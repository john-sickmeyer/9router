import importlib.util
import json
import pathlib
import plistlib
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('release_test', SCRIPTS / 'studio-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.data = self.root / 'data'
        (self.data / 'db').mkdir(parents=True)
        self.database = self.data / 'db/data.sqlite'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE accounts (value TEXT)')
            db.execute("INSERT INTO accounts VALUES ('original')")
        self.old = self.root / 'releases' / ('a' * 40)
        self.new = self.root / 'releases' / ('b' * 40)
        for directory in (self.old, self.new):
            directory.mkdir(parents=True)
            (directory / 'studio-release.json').write_text('{}')
        (self.root / 'current').symlink_to(self.old)
        self.plist = self.root / 'service.plist'
        self.plist.write_bytes(plistlib.dumps({'Label': release.LABEL}))
        for name, value in [('ROOT', self.root), ('DATA', self.data), ('PLIST', self.plist),
                            ('MAINTENANCE', self.root / 'maintenance')]:
            patch = mock.patch.object(release, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        for name in ('stop', 'start'):
            patch = mock.patch.object(release, name)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(release.time, 'sleep')
        patch.start()
        self.addCleanup(patch.stop)

    def value(self):
        with closing(sqlite3.connect(self.database)) as db:
            return db.execute('SELECT value FROM accounts').fetchone()[0]

    def test_unhealthy_boot_restores_build_and_database(self):
        def start(*args):
            if (self.root / 'current').resolve() == self.new:
                with closing(sqlite3.connect(self.database)) as db, db:
                    db.execute("UPDATE accounts SET value='migrated'")
        release.start.side_effect = start
        def health(rev, baseline=None):
            if rev == self.new.name: raise RuntimeError('Broken catalog')
            return []
        with mock.patch.object(release, 'status', return_value={'pending': []}), mock.patch.object(release, 'health', side_effect=health):
            with self.assertRaisesRegex(RuntimeError, 'health check'):
                release.activate(self.new.name, False)
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(self.value(), 'original')
        self.assertFalse((self.root / 'maintenance').exists())
        self.assertFalse((self.root / 'activation-in-progress.json').exists())

    def test_drain_timeout_does_not_stop_the_service(self):
        with mock.patch.object(release, 'status', return_value={'pending': ['busy']}), mock.patch.object(release, 'health', return_value=[]):
            with self.assertRaisesRegex(RuntimeError, 'Requests still active'):
                release.activate(self.new.name, False)
        release.stop.assert_not_called()
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertFalse((self.root / 'maintenance').exists())

    def test_transport_drain_waits_for_http_then_ignores_stale_audit(self):
        states = [
            {'pending': [], 'transport': {'version': 1, 'activeCount': 1, 'pending': ['active']}},
            {'pending': ['stale-audit'], 'transport': {'version': 1, 'activeCount': 0, 'pending': []}},
        ]
        with mock.patch.object(release, 'status', side_effect=states), mock.patch.object(release, 'health', return_value=[]):
            release.activate(self.new.name, False)
        release.time.sleep.assert_called_once_with(1)
        release.stop.assert_called_once()
        self.assertEqual((self.root / 'current').resolve(), self.new)
        self.assertFalse((self.root / 'maintenance').exists())

    def test_invalid_transport_state_never_stops_the_service(self):
        for index, transport in enumerate([None, [], {}, {'version': 2, 'activeCount': 0, 'pending': []},
                {'version': 1, 'activeCount': 0, 'pending': ['active']},
                {'version': 1, 'activeCount': False, 'pending': []}]):
            with self.subTest(transport=transport), mock.patch.object(release.time, 'strftime', return_value=str(index)), mock.patch.object(release, 'status', return_value={
                    'pending': [], 'transport': transport}), mock.patch.object(release, 'health', return_value=[]):
                with self.assertRaisesRegex(RuntimeError, 'Invalid transport'):
                    release.activate(self.new.name, False)
            release.stop.assert_not_called()
            self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_transport_timeout_uses_typed_deferral(self):
        with mock.patch.object(release, 'status', return_value={'pending': [], 'transport': {
                'version': 1, 'activeCount': 1, 'pending': ['streaming']}}), mock.patch.object(release, 'health', return_value=[]):
            with self.assertRaises(release.DrainTimeout):
                release.activate(self.new.name, False)
        release.stop.assert_not_called()

    def test_interrupted_activation_recovers_snapshot_before_reopening(self):
        backup = self.root / 'snapshot'
        backup.mkdir()
        (backup / self.plist.name).write_bytes(self.plist.read_bytes())
        with closing(sqlite3.connect(self.database)) as source, closing(sqlite3.connect(backup / 'data.sqlite')) as dest:
            source.backup(dest)
        release.switch(self.new)
        with closing(sqlite3.connect(self.database)) as db, db: db.execute("UPDATE accounts SET value='partial'")
        (self.root / 'maintenance').touch()
        (self.root / 'activation-in-progress.json').write_text(json.dumps({
            'previous': str(self.old), 'backup': str(backup), 'backedUp': True}))
        with mock.patch.object(release, 'health', return_value=[]): release.recover()
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(self.value(), 'original')
        self.assertFalse((self.root / 'maintenance').exists())

    def test_failed_recovery_keeps_maintenance_and_journal(self):
        backup = self.root / 'snapshot'
        backup.mkdir()
        (backup / self.plist.name).write_bytes(self.plist.read_bytes())
        (self.root / 'maintenance').touch()
        (self.root / 'activation-in-progress.json').write_text(json.dumps({
            'previous': str(self.old), 'backup': str(backup), 'backedUp': False}))
        with mock.patch.object(release, 'health', side_effect=RuntimeError('Unhealthy')):
            with self.assertRaisesRegex(RuntimeError, 'maintenance retained'): release.recover()
        self.assertTrue((self.root / 'maintenance').exists())
        self.assertTrue((self.root / 'activation-in-progress.json').exists())


if __name__ == '__main__': unittest.main()
