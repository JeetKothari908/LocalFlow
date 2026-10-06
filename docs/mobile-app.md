# Shared mobile interface

The iOS app now hosts the extension's shared React/TypeScript productivity components in a bundled `WKWebView`. SwiftUI retains the Tasks, Notes, Plan, and Alerts tab structure. Alerts, notification scheduling, settings, sharing, storage, and network sync remain native. Node.js builds the interface; it is not required on the phone.

The source implementation is ready for Mac integration testing. It has not yet passed iOS compilation, simulator/device workflows, or visual/accessibility acceptance. Those checks cannot run in the Windows development environment used for this change.

The [proposal compliance audit](mobile-proposal-audit.md) now includes remediation of its recovery and UI findings. See [validation and beta gating](mobile-validation.md) for the added checks and remaining Mac/device acceptance.

## Build and preview

Use Node.js 22 and npm from the repository root. The root lockfile covers every workspace; there is no separate extension install.

```sh
npm ci
npm test
npm run build:extension
npm run build:mobile
npm run verify:mobile
```

`build:mobile` produces `mobile-web/dist/bundle` and copies the runtime assets to `app/MobileWeb`. Both are generated and ignored by Git. The manifest records the bridge protocol, source fingerprint, and asset hashes. Xcode checks this manifest before compiling and rejects missing, stale, or modified assets. Run the mobile build again after changing shared sources or dependencies. The build verification script needs Node on Xcode's PATH; common Homebrew locations are included.

For a browser preview:

```sh
npm run dev:mobile
```

Open `http://127.0.0.1:8093/?preview=1`. This explicitly enabled preview uses sample data and separate browser local storage. It does not connect to your sync server. Restart the command to rebuild after source changes. Native Alerts, sharing, settings, revision history, and WebKit lifecycle must be tested in the app.

On a Mac, open `app/app.xcodeproj`, select the shared `app` scheme, choose an iPhone simulator, and run. The project deployment target is iOS 26.2; use Xcode 26.2 or a compatible newer version. For command-line tests, replace the simulator ID below with an available compatible device from `xcrun simctl list devices available`:

```sh
xcodebuild -project app/app.xcodeproj -scheme app \
  -destination 'platform=iOS Simulator,id=SIMULATOR-UDID' \
  CODE_SIGNING_ALLOWED=NO test
```

The GitHub workflow builds the extension targets and mobile assets, then builds/tests the app on a Mac runner. Adding that workflow is not evidence of a successful remote run.

## Code ownership

| Location | Responsibility |
|---|---|
| `packages/core/src` | Task rules, planning, recurrence, safe undo, note tree helpers, and planning-day dates. |
| `packages/ui/src` | Shared Tasks, Notes, and Plan components, design tokens, clock context, and platform hooks. |
| `packages/platform/src` | Versioned bridge types and document client with optimistic edits and serialized commits. |
| `mobile-web/src` | Mobile composition, touch layouts, recovery UI, preview adapter, and routing. |
| `extension/src` | Existing extension host and browser storage/sync; previous component paths re-export shared implementations. |
| `app/app/MobileWebView.swift` | Retained WebKit runtime, bridge allowlist, native presentations, and acknowledged task routing. |
| `app/app/MobileDocuments.swift` | Atomic journal, protocol models, and conservative notes/plan merge. |
| `app/app/SyncStore.swift` | Authoritative native documents, validation, revisions, migration, and sync. |

The shared task workspace includes subtasks, outline, dependencies, timeline, activity, recurrence, trash, custom lists, and exports. Mobile styling uses a full-screen workspace, visible view selector, larger map cards, touch controls, recentering, keyboard-aware viewport sizing, and light/dark surfaces. Notes retains folders, breadcrumbs, editing, deletion, and restoration. Plan uses the shared 8 a.m. planning-day boundary; task deadlines retain calendar-day behavior. The synced extension timezone is used when available, otherwise the device timezone applies.

