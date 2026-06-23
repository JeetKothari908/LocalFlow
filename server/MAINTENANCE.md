# LocalFlow Maintenance Quick Reference

## Daily Monitoring

Check server health anytime:

```bash
ssh jkothari@raspberrypi.local
sudo systemctl status localflow-server
```

Follow real-time logs:

```bash
sudo journalctl -u localflow-server -f
sudo journalctl -u localflow-monitor -f
```

## Automatic Schedules

The system automatically:

- **4:00 AM** - Graceful restart (cleanup & resource reset)
- **6:00 AM** - Health verification

Manual trigger anytime:

```bash
# Restart now
sudo /home/jkothari/todolist-sync/server/maintenance.sh restart

# Check health now  
sudo /home/jkothari/todolist-sync/server/maintenance.sh verify

# Full diagnostics now
sudo /home/jkothari/todolist-sync/server/maintenance.sh full-check
```

## Diagnosing Issues

If the server seems sluggish or crashes, check what was happening:

```bash
# Overall crash analysis
python3 /home/jkothari/todolist-sync/server/analyze-crashes.py

# Specific issue types:
python3 /home/jkothari/todolist-sync/server/analyze-crashes.py --memory-spike
python3 /home/jkothari/todolist-sync/server/analyze-crashes.py --db-locks
python3 /home/jkothari/todolist-sync/server/analyze-crashes.py --disk
python3 /home/jkothari/todolist-sync/server/analyze-crashes.py --temp
```

View recent alerts:

```bash
sudo /home/jkothari/todolist-sync/server/maintenance.sh alerts
```

## Log Files

| Path | Purpose |
|------|---------|
| `/var/log/localflow/diagnostics.jsonl` | Machine-readable health checks (every 60s) |
| `/var/log/localflow/alerts.log` | Human-readable warnings and errors |
| `/var/log/localflow/maintenance.log` | Restart/health check results |
| `/var/log/localflow/cron.log` | Scheduled task output |

View latest diagnostics:

```bash
tail -1 /var/log/localflow/diagnostics.jsonl | jq .
```

## If Server Won't Start

1. Check what went wrong:

```bash
sudo systemctl status localflow-server
sudo journalctl -u localflow-server -n 50
```

2. Check if port 8787 is in use:

```bash
sudo lsof -i :8787
```

3. Check if database is locked:

```bash
lsof /home/jkothari/localflow-sync/server/localflow.sqlite3
```

4. Force manual restart:

```bash
sudo systemctl stop localflow-server
sleep 5
sudo systemctl start localflow-server
```

## If Database Seems Corrupt

The database file is at:

```
/home/jkothari/todolist-sync/server/localflow.sqlite3
```

Check it manually:

```bash
sqlite3 /home/jkothari/todolist-sync/server/localflow.sqlite3
sqlite> SELECT COUNT(*) FROM kv;
sqlite> .quit
```

If needed, back it up before troubleshooting:

```bash
cp /home/jkothari/todolist-sync/server/localflow.sqlite3 /home/jkothari/localflow.sqlite3.backup
```

## Resource Limits

The server process has these limits:

- **Max Memory:** 512 MB (auto-restarts if exceeded)
- **Max CPU:** 80% quota
- **Restart policy:** Always restart, wait 5 seconds between attempts
- **Max restart attempts:** 10 times in 5 minutes

If hitting these limits repeatedly, the analysis tools will show the problem.

## Copying Logs to Windows for Review

From Windows PowerShell:

```powershell
scp jkothari@raspberrypi.local:/var/log/localflow/diagnostics.jsonl .\diagnostics.jsonl
scp jkothari@raspberrypi.local:/var/log/localflow/alerts.log .\alerts.log
```

Then analyze locally:

```powershell
python .\server\analyze-crashes.py
# (after copying the log files to /var/log/localflow/ locally, or edit the script paths)
```
