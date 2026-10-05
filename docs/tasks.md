# Recursive tasks

LocalFlow stores projects and subtasks as the same task type. A root task is
presented as a project; each task can contain subtasks without a fixed depth
limit. Inbox and custom lists organize roots. Due Today is a global view of
unfinished tasks from all roots, lists, and depths.

## Daily use and navigation

- Inbox contains roots with no `listId`; a custom list contains roots assigned
  to that list. A due task remains in its project while appearing in Due Today.
- Due Today separates overdue tasks from today's deadlines and shows the
  project/path for context. Blocked work remains visible. Ready to work filters
  to tasks whose prerequisites are resolved and whose planned start has arrived.
- In the browser, clicking a task opens a non-modal dock beside the task list.
  The dock is at most 600 pixels wide and one third of the viewport height
  (capped at 300 pixels), anchored beside the task rather than filling the page.
  A connected map expands its subtasks to the right in compact panels containing
  the same task-row component used in lists: expand control, checkbox, title,
  metadata, and open arrow. Graph rows are 28 pixels tall; long titles and
  metadata have tooltips, and selecting a row opens its full settings.
  Nodes align in bracket columns, with parents
  centered between their child branches and right-angle connecting lines.
  Clicking a card selects its settings and reveals its children while retaining
  the branch context. Expand/collapse controls and map scrolling handle deeper
  chains. The dashboard remains interactive while the map is open.
- A narrow settings rail sits farther left than the map. Existing fields are
  grouped in expandable menus for name/notes, dates/effort, state/priority,
  recurrence, and parent/list assignment. The View dropdown retains Outline,
  Dependencies, Timeline, and History. On narrow screens the dock uses the
  opposite half of the page from the task list, and Settings toggles the rail.
- iOS uses task workspaces and immediate-child Focus navigation. Both clients
  retain Outline editing, breadcrumbs, full-path search, branch moves, and
  completion rules. Outline supports dragging and row actions; the browser also
  provides Alt + arrow keys to reorder, indent, and outdent.
- Root rows summarize completed leaf steps, tasks due today, overdue work,
  blocked commitments, and the next subtask deadline. Today's count uses the
  current calendar date; overdue commitments have a separate count.
- Outlines draw hierarchy connectors. Search's **Open in outline** action on
  both clients expands the result's ancestors and highlights the selected task.
  Other branches stay collapsed until expanded deliberately.
  iOS outline titles can be dragged onto another task to nest the branch;
  row menus also provide move, reorder, indent, and outdent actions.
- Dependencies describe prerequisites independently of the hierarchy. A blocker
  on a parent gates the entire branch. The dependency view exposes prerequisites
  and work unblocked by the selected task, including links across projects. The
  layered graph highlights the entire unresolved prerequisite chain, including
  inherited constraints and prerequisite branches, plus direct dependents when
  a task node is selected. Fulfilled prerequisites are dimmed; unavailable ones
  remain visible for resolution. Selected nodes open their workspace. Link
  management remains available beneath the graph.
- Timeline uses deadline/start markers and start-to-deadline bars, lists scheduling
  dependencies, and reports schedule problems.
  Branch date shifts require an explicit preview/confirmation. Editing one task's
  deadline does not implicitly change its children's dates.
- Finished work and recurring occurrence snapshots remain reviewable. Trash is
  recoverable. Task export includes the current document and its legacy backup.

The dashboard keeps a compact daily queue and root-list browser. The browser
map dock provides branch exploration alongside the page; planning views remain
available through its View menu. iOS exposes the same task hierarchy and
uses stable task IDs to open the right task from a reminder after renaming or
moving it.

## Task and graph semantics

The shared todo document remains under `tabliss/config` / `data/default-todo`.
`schemaVersion: 2` contains:

| Collection | Role |
| --- | --- |
| `items` | All live, completed, archived, and trashed tasks, linked by `parentTaskId`. |
| `customLists` | Named root-task collections. |
| `dependencies` | Prerequisite/dependent task ID pairs. |
| `occurrences` | Immutable recurring completion snapshots. |
| `activity` | Task creation, edits, moves, schedule shifts, dependency changes, and completion events. |
| `legacyBackup` | Preserved original document captured by migration. |

`parentTaskId` is the structural parent. Legacy `parentId` belonged to recurring
completion records and must never be interpreted as tree structure. Project
names and paths are derived from ancestry rather than copied into every child.
Only roots have `listId`; children inherit their root's list. Moving a task moves
its subtree without changing IDs or dependency links. Deleting a list returns
its roots to Inbox.

