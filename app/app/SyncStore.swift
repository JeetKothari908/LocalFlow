import Combine
import Foundation

@MainActor
final class SyncStore: ObservableObject {
    @Published var todos = TodoData()
    @Published var notes = NotesData()
    @Published var plan = PlanData()
    @Published var isSyncing = false
    @Published var status = "Not synced yet"
    @Published var errorMessage: String?
    @Published var canUndoTasks = false
    @Published var todoConflict: TodoSyncConflict?
    @Published var taskToOpen: String?
    @Published var taskMessage: String?
    private var taskUndo: [TodoData] = []
    private var todoDirty = UserDefaults.standard.bool(forKey: "cache.todos.dirty")
    private var baseTodos: TodoData?
    private var baseTodoValue: JSONValue?
    private var todoDocumentUnavailable = false

    @Published var serverURL = UserDefaults.standard.string(forKey: "sync.serverURL") ?? "https://raspberrypi.tail2db278.ts.net" {
        didSet { UserDefaults.standard.set(serverURL, forKey: "sync.serverURL"); if oldValue != serverURL { invalidateTaskBaseline() } }
    }

    @Published var authToken = UserDefaults.standard.string(forKey: "sync.authToken") ?? "jfiweokgerhotrwhtr" {
        didSet { UserDefaults.standard.set(authToken, forKey: "sync.authToken"); if oldValue != authToken { invalidateTaskBaseline() } }
    }

    private let storeName = "tabliss/config"
    private var todoDataKey = "data/default-todo"
    private var notesDataKey = "data/default-notes"
    private var planDataKey = "data/default-plan-of-day"
    private let legacyPlanDataKey = "data/default-plan"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var versions: [String: Int] = [:]
    private let clientId = SyncStore.loadClientId()
    private let syncLock = AsyncLock()
    static let defaultDueTime = "23:59"

    init() {
        let cached = Self.load(TodoData.self, key: "cache.todos") ?? TodoData()
        todos = TaskGraph.migrate(cached)
        baseTodos = Self.load(TodoData.self, key: "cache.todos.base")
        baseTodoValue = Self.load(JSONValue.self, key: "cache.todos.baseValue")
        versions = Self.load([String: Int].self, key: "cache.sync.versions") ?? [:]
        todoConflict = Self.load(TodoSyncConflict.self, key: "cache.todos.conflict")
        if UserDefaults.standard.string(forKey: "cache.todos.scope") != serverURL {
            versions.removeValue(forKey: todoDataKey); baseTodos = nil; baseTodoValue = nil; todoConflict = nil
            todoDirty = !todos.items.isEmpty || !todos.customLists.isEmpty || !todos.occurrences.isEmpty
        }
        taskToOpen = UserDefaults.standard.string(forKey: "todo.pendingTaskId")
        if cached.schemaVersion < 2 { todoDirty = true; Self.save(cached, key: "cache.todos.legacyBackup") }
        notes = Self.load(NotesData.self, key: "cache.notes") ?? NotesData()
        plan = Self.load(PlanData.self, key: "cache.plan") ?? PlanData()
    }

    var activeTodos: [TodoItem] {
        todos.items.filter { TaskGraph.available(todos, $0) }
    }

    var finishedTodos: [TodoItem] {
        todos.items.filter { $0.deletedAt == nil && ($0.isDone || $0.dismissed == true || $0.archivedAt != nil) }
    }

    var liveNotes: [NoteNode] {
        notes.items.filter { $0.deleted != true && $0.type == "note" }
    }

    func refresh() async {
        await syncLock.acquire()
        await performSync {
            let snapshot = try await self.requestSnapshot()
            self.apply(snapshot: snapshot)
            self.status = self.todoConflict == nil ? "Synced \(Date.now.formatted(date: .omitted, time: .shortened))" : "Tasks need conflict review"
        }
        await syncLock.release()
        if todoDirty && todoConflict == nil { Task { await pushTodos() } }
    }

