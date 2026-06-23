#!/usr/bin/env python3
"""
Diagnostic monitor for LocalFlow server.

Logs:
- Memory usage and trends
- File descriptor count
- SQLite database lock status
- Tailscale connection health
- Crash/restart events

Run as a systemd service alongside the main server.
"""

import os
import json
import time
import sqlite3
import subprocess
import psutil
from pathlib import Path
from datetime import datetime

# Configuration
DB_PATH = os.getenv("LOCALFLOW_DB", "localflow.sqlite3")
LOG_DIR = Path("/var/log/localflow")
DIAGNOSTICS_LOG = LOG_DIR / "diagnostics.jsonl"
ALERT_LOG = LOG_DIR / "alerts.log"
CHECK_INTERVAL = 60  # seconds
MEMORY_THRESHOLD = 400  # MB
FD_THRESHOLD = 900

LOG_DIR.mkdir(exist_ok=True, parents=True)


def log_diagnostic(event_type: str, data: dict) -> None:
    """Log event as JSONL for easy parsing."""
    entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "type": event_type,
        **data
    }
    with open(DIAGNOSTICS_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def log_alert(severity: str, message: str) -> None:
    """Log alerts to dedicated file."""
    with open(ALERT_LOG, "a") as f:
        f.write(f"[{datetime.utcnow().isoformat()}] {severity}: {message}\n")


def check_memory() -> dict:
    """Check memory usage of uvicorn process."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "uvicorn app:app"],
            capture_output=True,
            text=True
        )
        if not result.stdout:
            return {"status": "process_not_found"}

        pid = int(result.stdout.strip().split()[0])
        process = psutil.Process(pid)
        mem_info = process.memory_info()
        memory_mb = mem_info.rss / 1024 / 1024

        return {
            "pid": pid,
            "memory_mb": round(memory_mb, 2),
            "memory_percent": round(process.memory_percent(), 2),
            "status": "warning" if memory_mb > MEMORY_THRESHOLD else "ok"
        }
    except Exception as e:
        return {"error": str(e)}


def check_file_descriptors() -> dict:
    """Check open file descriptors."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "uvicorn app:app"],
            capture_output=True,
            text=True
        )
        if not result.stdout:
            return {"status": "process_not_found"}

        pid = int(result.stdout.strip().split()[0])
        fd_path = Path(f"/proc/{pid}/fd")
        if not fd_path.exists():
            return {"error": "proc fs not available"}

        fd_count = len(list(fd_path.iterdir()))
        return {
            "pid": pid,
            "fd_count": fd_count,
            "fd_percent": round((fd_count / FD_THRESHOLD) * 100, 2),
            "status": "warning" if fd_count > FD_THRESHOLD else "ok"
        }
    except Exception as e:
        return {"error": str(e)}


def check_database_lock() -> dict:
    """Check for SQLite database locks."""
    try:
        if not os.path.exists(DB_PATH):
            return {"status": "db_not_found"}

        # Try to open and query the database
        conn = sqlite3.connect(DB_PATH, timeout=2)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM kv")
        row_count = cursor.fetchone()[0]
        conn.close()

        return {
            "status": "ok",
            "row_count": row_count,
            "accessible": True
        }
    except sqlite3.OperationalError as e:
        if "locked" in str(e):
            log_alert("ERROR", f"Database lock detected: {e}")
            return {"status": "locked", "error": str(e)}
        return {"status": "error", "error": str(e)}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def check_tailscale() -> dict:
    """Check Tailscale connection status."""
    try:
        result = subprocess.run(
            ["tailscale", "status"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode != 0:
            return {"status": "error", "error": "tailscale command failed"}

        # Check if connected
        if "DERP" in result.stdout or "relay" in result.stdout.lower():
            return {"status": "connected_via_relay", "warning": "Using relay, not direct"}
        else:
            return {"status": "connected_direct"}
    except FileNotFoundError:
        return {"status": "tailscale_not_installed"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def check_disk_space() -> dict:
    """Check disk space on the partition."""
    try:
        stat = os.statvfs("/")
        total_bytes = stat.f_blocks * stat.f_frsize
        free_bytes = stat.f_bavail * stat.f_frsize
        used_percent = 100 * (1 - free_bytes / total_bytes)

        return {
            "used_percent": round(used_percent, 2),
            "free_gb": round(free_bytes / 1024 / 1024 / 1024, 2),
            "status": "warning" if used_percent > 80 else "ok"
        }
    except Exception as e:
        return {"error": str(e)}


def check_cpu_temp() -> dict:
    """Check Raspberry Pi CPU temperature."""
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            temp_millidegrees = int(f.read().strip())
            temp_c = temp_millidegrees / 1000
            return {
                "temp_c": round(temp_c, 2),
                "status": "warning" if temp_c > 70 else "ok"
            }
    except FileNotFoundError:
        return {"status": "not_available"}
    except Exception as e:
        return {"error": str(e)}


def run_diagnostics() -> None:
    """Run all diagnostic checks and log results."""
    diagnostics = {
        "memory": check_memory(),
        "file_descriptors": check_file_descriptors(),
        "database": check_database_lock(),
        "tailscale": check_tailscale(),
        "disk": check_disk_space(),
        "cpu_temp": check_cpu_temp()
    }

    log_diagnostic("health_check", diagnostics)

    # Alert on warnings
    for check_name, result in diagnostics.items():
        if isinstance(result, dict):
            if result.get("status") == "warning":
                log_alert("WARNING", f"{check_name}: {result}")
            elif result.get("status") == "error":
                log_alert("ERROR", f"{check_name}: {result}")
            elif result.get("error"):
                log_alert("ERROR", f"{check_name}: {result.get('error')}")

    print(f"[{datetime.utcnow().isoformat()}] Diagnostics complete")


def main() -> None:
    """Main loop."""
    print(f"LocalFlow Monitor started. Logging to {DIAGNOSTICS_LOG}")
    log_alert("INFO", "Monitor started")

    try:
        while True:
            run_diagnostics()
            time.sleep(CHECK_INTERVAL)
    except KeyboardInterrupt:
        log_alert("INFO", "Monitor stopped")
        print("Monitor stopped")


if __name__ == "__main__":
    main()
