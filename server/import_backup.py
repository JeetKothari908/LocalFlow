import json
import sys
from pathlib import Path

import app as sync_app
from todo_schema import TODO_KEY, is_recursive_todo

STORE = "tabliss/config"
PREFIX = f"{STORE}/"


def prepare_changes(backup: dict, snapshot: dict) -> list[sync_app.Change]:
    """Restore an exported document using current versions, without bypassing protection."""
    if not isinstance(backup, dict):
        raise ValueError("The backup must be an exported JSON object.")
    if is_recursive_todo(backup):
        backup = {f"{PREFIX}{TODO_KEY}": backup}
    versions = {change["key"]: change["version"] for change in snapshot["changes"]}
    return [
        sync_app.Change(
            key=full_key[len(PREFIX):], value=value,
            baseVersion=versions.get(full_key[len(PREFIX):], 0),
            todoSchemaVersion=2 if full_key == f"{PREFIX}{TODO_KEY}" and is_recursive_todo(value) else None,
        )
        for full_key, value in backup.items() if full_key.startswith(PREFIX)
    ]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python import_backup.py path/to/backup.json")

    backup_path = Path(sys.argv[1])
    with backup_path.open("r", encoding="utf-8") as file:
        backup = json.load(file)

    authorization = f"Bearer {sync_app.AUTH_TOKEN}" if sync_app.AUTH_TOKEN else None
    snapshot = sync_app.get_store(STORE, authorization=authorization)
    changes = prepare_changes(backup, snapshot)
    if not changes:
        raise SystemExit("No LocalFlow records found in this backup.")
    sync_app.apply_changes(
        STORE,
        sync_app.Changes(changes=changes, clientId="backup-import"),
        authorization=authorization,
    )
    print(f"Imported {len(changes)} keys into {Path(sync_app.DB_PATH)} with history")


if __name__ == "__main__":
    main()
