#!/usr/bin/env python3
"""Studio-owned hourly updater: merge stable tags, validate, drain, activate, back up Git."""
import argparse
import fcntl
import importlib.util
import json
import os
import pathlib
import plistlib
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time

ROOT = pathlib.Path.home() / 'Library/Application Support/9router-studio'
LABEL = 'com.sickmeyer.9router-autoupdate'
TAG_PREFIX = 'refs/studio-upstream-tags/'
STABLE = re.compile(r'^v(\d+)\.(\d+)\.(\d+)$')
INTERVAL = 3600
RETRY_DELAY = 6 * 3600


class Deferred(Exception):
    pass


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.chmod(temporary, 0o600)
    temporary.replace(path)


class Updater:
    def __init__(self, root=ROOT):
        self.root = root
        self.repo = root / 'source'
        self.work = root / 'autoupdate'
        self.work.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_path = self.work / 'status.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.log = None
        self.env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
        key = self.work / 'deploy_ed25519'
        if key.exists():
            self.env['GIT_SSH_COMMAND'] = shlex.join(['ssh', '-i', str(key), '-o', 'IdentitiesOnly=yes',
                '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o',
                'UserKnownHostsFile="' + str(self.work / 'known_hosts') + '"'])
        spec = importlib.util.spec_from_file_location('studio_release', pathlib.Path(__file__).with_name('studio-release.py'))
        self.release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.release)

    def save(self, **fields):
        self.state.update(fields)
        write_json(self.state_path, self.state)

    def command(self, *args, cwd=None, timeout=180):
        if self.log:
            self.log.write('+ ' + shlex.join(str(arg) for arg in args) + '\n')
            self.log.flush()
        process = subprocess.Popen([str(arg) for arg in args], cwd=cwd or self.repo, env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try: output, _ = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                output, _ = process.communicate()
            if self.log: self.log.write(output); self.log.flush()
            raise RuntimeError(f'{args[0]} timed out after {timeout}s')
        if self.log: self.log.write(output); self.log.flush()
        if process.returncode:
            raise RuntimeError(f'Command failed ({process.returncode}): ' + shlex.join(str(arg) for arg in args))
        return output.strip()

    def git(self, *args, cwd=None):
        return self.command('git', *args, cwd=cwd)

    def ancestor(self, left, right):
        result = subprocess.run(['git', 'merge-base', '--is-ancestor', left, right], cwd=self.repo,
            env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if result.returncode not in (0, 1): raise RuntimeError('Cannot compare Git ancestry')
        return result.returncode == 0

    def latest(self):
        self.git('fetch', '--no-tags', 'upstream', 'refs/heads/master:refs/remotes/upstream/master',
            'refs/tags/v*:' + TAG_PREFIX + 'v*')
        refs = self.git('for-each-ref', '--format=%(refname)', TAG_PREFIX).splitlines()
        candidates = []
        for ref in refs:
            tag = ref[len(TAG_PREFIX):]
            match = STABLE.fullmatch(tag)
            if match: candidates.append((tuple(map(int, match.groups())), tag, ref))
        if not candidates: raise RuntimeError('Upstream has no stable version tags')
        version, tag, ref = max(candidates)
        revision = self.git('rev-parse', ref + '^{commit}')
        if not self.ancestor(revision, 'upstream/master'):
            raise RuntimeError('Latest stable tag is not on upstream master')
        package = json.loads(self.git('show', revision + ':package.json'))
        if package['version'] != '.'.join(map(str, version)):
            raise RuntimeError('Tag and package version disagree')
        return {'tag': tag, 'revision': revision}

    def require_source(self, allowed):
        if self.git('branch', '--show-current') != 'studio' or self.git('status', '--porcelain'):
            raise RuntimeError('Source must be clean and on the studio branch')
        if self.git('rev-parse', 'HEAD') not in allowed:
            raise RuntimeError('Source changed independently; refusing to overwrite it')

    def remove_candidate(self):
        candidate = self.work / 'candidate'
        if candidate.exists():
            # This one path is owned exclusively by this updater. Never remove the
            # source checkout, other worktrees, releases, or database backups.
            self.git('worktree', 'remove', '--force', str(candidate))

    def prepare(self, base, target):
        self.remove_candidate()
        candidate = self.work / 'candidate'
        self.git('worktree', 'add', '--detach', str(candidate), base)
        self.save(phase='merge')
        self.git('-c', 'user.name=Studio Updater', '-c', 'user.email=studio-updater@localhost',
            'merge', '--no-ff', target['revision'], '-m', f"Merge upstream {target['tag']} into Studio fork", cwd=candidate)
        revision = self.git('rev-parse', 'HEAD', cwd=candidate)
        self.save(phase='dependencies', candidateRevision=revision)
        self.command('npm', 'ci', '--no-audit', '--no-fund', cwd=candidate, timeout=1200)
        self.command('npm', '--prefix', 'tests', 'ci', '--no-audit', '--no-fund', cwd=candidate, timeout=600)
        self.save(phase='tests')
        self.command('npm', '--prefix', 'tests', 'run', 'test:studio', cwd=candidate, timeout=900)
        self.save(phase='build')
        self.command('bash', 'scripts/studio-build.sh', cwd=candidate, timeout=1800)
        self.release.stage(candidate)
        self.save(phase='candidate-health')
        self.command(sys.executable, self.repo / 'scripts/studio-candidate-check.py',
            self.root / 'releases' / revision, revision, '--log', self.work / 'candidate.log', timeout=180)
        ready = {'base': base, 'revision': revision, 'target': target}
        self.save(phase='ready', ready=ready)
        return ready

    def publish(self, ready):
        revision, base = ready['revision'], ready['base']
        self.require_source({base, revision})
        self.git('fetch', '--no-tags', 'origin', 'studio')
        if not self.ancestor('origin/studio', revision):
            raise RuntimeError('Fork changed independently; live release retained, no force push')
        self.git('push', 'origin', revision + ':refs/heads/studio')
        self.git('merge', '--ff-only', revision)
        self.save(status='updated', phase='complete', ready=None, currentRevision=revision,
            lastSuccess={'time': int(time.time()), 'revision': revision, 'upstream': ready['target']},
            error=None, retryAfter=None)
        self.remove_candidate()

    def execute(self):
        if (self.work / 'paused').exists():
            self.save(status='paused', phase='idle')
            return
        # Crash recovery is serialized with manual activation as well as this job.
        with (self.root / 'release.lock').open('a') as release_lock:
            try: fcntl.flock(release_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise Deferred('A release operation is already running')
            self.release.recover()
        live = self.release.status()
        ready = self.state.get('ready')
        if ready and live['release'] == ready['revision']:
            # Handles a crash/network loss after activation, before the Git push.
            self.release.health(ready['revision'])
            self.save(phase='publish')
            self.publish(ready)
            return
        base = self.git('rev-parse', 'HEAD')
        self.require_source({base})
        if live['release'] != base:
            raise RuntimeError('Source and live release differ; refusing an implicit deployment')
        self.git('fetch', '--no-tags', 'origin', 'studio')
        if self.git('rev-parse', 'origin/studio') != base:
            raise RuntimeError('Remote fork and deployed source differ; reconciliation required')
        self.save(phase='checking')
        target = self.latest()
        self.save(upstream=target, currentRevision=base)
        if self.ancestor(target['revision'], base):
            self.release.health(base)
            self.save(status='up-to-date', phase='idle', error=None, retryAfter=None, ready=None)
            return
        attempt = {'base': base, 'target': target}
        if self.state.get('failedAttempt') == attempt and (self.state.get('retryAfter') or 0) > time.time():
            self.save(status='retry-wait', phase='idle')
            return
        self.save(status='running', attempt=attempt, error=None)
        if not ready or ready['base'] != base or ready['target'] != target:
            self.save(ready=None)
            ready = self.prepare(base, target)
        revision = ready['revision']
        self.require_source({base})
        self.git('fetch', '--no-tags', 'origin', 'studio')
        if self.git('rev-parse', 'origin/studio') != base:
            raise RuntimeError('Fork changed during validation; live release retained')
        self.git('push', '--dry-run', 'origin', revision + ':refs/heads/studio')
        # Do not close admission while a long-running request is already active.
        if self.release.status()['pending']:
            raise Deferred('Requests are active; validated candidate waits for the next hourly check')
        with (self.root / 'release.lock').open('a') as release_lock:
            try: fcntl.flock(release_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise Deferred('A release operation is already running')
            if self.release.status()['release'] != base:
                raise RuntimeError('Live release changed during validation')
            self.save(phase='activate')
            self.release.activate(revision, False)
        self.save(phase='publish', status='sync-pending', currentRevision=revision)
        self.publish(ready)

    def run(self):
        with (self.work / 'update.lock').open('a') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('Another automatic update check is running')
                return 0
            stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
            log_path = self.work / ('run-' + stamp + '.log')
            with log_path.open('a') as self.log:
                self.save(lastCheck=int(time.time()), log=str(log_path))
                try:
                    self.execute()
                except Deferred as error:
                    self.save(status='deferred', phase='ready', error=str(error))
                except Exception as error:
                    # Keep a successfully activated revision for publication retry.
                    published_later = self.state.get('phase') == 'publish'
                    self.save(status='sync-pending' if published_later else 'failed',
                        error=str(error), failedAt=int(time.time()), failedAttempt=self.state.get('attempt'),
                        retryAfter=int(time.time()) + RETRY_DELAY,
                        ready=self.state.get('ready') if published_later else None)
                    print(json.dumps(self.state))
                    return 1
                finally:
                    self.save(finishedAt=int(time.time()))
            print(json.dumps(self.state))
            return 0


def install(root=ROOT):
    work = root / 'autoupdate'
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    script = root / 'source/scripts/studio-autoupdate.py'
    if not script.is_file(): raise RuntimeError('Install the committed updater in the Studio source checkout first')
    path = pathlib.Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    spec = {'Label': LABEL, 'ProgramArguments': ['/usr/bin/caffeinate', '-i', '/usr/bin/python3', str(script)],
        'WorkingDirectory': str(root / 'source'), 'RunAtLoad': True, 'StartInterval': INTERVAL,
        'ProcessType': 'Background', 'Nice': 10, 'LowPriorityIO': True, 'ExitTimeOut': 120,
        'EnvironmentVariables': {'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'GIT_TERMINAL_PROMPT': '0'},
        'StandardOutPath': str(work / 'launchd.log'), 'StandardErrorPath': str(work / 'launchd.log')}
    domain = f'gui/{os.getuid()}'
    # Installation is explicit and must not kill a running update.
    existing = subprocess.run(['launchctl', 'print', domain + '/' + LABEL], capture_output=True)
    if existing.returncode == 0:
        raise RuntimeError('Updater is already loaded; unload it after its current run before reinstalling')
    path.write_bytes(plistlib.dumps(spec))
    subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True)
    print(f'Installed hourly Studio updater: {path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    if args.install: install()
    else: sys.exit(Updater().run())
