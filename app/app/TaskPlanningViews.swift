import SwiftUI

struct TaskDependencySections: View {
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    @Binding var pickerOpen: Bool
    private var incoming: [TaskDependency] {
        let scope = Set([taskId] + TaskGraph.ancestors(store.todos, taskId).map(\.id))
        return store.todos.dependencies.filter { $0.deletedAt == nil && scope.contains($0.dependentTaskId) }
    }
    private var outgoing: [TaskDependency] { store.todos.dependencies.filter { $0.deletedAt == nil && $0.prerequisiteTaskId == taskId } }
    var body: some View {
        Section("Dependency map · Selected branch") {
            TaskDependencyMap(taskId: taskId)
            Text("Arrows point from prerequisites to the work they unblock. Tap a task to follow its chain.").font(.caption).foregroundStyle(.secondary)
        }
        Section("Blocked by") {
            if incoming.isEmpty { Text("No prerequisites").foregroundStyle(.secondary) }
            ForEach(incoming) { edge in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        if let prerequisite = TaskGraph.item(store.todos, edge.prerequisiteTaskId) {
                            NavigationLink(value: prerequisite.id) { Label(prerequisite.contents, systemImage: prerequisite.isDone ? "checkmark.circle" : "hourglass") }
                            Text(TaskGraph.path(store.todos, prerequisite.id).dropLast().map(\.contents).joined(separator: " › ")).font(.caption).foregroundStyle(.secondary)
                            if !TaskGraph.available(store.todos, prerequisite) && !prerequisite.isDone { Text("Prerequisite unavailable; review this relationship").font(.caption).foregroundStyle(.orange) }
                        } else { Text("Missing prerequisite").foregroundStyle(.orange) }
                        if edge.dependentTaskId != taskId, let ancestor = TaskGraph.item(store.todos, edge.dependentTaskId) { NavigationLink(value: ancestor.id) { Text("Inherited through \(ancestor.contents)").font(.caption) } }
                    }
                    Spacer()
                    if edge.dependentTaskId == taskId { Button(role: .destructive) { store.removeDependency(edge) } label: { Image(systemName: "link.badge.minus") }.buttonStyle(.borderless) }
                }
            }
            Button("Add prerequisite", systemImage: "link") { pickerOpen = true }
        }
        Section("Unblocks") {
            if outgoing.isEmpty { Text("No dependent tasks").foregroundStyle(.secondary) }
            ForEach(outgoing) { edge in
                if let task = TaskGraph.item(store.todos, edge.dependentTaskId) {
                    HStack {
                        NavigationLink(value: task.id) { VStack(alignment: .leading) { Text(task.contents); Text(TaskGraph.path(store.todos, task.id).dropLast().map(\.contents).joined(separator: " › ")).font(.caption).foregroundStyle(.secondary) } }
                        Button(role: .destructive) { store.removeDependency(edge) } label: { Image(systemName: "link.badge.minus") }.buttonStyle(.borderless)
                    }
                }
            }
        }
    }
}

