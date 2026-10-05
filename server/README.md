# LocalFlow Sync Server

FastAPI and SQLite sync server for LocalFlow.

The server uses `LOCALFLOW_TOKEN` for auth, `LOCALFLOW_DB` to override the
SQLite database path, and `LOCALFLOW_HISTORY_LIMIT` to control how many
revisions are retained per key (default: `500`; use `0` for unlimited).

## Quick Start (Manual)

```bash
cd ~/todolist-sync/server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export LOCALFLOW_TOKEN='replace-with-your-token'
export LOCALFLOW_HISTORY_LIMIT='500'
uvicorn app:app --host 127.0.0.1 --port 8787
```

## Revision History

The server automatically migrates the existing `kv` table on first start:

- `kv.version` tracks the current version of each key.
- `kv_revisions` contains immutable JSON snapshots.
- Every existing row is backfilled as a version-one baseline.
- New clients send `baseVersion`; stale writes receive HTTP `409` instead of
  replacing newer data. Recursive todo documents can safely merge disjoint
  edits when the client also sends the exact `baseValue` snapshot.
- Restoring an old version creates a new revision and never rewrites history.

Back up the database before first deploying the migration. The migration is
idempotent, so subsequent starts are safe.

List revisions:

```bash
curl -H "Authorization: Bearer replace-with-your-token" \
  "http://127.0.0.1:8787/v1/history?store=tabliss%2Fconfig&key=data%2Fdefault-notes"
```

Restore a revision:

```bash
curl -X POST \
  -H "Authorization: Bearer replace-with-your-token" \
  -H "Content-Type: application/json" \
  -d '{"store":"tabliss/config","key":"data/default-notes","version":1}' \
  http://127.0.0.1:8787/v1/history/restore
```

Permanently remove older revisions while retaining the current value as a
baseline:

```bash
curl -X DELETE \
  -H "Authorization: Bearer replace-with-your-token" \
  "http://127.0.0.1:8787/v1/history?store=tabliss%2Fconfig&key=data%2Fdefault-notes"
```

## Recursive Tasks and Concurrent Editing

The existing `python import_backup.py path/to/export.json` recovery command also
accepts the task dashboard's standalone JSON export. It restores records using
current versions, records revision history, and refuses concurrent changes or
schema downgrades. Import is an explicit replacement of the exported records.

The todo record at `tabliss/config` / `data/default-todo` uses `schemaVersion: 2`.
Its `items` array contains root tasks and arbitrarily nested subtasks linked by
`parentTaskId`; legacy `parentId` remains reserved for recurrence history.
Only root tasks have `listId`. The document also includes `customLists`,
`dependencies`, `occurrences`, and `activity` arrays. Unknown fields are retained.

Each changed record should send its server `baseVersion` and the exact JSON
`baseValue` originally received from the server. For example:

```json
{
  "clientId": "device-id",
  "changes": [{
    "key": "data/default-todo",
    "baseVersion": 12,
    "baseValue": {"schemaVersion": 2, "items": [], "customLists": []},
    "value": {"schemaVersion": 2, "items": [
      {"id": "task-id", "contents": "Plan launch", "completed": false, "status": "todo"}
    ], "customLists": []},
    "todoSchemaVersion": 2
  }]
}
```

The example `baseValue` must match the retained revision exactly, including
all metadata and arrays actually present in that revision. Local migration
does not change the base snapshot until the server acknowledges the write.

On a stale version, arrays of objects with IDs merge by ID and task edits merge
by field. Concurrent additions and disjoint edits are retained; competing edits
to the same field or deleting a concurrently edited task return HTTP `409`.
Concurrent `updatedAt` timestamps retain the later timestamp. Parent relationships
and dependencies are validated together after merging, in the same transaction.
An invalid combined graph rolls back the entire batch.
This also protects completing a parent while another device adds an unfinished
child, or trashing a branch while another device adds live work beneath it.

Normal acknowledgments retain `ok`, `versions`, and `requestId`. A successful
merge also returns `changes: [{key, value, version}]`. Clients must apply those
merged values and keep them as their new base snapshots. HTTP `409` details
include `currentVersion`, `currentValue`, and (when applicable) `conflicts` paths
such as `items[task-id].dueDate`. Refreshing a conflicted base must not discard
unsynced local work. Notes, daily plans, and legacy todos retain the existing
version-conflict behavior.
Even when `baseVersion` is current, a supplied `baseValue` must match it; an
incorrectly paired snapshot/version returns a conflict instead of overwriting
newer task fields.

Malformed recursive task graphs or metadata return HTTP `422`. Hierarchies,
dependencies, inherited blockers, and parent completion requirements must form
an acyclic graph. The validator uses iterative graph traversal without a task
depth limit. Occurrence snapshots may retain references to tasks that no longer
exist in the live hierarchy.

After migration, old todo schemas cannot overwrite, restore over, or recreate
the recursive record; they receive HTTP `428` with an update-client message.
Recursive writes require `baseVersion`. Deleting the record additionally requires
`todoSchemaVersion: 2`; structural task deletion should normally use task
`deletedAt` instead. This protection persists after deletion and history purging.
Restoring a compatible recursive revision creates a new revision as before.

Run server tests:

```bash
cd server
python -m unittest discover -v
```

## Automated Setup with Maintenance (Recommended)

See [setup.md](../setup.md#scheduled-maintenance--diagnostics) for complete Raspberry Pi setup with automatic maintenance and diagnostics. This includes:

- **Systemd services** that auto-restart the server and monitor health
- **Scheduled maintenance** with graceful restart at 4:00 AM and health check at 6:00 AM
- **Continuous diagnostics** logging memory, file descriptors, database locks, Tailscale status, disk space, and CPU temperature
- **Crash analysis tools** to diagnose issues when they occur
- **Resource limits** (512MB memory, 80% CPU) to prevent system hangs

## Utilities

Import an exported extension storage backup:

```bash
python import_backup.py backup.json
```

Verify the API locally:

```bash
curl http://127.0.0.1:8787/health
curl -H "Authorization: Bearer replace-with-your-token" \
  http://127.0.0.1:8787/v1/stores/tabliss/config
```

Expose privately over Tailscale:

```bash
sudo tailscale serve --https=443 http://127.0.0.1:8787
tailscale serve status
```

## Maintenance

See [MAINTENANCE.md](MAINTENANCE.md) for monitoring, diagnostics, and troubleshooting commands.

Analyze what was happening before crashes:

```bash
python3 /home/jkothari/todolist-sync/server/analyze-crashes.py
python3 /home/jkothari/todolist-sync/server/analyze-crashes.py --memory-spike
python3 /home/jkothari/todolist-sync/server/analyze-crashes.py --db-locks
```
