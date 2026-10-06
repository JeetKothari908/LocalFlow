# Mobile overhaul proposal audit

Audit date: October 6, 2026. Scope: the current working tree against all eight sections of [the proposal](mobile-app-overhaul-proposal.md). This is a source and automated-check audit, not iOS release acceptance. Application source was not changed during this audit.

**Verdict: partially followed.** The main architecture and most productivity components match the proposal. Several specified UI and validation requirements remain incomplete, and the audit found recovery defects. The previous statement that the overhaul was implemented in source should not be read as confirmation that every requirement was satisfied.

## Remediation after the audit

The original findings below describe the pre-remediation code. The following changes have now been made; native/device acceptance is still open.

| Finding | Remediation | Verification status |
|---|---|---|
| 1. Blocked drafts | Ordered, coalesced durable writes; explicit unsaved-draft feedback; retry before resolution; snapshot epochs reject stale broadcasts. | JavaScript restart, delayed-write, failure, and stale-broadcast regression tests pass. |
| 2. Unchosen copy lost | Dedicated revision-checked native draft decision atomically stores the unchosen version, receipt, and document. | Native keep/discard/replay/stale/disk-failure tests added; require Mac execution. |
| 3. Native route lost | Central route state persists delivered task/tab before acknowledging and clearing the pending event. | Native route-state and UI restart tests added; require Mac execution. |
| 4. Layout and quick-add | Task and Notes list/detail layouts at wide widths; sticky quick-add survives collapsed/long task lists. | Mobile build passes; iPad UI workflow added; visual/device review pending. |
| 5. Theme/accessibility | Both web hosts consume semantic typography/color/spacing tokens; Alerts mapping completed; mobile targets enlarged; recovery dialogs use native modal focus behavior. | Semantic contrast and native palette checks pass; browser/VoiceOver/large-text review pending. |
| 6. Acceptance/gating | Shared recurrence/recovery fixtures, DST/travel tests, isolated migration/concurrent-sync tests, UI lifecycle tests, Debug/beta gate, iPad CI workflow, actual archive-asset check, and profiling datasets/targets added. | JavaScript tests pass. Native/CI execution and physical-device measurements remain pending. |

See [the validation and beta guide](mobile-validation.md) for the exact remaining evidence. Current JavaScript total: **164 passing tests**, plus the theme verification script. This is implementation remediation, not a native release sign-off.

## Original findings

### 1. High: edits to a blocked draft are not durable

Evidence: `packages/platform/src/documents.ts:39–48` and `:58–78`.

`set()` accepts additional edits while a document is blocked for review, but `flush()` immediately returns for blocked documents. There is no call to preserve the updated draft in that path. The initial conflict copy is durable; subsequent typing is only in the JavaScript pending map. A WebKit restart or application termination therefore loses that typing. The review banner still says the user's work is preserved.

This violates sections 3, 4 (continuous note/plan draft preservation), 5 (web-process recovery), and 7 (offline/relaunch acceptance).

Reproduced by running the compiled `DocumentClient` against an isolated in-memory bridge with a previously persisted plan draft, typing a new value, and constructing a new client from the persisted snapshot:

```text
visibleBeforeRestart:  new typing after conflict
recoveredAfterRestart: original preserved draft
bridgeCalls:           snapshot, snapshot
```

No commit or preserve-draft request was made for the new typing. This reproduction is separate from the 150 passing unit tests; those tests do not cover editing after the blocked state has already been entered.

Required correction: persist changes to blocked drafts with ordered acknowledgments, or prevent further editing until review. Add a conflict → further typing → restart regression test, including persistence failure feedback.

### 2. High: keeping a stale-commit draft does not preserve the document it replaces

Evidence: `packages/platform/src/documents.ts:82–89`, `app/app/SyncStore.swift:793–820`, compared with `:839–859`.

For a blocked draft, **Keep my copy** fetches the latest revision and submits the draft as an ordinary commit. `commitMobile()` replaces the current document and removes its preserved draft without saving the displaced document in `documentBackups`. In contrast, the native sync-conflict resolution method explicitly retains the unchosen copy. If the displaced native document contains unsynced changes, the stale-draft resolution path supplies no durable recovery copy of them. Server history is not a substitute for unsynced native data.

This is a source-confirmed gap in the proposal's preservation and recovery contract. The native scenario has not been executed because Xcode is unavailable.

Required correction: give stale-draft resolution an explicit native operation that atomically backs up the unchosen document and commits the decision. Test both keep/discard decisions across relaunch and disk failures.

### 3. Medium: a task opened through a native event is not saved as the last task route