    private func invalidateTaskBaseline() {
        versions.removeValue(forKey: todoDataKey)
        baseTodos = nil; baseTodoValue = nil; todoConflict = nil; todoDocumentUnavailable = false
        taskUndo.removeAll(); canUndoTasks = false
        todoDirty = !todos.items.isEmpty || !todos.customLists.isEmpty
        persist()
    }

    @discardableResult
    func mutateTasks(_ operation: (inout TodoData) throws -> Void) -> Bool {
        var next = todos
        do {
            try operation(&next)
            try TaskGraph.validate(next)
            guard next != todos else { return true }
            taskUndo.append(todos)
            if taskUndo.count > 30 { taskUndo.removeFirst() }
            canUndoTasks = true
            let previous = Dictionary(uniqueKeysWithValues: todos.items.map { ($0.id, $0) })
            let reopened = next.items.filter { !$0.isDone && !$0.isCanceled && previous[$0.id].map { $0.isDone || $0.isCanceled } == true }
            taskMessage = reopened.isEmpty ? nil : "Reopened \(reopened.map(\.contents).joined(separator: ", ")) because unfinished work was restored or added."
            todos = next
            todoDirty = true
            errorMessage = nil
            persist()
            Task { await pushTodos() }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func undoTasks() {
        guard let prior = taskUndo.popLast() else { return }
        // Undo is a new edit, with new timestamps for synchronization.
        var restored = prior
        let at = TaskGraph.timestamp()
        for index in restored.items.indices {
            if todos.items.first(where: { $0.id == restored.items[index].id }) != restored.items[index] { restored.items[index].updatedAt = at }
        }
        // Keep tasks created after the snapshot as tombstones so remote clients cannot resurrect them.
        let priorIds = Set(restored.items.map(\.id))
        for var task in todos.items where !priorIds.contains(task.id) { task.deletedAt = at; task.updatedAt = at; restored.items.append(task) }
        TaskGraph.record(&restored, type: "undo", detail: "Previous task change undone", at: at)
        todos = restored
        taskMessage = "Task change undone."
        canUndoTasks = !taskUndo.isEmpty
        todoDirty = true
        persist()
        Task { await pushTodos() }
    }

    func addTodo(_ contents: String, dueDate: String? = nil, dueTime: String? = nil, repeatRule: RepeatRule? = nil, parentTaskId: String? = nil, listId: String? = nil) {
        _ = mutateTasks { data in
            try TaskGraph.add(&data, task: TodoItem(id: Self.makeId(), contents: contents, dueDate: dueDate, dueTime: dueDate != nil || repeatRule != nil ? (dueTime ?? Self.defaultDueTime) : nil, repeat: repeatRule, listId: listId, parentTaskId: parentTaskId))
        }
    }

    @discardableResult
    func saveTask(_ task: TodoItem, isNew: Bool = false) -> Bool {
        mutateTasks { data in
            if isNew { try TaskGraph.add(&data, task: task) }
            else if let old = TaskGraph.item(data, task.id), old.isDone && !task.isDone {
                TaskGraph.reopen(&data, id: task.id)
                try TaskGraph.update(&data, task: task)
            } else { try TaskGraph.update(&data, task: task) }
        }
    }

    func updateTodo(_ item: TodoItem, contents: String, dueDate: String?, dueTime: String?, repeatRule: RepeatRule?) {
        var updated = TaskGraph.item(todos, item.id) ?? item
        updated.contents = contents
        updated.dueDate = dueDate
        updated.dueTime = dueTime
        updated.repeat = repeatRule
        _ = saveTask(updated)
    }

    func toggleTodo(_ item: TodoItem) {
        if item.isDone { _ = mutateTasks { TaskGraph.reopen(&$0, id: item.id) } }
        else { _ = completeTask(item.id) }
    }

    @discardableResult
    func completeTask(_ id: String, cascade: Bool = false, permanent: Bool = false) -> Bool {
        mutateTasks { try TaskGraph.complete(&$0, id: id, cascade: cascade, permanent: permanent) }
    }

    func dismissTodo(_ item: TodoItem) { archiveTask(item.id, archived: true) }
    func deleteTodo(_ item: TodoItem) { _ = mutateTasks { TaskGraph.trash(&$0, id: item.id) } }
    func restoreTask(_ id: String) { _ = mutateTasks { try TaskGraph.restore(&$0, id: id) } }
    func archiveTask(_ id: String, archived: Bool) { _ = mutateTasks { TaskGraph.archive(&$0, id: id, archived: archived) } }
    @discardableResult
    func moveTask(_ id: String, parent: String?, listId: String? = nil) -> Bool {
        mutateTasks { try TaskGraph.move(&$0, id: id, parent: parent, listId: listId) }
    }
    func indentTask(_ id: String) {
        guard let task = TaskGraph.item(todos, id) else { return }
        let siblings = TaskGraph.children(todos, task.parentTaskId).filter { task.parentTaskId != nil || $0.listId == task.listId }
        guard let index = siblings.firstIndex(where: { $0.id == id }), index > 0 else { return }
        _ = moveTask(id, parent: siblings[index - 1].id)
    }
    func outdentTask(_ id: String) {
        guard let task = TaskGraph.item(todos, id), let parentId = task.parentTaskId, let parent = TaskGraph.item(todos, parentId) else { return }
        _ = moveTask(id, parent: parent.parentTaskId, listId: TaskGraph.root(todos, id)?.listId)
    }
    func reorderTask(_ id: String, offset: Int) {
        guard let task = TaskGraph.item(todos, id) else { return }
        let siblings = TaskGraph.children(todos, task.parentTaskId).filter { task.parentTaskId != nil || $0.listId == task.listId }
        guard let index = siblings.firstIndex(where: { $0.id == id }), siblings.indices.contains(index + offset) else { return }
        reorderTasks(siblings, from: IndexSet(integer: index), to: index + offset + (offset > 0 ? 1 : 0))
    }
    func reorderTasks(_ tasks: [TodoItem], from offsets: IndexSet, to destination: Int) {
        var ordered = tasks
        let moving = offsets.sorted().map { ordered[$0] }
        for index in offsets.sorted(by: >) { ordered.remove(at: index) }
        let insertion = destination - offsets.filter { $0 < destination }.count
        ordered.insert(contentsOf: moving, at: min(ordered.count, max(0, insertion)))
        _ = mutateTasks { data in
            for (position, task) in ordered.enumerated() {
                if let index = data.items.firstIndex(where: { $0.id == task.id }) { data.items[index].order = Double(position); data.items[index].updatedAt = TaskGraph.timestamp() }
            }
            TaskGraph.record(&data, type: "reordered", detail: "Sibling task order changed")
        }
    }
    @discardableResult
    func addDependency(prerequisite: String, dependent: String) -> Bool { mutateTasks { try TaskGraph.addDependency(&$0, prerequisite: prerequisite, dependent: dependent) } }
    func removeDependency(_ edge: TaskDependency) {
        _ = mutateTasks { data in
            data.dependencies.removeAll { $0.id == edge.id }
            TaskGraph.record(&data, taskId: edge.dependentTaskId, type: "dependencyRemoved")
        }
    }
    func shiftSchedule(_ id: String, days: Int) { _ = mutateTasks { TaskGraph.shiftSchedule(&$0, id: id, days: days) } }
    func saveList(id: String? = nil, name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        _ = mutateTasks { data in
            if let id, let index = data.customLists.firstIndex(where: { $0.id == id }) { data.customLists[index].name = name; data.customLists[index].updatedAt = TaskGraph.timestamp() }
            else { data.customLists.append(CustomList(id: Self.makeId(), name: name, updatedAt: TaskGraph.timestamp())) }
            TaskGraph.record(&data, type: "listUpdated", detail: name)
        }
    }
    func deleteList(_ id: String) {
        _ = mutateTasks { data in
            data.customLists.removeAll { $0.id == id }
            for index in data.items.indices where data.items[index].listId == id { data.items[index].listId = nil; data.items[index].updatedAt = TaskGraph.timestamp() }
            TaskGraph.record(&data, type: "listDeleted", detail: "Projects returned to Inbox")
        }
    }

    func addNote(title: String, contents: String) {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedContents = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty || !trimmedContents.isEmpty else { return }
        let id = Self.makeId()
        notes.items.append(
            NoteNode(
                id: id,
                type: "note",
                name: Self.normalizedNoteTitle(title: trimmedTitle, contents: trimmedContents),
                parentId: nil,
                contents: Self.noteContents(title: trimmedTitle, body: contents)
            )
        )
        notes.selectedNoteId = id
        notes.currentFolderId = nil
        persist()
        Task { await pushNotes() }
    }

    func updateNote(_ note: NoteNode, title: String, contents: String) {
        guard let index = notes.items.firstIndex(where: { $0.id == note.id }) else { return }
        let normalizedTitle = Self.normalizedNoteTitle(title: title, contents: contents)
        notes.items[index].name = normalizedTitle
        notes.items[index].contents = Self.noteContents(title: normalizedTitle, body: contents)
        notes.selectedNoteId = note.id
        persist()
        Task { await pushNotes() }
    }

    func deleteNote(_ note: NoteNode) {
        guard let index = notes.items.firstIndex(where: { $0.id == note.id }) else { return }
        notes.items[index].deleted = true
        notes.items[index].deletedAt = ISO8601DateFormatter().string(from: Date())
        if notes.selectedNoteId == note.id {
            notes.selectedNoteId = nil
        }
        persist()
        Task { await pushNotes() }
    }

    func updatePlan(date: String, contents: String) {
        plan.plans[date] = contents
        plan.activeDate = Self.todayKey()
        plan.selectedDate = date
        persist()
        Task { await pushPlan() }
    }

    func pushTodos() async {
        await syncLock.acquire()
        await performSync {
            guard self.todoDirty, self.todoConflict == nil, !self.todoDocumentUnavailable else { return }
            if self.versions[self.todoDataKey] == nil || self.baseTodoValue == nil { self.apply(snapshot: try await self.requestSnapshot()) }
            guard self.todoConflict == nil, !self.todoDocumentUnavailable else { return }
            let submitted = self.todos
            do {
                let response = try await self.post(changes: [RemoteChange(key: self.todoDataKey, value: try JSONValue(encoding: submitted), deleted: false, baseVersion: self.versions[self.todoDataKey] ?? 0, baseValue: self.baseTodoValue, todoSchemaVersion: 2)])
                let savedValue = try response.changes?.first(where: { $0.key == self.todoDataKey })?.value ?? JSONValue(encoding: submitted)
                let saved = try savedValue.decode(TodoData.self)
                if saved != submitted { self.taskUndo.removeAll(); self.canUndoTasks = false }
                if self.todos == submitted { self.todos = saved; self.todoDirty = false }
                else {
                    do { self.todos = try TaskGraph.merge(base: submitted, local: self.todos, remote: saved) }
                    catch {
                        Self.save(self.todos, key: "cache.todos.conflictBackup")
                        self.todoConflict = TodoSyncConflict(local: self.todos, remote: saved, version: response.versions?[self.todoDataKey] ?? 0, remoteValue: savedValue, detail: error.localizedDescription)
                    }
                }
                self.baseTodos = saved
                self.baseTodoValue = savedValue
                if let version = response.versions?[self.todoDataKey] { self.versions[self.todoDataKey] = version }
                self.status = "Tasks saved"
                self.persist()
                if self.todoDirty && self.todoConflict == nil { Task { await self.pushTodos() } }
            } catch SyncError.conflict {
                self.apply(snapshot: try await self.requestSnapshot())
                if self.todoConflict == nil { self.status = "Changes merged; saving"; Task { await self.pushTodos() } }
            }
        }
        await syncLock.release()
    }

    func resolveTodoConflict(useLocal: Bool) {
        guard let conflict = todoConflict else { return }
        Self.save(useLocal ? conflict.remote : todos, key: "cache.todos.conflictBackup")
        baseTodos = conflict.remote
        baseTodoValue = conflict.remoteValue
        let local = todos
        todos = useLocal ? local : conflict.remote
        todoDocumentUnavailable = false
        todoDirty = useLocal || (try? conflict.remoteValue.decode(TodoData.self).schemaVersion) != 2
        taskUndo.removeAll(); canUndoTasks = false
        versions[todoDataKey] = conflict.version
        todoConflict = nil
        persist()
        if todoDirty { Task { await pushTodos() } }
    }

    func recoverTaskBackup() {
        guard let backup = Self.load(TodoData.self, key: "cache.todos.conflictBackup") else { return }
        _ = mutateTasks { data in
            let liveIds = Set(data.items.map(\.id))
            var mapping: [String: String] = [:]
            for task in backup.items { mapping[task.id] = liveIds.contains(task.id) ? Self.makeId() : task.id }
            for var task in backup.items {
                task.id = mapping[task.id]!
                task.parentTaskId = task.parentTaskId.flatMap { mapping[$0] }
                task.deletedByTaskId = task.deletedByTaskId.flatMap { mapping[$0] }
                task.updatedAt = TaskGraph.timestamp()
                data.items.append(task)
            }
            for var edge in backup.dependencies {
                edge.id = Self.makeId()
                edge.prerequisiteTaskId = mapping[edge.prerequisiteTaskId] ?? edge.prerequisiteTaskId
                edge.dependentTaskId = mapping[edge.dependentTaskId] ?? edge.dependentTaskId
                data.dependencies.append(edge)
            }
            for list in backup.customLists where !data.customLists.contains(where: { $0.id == list.id }) { data.customLists.append(list) }
            for occurrence in backup.occurrences where !data.occurrences.contains(where: { $0.id == occurrence.id }) { data.occurrences.append(occurrence) }
            TaskGraph.record(&data, type: "backupRecovered", detail: "Conflict backup restored as separate tasks")
        }
    }

    func pushNotes() async {
        await push(value: notes, key: notesDataKey, label: "Notes saved")
    }

    func pushPlan() async {
        await push(value: plan, key: planDataKey, label: "Plan saved")
    }

    private func push<T: Encodable>(value: T, key: String, label: String) async {
        await syncLock.acquire()
        await performSync {
            let response = try await self.post(
                changes: [
                    RemoteChange(
                        key: key,
                        value: try JSONValue(encoding: value, encoder: self.encoder),
                        deleted: false,
                        baseVersion: self.versions[key]
                    )
                ]
            )
            if let version = response.versions?[key] {
                self.versions[key] = version
            }
            self.status = label
        }
        await syncLock.release()
    }

    private func performSync(_ operation: @escaping () async throws -> Void) async {
        isSyncing = true
        errorMessage = nil
        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
            status = "Sync failed"
        }
        isSyncing = false
    }

    private func requestSnapshot() async throws -> RemoteSnapshot {
        let requestedURL = serverURL, requestedToken = authToken
        var request = URLRequest(url: try endpoint(""))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("no-cache", forHTTPHeaderField: "cache-control")
        applyHeaders(to: &request)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard requestedURL == serverURL && requestedToken == authToken else { throw SyncError.connectionChanged }
        try validate(response: response)
        return try decoder.decode(RemoteSnapshot.self, from: data)
    }

    private func post(changes: [RemoteChange]) async throws -> RemoteWriteResponse {
        let requestedURL = serverURL, requestedToken = authToken
        var request = URLRequest(url: try endpoint("/changes"))
        request.httpMethod = "POST"
        applyHeaders(to: &request)
        request.httpBody = try encoder.encode(RemoteSnapshot(changes: changes, clientId: clientId))
        let (data, response) = try await URLSession.shared.data(for: request)
        guard requestedURL == serverURL && requestedToken == authToken else { throw SyncError.connectionChanged }
        try validate(response: response)
        return try decoder.decode(RemoteWriteResponse.self, from: data)
    }

    private func apply(snapshot: RemoteSnapshot) {
        for change in snapshot.changes {
            if change.key != todoDataKey, let version = change.version { versions[change.key] = version }
        }
        let values = Dictionary(uniqueKeysWithValues: snapshot.changes.compactMap { change -> (String, JSONValue)? in
            guard change.deleted != true, let value = change.value else { return nil }
            return (change.key, value)
        })

        let todoChange = snapshot.changes.first { $0.key == todoDataKey }
        if todoChange?.deleted == true {
            let remote = TodoData()
            if todoDirty {
                Self.save(todos, key: "cache.todos.conflictBackup")
                todoConflict = TodoSyncConflict(local: todos, remote: remote, version: todoChange?.version ?? 0, remoteValue: .null, detail: "The task document was removed on another device. Your local work is preserved.")
            } else { todos = remote }
            baseTodos = remote; baseTodoValue = .null
            if let version = todoChange?.version { versions[todoDataKey] = version }
            taskUndo.removeAll(); canUndoTasks = false; todoDocumentUnavailable = false
        }
        if let value = values[todoDataKey] {
            do {
                let decodedRemote = try value.decode(TodoData.self, decoder: decoder)
                let remote = TaskGraph.migrate(decodedRemote)
                if value != baseTodoValue { taskUndo.removeAll(); canUndoTasks = false }
                guard remote.schemaVersion <= 2 else { throw TaskGraphError.invalid("Update LocalFlow to use this newer task document.") }
                try TaskGraph.validate(remote)
                todoDocumentUnavailable = false
                let versionRegressed = (todoChange?.version ?? 0) < (versions[todoDataKey] ?? 0) && value != baseTodoValue
                if versionRegressed {
                    todoDirty = true
                    Self.save(todos, key: "cache.todos.conflictBackup")
                    todoConflict = TodoSyncConflict(local: todos, remote: remote, version: todoChange?.version ?? 0, remoteValue: value, detail: "The synced task version moved backwards. Review the retained local tasks and the server snapshot.")
                    baseTodos = remote; baseTodoValue = value
                } else if todoDirty {
                    do {
                        if let baseTodos { todos = try TaskGraph.merge(base: baseTodos, local: todos, remote: remote) }
                        else if todos.items.isEmpty && todos.customLists.isEmpty && todos.occurrences.isEmpty { todos = remote; todoDirty = decodedRemote.schemaVersion < 2 }
                        else if (try? todos.legacyBackup?.decode(TodoData.self)) == decodedRemote { /* Safe migration of the same legacy document. */ }
                        else if todos == remote { todoDirty = decodedRemote.schemaVersion < 2 }
                        else { throw TaskGraphError.invalid("The local tasks have no matching sync baseline. Choose which document to retain; both copies are preserved.") }
                        baseTodos = remote
                        baseTodoValue = value
                    } catch {
                        Self.save(todos, key: "cache.todos.conflictBackup")
                        todoConflict = TodoSyncConflict(local: todos, remote: remote, version: todoChange?.version ?? 0, remoteValue: value, detail: error.localizedDescription)
                        baseTodos = remote; baseTodoValue = value
                        errorMessage = "Task changes need review. Both copies are preserved."
                    }
                } else { todos = remote; baseTodos = remote; baseTodoValue = value; todoDirty = decodedRemote.schemaVersion < 2 }
                if let version = todoChange?.version { versions[todoDataKey] = version }
            } catch {
                todoDocumentUnavailable = true
                Self.save(value, key: "cache.todos.incompatibleRemoteBackup")
                errorMessage = error.localizedDescription
            }
        }
        decodeIfPresent(NotesData.self, key: notesDataKey, values: values) { notes = $0 }
        if values[planDataKey] != nil {
            decodeIfPresent(PlanData.self, key: planDataKey, values: values) { plan = $0 }
        } else {
            decodeIfPresent(PlanData.self, key: legacyPlanDataKey, values: values) { plan = $0 }
        }

        if plan.selectedDate == nil {
            plan.selectedDate = Self.todayKey()
        }
        if plan.activeDate == nil {
            plan.activeDate = Self.todayKey()
        }
        persist()
    }

    private func decodeIfPresent<T: Decodable>(_ type: T.Type, key: String, values: [String: JSONValue], assign: (T) -> Void) {
        guard let value = values[key] else { return }
        do {
            assign(try value.decode(type, decoder: decoder))
        } catch {
            errorMessage = "Could not decode \(key): \(error.localizedDescription)"
        }
    }

    private func endpoint(_ suffix: String) throws -> URL {
        let trimmedBase = serverURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let path = storeName.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }.joined(separator: "/")
        guard let url = URL(string: "\(trimmedBase)/v1/stores/\(path)\(suffix)") else {
            throw URLError(.badURL)
        }
        return url
    }

