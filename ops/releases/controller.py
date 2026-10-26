"""Reviewed release controller. Deployed from a pinned private-repository commit."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import urllib.error
import zipfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def function_fingerprint(configuration):
    keys = ['Runtime', 'Architectures', 'Handler', 'Role', 'MemorySize', 'Timeout', 'Environment', 'Layers',
            'VpcConfig', 'KMSKeyArn', 'DeadLetterConfig', 'TracingConfig', 'FileSystemConfigs', 'EphemeralStorage', 'SnapStart', 'LoggingConfig']
    return digest(encode({key: configuration[key] for key in keys if key in configuration}))


class CommandError(RuntimeError):
    def __init__(self, code):
        super().__init__('External command failed; inspect the private operation before retrying')
        self.code = code


def command(args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        match = re.search(rb'An error occurred \(([^)]+)\)', result.stderr)
        raise CommandError(match.group(1).decode() if match else 'CommandFailed')
    return result.stdout


class Aws:
    def __init__(self, bucket):
        require(re.fullmatch(r'[a-z0-9.-]{3,63}', bucket or ''), 'Operations bucket required')
        self.bucket = bucket

    def call(self, *args):
        data = command(['aws', *args, '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'])
        return json.loads(data) if data.strip() else {}

    def get(self, key, bucket=None):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'object')
            result = self.call('s3api', 'get-object', '--bucket', bucket or self.bucket, '--key', key, path)
            return Path(path).read_bytes(), result['ETag']

    def put(self, key, data, bucket=None, etag=None, create=False, content_type='application/json', cache='no-store'):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'object'
            path.write_bytes(data)
            args = ['s3api', 'put-object', '--bucket', bucket or self.bucket, '--key', key, '--body', str(path),
                    '--content-type', content_type, '--cache-control', cache, '--server-side-encryption', 'AES256']
            if etag:
                args += ['--if-match', etag]
            if create:
                args += ['--if-none-match', '*']
            return self.call(*args)['ETag']

    def asset(self, path, data, bucket, content_type):
        try:
            self.put(path, data, bucket=bucket, create=True, content_type=content_type, cache='public,max-age=31536000,immutable')
        except CommandError as error:
            if error.code != 'PreconditionFailed':
                raise
            existing, _ = self.get(path, bucket)
            require(existing == data, 'Refusing to overwrite an existing frontend asset')

    def remove_lock(self, etag):
        self.call('s3api', 'delete-object', '--bucket', self.bucket, '--key', 'state/lock.json', '--if-match', etag)


def frontend_files(archive, entries):
    require(isinstance(entries, list) and 1 < len(entries) <= 200, 'Invalid frontend inventory')
    expected = {}
    for entry in entries:
        path = entry['path']
        require(re.fullmatch(r'(marketing/)?index\.html', path) or re.fullmatch(r'(marketing/)?assets/[A-Za-z0-9_-]+\.(js|css|woff2|png|svg)', path) or re.fullmatch(r'[A-Za-z0-9_-]+\.svg', path), 'Unsafe frontend path')
        require(path not in expected and 0 < entry['size'] <= 20_000_000, 'Invalid frontend entry')
        expected[path] = entry
    require(sum(entry['size'] for entry in entries) <= 50_000_000, 'Frontend exceeds release limit')
    result = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        members = tar.getmembers()
        require(len(members) == len(expected), 'Unexpected archive entries')
        for member in members:
            require(member.isfile() and member.name in expected and member.name not in result, 'Unsafe archive member')
            entry = expected[member.name]
            require(member.size == entry['size'], 'Frontend size mismatch')
            content = tar.extractfile(member).read()
            require(digest(content) == entry['sha256'], 'Frontend digest mismatch')
            result[member.name] = content
    require('index.html' in result and 'marketing/index.html' in result, 'Frontend or marketing index missing')
    return result


def verify_package(directory, source, manifest_digest, config):
    root = Path(directory)
    raw = (root / 'release.json').read_bytes()
    require(re.fullmatch(r'[a-f0-9]{40}', source or '') and re.fullmatch(r'[a-f0-9]{64}', manifest_digest or ''), 'Exact source and manifest required')
    require(digest(raw) == manifest_digest, 'Manifest digest mismatch')
    manifest = json.loads(raw)
    require(manifest.get('version') == 2 and manifest.get('source') == source and manifest.get('repository') == config['repository'], 'Release identity mismatch')
    require(manifest['infrastructure'] == config['infrastructure'], 'Infrastructure change requires operator deployment')
    require(manifest['configuration'] == config['configuration'], 'Frontend configuration mismatch')
    require(set(manifest['artifacts']) == {'api.zip', 'web.tar.gz'}, 'Unexpected artifacts')
    for name, metadata in manifest['artifacts'].items():
        data = (root / name).read_bytes()
        require(0 < len(data) <= 50_000_000 and len(data) == metadata['size'] and digest(data) == metadata['sha256'], 'Artifact digest mismatch')
    code = (root / 'api.zip').read_bytes()
    with zipfile.ZipFile(io.BytesIO(code)) as archive:
        require(archive.namelist() == ['lambda.cjs'], 'Unexpected Lambda archive entries')
        info = archive.getinfo('lambda.cjs')
        require(0 < info.file_size <= 100_000_000 and not info.is_dir(), 'Invalid Lambda archive')
        require(archive.testzip() is None, 'Invalid Lambda archive checksum')
    return manifest, code, frontend_files((root / 'web.tar.gz').read_bytes(), manifest['frontend'])


def download_release(directory, source, manifest_digest, config):
    require(re.fullmatch(r'[a-f0-9]{40}', source or ''), 'Exact source required')
    gh = os.environ.get('FREEDMS_GH_BINARY', 'gh')
    command([gh, 'release', 'download', 'build-' + source, '--repo', config['repository'], '--dir', str(directory),
             '--pattern', 'release.json', '--pattern', 'provenance.jsonl', '--pattern', 'api.zip', '--pattern', 'web.tar.gz'])
    command([gh, 'attestation', 'verify', str(Path(directory) / 'release.json'), '--bundle', str(Path(directory) / 'provenance.jsonl'),
             '--repo', config['repository'], '--signer-workflow', config['repository'] + '/.github/workflows/ci.yml',
             '--signer-digest', source, '--source-digest', source, '--source-ref', 'refs/heads/master', '--deny-self-hosted-runners'])
    return verify_package(directory, source, manifest_digest, config)


def check_approval(approval, current_etag, config_digest, source, manifest_digest, now=None):
    now = now or time.time()
    require(approval.get('source') == source and approval.get('manifest') == manifest_digest, 'Approval does not match release')
    require(approval.get('currentETag') == current_etag and approval.get('configuration') == config_digest, 'Approval is stale')
    require(now < approval.get('expiresAt', 0) <= now + 4 * 3600 + 60, 'Approval expired or invalid')


def inspect(aws, config, current):
    info = aws.call('lambda', 'get-function', '--function-name', config['function'])
    function = info['Configuration']
    require(function['State'] == 'Active' and function['LastUpdateStatus'] == 'Successful', 'Lambda is not ready')
    require(function['Runtime'] == 'nodejs24.x' and function['Architectures'] == ['arm64'], 'Unexpected Lambda configuration')
    require(function_fingerprint(function) == config['functionConfiguration'], 'Live Lambda configuration changed')
    require(function['CodeSha256'] == current['codeSha256'], 'Live Lambda differs from recorded release')
    index, etag = aws.get('index.html', config['frontendBucket'])
    require(digest(index) == current['indexSha256'], 'Live frontend differs from recorded release')
    marketing, _ = aws.get('marketing/index.html', config['frontendBucket'])
    require(digest(marketing) == current['marketingIndexSha256'], 'Live marketing site differs from recorded release')
    return info, index, etag


def smoke(config, files):
    # Public checks never log in, load demo data, or write application records.
    origin = config['webUrl'].rstrip('/')
    require(re.fullmatch(r'https://[a-z0-9.-]+', origin), 'Invalid web origin')
    marketing_origin = config['marketingUrl'].rstrip('/')
    require(re.fullmatch(r'https://[a-z0-9.-]+', marketing_origin) and marketing_origin != origin, 'Invalid marketing origin')
    for path, expected in files.items():
        site = marketing_origin if path.startswith('marketing/') else origin
        public_path = path.removeprefix('marketing/')
        for suffix in [public_path, ''] if public_path == 'index.html' else [public_path]:
            with urllib.request.urlopen(site + '/' + suffix, timeout=20) as response:
                require(response.status == 200 and response.geturl() == site + '/' + suffix and digest(response.read()) == digest(expected), 'Live frontend mismatch')
    for path, status in [('/api/session', 401), ('/api/share/invalid-release-smoke', 404)]:
        try:
            urllib.request.urlopen(origin + path, timeout=20)
            raise RuntimeError('Unauthenticated API unexpectedly succeeded')
        except urllib.error.HTTPError as error:
            require(error.code == status, 'Unexpected API smoke response')


def replace_code(aws, config, data, revision):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'api.zip'
        path.write_bytes(data)
        result = aws.call('lambda', 'update-function-code', '--function-name', config['function'],
                          '--zip-file', 'fileb://' + str(path), '--revision-id', revision)
        aws.call('lambda', 'wait', 'function-updated-v2', '--function-name', config['function'])
        require(result['CodeSha256'] == base64.b64encode(hashlib.sha256(data).digest()).decode(), 'Lambda digest mismatch')
        return result['CodeSha256']


def promote(aws, config, current, current_etag, config_digest, source, manifest_digest, manifest, code, files, operation):
    require(re.fullmatch(r'[a-zA-Z0-9-]{1,100}', operation), 'Invalid operation identifier')
    # Conditional durable lock survives a lost runner; it is never removed by a blind finally block.
    lock = aws.put('state/lock.json', encode({'operation': operation, 'source': source, 'startedAt': time.time()}), create=True)
    started = False
    snapshot = None
    try:
        raw, refreshed_etag = aws.get('state/current.json')
        require(refreshed_etag == current_etag and json.loads(raw) == current, 'Current release changed')
        config_raw, _ = aws.get('config.json')
        require(digest(config_raw) == config_digest, 'Deployment configuration changed')
        approval, _ = aws.get(f'approvals/{source}-{manifest_digest}.json')
        check_approval(json.loads(approval), current_etag, config_digest, source, manifest_digest)
        info, previous_index, index_etag = inspect(aws, config, current)
        previous_marketing, marketing_etag = aws.get('marketing/index.html', config['frontendBucket'])
        require(digest(previous_marketing) == current['marketingIndexSha256'], 'Marketing site changed before snapshot')
        with urllib.request.urlopen(info['Code']['Location'], timeout=30) as response:
            previous_code = response.read(50_000_001)
        require(base64.b64encode(hashlib.sha256(previous_code).digest()).decode() == current['codeSha256'], 'Rollback code mismatch')
        prefix = 'history/' + operation
        aws.put(prefix + '/api.zip', previous_code, content_type='application/zip', create=True)
        aws.put(prefix + '/index.html', previous_index, content_type='text/html', create=True)
        aws.put(prefix + '/marketing.html', previous_marketing, content_type='text/html', create=True)
        snapshot = {'previous': current, 'target': source, 'manifest': manifest_digest, 'operation': operation, 'prefix': prefix}
        aws.put(prefix + '/snapshot.json', encode(snapshot), create=True)
        for path, data in files.items():
            if path not in ['index.html', 'marketing/index.html']:
                content_type = {'js': 'application/javascript', 'css': 'text/css', 'svg': 'image/svg+xml', 'png': 'image/png', 'woff2': 'font/woff2'}[path.rsplit('.', 1)[1]]
                aws.asset(path, data, config['frontendBucket'], content_type)
        # Changes are compatible application bytes only. Existing assets remain available.
        started = True
        code_sha = replace_code(aws, config, code, info['Configuration']['RevisionId'])
        aws.put('index.html', files['index.html'], bucket=config['frontendBucket'], etag=index_etag, content_type='text/html')
        aws.put('marketing/index.html', files['marketing/index.html'], bucket=config['frontendBucket'], etag=marketing_etag, content_type='text/html')
        live, _, _ = inspect(aws, config, {'codeSha256': code_sha, 'indexSha256': digest(files['index.html']), 'marketingIndexSha256': digest(files['marketing/index.html'])})
        smoke(config, files)
        record = {'source': source, 'manifest': manifest_digest, 'codeSha256': code_sha, 'indexSha256': digest(files['index.html']), 'marketingIndexSha256': digest(files['marketing/index.html']),
                  'operation': operation, 'previous': prefix, 'deployedAt': time.time()}
        aws.put('state/current.json', encode(record), etag=current_etag)
        aws.remove_lock(lock)
        return record
    except Exception:
        if not started:
            aws.remove_lock(lock)
        elif snapshot:
            # Any rollback failure preserves the lock and snapshot for operator recovery.
            live = aws.call('lambda', 'get-function', '--function-name', config['function'])
            target_code_sha = base64.b64encode(hashlib.sha256(code).digest()).decode()
            require(live['Configuration']['CodeSha256'] in [current['codeSha256'], target_code_sha], 'Unrecognized code change; operator recovery required')
            require(function_fingerprint(live['Configuration']) == config['functionConfiguration'], 'Configuration changed; operator recovery required')
            live_index, rollback_index_etag = aws.get('index.html', config['frontendBucket'])
            require(digest(live_index) in [current['indexSha256'], digest(files['index.html'])], 'Unrecognized frontend change; operator recovery required')
            live_marketing, rollback_marketing_etag = aws.get('marketing/index.html', config['frontendBucket'])
            require(digest(live_marketing) in [current['marketingIndexSha256'], digest(files['marketing/index.html'])], 'Unrecognized marketing change; operator recovery required')
            replace_code(aws, config, previous_code, live['Configuration']['RevisionId'])
            aws.put('index.html', previous_index, bucket=config['frontendBucket'], etag=rollback_index_etag, content_type='text/html')
            aws.put('marketing/index.html', previous_marketing, bucket=config['frontendBucket'], etag=rollback_marketing_etag, content_type='text/html')
            inspect(aws, config, current)
            smoke(config, {'index.html': previous_index, 'marketing/index.html': previous_marketing})
            recovered = {**current, 'recoveredAt': time.time(), 'failedOperation': operation}
            aws.put('state/current.json', encode(recovered), etag=current_etag)
            aws.remove_lock(lock)
        raise


def main():
    mode = sys.argv[1]
    require(mode in ['probe', 'preflight', 'deploy'], 'Unsupported operation')
    aws = Aws(os.environ.get('FREEDMS_OPERATIONS_BUCKET'))
    config_raw, _ = aws.get('config.json')
    config = json.loads(config_raw)
    current_raw, current_etag = aws.get('state/current.json')
    current = json.loads(current_raw)
    inspect(aws, config, current)
    if mode == 'probe':
        print('Release access and current application verified; no application writes performed.')
        return
    source, manifest_digest = os.environ['RELEASE_SOURCE'], os.environ['RELEASE_MANIFEST']
    approval, _ = aws.get(f'approvals/{source}-{manifest_digest}.json')
    check_approval(json.loads(approval), current_etag, digest(config_raw), source, manifest_digest)
    with tempfile.TemporaryDirectory() as directory:
        manifest, code, files = download_release(directory, source, manifest_digest, config)
        if mode == 'deploy':
            operation = 'run-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
            promote(aws, config, current, current_etag, digest(config_raw), source, manifest_digest, manifest, code, files, operation)
            print('Approved release deployed and verified: ' + source)
        else:
            print('Approved release verified; no application writes performed: ' + source)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # AWS errors/presigned URLs and deployment configuration stay out of logs.
        print('Release stopped: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
