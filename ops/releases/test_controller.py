import base64
import hashlib
import io
import json
import subprocess
import sys
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile
import controller as c


SOURCE = 'a' * 40
CONFIG = {'repository': 'tomesposito/freedms', 'infrastructure': 'infra', 'configuration': 'config',
          'functionConfiguration': c.function_fingerprint({'Runtime': 'nodejs24.x', 'Architectures': ['arm64']}),
          'function': 'function', 'frontendBucket': 'frontend', 'webUrl': 'https://app.example.test', 'marketingUrl': 'https://example.test'}


def package(directory):
    code = io.BytesIO()
    with zipfile.ZipFile(code, 'w') as archive:
        archive.writestr('lambda.cjs', 'exports.handler = async () => 1;')
    files = {'index.html': b'<html>test</html>', 'assets/main-12345678.js': b'console.log(1)', 'logo.svg': b'<svg/>', 'marketing/index.html': b'<html>marketing</html>', 'marketing/assets/hero-12345678.png': b'image'}
    web = io.BytesIO()
    with tarfile.open(fileobj=web, mode='w:gz') as archive:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    artifacts = {'api.zip': code.getvalue(), 'web.tar.gz': web.getvalue()}
    manifest = {'version': 2, 'repository': CONFIG['repository'], 'source': SOURCE, 'infrastructure': 'infra', 'configuration': 'config',
                'artifacts': {name: {'sha256': c.digest(data), 'size': len(data)} for name, data in artifacts.items()},
                'frontend': [{'path': name, 'sha256': c.digest(data), 'size': len(data)} for name, data in files.items()]}
    raw = c.encode(manifest)
    for name, data in {**artifacts, 'release.json': raw}.items():
        (Path(directory) / name).write_bytes(data)
    return manifest, c.digest(raw), artifacts['api.zip'], files


class PackageTests(unittest.TestCase):
    def test_operator_command_starts_without_shadowing_the_standard_library(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('release_operator.py')), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('approve', result.stdout)

    def test_existing_asset_can_only_be_reused_with_identical_bytes(self):
        aws = c.Aws('test-bucket')
        with patch.object(aws, 'put', side_effect=c.CommandError('PreconditionFailed')), patch.object(aws, 'get', return_value=(b'original', 'etag')):
            aws.asset('assets/a.js', b'original', 'frontend', 'application/javascript')
            with self.assertRaisesRegex(RuntimeError, 'overwrite'):
                aws.asset('assets/a.js', b'different', 'frontend', 'application/javascript')

    def test_configuration_fingerprint_ignores_release_metadata_but_detects_authority_changes(self):
        original = {'Runtime': 'nodejs24.x', 'Role': 'original', 'Environment': {'Variables': {'TABLE_NAME': 'one'}}}
        self.assertEqual(c.function_fingerprint(original), c.function_fingerprint({**original, 'RevisionId': 'new'}))
        self.assertNotEqual(c.function_fingerprint(original), c.function_fingerprint({**original, 'Role': 'other'}))

    def test_valid_package_and_tampered_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            manifest, digest, code, files = package(d)
            self.assertEqual(c.verify_package(d, SOURCE, digest, CONFIG), (manifest, code, files))
            (Path(d) / 'api.zip').write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'Artifact digest'):
                c.verify_package(d, SOURCE, digest, CONFIG)

    def test_identity_configuration_and_infrastructure_are_bound(self):
        with tempfile.TemporaryDirectory() as d:
            _, digest, _, _ = package(d)
            for source, checksum, config in [('b' * 40, digest, CONFIG), (SOURCE, '0' * 64, CONFIG),
                                             (SOURCE, digest, {**CONFIG, 'infrastructure': 'other'}),
                                             (SOURCE, digest, {**CONFIG, 'configuration': 'other'})]:
                with self.assertRaises(RuntimeError):
                    c.verify_package(d, source, checksum, config)

    def test_marketing_index_is_required_and_tampering_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            manifest, checksum, _, _ = package(d)
            manifest['frontend'] = [entry for entry in manifest['frontend'] if not entry['path'].startswith('marketing/')]
            with self.assertRaisesRegex(RuntimeError, 'Unexpected archive entries'):
                c.frontend_files((Path(d) / 'web.tar.gz').read_bytes(), manifest['frontend'])
            manifest, _, _, _ = package(d)
            next(entry for entry in manifest['frontend'] if entry['path'] == 'marketing/index.html')['sha256'] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
                c.frontend_files((Path(d) / 'web.tar.gz').read_bytes(), manifest['frontend'])

    def test_archive_rejects_traversal_symlinks_and_duplicate_names(self):
        entries = [{'path': 'index.html', 'size': 1, 'sha256': c.digest(b'x')}, {'path': 'assets/a.js', 'size': 1, 'sha256': c.digest(b'x')}]
        for names, link in [(['../index.html', 'assets/a.js'], False), (['index.html', 'assets/a.js'], True), (['index.html', 'index.html'], False)]:
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz') as archive:
                for name in names:
                    info = tarfile.TarInfo(name)
                    if link:
                        info.type = tarfile.SYMTYPE
                        info.linkname = '/etc/passwd'
                        archive.addfile(info)
                    else:
                        info.size = 1
                        archive.addfile(info, io.BytesIO(b'x'))
            with self.assertRaises(RuntimeError):
                c.frontend_files(data.getvalue(), entries)

    def test_approval_rejects_expired_stale_and_different_releases(self):
        approval = {'source': SOURCE, 'manifest': 'digest', 'currentETag': 'etag', 'configuration': 'config', 'expiresAt': 1100}
        c.check_approval(approval, 'etag', 'config', SOURCE, 'digest', now=1000)
        for field, value in [('source', 'other'), ('manifest', 'other'), ('currentETag', 'old'), ('configuration', 'old'), ('expiresAt', 999), ('expiresAt', 999999)]:
            with self.assertRaises(RuntimeError):
                c.check_approval({**approval, field: value}, 'etag', 'config', SOURCE, 'digest', now=1000)


