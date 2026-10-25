#!/usr/bin/env python3
"""Run on the Studio. Stage immutable builds; activate with drain/backup/rollback."""
import argparse, base64, fcntl, hashlib, hmac, json, os, pathlib, plistlib, shutil, sqlite3, subprocess, time, urllib.request

ROOT = pathlib.Path.home() / 'Library/Application Support/9router-studio'
DATA = pathlib.Path.home() / '.9router'
AGENTS = pathlib.Path.home() / 'Library/LaunchAgents'
LABEL = 'com.sickmeyer.9router-studio'
PLIST = AGENTS / (LABEL + '.plist')
MAINTENANCE = ROOT / 'maintenance'
DOMAIN = f'gui/{os.getuid()}'
PORT = 20128

def run(*args, check=True, **kwargs):
    return subprocess.run(args, check=check, **kwargs)

def token():
    def enc(x): return base64.urlsafe_b64encode(x).rstrip(b'=')
    secret = (DATA / 'jwt-secret').read_text().strip().encode()
    parts = [enc(b'{"alg":"HS256","typ":"JWT"}'), enc(json.dumps({'authenticated': True, 'iat': int(time.time()), 'exp': int(time.time()) + 120}).encode())]
    body = b'.'.join(parts)
    return (body + b'.' + enc(hmac.new(secret, body, hashlib.sha256).digest())).decode()

def status():
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}/api/studio', headers={'Cookie': 'auth_token=' + token()})
    with urllib.request.urlopen(req, timeout=5) as res: return json.load(res)

def switch(target):
    tmp = ROOT / 'current.next'
    tmp.unlink(missing_ok=True)
    tmp.symlink_to(target)
    tmp.replace(ROOT / 'current')

