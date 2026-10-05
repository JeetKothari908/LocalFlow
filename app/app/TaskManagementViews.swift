import SwiftUI

struct TaskMovePicker: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    @State private var parent = ""
    @State private var listId = ""
    @State private var search = ""
    private var excluded: Set<String> { Set([taskId] + TaskGraph.descendants(store.todos, taskId).map(\.id)) }
    var body: some View {
        NavigationStack {
            Form {
                Picker("Destination", selection: $parent) {
                    Text("Top level project").tag("")
                    ForEach(store.todos.items.filter { !excluded.contains($0.id) && TaskGraph.available(store.todos, $0) && (search.isEmpty || $0.contents.localizedCaseInsensitiveContains(search)) }) { Text(TaskGraph.path(store.todos, $0.id).map(\.contents).joined(separator: " › ")).tag($0.id) }
                }
                if parent.isEmpty { Picker("List", selection: $listId) { Text("Inbox").tag(""); ForEach(store.todos.customLists.filter { $0.deletedAt == nil }) { Text($0.name).tag($0.id) } } }
                Text("All subtasks move with this task. Dependencies keep their stable references.").font(.caption).foregroundStyle(.secondary)
                if let error = store.errorMessage { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Move task").searchable(text: $search)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Move") {
                        if store.mutateTasks({ data in
                            try TaskGraph.move(&data, id: taskId, parent: parent.isEmpty ? nil : parent, listId: listId.isEmpty ? nil : listId)
                            if parent.isEmpty && listId.isEmpty, let index = data.items.firstIndex(where: { $0.id == taskId }) { data.items[index].listId = nil }
                        }) { dismiss() }
                    }
                }
            }
            .onAppear { parent = TaskGraph.item(store.todos, taskId)?.parentTaskId ?? ""; listId = TaskGraph.root(store.todos, taskId)?.listId ?? "" }
        }
    }
}

struct TaskListManager: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: SyncStore
    @State private var name = ""
    @State private var rename: CustomList?
    @State private var renameText = ""
    @State private var confirmDelete: CustomList?
    var body: some View {
        NavigationStack {
            List {
                Section("New list") {
                    TextField("List name", text: $name)
                    Button("Add list") { store.saveList(name: name); name = "" }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section("Custom lists") {
                    ForEach(store.todos.customLists.filter { $0.deletedAt == nil }) { list in
                        HStack {
                            Text(list.name); Spacer()
                            Button("Rename") { rename = list; renameText = list.name }.buttonStyle(.borderless)
                            Button(role: .destructive) { confirmDelete = list } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                        }
                    }
                }
            }.navigationTitle("Lists")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .alert("Rename list", isPresented: Binding(get: { rename != nil }, set: { if !$0 { rename = nil } })) {
                    TextField("Name", text: $renameText)
                    Button("Save") { if let rename { store.saveList(id: rename.id, name: renameText) }; rename = nil }
                    Button("Cancel", role: .cancel) { rename = nil }
                }
                .confirmationDialog("Delete this list?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
                    Button("Delete list", role: .destructive) { if let confirmDelete { store.deleteList(confirmDelete.id) }; confirmDelete = nil }
                } message: { Text("Its projects return to Inbox. Their task structure is preserved.") }
        }
    }
}