Evidence: `app/app/MobileWebView.swift:62–74`, `:155–172`; `mobile-web/src/main.tsx:57–63`; `packages/ui/src/tasks/TaskDashboard.tsx:80–103`.

Opening a task natively writes `todo.pendingTaskId`. The web route handler changes the hash and acknowledges delivery, then native code removes the pending ID. That hash-navigation path does not invoke the `taskRoute` operation which writes `mobile.lastTask`. After acknowledgment, a WebKit restart can therefore reopen the previously selected task or the dashboard instead of the notification/deep-linked task. Native event routing also does not update `mobile.lastRoute` as ordinary tab selection does.

This falls short of section 5's last-route recovery requirement. It is established by the source paths; native runtime confirmation remains pending.

Required correction: persist the successfully delivered task/tab route before clearing the pending event. Test notification and URL entry from Tasks, Notes, and Plan, followed by WebKit restart and cold relaunch.

### 4. Medium: the proposed iPad list/detail layout and persistent quick-add are absent

Evidence: `mobile-web/src/mobile.scss:43,72`; `packages/ui/src/tasks/TaskDashboard.tsx:347–426,648–665`.

The workspace remains a fixed full-screen overlay at every width. The wide breakpoint adds two dashboard columns and limits the settings sheet width; it does not provide a simultaneous list and selected-detail arrangement. The quick-add forms occur after their lists and are removed when the corresponding panels collapse. They are not persistently accessible on a long or collapsed dashboard.

Required correction: implement a wide list/detail layout and an always-available quick-add entry, while retaining one primary screen on iPhone. Verify both with representative data and keyboard use.

### 5. Medium: design-system and accessibility work is partial

Evidence: `packages/ui/src/tokens.scss`, `packages/ui/src/tasks/Tasks.sass`, `mobile-web/src/mobile.scss`, `app/app/MobileShell.swift:19–20`, and `mobile-web/src/main.tsx:35,92`.

The token file provides mobile colors, font, and radius, but the extension does not consume it and spacing remains hard-coded. Shared feature Sass still contains its own typography and color values. Alerts receives the new accent tint; its typography and spacing have not been aligned through an explicit shared specification.

Mobile controls are enlarged in many places, but check buttons are explicitly 32 by 32 pixels and some map actions remain 32 pixels wide. The recovery/review overlays have dialog semantics but no explicit initial focus, focus containment, or focus restoration. These are source-level limitations; no claim is made that a particular VoiceOver session has failed.

Required correction: complete token adoption or document an agreed platform mapping, finish touch/focus behavior, and perform the requested contrast, text-scaling, VoiceOver, reduced-motion, safe-area, and keyboard checks.

### 6. Acceptance, rollout, and parity requirements are incomplete

Evidence: `packages/core/src/tasks/parity.test.ts`, `app/appTests/MobileDocumentTests.swift`, `app/appUITests/MobileWorkspaceUITests.swift`, `.github/workflows/push.yml:86–87`, and `app/app/ContentView.swift:5`.

- The shared cross-language fixture covers hierarchy, blockers, due ordering, completion, and unknown task fields. It does not cover the specified shared recurrence and recovery scenarios. Existing separate Swift/TypeScript tests are useful but do not establish shared-fixture parity.
- The new native tests cover useful persistence and merge primitives, but not full extension/app concurrent-sync sessions, migration of an existing installation, notification cold/warm launch, or WebKit process termination. The two new UI tests cover a task/offline flow and basic tab access, not the entire acceptance matrix.
- Basic 8 a.m. tests exist. Travel, daylight-saving transitions, and effective timezone changes are not covered by the new integration tests.
- Native compilation and all newly added Swift tests remain unexecuted locally. Browser interaction, physical-device checks, and performance measurements remain unexecuted. No startup/typing/graph budgets or beta evidence are present.
- The proposal called for proving the prototype on an installed build before expanding implementation. Development expanded without that milestone being demonstrated.
- The fallback is retained, but selection is a normal persisted Settings toggle with the new UI defaulting on. This differs from the specified build/debug flag during migration.
- CI includes a simulator test command and source-bundle verification, but no archive job that inspects assets inside the completed iOS archive. A configured workflow is not evidence of a successful CI run.

Required correction: complete the missing tests and milestone evidence, decide the release gating explicitly, and verify the packaged archive before declaring proposal acceptance.

## Requirement traceability

“Present” below means the source implements the stated mechanism. It does not certify native runtime behavior.

