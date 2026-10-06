import SwiftUI
import UserNotifications

struct NotificationSettingsView: View {
    @EnvironmentObject private var store: SyncStore
    @EnvironmentObject private var notificationStore: TodoNotificationStore
    @State private var editingGroup: TodoNotificationGroup?

    var body: some View {
        List {
            Section("Permission") {
                HStack {
                    Text("Status")
                    Spacer()
                    Text(permissionText)
                        .foregroundStyle(LocalFlowTheme.muted)
                }

                Button {
                    Task { await notificationStore.requestPermission() }
                } label: {
                    Label("Request Permission", systemImage: "bell.badge")
                }

                HStack {
                    Text("Pending")
                    Spacer()
                    Text("\(notificationStore.pendingCount)")
                        .foregroundStyle(LocalFlowTheme.muted)
                }
            }.listRowBackground(LocalFlowTheme.surface)
            .listRowInsets(EdgeInsets(top: LocalFlowTheme.rowPadding, leading: LocalFlowTheme.rowInset, bottom: LocalFlowTheme.rowPadding, trailing: LocalFlowTheme.rowInset))

            Section {
                Button {
                    Task { await notificationStore.scheduleAll(todos: store.todos.items) }
                } label: {
                    Label("Schedule Enabled Groups", systemImage: "calendar.badge.clock")
                }

                Button(role: .destructive) {
                    Task { await notificationStore.cancelAll() }
                } label: {
                    Label("Cancel Todo Notifications", systemImage: "bell.slash")
                }
            }.listRowBackground(LocalFlowTheme.surface)
            .listRowInsets(EdgeInsets(top: LocalFlowTheme.rowPadding, leading: LocalFlowTheme.rowInset, bottom: LocalFlowTheme.rowPadding, trailing: LocalFlowTheme.rowInset))

            Section("Groups") {
                ForEach(notificationStore.groups) { group in
                    Button {
                        editingGroup = group
                    } label: {
                        NotificationGroupRow(
                            group: group,
                            matches: notificationStore.matchingTodos(for: group, todos: store.todos.items)
                        )
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            notificationStore.deleteGroup(group)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }

                        Button {
                            notificationStore.duplicateGroup(group)
                        } label: {
                            Label("Duplicate", systemImage: "doc.on.doc")
                        }
                        .tint(.accentColor)
                    }
                }

                Button {
                    notificationStore.addGroup()
                } label: {
                    Label("Add Group", systemImage: "plus")
                }
            }.listRowBackground(LocalFlowTheme.surface)
            .listRowInsets(EdgeInsets(top: LocalFlowTheme.rowPadding, leading: LocalFlowTheme.rowInset, bottom: LocalFlowTheme.rowPadding, trailing: LocalFlowTheme.rowInset))

            Section("Status") {
                Text(notificationStore.status)
                    .foregroundStyle(LocalFlowTheme.muted)
                if let errorMessage = notificationStore.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }.listRowBackground(LocalFlowTheme.surface)
            .listRowInsets(EdgeInsets(top: LocalFlowTheme.rowPadding, leading: LocalFlowTheme.rowInset, bottom: LocalFlowTheme.rowPadding, trailing: LocalFlowTheme.rowInset))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(LocalFlowTheme.background)
        .foregroundStyle(LocalFlowTheme.text)
        .font(.body)
        .environment(\.defaultMinListRowHeight, LocalFlowTheme.minimumTarget)
        .listRowSpacing(LocalFlowTheme.rowPadding)
        .navigationTitle("Notifications")
        .toolbar {
            SyncToolbar()
        }
        .task {
            await notificationStore.refreshStatus()
        }
        .sheet(item: $editingGroup) { group in
            NotificationGroupEditorView(
                group: group,
                allTodos: store.todos.items,
                onSave: { next in
                    notificationStore.updateGroup(next)
                },
                onSchedule: { next in
                    notificationStore.updateGroup(next)
                    Task { await notificationStore.schedule(group: next, todos: store.todos.items) }
                },
                onTest: { next in
                    notificationStore.updateGroup(next)
                    Task { await notificationStore.sendTest(group: next, todos: store.todos.items) }
                }
            )
        }
    }

    private var permissionText: String {
        switch notificationStore.authorizationStatus {
        case .authorized:
            return "Allowed"
        case .denied:
            return "Denied"
        case .notDetermined:
            return "Not Asked"
        case .provisional:
            return "Provisional"
        case .ephemeral:
            return "Ephemeral"
        @unknown default:
            return "Unknown"
        }
    }
}

private struct NotificationGroupRow: View {
    let group: TodoNotificationGroup
    let matches: [TodoItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(group.name)
                    .font(.headline)
                Spacer()
                Text(group.enabled ? "On" : "Off")
                    .font(.caption)
                    .foregroundStyle(group.enabled ? .green : .secondary)
            }

            Text("\(group.filter.rawValue) • \(matches.count) match\(matches.count == 1 ? "" : "es")")
                .font(.caption)
                .foregroundStyle(LocalFlowTheme.muted)

