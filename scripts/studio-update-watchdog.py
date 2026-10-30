#!/usr/bin/env python3
"""Monitor Studio updates independently; recover missed checks without interrupting work."""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import plistlib
import shutil
import subprocess
import time

ROOT = pathlib.Path.home() / 'Library/Application Support/9router-studio'
LABEL = 'com.sickmeyer.9router-update-watchdog'
UPDATER = 'com.sickmeyer.9router-autoupdate'


class Watchdog:
    def __init__(self, root=ROOT):
        self.root = root
        self.work = root / 'autoupdate'
        self.work.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.work / 'watchdog.json'
        try: self.state = json.loads(self.path.read_text())
        except (OSError, ValueError): self.state = {}
        if not isinstance(self.state, dict): self.state = {}

    def health(self):
        revision = (self.root / 'current').resolve().name
        output = subprocess.check_output([shutil.which('node') or 'node',
            str(self.root / 'source/scripts/studio-update-health.cjs'), str(self.work), revision], text=True, timeout=15)
        return json.loads(output)

    def recover_scheduler(self):
        domain = f'gui/{os.getuid()}'
        target = domain + '/' + UPDATER
        loaded = subprocess.run(['launchctl', 'print', target], capture_output=True, timeout=15)
        if loaded.returncode == 0:
            subprocess.run(['launchctl', 'kickstart', target], check=True, capture_output=True, timeout=15)
        else:
            plist = pathlib.Path.home() / 'Library/LaunchAgents' / (UPDATER + '.plist')
            configuration = plistlib.loads(plist.read_bytes())
            if configuration.get('Label') != UPDATER or str(self.root / 'source/scripts/studio-autoupdate.py') not in configuration.get('ProgramArguments', []):
                raise RuntimeError('Updater LaunchAgent does not match the Studio installation')
            subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True, capture_output=True, timeout=15)

    def notify(self, message):
        script = 'on run argv\ndisplay notification (item 1 of argv) with title "9Router updates"\nend run'
        subprocess.run(['osascript', '-e', script, message], check=True, capture_output=True, timeout=15)

    def run(self):
        with (self.work / 'watchdog.lock').open('a') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return
            now = int(time.time())
            try: health = self.health()
            except Exception:
                health = {'status': 'unavailable', 'stale': True, 'needsAttention': True,
                    'message': 'Automatic update status is unavailable. Open Studio controls.'}
            self.state.update(lastCheck=now, status=health['status'])
            recovered = False
            paused = (self.work / 'paused').exists()
            if health.get('stale') and not paused and now - self.state.get('lastRecovery', 0) >= 3600:
                with (self.work / 'update.lock').open('a') as update_lock:
                    try:
                        fcntl.flock(update_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        available = True
                    except BlockingIOError: available = False
                if available:
                    self.state['lastRecovery'] = now
                    try:
                        self.recover_scheduler()
                        self.state['recoveryError'] = None
                        recovered = True
                    except Exception:
                        self.state['recoveryError'] = 'Could not restart the automatic update scheduler'
            # Give a newly recovered scheduler one watchdog interval to report.
            if health.get('needsAttention') and not recovered:
                fingerprint = hashlib.sha256(json.dumps({key: health.get(key) for key in
                    ('status', 'upstreamTag', 'error', 'conflicts')}, sort_keys=True).encode()).hexdigest()
                if fingerprint != self.state.get('notification') or now - self.state.get('notifiedAt', 0) >= 86400:
                    try:
                        self.notify(health['message'] + ' Open Studio controls for details.')
                        self.state.update(notification=fingerprint, notifiedAt=now, notificationError=None)
                    except Exception:
                        self.state['notificationError'] = 'macOS notification could not be delivered'
            elif not health.get('needsAttention'):
                self.state.update(notification=None, notifiedAt=None, recoveryError=None, notificationError=None)
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.state, indent=2) + '\n')
            os.chmod(temporary, 0o600)
            temporary.replace(self.path)
            print(json.dumps(self.state))


def install(root=ROOT):
    domain = f'gui/{os.getuid()}'
    if subprocess.run(['launchctl', 'print', domain + '/' + LABEL], capture_output=True).returncode == 0:
        raise RuntimeError('Watchdog is already installed')
    script = root / 'source/scripts/studio-update-watchdog.py'
    if not script.is_file(): raise RuntimeError('Publish the watchdog in the source checkout before installing')
    work = root / 'autoupdate'
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = pathlib.Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    spec = {'Label': LABEL, 'ProgramArguments': ['/usr/bin/python3', str(script)],
        'WorkingDirectory': str(root / 'source'), 'RunAtLoad': True, 'StartInterval': 900,
        'ProcessType': 'Background', 'Nice': 10,
        'EnvironmentVariables': {'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
        'StandardOutPath': str(work / 'watchdog.log'), 'StandardErrorPath': str(work / 'watchdog.log')}
    path.write_bytes(plistlib.dumps(spec))
    subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True)
    print(f'Installed Studio update watchdog: {path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    if args.install: install()
    else: Watchdog().run()