struct TaskDependencyPicker: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    @State private var search = ""
    var body: some View {
        NavigationStack {
            List {
                Section { Text("Select a task that must finish first. Dependencies may cross projects. Circular relationships are rejected.").font(.caption).foregroundStyle(.secondary) }
                ForEach(store.todos.items.filter { $0.id != taskId && $0.deletedAt == nil && (search.isEmpty || TaskGraph.path(store.todos, $0.id).map(\.contents).joined(separator: " ").localizedCaseInsensitiveContains(search)) }) { task in
                    Button {
                        if store.addDependency(prerequisite: task.id, dependent: taskId) { dismiss() }
                    } label: {
                        VStack(alignment: .leading, spacing: 3) { Text(task.contents); Text(TaskGraph.path(store.todos, task.id).dropLast().map(\.contents).joined(separator: " › ")).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                if let error = store.errorMessage { Text(error).foregroundStyle(.red) }
            }.navigationTitle("Choose prerequisite").searchable(text: $search)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

struct TaskDependencyMap: View {
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    @State private var selectedId: String?
    var body: some View {
        let layout = TaskMapLayout(data: store.todos, taskId: taskId)
        let selected = selectedId ?? taskId
        let trace = TaskGraph.dependencyTrace(store.todos, selected)
        ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for edge in layout.edges {
                        guard let a = layout.positions[edge.prerequisiteTaskId], let b = layout.positions[edge.dependentTaskId] else { continue }
                        let from = CGPoint(x: a.x + 84, y: a.y), to = CGPoint(x: b.x - 84, y: b.y)
                        var path = Path(); path.move(to: from)
                        path.addCurve(to: to, control1: CGPoint(x: (from.x + to.x) / 2, y: from.y), control2: CGPoint(x: (from.x + to.x) / 2, y: to.y))
                        let emphasized = trace.edgeIds.contains(edge.id)
                        let tint = emphasized ? Color.accentColor : Color.secondary.opacity(0.3)
                        context.stroke(path, with: .color(tint), lineWidth: emphasized ? 2.5 : 1.5)
                        var arrow = Path(); arrow.move(to: CGPoint(x: to.x - 7, y: to.y - 4)); arrow.addLine(to: to); arrow.addLine(to: CGPoint(x: to.x - 7, y: to.y + 4))
                        context.stroke(arrow, with: .color(tint), lineWidth: emphasized ? 2.5 : 1.5)
                    }
                }
                ForEach(layout.tasks) { task in
                    Button { selectedId = task.id } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(task.contents).font(.caption).bold().lineLimit(2)
                            Text(TaskGraph.root(store.todos, task.id)?.contents ?? "").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            Text(task.deletedAt != nil ? "Trash" : (task.archivedAt != nil || task.dismissed == true ? "Archived" : (task.isCanceled ? "Canceled" : (task.isDone ? "Done" : (TaskGraph.blockers(store.todos, task.id).isEmpty ? "Ready" : "Blocked"))))).font(.caption2)
                        }.frame(width: 150, height: 64, alignment: .leading).padding(8)
                            .background(task.id == selected ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                            .opacity(task.id == selected || (trace.taskIds.contains(task.id) && !task.isDone) ? 1 : 0.45)
                    }.buttonStyle(.plain).position(layout.positions[task.id] ?? .zero)
                }
            }.frame(width: layout.width, height: layout.height)
        }.frame(height: min(400, layout.height))
        NavigationLink(value: selected) { Label("Open selected task", systemImage: "arrow.up.right.square") }
        ForEach(TaskGraph.blockers(store.todos, selected), id: \.dependency.id) { blocker in
            VStack(alignment: .leading, spacing: 4) {
                NavigationLink(value: blocker.dependency.prerequisiteTaskId) { Text("Waiting on \(blocker.prerequisite?.contents ?? "Missing prerequisite")").font(.caption) }
                if let ancestor = blocker.inheritedFrom { NavigationLink(value: ancestor.id) { Text("Inherited through \(ancestor.contents)").font(.caption) } }
            }
        }
        Text("Highlighted arrows trace unfinished prerequisites and direct dependents. Fulfilled prerequisites are dimmed.").font(.caption).foregroundStyle(.secondary)
    }
}

private struct TaskMapLayout {
    let tasks: [TodoItem]
    let edges: [TaskDependency]
    let positions: [String: CGPoint]
    let width: CGFloat
    let height: CGFloat
    init(data: TodoData, taskId: String) {
        let branch = Set([taskId] + TaskGraph.descendants(data, taskId).map(\.id))
        var scope = branch, queueIds = Array(branch), position = 0, foundEdges: [String: TaskDependency] = [:]
        while position < queueIds.count {
            let id = queueIds[position]; position += 1
            let inheritedScope = Set([id] + TaskGraph.ancestors(data, id).map(\.id))
            for edge in data.dependencies where edge.deletedAt == nil && inheritedScope.contains(edge.dependentTaskId) {
                foundEdges[edge.id] = edge
                let prerequisiteBranch = [edge.prerequisiteTaskId] + TaskGraph.descendants(data, edge.prerequisiteTaskId).map(\.id)
                for prerequisite in prerequisiteBranch { if scope.insert(prerequisite).inserted { queueIds.append(prerequisite) } }
                scope.insert(edge.dependentTaskId)
            }
        }
        for edge in data.dependencies where edge.deletedAt == nil && branch.contains(edge.prerequisiteTaskId) { foundEdges[edge.id] = edge; scope.insert(edge.dependentTaskId) }
        edges = foundEdges.values.sorted { $0.id < $1.id }
        let ids = scope
        tasks = data.items.filter { ids.contains($0.id) }
        var indegree = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, 0) }), next: [String: [String]] = [:], levels: [String: Int] = [:]
        for edge in edges where ids.contains(edge.prerequisiteTaskId) && ids.contains(edge.dependentTaskId) { indegree[edge.dependentTaskId, default: 0] += 1; next[edge.prerequisiteTaskId, default: []].append(edge.dependentTaskId) }
        var queue = indegree.filter { $0.value == 0 }.map(\.key).sorted(), cursor = 0
        while cursor < queue.count {
            let id = queue[cursor]; cursor += 1
            for child in next[id] ?? [] { levels[child] = max(levels[child] ?? 0, (levels[id] ?? 0) + 1); indegree[child, default: 0] -= 1; if indegree[child] == 0 { queue.append(child) } }
        }
        var rows: [Int: Int] = [:], points: [String: CGPoint] = [:]
        for task in tasks { let column = levels[task.id] ?? 0, row = rows[column] ?? 0; points[task.id] = CGPoint(x: CGFloat(column) * 220 + 96, y: CGFloat(row) * 94 + 48); rows[column] = row + 1 }
        positions = points; width = CGFloat((levels.values.max() ?? 0) + 1) * 220; height = CGFloat(max(1, rows.values.max() ?? 1)) * 94
    }
}

