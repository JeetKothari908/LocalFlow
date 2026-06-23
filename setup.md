# Setup

This guide contains all setup instructions for LocalFlow: building the browser extension, running the sync server, opening the iOS app, setting up the Raspberry Pi, restarting the stack later, verifying sync, and debugging common setup issues.

## Browser Extension

Use this when installing or rebuilding the Chrome/Chromium extension locally.

1. Install dependencies and build the Chromium bundle from the repo root:

```powershell
cd extension
npm install
npm run build:chromium
```

2. Load the extension:

Open `chrome://extensions`, enable Developer mode, click "Load unpacked", and select:

```text
extension/dist/chromium
```

3. Open a new tab.

The LocalFlow extension works as a standalone local app by default. To use the private sync server, open Settings, go to Sync, turn on "Use Tailscale sync", enter the server URL and auth token, and keep Tailscale connected when you want remote syncing.

For development, run Webpack in watch mode:

```powershell
cd extension
npm run dev:chromium
```

Useful extension commands:

```powershell
npm test
npm run build:chromium
npm run build:firefox
npm run build:web
npm run translations
```

## Local Sync Server

Use this when running the FastAPI and SQLite sync server directly on your current machine instead of the Raspberry Pi.

On macOS/Linux:

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export LOCALFLOW_TOKEN='replace-with-your-token'
uvicorn app:app --host 127.0.0.1 --port 8787
```

On Windows PowerShell:

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:LOCALFLOW_TOKEN = 'replace-with-your-token'
uvicorn app:app --host 127.0.0.1 --port 8787
```

Verify it locally:

```powershell
curl.exe "http://127.0.0.1:8787/health"
curl.exe -H "Authorization: Bearer replace-with-your-token" "http://127.0.0.1:8787/v1/stores/tabliss/config"
```

The health check should return `{"ok":true}`. The config endpoint should return JSON with a `changes` array.

## iOS App

Open the Xcode project:

```text
app/app.xcodeproj
```

The LocalFlow app uses SwiftUI and `SyncStore` to talk to the same sync API as the extension. Its main tabs are:

- Todos
- Notes
- Plan
- Alerts

Sync settings are editable in the app through the gear button. Build and run it from Xcode on a Mac.

## Raspberry Pi From Scratch

Use this when setting up a fresh Raspberry Pi to host the private SQLite sync database.

1. Flash Raspberry Pi OS Lite with Raspberry Pi Imager.

During imaging, enable SSH, set the hostname to `raspberrypi`, and create the user `jkothari`.

2. Boot the Pi, make sure it has internet, then SSH into it from Windows PowerShell:

```powershell
ssh jkothari@raspberrypi.local
```

If `.local` does not resolve, use the Pi's IP address from your router or the Raspberry Pi Imager screen.

3. Update the Pi and install basic tools:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y python3 python3-venv python3-pip curl git
```

4. Install Tailscale and sign into the same tailnet as your other computers:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

Follow the login URL that Tailscale prints.

5. Copy the sync server folder from Windows to the Pi.

Run this from Windows PowerShell in the repo folder:

```powershell
scp -r .\server jkothari@raspberrypi.local:~/todolist-sync/
```

6. On the Pi, create the Python environment and install the server dependencies:

```bash
cd ~/todolist-sync/server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

7. Start the sync API:

```bash
cd ~/todolist-sync/server
source .venv/bin/activate
export LOCALFLOW_TOKEN='jfiweokgerhotrwhtr'
uvicorn app:app --host 127.0.0.1 --port 8787
```

Leave this terminal running. The SQLite database will be created automatically at:

```text
~/todolist-sync/server/localflow.sqlite3
```

8. In a second SSH terminal, expose the local API privately through Tailscale Serve:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

9. Verify from Windows PowerShell:

```powershell
curl.exe "https://raspberrypi.tail2db278.ts.net/health"
curl.exe -H "Authorization: Bearer jfiweokgerhotrwhtr" "https://raspberrypi.tail2db278.ts.net/v1/stores/tabliss/config"
```

The health check should return `{"ok":true}`. The config endpoint should return JSON with a `changes` array.

## Optional: Run The API Automatically On Boot

The manual `uvicorn` command works, but it stops when that SSH terminal closes. Use a `systemd` service if the Pi should restart the sync API automatically.

1. Create an environment file:

```bash
sudo nano /etc/todolist-sync.env
```

Add:

```bash
LOCALFLOW_TOKEN=jfiweokgerhotrwhtr
LOCALFLOW_DB=/home/jkothari/todolist-sync/server/localflow.sqlite3
```

2. Create the service:

```bash
sudo nano /etc/systemd/system/todolist-sync.service
```

Add:

```ini
[Unit]
Description=LocalFlow Sync API
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=jkothari
WorkingDirectory=/home/jkothari/todolist-sync/server
EnvironmentFile=/etc/todolist-sync.env
ExecStart=/home/jkothari/todolist-sync/server/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8787
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

3. Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now todolist-sync
sudo systemctl status todolist-sync
```

