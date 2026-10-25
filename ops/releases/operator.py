"""Local, independently authenticated operator approval. Never run in GitHub Actions."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import time
from controller import Aws, command, digest, download_release, encode, inspect, require


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['approve', 'status'])
    parser.add_argument('configuration', help='Private local operator JSON')
    parser.add_argument('--source')
    parser.add_argument('--manifest')
    args = parser.parse_args()
    require(not os.environ.get('GITHUB_ACTIONS'), 'Independent local operator required')
    private = json.loads(Path(args.configuration).read_text())
    aws = Aws(private['operationsBucket'])
    identity = aws.call('sts', 'get-caller-identity')
    require(identity['Account'] == private['accountId'] and identity['Arn'] == private['operatorArn'], 'Unexpected approving AWS identity')
    config_raw, _ = aws.get('config.json')
    config = json.loads(config_raw)
    current_raw, etag = aws.get('state/current.json')
    current = json.loads(current_raw)
    inspect(aws, config, current)
    if args.operation == 'status':
        print(json.dumps({'source': current['source'], 'deployedAt': current.get('deployedAt'), 'manifest': current.get('manifest')}))
        return
    with tempfile.TemporaryDirectory() as directory:
        download_release(directory, args.source, args.manifest, config)
    require(args.source != current['source'], 'This source is already deployed')
    approval = {'source': args.source, 'manifest': args.manifest, 'currentETag': etag, 'configuration': digest(config_raw), 'expiresAt': time.time() + 4 * 3600}
    key = f'approvals/{args.source}-{args.manifest}.json'
    aws.put(key, encode(approval))
    saved, _ = aws.get(key)
    require(json.loads(saved) == approval, 'Approval readback mismatch')
    print('Exact release approved for four hours. Dispatch the private deployment workflow with the same source and manifest.')


if __name__ == '__main__':
    main()
