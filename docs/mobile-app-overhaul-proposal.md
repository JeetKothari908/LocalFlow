LocalFlow mobile app overhaul proposal — October 5, 2026

Rebuild the app's main productivity screens from the extension's React/TypeScript components, adapted for touch and smaller screens, inside the existing SwiftUI application. Preserve the app's Tasks, Notes, Plan, and Alerts organization and its native sync, storage, notification, and deep-link services.

The intended result is one shared implementation of the core productivity interface, with layouts appropriate to each platform. A feature added to the shared task workspace should become available to both clients without requiring a second SwiftUI implementation.

The interfaces described as “Node.js interfaces” are currently React, TypeScript, HTML, and Sass. Node.js builds and tests those assets. On iOS, the bundled JavaScript would execute in WebKit; the installed app would not require a running Node.js server.

Implementation status, October 6, 2026: the shared packages, mobile interface, native bridge, persistence, and build integration described below are now implemented in source. See [the implementation guide](mobile-app.md) for build instructions and verification results. Native compilation, device workflows, accessibility, and performance acceptance remain pending Mac/device validation. The milestones below retain the original planning estimates, not a claim of completed release acceptance.

The [implementation audit](mobile-proposal-audit.md) records the original gaps and their source remediation. The [validation guide](mobile-validation.md) lists the remaining native/device acceptance; release validation is not yet complete.

