<h1 align="center">Extension</h1>

<p align="center">A private, customisable new-tab workspace for Firefox and Chrome.</p>

![LocalFlow](../logo.png)

<p align="center">Based on <a href="https://github.com/JeetKothari908/LocalFlow">LocalFlow</a>.</p>

## Usage

Install all workspace dependencies with `npm ci` from the repository root. Then run these commands from `extension`:

- `npm run dev[:target]` Local development server
- `npm run build[:target]` Production build
- `npm run translations` Manage translation files

To develop with external services you will additionally need to signup for your own API keys
and enter them into your `.env` file. Get started by copying the example provided `cp .env.example .env`.

## Private Sync Setup

This fork can sync extension state through a private Raspberry Pi server exposed with Tailscale Serve.

### Raspberry Pi server

Copy the repo-level `server/` folder to the Pi, then run:

```bash
cd ~/localflow-sync/server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export LOCALFLOW_TOKEN='jfiweokgerhotrwhtr'
uvicorn app:app --host 127.0.0.1 --port 8787
```

In another Pi terminal, expose the local FastAPI server through Tailscale:

```bash
sudo tailscale serve --https=443 http://127.0.0.1:8787
tailscale serve status
```

Verify from a Tailscale-connected computer:

```powershell
curl.exe "https://raspberrypi.tail2db278.ts.net/health"
curl.exe -H "Authorization: Bearer jfiweokgerhotrwhtr" "https://raspberrypi.tail2db278.ts.net/v1/stores/tabliss/config"
```

### Import an existing extension backup

Export browser extension local storage to JSON, copy it to the Pi, then run:

```bash
cd ~/localflow-sync/server
source .venv/bin/activate
python import_backup.py ../backup.json
```

The importer reads keys under `tabliss/config/` and writes them into the configured SQLite database. By default this is `localflow.sqlite3`.

### Extension build

The sync URL and token are stored in `.env`:

```env
SYNC_SERVER_URL=https://raspberrypi.tail2db278.ts.net
SYNC_AUTH_TOKEN=jfiweokgerhotrwhtr
```

Build Chromium from the repository root:

```powershell
npm ci
npm run build:extension
```

Load `extension/dist/chromium` as an unpacked extension from `chrome://extensions`.

### Sync debugging

Open DevTools on the new-tab page and check the console for `[todo-sync]` logs. A healthy startup shows:

```text
[todo-sync] enabled: https://raspberrypi.tail2db278.ts.net
[todo-sync] starting remote sync: https://raspberrypi.tail2db278.ts.net
[todo-sync] request: GET /v1/stores/tabliss/config
```

If those logs do not appear, reload or remove and re-add the unpacked extension from the rebuilt `extension/dist/chromium` directory.

## Translations

Checkout the guide to [adding translations](TRANSLATING.md).
