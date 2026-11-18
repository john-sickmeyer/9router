#!/usr/bin/env python3
"""Boot a staged release with an empty temporary DB; never use account credentials."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import socket
import sqlite3
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
        updates = data / 'updates'
        updates.mkdir()
        update_state = {'status': 'up-to-date', 'lastCheck': int(time.time()), 'currentRevision': revision}
        (updates / 'status.json').write_text(json.dumps(update_state))
        env = {**os.environ, 'PORT': str(port), 'HOSTNAME': '127.0.0.1', 'NODE_ENV': 'production',
            'DATA_DIR': str(data), 'STUDIO_RELEASE': revision, 'STUDIO_MAINTENANCE_FILE': str(marker),
            'STUDIO_UPDATE_STATE_DIR': str(updates),
            'DISABLE_BACKGROUND_TOKEN_REFRESH': '1', 'STUDIO_CURATED_CATALOG': '1', 'STUDIO_CLAUDE_FAST_ENABLED': '0', 'STUDIO_OPENAI_POOL_ENABLED': '1'}
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
                checks['openai_pool_enabled'] = json.loads(content).get('openaiPool', {}).get('enabled') is True
                if not checks['release']: raise RuntimeError('Candidate port belongs to the wrong release')
                transport = json.loads(content).get('transport', {})
                checks['transport_tracking'] = transport == {'version': 1, 'activeCount': 0, 'pending': []}
                checks['protected_status'] = call('/api/studio')[0] == 401
                checks['protected_ultrafast_policy'] = call('/api/studio/ultrafast')[0] == 401 and call('/api/studio/ultrafast',payload={'action':'mode','mode':'observe'})[0] == 401
                code, content = call('/api/studio/ultrafast', admin=True)
                initial_speed = json.loads(content)
                checks['ultrafast_enforcement_default'] = code == 200 and initial_speed.get('mode') == 'enforce' and initial_speed.get('rows') == [] and initial_speed.get('ping') == {'model':'gpt-6.2-sol','effort':'low','tier':'ultrafast'}
                checks['ultrafast_mode_switch'] = all(json.loads(call('/api/studio/ultrafast',admin=True,payload={'action':'mode','mode':m})[1])['mode'] == m for m in ('observe','enforce'))
                checks['protected_billing_recovery'] = call('/api/studio/openai-pool', payload={'action': 'retry-billing', 'connectionId': 'fixture'})[0] == 401
                checks['protected_credit_balance'] = call('/api/studio/openai-pool')[0] == 401 and call('/api/studio/openai-pool', payload={'action': 'set-credit-balance', 'balanceUsd': 1, 'connectionIds': ['fixture']})[0] == 401
                code, content = call('/api/studio/openai-pool', admin=True)
                checks['credit_balance_unconfigured'] = code == 200 and json.loads(content).get('credit') is None
                code, content = call('/api/studio/updates', admin=True)
                checks['update_health'] = code == 200 and json.loads(content).get('status') == 'up-to-date'
                checks['protected_update_health'] = call('/api/studio/updates')[0] == 401
                (updates / 'status.json').write_text(json.dumps({**update_state, 'status': 'needs-resolution',
                    'lastFailure': {'error': 'Fixture conflict', 'conflicts': ['fixture.js']}}))
                code, content = call('/api/studio/updates', admin=True)
                checks['update_conflict_warning'] = code == 200 and json.loads(content).get('needsAttention') is True
                (updates / 'status.json').write_text(json.dumps(update_state))
                for label, headers in [('catalog', {}), ('claude_catalog', {'anthropic-version': '2023-06-01'})]:
                    code, content = call('/v1/models', headers=headers)
                    if code != 200: raise RuntimeError('Candidate catalog unavailable')
                    catalog_contract(content, anthropic=bool(headers), pooled=True, kimi=True, lithos=True)
                    checks[label] = True
                code, content = call('/dashboard/studio', admin=True)
                checks['dashboard'] = code == 200 and b'Studio controls' in content
                code, content = call('/dashboard/quota', admin=True)
                checks['quota_tracker_page'] = code == 200 and b'Quota' in content
                checks['stock_updater_blocked'] = call('/api/version/update', payload={}, admin=True)[0] == 409
                code, content = call('/api/keys', payload={'name': 'isolated-candidate-test'}, admin=True)
                if code != 201: raise RuntimeError('Cannot create temporary test key')
                key = json.loads(content)['key']
                with sqlite3.connect(data/'db'/'data.sqlite', timeout=10) as db:
                    stamp = '2026-11-17T00:00:00Z'
                    db.execute("""INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt)
                        VALUES(?, 'codex','oauth','Suspended fixture',0,?,?,?)""",
                        ('speed-test-only',json.dumps({'studioUltrafastAutoOff':'fixture-owner'}),stamp,stamp))
                _, content = call('/api/studio', admin=True)
                checks['speed_suspension_preserves_codex_catalog'] = any(c['id']=='cx/gpt-6.2-sol' for c in json.loads(content)['choices'])
                code, content = call('/v1/responses',payload={'model':'cx/gpt-6.2-sol@ultrafast','input':'fixture'},
                    headers={'Authorization':'Bearer '+key})
                checks['suspended_pool_returns_capacity'] = code == 503 and b'speed-qualified' in content
                with sqlite3.connect(data/'db'/'data.sqlite', timeout=10) as db:
                    account = 'reserve-fixture'
                    db.execute("""INSERT INTO providerConnections(id,provider,authType,name,isActive,data,createdAt,updatedAt)
                        VALUES(?,'codex','oauth','Reserved fixture',1,?,?,?)""",
                        (account,json.dumps({'providerSpecificData':{'workspaceId':account}}),stamp,stamp))
                    now = int(time.time()*1000)
                    reserve = {'owner':hashlib.sha256(account.encode()).hexdigest(),'session':{'remaining':1},
                        'weekly':{'remaining':87},'observedAt':now,'verifiedAt':now,'usageAt':now}
                    db.execute("INSERT INTO kv(scope,key,value) VALUES('studioCodexQuotaReserveV1',?,?)",(account,json.dumps(reserve)))
                for speed in ('standard','fast','ultrafast'):
                    code, content = call('/v1/responses',payload={'model':'cx/gpt-6.2-sol@'+speed,'input':'fixture'},
                        headers={'Authorization':'Bearer '+key})
                    checks['quota_reserve_blocks_'+speed] = code == 503 and b'1% ping reserve' in content
                code, content = call('/api/studio/ultrafast',admin=True)
                view=json.loads(content)['reserves'][account]
                checks['reserved_account_can_ping'] = view['held'] and view['pingAllowed'] and not view['routable']
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