struct TaskHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: SyncStore
    @State private var mode = "Completed"
    private let modes = ["Completed", "Canceled", "Occurrences", "Archived", "Trash", "Activity"]
    var body: some View {
        NavigationStack {
            List {
                Picker("History", selection: $mode) { ForEach(modes, id: \.self) { Text($0).tag($0) } }
                if mode == "Completed" {
                    ForEach(store.todos.items.filter { $0.isDone && $0.deletedAt == nil }) { TaskRow(item: $0) }
                } else if mode == "Canceled" {
                    ForEach(store.todos.items.filter { $0.isCanceled && $0.deletedAt == nil }) { item in
                        VStack(alignment: .leading) { TaskRow(item: item); Button("Reopen task") { _ = store.mutateTasks { TaskGraph.reopen(&$0, id: item.id) } } }
                    }
                } else if mode == "Occurrences" {
                    ForEach(store.todos.occurrences.reversed()) { occurrence in
                        NavigationLink {
                            TaskOccurrenceView(occurrence: occurrence)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(occurrence.items.first(where: { $0.id == occurrence.taskId })?.contents ?? occurrence.items.first?.contents ?? "Recurring task")
                                Text("\(occurrence.dueDate ?? "Undated") · completed \(occurrence.completedAt)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else if mode == "Archived" {
                    ForEach(store.todos.items.filter { $0.deletedAt == nil && ($0.archivedAt != nil || $0.dismissed == true) }) { task in
                        HStack { NavigationLink(value: task.id) { Text(TaskGraph.path(store.todos, task.id).map(\.contents).joined(separator: " › ")) }; Button("Unarchive") { store.archiveTask(task.id, archived: false) }.buttonStyle(.borderless) }
                    }
                } else if mode == "Trash" {
                    ForEach(store.todos.items.filter { $0.deletedAt != nil && ($0.deletedByTaskId == $0.id || $0.parentTaskId.flatMap { TaskGraph.item(store.todos, $0)?.deletedAt } == nil) }) { task in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(TaskGraph.path(store.todos, task.id).map(\.contents).joined(separator: " › "))
                            Text("Deleted \(task.deletedAt ?? "")").font(.caption).foregroundStyle(.secondary)
                            Button("Restore branch") { store.restoreTask(task.id) }
                        }
                    }
                } else {
                    ForEach(store.todos.activity.reversed()) { entry in
                        VStack(alignment: .leading, spacing: 3) {
                            if let id = entry.taskId, let task = TaskGraph.item(store.todos, id) { NavigationLink(value: id) { Text(task.contents) } }
                            Text(entry.detail ?? entry.displayTitle); Text("\(entry.type) · \(entry.at)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Task history")
            .navigationDestination(for: String.self) { TaskWorkspace(taskId: $0) }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct TaskOccurrenceView: View {
    let occurrence: TaskOccurrence
    private var snapshot: TodoData { var data = TodoData(); data.items = occurrence.items; data.dependencies = occurrence.dependencies ?? []; return data }
    var body: some View {
        List {
            Section("Completed occurrence") { Text(occurrence.completedAt); Text("This snapshot preserves the tasks and dates from this occurrence.").font(.caption).foregroundStyle(.secondary) }
            ForEach(occurrence.items) { task in
                VStack(alignment: .leading, spacing: 4) {
                    Label(task.contents, systemImage: task.isCanceled ? "minus.circle" : (task.isDone ? "checkmark.circle" : "circle"))
                    Text(TaskGraph.path(snapshot, task.id).dropLast().map(\.contents).joined(separator: " › ")).font(.caption).foregroundStyle(.secondary)
                    if task.isCanceled { Text("Canceled").font(.caption).foregroundStyle(.secondary) }
                    if let due = TodoListView.displayDue(task) { Text(due).font(.caption) }
                    if let description = task.description { Text(description).font(.caption) }
                }
            }
        }.navigationTitle("Occurrence")
    }
}

struct TaskConflictView: View {
    @EnvironmentObject private var store: SyncStore
    let conflict: TodoSyncConflict
    var body: some View {
        NavigationStack {
            List {
                Section("Task changes need review") {
                    Text(conflict.detail)
                    Text("Both documents have been preserved. Choosing a copy stores the other as a recoverable backup.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Local copy · \(conflict.local.items.count) tasks") {
                    ForEach(conflict.local.items.filter { $0.parentTaskId == nil }) { Text($0.contents) }
                    Button("Keep local copy") { store.resolveTodoConflict(useLocal: true) }
                }
                Section("Synced copy · \(conflict.remote.items.count) tasks") {
                    ForEach(conflict.remote.items.filter { $0.parentTaskId == nil }) { Text($0.contents) }
                    Button("Use synced copy") { store.resolveTodoConflict(useLocal: false) }
                }
            }.navigationTitle("Review sync conflict")
        }
    }
}