    private func applyHeaders(to request: inout URLRequest) {
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let token = authToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
    }

    private func validate(response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        if http.statusCode == 428 { throw SyncError.schemaUpgrade }
        if http.statusCode == 409 {
            throw SyncError.conflict
        }
        guard 200..<300 ~= http.statusCode else {
            throw URLError(.badServerResponse)
        }
    }

    private static func loadClientId() -> String {
        let key = "sync.clientId"
        if let existing = UserDefaults.standard.string(forKey: key) {
            return existing
        }
        let created = "ios-\(makeId())"
        UserDefaults.standard.set(created, forKey: key)
        return created
    }

    static func makeId() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    static func todayKey() -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    static func firstRepeatDate(_ rule: RepeatRule, today: Date = Date()) -> String? { TaskGraph.firstRepeatDate(rule, today: today) }
    static func nextRepeatDate(_ rule: RepeatRule, from dueDate: String?) -> String? { TaskGraph.nextRepeatDate(rule, from: dueDate) }

    private static func dateKey(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func date(from key: String?) -> Date? {
        guard let key else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: key)
    }

    static func splitNote(_ note: NoteNode) -> (title: String, body: String) {
        let raw = note.contents ?? ""
        if note.name != "Untitled Note" && !raw.hasPrefix(note.name) {
            return (note.name, raw)
        }
        guard let newline = raw.firstIndex(of: "\n") else {
            let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if title.isEmpty || title == note.name {
                return (note.name == "Untitled Note" ? "" : note.name, title.isEmpty ? raw : "")
            }
            return (title, "")
        }
        let title = String(raw[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
        let body = String(raw[raw.index(after: newline)...])
        return (title.isEmpty ? note.name : title, body)
    }

    static func normalizedNoteTitle(title: String, contents: String) -> String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedTitle.isEmpty {
            return trimmedTitle
        }

        let firstLine = contents
            .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return firstLine.isEmpty ? "Untitled Note" : firstLine
    }

    static func noteContents(title: String, body: String) -> String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            return body
        }
        return body.isEmpty ? trimmedTitle : "\(trimmedTitle)\n\(body)"
    }

    private func persist() {
        Self.save(todos, key: "cache.todos")
        Self.save(baseTodos, key: "cache.todos.base")
        Self.save(baseTodoValue, key: "cache.todos.baseValue")
        if let conflict = todoConflict { Self.save(conflict, key: "cache.todos.conflict") }
        else { UserDefaults.standard.removeObject(forKey: "cache.todos.conflict") }
        Self.save(versions, key: "cache.sync.versions")
        UserDefaults.standard.set(serverURL, forKey: "cache.todos.scope")
        UserDefaults.standard.set(todoDirty, forKey: "cache.todos.dirty")
        Self.save(notes, key: "cache.notes")
        Self.save(plan, key: "cache.plan")
    }

    private static func save<T: Encodable>(_ value: T, key: String) {
        if let data = try? JSONEncoder().encode(value) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

private enum SyncError: LocalizedError {
    case conflict
    case schemaUpgrade
    case connectionChanged

    var errorDescription: String? {
        switch self {
        case .conflict:
            return "This data changed on another device. Review the task conflict before saving."
        case .connectionChanged: return "The sync connection changed. Sync again using the current server."
        case .schemaUpgrade:
            return "The server requires a newer task schema. Update LocalFlow before saving."
        }
    }
}

private actor AsyncLock {
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !locked {
            locked = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func release() {
        if waiters.isEmpty {
            locked = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

struct TodoSyncConflict: Codable, Identifiable {
    var id = UUID()
    let local: TodoData
    let remote: TodoData
    let version: Int
    let remoteValue: JSONValue
    let detail: String
}
