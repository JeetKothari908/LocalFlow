import SwiftUI

struct TaskWorkspace: View {
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    var outlineTarget: String? = nil
    @State private var mode = "Tasks"
    @State private var outline = false
    @State private var expanded: Set<String> = []
    @State private var creator: TodoItem?
    @State private var editorOpen = false
    @State private var shiftOpen = false
    @State private var dependencyOpen = false
    private var task: TodoItem? { TaskGraph.item(store.todos, taskId) }
    private var children: [TodoItem] { TaskGraph.children(store.todos, taskId) }
    private var branchIds: Set<String> { Set([taskId] + TaskGraph.descendants(store.todos, taskId).map(\.id)) }
    var body: some View {
        Group {
            if let task {
                ScrollViewReader { reader in
                    List {
                        Section {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(TaskGraph.path(store.todos, taskId)) { ancestor in
                                        NavigationLink(value: ancestor.id) { Text(ancestor.contents).font(.caption).lineLimit(1) }
                                        if ancestor.id != taskId { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary) }
                                    }
                                }
                            }
                            TaskRow(item: task, showPath: false, showProjectSummary: false).id(taskId)
                            if let next = TaskGraph.summary(store.todos, taskId).next { NavigationLink(value: next.id) { Text("Next subtask deadline: \(next.contents) · \(TodoListView.displayDue(next) ?? "")").font(.caption) } }
                            if let description = task.description, !description.isEmpty { Text(description).textSelection(.enabled) }
                            if let start = task.plannedStart { LabeledContent("Planned start", value: start) }
                            if let estimate = task.estimatedMinutes { LabeledContent("Estimate", value: "\(estimate) minutes") }
                            if let priority = task.priority, priority != "normal" { LabeledContent("Priority", value: priority.capitalized) }
                            ForEach(TaskGraph.scheduleWarnings(store.todos, taskId), id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
                            Picker("View", selection: $mode) { Text("Tasks").tag("Tasks"); Text("Dependencies").tag("Dependencies"); Text("Timeline").tag("Timeline") }.pickerStyle(.segmented)
                        }
                        if task.deletedAt != nil { Section { Button("Restore branch") { store.restoreTask(taskId) } } }
                        else if task.archivedAt != nil || task.dismissed == true { Section { Button("Unarchive branch") { store.archiveTask(taskId, archived: false) } } }
                        if mode == "Tasks" {
                            Section {
                                Toggle("Expand as outline", isOn: $outline)
                                if children.isEmpty { Text("No subtasks yet").foregroundStyle(.secondary) }
                                if outline {
                                    ForEach(TaskGraph.outlineRows(store.todos, taskId, expanded: expanded)) { row in
                                        TaskOutlineNode(row: row, expanded: $expanded)
                                            .id(row.id)
                                            .listRowBackground(row.id == outlineTarget ? Color.accentColor.opacity(0.12) : nil)
                                    }
                                }
                                else { ForEach(children) { TaskRow(item: $0, showPath: false) }.onMove { store.reorderTasks(children, from: $0, to: $1) } }
                                Button("Add subtask", systemImage: "plus") { creator = TodoItem(id: SyncStore.makeId(), contents: "", parentTaskId: taskId) }.disabled(task.deletedAt != nil || task.archivedAt != nil || task.dismissed == true || task.isCanceled)
                            } header: { Text("Subtasks") }
                            Section("Activity") {
                                let entries = store.todos.activity.filter { $0.taskId.map { branchIds.contains($0) } ?? false }.suffix(30).reversed()
                                ForEach(Array(entries)) { entry in
                                    VStack(alignment: .leading, spacing: 3) { Text(entry.detail ?? entry.displayTitle).font(.subheadline); Text("\(entry.type) · \(entry.at)").font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        } else if mode == "Dependencies" { TaskDependencySections(taskId: taskId, pickerOpen: $dependencyOpen); TaskScheduleAnalysisSection(taskId: taskId) }
                        else { TaskTimelineSection(taskId: taskId); Section { Button("Shift branch schedule", systemImage: "calendar.badge.clock") { shiftOpen = true } } }
                        if let message = store.taskMessage { Section { Text(message).font(.caption); Button("Undo task change") { store.undoTasks() }.disabled(!store.canUndoTasks) } }
                        if let error = store.errorMessage { Section { Text(error).font(.caption).foregroundStyle(.red) } }
                    }
                    .onAppear {
                        guard let target = outlineTarget else { return }
                        outline = true; expanded = Set(TaskGraph.ancestors(store.todos, target).map(\.id))
                    }
                    .onChange(of: expanded) { _, _ in
                        if let target = outlineTarget { withAnimation { reader.scrollTo(target, anchor: .center) } }
                    }
                }
                .navigationTitle(task.contents)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button("Edit") { editorOpen = true } }
                    ToolbarItem(placement: .topBarTrailing) { Button { store.undoTasks() } label: { Image(systemName: "arrow.uturn.backward") }.disabled(!store.canUndoTasks) }
                }
                .sheet(isPresented: $editorOpen) { TaskEditor(task: task).environmentObject(store) }
            } else { ContentUnavailableView("Task unavailable", systemImage: "checklist", description: Text("This task may have been removed on another device.")) }
        }
        .sheet(item: $creator) { TaskEditor(task: $0, isNew: true).environmentObject(store) }
        .sheet(isPresented: $shiftOpen) { TaskScheduleShiftView(taskId: taskId).environmentObject(store) }
        .sheet(isPresented: $dependencyOpen) { TaskDependencyPicker(taskId: taskId).environmentObject(store) }
    }
}