class FakeAws:
    def __init__(self):
        self.code = b'old code'
        self.revision = 1
        self.rows = {}
        self.seq = 0
        self.fail_rollback = False
        self.fail_assets = False
        self.updates = []
        self.current = {'source': 'old', 'codeSha256': base64.b64encode(hashlib.sha256(self.code).digest()).decode(), 'indexSha256': c.digest(b'old index'), 'marketingIndexSha256': c.digest(b'old marketing')}
        self.put('config.json', c.encode(CONFIG))
        self.etag = self.put('state/current.json', c.encode(self.current))
        self.put('index.html', b'old index', bucket='frontend')
        self.put('marketing/index.html', b'old marketing', bucket='frontend')

    def get(self, key, bucket=None):
        return self.rows[(bucket, key)]

    def put(self, key, data, bucket=None, etag=None, create=False, **kwargs):
        old = self.rows.get((bucket, key))
        if (create and old) or (etag and (not old or etag != old[1])):
            raise RuntimeError('Conditional write refused')
        self.seq += 1
        self.rows[(bucket, key)] = (data, str(self.seq))
        return str(self.seq)

    def asset(self, path, data, bucket, content_type):
        if self.fail_assets:
            raise RuntimeError('Asset failed')
        self.put(path, data, bucket=bucket)

    def remove_lock(self, etag):
        assert self.get('state/lock.json')[1] == etag
        del self.rows[(None, 'state/lock.json')]

    def call(self, *args):
        if args[:2] == ('lambda', 'get-function'):
            return {'Configuration': {'State': 'Active', 'LastUpdateStatus': 'Successful', 'Runtime': 'nodejs24.x', 'Architectures': ['arm64'],
                                      'CodeSha256': base64.b64encode(hashlib.sha256(self.code).digest()).decode(), 'RevisionId': str(self.revision)},
                    'Code': {'Location': 'https://example.test/old.zip'}}
        if args[:2] == ('lambda', 'wait'):
            return {}
        if args[:2] == ('lambda', 'update-function-code'):
            if self.fail_rollback and self.updates:
                raise RuntimeError('Rollback failed')
            assert args[args.index('--revision-id') + 1] == str(self.revision)
            self.code = Path(args[args.index('--zip-file') + 1].removeprefix('fileb://')).read_bytes()
            self.updates.append(self.code)
            self.revision += 1
            return {'CodeSha256': base64.b64encode(hashlib.sha256(self.code).digest()).decode()}
        raise AssertionError(args)