Each task supports a title (`contents`), description, due date/time, planned
start, estimated minutes, priority, ordering, and lifecycle timestamps. States
are `todo`, `inProgress`, `done`, and `canceled`; `completed` agrees with `done`.
Blocked status is derived from prerequisites. Dates use calendar `YYYY-MM-DD`
values and times use `HH:MM`; activity timestamps use ISO 8601 with a timezone.

Completion is explicit at every level. Completed children make a parent ready
to complete without closing it automatically. Closing unfinished work requires
an explicit branch-completion action with a preview listing the unfinished
descendants and their paths/deadlines; unresolved external blockers still prevent
completion. Adding, moving, or reopening unfinished work under a completed task
reopens the affected ancestors. Unarchiving unfinished work does the same,
including a visible explanation and undo. Bulk completion preserves earlier
child completion timestamps, including in recurrence snapshots.
Inherited blocker labels identify the ancestor supplying the constraint.
Archived, dismissed, canceled, or trashed
ancestors hide their entire branch from the daily queue. Canceled, trashed, or
unfinished prerequisites require resolution and do not silently unblock work.
Archiving a completed prerequisite preserves its fulfilled dependency; trashing
or canceling it requires resolution.

Progress counts leaf steps instead of counting both a parent and its children.
Effort-based dependency planning gives summary tasks zero additional weight to
avoid counting the same work twice. Missing effort estimates are surfaced;
estimated prerequisite-chain duration does not promise a calendar finish date.
Only active remaining work and its required prerequisites participate in this
calculation; prerequisites of canceled, completed, or hidden work do not inflate
the selected branch's estimate.

Schedule analysis adds a calendar scenario when enough inputs exist. It requires
remaining leaf effort estimates and planned starts for source work; a start on
an ancestor anchors the branch without changing descendants' metadata. Tasks
may also start when their prerequisites finish. External unfinished prerequisite
branches participate. Missing inputs and unavailable prerequisites are linked
for review instead of being replaced with guesses.

The scenario calculates earliest starts/finishes using uninterrupted effort.
With a deadline on the selected outcome, it also shows a scheduled critical path,
float for each step, the outcome's deadline margin, and individual deadline
overruns. Float measures delay without changing the earliest outcome finish;
deadline margin is separate. Summary parents add no effort on top of their
children, and zero-effort milestones remain traceable. This is a planning
scenario, without working-hour calendars, resource allocation, or automatic
changes to saved dates.

The server validates structure and dependencies atomically. Its graph uses two
nodes per task: start and completion. A parent's start gates its children's
starts, child completion precedes parent completion, and prerequisite completion
gates dependent start. This catches circular dependencies and branches waiting
on their own work using iterative traversal in linear space. A completed ancestor
cannot retain active unfinished descendants. Concurrent edits creating either
condition return a conflict rather than persisting an inconsistent graph.

Trash uses `deletedAt` and `deletedByTaskId` so branch restoration can distinguish
descendants removed by this action from work already trashed separately. Archive
uses `archivedAt` and remains distinct from deletion. Dependencies and list
entities may carry tombstone/update timestamps for forward compatibility; array
removal is also understood by the sync merge.

## Recurrence and scheduling

Daily, weekly, selected-weekday (`custom`), and monthly rules are supported.
Each active repeating task has an explicit next deadline. Completing it records
an occurrence snapshot before reopening the next occurrence. Repeating a task
with children uses branch recurrence: capture the subtree, reset its active
steps, and shift dated descendants by the difference between occurrences.
Previous snapshots remain unchanged. Monthly days clamp to the month's final
day while preserving the intended day for subsequent months.

Individual recurrence remains useful for leaves. Parent recurrence must use a
branch or be completed permanently so finished children are not silently carried
into new work. Historical snapshots can refer to former ancestors or external
prerequisites that no longer exist in the current hierarchy.

Schedule warnings identify children due after ancestors, prerequisites due
after dependent commitments or planned starts, missing dates, and starts after
deadlines. Deadline comparisons include optional times on the same day. Dates
remain user-controlled. A branch schedule shift creates one coherent edit and
an activity entry; the preview shows every affected due/start date and conflicts
with dependent tasks in other projects. Each workspace also reports undated
unfinished descendants and its next subtask deadline. History is a workspace
view of these activity entries and frozen recurring occurrences.

## Migration and recovery

