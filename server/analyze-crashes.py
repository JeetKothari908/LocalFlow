#!/usr/bin/env python3
"""
Analyze crash patterns from diagnostic logs.

Helps identify what was happening when the server crashed/restarted.

Usage:
    python analyze-crashes.py
    python analyze-crashes.py --since "2 days ago"
    python analyze-crashes.py --memory-spike  # Find memory spikes
    python analyze-crashes.py --db-locks      # Find database lock events
"""

import json
import argparse
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict

LOG_FILE = Path("/var/log/localflow/diagnostics.jsonl")
ALERT_FILE = Path("/var/log/localflow/alerts.log")


def load_diagnostics():
    """Load all diagnostic entries."""
    if not LOG_FILE.exists():
        print(f"No diagnostics found at {LOG_FILE}")
        return []

    entries = []
    with open(LOG_FILE) as f:
        for line in f:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    return entries


def load_alerts():
    """Load all alert entries."""
    if not ALERT_FILE.exists():
        return []

    with open(ALERT_FILE) as f:
        return f.readlines()


def parse_timestamp(ts_str):
    """Parse ISO timestamp."""
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except:
        return None


def find_crashes(entries):
    """Find restart/crash events by detecting process restarts."""
    crashes = []
    last_startup = None

    for entry in entries:
        ts = parse_timestamp(entry.get("timestamp"))
        if not ts:
            continue

        # Detect startup by looking for memory going down significantly
        if entry.get("type") == "health_check":
            memory_data = entry.get("memory", {})
            if memory_data.get("status") == "process_not_found":
                crashes.append({"timestamp": ts, "type": "process_restart"})

    return crashes


def find_memory_spikes(entries, threshold_spike=100):
    """Find sudden memory increases."""
    spikes = []
    prev_memory = None

    for entry in entries:
        ts = parse_timestamp(entry.get("timestamp"))
        if not ts:
            continue

        if entry.get("type") == "health_check":
            memory_data = entry.get("memory", {})
            current_memory = memory_data.get("memory_mb")

            if current_memory and prev_memory:
                spike = current_memory - prev_memory
                if spike > threshold_spike:
                    spikes.append({
                        "timestamp": ts,
                        "previous_mb": prev_memory,
                        "current_mb": current_memory,
                        "spike_mb": spike
                    })

            if current_memory:
                prev_memory = current_memory

    return spikes


def find_db_locks(entries):
    """Find database lock events."""
    locks = []

    for entry in entries:
        ts = parse_timestamp(entry.get("timestamp"))
        if not ts:
            continue

        if entry.get("type") == "health_check":
            db_data = entry.get("database", {})
            if db_data.get("status") == "locked":
                locks.append({
                    "timestamp": ts,
                    "error": db_data.get("error")
                })

    return locks


def find_disk_warnings(entries):
    """Find disk space warnings."""
    warnings = []

    for entry in entries:
        ts = parse_timestamp(entry.get("timestamp"))
        if not ts:
            continue

        if entry.get("type") == "health_check":
            disk_data = entry.get("disk", {})
            if disk_data.get("status") == "warning":
                warnings.append({
                    "timestamp": ts,
                    "used_percent": disk_data.get("used_percent"),
                    "free_gb": disk_data.get("free_gb")
                })

    return warnings


def find_high_temp(entries):
    """Find high temperature warnings."""
    temps = []

    for entry in entries:
        ts = parse_timestamp(entry.get("timestamp"))
        if not ts:
            continue

        if entry.get("type") == "health_check":
            temp_data = entry.get("cpu_temp", {})
            if temp_data.get("status") == "warning":
                temps.append({
                    "timestamp": ts,
                    "temp_c": temp_data.get("temp_c")
                })

    return temps


def print_crashes(crashes):
    """Print crash report."""
    if not crashes:
        print("✓ No crashes detected")
        return

    print(f"\n✗ Found {len(crashes)} crash/restart events:")
    for crash in crashes[-20:]:  # Last 20
        print(f"  {crash['timestamp']}: {crash['type']}")


def print_memory_spikes(spikes):
    """Print memory spike report."""
    if not spikes:
        print("✓ No significant memory spikes")
        return

    print(f"\n⚠ Found {len(spikes)} memory spikes (>100MB):")
    for spike in spikes[-20:]:  # Last 20
        print(f"  {spike['timestamp']}: {spike['previous_mb']:.1f}MB → {spike['current_mb']:.1f}MB (+{spike['spike_mb']:.1f}MB)")


def print_db_locks(locks):
    """Print database lock report."""
    if not locks:
        print("✓ No database locks detected")
        return

    print(f"\n✗ Found {len(locks)} database lock events:")
    for lock in locks[-20:]:  # Last 20
        print(f"  {lock['timestamp']}: {lock['error']}")


def print_disk_warnings(warnings):
    """Print disk space report."""
    if not warnings:
        print("✓ No disk space warnings")
        return

    print(f"\n⚠ Found {len(warnings)} disk space warnings:")
    for warn in warnings[-20:]:  # Last 20
        print(f"  {warn['timestamp']}: {warn['used_percent']:.1f}% used ({warn['free_gb']:.2f}GB free)")


def print_temp_warnings(temps):
    """Print temperature report."""
    if not temps:
        print("✓ No high temperature warnings")
        return

    print(f"\n⚠ Found {len(temps)} temperature warnings:")
    for temp in temps[-20:]:  # Last 20
        print(f"  {temp['timestamp']}: {temp['temp_c']:.1f}°C")


def main():
    parser = argparse.ArgumentParser(description="Analyze LocalFlow crash patterns")
    parser.add_argument("--memory-spike", action="store_true", help="Show memory spikes only")
    parser.add_argument("--db-locks", action="store_true", help="Show database locks only")
    parser.add_argument("--disk", action="store_true", help="Show disk warnings only")
    parser.add_argument("--temp", action="store_true", help="Show temperature warnings only")

    args = parser.parse_args()

    entries = load_diagnostics()

    if not entries:
        print("No diagnostic data available")
        return

    print(f"Analyzing {len(entries)} diagnostic entries from {LOG_FILE}")

    if args.memory_spike:
        print_memory_spikes(find_memory_spikes(entries))
    elif args.db_locks:
        print_db_locks(find_db_locks(entries))
    elif args.disk:
        print_disk_warnings(find_disk_warnings(entries))
    elif args.temp:
        print_temp_warnings(find_high_temp(entries))
    else:
        print("\n=== CRASH ANALYSIS ===")
        print_crashes(find_crashes(entries))
        print_memory_spikes(find_memory_spikes(entries))
        print_db_locks(find_db_locks(entries))
        print_disk_warnings(find_disk_warnings(entries))
        print_temp_warnings(find_high_temp(entries))


if __name__ == "__main__":
    main()
