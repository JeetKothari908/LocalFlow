import copy
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

import app as sync_app
from todo_schema import TodoValidationError, validate_todo


KEY = "data/default-todo"
STORE = "tabliss/config"
STAMP = "2026-10-01T15:00:00Z"


def task(task_id, parent=None, **metadata):
    value = {"id": task_id, "contents": task_id, "completed": False, "status": "todo"}
    if parent:
        value["parentTaskId"] = parent
    return {**value, **metadata}


def document(*items, **metadata):
    return {
        "schemaVersion": 2, "items": list(items), "customLists": [],
        "dependencies": [], "occurrences": [], "activity": [], **metadata,
    }


def dependency(dependency_id, prerequisite, dependent):
    return {"id": dependency_id, "prerequisiteTaskId": prerequisite, "dependentTaskId": dependent}


class RecursiveTodoSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        sync_app.DB_PATH = str(Path(self.temp_dir.name) / "test.sqlite3")
        sync_app.AUTH_TOKEN = ""
        sync_app.HISTORY_LIMIT = 500

    def tearDown(self):
        self.temp_dir.cleanup()

    def write(self, value, version=None, base=None, **options):
        return sync_app.apply_changes(STORE, sync_app.Changes(changes=[sync_app.Change(
            key=KEY, value=value, baseVersion=version, baseValue=base, **options,
        )]))

    def snapshot(self):
        return sync_app.get_store(STORE, authorization=None)["changes"][0]

    def assert_http(self, code, action):
        with self.assertRaises(HTTPException) as raised:
            action()
        self.assertEqual(raised.exception.status_code, code)
        return raised.exception.detail

    def test_schema1_remains_compatible_until_migration(self):
        self.write({"items": [{"id": "legacy"}]})
        upgraded = self.write(document(task("legacy")), 1)
        self.assertEqual(upgraded["versions"][KEY], 2)
        detail = self.assert_http(428, lambda: self.write({"items": [{"id": "legacy"}]}, 2))
        self.assertEqual(detail["requiredTodoSchemaVersion"], 2)
        self.assertEqual(self.snapshot()["value"]["schemaVersion"], 2)

    def test_downgrade_restore_and_unversioned_writes_are_protected(self):
        self.write({"items": []})
        self.write(document(task("root")), 1)
        self.assert_http(428, lambda: self.write(document(task("changed"))))
        self.assert_http(428, lambda: sync_app.restore_revision(sync_app.RestoreRevision(
            store=STORE, key=KEY, version=1, baseVersion=2, todoSchemaVersion=2,
        )))
        self.assertEqual(self.snapshot()["version"], 2)

    def test_deletion_requires_capability_and_tombstone_remembers_schema(self):
        value = document(task("root"))
        self.write(value)
        self.assert_http(428, lambda: self.write(None, 1, deleted=True))
        self.assert_http(409, lambda: self.write(None, 0, deleted=True, todoSchemaVersion=2))
        self.write(None, 1, deleted=True, todoSchemaVersion=2)
        self.assertTrue(self.snapshot()["deleted"])
        self.assert_http(428, lambda: self.write({"items": []}, 2))
        self.assert_http(428, lambda: self.write(None, 2, deleted=True))
        self.write(value, 2, todoSchemaVersion=2)
        self.assertEqual(self.snapshot()["value"], value)

    def test_disjoint_entities_and_field_edits_merge(self):
        base = document(task("root"), task("child", "root"))
        self.write(base)
        remote = copy.deepcopy(base)
        remote["items"][0]["contents"] = "Renamed project"
        remote["items"][1]["description"] = "Instructions"
        remote["items"][1]["updatedAt"] = "2026-10-01T15:00:00Z"
        remote["activity"] = [{"id": "remote-event", "taskId": "child", "type": "edited", "at": STAMP}]
        self.write(remote, 1)
        local = copy.deepcopy(base)
        local["items"][1]["dueDate"] = "2026-10-02"
        local["items"][1]["updatedAt"] = "2026-10-01T16:00:00Z"
        local["activity"] = [{"id": "local-event", "taskId": "child", "type": "scheduled", "at": STAMP}]
        response = self.write(local, 1, base)
        self.assertEqual(response["versions"][KEY], 3)
        merged = response["changes"][0]["value"]
        self.assertEqual(merged["items"][0]["contents"], "Renamed project")
        self.assertEqual(merged["items"][1]["description"], "Instructions")
        self.assertEqual(merged["items"][1]["dueDate"], "2026-10-02")
        self.assertEqual(merged["items"][1]["updatedAt"], "2026-10-01T16:00:00Z")
        self.assertEqual({event["id"] for event in merged["activity"]}, {"local-event", "remote-event"})
        self.assertEqual(self.snapshot()["value"], merged)

    def test_same_field_conflict_returns_latest_value_without_writing(self):
        base = document(task("root"))
        self.write(base)
        remote = document(task("root", contents="Remote title"))
        local = document(task("root", contents="Local title"))
        self.write(remote, 1)
        detail = self.assert_http(409, lambda: self.write(local, 1, base))
        self.assertIn("items[root].contents", detail["conflicts"])
        self.assertEqual(detail["currentValue"], remote)
        self.assertEqual(detail["currentVersion"], 2)
        self.assertEqual(self.snapshot()["version"], 2)

    def test_same_entity_disjoint_deleted_field_merges(self):
        base = document(task("root", description="Old notes"))
        self.write(base)
        remote = document(task("root", description="Old notes", dueDate="2026-10-02"))
        local = document(task("root"))
        self.write(remote, 1)
        merged = self.write(local, 1, base)["changes"][0]["value"]
        self.assertNotIn("description", merged["items"][0])
        self.assertEqual(merged["items"][0]["dueDate"], "2026-10-02")

    def test_physical_and_soft_delete_conflict_with_edit(self):
        for soft in (False, True):
            with self.subTest(soft=soft):
                base = document(task("root"))
                version = self.snapshot()["version"] if self.snapshot_if_present() else 0
                self.write(base, version if version else None)
                base_version = self.snapshot()["version"]
                remote = document(task("root", description="New work"))
                self.write(remote, base_version)
                local = document(task("root", deletedAt=STAMP)) if soft else document()
                self.assert_http(409, lambda: self.write(local, base_version, base))
                self.assertEqual(self.snapshot()["value"], remote)

    def snapshot_if_present(self):
        return sync_app.get_store(STORE, authorization=None)["changes"]

    def test_stale_write_without_snapshot_and_fabricated_snapshot_conflict(self):
        base = document(task("root"))
        self.write(base)
        remote = document(task("root", description="Remote"))
        self.write(remote, 1)
        local = document(task("root", dueDate="2026-10-03"))
        self.assert_http(409, lambda: self.write(local, 1))
        fake_base = document(task("root", contents="Fake baseline"))
        detail = self.assert_http(409, lambda: self.write(local, 1, fake_base))
        self.assertIn("base snapshot", detail["message"])

    def test_current_version_with_older_snapshot_cannot_overwrite_remote_edit(self):
        base = document(task("root"))
        self.write(base)
        remote = document(task("root", description="Remote change"))
        self.write(remote, 1)
        local = document(task("root", dueDate="2026-10-03"))
        detail = self.assert_http(409, lambda: self.write(local, 2, base))
        self.assertEqual(detail["conflicts"], ["$baseValue"])
        self.assertEqual(self.snapshot()["value"], remote)

    def test_schema_protection_survives_history_purge_after_delete(self):
        self.write(document(task("root")))
        self.write(None, 1, deleted=True, todoSchemaVersion=2)
        sync_app.purge_history(STORE, KEY, authorization=None)
        self.assert_http(428, lambda: self.write({"items": []}, 2))
        self.assertTrue(self.snapshot()["deleted"])

    def test_invalid_graph_after_merge_rolls_back_entire_batch(self):
        base = document(task("a"), task("b"))
        self.write(base)
        remote = copy.deepcopy(base)
        remote["dependencies"] = [dependency("ab", "a", "b")]
        self.write(remote, 1)
        local = copy.deepcopy(base)
        local["dependencies"] = [dependency("ba", "b", "a")]
        body = sync_app.Changes(changes=[
            sync_app.Change(key="data/default-notes", value={"notes": ["must roll back"]}),
            sync_app.Change(key=KEY, value=local, baseVersion=1, baseValue=base),
        ])
        detail = self.assert_http(409, lambda: sync_app.apply_changes(STORE, body))
        self.assertIn("invalid task hierarchy", detail["message"])
        snapshot = sync_app.get_store(STORE, authorization=None)["changes"]
        self.assertEqual(len(snapshot), 1)
        self.assertEqual(snapshot[0]["value"], remote)

    def test_concurrent_reparenting_cycle_is_rejected(self):
        base = document(task("a"), task("b"))
        self.write(base)
        remote = document(task("a", "b"), task("b"))
        local = document(task("a"), task("b", "a"))
        self.write(remote, 1)
        self.assert_http(409, lambda: self.write(local, 1, base))

    def test_concurrent_parent_completion_and_new_subtask_conflict(self):
        base = document(task("root"))
        self.write(base)
        remote = document(task("root", completed=True, status="done", completedAt=STAMP))
        local = document(task("root"), task("new-step", "root"))
        self.write(remote, 1)
        detail = self.assert_http(409, lambda: self.write(local, 1, base))
        self.assertIn("unfinished work", detail["conflicts"][0])
        self.assertEqual(self.snapshot()["value"], remote)

    def test_concurrent_branch_trash_and_new_subtask_conflict(self):
        base = document(task("root"))
        self.write(base)
        remote = document(task("root", deletedAt=STAMP, deletedByTaskId="root"))
        local = document(task("root"), task("new-step", "root"))
        self.write(remote, 1)
        detail = self.assert_http(409, lambda: self.write(local, 1, base))
        self.assertIn("live work is beneath deleted task", detail["conflicts"][0])
        self.assertEqual(self.snapshot()["value"], remote)

    def test_disjoint_new_tasks_and_removed_entities_merge(self):
        base = document(task("root"), task("old", "root"))
        self.write(base)
        remote = document(task("root"), task("old", "root"), task("remote", "root"))
        local = document(task("root"), task("local", "root"))
        self.write(remote, 1)
        merged = self.write(local, 1, base)["changes"][0]["value"]
        self.assertEqual({item["id"] for item in merged["items"]}, {"root", "remote", "local"})

    def test_unknown_fields_survive_merge(self):
        base = document(task("root", futureSettings={"color": "blue"}), unknownDocumentField={"enabled": True})
        self.write(base)
        remote = copy.deepcopy(base)
        remote["items"][0]["dueDate"] = "2026-10-04"
        self.write(remote, 1)
        local = copy.deepcopy(base)
        local["items"][0]["contents"] = "Local"
        merged = self.write(local, 1, base)["changes"][0]["value"]
        self.assertEqual(merged["items"][0]["futureSettings"], {"color": "blue"})
        self.assertEqual(merged["unknownDocumentField"], {"enabled": True})

    def test_notes_keep_existing_conflict_behavior(self):
        sync_app.apply_changes(STORE, sync_app.Changes(changes=[sync_app.Change(key="notes", value={"a": 1})]))
        sync_app.apply_changes(STORE, sync_app.Changes(changes=[sync_app.Change(key="notes", value={"a": 2}, baseVersion=1)]))
        self.assert_http(409, lambda: sync_app.apply_changes(STORE, sync_app.Changes(changes=[
            sync_app.Change(key="notes", value={"a": 1, "b": 1}, baseVersion=1, baseValue={"a": 1}),
        ])))