def stop(label=LABEL):
    run('launchctl', 'bootout', f'{DOMAIN}/{label}', check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        probe = run('launchctl', 'print', f'{DOMAIN}/{label}', check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode != 0: return
        time.sleep(0.25)
    raise RuntimeError(f'Timed out waiting for {label} to unload')

def start(plist=PLIST):
    # launchd can briefly return EIO after a completed bootout. Retry only this
    # bounded startup step; activation still checks the actual served revision.
    for _ in range(20):
        result = run('launchctl', 'bootstrap', DOMAIN, str(plist), check=False, capture_output=True, text=True)
        if result.returncode == 0: return
        label = plistlib.loads(pathlib.Path(plist).read_bytes())['Label']
        probe = run('launchctl', 'print', f'{DOMAIN}/{label}', check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0: return
        time.sleep(0.5)
    raise RuntimeError(f'Could not start {plist.name}: {result.stderr.strip()}')

def stage(source):
    source = pathlib.Path(source).resolve()
    rev = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True).strip()
    if dirty: raise RuntimeError('Stage only a clean, committed source tree')
    built = source / '.next/standalone'
    if not (built / 'custom-server.js').is_file(): raise RuntimeError('Run npm run build first')
    stamp = built / 'studio-build.json'
    if not stamp.is_file() or json.loads(stamp.read_text()).get('revision') != rev:
        raise RuntimeError('Build does not match this source commit; run bash scripts/studio-build.sh')
    dest = ROOT / 'releases' / rev
    if dest.exists(): raise RuntimeError(f'Release already exists: {dest}')
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(built, dest)
    (dest / 'studio-release.json').write_text(json.dumps({'revision': rev, 'source': str(source), 'builtAt': int(time.time())}))
    print(f'Staged {rev} at {dest}')

def restore_db(backup):
    # Only called while the service is stopped and maintenance blocks traffic.
    for suffix in ['', '-wal', '-shm']:
        (DATA / ('db/data.sqlite' + suffix)).unlink(missing_ok=True)
    shutil.copy2(backup / 'data.sqlite', DATA / 'db/data.sqlite')

def activate(rev, migrate):
    if len(rev) != 40 or any(c not in '0123456789abcdef' for c in rev): raise RuntimeError('Use a full commit SHA')
    release = ROOT / 'releases' / rev
    if not (release / 'studio-release.json').is_file(): raise RuntimeError('Release is not staged')
    ROOT.mkdir(parents=True, exist_ok=True)
    previous = (ROOT / 'current').resolve() if (ROOT / 'current').exists() else None
    if not previous and not migrate: raise RuntimeError('First install requires --migrate-stock')
    backup = ROOT / 'backups' / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + rev[:8])
    backup.mkdir(parents=True, mode=0o700)
    old_plist = PLIST.read_bytes() if PLIST.exists() else None
    if old_plist: (backup / PLIST.name).write_bytes(old_plist)
    MAINTENANCE.write_text('Draining for release ' + rev)
    stopped = False
    backed_up = False
    stock = []
    try:
        if previous:
            for _ in range(60):
                if not status()['pending']: break
                time.sleep(1)
            else: raise RuntimeError('Requests still active after 60 seconds; update cancelled')
        stopped = True
        if migrate:
            for label in ['com.sickmeyer.9router-watchdog', 'com.9router.autostart']:
                p = AGENTS / (label + '.plist')
                if p.exists():
                    shutil.copy2(p, backup / p.name)
                    stop(label)
                    disabled = p.with_suffix('.plist.studio-disabled')
                    p.replace(disabled)
                    stock.append((p, disabled))
        stop(); stopped = True
        # Capture after stopping the worker so background OAuth refresh cannot
        # rotate credentials between the backup and the service stop.
        with sqlite3.connect(DATA / 'db/data.sqlite') as src, sqlite3.connect(backup / 'data.sqlite') as dest:
            src.backup(dest)
        os.chmod(backup / 'data.sqlite', 0o600)
        backed_up = True
        switch(release)
        node = shutil.which('node')
        if not node: raise RuntimeError('Node is not on PATH')
        log = pathlib.Path.home() / 'Library/Logs/9router-studio.log'
        spec = {'Label': LABEL, 'ProgramArguments': [node, str(ROOT / 'current/custom-server.js')],
            'WorkingDirectory': str(ROOT / 'current'), 'RunAtLoad': True, 'KeepAlive': True,
            'ThrottleInterval': 10, 'ExitTimeOut': 30,
            'EnvironmentVariables': {'PATH': os.environ.get('PATH', ''), 'PORT': str(PORT), 'HOSTNAME': '127.0.0.1',
                'NODE_ENV': 'production', 'DATA_DIR': str(DATA), 'STUDIO_RELEASE': rev,
                'STUDIO_CURATED_CATALOG': '1',
                'STUDIO_MAINTENANCE_FILE': str(MAINTENANCE)},
            'StandardOutPath': str(log), 'StandardErrorPath': str(log)}
        PLIST.write_bytes(plistlib.dumps(spec)); start()
        for _ in range(45):
            try:
                if status()['release'] == rev: break
            except Exception: pass
            time.sleep(1)
        else: raise RuntimeError('New release did not pass health check')
        receipt = {'revision': rev, 'previous': str(previous) if previous else None, 'backup': str(backup), 'time': int(time.time())}
        (ROOT / 'last-activation.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt, indent=2))
    except Exception:
        if stopped:
            stop()
            if backed_up: restore_db(backup)
            if previous:
                switch(previous)
                PLIST.write_bytes(old_plist)
                start()
            else:
                PLIST.unlink(missing_ok=True)
                for p, disabled in reversed(stock):
                    disabled.replace(p); start(p)
        raise
    finally:
        MAINTENANCE.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    s = sub.add_parser('stage'); s.add_argument('source')
    a = sub.add_parser('activate'); a.add_argument('revision'); a.add_argument('--migrate-stock', action='store_true')
    sub.add_parser('status')
    args = parser.parse_args()
    if args.command == 'stage': stage(args.source)
    elif args.command == 'activate':
        ROOT.mkdir(parents=True, exist_ok=True)
        with (ROOT / 'release.lock').open('w') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise RuntimeError('Another release operation is already running')
            activate(args.revision, args.migrate_stock)
    else: print(json.dumps(status(), indent=2))

if __name__ == '__main__': main()
