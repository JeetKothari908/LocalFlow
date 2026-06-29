import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

import app as sync_app


class RevisionHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test.sqlite3"
        sync_app.DB_PATH = str(self.db_path)
        sync_app.AUTH_TOKEN = ""
        sync_app.HISTORY_LIMIT = 500

        # Reproduce the pre-history schema to exercise the real migration.
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                create table kv (
                  store text not null,
                  key text not null,
                  value text,
                  deleted integer not null default 0,
                  updated_at integer not null,
                  primary key (store, key)
                )
                """
            )
            conn.execute(
                """
                insert into kv (store, key, value, deleted, updated_at)
                values ('tabliss/config', 'data/default-todo', ?, 0, 100)
                """,
                (json.dumps({"items": []}),),
            )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def revisions(self, key: str = "data/default-todo") -> list[sqlite3.Row]:
        with sync_app.connect() as conn:
            return conn.execute(
                """
                select * from kv_revisions
                where store = 'tabliss/config' and key = ?
                order by version
                """,
                (key,),
            ).fetchall()

    def test_migration_adds_version_and_backfills_baseline(self) -> None:
        with sync_app.connect() as conn:
            columns = {
                row[1] for row in conn.execute("pragma table_info(kv)").fetchall()
            }
            current = conn.execute(
                "select version from kv where key = 'data/default-todo'"
            ).fetchone()

        self.assertIn("version", columns)
        self.assertEqual(current["version"], 1)
        revisions = self.revisions()
        self.assertEqual(len(revisions), 1)
        self.assertEqual(revisions[0]["operation"], "baseline")

    def test_write_noop_and_conflict(self) -> None:
        response = sync_app.apply_changes(
            "tabliss/config",
            sync_app.Changes(
                changes=[
                    sync_app.Change(
                        key="data/default-todo",
                        value={"items": [{"id": "one"}]},
                        baseVersion=1,
                    )
                ],
                clientId="test-client",
            ),
        )
        self.assertEqual(response["versions"]["data/default-todo"], 2)
        self.assertEqual(len(self.revisions()), 2)

        # Repeating the same desired value is accepted without history spam,
        # even if the caller learned it from an older snapshot.
        noop = sync_app.apply_changes(
            "tabliss/config",
            sync_app.Changes(
                changes=[
                    sync_app.Change(
                        key="data/default-todo",
                        value={"items": [{"id": "one"}]},
                        baseVersion=1,
                    )
                ]
            ),
        )
        self.assertEqual(noop["versions"]["data/default-todo"], 2)
        self.assertEqual(len(self.revisions()), 2)

        with self.assertRaises(HTTPException) as raised:
            sync_app.apply_changes(
                "tabliss/config",
                sync_app.Changes(
                    changes=[
                        sync_app.Change(
                            key="data/default-todo",
                            value={"items": [{"id": "stale"}]},
                            baseVersion=1,
                        )
                    ]
                ),
            )
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(len(self.revisions()), 2)

    def test_restore_creates_new_revision_and_purge_keeps_baseline(self) -> None:
        for item_id, base_version in (("one", 1), ("two", 2)):
            sync_app.apply_changes(
                "tabliss/config",
                sync_app.Changes(
                    changes=[
                        sync_app.Change(
                            key="data/default-todo",
                            value={"items": [{"id": item_id}]},
                            baseVersion=base_version,
                        )
                    ]
                ),
            )

        restored = sync_app.restore_revision(
            sync_app.RestoreRevision(
                store="tabliss/config",
                key="data/default-todo",
                version=2,
                baseVersion=3,
                clientId="test-restore",
            )
        )
        self.assertEqual(restored["versions"]["data/default-todo"], 4)
        revisions = self.revisions()
        self.assertEqual(revisions[-1]["operation"], "restore")
        self.assertEqual(revisions[-1]["restored_from"], 2)

        purged = sync_app.purge_history(
            store="tabliss/config",
            key="data/default-todo",
            authorization=None,
        )
        self.assertEqual(purged["deleted"], 3)
        revisions = self.revisions()
        self.assertEqual(len(revisions), 1)
        self.assertEqual(revisions[0]["version"], 4)
        self.assertEqual(revisions[0]["operation"], "baseline")

    def test_retention_keeps_latest_revisions(self) -> None:
        sync_app.HISTORY_LIMIT = 2
        for version in range(1, 5):
            sync_app.apply_changes(
                "tabliss/config",
                sync_app.Changes(
                    changes=[
                        sync_app.Change(
                            key="data/default-todo",
                            value={"items": [{"id": str(version)}]},
                        )
                    ]
                ),
            )
        self.assertEqual([row["version"] for row in self.revisions()], [4, 5])

    def test_snapshot_and_history_include_versions(self) -> None:
        snapshot = sync_app.get_store("tabliss/config", authorization=None)
        self.assertEqual(snapshot["changes"][0]["version"], 1)
        self.assertEqual(snapshot["changes"][0]["updatedAt"], 100)

        history = sync_app.get_history(
            store="tabliss/config",
            key="data/default-todo",
            limit=50,
            authorization=None,
        )
        self.assertEqual(history["revisions"][0]["version"], 1)
        self.assertEqual(history["revisions"][0]["operation"], "baseline")


if __name__ == "__main__":
    unittest.main()