class RecursiveTodoValidationTests(unittest.TestCase):
    def assert_invalid(self, value):
        with self.assertRaises(TodoValidationError):
            validate_todo(value)

    def test_deep_hierarchy_has_no_arbitrary_depth_limit(self):
        items = [task(str(index), str(index - 1) if index else None) for index in range(5000)]
        validate_todo(document(*items))

    def test_cycles_and_missing_references(self):
        self.assert_invalid(document(task("a", "b"), task("b", "a")))
        self.assert_invalid(document(task("a", "missing")))
        self.assert_invalid(document(task("a"), dependencies=[dependency("d", "a", "missing")]))
        self.assert_invalid(document(task("a"), dependencies=[dependency("d", "a", "a")]))
        self.assert_invalid(document(task("a"), task("b"), dependencies=[dependency("ab", "a", "b"), dependency("ba", "b", "a")]))

    def test_inherited_dependency_cycle(self):
        # Root waits for external; external waits for a child gated by root.
        self.assert_invalid(document(task("root"), task("child", "root"), task("external"), dependencies=[
            dependency("external-root", "external", "root"), dependency("child-external", "child", "external"),
        ]))
        # Neither ancestor nor descendant can be its own branch prerequisite.
        self.assert_invalid(document(task("root"), task("child", "root"), dependencies=[dependency("d", "root", "child")]))
        self.assert_invalid(document(task("root"), task("child", "root"), dependencies=[dependency("d", "child", "root")]))

    def test_lists_and_metadata_validation(self):
        self.assert_invalid(document(task("root", listId="missing")))
        self.assert_invalid(document(task("root"), task("child", "root", listId="work"), customLists=[{"id": "work", "name": "Work"}]))
        self.assert_invalid(document(task("root", dueDate="2026-02-30")))
        self.assert_invalid(document(task("root", plannedStart="tomorrow")))
        self.assert_invalid(document(task("root", dueTime="25:00")))
        self.assert_invalid(document(task("root", estimatedMinutes=-1)))
        self.assert_invalid(document(task("root", order=float("inf"))))
        self.assert_invalid(document(task("root", status="done")))
        self.assert_invalid(document(task("root", repeat={"type": "custom", "days": []})))
        self.assert_invalid(document(task("root", repeat={"type": "weekly", "days": [7]})))
        self.assert_invalid(document(task("root", repeat={"type": "monthly", "day": 32})))

    def test_valid_monthly_archive_and_snapshot(self):
        validate_todo(document(
            task("root", archivedAt=STAMP, repeat={"type": "monthly", "day": 31}, repeatScope="branch"),
            occurrences=[{"id": "occurrence", "taskId": "removed-source", "completedAt": STAMP, "items": [task("historic", completed=True, status="done")]}],
        ))

    def test_completed_parents_require_active_children_done(self):
        self.assert_invalid(document(task("root", completed=True, status="done"), task("child", "root")))
        validate_todo(document(task("root", completed=True, status="done"), task("child", "root", archivedAt=STAMP), task("grandchild", "child")))
        validate_todo(document(task("root", completed=True, status="done"), task("child", "root", status="canceled"), task("grandchild", "child")))

    def test_deleted_branch_requires_descendant_tombstones(self):
        self.assert_invalid(document(task("root", deletedAt=STAMP), task("child", "root")))
        validate_todo(document(task("root", deletedAt=STAMP), task("child", "root", deletedAt=STAMP)))

    def test_snapshot_external_parent_and_removed_prerequisite_are_valid(self):
        validate_todo(document(occurrences=[{
            "id": "occurrence", "taskId": "historic", "completedAt": STAMP,
            "items": [task("historic", "former-parent", completed=True, status="done")],
            "dependencies": [dependency("external", "former-prerequisite", "historic")],
        }]))


if __name__ == "__main__":
    unittest.main()
