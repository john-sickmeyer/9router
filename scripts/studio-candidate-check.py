#!/usr/bin/env python3
"""Boot a staged release with an empty temporary DB; never use account credentials."""
import argparse
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time
from studio_health import catalog_contract, request


def validate(build, revision, log_path):
    checks = {}
    # Reserve a free port. Verify the release ID before accepting any probe.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='9router-candidate-') as directory:
        data = pathlib.Path(directory)
        marker = data / 'maintenance'
        env = {**os.environ, 'PORT': str(port), 'HOSTNAME': '127.0.0.1', 'NODE_ENV': 'production',
            'DATA_DIR': str(data), 'STUDIO_RELEASE': revision, 'STUDIO_MAINTENANCE_FILE': str(marker),
            'DISABLE_BACKGROUND_TOKEN_REFRESH': '1', 'STUDIO_CURATED_CATALOG': '1', 'STUDIO_CLAUDE_FAST_ENABLED': '0'}
        with log_path.open('w') as log:
            process = subprocess.Popen([shutil.which('node'), str(build / 'custom-server.js')],
                cwd=build, env=env, stdout=log, stderr=log)
            def call(path, **kwargs): return request(port, data, path, **kwargs)
            try:
                for _ in range(60):
                    if process.poll() is not None: raise RuntimeError('Candidate process exited')
                    try:
                        if call('/v1/models')[0] == 200: break
                    except OSError: pass
                    time.sleep(1)
                else: raise RuntimeError('Candidate did not start')
                code, content = call('/api/studio', admin=True)
                checks['release'] = code == 200 and json.loads(content)['release'] == revision
                if not checks['release']: raise RuntimeError('Candidate port belongs to the wrong release')
                transport = json.loads(content).get('transport', {})
                checks['transport_tracking'] = transport == {'version': 1, 'activeCount': 0, 'pending': []}
                checks['protected_status'] = call('/api/studio')[0] == 401
                for label, headers in [('catalog', {}), ('claude_catalog', {'anthropic-version': '2023-06-01'})]:
                    code, content = call('/v1/models', headers=headers)
                    if code != 200: raise RuntimeError('Candidate catalog unavailable')
                    catalog_contract(content, anthropic=bool(headers))
                    checks[label] = True
                code, content = call('/dashboard/studio', admin=True)
                checks['dashboard'] = code == 200 and b'Studio controls' in content
                checks['stock_updater_blocked'] = call('/api/version/update', payload={}, admin=True)[0] == 409
                code, content = call('/api/keys', payload={'name': 'isolated-candidate-test'}, admin=True)
                if code != 201: raise RuntimeError('Cannot create temporary test key')
                key = json.loads(content)['key']
                code, content = call('/v1/messages', payload={'model': 'cc/claude-opus-5-5@fast',
                    'messages': [{'role': 'user', 'content': 'probe'}], 'max_tokens': 1},
                    headers={'Authorization': 'Bearer ' + key})
                checks['claude_fast_blocked'] = code == 400 and b'extra-usage credits' in content
                marker.write_text('validation')
                checks['drain'] = call('/v1/chat/completions', payload={
                    'model': 'cx/gpt-6-astra', 'messages': [{'role': 'user', 'content': 'probe'}]})[0] == 503
                checks['drain_all_inference_routes'] = all(call(path, payload={})[0] == 503 for path in
                    ['/api/v1/messages', '/v1/v1/messages', '/v1/images/generations',
                     '/responses', '/codex/responses', '/systemone', '/v1beta/models/probe:generateContent'])
                if not all(checks.values()): raise RuntimeError('Candidate checks failed: ' + json.dumps(checks))
                return checks
            finally:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('build', type=pathlib.Path)
    parser.add_argument('revision')
    parser.add_argument('--log', type=pathlib.Path, required=True)
    args = parser.parse_args()
    print(json.dumps(validate(args.build.resolve(), args.revision, args.log), sort_keys=True))