class PromotionTests(unittest.TestCase):
    def run_release(self, aws, smoke_error=False):
        with tempfile.TemporaryDirectory() as d:
            manifest, digest, code, files = package(d)
            approval = {'source': SOURCE, 'manifest': digest, 'currentETag': aws.etag, 'configuration': c.digest(c.encode(CONFIG)), 'expiresAt': time.time() + 3600}
            aws.put(f'approvals/{SOURCE}-{digest}.json', c.encode(approval))
            with patch('controller.urllib.request.urlopen', return_value=io.BytesIO(b'old code')), patch('controller.smoke', side_effect=RuntimeError('Smoke failed') if smoke_error else None):
                return c.promote(aws, CONFIG, aws.current, aws.etag, c.digest(c.encode(CONFIG)), SOURCE, digest, manifest, code, files, 'test-run')

    def test_success_records_exact_source_and_clears_lock(self):
        aws = FakeAws()
        record = self.run_release(aws)
        self.assertEqual(record['source'], SOURCE)
        self.assertNotIn((None, 'state/lock.json'), aws.rows)
        self.assertIn((None, 'history/test-run/api.zip'), aws.rows)
        self.assertIn((None, 'history/test-run/marketing.html'), aws.rows)
        self.assertEqual(record['marketingIndexSha256'], c.digest(aws.get('marketing/index.html', 'frontend')[0]))
        self.assertNotEqual(aws.get('state/current.json')[1], aws.etag)

    def test_smoke_failure_restores_application_and_consumes_approval(self):
        aws = FakeAws()
        with patch('controller.smoke', side_effect=[RuntimeError('Smoke failed'), None]):
            # run_release's patch is replaced below to exercise the recovery success path.
            with tempfile.TemporaryDirectory() as d:
                manifest, digest, code, files = package(d)
                aws.put(f'approvals/{SOURCE}-{digest}.json', c.encode({'source': SOURCE, 'manifest': digest, 'currentETag': aws.etag,
                    'configuration': c.digest(c.encode(CONFIG)), 'expiresAt': time.time() + 3600}))
                with patch('controller.urllib.request.urlopen', return_value=io.BytesIO(b'old code')):
                    with self.assertRaisesRegex(RuntimeError, 'Smoke failed'):
                        c.promote(aws, CONFIG, aws.current, aws.etag, c.digest(c.encode(CONFIG)), SOURCE, digest, manifest, code, files, 'test-run')
        self.assertEqual(aws.code, b'old code')
        self.assertEqual(aws.get('index.html', 'frontend')[0], b'old index')
        self.assertEqual(aws.get('marketing/index.html', 'frontend')[0], b'old marketing')
        self.assertNotIn((None, 'state/lock.json'), aws.rows)
        self.assertNotEqual(aws.get('state/current.json')[1], aws.etag)

    def test_failed_recovery_preserves_durable_lock_and_snapshot(self):
        aws = FakeAws()
        aws.fail_rollback = True
        with self.assertRaisesRegex(RuntimeError, 'Rollback failed'):
            self.run_release(aws, smoke_error=True)
        self.assertIn((None, 'state/lock.json'), aws.rows)
        self.assertIn((None, 'history/test-run/snapshot.json'), aws.rows)

    def test_existing_lock_blocks_without_any_application_update(self):
        aws = FakeAws()
        aws.put('state/lock.json', b'other run')
        with self.assertRaisesRegex(RuntimeError, 'Conditional write'):
            self.run_release(aws)
        self.assertEqual(aws.updates, [])
        self.assertEqual(aws.get('state/lock.json')[0], b'other run')

    def test_external_code_change_is_never_overwritten_by_recovery(self):
        aws = FakeAws()
        original_call = aws.call
        def call(*args):
            if args[:2] == ('lambda', 'get-function') and aws.updates:
                aws.code = b'external operator change'
            return original_call(*args)
        with patch.object(aws, 'call', side_effect=call):
            with self.assertRaisesRegex(RuntimeError, 'Unrecognized code change'):
                self.run_release(aws)
        self.assertEqual(aws.code, b'external operator change')
        self.assertEqual(len(aws.updates), 1)
        self.assertIn((None, 'state/lock.json'), aws.rows)

    def test_asset_failure_leaves_current_application_untouched(self):
        aws = FakeAws()
        aws.fail_assets = True
        with self.assertRaisesRegex(RuntimeError, 'Asset failed'):
            self.run_release(aws)
        self.assertEqual(aws.updates, [])
        self.assertEqual(aws.get('index.html', 'frontend')[0], b'old index')
        self.assertEqual(aws.get('marketing/index.html', 'frontend')[0], b'old marketing')
        self.assertNotIn((None, 'state/lock.json'), aws.rows)

    def test_marketing_drift_blocks_before_application_writes(self):
        aws = FakeAws()
        aws.put('marketing/index.html', b'external edit', bucket='frontend')
        with self.assertRaisesRegex(RuntimeError, 'marketing site differs'):
            self.run_release(aws)
        self.assertEqual(aws.updates, [])
        self.assertEqual(aws.get('marketing/index.html', 'frontend')[0], b'external edit')
        self.assertNotIn((None, 'state/lock.json'), aws.rows)

    def test_external_marketing_change_is_never_overwritten_by_recovery(self):
        aws = FakeAws()
        original_get = aws.get
        def get(key, bucket=None):
            if key == 'marketing/index.html' and bucket == 'frontend' and aws.updates:
                aws.put(key, b'external marketing edit', bucket=bucket)
            return original_get(key, bucket)
        with patch.object(aws, 'get', side_effect=get):
            with self.assertRaisesRegex(RuntimeError, 'Unrecognized marketing change'):
                self.run_release(aws)
        self.assertEqual(aws.get('marketing/index.html', 'frontend')[0], b'external marketing edit')
        self.assertEqual(len(aws.updates), 1)
        self.assertIn((None, 'state/lock.json'), aws.rows)


if __name__ == '__main__':
    unittest.main()