Migration is performed by clients and is idempotent. Existing ordinary todos
become root tasks in their existing lists, preserving IDs, titles, deadlines,
repeat rules, and completion/archive state. No compulsory container task is
created. Completed legacy recurrence instances become occurrence history,
retaining their linkage to the originating task. The original document is kept
in `legacyBackup`; export it before reorganizing imported work.

The browser migration also repairs dangling parents/corrupt parent cycles and
orphan list assignments in imported documents without losing the original
backup. Canonical schema2 writes must satisfy the server's validation rules.
Migration is a new server revision, so an existing database backup and revision
history provide additional recovery paths.

`python import_backup.py path/to/export.json`, run from `server`, accepts a full
extension storage export or the task dashboard's schema2 JSON export. Import
deliberately restores those records as new revisions using the current server
versions; a concurrent edit stops the import instead of being overwritten.
It retains the same validation and schema downgrade protection as normal sync.
Export/import restores a document; it does not append its tasks to existing work.

Before rolling out to a server and devices:

1. Copy the SQLite database and export existing extension data.
2. Deploy the updated server first. Existing schema1 clients remain compatible
   until migration; the server knows how to protect schema2 as soon as it arrives.
3. Install updated browser and iOS clients together, then synchronize one device
   to migrate. Verify its exported backup and imported recurring history.
4. Synchronize the remaining updated devices and verify roots, nested due tasks,
   dependencies, occurrence history, and notification navigation.
5. Keep the database backup until both clients have been exercised. Recover using
   a compatible schema2 revision or the original backup through a deliberate
   migration/recovery workflow.

After migration, older clients cannot write a schema1 value over schema2, delete
it, or restore schema1 over it. They receive HTTP `428` explaining that a client
update is required. The protection survives record deletion and history purging.
Deleting the entire todo record requires `todoSchemaVersion: 2` and the current
`baseVersion`; everyday task removal should use recoverable task trash.
Restoring a recursive server revision creates a new revision and requires a
current base version. Replacing the database with the pre-migration backup is
the explicit rollback route when older client compatibility is necessary.

## Sync recovery on the dashboard

Unresolved sync recoveries appear in the main dashboard beside the settings
controls, rather than inside the todo widget. The panel skips occupied widgets
to the right and wraps below the occupied row when a narrow viewport cannot fit
it beside them. It can be collapsed while keeping the page interactive.

Each recovery identifies its stored record (tasks, notes, plan, or settings) and
compares the actual device/server values. Task and other entity arrays match by
stable ID. The comparison shows added/removed records, changed fields, collection
ordering, and the saved sync baseline field values when available. Missing values, null,
empty documents, and unexpected formats have distinct summaries. Complete raw
copies remain inspectable and exportable; long values are not truncated. An
unresolved recovery whose saved copies are now equal says so explicitly.

The existing whole-record selection and export actions retain their sync behavior.

## Concurrent edits

Clients retain the exact raw JSON received from the server as `baseValue`, along
with its `baseVersion`. Decoded/migrated defaults must not replace this raw base.
The writable local document is separate, so refresh cannot silently discard
unsynced task edits.

Stale schema2 writes can merge disjoint edits by entity ID and by field.
Concurrent additions survive; different fields on the same task combine.
Competing same-field edits, deletion versus editing, and invalid combined graphs
return HTTP `409` with the current version/value and useful conflict paths.
This includes a new live task appearing beneath a concurrently trashed ancestor.
Concurrent `updatedAt` stamps retain the later timestamp. Historical base values
must match a retained revision; an unavailable/mismatched base requires refresh
and explicit conflict review. Supplying an older snapshot with a newer current
version also returns a conflict, so acknowledgment timing cannot overwrite work.

