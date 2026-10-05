import SwiftUI

struct TodoListView: View {
    @EnvironmentObject private var store: SyncStore
    @State private var navigation = NavigationPath()
    @State private var selectedList = ""
    @State private var search = ""
    @State private var readyOnly = false
    @State private var priorityFirst = false
    @State private var creator: TodoItem?
    @State private var listManagerOpen = false
    @State private var historyOpen = false
    private var due: [TodoItem] {
        let tasks = TaskGraph.dueToday(store.todos).filter { !readyOnly || (TaskGraph.blockers(store.todos, $0.id).isEmpty && ($0.plannedStart.map { $0 <= SyncStore.todayKey() } ?? true)) }
        guard priorityFirst else { return tasks }
        let ranks = ["high": 0, "normal": 1, "low": 2]
        return tasks.enumerated().sorted {
            let left = ranks[$0.element.priority ?? "normal"] ?? 1, right = ranks[$1.element.priority ?? "normal"] ?? 1
            return left == right ? $0.offset < $1.offset : left < right
        }.map(\.element)
    }
    private var roots: [TodoItem] { TaskGraph.children(store.todos, nil).filter { !$0.isDone && ($0.listId ?? "") == selectedList } }
    private var matches: [TodoItem] { store.todos.items.filter { TaskGraph.available(store.todos, $0) && (TaskGraph.path(store.todos, $0.id).map(\.contents).joined(separator: " ") + " " + ($0.description ?? "")).localizedCaseInsensitiveContains(search) } }
    var body: some View {
        NavigationStack(path: $navigation) {
            List {
                if search.isEmpty {
                    Section {
                        Toggle("Ready to work only", isOn: $readyOnly)
                        Toggle("Sort by priority", isOn: $priorityFirst)
                        if due.isEmpty { Text("No tasks due").foregroundStyle(.secondary) }
                        let overdue = due.filter { ($0.dueDate ?? "") < SyncStore.todayKey() }
                        let today = due.filter { $0.dueDate == SyncStore.todayKey() }
                        if !overdue.isEmpty { Text("Overdue").font(.caption).foregroundStyle(.red); ForEach(overdue) { TaskRow(item: $0) } }
                        if !today.isEmpty { Text("Today").font(.caption).foregroundStyle(.secondary); ForEach(today) { TaskRow(item: $0) } }
                        DisclosureGroup("Completed today") {
                            ForEach(store.todos.items.filter { $0.isDone && $0.deletedAt == nil && TaskGraph.localDay(of: $0.completedAt) == SyncStore.todayKey() }) { TaskRow(item: $0) }
                            ForEach(store.todos.occurrences.filter { TaskGraph.localDay(of: $0.completedAt) == SyncStore.todayKey() }) { occurrence in
                                NavigationLink { TaskOccurrenceView(occurrence: occurrence) } label: { Label(occurrence.items.first(where: { $0.id == occurrence.taskId })?.contents ?? occurrence.items.first?.contents ?? "Recurring task", systemImage: "checkmark.circle") }
                            }
                        }
                        Button("Add task due today", systemImage: "plus") { creator = TodoItem(id: SyncStore.makeId(), contents: "", dueDate: SyncStore.todayKey(), dueTime: SyncStore.defaultDueTime, listId: selectedList.isEmpty ? nil : selectedList) }
                    } header: { Text("Due Today · All projects") }
                    Section {
                        Picker("List", selection: $selectedList) {
                            Text("Inbox").tag("")
                            ForEach(store.todos.customLists.filter { $0.deletedAt == nil }) { Text($0.name).tag($0.id) }
                        }
                        if roots.isEmpty { Text("No projects here yet").foregroundStyle(.secondary) }
                        ForEach(roots) { TaskRow(item: $0, showPath: false) }.onMove { store.reorderTasks(roots, from: $0, to: $1) }
                        Button("New project or task", systemImage: "plus") { creator = TodoItem(id: SyncStore.makeId(), contents: "", listId: selectedList.isEmpty ? nil : selectedList) }
                    } header: { Text("Projects") }
                } else {
                    Section("Matching tasks · All projects") {
                        if matches.isEmpty { Text("No matching tasks").foregroundStyle(.secondary) }
                        ForEach(matches) { item in
                            VStack(alignment: .leading, spacing: 8) {
                                TaskRow(item: item)
                                NavigationLink(value: TaskOutlineRoute(rootId: TaskGraph.root(store.todos, item.id)?.id ?? item.id, targetId: item.id)) { Label("Open in outline", systemImage: "list.bullet.indent").font(.caption) }
                            }
                        }
                    }
                }
                if let message = store.errorMessage { Section { Text(message).font(.caption).foregroundStyle(.red) } }
            }
            .navigationTitle("Tasks")
            .searchable(text: $search, prompt: "Search tasks, descriptions, and paths")
            .navigationDestination(for: String.self) { TaskWorkspace(taskId: $0) }
            .navigationDestination(for: TaskOutlineRoute.self) { TaskWorkspace(taskId: $0.rootId, outlineTarget: $0.targetId) }
            .toolbar {
                SyncToolbar()
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button("Manage lists", systemImage: "list.bullet") { listManagerOpen = true }
                        Button("Completed, history, and trash", systemImage: "archivebox") { historyOpen = true }
                        Button("Undo task change", systemImage: "arrow.uturn.backward") { store.undoTasks() }.disabled(!store.canUndoTasks)
                        Button("Recover preserved conflict backup", systemImage: "arrow.counterclockwise") { store.recoverTaskBackup() }
                        ShareLink(item: exportText) { Label("Export task document", systemImage: "square.and.arrow.up") }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack {
                    if let message = store.taskMessage { HStack { Text(message).font(.caption); Button("Undo") { store.undoTasks() }.disabled(!store.canUndoTasks) }.padding(.horizontal) }
                    SyncStatusView()
                }
            }
            .sheet(item: $creator) { TaskEditor(task: $0, isNew: true).environmentObject(store) }
            .sheet(isPresented: $listManagerOpen) { TaskListManager().environmentObject(store) }
            .sheet(isPresented: $historyOpen) { TaskHistoryView().environmentObject(store) }
            .sheet(item: $store.todoConflict) { TaskConflictView(conflict: $0).environmentObject(store).interactiveDismissDisabled() }
            .onAppear { if let id = store.taskToOpen { navigation = NavigationPath([id]); store.taskToOpen = nil; UserDefaults.standard.removeObject(forKey: "todo.pendingTaskId") } }
            .onChange(of: store.taskToOpen) { _, id in if let id { navigation = NavigationPath([id]); store.taskToOpen = nil; UserDefaults.standard.removeObject(forKey: "todo.pendingTaskId") } }
            .onChange(of: store.todos.customLists) { _, lists in if !selectedList.isEmpty && !lists.contains(where: { $0.id == selectedList }) { selectedList = "" } }
        }
    }
    private var exportText: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(store.todos)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
    static func dateKey(_ date: Date) -> String { TaskGraph.dateKey(date) }
    static func timeKey(_ date: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm"; return f.string(from: date)
    }
    static func defaultDueTimeDate() -> Date { Calendar.current.date(bySettingHour: 23, minute: 59, second: 0, of: Date()) ?? Date() }
    static func sortKey(_ item: TodoItem) -> String { "\(item.dueDate ?? "9999-99-99")T\(item.dueTime ?? SyncStore.defaultDueTime)" }
    static func displayDue(_ item: TodoItem) -> String? { item.dueDate.map { "\($0) \(item.dueTime ?? SyncStore.defaultDueTime)" } }
    static func isOverdue(_ item: TodoItem) -> Bool {
        guard let due = item.dueDate, !item.isDone else { return false }
        return due < SyncStore.todayKey() || (due == SyncStore.todayKey() && (item.dueTime ?? "23:59") < timeKey(Date()))
    }
}