1. **Use the current iOS app as the host.**

   Add a `WKWebView` host to the existing Xcode project and ship the compiled mobile interface inside the app bundle. Apple supports embedding HTML, CSS, and JavaScript alongside native views, including loading local content. This makes the existing React interface a practical starting point. [Apple WKWebView documentation](https://developer.apple.com/documentation/webkit/wkwebview/).

   Keep the four-tab structure. Tasks, Notes, and Plan become shared React screens. Alerts remains native for the first release, with typography, colors, and spacing aligned to the new interface. Sync configuration, notification permissions, sharing, and app lifecycle remain native responsibilities.

   Use one retained web runtime for the three React screens. Native tab selection changes its route; switching to Alerts preserves web navigation and drafts. The prototype must verify mounting, memory use, and keyboard behavior before this hosting arrangement is finalized. Native code owns the tab bar and native presentations; React owns navigation within the productivity screens, preventing duplicate headers and back controls.

   My recommendation favors direct WebKit integration because this repository already contains a working SwiftUI host and native services. The tradeoff is that we must maintain a small, well-tested bridge.

   | Alternative | Fit for this project |
   |---|---|
   | SwiftUI host with bundled React and WKWebView | Recommended for the current iOS scope; preserves native investment and directly reuses web components. |
   | Capacitor | A credible alternative if Android becomes a near-term requirement or the bridge grows substantially. It supplies a web/native runtime and Swift plugin APIs; adopting it would require integrating the existing native services into its host. [Official overview](https://capacitorjs.com/docs). |
   | React Native | Suitable for a native-component redesign, but the existing DOM/Sass interface would require substantial porting. React Native renders platform components such as `View` and `Text`, so it does not directly reuse these web components. This assessment follows its [component model](https://reactnative.dev/docs/components-and-apis). |

2. **Extract shared features without copying the extension into another application.**

   The strongest reuse candidates already exist:

   | Existing source | Proposed treatment |
   |---|---|
   | `extension/src/plugins/widgets/todo/tasks.ts`, `planning.ts`, and task types | Extract pure task operations, selectors, recurrence, and planning into a shared core package. |
   | `todo-plus/TaskDashboard.tsx`, `TaskWorkspace.tsx`, `TaskRow.tsx`, `TaskMap.tsx`, and planning views | Extract reusable feature components; provide desktop and mobile layouts. |
   | Notes component, data types, and tree helpers | Share folder, editing, deletion, and restoration behavior; introduce a mobile navigation layout. |
   | Plan component and date helpers | Share plan editing and the existing 8 a.m. planning-day boundary. |
   | `app/app/SyncStore.swift` and `Models.swift` | Retain native persistence and network responsibilities behind a document adapter. |
   | Notification stores and delegate | Retain scheduling, permissions, groups, and notification-to-task routing. |
   | Existing SwiftUI task, note, and plan views | Keep as a temporary fallback during migration, then retire after acceptance. |

   Proposed source layout:

   ```text
   packages/core/          Shared models, task rules, note tree, planning dates
   packages/ui/            Feature components, design tokens, responsive layouts
   packages/platform/      Persistence/navigation contracts and bridge types
   mobile-web/             Mobile entry point, routes, native adapter, preview
   extension/              Existing extension host and browser storage adapter
   app/                    Existing Xcode project, WebKit host, native services
   server/                 Existing sync API and database
   ```

   Introduce npm workspaces incrementally. Keep the existing extension build working while extracting one feature at a time. Configure compilation, Sass, and tests to include the new package locations.

   Components currently accept `data` and `setData`, which gives us a useful seam. However, extraction must also remove their assumptions about extension side panels, DOM anchors, global styles, hash routing, downloads, and provider initialization. Add explicit layout and platform adapters rather than scattering platform checks throughout the components.

   Use a dedicated mobile build entry. The extension's existing `BUILD_TARGET` branches distinguish web from extension behavior; simply adding another target would currently inherit browser-extension behavior. The mobile bundle needs relative asset paths, bundled fonts/icons, the required React providers, and no dependency on extension APIs or a service worker for startup.

3. **Define one owner for app data and synchronization.**

   On iOS, the native document store remains authoritative. React holds a working snapshot and uses shared TypeScript functions to calculate user edits. A native adapter commits those edits, persists them, and schedules sync. The extension continues using its browser storage adapter and existing sync implementation.

   ```mermaid
   flowchart TD
       Shared[Shared React features and TypeScript rules]
       Shared --> Extension[Extension adapter]
       Shared --> Mobile[Mobile adapter and typed bridge]
       Extension --> Browser[Browser storage and sync]
       Mobile --> Native[Native document store and sync]
       Native --> Notifications[iOS notification services]
       Browser <--> Server[Existing FastAPI and SQLite server]
       Native <--> Server
   ```

   Build a versioned bridge with operations for loading snapshots, committing edits, requesting sync, observing document changes, opening native settings, sharing exports, and accessing recovery. WebKit provides a message-handler API that can return responses to JavaScript. [Apple message-handler documentation](https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply?changes=la).

   A commit must include the document key, expected local revision, transaction ID, and proposed document. The native store serializes local commits and incoming sync updates. It checks the revision, validates the document, persists it, and returns the accepted snapshot and revision. Duplicate transaction IDs return the prior result instead of applying an edit twice.

   Local revisions are distinct from server versions: unsynced edits also advance local revisions. A stale edit receives the latest snapshot and a recoverable error. Replaying an intent is permitted only when its preconditions still hold; conflicting text or destructive actions require review. An optimistic UI change remains “saving” until native persistence acknowledges it, and “saved locally” remains distinct from “synced.”

   Preserve the existing `tabliss/config` store and its task, notes, and plan keys. Preserve stable IDs, unknown fields, dependency references, recurrence snapshots, tombstones, and sync baselines. There is no planned server schema migration for the interface overhaul.

   The current task sync path has protections that Notes and Plan do not share. Extend durable pending-write tracking, retry, and conflict preservation to all three documents before release. A refresh must not replace an unsynced note or plan. Persist document state and pending-write metadata atomically; migrate the current caches with a retained backup if a new local persistence format is required.

   Shared TypeScript owns interactive task transitions in the new screens. Swift continues validating documents and handling sync/merge. Its task mutation methods remain available to the fallback UI during migration; the new UI must not execute the same transition again in Swift. Native reminder selectors and any retained Swift rules need common fixtures against the TypeScript behavior. A complete deletion of `TaskGraph.swift` is not a prerequisite for this overhaul.

   Undo must also pass through the document adapter. A remote update must not make an old undo snapshot silently overwrite newer work. Clear or safely rebase affected undo entries and make that behavior consistent across clients.

4. **Redesign the experience around the app's existing structure.**

   Reuse the extension's terminology, status indicators, task cards, and visual relationships. Introduce shared design tokens for typography, spacing, colors, surfaces, and light/dark appearance. Mobile layouts should have readable text, generous touch targets, visible actions, and keyboard-safe editing.

   | Surface | Proposed mobile experience |
   |---|---|
   | Tasks home | Due Today and overdue groups, ready/priority filters, project-list switcher, global search, and a persistent quick-add action. |
   | Task workspace | Dedicated screen with breadcrumbs and an accessible view selector for Subtasks, Outline, Dependencies, Timeline, and History. Task details open in a sheet. |
   | Subtask map | Reuse the map and layout logic with touch panning, explicit expand controls, and a recenter action. Start on the selected branch to limit visual overload. |
   | Outline | Compact hierarchy with expand/collapse and explicit move, indent, and outdent actions. Dragging is supplementary, so every operation works without a mouse or keyboard shortcut. |
   | Dependencies | Reuse the graph with selectable nodes and readable blocker details. Provide a list alternative for accessibility and dense graphs. |
   | Timeline | Restore today's marker, unscheduled tasks, warnings, schedule analysis, and branch-shift previews. Keep horizontal scrolling within the chart. |
   | History and recovery | Show branch activity and recurring occurrences together. Provide task trash, archived items, conflict review, and server revision restore through a clear recovery entry point. |
   | Notes | Folder navigation, breadcrumbs, note editor, folder creation/rename, deleted items, and restore. Save drafts continuously and preserve them across navigation. |
   | Plan | Date navigation and an autosaving editor using shared planning-day logic. Provide a direct return to the current planning day. |
   | Alerts | Preserve notification groups, filters, schedules, permission controls, and task links; align the native screen visually. |

   On iPad and wide layouts, allow a list/detail arrangement and larger planning views. On iPhone, use one primary screen at a time. Validate text scaling, VoiceOver, contrast, reduced motion, safe areas, selection/copy/paste, and keyboard dismissal on actual iOS WebKit.

   Apply the extension's 8 a.m. rule specifically to the planning day. Task deadlines retain their existing calendar-day semantics. Define the effective timezone explicitly and test travel, daylight-saving transitions, and midnight/8 a.m. boundaries.

   The first release covers the productivity capabilities and native Alerts. General new-tab widgets such as search, clock, quotes, and wallpaper customization are a separate optional scope; the four-tab mobile structure remains the basis of this proposal.

5. **Preserve native behavior through the new interface.**

   Notification taps and `localflow://task/<id>` links should select Tasks and open the referenced workspace. Queue the route until the web interface is ready, acknowledge delivery, and show a useful recovery state when the task is unavailable. Test cold launch as well as an already-running app.

   Reschedule notifications after accepted task changes and synchronized updates. Native lifecycle code continues refreshing on foreground entry; the design must tolerate suspension and WebKit process termination without assuming continuous background JavaScript execution.

   Bundle the UI for offline launch. Rehydrate it from native storage after a web-process restart, including recoverable drafts and the last route. External links open outside the privileged app web view. Restrict bridge calls to the bundled main frame, validate their payloads, keep credentials native, and expose only the operations the UI needs.

6. **Deliver through testable milestones.**

   These are planning estimates for one experienced developer working full time, with Mac/device access from the first milestone. They are not delivery commitments; refine them after the prototype.

   | Milestone | Deliverable and exit condition | Estimate |
   |---|---|---|
   | Prototype | Bundled React task screen in the current app; load existing cached tasks, commit one edit, reopen offline, and open a task from a native event. Prove keyboard and tab retention behavior on iPhone. | 3–5 working days |
   | Shared foundation | Extract core/components, establish adapters and design tokens, and keep extension builds/tests passing. | 5–8 days |
   | Mobile task workspace | Tasks dashboard, editing, map/outline, dependencies, timeline, history, recurrence, and recovery implemented against native persistence. | 8–12 days |
   | Notes, Plan, and native integration | Folder/trash parity, draft persistence, shared planning dates, Alerts styling, sharing, and notification/deep-link flows. | 5–8 days |
   | Hardening and rollout | Migration, offline/concurrent-edit tests, accessibility, performance, device review, and staged beta. | 5–8 days |

   The total is approximately **26–41 working days, or 6–9 calendar weeks** allowing modest integration time. Significant sync defects, a new Android target, or a broader widget dashboard would require revising the estimate.

   Keep the existing screens behind a build/debug feature flag until the replacement passes acceptance. Both interfaces use the same authoritative native data store. Rollback changes the interface, without restoring an old data snapshot over newer edits. Remove the fallback only after beta validation.

7. **Make parity and reliability the release criteria.**

   The extension's current 137 passing unit tests are a useful baseline, not evidence that the embedded mobile interface works. Preserve those tests and add focused coverage where the new architecture introduces behavior.

   - A shared fixture produces matching task completion, dependency, recurrence, date, and recovery results in both clients. Retained Swift selectors and validators agree with these fixtures.
   - Existing installations open their tasks, folders, plans, occurrences, and notification groups without losing IDs or metadata. Unknown fields survive a mobile edit and round trip.
   - Tasks, notes, and plans can be edited offline, survive termination/relaunch, and sync on reconnection. Failed writes remain visible and retryable.
   - Simultaneous extension/app edits either merge correctly or preserve both versions for review. Stale bridge commits cannot overwrite later state.
   - Notification taps reach the correct task on cold and warm launch. Alert groups still schedule from the accepted task state.
   - All listed productivity workflows work with touch and VoiceOver; drafts survive tab changes, keyboard dismissal, and web-process recovery.
   - Representative small, medium, and large task collections are profiled on a real iPhone. Set measurable startup, typing, scrolling, and graph-rendering budgets during the prototype; add virtualization or narrower graph rendering where measurements require it.
   - Extension builds and existing desktop workflows continue passing while the shared packages evolve. CI builds the mobile bundle and verifies that the matching assets are included in the iOS archive.

   Browser automation can test shared React workflows. Xcode UI tests and real-device sessions must cover the native bridge, WebKit behavior, notifications, accessibility, and lifecycle. The current iOS launch/performance tests need meaningful workflow assertions.

8. **Required tools and the first implementation step.**

   Source extraction, mobile layouts, and shared TypeScript tests can be developed in the current Windows workspace. Completing the prototype and validating the release requires macOS with Xcode, an iOS simulator, and preferably a physical iPhone. A connected browser is needed for interactive web previews; a Mac CI runner is useful for repeatable iOS builds. No additional paid UI framework or backend service is proposed.

   Start with the prototype against a copy of representative data. Its concrete deliverable is an installed build that displays the shared task interface, saves through the existing native store, survives an offline restart, and handles a task deep link. Use that result to confirm the architecture and refine the remaining estimate before expanding the migration.