            Text(scheduleSummary)
                .font(.caption2)
                .foregroundStyle(LocalFlowTheme.muted)
        }
        .foregroundStyle(.primary)
    }

    private var scheduleSummary: String {
        if group.useDueTimeReminders {
            let offsets = group.dueReminderOffsetsMinutes
                .sorted()
                .map(Self.offsetString)
                .joined(separator: ", ")
            return "\(offsets.isEmpty ? "No offsets" : offsets) / before due / max \(group.maxNotifications)"
        }

        let times = group.deliveryMinutes
            .sorted()
            .map(Self.timeString)
            .joined(separator: ", ")
        let style = group.oneNotificationPerTask ? "per task" : "summary"
        return "\(times.isEmpty ? "No times" : times) • \(style) • max \(group.maxNotifications)"
    }

    private static func timeString(_ minutes: Int) -> String {
        let hour = minutes / 60
        let minute = minutes % 60
        return String(format: "%02d:%02d", hour, minute)
    }

    private static func offsetString(_ minutes: Int) -> String {
        if minutes == 0 { return "At due time" }
        if minutes < 60 { return "\(minutes)m before" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder == 0 ? "\(hours)h before" : "\(hours)h \(remainder)m before"
    }
}

private struct NotificationGroupEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var group: TodoNotificationGroup
    let allTodos: [TodoItem]
    let onSave: (TodoNotificationGroup) -> Void
    let onSchedule: (TodoNotificationGroup) -> Void
    let onTest: (TodoNotificationGroup) -> Void

    init(
        group: TodoNotificationGroup,
        allTodos: [TodoItem],
        onSave: @escaping (TodoNotificationGroup) -> Void,
        onSchedule: @escaping (TodoNotificationGroup) -> Void,
        onTest: @escaping (TodoNotificationGroup) -> Void
    ) {
        _group = State(initialValue: group)
        self.allTodos = allTodos
        self.onSave = onSave
        self.onSchedule = onSchedule
        self.onTest = onTest
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Group") {
                    TextField("Name", text: $group.name)
                    Toggle("Enabled", isOn: $group.enabled)
                    TextField("Notification Title Prefix", text: $group.titlePrefix)
                }

                Section("Matching") {
                    Picker("Type", selection: $group.filter) {
                        ForEach(TodoNotificationFilter.allCases) { filter in
                            Text(filter.rawValue).tag(filter)
                        }
                    }

                    if group.filter == .dueWithinDays {
                        Stepper("Within \(group.dueWithinDays) day\(group.dueWithinDays == 1 ? "" : "s")", value: $group.dueWithinDays, in: 1...30)
                    }

                    if group.filter == .specific {
                        SpecificTodoPicker(
                            todos: allTodos,
                            selectedIds: $group.specificTodoIds
                        )
                    }

                    Toggle("Include Completed", isOn: $group.includeCompleted)
                    Toggle("Include Dismissed", isOn: $group.includeDismissed)
                    Stepper("Max Tasks In Body: \(group.maxTasks)", value: $group.maxTasks, in: 1...25)
                }

                Section("Delivery") {
                    Toggle("Before Due Time", isOn: $group.useDueTimeReminders)

                    if !group.useDueTimeReminders {
                        Toggle("One Notification Per Task", isOn: $group.oneNotificationPerTask)
                    }
                    Stepper("Max Notifications: \(group.maxNotifications)", value: $group.maxNotifications, in: 1...64)
                    if group.oneNotificationPerTask && !group.useDueTimeReminders {
                        Stepper("Spacing: \(group.minuteSpacing) min", value: $group.minuteSpacing, in: 1...60)
                    }
                    if !group.useDueTimeReminders {
                        Toggle("Repeat Daily", isOn: $group.repeatsDaily)
                    }
                    Picker("Body Style", selection: $group.bodyStyle) {
                        ForEach(NotificationBodyStyle.allCases) { style in
                            Text(style.rawValue).tag(style)
                        }
                    }
                }

                if group.useDueTimeReminders {
                    Section("Due Time Offsets") {
                        ForEach(group.dueReminderOffsetsMinutes.indices, id: \.self) { index in
                            Stepper(
                                Self.offsetLabel(group.dueReminderOffsetsMinutes[index]),
                                value: $group.dueReminderOffsetsMinutes[index],
                                in: 0...10080,
                                step: 15
                            )
                        }

                        Button {
                            group.dueReminderOffsetsMinutes.append(60)
                            group.dueReminderOffsetsMinutes.sort()
                        } label: {
                            Label("Add Offset", systemImage: "plus")
                        }

                        if group.dueReminderOffsetsMinutes.count > 1 {
                            Button(role: .destructive) {
                                group.dueReminderOffsetsMinutes.removeLast()
                            } label: {
                                Label("Remove Last Offset", systemImage: "minus.circle")
                            }
                        }
                    }
                } else {
                Section("Times") {
                    ForEach(group.deliveryMinutes.indices, id: \.self) { index in
                        HStack {
                            DatePicker(
                                "Time \(index + 1)",
                                selection: Binding(
                                    get: { Self.date(fromMinutes: group.deliveryMinutes[index]) },
                                    set: { group.deliveryMinutes[index] = Self.minutes(from: $0) }
                                ),
                                displayedComponents: .hourAndMinute
                            )
                            Button(role: .destructive) {
                                group.deliveryMinutes.remove(at: index)
                            } label: {
                                Image(systemName: "minus.circle")
                            }
                            .buttonStyle(.borderless)
                        }
                    }

                    Button {
                        group.deliveryMinutes.append(9 * 60)
                        group.deliveryMinutes.sort()
                    } label: {
                        Label("Add Time", systemImage: "plus")
                    }
                }
                }

                Section("Preview") {
                    let previewTodos = TodoNotificationStore.matchingTodos(for: group, todos: allTodos)
                    let capped = Array(previewTodos.prefix(group.maxTasks))
                    if capped.isEmpty {
                        Text("No todos match this group right now.")
                            .foregroundStyle(LocalFlowTheme.muted)
                    } else {
                        ForEach(capped) { todo in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(todo.contents)
                                if let dueDate = Self.displayDue(todo) {
                                    Text(dueDate)
                                        .font(.caption)
                                        .foregroundStyle(LocalFlowTheme.muted)
                                }
                            }
                        }
                    }
                }

                Section {
                    Button {
                        onTest(group)
                    } label: {
                        Label("Send Test In 5 Seconds", systemImage: "paperplane")
                    }

                    Button {
                        onSchedule(group)
                        dismiss()
                    } label: {
                        Label("Schedule This Group", systemImage: "calendar.badge.plus")
                    }
                }
            }
            .navigationTitle("Notification Group")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(group)
                        dismiss()
                    }
                    .disabled(group.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private static func date(fromMinutes minutes: Int) -> Date {
        var components = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        components.hour = minutes / 60
        components.minute = minutes % 60
        return Calendar.current.date(from: components) ?? Date()
    }

    private static func minutes(from date: Date) -> Int {
        let components = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (components.hour ?? 0) * 60 + (components.minute ?? 0)
    }

    private static func offsetLabel(_ minutes: Int) -> String {
        if minutes == 0 { return "At due time" }
        if minutes < 60 { return "\(minutes) min before due" }
        let hours = minutes / 60
        let remainder = minutes % 60
        if remainder == 0 {
            return "\(hours) hour\(hours == 1 ? "" : "s") before due"
        }
        return "\(hours)h \(remainder)m before due"
    }

    private static func displayDue(_ todo: TodoItem) -> String? {
        guard let dueDate = todo.dueDate else { return todo.dueTime }
        return "\(dueDate) \(todo.dueTime ?? SyncStore.defaultDueTime)"
    }
}

