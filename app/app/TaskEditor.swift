import SwiftUI

struct TaskEditor: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: SyncStore
    let isNew: Bool
    @State private var original: TodoItem
    @State private var task: TodoItem
    @State private var useDue: Bool
    @State private var due: Date
    @State private var time: Date
    @State private var useStart: Bool
    @State private var start: Date
    @State private var repeatMode: RepeatMode
    @State private var days: Set<Int>
    @State private var monthDay: Int
    @State private var estimate: String
    @State private var parentSelection: String
    @State private var projectSelection: String
    @State private var confirmComplete = false
    @State private var completeDescendants = false
    @State private var completionSaved = false
    init(task: TodoItem, isNew: Bool = false) {
        self.isNew = isNew; _original = State(initialValue: task)
        _task = State(initialValue: task); _useDue = State(initialValue: task.dueDate != nil)
        _due = State(initialValue: TaskGraph.date(task.dueDate) ?? Date())
        let formatter = DateFormatter(); formatter.dateFormat = "HH:mm"; formatter.locale = Locale(identifier: "en_US_POSIX")
        _time = State(initialValue: formatter.date(from: task.dueTime ?? "23:59") ?? TodoListView.defaultDueTimeDate())
        _useStart = State(initialValue: task.plannedStart != nil); _start = State(initialValue: TaskGraph.date(task.plannedStart) ?? Date())
        _repeatMode = State(initialValue: RepeatMode(rule: task.repeat)); _days = State(initialValue: Set(task.repeat?.days ?? []))
        _monthDay = State(initialValue: task.repeat?.day ?? Calendar.current.component(.day, from: TaskGraph.date(task.dueDate) ?? Date()))
        _estimate = State(initialValue: task.estimatedMinutes.map { String($0) } ?? "")
        _parentSelection = State(initialValue: task.parentTaskId ?? ""); _projectSelection = State(initialValue: task.listId ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("Name", text: $task.contents, axis: .vertical)
                    TextField("Description, instructions, and links", text: Binding(get: { task.description ?? "" }, set: { task.description = $0 }), axis: .vertical).lineLimit(3...10)
                    Picker("State", selection: Binding(get: { task.status ?? (task.isDone ? "done" : "todo") }, set: { task.status = $0; task.completed = $0 == "done" })) {
                        Text("To do").tag("todo"); Text("In progress").tag("inProgress"); Text("Canceled").tag("canceled")
                        Text("Done").tag("done")
                    }
                    Picker("Priority", selection: Binding(get: { task.priority ?? "normal" }, set: { task.priority = $0 })) { Text("Low").tag("low"); Text("Normal").tag("normal"); Text("High").tag("high") }
                    TextField("Estimated minutes", text: $estimate)
                }
                if isNew {
                    Section("Location") {
                        Picker("Parent task", selection: $parentSelection) {
                            Text("Top level project").tag("")
                            ForEach(store.todos.items.filter { TaskGraph.available(store.todos, $0) }) { Text(TaskGraph.path(store.todos, $0.id).map(\.contents).joined(separator: " › ")).tag($0.id) }
                        }
                        if parentSelection.isEmpty { listPicker }
                    }
                } else if task.parentTaskId == nil {
                    Section("Location") {
                        Picker("List", selection: Binding(get: { task.listId ?? "" }, set: { task.listId = $0.isEmpty ? nil : $0 })) {
                            Text("Inbox").tag(""); ForEach(store.todos.customLists.filter { $0.deletedAt == nil }) { Text($0.name).tag($0.id) }
                        }
                    }
                }
                Section("Schedule") {
                    Toggle("Deadline", isOn: $useDue)
                    if useDue { DatePicker("Due", selection: $due, displayedComponents: .date); DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute) }
                    Toggle("Planned start", isOn: $useStart)
                    if useStart { DatePicker("Start", selection: $start, displayedComponents: .date) }
                    Text("Deadlines belong to this task. Subtask dates stay independent.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Recurrence") {
                    RepeatControls(mode: $repeatMode, selectedDays: $days, monthDay: $monthDay)
                    if repeatMode != .none {
                        Picker("Repeat scope", selection: Binding(get: { task.repeatScope ?? (TaskGraph.children(store.todos, task.id).isEmpty ? "task" : "branch") }, set: { task.repeatScope = $0 })) { Text("This task").tag("task"); Text("Entire branch").tag("branch") }
                        Text("Each completion preserves an occurrence snapshot. A repeating branch resets its subtasks and shifts their dates by the recurrence interval.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let error = store.errorMessage { Section { Text(error).foregroundStyle(.red); if !isNew { Button("Reload latest details", action: reloadLatest) } } }
            }
            .sheet(isPresented: $confirmComplete, onDismiss: {
                completeDescendants = false
                if completionSaved { dismiss() }
            }) {
                TaskCompletionReview(taskId: task.id) {
                    completeDescendants = true
                    completionSaved = save()
                    return completionSaved
                }.environmentObject(store)
            }
            .navigationTitle(isNew ? "New task" : "Task details")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { _ = save() }.disabled(task.contents.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (!estimate.isEmpty && (Double(estimate) ?? -1) < 0)) }
            }
        }
    }
    private var listPicker: some View {
        Picker("List", selection: $projectSelection) { Text("Inbox").tag(""); ForEach(store.todos.customLists.filter { $0.deletedAt == nil }) { Text($0.name).tag($0.id) } }
    }
    private func reloadLatest() {
        guard let latest = TaskGraph.item(store.todos, task.id) else { return }
        original = latest; task = latest; useDue = latest.dueDate != nil; due = TaskGraph.date(latest.dueDate) ?? Date()
        let formatter = DateFormatter(); formatter.dateFormat = "HH:mm"; formatter.locale = Locale(identifier: "en_US_POSIX")
        time = formatter.date(from: latest.dueTime ?? "23:59") ?? TodoListView.defaultDueTimeDate()
        useStart = latest.plannedStart != nil; start = TaskGraph.date(latest.plannedStart) ?? Date()
        repeatMode = RepeatMode(rule: latest.repeat); days = Set(latest.repeat?.days ?? [])
        monthDay = latest.repeat?.day ?? Calendar.current.component(.day, from: due)
        estimate = latest.estimatedMinutes.map { String($0) } ?? ""; parentSelection = latest.parentTaskId ?? ""; projectSelection = latest.listId ?? ""
        completeDescendants = false; store.errorMessage = nil
    }
    @discardableResult private func save() -> Bool {
        var result = task
        result.dueDate = useDue ? TaskGraph.dateKey(due) : nil; result.dueTime = useDue ? TodoListView.timeKey(time) : nil
        if !isNew && result.dueDate == original.dueDate && TodoListView.timeKey(time) == (original.dueTime ?? "23:59") { result.dueTime = original.dueTime }
        result.plannedStart = useStart ? TaskGraph.dateKey(start) : nil; result.estimatedMinutes = Double(estimate)
        result.repeat = repeatMode.rule(days: days, fallbackDay: Calendar.current.component(.weekday, from: due) - 1, monthDay: monthDay)
        if !isNew && repeatMode == RepeatMode(rule: original.repeat) && days == Set(original.repeat?.days ?? []) && (repeatMode != .monthly || monthDay == (original.repeat?.day ?? Calendar.current.component(.day, from: TaskGraph.date(original.dueDate) ?? due))) { result.repeat = original.repeat }
        if isNew { result.parentTaskId = parentSelection.isEmpty ? nil : parentSelection; result.listId = parentSelection.isEmpty && !projectSelection.isEmpty ? projectSelection : nil }
        if !isNew && result.isDone && !original.isDone && !completeDescendants && TaskGraph.descendants(store.todos, result.id).contains(where: { TaskGraph.active(store.todos, $0) }) { completionSaved = false; confirmComplete = true; return false }
        let saved = store.mutateTasks { data in
            if isNew { try TaskGraph.add(&data, task: result) }
            else if let latest = TaskGraph.item(data, result.id) {
                var merged = try TaskGraph.mergeTask(base: original, local: result, remote: latest)
                if latest.isDone && !merged.isDone { TaskGraph.reopen(&data, id: merged.id); merged.completedAt = nil }
                if merged.isDone && !latest.isDone {
                    merged.completed = latest.completed; merged.status = latest.status ?? "todo"
                    try TaskGraph.update(&data, task: merged)
                    try TaskGraph.complete(&data, id: merged.id, cascade: completeDescendants)
                } else { try TaskGraph.update(&data, task: merged) }
            } else { throw TaskGraphError.invalid("This task was removed while editing.") }
        }
        if saved && !confirmComplete { dismiss() }
        return saved
    }
}

