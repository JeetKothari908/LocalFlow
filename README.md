# LocalFlow

LocalFlow is a personal agentic workspace built around a customized LocalFlow new-tab extension, a private FastAPI sync server, and a SwiftUI iOS client. The current daily surface replaces the browser new tab with a dashboard for todos, notes, plan-of-day, clock/search/background widgets, and optional private sync.

This repo began as a fork of an upstream new-tab dashboard by Joel Shepherd and is licensed under [GPL-3.0](LICENSE.txt).

![LocalFlow](logo.png)

## Project Summary

The project has these main parts:

| Path | Purpose |
|---|---|
| `extension/` | React 18, TypeScript, Sass, and Webpack browser extension/PWA. This is the main LocalFlow new-tab dashboard and contains the widgets for todos, notes, plan of the day, backgrounds, search, time, quotes, and other LocalFlow-derived features. |
| `server/` | FastAPI and SQLite key-value sync API. It stores extension/iOS data under a shared store path, supports bearer-token auth, and is intended to run privately on a Raspberry Pi behind Tailscale Serve. |
| `app/` | SwiftUI iOS client for LocalFlow todos, notes, plan of day, and local notification groups. It reads/writes the same synced records as the extension. |
| `docs/` | Extension-focused docs, contributing notes, changelog, and translation instructions. |
| `setup.md` | Operational runbook for setting up, restarting, and verifying the Raspberry Pi sync stack. |

At a data level, the browser extension and iOS app share the same JSON records in the `tabliss/config` store:

- `data/default-todo` for recursive tasks, dependencies, schedules, custom lists, recurrence history, activity, and recoverable trash.
- `data/default-notes` for notes and note folders.
- `data/default-plan-of-day` for day-keyed plan text.

The sync server exposes:

- `GET /health`
- `GET /v1/stores/{store}`
- `POST /v1/stores/{store}/changes`

## Features

- Momentum-style new-tab todo dashboard.
- Tasks nested to any depth, with projects represented by top level tasks, custom lists, global Due Today, metadata, and recoverable trash.
- Task dependencies, outline editing, dependency graphs, timeline planning, schedule previews, activity history, and recurring task or branch occurrences.
- Notes widget with note/folder data that syncs across clients.
- Plan-of-day widget for date-specific planning.
- Customizable LocalFlow widgets and backgrounds.
- Optional private sync through a Raspberry Pi, SQLite, and Tailscale Serve.
- SwiftUI iOS client with tabs for Tasks, Notes, Plan, and Alerts.
- Local iOS notification groups for todo reminders.

## Setup

All setup instructions live in [setup.md](setup.md), including:

- Building and loading the browser extension.
- Running the local FastAPI sync server.
- Opening the SwiftUI iOS app.
- Setting up the Raspberry Pi sync server.
- Restarting, verifying, debugging, and connecting new devices.

## Important Files

| File | Purpose |
|---|---|
| `extension/src/plugins/widgets/todo-plus/TaskDashboard.tsx` | Daily task dashboard, project lists, search, recovery, and workspace navigation. |
| `extension/src/plugins/widgets/todo-plus/TaskWorkspace.tsx` | Recursive task workspace, metadata, outline editing, schedule shifts, and planning views. |
| `extension/src/plugins/widgets/todo/tasks.ts` | Task migration, hierarchy, dependencies, completion, trash, recurrence, and planning behavior. |
| `extension/src/plugins/widgets/notes/Notes.tsx` | Notes widget UI. |
| `extension/src/plugins/widgets/planOfDay/PlanOfDay.tsx` | Plan-of-day widget UI. |
| `extension/src/lib/db/storage.ts` | Local storage and remote sync plumbing. |
| `extension/src/db/state.ts` | Default extension database state and sync startup. |
| `server/app.py` | FastAPI sync API and SQLite persistence. |
| `server/import_backup.py` | Imports an exported extension storage backup into the server database. |
| `app/app/SyncStore.swift` | iOS sync, caching, and shared data model mapping. |
| `app/app/Models.swift` | Swift models for tasks, dependencies, occurrences, notes, plans, and remote changes. |
| `app/app/TaskGraph.swift` | Swift task migration and hierarchy, dependency, completion, recurrence, and planning rules. |
| `app/app/TodoNotificationStore.swift` | Local iOS notification scheduling for todo reminders. |

## Privacy

The extension does not use analytics, telemetry, advertising, cookies, or third-party tracking. By default, extension data is stored locally in browser storage.

This fork also supports optional private sync. When sync is configured, todos, notes, plan data, and settings are sent only to the configured sync server. The intended deployment is a private Raspberry Pi reachable through Tailscale, not a public hosted service.

Stored app data can include:

- Task text and metadata, hierarchy, dependencies, dates, recurrence history, lifecycle state, and custom lists.
- Notes and note folders.
- Plan-of-day text.
- Extension settings such as background, language, time zone, and widget configuration.

You can delete local extension data by resetting settings in the extension or uninstalling the extension. Server-side data lives in the SQLite database configured for the sync server.

## More Docs

- [Recursive tasks, migration, sync recovery, and validation](docs/tasks.md)
- [Raspberry Pi sync setup and recovery](setup.md)
- [Sync server notes](server/README.md)
- [Extension docs](docs/extension.md)
- [Translation guide](docs/TRANSLATING.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Changelog](docs/CHANGELOG.md)

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE.txt).

Originally forked from a new-tab dashboard by Joel Shepherd.
