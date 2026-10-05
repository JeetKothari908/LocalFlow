import Foundation

/// Shared task semantics, independent of SwiftUI, notification APIs, and persistence.
enum TaskGraph {
    static func timestamp(_ date: Date = Date()) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
    static func makeId() -> String { UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
    static func localDay(of timestamp: String?) -> String? {
        guard let timestamp else { return nil }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: timestamp) { return dateKey(parsed) }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: timestamp).map(dateKey)
    }
    static func dateKey(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
    static func date(_ key: String?) -> Date? {
        guard let key else { return nil }
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        f.isLenient = false
        return f.date(from: key)
    }
    static func shift(_ key: String?, days: Int) -> String? {
        guard let source = date(key), let result = Calendar(identifier: .gregorian).date(byAdding: .day, value: days, to: source) else { return key }
        return dateKey(result)
    }
    static func migrate(_ source: TodoData, now: Date = Date()) -> TodoData {
        guard source.schemaVersion < 2 else { return source }
        var result = source
        result.legacyBackup = source.legacyBackup ?? (try? JSONValue(encoding: source))
        let legacyInstances = source.items.filter { $0.parentId != nil && $0.isDone }
        for var item in legacyInstances {
            guard let taskId = item.parentId else { continue }
            let occurrenceId = item.id
            if !result.occurrences.contains(where: { $0.id == occurrenceId }) {
                item.parentId = nil; item.status = "done"; item.completed = true
                let completedAt = item.completedAt ?? item.dueDate.map { "\($0)T12:00:00.000Z" } ?? "1970-01-01T00:00:00.000Z"
                result.occurrences.append(TaskOccurrence(id: occurrenceId, taskId: taskId, completedAt: completedAt, dueDate: item.dueDate, items: [item]))
            }
        }
        let removed = Set(legacyInstances.map(\.id))
        var seen = Set<String>(), orders: [String: Double] = [:]
        result.items = source.items.filter { !removed.contains($0.id) && seen.insert($0.id).inserted }
        let listIds = Set(result.customLists.filter { $0.deletedAt == nil }.map(\.id))
        for index in result.items.indices {
            result.items[index].parentId = nil
            let group = result.items[index].parentTaskId ?? "list:" + (result.items[index].listId ?? "")
            result.items[index].order = result.items[index].order ?? (orders[group] ?? 0)
            orders[group, default: 0] += 1
            result.items[index].status = result.items[index].status ?? (result.items[index].completed ? "done" : "todo")
            result.items[index].completed = result.items[index].status == "done"
            if let rule = result.items[index].repeat, result.items[index].dueDate == nil, !result.items[index].isDone, !result.items[index].isCanceled { result.items[index].dueDate = firstRepeatDate(rule, today: now) }
            if let estimate = result.items[index].estimatedMinutes, !estimate.isFinite || estimate < 0 { result.items[index].estimatedMinutes = nil }
            if result.items[index].parentTaskId != nil || result.items[index].listId.map({ !listIds.contains($0) }) == true { result.items[index].listId = nil }
        }
        let ids = Set(result.items.map(\.id))
        for index in result.items.indices {
            if result.items[index].parentTaskId.map({ !ids.contains($0) }) == true { result.items[index].parentTaskId = nil }
            var path = Set<String>(), current: String? = result.items[index].id
            while let id = current, let cursor = result.items.firstIndex(where: { $0.id == id }) {
                if !path.insert(id).inserted { result.items[cursor].parentTaskId = nil; break }
                current = result.items[cursor].parentTaskId
            }
        }
        result.dependencies.removeAll { !ids.contains($0.prerequisiteTaskId) || !ids.contains($0.dependentTaskId) }
        result.schemaVersion = 2
        return result
    }
    static func item(_ data: TodoData, _ id: String) -> TodoItem? { data.items.first { $0.id == id } }
    static func ancestors(_ data: TodoData, _ id: String) -> [TodoItem] {
        let index = Dictionary(data.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var result: [TodoItem] = [], seen: Set<String> = [id]
        var parent = index[id]?.parentTaskId
        while let current = parent, seen.insert(current).inserted, let task = index[current] {
            result.append(task)
            parent = task.parentTaskId
        }
        return result
    }
    static func path(_ data: TodoData, _ id: String) -> [TodoItem] {
        guard let task = item(data, id) else { return [] }
        return Array(ancestors(data, id).reversed()) + [task]
    }
    static func root(_ data: TodoData, _ id: String) -> TodoItem? { path(data, id).first }
    static func descendants(_ data: TodoData, _ id: String) -> [TodoItem] {
        let groups = Dictionary(grouping: data.items.filter { $0.parentTaskId != nil }, by: { $0.parentTaskId! }).mapValues { tasks in tasks.sorted { ($0.order ?? 0) == ($1.order ?? 0) ? $0.id < $1.id : ($0.order ?? 0) < ($1.order ?? 0) } }
        var result: [TodoItem] = [], stack = Array((groups[id] ?? []).reversed()), seen: Set<String> = [id]
        while let task = stack.popLast() {
            guard seen.insert(task.id).inserted else { continue }
            result.append(task)
            stack.append(contentsOf: (groups[task.id] ?? []).reversed())
        }
        return result
    }
    static func available(_ data: TodoData, _ task: TodoItem) -> Bool {
        ([task] + ancestors(data, task.id)).allSatisfy { $0.deletedAt == nil && $0.archivedAt == nil && $0.dismissed != true && !$0.isCanceled }
    }
    static func active(_ data: TodoData, _ task: TodoItem) -> Bool { available(data, task) && !task.isDone }
    static func children(_ data: TodoData, _ parent: String?, includeUnavailable: Bool = false) -> [TodoItem] {
        data.items.filter { $0.parentTaskId == parent && (includeUnavailable || available(data, $0)) }.sorted {
            if ($0.order ?? 0) != ($1.order ?? 0) { return ($0.order ?? 0) < ($1.order ?? 0) }
            return $0.id < $1.id
        }
    }
    static func dueToday(_ data: TodoData, today: String = dateKey(Date())) -> [TodoItem] {
        data.items.filter { active(data, $0) && ($0.dueDate.map { $0 <= today } ?? false) }.sorted {
            let a = "\($0.dueDate ?? "") \($0.dueTime ?? "23:59")", b = "\($1.dueDate ?? "") \($1.dueTime ?? "23:59")"
            if a != b { return a < b }
            return $0.contents < $1.contents
        }
    }
    static func blockers(_ data: TodoData, _ id: String) -> [TaskBlocker] {
        guard !data.dependencies.isEmpty else { return [] }
        let scope = Set(([id] + ancestors(data, id).map(\.id)))
        return data.dependencies.filter { $0.deletedAt == nil && scope.contains($0.dependentTaskId) }.compactMap { dependency in
            let prerequisite = item(data, dependency.prerequisiteTaskId)
            if let prerequisite, prerequisite.isDone && !prerequisite.isCanceled && prerequisite.deletedAt == nil { return nil }
            return TaskBlocker(dependency: dependency, prerequisite: prerequisite, inheritedFrom: dependency.dependentTaskId == id ? nil : item(data, dependency.dependentTaskId))
        }
    }
    static func progress(_ data: TodoData, _ id: String) -> (completed: Int, total: Int) {
        let branch = descendants(data, id).filter { available(data, $0) }
        let leaves = branch.filter { task in !branch.contains { $0.parentTaskId == task.id } }
        return (leaves.filter(\.isDone).count, leaves.count)
    }
    static func scheduleWarnings(_ data: TodoData, _ id: String) -> [String] {
        guard let task = item(data, id) else { return [] }
        let branch = descendants(data, id).filter { active(data, $0) }
        var warnings: [String] = []
        if task.dueDate != nil {
            let late = branch.filter { $0.dueDate != nil && deadlineKey($0) > deadlineKey(task) }
            if !late.isEmpty { warnings.append("\(late.count) subtasks are due after this task's deadline.") }
            if let ancestor = ancestors(data, id).first(where: { $0.dueDate != nil && deadlineKey(task) > deadlineKey($0) }) { warnings.append("Deadline is after \(ancestor.contents).") }
        }
        let undated = branch.filter { $0.dueDate == nil }.count
        if undated > 0 { warnings.append("\(undated) unfinished subtasks have no deadline.") }
        if let start = task.plannedStart, let due = task.dueDate, start > due { warnings.append("Planned start is after the deadline.") }
        for blocker in blockers(data, id) {
            guard let prerequisite = blocker.prerequisite, prerequisite.dueDate != nil else { continue }
            if task.dueDate != nil && deadlineKey(prerequisite) > deadlineKey(task) { warnings.append("\(prerequisite.contents) is due after this task.") }
            if let start = task.plannedStart, prerequisite.dueDate! > start { warnings.append("\(prerequisite.contents) is due after this task's planned start.") }
        }
        return warnings
    }
    private static func deadlineKey(_ task: TodoItem) -> String { "\(task.dueDate ?? "")T\(task.dueTime ?? "23:59")" }
    static func scheduleShiftWarnings(_ data: TodoData, _ id: String, days: Int) -> [String] {
        let changed = Set(shiftPreview(data, id: id, days: days).map(\.id))
        var shifted = data
        shiftSchedule(&shifted, id: id, days: days)
        return shifted.items.filter { active(shifted, $0) && (changed.contains($0.id) || blockers(shifted, $0.id).contains { changed.contains($0.dependency.prerequisiteTaskId) }) }.flatMap { task in
            scheduleWarnings(shifted, task.id).map { "\(path(shifted, task.id).map(\.contents).joined(separator: " › ")): \($0)" }
        }
    }
    static func readyToComplete(_ data: TodoData, _ id: String) -> Bool {
        guard let task = item(data, id), active(data, task) else { return false }
        let branch = descendants(data, id).filter { available(data, $0) }
        return !branch.isEmpty && branch.allSatisfy(\.isDone) && blockers(data, id).isEmpty
    }
    static func validate(_ data: TodoData) throws {
        let tasks = Dictionary(data.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard tasks.count == data.items.count else { throw TaskGraphError.invalid("Task IDs must be unique.") }
        let lists = Set(data.customLists.filter { $0.deletedAt == nil }.map(\.id))
        var edges: [String: Set<String>] = [:], indegree: [String: Int] = [:], childIds: [String: [String]] = [:]
        func connect(_ from: String, _ to: String) { if edges[from, default: []].insert(to).inserted { indegree[to, default: 0] += 1 } }
        for task in data.items {
            guard (task.status != "done" || task.completed) && (!task.completed || task.status == nil || task.status == "done") else { throw TaskGraphError.invalid("Task state and completion must agree.") }
            if task.parentTaskId != nil && task.listId != nil { throw TaskGraphError.invalid("Subtasks inherit their project's list.") }
            for key in [task.dueDate, task.plannedStart].compactMap({ $0 }) { guard let parsed = date(key), dateKey(parsed) == key else { throw TaskGraphError.invalid("Use dates in YYYY-MM-DD format.") } }
            if let time = task.dueTime { let pieces = time.split(separator: ":"); guard pieces.count == 2, pieces.allSatisfy({ $0.count == 2 }), let hour = Int(pieces[0]), let minute = Int(pieces[1]), (0...23).contains(hour), (0...59).contains(minute) else { throw TaskGraphError.invalid("Use times in HH:mm format.") } }
            if let priority = task.priority, !["low", "normal", "high"].contains(priority) { throw TaskGraphError.invalid("Unknown task priority.") }
            if let status = task.status, !["todo", "inProgress", "done", "canceled"].contains(status) { throw TaskGraphError.invalid("Unknown task state.") }
            if task.parentTaskId == nil, let list = task.listId, !lists.contains(list), task.deletedAt == nil { throw TaskGraphError.invalid("The task's list no longer exists.") }
            if let estimate = task.estimatedMinutes, !estimate.isFinite || estimate < 0 { throw TaskGraphError.invalid("Estimated effort must be a nonnegative number.") }
            if let rule = task.repeat {
                if rule.type == "custom" && (rule.days ?? []).isEmpty { throw TaskGraphError.invalid("Select at least one recurrence weekday.") }
                if let day = rule.day, !(1...31).contains(day) { throw TaskGraphError.invalid("Choose a monthly day between 1 and 31.") }
                if let days = rule.days, (Set(days).count != days.count || days.contains(where: { !(0...6).contains($0) })) { throw TaskGraphError.invalid("Choose unique weekdays between Sunday and Saturday.") }
                guard ["daily", "weekly", "custom", "monthly"].contains(rule.type) else { throw TaskGraphError.invalid("Unknown recurrence rule.") }
            }
            let start = task.id + ":start", done = task.id + ":done"
            indegree[start, default: 0] += 0; indegree[done, default: 0] += 0
            connect(start, done)
            if let parent = task.parentTaskId {
                guard tasks[parent] != nil else { throw TaskGraphError.invalid("A task's parent is missing.") }
                connect(parent + ":start", start); connect(done, parent + ":done")
                childIds[parent, default: []].append(task.id)
            }
        }
        var dependencyIds = Set<String>(), relations = Set<String>()
        for edge in data.dependencies where edge.deletedAt == nil {
            guard dependencyIds.insert(edge.id).inserted, relations.insert(edge.prerequisiteTaskId + ":" + edge.dependentTaskId).inserted else { throw TaskGraphError.invalid("Duplicate task dependency.") }
            guard tasks[edge.prerequisiteTaskId] != nil, tasks[edge.dependentTaskId] != nil else { throw TaskGraphError.invalid("A prerequisite task is missing. Review the dependency.") }
            connect(edge.prerequisiteTaskId + ":done", edge.dependentTaskId + ":start")
        }
        var queue = indegree.filter { $0.value == 0 }.map(\.key), position = 0, visited = 0
        while position < queue.count {
            let id = queue[position]; position += 1; visited += 1
            for next in edges[id] ?? [] { indegree[next, default: 0] -= 1; if indegree[next] == 0 { queue.append(next) } }
        }
        guard visited == indegree.count else { throw TaskGraphError.invalid("This relationship creates a circular dependency or a branch waiting on itself.") }
        var branchQueue = data.items.filter { $0.parentTaskId == nil }.map { ($0.id, false, false, false) }
        position = 0
        while position < branchQueue.count {
            let (id, hidden, closedAbove, deletedAbove) = branchQueue[position]; position += 1
            guard let task = tasks[id] else { continue }
            if deletedAbove && task.deletedAt == nil { throw TaskGraphError.invalid("Restore the deleted ancestors before restoring this task.") }
            let unavailable = hidden || task.deletedAt != nil || task.archivedAt != nil || task.dismissed == true || task.isCanceled
            if !unavailable && closedAbove && !task.isDone { throw TaskGraphError.invalid("A completed task contains unfinished work. Reopen its ancestors.") }
            for child in childIds[id] ?? [] { branchQueue.append((child, unavailable, closedAbove || task.isDone, deletedAbove || task.deletedAt != nil)) }
        }
    }
    static func record(_ data: inout TodoData, taskId: String? = nil, type: String, detail: String? = nil, at: String = timestamp()) {
        data.activity.append(TaskActivity(id: makeId(), taskId: taskId, type: type, at: at, detail: detail))
    }
    static func reopenAncestors(_ data: inout TodoData, _ id: String, at: String = timestamp()) {
        for ancestor in ancestors(data, id) where ancestor.isDone || ancestor.isCanceled {
            guard let index = data.items.firstIndex(where: { $0.id == ancestor.id }) else { continue }
            data.items[index].completed = false
            data.items[index].status = "todo"
            data.items[index].completedAt = nil
            data.items[index].updatedAt = at
            record(&data, taskId: ancestor.id, type: "reopened", detail: "Unfinished work added or reopened below this task", at: at)
        }
    }
    private static func addUnchecked(_ data: inout TodoData, task: TodoItem) throws {
        var task = task
        task.contents = task.contents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.contents.isEmpty else { throw TaskGraphError.invalid("Enter a task name.") }
        let at = timestamp()
        task.order = task.order ?? ((children(data, task.parentTaskId, includeUnavailable: true).map { $0.order ?? 0 }.max() ?? -1) + 1)
        task.createdAt = task.createdAt ?? at
        task.updatedAt = at
        task.status = task.completed ? "done" : (task.status ?? "todo")
        if task.repeat != nil && task.dueDate == nil { task.dueDate = firstRepeatDate(task.repeat!) }
        if let parentId = task.parentTaskId, let parent = item(data, parentId), parent.deletedAt != nil || parent.archivedAt != nil || parent.dismissed == true { throw TaskGraphError.invalid("Restore the parent task before adding subtasks.") }
        if task.parentTaskId != nil { task.listId = nil }
        data.items.append(task)
        if !task.isDone && !task.isCanceled { reopenAncestors(&data, task.id, at: at) }
        if task.status == "inProgress" && !blockers(data, task.id).isEmpty { throw TaskGraphError.invalid("Resolve prerequisites before starting this task.") }
        try validate(data)
        record(&data, taskId: task.id, type: "created", detail: task.contents, at: at)
    }
    private static func updateUnchecked(_ data: inout TodoData, task: TodoItem) throws {
        guard let index = data.items.firstIndex(where: { $0.id == task.id }) else { return }
        var task = task
        task.contents = task.contents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.contents.isEmpty else { throw TaskGraphError.invalid("Enter a task name.") }
        guard task.parentTaskId == data.items[index].parentTaskId else { throw TaskGraphError.invalid("Use Move to change the parent.") }
        let old = data.items[index]
        if task.status == "inProgress" && old.status != "inProgress" && !blockers(data, task.id).isEmpty { throw TaskGraphError.invalid("Resolve prerequisites before starting this task.") }
        if task.isDone && !old.isDone { throw TaskGraphError.invalid("Use the completion action to close this task.") }
        task.updatedAt = timestamp()
        if task.repeat != nil && task.dueDate == nil { task.dueDate = firstRepeatDate(task.repeat!) }
        if task.status == nil { task.status = task.completed ? "done" : "todo" }
        task.completed = task.status == "done"
        data.items[index] = task
        if !task.isDone && !task.isCanceled { reopenAncestors(&data, task.id) }
        try validate(data)
        record(&data, taskId: task.id, type: "updated", detail: old.dueDate != task.dueDate ? "Deadline changed from \(old.dueDate ?? "none") to \(task.dueDate ?? "none")" : "Task details updated")
    }
    private static func moveUnchecked(_ data: inout TodoData, id: String, parent: String?, listId: String? = nil, order: Double? = nil) throws {
        guard let index = data.items.firstIndex(where: { $0.id == id }) else { return }
        if let parent, let parentTask = item(data, parent), parentTask.deletedAt != nil || parentTask.archivedAt != nil || parentTask.dismissed == true { throw TaskGraphError.invalid("Choose an active parent task.") }
        let inheritedList = root(data, id)?.listId
        data.items[index].parentTaskId = parent
        data.items[index].listId = parent == nil ? (listId ?? inheritedList) : nil
        data.items[index].order = order ?? ((children(data, parent, includeUnavailable: true).filter { $0.id != id }.map { $0.order ?? 0 }.max() ?? -1) + 1)
        data.items[index].updatedAt = timestamp()
        if let moved = item(data, id), !moved.isDone && !moved.isCanceled { reopenAncestors(&data, id) }
        try validate(data)
        record(&data, taskId: id, type: "moved", detail: path(data, id).map(\.contents).joined(separator: " › "))
    }
    private static func completeUnchecked(_ data: inout TodoData, id: String, cascade: Bool = false, permanent: Bool = false, now: Date = Date()) throws {
        guard let task = item(data, id) else { throw TaskGraphError.invalid("This task no longer exists.") }
        guard available(data, task) else { throw TaskGraphError.invalid("Restore this task's branch before completing it.") }
        let historicalBranch = descendants(data, id).filter { child in ([child] + ancestors(data, child.id)).allSatisfy { $0.deletedAt == nil && $0.archivedAt == nil && $0.dismissed != true } }
        let branch = descendants(data, id).filter { available(data, $0) }
        if task.repeat != nil && !permanent && task.repeatScope == "task" && !historicalBranch.isEmpty { throw TaskGraphError.invalid("A repeating task with subtasks must repeat its entire branch.") }
        if !cascade && branch.contains(where: { !$0.isDone }) { throw TaskGraphError.unfinishedChildren }
        let ids = Set([id] + (cascade ? branch.filter { !$0.isDone }.map(\.id) : []))
        let unresolved = ids.flatMap { blockers(data, $0) }.filter { !ids.contains($0.dependency.prerequisiteTaskId) }
        guard unresolved.isEmpty else { throw TaskGraphError.invalid("Resolve the unfinished or unavailable prerequisites before completing this task.") }
        let at = timestamp(now)
        for index in data.items.indices where ids.contains(data.items[index].id) && !data.items[index].isDone {
            data.items[index].completed = true
            data.items[index].status = "done"
            data.items[index].completedAt = at
            data.items[index].updatedAt = at
        }
        record(&data, taskId: id, type: "completed", detail: cascade ? "Task and remaining subtasks completed" : nil, at: at)
        if let rule = task.repeat, !permanent {
            let oldDue = task.dueDate ?? firstRepeatDate(rule, today: now)
            guard let old = date(oldDue) else { throw TaskGraphError.invalid("The recurring task needs a valid deadline.") }
            var anchoredRule = rule
            if rule.type == "monthly" && rule.day == nil { anchoredRule.day = Calendar(identifier: .gregorian).component(.day, from: old) }
            if (rule.type == "weekly" || rule.type == "custom") && (rule.days ?? []).isEmpty { anchoredRule.days = [Calendar(identifier: .gregorian).component(.weekday, from: old) - 1] }
            guard let next = nextRepeatDate(anchoredRule, from: max(oldDue ?? dateKey(now), dateKey(now))), let new = date(next) else { throw TaskGraphError.invalid("Choose valid recurrence days.") }
            let delta = Calendar(identifier: .gregorian).dateComponents([.day], from: old, to: new).day ?? 0
            let repeatingIds = Set([id] + (task.repeatScope == "branch" || (task.repeatScope == nil && !historicalBranch.isEmpty) ? branch.map(\.id) : []))
            let snapshotIds = Set([id] + historicalBranch.map(\.id))
            let snapshot = ([item(data, id)].compactMap { $0 } + descendants(data, id)).filter { snapshotIds.contains($0.id) }
            data.occurrences.append(TaskOccurrence(id: makeId(), taskId: id, completedAt: at, dueDate: oldDue, items: snapshot, dependencies: data.dependencies.filter { $0.deletedAt == nil && snapshotIds.contains($0.prerequisiteTaskId) && snapshotIds.contains($0.dependentTaskId) }))
            for index in data.items.indices where repeatingIds.contains(data.items[index].id) {
                data.items[index].completed = false
                data.items[index].status = "todo"
                data.items[index].completedAt = nil
                data.items[index].dismissed = false
                data.items[index].dueDate = data.items[index].id == id ? next : shift(data.items[index].dueDate, days: delta)
                data.items[index].plannedStart = shift(data.items[index].plannedStart, days: delta)
                data.items[index].updatedAt = at
                if data.items[index].id == id && rule.type == "monthly" { data.items[index].repeat?.day = rule.day ?? Calendar(identifier: .gregorian).component(.day, from: old) }
            }
            reopenAncestors(&data, id, at: at)
            record(&data, taskId: id, type: "repeated", detail: "Next occurrence due \(next)", at: at)
        }
    }
    static func reopen(_ data: inout TodoData, id: String) {
        guard let index = data.items.firstIndex(where: { $0.id == id }) else { return }
        data.items[index].completed = false
        data.items[index].status = "todo"
        data.items[index].completedAt = nil
        data.items[index].dismissed = false
        data.items[index].archivedAt = nil
        data.items[index].updatedAt = timestamp()
        reopenAncestors(&data, id)
        record(&data, taskId: id, type: "reopened")
    }
    static func trash(_ data: inout TodoData, id: String) {
        let ids = Set([id] + descendants(data, id).map(\.id)), at = timestamp()
        for index in data.items.indices where ids.contains(data.items[index].id) && data.items[index].deletedAt == nil {
            data.items[index].deletedByTaskId = id
            data.items[index].deletedAt = at
            data.items[index].updatedAt = at
        }
        record(&data, taskId: id, type: "trashed", detail: "Branch moved to recoverable trash", at: at)
    }
    private static func restoreUnchecked(_ data: inout TodoData, id: String) throws {
        guard let task = item(data, id) else { return }
        let descendantsToRestore = descendants(data, id).filter { child in
            if let source = child.deletedByTaskId { return source == task.deletedByTaskId }
            return child.deletedAt == task.deletedAt
        }.map(\.id)
        let detach = ancestors(data, id).contains { $0.deletedAt != nil || $0.archivedAt != nil || $0.dismissed == true }
        let ids = Set([id] + descendantsToRestore), at = timestamp()
        for index in data.items.indices where ids.contains(data.items[index].id) {
            data.items[index].deletedAt = nil; data.items[index].deletedByTaskId = nil
            if data.items[index].id == id && detach { data.items[index].parentTaskId = nil; data.items[index].listId = nil }
            data.items[index].updatedAt = at
        }
        if !task.isDone && !task.isCanceled { reopenAncestors(&data, id, at: at) }
        try validate(data)
        record(&data, taskId: id, type: "restored", at: at)
    }
    static func archive(_ data: inout TodoData, id: String, archived: Bool) {
        let ids = Set([id] + descendants(data, id).map(\.id)), at = timestamp()
        for index in data.items.indices where ids.contains(data.items[index].id) {
            data.items[index].archivedAt = archived ? at : nil
            data.items[index].dismissed = archived
            data.items[index].updatedAt = at
        }
        if !archived {
            let unfinished = data.items.filter { ids.contains($0.id) && !$0.isDone && !$0.isCanceled && $0.deletedAt == nil }
            for task in unfinished { reopenAncestors(&data, task.id, at: at) }
        }
        record(&data, taskId: id, type: archived ? "archived" : "unarchived", at: at)
    }
    private static func addDependencyUnchecked(_ data: inout TodoData, prerequisite: String, dependent: String) throws {
        guard let before = item(data, prerequisite), let after = item(data, dependent) else { throw TaskGraphError.invalid("Choose existing tasks.") }
        guard before.deletedAt == nil && before.archivedAt == nil && before.dismissed != true && after.deletedAt == nil && after.archivedAt == nil && after.dismissed != true else { throw TaskGraphError.invalid("Restore tasks before linking prerequisites.") }
        guard !data.dependencies.contains(where: { $0.deletedAt == nil && $0.prerequisiteTaskId == prerequisite && $0.dependentTaskId == dependent }) else { return }
        data.dependencies.append(TaskDependency(id: makeId(), prerequisiteTaskId: prerequisite, dependentTaskId: dependent, createdAt: timestamp()))
        try validate(data)
        record(&data, taskId: dependent, type: "dependencyAdded", detail: "Blocked by \(item(data, prerequisite)?.contents ?? prerequisite)")
    }
    static func shiftPreview(_ data: TodoData, id: String, days: Int) -> [TaskScheduleShift] {
        ([item(data, id)].compactMap { $0 } + descendants(data, id)).filter { active(data, $0) && ($0.dueDate != nil || $0.plannedStart != nil) }.map {
            TaskScheduleShift(id: $0.id, title: $0.contents, oldDue: $0.dueDate, newDue: shift($0.dueDate, days: days), oldStart: $0.plannedStart, newStart: shift($0.plannedStart, days: days))
        }
    }
    static func shiftSchedule(_ data: inout TodoData, id: String, days: Int) {
        let preview = shiftPreview(data, id: id, days: days), at = timestamp()
        for change in preview {
            guard let index = data.items.firstIndex(where: { $0.id == change.id }) else { continue }
            data.items[index].dueDate = change.newDue
            data.items[index].plannedStart = change.newStart
            data.items[index].updatedAt = at
        }
        record(&data, taskId: id, type: "scheduleShifted", detail: "Shifted \(preview.count) tasks by \(days) days", at: at)
    }
    static func firstRepeatDate(_ rule: RepeatRule, today: Date = Date()) -> String? {
        if rule.type == "daily" { return dateKey(today) }
        if rule.type == "monthly" {
            let calendar = Calendar(identifier: .gregorian), day = min(31, max(1, rule.day ?? calendar.component(.day, from: today)))
            for offset in 0...1 {
                guard let month = calendar.date(byAdding: .month, value: offset, to: today), let range = calendar.range(of: .day, in: .month, for: month) else { continue }
                var parts = calendar.dateComponents([.year, .month], from: month)
                parts.day = min(day, range.count)
                if let candidate = calendar.date(from: parts), dateKey(candidate) >= dateKey(today) { return dateKey(candidate) }
            }
            return nil
        }
        let calendar = Calendar(identifier: .gregorian)
        let configured = rule.days?.filter { (0...6).contains($0) } ?? []
        let days = configured.isEmpty ? [calendar.component(.weekday, from: today) - 1] : configured
        for offset in 0...6 {
            if let candidate = calendar.date(byAdding: .day, value: offset, to: today), days.contains(calendar.component(.weekday, from: candidate) - 1) { return dateKey(candidate) }
        }
        return nil
    }
    static func nextRepeatDate(_ rule: RepeatRule, from due: String?) -> String? {
        let base = date(due) ?? Date(), calendar = Calendar(identifier: .gregorian)
        if rule.type == "monthly" {
            let preferredDay = max(1, min(31, rule.day ?? calendar.component(.day, from: base)))
            for offset in 0...2 {
                guard let month = calendar.date(byAdding: .month, value: offset, to: base), let range = calendar.range(of: .day, in: .month, for: month) else { continue }
                var parts = calendar.dateComponents([.year, .month], from: month)
                parts.day = min(range.count, preferredDay)
                if let candidate = calendar.date(from: parts), dateKey(candidate) > dateKey(base) { return dateKey(candidate) }
            }
            return nil
        }
        guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: base) else { return nil }
        if rule.type == "daily" { return dateKey(tomorrow) }
        let fallback = RepeatRule(type: rule.type, days: (rule.days ?? []).isEmpty ? [calendar.component(.weekday, from: base) - 1] : rule.days)
        return firstRepeatDate(fallback, today: tomorrow)
    }
}

struct TaskBlocker: Identifiable {
    let dependency: TaskDependency
    let prerequisite: TodoItem?
    let inheritedFrom: TodoItem?
    var id: String { dependency.id }
}
struct TaskScheduleShift: Identifiable {
    let id: String
    let title: String
    let oldDue: String?
    let newDue: String?
    let oldStart: String?
    let newStart: String?
}
enum TaskGraphError: LocalizedError {
    case unfinishedChildren
    case invalid(String)
    var errorDescription: String? {
        switch self {
        case .unfinishedChildren: return "This task has unfinished subtasks. Complete the remaining subtasks explicitly before closing it."
        case .invalid(let message): return message
        }
    }
}

extension TaskGraph {
    /// Three-way field merge. Concurrent edits to the same field require explicit review.
    static func merge(base: TodoData, local: TodoData, remote: TodoData) throws -> TodoData {
        if local == remote { return local }
        let result = try mergeValue(base: try JSONValue(encoding: base), local: try JSONValue(encoding: local), remote: try JSONValue(encoding: remote), path: "tasks")
        guard let result else { return local }
        let document = try result.decode(TodoData.self)
        try validate(document)
        return document
    }
    static func mergeTask(base: TodoItem, local: TodoItem, remote: TodoItem) throws -> TodoItem {
        guard let merged = try mergeValue(base: JSONValue(encoding: base), local: JSONValue(encoding: local), remote: JSONValue(encoding: remote), path: "task") else { return local }
        return try merged.decode(TodoItem.self)
    }
    private static func mergeValue(base: JSONValue?, local: JSONValue?, remote: JSONValue?, path: String) throws -> JSONValue? {
        if local == remote { return local }
        if local == base { return remote }
        if remote == base { return local }
        guard let base, let local, let remote else { throw TaskGraphError.invalid("Concurrent creation, removal, or editing at \(path).") }
        if case .object(let original) = base, case .object(let left) = local, case .object(let right) = remote {
            if original["id"] != nil {
                func removed(_ fields: [String: JSONValue]) -> Bool { if case .string(_)? = fields["deletedAt"] { return true }; return false }
                if removed(original) != removed(left) || removed(original) != removed(right) { throw TaskGraphError.invalid("A task was deleted or restored and edited concurrently at \(path).") }
            }
            var result: [String: JSONValue] = [:]
            for key in Set(left.keys).union(right.keys).union(original.keys) {
                if key == "updatedAt", case .string(let a)? = left[key], case .string(let b)? = right[key], let aDate = instant(a), let bDate = instant(b) { result[key] = .string(aDate >= bDate ? a : b) }
                else { result[key] = try mergeValue(base: original[key], local: left[key], remote: right[key], path: "\(path).\(key)") }
            }
            return .object(result)
        }
        if case .array(let original) = base, case .array(let left) = local, case .array(let right) = remote {
            func entries(_ values: [JSONValue]) -> [String: JSONValue]? {
                var result: [String: JSONValue] = [:]
                for value in values {
                    guard case .object(let fields) = value, case .string(let id)? = fields["id"], result[id] == nil else { return nil }
                    result[id] = value
                }
                return result
            }
            if let a = entries(original), let b = entries(left), let c = entries(right) {
                var ids: [String] = [], seen = Set<String>()
                for value in right + left + original {
                    if case .object(let fields) = value, case .string(let id)? = fields["id"], seen.insert(id).inserted { ids.append(id) }
                }
                let values = try ids.compactMap { id in try mergeValue(base: a[id], local: b[id], remote: c[id], path: "\(path)[\(id)]") }
                return .array(values)
            }
        }
        throw TaskGraphError.invalid("Both devices changed \(path). Review the local and synced copies.")
    }
    static func summary(_ data: TodoData, _ id: String, today: String = dateKey(Date())) -> (dueToday: Int, overdue: Int, blocked: Int, unscheduled: Int, next: TodoItem?) {
        let remaining = descendants(data, id).filter { active(data, $0) }
        let branch = ([item(data, id)].compactMap { $0 } + remaining).filter { active(data, $0) }
        let dated = remaining.filter { $0.dueDate != nil }.sorted {
            let left = "\($0.dueDate!) \($0.dueTime ?? "23:59")", right = "\($1.dueDate!) \($1.dueTime ?? "23:59")"
            return left == right ? $0.id < $1.id : left < right
        }
        return (branch.filter { $0.dueDate == today }.count, branch.filter { $0.dueDate.map { $0 < today } ?? false }.count, branch.filter { !blockers(data, $0.id).isEmpty }.count, remaining.filter { $0.dueDate == nil }.count, dated.first)
    }
    struct OutlineRow: Identifiable {
        let task: TodoItem
        let guides: [Bool]
        let isLast: Bool
        var id: String { task.id }
    }
    static func outlineRows(_ data: TodoData, _ id: String, expanded: Set<String>) -> [OutlineRow] {
        func rows(_ parent: String, guides: [Bool]) -> [OutlineRow] {
            let children = children(data, parent)
            return children.enumerated().map { OutlineRow(task: $0.element, guides: guides, isLast: $0.offset == children.count - 1) }
        }
        var stack = Array(rows(id, guides: []).reversed()), result: [OutlineRow] = [], seen: Set<String> = [id]
        while let row = stack.popLast() {
            guard seen.insert(row.id).inserted else { continue }
            result.append(row)
            if expanded.contains(row.id) { stack.append(contentsOf: rows(row.id, guides: row.guides + [!row.isLast]).reversed()) }
        }
        return result
    }
    private static func instant(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: value) { return parsed }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

extension TaskGraph {
    static func criticalPath(_ data: TodoData, _ id: String) -> (minutes: Double, ids: [String])? {
        var scope = Set(([item(data, id)].compactMap { $0 } + descendants(data, id)).filter { active(data, $0) }.map(\.id))
        guard !scope.isEmpty else { return nil }
        var changed = true
        while changed {
            changed = false
            for taskId in Array(scope) {
                for blocker in blockers(data, taskId) {
                    guard let prerequisite = blocker.prerequisite, available(data, prerequisite) else { return nil }
                    for task in [prerequisite] + descendants(data, prerequisite.id) where active(data, task) {
                        if scope.insert(task.id).inserted { changed = true }
                    }
                }
            }
        }
        let leaves = data.items.filter { scope.contains($0.id) && !children(data, $0.id).contains(where: { scope.contains($0.id) }) }
        guard !leaves.isEmpty, leaves.allSatisfy({ $0.estimatedMinutes != nil && ($0.estimatedMinutes ?? -1) >= 0 }) else { return nil }
        let leafIds = Set(leaves.map(\.id))
        var edges: [String: Set<String>] = [:], indegree = Dictionary(uniqueKeysWithValues: leaves.map { ($0.id, 0) })
        for task in leaves {
            for blocker in blockers(data, task.id) {
                let prerequisiteLeaves = Set([blocker.dependency.prerequisiteTaskId] + descendants(data, blocker.dependency.prerequisiteTaskId).map(\.id)).intersection(leafIds)
                for prerequisite in prerequisiteLeaves where prerequisite != task.id {
                    if edges[prerequisite, default: []].insert(task.id).inserted { indegree[task.id, default: 0] += 1 }
                }
            }
        }
        var queue = indegree.filter { $0.value == 0 }.map(\.key), cursor = 0
        var best: [String: (Double, [String])] = [:]
        for leaf in leaves { best[leaf.id] = (leaf.estimatedMinutes ?? 0, [leaf.id]) }
        while cursor < queue.count {
            let current = queue[cursor]; cursor += 1
            for next in edges[current] ?? [] {
                let candidate = (best[current]?.0 ?? 0) + (item(data, next)?.estimatedMinutes ?? 0)
                if candidate > (best[next]?.0 ?? 0) { best[next] = (candidate, (best[current]?.1 ?? []) + [next]) }
                indegree[next, default: 0] -= 1
                if indegree[next] == 0 { queue.append(next) }
            }
        }
        guard cursor == leaves.count else { return nil }
        let selected = Set([id] + descendants(data, id).map(\.id))
        guard let longest = best.filter({ selected.contains($0.key) }).values.max(by: { $0.0 < $1.0 }) else { return nil }
        return (longest.0, longest.1)
    }
}

extension TaskGraph {
    static func add(_ data: inout TodoData, task: TodoItem) throws {
        var draft = data
        try addUnchecked(&draft, task: task)
        try validate(draft)
        data = draft
    }
    static func update(_ data: inout TodoData, task: TodoItem) throws {
        var draft = data
        try updateUnchecked(&draft, task: task)
        try validate(draft)
        data = draft
    }
    static func move(_ data: inout TodoData, id: String, parent: String?, listId: String? = nil, order: Double? = nil) throws {
        var draft = data
        try moveUnchecked(&draft, id: id, parent: parent, listId: listId, order: order)
        try validate(draft)
        data = draft
    }
    static func complete(_ data: inout TodoData, id: String, cascade: Bool = false, permanent: Bool = false, now: Date = Date()) throws {
        var draft = data
        try completeUnchecked(&draft, id: id, cascade: cascade, permanent: permanent, now: now)
        try validate(draft)
        data = draft
    }
    static func restore(_ data: inout TodoData, id: String) throws {
        var draft = data
        try restoreUnchecked(&draft, id: id)
        try validate(draft)
        data = draft
    }
    static func addDependency(_ data: inout TodoData, prerequisite: String, dependent: String) throws {
        var draft = data
        try addDependencyUnchecked(&draft, prerequisite: prerequisite, dependent: dependent)
        try validate(draft)
        data = draft
    }
}

struct TaskDependencyTrace {
    var taskIds: Set<String> = []
    var edgeIds: Set<String> = []
    var unavailableIds: Set<String> = []
}

struct TaskScheduledStep: Identifiable {
    let id: String
    let start: Date
    let finish: Date
    let floatMinutes: Double?
    let critical: Bool
    let lateMinutes: Double
    let summary: Bool
}

struct TaskScheduleAnalysis {
    var rows: [TaskScheduledStep] = []
    var missingEstimateIds: [String] = []
    var missingStartIds: [String] = []
    var unavailableIds: [String] = []
    var targetDeadline: Date?
    var earliestFinish: Date?
    var deadlineMarginMinutes: Double?
    var criticalTaskIds: [String] = []
}

extension TaskGraph {
    static func dependencyTrace(_ data: TodoData, _ id: String) -> TaskDependencyTrace {
        let context = planningContext(data)
        let branch = Set([id] + descendants(data, id).filter { context.active.contains($0.id) }.map(\.id))
        var result = TaskDependencyTrace(taskIds: branch)
        var pending = Array(branch), visited = Set<String>(), position = 0
        while position < pending.count {
            let currentId = pending[position]; position += 1
            guard context.active.contains(currentId), visited.insert(currentId).inserted else { continue }
            let sources = Set([currentId] + ancestors(data, currentId).map(\.id))
            let unresolved = Set(blockers(data, currentId).map { $0.dependency.prerequisiteTaskId })
            for edge in data.dependencies where edge.deletedAt == nil && sources.contains(edge.dependentTaskId) && unresolved.contains(edge.prerequisiteTaskId) {
                result.edgeIds.insert(edge.id); result.taskIds.insert(edge.dependentTaskId); result.taskIds.insert(edge.prerequisiteTaskId)
                guard let prerequisite = item(data, edge.prerequisiteTaskId), context.active.contains(prerequisite.id) else { result.unavailableIds.insert(edge.prerequisiteTaskId); continue }
                for task in [prerequisite] + descendants(data, prerequisite.id) where context.active.contains(task.id) { result.taskIds.insert(task.id); pending.append(task.id) }
            }
        }
        for edge in data.dependencies where edge.deletedAt == nil && branch.contains(edge.prerequisiteTaskId) { result.edgeIds.insert(edge.id); result.taskIds.insert(edge.dependentTaskId) }
        return result
    }

    private static func planningContext(_ data: TodoData) -> (active: Set<String>, starts: [String: Double]) {
        let index = Dictionary(data.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var hidden: [String: Bool] = [:], starts: [String: Double] = [:]
        for task in data.items {
            var path: [TodoItem] = [], current: TodoItem? = task, seen = Set<String>()
            while let cursor = current, hidden[cursor.id] == nil, seen.insert(cursor.id).inserted { path.append(cursor); current = cursor.parentTaskId.flatMap { index[$0] } }
            var unavailable = current.flatMap { hidden[$0.id] } ?? false, planned = current.flatMap { starts[$0.id] } ?? -Double.infinity
            for cursor in path.reversed() {
                unavailable = unavailable || cursor.deletedAt != nil || cursor.archivedAt != nil || cursor.dismissed == true || cursor.isCanceled
                planned = max(planned, date(cursor.plannedStart)?.timeIntervalSince1970 ?? -Double.infinity)
                hidden[cursor.id] = unavailable; starts[cursor.id] = planned
            }
        }
        return (Set(data.items.filter { !$0.isDone && hidden[$0.id] == false }.map(\.id)), starts)
    }

    private static func scheduleDeadline(_ task: TodoItem) -> Date? {
        guard let day = date(task.dueDate) else { return nil }
        let calendar = Calendar(identifier: .gregorian)
        var parts = calendar.dateComponents([.year, .month, .day], from: day)
        let clock = (task.dueTime ?? "23:59").split(separator: ":")
        guard clock.count == 2, let hour = Int(clock[0]), let minute = Int(clock[1]) else { return nil }
        parts.hour = hour; parts.minute = minute
        return calendar.date(from: parts)
    }

    /// Read-only continuous-effort scenario using explicit calendar dates and prerequisites.
    static func analyzeSchedule(_ data: TodoData, _ id: String) -> TaskScheduleAnalysis {
        guard let target = item(data, id) else { return TaskScheduleAnalysis() }
        var result = TaskScheduleAnalysis(targetDeadline: scheduleDeadline(target))
        do { try validate(data) } catch { return result }
        let context = planningContext(data)
        let selected = ([target] + descendants(data, id)).filter { context.active.contains($0.id) }
        var scope = Set(selected.map(\.id)), pending = selected.map(\.id), unavailable = Set<String>(), position = 0
        while position < pending.count {
            let currentId = pending[position]; position += 1
            for blocker in blockers(data, currentId) {
                guard let prerequisite = blocker.prerequisite, context.active.contains(prerequisite.id) else { unavailable.insert(blocker.dependency.prerequisiteTaskId); continue }
                for task in [prerequisite] + descendants(data, prerequisite.id) where context.active.contains(task.id) {
                    if scope.insert(task.id).inserted { pending.append(task.id) }
                }
            }
        }
        result.unavailableIds = unavailable.sorted()
        guard scope.contains(id) else { return result }
        let tasks = data.items.filter { scope.contains($0.id) }, parents = Set(tasks.compactMap(\.parentTaskId))
        let leaves = tasks.filter { !parents.contains($0.id) }
        result.missingEstimateIds = leaves.filter { $0.estimatedMinutes == nil || !($0.estimatedMinutes?.isFinite ?? false) || ($0.estimatedMinutes ?? -1) < 0 }.map(\.id)
        func start(_ id: String) -> String { "start:" + id }
        func finish(_ id: String) -> String { "finish:" + id }
        var outgoing: [String: [String: Double]] = [:], indegree: [String: Int] = [:]
        var earliest: [String: Double] = [:], previous: [String: String] = [:]
        for task in tasks {
            indegree[start(task.id)] = 0; indegree[finish(task.id)] = 0
            earliest[start(task.id)] = context.starts[task.id] ?? -Double.infinity
            earliest[finish(task.id)] = -Double.infinity
        }
        func connect(_ from: String, _ to: String, weight: Double = 0) {
            if outgoing[from]?[to] == nil { outgoing[from, default: [:]][to] = weight; indegree[to, default: 0] += 1 }
        }
        for task in tasks {
            connect(start(task.id), finish(task.id), weight: parents.contains(task.id) ? 0 : (task.estimatedMinutes ?? 0) * 60)
            if let parent = task.parentTaskId, scope.contains(parent) { connect(start(parent), start(task.id)); connect(finish(task.id), finish(parent)) }
            for blocker in blockers(data, task.id) where scope.contains(blocker.dependency.prerequisiteTaskId) { connect(finish(blocker.dependency.prerequisiteTaskId), start(task.id)) }
        }
        var queue = tasks.flatMap { [start($0.id), finish($0.id)] }.filter { indegree[$0] == 0 }, cursor = 0
        while cursor < queue.count {
            let from = queue[cursor]; cursor += 1
            for (to, weight) in outgoing[from] ?? [:] {
                let candidate = earliest[from]! + weight
                let tiedLink = candidate.isFinite && candidate == earliest[to] && (previous[to] == nil || from.hasPrefix("finish:"))
                if candidate > earliest[to]! || tiedLink { earliest[to] = candidate; previous[to] = from }
                indegree[to, default: 0] -= 1
                if indegree[to] == 0 { queue.append(to) }
            }
        }
        result.missingStartIds = leaves.filter { !(earliest[start($0.id)]?.isFinite ?? false) }.map(\.id)
        guard result.missingEstimateIds.isEmpty, result.missingStartIds.isEmpty, unavailable.isEmpty, let end = earliest[finish(id)], end.isFinite else { return result }
        result.earliestFinish = Date(timeIntervalSince1970: end)
        var children: [String: [String]] = [:], displayStarts = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, earliest[start($0.id)]!) })
        for task in tasks { if let parent = task.parentTaskId, scope.contains(parent) { children[parent, default: []].append(task.id) } }
        for node in queue where node.hasPrefix("finish:") {
            let taskId = String(node.dropFirst(7))
            if !(displayStarts[taskId]?.isFinite ?? false) { displayStarts[taskId] = (children[taskId] ?? []).compactMap { displayStarts[$0] }.min() ?? end }
        }
        var latest = Dictionary(uniqueKeysWithValues: queue.map { ($0, Double.infinity) })
        latest[finish(id)] = end
        for from in queue.reversed() {
            for (to, weight) in outgoing[from] ?? [:] { latest[from] = min(latest[from]!, latest[to]! - weight) }
        }
        let hasDeadline = result.targetDeadline != nil
        if let deadline = result.targetDeadline {
            result.deadlineMarginMinutes = (deadline.timeIntervalSince1970 - end) / 60
            var current: String? = finish(id)
            while let node = current {
                if node.hasPrefix("finish:") {
                    let taskId = String(node.dropFirst(7))
                    if previous[node] == start(taskId) && !parents.contains(taskId) { result.criticalTaskIds.append(taskId) }
                }
                current = previous[node]
            }
            result.criticalTaskIds.reverse()
        }
        result.rows = tasks.map { task in
            let end = earliest[finish(task.id)]!, float: Double? = hasDeadline ? max(0, (latest[finish(task.id)]! - end) / 60) : nil
            let late = scheduleDeadline(task).map { max(0, (end - $0.timeIntervalSince1970) / 60) } ?? 0
            return TaskScheduledStep(id: task.id, start: Date(timeIntervalSince1970: displayStarts[task.id]!), finish: Date(timeIntervalSince1970: end), floatMinutes: float, critical: float.map { $0 < 0.00001 } ?? false, lateMinutes: late, summary: parents.contains(task.id))
        }
        return result
    }
}