struct TaskOutlineNode: View {
    @EnvironmentObject private var store: SyncStore
    let row: TaskGraph.OutlineRow
    @Binding var expanded: Set<String>
    private var taskId: String { row.id }
    private var children: [TodoItem] { TaskGraph.children(store.todos, taskId) }
    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Button { if expanded.contains(taskId) { expanded.remove(taskId) } else { expanded.insert(taskId) } } label: {
                Image(systemName: expanded.contains(taskId) ? "chevron.down" : "chevron.right").font(.caption).frame(width: 14)
            }.buttonStyle(.borderless).disabled(children.isEmpty).opacity(children.isEmpty ? 0.2 : 1)
            TaskRow(item: row.task, showPath: false)
        }
        .padding(.leading, CGFloat(row.guides.count + 1) * 12)
        .background(alignment: .leading) {
            Canvas { context, size in
                var path = Path()
                for (index, continues) in row.guides.enumerated() where continues {
                    let x = CGFloat(index) * 12 + 1
                    path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: size.height))
                }
                let x = CGFloat(row.guides.count) * 12 + 1
                path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: row.isLast ? size.height / 2 : size.height))
                path.move(to: CGPoint(x: x, y: size.height / 2)); path.addLine(to: CGPoint(x: x + 10, y: size.height / 2))
                context.stroke(path, with: .color(.secondary.opacity(0.35)), lineWidth: 1)
            }.frame(width: CGFloat(row.guides.count + 1) * 12).accessibilityHidden(true).allowsHitTesting(false)
        }
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, TaskGraph.item(store.todos, id) != nil else { return false }
            let moved = store.moveTask(id, parent: taskId)
            if moved { expanded.insert(taskId) }
            return moved
        }
    }
}

struct TaskCompletionReview: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    let onConfirm: () -> Bool
    private var unfinished: [TodoItem] { TaskGraph.descendants(store.todos, taskId).filter { TaskGraph.active(store.todos, $0) } }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Complete \(TaskGraph.item(store.todos, taskId)?.contents ?? "this task") and \(unfinished.count) unfinished subtasks?")
                    Text("Earlier completions keep their original dates. External prerequisites must be resolved. You can undo this change.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Remaining subtasks") {
                    ForEach(unfinished) { task in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(task.contents)
                            Text(TaskGraph.path(store.todos, task.id).dropLast().map(\.contents).joined(separator: " › ")).font(.caption).foregroundStyle(.secondary)
                            Text(TodoListView.displayDue(task) ?? "No deadline").font(.caption).foregroundStyle(.secondary)
                            let completionIds = Set([taskId] + unfinished.map(\.id))
                            ForEach(TaskGraph.blockers(store.todos, task.id).filter { !completionIds.contains($0.dependency.prerequisiteTaskId) }, id: \.dependency.id) { blocker in
                                Text("Requires resolution: \(blocker.prerequisite?.contents ?? "Missing prerequisite")").font(.caption).foregroundStyle(.orange)
                            }
                        }
                    }
                }
                if let error = store.errorMessage { Section { Text(error).foregroundStyle(.red) } }
                Section { Button("Complete remaining subtasks") { if onConfirm() { dismiss() } }.disabled(TaskGraph.item(store.todos, taskId) == nil) }
            }
            .navigationTitle("Review completion")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Keep working") { dismiss() } } }
        }
    }
}
