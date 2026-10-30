import fcntl
import importlib.util
import pathlib
import plistlib
import subprocess
import tempfile
import unittest
from unittest import mock

script = pathlib.Path(__file__).resolve().parents[2] / 'scripts/studio-update-watchdog.py'
spec = importlib.util.spec_from_file_location('studio_update_watchdog', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job = module.Watchdog(pathlib.Path(self.temp.name))
        self.job.health = mock.Mock(return_value={'status': 'up-to-date', 'stale': False, 'needsAttention': False})
        self.job.notify = mock.Mock()
        self.job.recover_scheduler = mock.Mock()
        patch = mock.patch('builtins.print')
        patch.start()
        self.addCleanup(patch.stop)

    def stale(self):
        self.job.health.return_value = {'status': 'stale', 'stale': True, 'needsAttention': True, 'message': 'Missed update check'}

    def test_healthy_job_does_not_restart_or_notify(self):
        self.job.run()
        self.job.notify.assert_not_called()
        self.job.recover_scheduler.assert_not_called()

    def test_recovers_missed_run_then_alerts_if_still_stale(self):
        self.stale()
        self.job.run()
        self.job.recover_scheduler.assert_called_once()
        self.job.notify.assert_not_called()
        self.job.run()
        self.job.recover_scheduler.assert_called_once()
        self.job.notify.assert_called_once()

    def test_does_not_restart_a_busy_or_paused_updater(self):
        self.stale()
        with (self.job.work / 'update.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.job.run()
        (self.job.work / 'paused').touch()
        self.job.run()
        self.job.recover_scheduler.assert_not_called()

    def test_short_pause_is_quiet(self):
        self.job.health.return_value = {'status': 'paused', 'stale': False, 'needsAttention': False}
        (self.job.work / 'paused').touch()
        self.job.run()
        self.job.notify.assert_not_called()
        self.job.recover_scheduler.assert_not_called()

    def test_failure_notifications_are_deduplicated_and_reset_after_recovery(self):
        failure = {'status': 'needs-resolution', 'stale': False, 'needsAttention': True,
            'message': 'Merge needs resolution', 'conflicts': ['headroom.js']}
        self.job.health.return_value = failure
        self.job.run()
        self.job.run()
        self.job.notify.assert_called_once()
        self.job.health.return_value = {'status': 'up-to-date', 'stale': False, 'needsAttention': False}
        self.job.run()
        self.job.health.return_value = failure
        self.job.run()
        self.assertEqual(self.job.notify.call_count, 2)

    def test_recovery_failure_is_recorded_and_notified(self):
        self.stale()
        self.job.recover_scheduler.side_effect = RuntimeError('launchctl unavailable')
        self.job.run()
        self.assertIsNotNone(self.job.state['recoveryError'])
        self.job.notify.assert_called_once()
        self.job.run()
        self.assertIsNotNone(self.job.state['recoveryError'])

    def test_loaded_scheduler_is_kickstarted_without_killing_it(self):
        with mock.patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            module.Watchdog.recover_scheduler(self.job)
        self.assertEqual(run.call_args.args[0], ['launchctl', 'kickstart', f'gui/{module.os.getuid()}/com.sickmeyer.9router-autoupdate'])

    def test_unloaded_scheduler_requires_the_expected_local_plist(self):
        directory = self.job.root / 'Library/LaunchAgents'
        directory.mkdir(parents=True)
        plist = directory / 'com.sickmeyer.9router-autoupdate.plist'
        plist.write_bytes(plistlib.dumps({'Label': module.UPDATER, 'ProgramArguments': ['unrelated-script.py']}))
        with mock.patch.object(module.pathlib.Path, 'home', return_value=self.job.root), mock.patch.object(
                module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as run:
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                module.Watchdog.recover_scheduler(self.job)
        run.assert_called_once()

    def test_notification_failure_does_not_claim_delivery(self):
        self.stale()
        self.job.state['lastRecovery'] = int(module.time.time())
        self.job.notify.side_effect = RuntimeError('osascript unavailable')
        self.job.run()
        self.assertIsNotNone(self.job.state['notificationError'])
        self.assertNotIn('notifiedAt', self.job.state)


if __name__ == '__main__': unittest.main()