private struct SpecificTodoPicker: View {
    let todos: [TodoItem]
    @Binding var selectedIds: [String]

    private var sortedTodos: [TodoItem] {
        todos
            .filter { !$0.completed && $0.dismissed != true }
            .sorted { lhs, rhs in
                let leftDate = lhs.dueDate ?? "9999-99-99"
                let rightDate = rhs.dueDate ?? "9999-99-99"
                let leftTime = lhs.dueTime ?? SyncStore.defaultDueTime
                let rightTime = rhs.dueTime ?? SyncStore.defaultDueTime
                if leftDate != rightDate {
                    return leftDate < rightDate
                }
                if leftTime != rightTime {
                    return leftTime < rightTime
                }
                return lhs.contents < rhs.contents
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Specific Todos")
                    .font(.subheadline)
                    .foregroundStyle(LocalFlowTheme.muted)
                Spacer()
                Text("\(selectedIds.count) selected")
                    .font(.caption)
                    .foregroundStyle(LocalFlowTheme.muted)
            }

            if sortedTodos.isEmpty {
                Text("No synced todos available.")
                    .font(.caption)
                    .foregroundStyle(LocalFlowTheme.muted)
            } else {
                ForEach(sortedTodos) { todo in
                    Button {
                        toggle(todo.id)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: selectedIds.contains(todo.id) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(selectedIds.contains(todo.id) ? Color.accentColor : Color.gray)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(todo.contents)
                                    .foregroundStyle(.primary)
                                if let dueDate = displayDue(todo) {
                                    Text(dueDate)
                                        .font(.caption2)
                                        .foregroundStyle(LocalFlowTheme.muted)
                                }
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func toggle(_ id: String) {
        if selectedIds.contains(id) {
            selectedIds.removeAll { $0 == id }
        } else {
            selectedIds.append(id)
        }
    }

    private func displayDue(_ todo: TodoItem) -> String? {
        guard let dueDate = todo.dueDate else { return todo.dueTime }
        return "\(dueDate) \(todo.dueTime ?? SyncStore.defaultDueTime)"
    }
}

#Preview {
    NavigationStack {
        NotificationSettingsView()
            .environmentObject(SyncStore())
            .environmentObject(TodoNotificationStore())
    }
}
