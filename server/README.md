# LocalFlow Sync Server

FastAPI and SQLite sync server for LocalFlow.

The server uses `LOCALFLOW_TOKEN` for auth and `LOCALFLOW_DB` to override the SQLite database path.

## Quick Start (Manual)

```bash
cd ~/todolist-sync/server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export LOCALFLOW_TOKEN='replace-with-your-token'
uvicorn app:app --host 127.0.0.1 --port 8787
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