enum RepeatMode: String, CaseIterable, Identifiable {
    case none = "None", daily = "Daily", weekly = "Weekly", custom = "Custom", monthly = "Monthly"
    var id: String { rawValue }
    init(rule: RepeatRule?) { switch rule?.type { case "daily": self = .daily; case "weekly": self = .weekly; case "custom": self = .custom; case "monthly": self = .monthly; default: self = .none } }
    func rule(days: Set<Int>, fallbackDay: Int, monthDay: Int) -> RepeatRule? {
        switch self {
        case .none: return nil
        case .daily: return RepeatRule(type: "daily")
        case .weekly: return RepeatRule(type: "weekly", days: days.isEmpty ? [fallbackDay] : days.sorted())
        case .custom: return RepeatRule(type: "custom", days: days.isEmpty ? [fallbackDay] : days.sorted())
        case .monthly: return RepeatRule(type: "monthly", day: monthDay)
        }
    }
}
struct RepeatControls: View {
    @Binding var mode: RepeatMode
    @Binding var selectedDays: Set<Int>
    @Binding var monthDay: Int
    private let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    var body: some View {
        Picker("Repeat", selection: $mode) { ForEach(RepeatMode.allCases) { Text($0.rawValue).tag($0) } }
        if mode == .weekly || mode == .custom {
            HStack { ForEach(names.indices, id: \.self) { day in
                Button(names[day]) {
                    if selectedDays.contains(day) { selectedDays.remove(day) }
                    else { selectedDays.insert(day) }
                }.font(.caption2).buttonStyle(.bordered).tint(selectedDays.contains(day) ? Color.accentColor : Color.gray)
            } }
        }
        if mode == .monthly { Stepper("Day of month: \(monthDay)", value: $monthDay, in: 1...31); Text("Shorter months use their last day.").font(.caption).foregroundStyle(.secondary) }
    }
}
