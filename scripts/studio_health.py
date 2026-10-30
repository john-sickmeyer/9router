"""Read-only assertions for the approved Studio model/effort contract."""
import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request

CODEX = ['gpt-6.1-sol', 'gpt-6-astra']
CLAUDE = ['claude-opus-5-5', 'claude-fable-5-1']
SPEEDS = ['standard', 'fast', 'ultrafast']
EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']


def request(port, data_dir, path, payload=None, admin=False, headers=None):
    headers = {'Content-Type': 'application/json', **(headers or {})}
    if admin:
        def enc(value): return base64.urlsafe_b64encode(value).rstrip(b'=')
        body = enc(b'{"alg":"HS256","typ":"JWT"}') + b'.' + enc(json.dumps({
            'authenticated': True, 'iat': int(time.time()), 'exp': int(time.time()) + 120,
        }).encode())
        signature = enc(hmac.new((data_dir / 'jwt-secret').read_text().strip().encode(), body, hashlib.sha256).digest())
        headers['Cookie'] = 'auth_token=' + (body + b'.' + signature).decode()
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}',
        data=None if payload is None else json.dumps(payload).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def catalog_contract(content, anthropic=False, pooled=False):
    models = json.loads(content)['data']
    expected = (CLAUDE if anthropic else
        [f'{"" if pooled else "cx/"}{model}@{speed}' for model in CODEX for speed in SPEEDS] + [f'cc/{model}' for model in CLAUDE])
    if sorted(model['id'] for model in models) != sorted(expected):
        raise RuntimeError('Model catalog no longer matches the approved Studio choices')
    for model in models:
        if model['id'].split('/')[-1] in CLAUDE:
            effort = model.get('capabilities', {}).get('effort', {})
            if not all(effort.get(level, {}).get('supported') for level in EFFORTS):
                raise RuntimeError('Claude effort metadata is incomplete')


def live_contract(status, catalog, baseline=None):
    catalog_contract(catalog, pooled=status.get('openaiPool', {}).get('enabled', False))
    expected = [f'cx/{model}' for model in CODEX] + [f'cc/{model}' for model in CLAUDE]
    choices = status['choices']
    if sorted(row['id'] for row in choices) != sorted(expected):
        raise RuntimeError('Studio control choices changed')
    for row in choices:
        if row['efforts'] != EFFORTS or 'standard' not in row['speeds']:
            raise RuntimeError('Studio speed/effort controls are incomplete')
        if row['id'].startswith('cc/') and row['speeds'] != ['standard']:
            raise RuntimeError('Claude Fast must remain disabled')
    accounts = sorted((row['id'], row['provider']) for row in status['accounts'])
    if baseline is not None and accounts != baseline:
        raise RuntimeError('Connected account identities changed during activation')
    return accounts