4. Make sure Tailscale Serve is still pointing at the API:

```bash
sudo tailscale serve --https=443 http://127.0.0.1:8787
tailscale serve status
```

## Raspberry Pi After Moving Or Restarting

1. Plug in the Pi and make sure it has internet.
2. SSH into it from a Tailscale-connected computer:

```powershell
ssh jkothari@raspberrypi.local
```

If `.local` does not resolve, use the Pi's Tailscale name or IP from the Tailscale admin console.

3. Start the sync API:

```bash
cd ~/todolist-sync/server
source .venv/bin/activate
export LOCALFLOW_TOKEN='jfiweokgerhotrwhtr'
uvicorn app:app --host 127.0.0.1 --port 8787
```

Leave this terminal running.

4. In a second SSH terminal, make sure Tailscale Serve is pointing at the API:

```bash
sudo tailscale serve --https=443 http://127.0.0.1:8787
tailscale serve status
```

5. Verify from Windows PowerShell:

```powershell
curl.exe "https://raspberrypi.tail2db278.ts.net/health"
curl.exe -H "Authorization: Bearer jfiweokgerhotrwhtr" "https://raspberrypi.tail2db278.ts.net/v1/stores/tabliss/config"
```

The health check should return `{"ok":true}`. The config endpoint should return JSON with a `changes` array.

## Connect A New Computer

1. Install Tailscale on the computer and sign into the same tailnet.
2. Verify the Pi is reachable:

```powershell
curl.exe "https://raspberrypi.tail2db278.ts.net/health"
```

3. Clone or pull this private repo.
4. Install Node.js LTS if needed.
5. From the repo folder, install dependencies and build:

```powershell
cd "PATH\TO\extension"
npm install
npm run build:chromium
```

6. Load the extension:

Open `chrome://extensions`, enable Developer mode, click "Load unpacked", and select:

```text
PATH\TO\extension\dist\chromium
```

7. Open a new tab, open Settings, go to Sync, and turn on "Use Tailscale sync".

Use these values:

```text
Server URL: https://raspberrypi.tail2db278.ts.net
Auth token: jfiweokgerhotrwhtr
```

The extension can still be used with this setting off. When sync is on and the Pi is reachable, it should pull the latest state from the Pi.

## Verify Sync

1. Turn on "Use Tailscale sync" in the extension settings on both computers.
2. Add a test todo on one computer.
3. Wait a few seconds.
4. Open or reload a new tab on the other computer.
5. The test todo should appear.

You can also verify the server received data:

```powershell
curl.exe -H "Authorization: Bearer jfiweokgerhotrwhtr" "https://raspberrypi.tail2db278.ts.net/v1/stores/tabliss/config"
```

## Debugging

Open DevTools on the new-tab page and check the Console for `[todo-sync]` logs.

A healthy startup looks like:

```text
[todo-sync] enabled: https://raspberrypi.tail2db278.ts.net
[todo-sync] starting remote sync: https://raspberrypi.tail2db278.ts.net
[todo-sync] request: GET /v1/stores/tabliss/config
```

With sync turned off, a healthy standalone startup logs:

```text
[todo-sync] disabled in settings
```

If no `[todo-sync]` logs appear, Chrome is probably running an older unpacked extension. Remove it from `chrome://extensions`, rebuild with `npm run build:chromium` from `extension`, and load `extension/dist/chromium` again.

If Tailscale Serve stops working, rerun:

```bash
sudo tailscale serve --https=443 http://127.0.0.1:8787
tailscale serve status
```

## Scheduled Maintenance & Diagnostics

LocalFlow now includes automatic diagnostics and scheduled maintenance to prevent crashes and diagnose issues when they occur. This section covers setup on the Raspberry Pi.

### Overview

Three components work together:

- **localflow-server.service** - The main sync API with resource limits and automatic restart
- **localflow-monitor.service** - Continuous monitoring that logs memory, file descriptors, database locks, temperatures, and disk space
- **maintenance.sh** - Scheduled downtime script that gracefully restarts the server at 4:00 AM and verifies health at 6:00 AM
- **analyze-crashes.py** - Diagnostic tool to review what was happening before crashes

### Setup on Raspberry Pi

1. Install additional dependencies on the Pi:

