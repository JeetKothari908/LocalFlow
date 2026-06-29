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
  replacing newer data.
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