Tasks, Notes, and Plan remain mounted across tab switches. Native code keeps one web view alive when Alerts is selected. Editor drafts and task routes persist across web-process recovery. Task links and notification routes are queued until the web UI is ready and acknowledged by the recipient. At 760px and above, Tasks and Notes retain their list beside the selected detail; Tasks has a sticky quick-add bar. iPad ergonomics still need device review.

## Persistence and recovery

The existing `tabliss/config` records and server API remain unchanged. JavaScript computes an edit, then submits the document key, expected local revision, unique transaction ID, and proposed value. Swift validates and atomically persists it before acknowledging success. Server versions and local revisions are separate. Replayed transaction IDs are checked against the original payload; stale commits preserve a draft for explicit review.

The app journal is `Application Support/LocalFlow/documents.json`. It contains the documents, revisions, pending flags, sync baselines, conflict copies, receipts, and drafts together. Existing UserDefaults caches are migrated and retained for recovery. Unknown note/plan fields round-trip through Swift, alongside the existing task field preservation. An unreadable or newer journal blocks writes instead of silently resetting data.

Notes and Plan now track pending writes and merge nonconflicting changes. Conflicting text, concurrent note deletion/editing, and missing sync baselines preserve both copies. The interface distinguishes saving, saved locally, and synced states. Recovery provides draft/conflict review, server revision previews, confirmed restore, and native backup export. Restoring a server revision requires resolving pending local document edits first.

New installations start without a configured server or token. Existing saved settings continue to work. Credentials stay native; the mobile bundle has no direct network transport. The bridge accepts only bundled main-frame requests and validates its operations and payloads. External links open outside the privileged web view.

Debug builds and Release builds compiled with `LOCALFLOW_SHARED_UI` enable the new interface. Ordinary Release builds retain the original interface until acceptance. In eligible builds, in Sync Settings, turn off **Use shared LocalFlow interface** to return to the original SwiftUI screens. Both interfaces use the same native store; switching does not restore an older document snapshot. Keep this fallback through beta validation.

## Verification and release acceptance

Verified in the Windows workspace:

- 164 JavaScript tests pass: the original 137 extension tests plus 27 bridge, safe-undo, parity, recovery, and timezone cases. Shared semantic contrast and native palette verification also passes.
- The production Chromium extension and mobile bundles build, and mobile asset/source verification passes.
- The workspace lockfile resolves using the locally available dependency cache.

Added for Mac execution, but not run here: native persistence/validation/merge/parity tests, a disk-write failure/retry test, and UI workflows covering offline task creation/relaunch and navigation through Notes, Alerts, and Plan. No connected browser was available for interactive visual testing. A clean network-backed dependency install and CI run also remain to be confirmed.

Before enabling this interface for a release, validate:

| Area | Required check |
|---|---|
| Migration | Open a copy of an existing installation with nested tasks, dependencies, recurrence, folders, plans, unknown fields, and notification groups. Verify IDs and content after round-trip sync. |
| Offline and concurrency | Edit each document offline; terminate/reopen, reconnect, and edit simultaneously in the extension. Verify merge or recoverable conflict, draft review, disk-failure recovery, and server restore. |
| Navigation and lifecycle | Switch all tabs while editing; use task links and notification taps on cold/warm launches; terminate the WebKit process and verify drafts and route restoration. |
| Touch and keyboard | Exercise all workspace views, map panning, move/indent/outdent, folder/trash actions, exports, text selection, and keyboard dismissal on iPhone and iPad. |
| Accessibility | Check VoiceOver order/labels, large text, contrast, reduced motion, safe areas, landscape, and split view. |
| Time and reminders | Verify midnight and 8 a.m., timezone changes, daylight-saving transitions, recurrence, alert filters, and notification rescheduling. |
| Performance | Profile launch, typing, tab retention, scrolling, and large task maps on a physical phone; set measured budgets and address regressions. |
| Extension regression | Review the shared desktop workflows and run Chromium, Firefox, and web builds in CI. |

These acceptance checks are outstanding; passing TypeScript tests does not establish native runtime or UI parity by itself. The original architecture and acceptance rationale are in the [overhaul proposal](mobile-app-overhaul-proposal.md).
