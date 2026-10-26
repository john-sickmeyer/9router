import fcntl
import contextlib
import io
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('studio_autoupdate', SCRIPTS / 'studio-autoupdate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.DEVNULL, text=True).strip()


class Release:
    def __init__(self, revision):
        self.revision = revision
        self.pending = []
        self.activations = []
        self.fail = False

    def status(self): return {'release': self.revision, 'pending': self.pending}
    def health(self, revision):
        if revision != self.revision: raise RuntimeError('Wrong live release')
    def recover(self): pass
    def stage(self, candidate): pass
    def activate(self, revision, migrate):
        if self.fail: raise RuntimeError('Candidate failed health; rolled back')
        self.activations.append(revision)
        self.revision = revision


class UpdateTest(unittest.TestCase):
    def setUp(self):
        quiet = contextlib.redirect_stdout(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.upstream = self.root / 'upstream'
        self.origin = self.root / 'origin.git'
        self.source = self.root / 'source'
        self.upstream.mkdir()
        git(self.upstream, 'init', '-b', 'master')
        self.identity(self.upstream)
        (self.upstream / 'package.json').write_text('{"version":"1.0.0"}')
        (self.upstream / 'custom.txt').write_text('base\n')
        git(self.upstream, 'add', '.')
        git(self.upstream, 'commit', '-m', 'Upstream base')
        git(self.upstream, 'tag', 'v1.0.0')
        git(self.root, 'init', '--bare', str(self.origin))
        git(self.root, 'clone', str(self.upstream), str(self.source))
        self.identity(self.source)
        git(self.source, 'remote', 'rename', 'origin', 'upstream')
        git(self.source, 'remote', 'add', 'origin', str(self.origin))
        git(self.source, 'switch', '-c', 'studio')
        (self.source / 'custom.txt').write_text('preserve the Studio controls\n')
        git(self.source, 'commit', '-am', 'Custom Studio features')
        git(self.source, 'push', '-u', 'origin', 'studio')
        self.base = git(self.source, 'rev-parse', 'HEAD')
        self.job = module.Updater(self.root)
        self.release = Release(self.base)
        self.job.release = self.release
        self.build_calls = []
        self.failure = None
        original = self.job.command

        def command(*args, **kwargs):
            if args[0] in ('npm', 'bash') or str(args[0]) == sys.executable:
                self.build_calls.append(args)
                if self.failure and self.failure in ' '.join(map(str, args)):
                    raise RuntimeError('Simulated ' + self.failure + ' failure')
                return ''
            return original(*args, **kwargs)
        self.job.command = command

    def identity(self, path):
        git(path, 'config', 'user.name', 'Update Test')
        git(path, 'config', 'user.email', 'test@example.invalid')

    def new_version(self, conflict=False):
        (self.upstream / 'package.json').write_text('{"version":"1.1.0"}')
        if conflict: (self.upstream / 'custom.txt').write_text('upstream conflict\n')
        git(self.upstream, 'commit', '-am', 'New upstream version')
        git(self.upstream, 'tag', 'v1.1.0')
        return git(self.upstream, 'rev-parse', 'HEAD')

    def assert_unchanged(self):
        self.assertEqual(self.release.revision, self.base)
        self.assertEqual(git(self.source, 'rev-parse', 'HEAD'), self.base)
        self.assertEqual(git(self.origin, 'rev-parse', 'studio'), self.base)

    def test_no_new_version_does_not_build_or_restart(self):
        self.assertEqual(self.job.run(), 0)
        self.assertEqual(self.job.state['status'], 'up-to-date')
        self.assertEqual(self.build_calls, [])
        self.assert_unchanged()

    def test_success_preserves_fork_and_pushes_tested_merge(self):
        upstream = self.new_version()
        self.assertEqual(self.job.run(), 0)
        revision = self.release.revision
        self.assertNotEqual(revision, self.base)
        self.assertEqual(git(self.source, 'rev-parse', 'HEAD'), revision)
        self.assertEqual(git(self.origin, 'rev-parse', 'studio'), revision)
        self.assertEqual(git(self.source, 'rev-list', '--parents', '-n', '1', revision).split(), [revision, self.base, upstream])
        self.assertEqual((self.source / 'custom.txt').read_text(), 'preserve the Studio controls\n')
        self.assertEqual(len(self.release.activations), 1)
        self.assertEqual(len(self.build_calls), 5)
        self.assertFalse((self.root / 'autoupdate/candidate').exists())
        self.assertEqual(self.job.state['status'], 'updated')

    def test_conflict_preserves_live_fork_and_records_failure(self):
        self.new_version(conflict=True)
        self.assertEqual(self.job.run(), 1)
        self.assertEqual(self.job.state['phase'], 'merge')
        self.assert_unchanged()
        self.assertEqual(self.build_calls, [])

    def test_test_failure_never_activates_and_retries_with_backoff(self):
        self.new_version()
        self.failure = 'test:studio'
        self.assertEqual(self.job.run(), 1)
        self.assert_unchanged()
        calls = len(self.build_calls)
        self.assertEqual(self.job.run(), 0)
        self.assertEqual(self.job.state['status'], 'retry-wait')
        self.assertEqual(len(self.build_calls), calls)
        self.job.state['retryAfter'] = 0
        self.failure = None
        self.assertEqual(self.job.run(), 0)
        self.assertEqual(self.job.state['status'], 'updated')

    def test_candidate_probe_failure_never_activates(self):
        self.new_version()
        self.failure = 'studio-candidate-check.py'
        self.assertEqual(self.job.run(), 1)
        self.assert_unchanged()

    def test_busy_service_defers_then_reuses_validated_candidate(self):
        self.new_version()
        self.release.pending = ['active-request']
        self.assertEqual(self.job.run(), 0)
        self.assertEqual(self.job.state['status'], 'deferred')
        self.assert_unchanged()
        calls = len(self.build_calls)
        self.release.pending = []
        self.assertEqual(self.job.run(), 0)
        self.assertEqual(self.job.state['status'], 'updated')
        self.assertEqual(len(self.build_calls), calls)

    def test_activation_failure_keeps_source_and_remote_on_previous(self):
        self.new_version()
        self.release.fail = True
        self.assertEqual(self.job.run(), 1)
        self.assert_unchanged()

    def test_failed_push_recovers_without_redeploying(self):
        self.new_version()
        original = self.job.git
        def git_fail(*args, **kwargs):
            if args[0] == 'push' and '--dry-run' not in args: raise RuntimeError('Network unavailable')
            return original(*args, **kwargs)
        self.job.git = git_fail
        self.assertEqual(self.job.run(), 1)
        self.assertEqual(self.job.state['status'], 'sync-pending')
        self.assertIsNotNone(self.job.state['ready'])
        self.job.git = original
        self.assertEqual(self.job.run(), 0)
        self.assertEqual(self.job.state['status'], 'updated')
        self.assertEqual(len(self.release.activations), 1)

    def test_dirty_source_is_never_overwritten(self):
        self.new_version()
        (self.source / 'user-work.txt').write_text('keep')
        self.assertEqual(self.job.run(), 1)
        self.assert_unchanged()
        self.assertEqual((self.source / 'user-work.txt').read_text(), 'keep')

    def test_prerelease_tag_is_ignored(self):
        git(self.upstream, 'tag', 'v99.0.0-beta.1')
        self.assertEqual(self.job.run(), 0)
        self.assertEqual(self.job.state['upstream']['tag'], 'v1.0.0')

    def test_tag_package_mismatch_is_rejected(self):
        git(self.upstream, 'tag', 'v99.0.0')
        self.assertEqual(self.job.run(), 1)
        self.assert_unchanged()

    def test_overlapping_job_exits_without_touching_state(self):
        with (self.job.work / 'update.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.job.run(), 0)
            self.assertFalse(self.job.state_path.exists())

    def test_pause_is_a_noop(self):
        (self.job.work / 'paused').touch()
        self.assertEqual(self.job.run(), 0)
        self.assertEqual(self.job.state['status'], 'paused')
        self.assert_unchanged()


if __name__ == '__main__': unittest.main()
