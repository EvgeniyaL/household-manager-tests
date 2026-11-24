import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
import unittest

spec = importlib.util.spec_from_file_location("backup_budget", Path(__file__).resolve().parents[1] / "tools" / "backup_budget.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Backups(unittest.TestCase):
    def test_consistent_wal_snapshot_and_bounded_rotation(self):
        with tempfile.TemporaryDirectory(prefix="kin-backup-test-") as folder:
            root = Path(folder).resolve()
            live = root / "live.db"
            backups = root / "backups"
            with closing(sqlite3.connect(live)) as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE example (note TEXT)")
                db.execute("INSERT INTO example VALUES ('private fixture')")
                db.commit()
                target = module.backup(live, backups)
                with closing(sqlite3.connect(target)) as snapshot:
                    self.assertEqual(snapshot.execute("SELECT note FROM example").fetchone()[0], "private fixture")
                    self.assertEqual(snapshot.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            now = datetime.now(timezone.utc)
            old = backups / f"kin-backup-{now-timedelta(days=34, seconds=1):%Y%m%dT%H%M%SZ}-{'0'*32}.db"
            old.write_bytes(b"expired snapshot")
            # Updating mtime must not extend the lifetime recorded in the name.
            old.touch()
            partial = old.with_suffix(".db.partial")
            partial.write_bytes(b"abandoned partial")
            unrelated = backups / "important.db"
            unrelated.write_bytes(b"unmanaged")
            self.assertEqual(module.rotate(backups, now),2)
            self.assertFalse(old.exists())
            self.assertFalse(partial.exists())
            self.assertTrue(target.exists())
            self.assertEqual(unrelated.read_bytes(),b"unmanaged")
            self.assertTrue(live.exists())
            with self.assertRaises(ValueError): module.backup(live,backups,35)
            with self.assertRaises(ValueError): module.backup(target,backups)

    def test_rotation_runs_even_if_backup_source_is_missing(self):
        with tempfile.TemporaryDirectory(prefix="kin-backup-test-") as folder:
            root = Path(folder).resolve()
            backups = root / "backups"
            backups.mkdir()
            old = backups / "kin-backup-20000101T000000Z-00000000000000000000000000000000.db"
            old.write_bytes(b"expired")
            with self.assertRaises(FileNotFoundError): module.backup(root / "missing.db",backups)
            self.assertFalse(old.exists())
            self.assertIsNone(module.backup(root / "missing.db",backups,rotate_only=True))

if __name__ == "__main__": unittest.main()