struct TaskOutlineRoute: Hashable {
    let rootId: String
    let targetId: String
}

struct TaskRow: View {
    @EnvironmentObject private var store: SyncStore
    let item: TodoItem
    var showPath = true
    var showProjectSummary = true
    @State private var confirmComplete = false
    @State private var permanentCompletion = false
    @State private var editorOpen = false
    @State private var moveOpen = false
    private var progress: (completed: Int, total: Int) { TaskGraph.progress(store.todos, item.id) }
    private var blockers: [TaskBlocker] { TaskGraph.blockers(store.todos, item.id) }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                permanentCompletion = false
                if item.isDone { store.toggleTodo(item) }
                else if TaskGraph.descendants(store.todos, item.id).contains(where: { TaskGraph.active(store.todos, $0) }) { confirmComplete = true }
                else { _ = store.completeTask(item.id) }
            } label: { Image(systemName: item.isDone ? "checkmark.circle.fill" : (item.isCanceled ? "minus.circle" : "circle")).font(.title3).foregroundStyle(item.isDone ? Color.green : Color.accentColor) }
                .buttonStyle(.borderless).disabled(!TaskGraph.available(store.todos, item))
                .accessibilityLabel(item.isDone ? "Reopen \(item.contents)" : "Complete \(item.contents)")
            VStack(alignment: .leading, spacing: 4) {
                NavigationLink(value: item.id) { Text(item.contents).strikethrough(item.isDone).foregroundStyle(.primary) }.draggable(item.id)
                if showPath {
                    let path = TaskGraph.path(store.todos, item.id)
                    if let root = path.first { NavigationLink(value: root.id) { Text(path.count == 1 ? "Project · \(root.contents)" : path.dropLast().map(\.contents).joined(separator: " › ")).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                }
                if let due = TodoListView.displayDue(item) { Text(due).font(.caption).foregroundStyle(TodoListView.isOverdue(item) ? Color.red : Color.secondary) }
                if progress.total > 0 { Text("\(progress.completed) of \(progress.total) steps done\(TaskGraph.readyToComplete(store.todos, item.id) ? " · Ready to complete" : "")").font(.caption).foregroundStyle(.secondary) }
                if showProjectSummary && item.parentTaskId == nil && progress.total > 0 {
                    let summary = TaskGraph.summary(store.todos, item.id)
                    HStack(spacing: 8) {
                        if summary.dueToday > 0 { Text("\(summary.dueToday) due today") }
                        if summary.overdue > 0 { Text("\(summary.overdue) overdue") }
                        if summary.blocked > 0 { Text("\(summary.blocked) blocked") }
                    }.font(.caption).foregroundStyle(.secondary)
                    if let next = summary.next { NavigationLink(value: next.id) { Text("Next deadline: \(next.contents) · \(TodoListView.displayDue(next) ?? "")").font(.caption) } }
                }
                if !blockers.isEmpty {
                    ForEach(blockers, id: \.dependency.id) { blocker in
                        HStack(spacing: 4) {
                            Text("Waiting on:")
                            NavigationLink(value: blocker.dependency.prerequisiteTaskId) { Text(blocker.prerequisite?.contents ?? "Missing prerequisite") }
                            if let ancestor = blocker.inheritedFrom { Text("through"); NavigationLink(value: ancestor.id) { Text(ancestor.contents) } }
                        }.font(.caption).foregroundStyle(.orange)
                    }
                }
                else if item.status == "inProgress" { Text("In progress").font(.caption).foregroundStyle(.blue) }
                if item.repeat != nil { Text(item.repeatScope == "branch" ? "Repeating branch" : "Repeating task").font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            Menu {
                Button("Edit details", systemImage: "slider.horizontal.3") { editorOpen = true }
                Button("Move task", systemImage: "arrow.turn.down.right") { moveOpen = true }
                Button("Move up", systemImage: "arrow.up") { store.reorderTask(item.id, offset: -1) }
                Button("Move down", systemImage: "arrow.down") { store.reorderTask(item.id, offset: 1) }
                Button("Indent under previous task") { store.indentTask(item.id) }
                Button("Outdent one level") { store.outdentTask(item.id) }.disabled(item.parentTaskId == nil)
                Button("Promote to project") { _ = store.moveTask(item.id, parent: nil) }.disabled(item.parentTaskId == nil)
                if item.repeat != nil && !item.isDone {
                    Button("Finish recurring task permanently") {
                        permanentCompletion = true
                        if TaskGraph.descendants(store.todos, item.id).contains(where: { TaskGraph.active(store.todos, $0) }) { confirmComplete = true }
                        else { _ = store.completeTask(item.id, permanent: true) }
                    }
                }
                Button("Archive branch", systemImage: "archivebox") { store.archiveTask(item.id, archived: true) }
                Button("Move branch to trash", systemImage: "trash", role: .destructive) { store.deleteTodo(item) }
            } label: { Image(systemName: "ellipsis") }.buttonStyle(.borderless)
        }
        .sheet(isPresented: $confirmComplete) {
            TaskCompletionReview(taskId: item.id) { store.completeTask(item.id, cascade: true, permanent: permanentCompletion) }.environmentObject(store)
        }
        .sheet(isPresented: $editorOpen) { TaskEditor(task: TaskGraph.item(store.todos, item.id) ?? item).environmentObject(store) }
        .sheet(isPresented: $moveOpen) { TaskMovePicker(taskId: item.id).environmentObject(store) }
    }
}
