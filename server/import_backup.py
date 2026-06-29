import json
import sys
from pathlib import Path

from app import AUTH_TOKEN, DB_PATH, Change, Changes, apply_changes

STORE = "tabliss/config"
PREFIX = f"{STORE}/"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python import_backup.py path/to/backup.json")

    backup_path = Path(sys.argv[1])
    with backup_path.open("r", encoding="utf-8") as file:
        backup = json.load(file)

    changes = []
    for full_key, value in backup.items():
        if not full_key.startswith(PREFIX):
            continue

        key = full_key[len(PREFIX) :]
        changes.append(Change(key=key, value=value))

    authorization = f"Bearer {AUTH_TOKEN}" if AUTH_TOKEN else None
    apply_changes(
        STORE,
        Changes(changes=changes, clientId="backup-import"),
        authorization=authorization,
    )
    print(f"Imported {len(changes)} keys into {Path(DB_PATH)} with history")


if __name__ == "__main__":
    main()