struct TaskTimelineSection: View {
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    private var branch: [TodoItem] { ([TaskGraph.item(store.todos, taskId)].compactMap { $0 } + TaskGraph.descendants(store.todos, taskId)).filter { TaskGraph.available(store.todos, $0) }.sorted { TodoListView.sortKey($0) < TodoListView.sortKey($1) } }
    var body: some View {
        let dated = branch.filter { $0.dueDate != nil || $0.plannedStart != nil }
        let dates = dated.flatMap { [TaskGraph.date($0.plannedStart), TaskGraph.date($0.dueDate)].compactMap { $0 } }
        let earliest = dates.min() ?? Date(), latest = dates.max() ?? Date()
        let span = max(86400, latest.timeIntervalSince(earliest))
        Section("Timeline · Explicit dates") {
            if dated.isEmpty { Text("Add task deadlines or planned starts to build a timeline.").foregroundStyle(.secondary) }
            else {
                HStack { Text(TaskGraph.dateKey(earliest)); Spacer(); Text(TaskGraph.dateKey(latest)) }.font(.caption).foregroundStyle(.secondary)
                ForEach(dated) { task in
                    VStack(alignment: .leading, spacing: 4) {
                        NavigationLink(value: task.id) { Text(task.contents).strikethrough(task.isDone) }
                        Text(TaskGraph.path(store.todos, task.id).dropLast().map(\.contents).joined(separator: " › ")).font(.caption).foregroundStyle(.secondary)
                        GeometryReader { geometry in
                            let start = TaskGraph.date(task.plannedStart) ?? TaskGraph.date(task.dueDate) ?? earliest
                            let end = TaskGraph.date(task.dueDate) ?? start
                            let width = max(0, geometry.size.width - 10)
                            let left = max(0, min(1, start.timeIntervalSince(earliest) / span)) * width
                            let right = max(0, min(1, end.timeIntervalSince(earliest) / span)) * width
                            let tint = task.isDone ? Color.green : (TaskGraph.blockers(store.todos, task.id).isEmpty ? Color.accentColor : Color.orange)
                            ZStack(alignment: .topLeading) {
                                if task.plannedStart != nil && task.dueDate != nil { RoundedRectangle(cornerRadius: 3).fill(tint.opacity(0.5)).frame(width: max(2, right - left), height: 4).offset(x: left, y: 3) }
                                if task.plannedStart != nil { Circle().stroke(tint, lineWidth: 1.5).frame(width: 10, height: 10).offset(x: left) }
                                if task.dueDate != nil { Image(systemName: "diamond.fill").font(.system(size: 10)).foregroundStyle(tint).offset(x: right) }
                            }
                        }.frame(height: 12)
                        Text("\(task.plannedStart.map { "Start \($0) · " } ?? "")\(task.dueDate.map { "Due \($0)" } ?? "No deadline")").font(.caption).foregroundStyle(TodoListView.isOverdue(task) ? Color.red : Color.secondary)
                        ForEach(TaskGraph.scheduleWarnings(store.todos, task.id), id: \.self) { Text($0).font(.caption2).foregroundStyle(.orange) }
                    }
                }
            }
            Text("◆ Deadline · ○ Planned start · Bars span start to deadline").font(.caption2).foregroundStyle(.secondary)
        }
        let branchIds = Set(branch.map(\.id))
        let dependencies = store.todos.dependencies.filter { $0.deletedAt == nil && branchIds.contains($0.dependentTaskId) }
        if !dependencies.isEmpty {
            Section("Scheduling dependencies") {
                ForEach(dependencies) { dependency in
                    VStack(alignment: .leading, spacing: 4) {
                        NavigationLink(value: dependency.prerequisiteTaskId) { Text(TaskGraph.path(store.todos, dependency.prerequisiteTaskId).map(\.contents).joined(separator: " › ")) }
                        Label("Must finish before", systemImage: "arrow.down").font(.caption).foregroundStyle(.secondary)
                        NavigationLink(value: dependency.dependentTaskId) { Text(TaskGraph.item(store.todos, dependency.dependentTaskId)?.contents ?? "Unavailable task") }
                    }
                }
            }
        }
        Section("Planning estimate") {
            if let path = TaskGraph.criticalPath(store.todos, taskId) {
                Text("Longest dependency chain: \(path.minutes.formatted()) estimated minutes")
                Text(path.ids.compactMap { TaskGraph.item(store.todos, $0)?.contents }.joined(separator: " → ")).font(.caption).foregroundStyle(.secondary)
                Text("This estimate uses task effort and dependencies. It does not assume working hours or automatic deadline changes.").font(.caption).foregroundStyle(.secondary)
            } else { Text("Add estimates to every unfinished leaf task in the dependency chain to calculate its length.").font(.caption).foregroundStyle(.secondary) }
        }
        TaskScheduleAnalysisSection(taskId: taskId)
    }
}