```bash
sudo apt update
sudo apt install -y jq
cd ~/todolist-sync/server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Copy the service files to systemd:

From your Windows machine, copy the new files to the Pi:

```powershell
scp .\server\localflow-server.service jkothari@raspberrypi.local:~
scp .\server\localflow-monitor.service jkothari@raspberrypi.local:~
scp .\server\maintenance.sh jkothari@raspberrypi.local:~
scp .\server\monitor.py jkothari@raspberrypi.local:~/todolist-sync/server/
scp .\server\analyze-crashes.py jkothari@raspberrypi.local:~/todolist-sync/server/
```

3. On the Pi, install the service files:

```bash
sudo mv ~/localflow-server.service /etc/systemd/system/
sudo mv ~/localflow-monitor.service /etc/systemd/system/
sudo mv ~/maintenance.sh /home/jkothari/todolist-sync/server/
sudo chmod +x /home/jkothari/todolist-sync/server/maintenance.sh
sudo chmod +x /home/jkothari/todolist-sync/server/analyze-crashes.py
```

4. Create the log directory:

```bash
sudo mkdir -p /var/log/localflow
sudo chown jkothari:jkothari /var/log/localflow
```

5. Update the service files with your token and username:

```bash
sudo nano /etc/systemd/system/localflow-server.service
```

Change:
- `LOCALFLOW_TOKEN=replace-with-your-token` → your actual token
- `User=pi` → your username (probably `jkothari`)
- `/home/pi/todolist-sync/server` → `/home/jkothari/todolist-sync/server`

6. Do the same for localflow-monitor.service:

```bash
sudo nano /etc/systemd/system/localflow-monitor.service
```

Change:
- `User=pi` → your username (probably `jkothari`)
- `/home/pi/todolist-sync/server` → `/home/jkothari/todolist-sync/server`

7. Reload systemd and start the services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable localflow-server localflow-monitor
sudo systemctl start localflow-server localflow-monitor
```

8. Verify both services are running:

```bash
sudo systemctl status localflow-server
sudo systemctl status localflow-monitor
```

9. Set up cron jobs for scheduled maintenance:

```bash
crontab -e
```

Add these lines:

```cron
# Graceful restart at 4:00 AM every day (cleanup time)
0 4 * * * /home/jkothari/todolist-sync/server/maintenance.sh restart >> /var/log/localflow/cron.log 2>&1

# Verify server health at 6:00 AM
0 6 * * * /home/jkothari/todolist-sync/server/maintenance.sh verify >> /var/log/localflow/cron.log 2>&1

# Optional: Full diagnostics report at 8:00 PM for review
0 20 * * * /home/jkothari/todolist-sync/server/maintenance.sh full-check >> /var/log/localflow/cron.log 2>&1
```

### Monitoring & Diagnostics

The monitor runs continuously in the background, logging diagnostics every 60 seconds.

#### View Real-Time Logs

```bash
# Follow the main server logs
sudo journalctl -u localflow-server -f

# Follow monitor logs
sudo journalctl -u localflow-monitor -f

# Follow both
sudo journalctl -u localflow-server -u localflow-monitor -f
```

#### View Alerts

Recent alerts from the last 24 hours:

```bash
sudo /home/jkothari/localflow-sync/server/maintenance.sh alerts
```

#### Run Diagnostics Analysis

Find crashes and review what was happening:

```bash
python3 /home/jkothari/localflow-sync/server/analyze-crashes.py
```

Find specific issues:

```bash
# Memory spikes
python3 /home/jkothari/localflow-sync/server/analyze-crashes.py --memory-spike

# Database locks
python3 /home/jketothari/localflow-sync/server/analyze-crashes.py --db-locks

# Disk space issues
python3 /home/jkothari/localflow-sync/server/analyze-crashes.py --disk

# Temperature issues
python3 /home/jkothari/localflow-sync/server/analyze-crashes.py --temp
```

#### Manual Maintenance Commands

Run anytime, outside the 4 AM window:

```bash
# Graceful restart
sudo /home/jkothari/localflow-sync/server/maintenance.sh restart

# Check if server is healthy
sudo /home/jkothari/localflow-sync/server/maintenance.sh verify

# Full diagnostics report
sudo /home/jkothari/localflow-sync/server/maintenance.sh full-check
```

### What Gets Logged

The monitor logs every 60 seconds to `/var/log/localflow/diagnostics.jsonl`. Each entry includes:

- **Memory usage** - RSS memory in MB and percentage, with warnings when > 400MB
- **File descriptors** - Count of open file handles, with warnings when > 900
- **Database status** - Row count and lock detection
- **Tailscale connection** - Direct vs relay mode
- **Disk space** - Used percentage and free GB, warnings when > 80%
- **CPU temperature** - Celsius, warnings when > 70°C

Alerts are logged to `/var/log/localflow/alerts.log` with timestamps and severity levels (INFO, WARNING, ERROR).

### Resource Limits

The new service limits the uvicorn process to:

- **Memory:** 512MB max (restarts if exceeded)
- **CPU:** 80% quota
- **Automatic restart** on OOM (Out Of Memory) condition

### Next Steps

The scheduled restart at 4:00 AM will:
1. Stop the current server gracefully
2. Wait 5 seconds for clean shutdown
3. Start a fresh process (clearing memory and file descriptors)
4. Wait 10 seconds for startup

At 6:00 AM, it verifies the server came back up and logs diagnostics for you to review later.

If issues keep happening after setup, run the crash analysis to see what was happening before each crash.
