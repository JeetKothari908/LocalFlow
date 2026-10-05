import copy
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

import app as sync_app
from import_backup import PREFIX, STORE, prepare_changes
from todo_schema import TODO_KEY


def document(title="Project"):
    return {"schemaVersion": 2, "items": [{"id": "root", "contents": title, "completed": False}]}


class BackupImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_db = sync_app.DB_PATH
        self.original_token = sync_app.AUTH_TOKEN
        sync_app.DB_PATH = str(Path(self.directory.name) / "import.sqlite3")
        sync_app.AUTH_TOKEN = ""

    def tearDown(self):
        sync_app.DB_PATH = self.original_db
        sync_app.AUTH_TOKEN = self.original_token
        self.directory.cleanup()

    def snapshot(self):
        return sync_app.get_store(STORE, authorization=None)

    def apply(self, changes):
        return sync_app.apply_changes(STORE, sync_app.Changes(changes=changes), authorization=None)

    def test_task_export_restores_as_versioned_revision(self):
        self.apply(prepare_changes(document(), self.snapshot()))
        changes = prepare_changes(document("Restored project"), self.snapshot())
        self.assertEqual(changes[0].baseVersion, 1)
        self.assertEqual(changes[0].todoSchemaVersion, 2)
        result = self.apply(changes)
        self.assertEqual(result["versions"][TODO_KEY], 2)
        self.assertEqual(self.snapshot()["changes"][0]["value"]["items"][0]["contents"], "Restored project")

    def test_intervening_edit_is_preserved_instead_of_overwritten(self):
        self.apply(prepare_changes(document(), self.snapshot()))
        pending = prepare_changes(document("Backup"), self.snapshot())
        self.apply(prepare_changes(document("Newer edit"), self.snapshot()))
        with self.assertRaises(HTTPException) as raised:
            self.apply(pending)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.snapshot()["changes"][0]["value"]["items"][0]["contents"], "Newer edit")

    def test_legacy_backup_cannot_downgrade_recursive_document(self):
        self.apply(prepare_changes(document(), self.snapshot()))
        backup = {PREFIX + TODO_KEY: {"items": []}}
        with self.assertRaises(HTTPException) as raised:
            self.apply(prepare_changes(backup, self.snapshot()))
        self.assertEqual(raised.exception.status_code, 428)
        self.assertEqual(self.snapshot()["changes"][0]["value"]["schemaVersion"], 2)

    def test_full_store_export_remains_compatible(self):
        backup = {PREFIX + TODO_KEY: document(), PREFIX + "data/default-notes": {"items": []}, "other/store": "ignored"}
        original = copy.deepcopy(backup)
        changes = prepare_changes(backup, self.snapshot())
        self.assertEqual({change.key for change in changes}, {TODO_KEY, "data/default-notes"})
        self.apply(changes)
        self.assertEqual(backup, original)
        self.assertEqual(len(self.snapshot()["changes"]), 2)


if __name__ == "__main__":
    unittest.main()