struct TaskScheduleAnalysisSection: View {
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    var body: some View {
        let analysis = TaskGraph.analyzeSchedule(store.todos, taskId)
        Section("Schedule analysis") {
            Text("This scenario uses planned dates and uninterrupted estimated effort. It leaves dates unchanged and does not assume working hours.").font(.caption).foregroundStyle(.secondary)
            ForEach(analysis.unavailableIds, id: \.self) { id in NavigationLink(value: id) { Text("Resolve unavailable prerequisite: \(TaskGraph.item(store.todos, id)?.contents ?? id)").foregroundStyle(.orange) } }
            ForEach(analysis.missingEstimateIds, id: \.self) { id in NavigationLink(value: id) { Text("Add effort estimate: \(TaskGraph.item(store.todos, id)?.contents ?? id)") } }
            ForEach(analysis.missingStartIds, id: \.self) { id in NavigationLink(value: id) { Text("Add a planned start to anchor: \(TaskGraph.item(store.todos, id)?.contents ?? id)") } }
            if let finish = analysis.earliestFinish {
                LabeledContent("Earliest planned finish", value: finish.formatted(date: .abbreviated, time: .shortened))
                if let margin = analysis.deadlineMarginMinutes {
                    Text(margin < 0 ? "Beyond deadline by \((-margin).formatted()) min" : "Deadline margin: \(margin.formatted()) min").foregroundStyle(margin < 0 ? Color.orange : Color.primary)
                    Text("Scheduled critical path").font(.caption).bold()
                    ForEach(analysis.criticalTaskIds, id: \.self) { id in NavigationLink(value: id) { Text(TaskGraph.item(store.todos, id)?.contents ?? id) } }
                } else { Text("Add a deadline to this outcome to calculate the scheduled critical path and deadline margin.").font(.caption) }
                DisclosureGroup("Scheduled steps (\(analysis.rows.count))") {
                    ForEach(analysis.rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            NavigationLink(value: row.id) { Text(TaskGraph.path(store.todos, row.id).map(\.contents).joined(separator: " › ")) }
                            Text("Start: \(row.start.formatted(date: .abbreviated, time: .shortened)) · Finish: \(row.finish.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                            if let float = row.floatMinutes { Text("Float: \(float.formatted()) min\(row.critical ? " · Critical" : "")").font(.caption).foregroundStyle(row.critical ? Color.accentColor : Color.secondary) }
                            if row.summary { Text("Summary outcome").font(.caption).foregroundStyle(.secondary) }
                            if row.lateMinutes > 0 { Text("Beyond own deadline by \(row.lateMinutes.formatted()) min").font(.caption).foregroundStyle(.orange) }
                        }
                    }
                    Text("Float measures delay without changing the earliest planned finish. The outcome's deadline margin is separate.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct TaskScheduleShiftView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: SyncStore
    let taskId: String
    @State private var days = 1
    var body: some View {
        NavigationStack {
            List {
                Section { Stepper("Shift by \(days) days", value: $days, in: -3650...3650); Text("Preview for this task and its unfinished descendants. Completed tasks and occurrence history keep their original dates.").font(.caption).foregroundStyle(.secondary) }
                ForEach(TaskGraph.shiftPreview(store.todos, id: taskId, days: days)) { change in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(change.title)
                        if let old = change.oldDue, let new = change.newDue { Text("Deadline: \(old) → \(new)").font(.caption) }
                        if let old = change.oldStart, let new = change.newStart { Text("Start: \(old) → \(new)").font(.caption) }
                    }
                }
                ForEach(TaskGraph.scheduleShiftWarnings(store.todos, taskId, days: days), id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
            }.navigationTitle("Shift branch schedule")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Apply shift") { store.shiftSchedule(taskId, days: days); dismiss() }.disabled(days == 0 || TaskGraph.shiftPreview(store.todos, id: taskId, days: days).isEmpty) }
                }
        }
    }
}