| Proposal requirement | Audit result | Evidence / remaining limitation |
|---|---|---|
| Existing SwiftUI app hosts bundled React | Present | `MobileWebView.swift`, Xcode MobileWeb resource reference and verification phase. |
| Tasks / Notes / Plan / Alerts structure | Present | `MobileShell.swift`; three shared screens in `main.tsx`, native Alerts. |
| One retained web runtime | Present, runtime unverified | State-owned coordinator and retained web view; Alerts hides rather than replaces it. |
| Native settings, sharing, notifications, lifecycle | Present, runtime unverified | Bridge handlers, native sheets, foreground refresh, existing notification store. |
| Shared core/UI/platform packages | Followed | Workspaces and extracted source; extension paths re-export shared implementations. |
| Preserve extension builds/tests | Verified automated checks | 137 original tests retained; Chromium, Firefox, and web builds pass. |
| Dedicated offline mobile bundle | Verified build; device unverified | Relative local assets, no mobile service worker, native network ownership. |
| Versioned bridge / native data authority | Present | Protocol 1, main-frame checks, document validation, revision and transaction checks. |
| Atomic document plus sync metadata persistence | Present, Swift tests unrun | `MobileCache.write`, `commitMobile`, legacy-cache migration. |
| Pending Notes/Plan writes and conservative merge | Present, end-to-end unverified | `pushDocument`, `applyDocument`, `MobileDocumentMerge`. |
| Preserve keys, IDs, unknown fields, tombstones | Present with partial tests | Unchanged server keys; models and core retain metadata. Existing-installation round trip still needed. |
| Recoverable stale edits and conflict decisions | Partial; defects | Findings 1 and 2. |
| Undo cannot overwrite remote work silently | Present with passing TS tests | `packages/core/src/tasks/undo.ts` and its tests. |
| Tasks filters, lists, global search, overdue groups | Present | Shared `TaskDashboard`; persistent quick-add missing. |
| Workspace views, breadcrumbs, details sheet | Present, interaction unverified | Mobile mode in `TaskWorkspace`; accessible view selector. |
| Map expand/recenter and touch scrolling | Present, touch unverified | Shared layout with mobile metrics; scroll viewport and Recenter control. |
| Explicit outline move / indent / outdent | Present | Task row structure controls and workspace actions. |
| Dependency graph plus accessible list alternative | Present | Graph and “Manage dependency links” list in `TaskPlanning`. |
| Timeline, unscheduled items, warnings, shifts | Present | Shared timeline, schedule analysis, and branch-shift preview. |
| Activity, occurrences, trash, archive, server recovery | Present with recovery gaps | Shared task views and mobile recovery; findings 1 and 2. |
| Notes folders, rename, editor, delete/restore | Present, interaction unverified | Shared Notes and tree helpers; blocked-draft durability fails. |
| Plan navigation, autosave, current day, 8 a.m. | Present with partial tests | Shared date helpers and provider; timezone/travel checks outstanding. |
| Native Alerts retained and visually aligned | Partial | Behavior retained; accent styling only. |
| Wide list/detail and persistent quick-add | Missing | Finding 4. |
| Shared tokens and accessibility acceptance | Partial / unverified | Finding 5. |
| Acknowledged task links and missing-task state | Present | Native pending route, web acknowledgment, unavailable-task message. |
| Last-route and draft recovery after WebKit restart | Partial; defects | Findings 1 and 3. |
| Native notification rescheduling after task updates | Present, runtime unverified | `MobileShell` observes native tasks and foreground entry. |
| Main-frame bridge restriction / external links / native credentials | Present by inspection | Allowlist and frame/path checks in `MobileWebView`; mobile CSP restricts network. |
| Milestone acceptance / shared parity / device performance / rollout | Incomplete | Finding 6. |

## Checks performed in this audit

| Check | Result |
|---|---|
| `npm test` | Passed: 150 tests in 21 suites (137 extension + 13 added tests). |
| `npm run build:mobile` | Passed. |
| `npm run verify:mobile` | Passed; source fingerprint and copied asset hashes match. |
| `npm run build:extension` | Passed (Chromium). |
| `npm run build:firefox --workspace extension` | Passed. |
| `npm run build:web --workspace extension` | Passed outside the sandbox; the initial restricted run failed with subprocess `spawn EPERM`. |
| Build warnings | Extension builds report three warnings; web also reports stale Browserslist data. |
| Targeted blocked-draft restart reproduction | Confirmed the defect in finding 1. |
| `git diff --check` | Passed; Git reports line-ending conversion warnings. |
| Browser availability | No connected browsers returned by the supported runtime. No visual/interactive certification. |
| Native tool availability | No Swift compiler or Xcode found in this Windows environment. No native test/build result claimed. |

Release acceptance should remain open until the recovery defects are corrected, the specified UI gaps are implemented or explicitly revised, and the missing native/device evidence is obtained.