Successful merged writes add `changes: [{key, value, version}]` to the existing
acknowledgment response. Clients apply that merged document and preserve it as
their new base. If another local edit arrived while the request was in flight,
that work must be retained/reconciled rather than overwritten by the response.
Notes and daily plans continue using their existing version-conflict behavior.
See [server API details](../server/README.md#recursive-tasks-and-concurrent-editing).

## Verification

From `extension`:

```bash
npm test -- --runInBand
npx tsc --noEmit
npm run build:web
```

From `server`, with the server dependencies installed:

```bash
python -m unittest discover -v
```

On macOS, build the iOS app with Xcode and run its task model tests. Windows can
exercise the browser and server; SwiftUI/UIKit execution requires Apple's SDKs.

The browser smoke test uses a dedicated headless Chrome profile and a local dev
server. Start Chrome with a new test-only `--user-data-dir` and
`--remote-debugging-port=8093`, then run from `extension`:

```bash
node scripts/test-tasks-ui.cjs http://127.0.0.1:8092
```

Never connect this runner to a personal browser profile. It creates test tasks
through the interface and writes desktop/narrow screenshots beneath ignored
`extension/dist/browser-qa-artifacts`. Override `TASK_UI_CDP` for another dedicated
debugging endpoint. The smoke test covers nested creation, cross-list Due Today,
task editing, dependencies, outline navigation, schedule previews/history,
individual/branch/monthly recurrence, trash/restore, archive/cancel blockers,
keyboard hierarchy editing, task links, dependency-graph interaction, and JSON
export. Validate exported documents with the server's `todo_schema.validate_todo`
to check that the browser and server agree on the canonical document format.
The runner also checks project summaries, search-target outline navigation,
connector lines, the non-modal inward map and settings rail, dashboard
interactions while the map is open, inherited blocker sources, descendant completion previews,
completion through the details editor, ancestor reopening, and undo.
It also exercises full prerequisite tracing, ancestor-path search, calendar
critical-path calculations, parallel float, missing child deadlines, cross-project
schedule warnings, and menu-based indent/outdent actions.

The dashboard groups left and right sections into full-height panels with
independent scrolling. Existing top/middle/bottom positions preserve their order
inside each panel. Center widgets use the remaining space, and the settings icon
sits just to the right of the left panel (or at the left edge when that panel is
empty). Tasks in the left panel unfold rightward; tasks in the right panel unfold
leftward. The compact bracket map mirrors its settings rail and stays non-modal.
On narrow screens it floats above or below the originating row. Undo is available
inside the task workspace, without a button above the dashboard lists.

`npm run test:side-panels-ui` uses the same dedicated Chrome test profile. It seeds
fake sections/tasks and checks panel order, independent scrolling, both map
directions, metadata, settings placement, narrow controls, and sync recovery
placement between occupied panels. `npm run test:recovery-ui` checks the exact
stored-record comparisons, collision avoidance, and complete recovery exports.

## Approved implementation stages

| Stage | Implemented behavior | Verification |
| --- | --- | --- |
| 1: Recursive tasks | Legacy migration, one recursive task type, root-list inheritance, branch moves/promotion, stable links, metadata, breadcrumbs, Focus navigation, and global Due Today. | Browser task model, UI workflows, and server document validation; equivalent native source and model tests. |
| 2: Dependencies and planning | Direct/inherited blockers, hierarchy-aware cycle checks, explicit completion and reopening with undo, connected outlines and structural editing, path search, dependency tracing, timeline markers, and activity history. | Browser model/UI workflows and server conflict/graph tests; equivalent native source and model tests. |
| 3: Recurrence and scheduling | Immutable individual/branch occurrence snapshots, shifted child offsets, monthly clamping, date-shift previews with cross-project warnings, and input-gated calendar critical-path/float calculations. | Browser model/UI workflows and exported-document validation; equivalent native source and model tests. |

Browser and server checks run on Windows. Native tests are supplied in
`app/appTests/TaskGraphTests.swift`; a macOS/Xcode build and test run are still
required to verify SwiftUI integration and reminders on a device. This is a
verification limit, rather than an omitted native implementation stage.

Manual release checks:

- Create a root, subtask, and deeply nested child with different dates; verify
  Due Today includes every qualifying task across Inbox and custom lists.
- Move a branch, rename its root, and follow its breadcrumb and reminder links.
- Add a cross-project prerequisite and an inherited parent blocker. Confirm
  readiness changes after completion and that circular links are rejected.
- Complete children, explicitly close the parent, reopen a child, and verify its
  ancestors reopen. Exercise branch-completion confirmation and undo.
- Preview/apply a schedule shift; verify unrelated tasks and history stay intact.
- Repeat a dated branch and a monthly task spanning February; inspect immutable
  occurrence snapshots and the next scheduled dates on both clients.
- Trash a subtree with a previously trashed descendant, restore it, and check
  that separate prior deletions remain separately recoverable.
- Edit different tasks and different fields concurrently on two devices; verify
  automatic merges. Compete on one field and verify both versions survive review.
- Complete a parent on one device while adding a child on another; verify an
  explicit conflict rather than a closed parent with unfinished hidden work.
- Verify an old client cannot overwrite/delete the migrated todo document and
  that compatible revision restore creates a new history entry.
