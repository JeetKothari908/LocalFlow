#!/bin/bash
#
# LocalFlow Scheduled Maintenance Script
#
# Performs daily maintenance:
# - 4:00 AM: Graceful restart for resource cleanup
# - 6:00 AM: Verify server is running and healthy
#
# Install as a cron job:
#   crontab -e
#   0 4 * * * /home/pi/localflow-sync/server/maintenance.sh restart
#   0 6 * * * /home/pi/localflow-sync/server/maintenance.sh verify
#

set -e

LOG_FILE="/var/log/localflow/maintenance.log"
SERVER_URL="http://127.0.0.1:8787"
HEALTH_ENDPOINT="$SERVER_URL/health"

log_msg() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

graceful_restart() {
    log_msg "=== Starting graceful restart ==="
    
    log_msg "Stopping LocalFlow server..."
    sudo systemctl stop localflow-server
    
    log_msg "Waiting 5 seconds for clean shutdown..."
    sleep 5
    
    log_msg "Starting LocalFlow server..."
    sudo systemctl start localflow-server
    
    log_msg "Waiting 10 seconds for startup..."
    sleep 10
    
    # Check if server is running
    if systemctl is-active --quiet localflow-server; then
        log_msg "✓ Server restarted successfully"
    else
        log_msg "✗ ERROR: Server failed to start after restart!"
        exit 1
    fi
}

verify_health() {
    log_msg "=== Verifying server health ==="
    
    # Check if server is running
    if ! systemctl is-active --quiet localflow-server; then
        log_msg "✗ ERROR: Server is not running!"
        log_msg "Attempting to start..."
        sudo systemctl start localflow-server
        sleep 5
    fi
    
    # Check health endpoint
    if curl -sf "$HEALTH_ENDPOINT" > /dev/null 2>&1; then
        log_msg "✓ Health check passed"
    else
        log_msg "✗ ERROR: Health check failed!"
        log_msg "Server status:"
        systemctl status localflow-server || true
        exit 1
    fi
    
    # Show diagnostics
    log_msg "Current diagnostics:"
    if [ -f "/var/log/localflow/diagnostics.jsonl" ]; then
        tail -1 "/var/log/localflow/diagnostics.jsonl" | jq . | tee -a "$LOG_FILE" || true
    fi
}

show_diagnostics() {
    log_msg "=== Latest Diagnostics ==="
    if [ -f "/var/log/localflow/diagnostics.jsonl" ]; then
        tail -5 "/var/log/localflow/diagnostics.jsonl" | jq .
    else
        log_msg "No diagnostics available yet"
    fi
}

show_recent_alerts() {
    log_msg "=== Recent Alerts (last 24h) ==="
    if [ -f "/var/log/localflow/alerts.log" ]; then
        grep "$(date -d '24 hours ago' '+%Y-%m-%d')" "/var/log/localflow/alerts.log" | tail -20 || log_msg "No alerts in last 24 hours"
    else
        log_msg "No alerts logged yet"
    fi
}

case "${1:-verify}" in
    restart)
        graceful_restart
        ;;
    verify)
        verify_health
        ;;
    diagnostics)
        show_diagnostics
        ;;
    alerts)
        show_recent_alerts
        ;;
    full-check)
        verify_health
        show_diagnostics
        show_recent_alerts
        ;;
    *)
        echo "Usage: $0 {restart|verify|diagnostics|alerts|full-check}"
        exit 1
        ;;
esac

log_msg "=== Task complete ==="
