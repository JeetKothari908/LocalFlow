import Combine
import Foundation
import CryptoKit

@MainActor
final class SyncStore: ObservableObject {
    @Published var todos = TodoData()
    @Published var notes = NotesData()
    @Published var plan = PlanData()
    @Published var isSyncing = false
    @Published var status = "Not synced yet"
    @Published var errorMessage: String?
    @Published private(set) var documentEpoch = 0
    private var documentDirty: [String: Bool] = [:]
    private var documentBases: [String: JSONValue] = [:]
    private var documentConflicts: [String: MobileConflict] = [:]
    private var localRevisions: [String: Int] = [:]
    private var commitReceipts: [String: MobileReceipt] = [:]
    private var receiptOrder: [String] = []
    private var preservedDrafts: [String: JSONValue] = [:]
    private var documentBackups: [String: JSONValue] = [:]
    private var editorDrafts: [String: JSONValue] = [:]
    private var legacyCaching = true
    private var syncedTimeZone: String?
    private var lastDocuments: [String: JSONValue] = [:]
    private var storageURL = MobileCache.defaultURL
    private var localStorageBlocked = false
    private var persistenceError: String?
    private var networkEnabled = true
    @Published var canUndoTasks = false
    @Published var todoConflict: TodoSyncConflict?
    @Published var taskToOpen: String?
    @Published var taskMessage: String?
    private var taskUndo: [TodoData] = []
    private var todoDirty = UserDefaults.standard.bool(forKey: "cache.todos.dirty")
    private var baseTodos: TodoData?
    private var baseTodoValue: JSONValue?
    private var todoDocumentUnavailable = false

    @Published var serverURL = UserDefaults.standard.string(forKey: "sync.serverURL") ?? "" {
        didSet { if legacyCaching { UserDefaults.standard.set(serverURL, forKey: "sync.serverURL") }; if oldValue != serverURL { invalidateTaskBaseline() } }
    }

    @Published var authToken = UserDefaults.standard.string(forKey: "sync.authToken") ?? "" {
        didSet { if legacyCaching { UserDefaults.standard.set(authToken, forKey: "sync.authToken") }; if oldValue != authToken { invalidateTaskBaseline() } }
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
    private let transport: (URLRequest) async throws -> (Data, URLResponse)
    static let defaultDueTime = "23:59"

    init(storageURL: URL? = nil, loadLegacy: Bool = true, syncEnabled: Bool = true, legacyDefaults: UserDefaults? = nil, transport: @escaping (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }) {
        self.transport = transport
        self.storageURL = storageURL ?? MobileCache.defaultURL
        self.networkEnabled = syncEnabled
        self.legacyCaching = loadLegacy && legacyDefaults == nil
        if !loadLegacy {
            do {
                if let cache = try MobileCache.read(from: self.storageURL) { install(cache) }
                lastDocuments = try currentDocuments()
            } catch { localStorageBlocked = true; persistenceError = error.localizedDescription }
            return
        }
        let migrationDefaults = legacyDefaults ?? .standard
        if let legacyDefaults {
            serverURL = legacyDefaults.string(forKey: "sync.serverURL") ?? ""
            authToken = legacyDefaults.string(forKey: "sync.authToken") ?? ""
            todoDirty = legacyDefaults.bool(forKey: "cache.todos.dirty")
        }
        let cached = Self.load(TodoData.self, key: "cache.todos", defaults: migrationDefaults) ?? TodoData()
        todos = TaskGraph.migrate(cached)
        baseTodos = Self.load(TodoData.self, key: "cache.todos.base", defaults: migrationDefaults)
        baseTodoValue = Self.load(JSONValue.self, key: "cache.todos.baseValue", defaults: migrationDefaults)
        versions = Self.load([String: Int].self, key: "cache.sync.versions", defaults: migrationDefaults) ?? [:]
        todoConflict = Self.load(TodoSyncConflict.self, key: "cache.todos.conflict", defaults: migrationDefaults)
        if migrationDefaults.string(forKey: "cache.todos.scope") != serverURL {
            versions.removeValue(forKey: todoDataKey); baseTodos = nil; baseTodoValue = nil; todoConflict = nil
            todoDirty = !todos.items.isEmpty || !todos.customLists.isEmpty || !todos.occurrences.isEmpty
        }
        taskToOpen = migrationDefaults.string(forKey: "todo.pendingTaskId")
        if cached.schemaVersion < 2 { todoDirty = true; migrationDefaults.set(try? JSONEncoder().encode(cached), forKey: "cache.todos.legacyBackup") }
        notes = Self.load(NotesData.self, key: "cache.notes", defaults: migrationDefaults) ?? NotesData()
        plan = Self.load(PlanData.self, key: "cache.plan", defaults: migrationDefaults) ?? PlanData()
        do {
            if let cache = try MobileCache.read(from: self.storageURL) {
                install(cache)
                if cache.serverScope != serverURL { invalidateTaskBaseline() }
            } else {
                // A legacy cache may contain offline changes. Without a baseline,
                // preserve it for review instead of letting the first refresh replace it.
                documentDirty["notes"] = !notes.items.isEmpty
                documentDirty["plan"] = !plan.plans.isEmpty
            }
            lastDocuments = try currentDocuments()
        } catch {
            localStorageBlocked = true
            persistenceError = "Local data could not be opened: \(error.localizedDescription)"
            errorMessage = persistenceError
        }
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
        guard persistenceError == nil else { errorMessage = persistenceError; return }
        guard networkEnabled, !localStorageBlocked, !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { status = "Saved on this device"; return }
        await syncLock.acquire()
        await performSync {
            let snapshot = try await self.requestSnapshot()
            self.apply(snapshot: snapshot)
            self.status = self.todoConflict == nil ? "Synced \(Date.now.formatted(date: .omitted, time: .shortened))" : "Tasks need conflict review"
        }
        await syncLock.release()
        if todoDirty && todoConflict == nil { Task { await pushTodos() } }
        if documentDirty["notes"] == true { Task { await pushNotes() } }
        if documentDirty["plan"] == true { Task { await pushPlan() } }
    }

    private func invalidateTaskBaseline() {
        versions.removeAll()
        documentBases.removeAll(); documentConflicts.removeAll()
        documentDirty["notes"] = !notes.items.isEmpty; documentDirty["plan"] = !plan.plans.isEmpty
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
        documentDirty["notes"] = true
        persist()
        Task { await pushNotes() }
    }

    func updateNote(_ note: NoteNode, title: String, contents: String) {
        guard let index = notes.items.firstIndex(where: { $0.id == note.id }) else { return }
        let normalizedTitle = Self.normalizedNoteTitle(title: title, contents: contents)
        notes.items[index].name = normalizedTitle
        notes.items[index].contents = Self.noteContents(title: normalizedTitle, body: contents)
        notes.selectedNoteId = note.id
        documentDirty["notes"] = true
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
        documentDirty["notes"] = true
        persist()
        Task { await pushNotes() }
    }

    func updatePlan(date: String, contents: String) {
        plan.plans[date] = contents
        plan.activeDate = Self.planningDayKey()
        plan.selectedDate = date
        documentDirty["plan"] = true
        persist()
        Task { await pushPlan() }
    }

    func pushTodos() async {
        guard networkEnabled, !localStorageBlocked, persistenceError == nil, !serverURL.isEmpty else { return }
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
        let previous = cacheState()
        let backup = useLocal ? conflict.remote : todos
        documentBackups["tasks"] = try? JSONValue(encoding: backup)
        baseTodos = conflict.remote
        baseTodoValue = conflict.remoteValue
        let local = todos
        todos = useLocal ? local : conflict.remote
        todoDocumentUnavailable = false
        todoDirty = useLocal || (try? conflict.remoteValue.decode(TodoData.self).schemaVersion) != 2
        taskUndo.removeAll(); canUndoTasks = false
        versions[todoDataKey] = conflict.version
        todoConflict = nil
        guard persist() else { install(previous); return }
        if legacyCaching { Self.save(backup, key: "cache.todos.conflictBackup") }
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

    func pushNotes() async { await pushDocument(.notes) }
    func pushPlan() async { await pushDocument(.plan) }

    private func pushDocument(_ key: MobileDocumentKey) async {
        guard networkEnabled, !localStorageBlocked, persistenceError == nil, !serverURL.isEmpty else { return }
        await syncLock.acquire()
        await performSync {
            guard self.documentDirty[key.rawValue] == true, self.documentConflicts[key.rawValue] == nil else { return }
            if self.versions[key.serverKey] == nil { self.apply(snapshot: try await self.requestSnapshot()) }
            guard self.documentDirty[key.rawValue] == true, self.documentConflicts[key.rawValue] == nil else { return }
            let submitted = try self.currentDocuments()[key.rawValue]!
            do {
                let response = try await self.post(changes: [RemoteChange(key: key.serverKey, value: submitted, baseVersion: self.versions[key.serverKey] ?? 0)])
                self.documentBases[key.rawValue] = submitted
                self.versions[key.serverKey] = response.versions?[key.serverKey] ?? self.versions[key.serverKey]
                self.documentDirty[key.rawValue] = try self.currentDocuments()[key.rawValue] != submitted
                self.status = self.documentDirty[key.rawValue] == true ? "Saved locally; syncing" : "Synced"
                self.persist()
                if self.documentDirty[key.rawValue] == true { Task { await self.pushDocument(key) } }
            } catch SyncError.conflict {
                self.apply(snapshot: try await self.requestSnapshot())
                if self.documentConflicts[key.rawValue] == nil { Task { await self.pushDocument(key) } }
            }
        }
        await syncLock.release()
    }

    private func applyDocument(_ key: MobileDocumentKey, change: RemoteChange?) {
        let name = key.rawValue
        do {
            let empty: JSONValue = try key == .notes ? JSONValue(encoding: NotesData()) : JSONValue(encoding: PlanData())
            let remote = change?.deleted == true ? empty : (change?.value ?? empty)
            let local = try currentDocuments()[name]!
            let version = change?.version ?? 0
            if let previous = versions[key.serverKey], version < previous && remote != documentBases[name] {
                throw MobileDocumentError.invalid("The server version moved backwards. Review both copies.")
            }
            if documentDirty[name] == true {
                let merged: JSONValue
                if local == remote { merged = local }
                else if change == nil && documentBases[name] == nil { merged = local }
                else if let base = documentBases[name] { merged = try MobileDocumentMerge.merge(base: base, local: local, remote: remote) ?? empty }
                else { throw MobileDocumentError.invalid("Local changes have no matching sync baseline. Both copies are preserved.") }
                try assignDocument(key, value: merged)
                documentDirty[name] = merged != remote
            } else { try assignDocument(key, value: remote) }
            documentBases[name] = remote
            versions[key.serverKey] = version
            documentConflicts.removeValue(forKey: name)
        } catch {
            let remote = change?.value ?? .null
            documentConflicts[name] = MobileConflict(key: name, detail: error.localizedDescription, local: (try? currentDocuments()[name]) ?? .null, remote: remote, version: change?.version ?? 0)
            errorMessage = "\(name.capitalized) changes need review. Both copies are preserved."
        }
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
        let (data, response) = try await transport(request)
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
        let (data, response) = try await transport(request)
        guard requestedURL == serverURL && requestedToken == authToken else { throw SyncError.connectionChanged }
        try validate(response: response)
        return try decoder.decode(RemoteWriteResponse.self, from: data)
    }

    private func apply(snapshot: RemoteSnapshot) {
        let previous = cacheState()
        if let setting = snapshot.changes.first(where: { $0.key == "timeZone" }) {
            if case .string(let zone) = setting.value, TimeZone(identifier: zone) != nil { syncedTimeZone = zone }
            else { syncedTimeZone = nil }
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
        applyDocument(.notes, change: snapshot.changes.first { $0.key == notesDataKey })
        let currentPlan = snapshot.changes.first { $0.key == planDataKey }
        let legacyPlan = snapshot.changes.first { $0.key == legacyPlanDataKey }
        if currentPlan == nil, let legacyPlan, documentBases["plan"] == nil {
            if documentDirty["plan"] != true, let value = legacyPlan.value { try? assignDocument(.plan, value: value) }
            documentDirty["plan"] = true
        }
        applyDocument(.plan, change: currentPlan)
        if !persist() { install(previous) }
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

    static func planningDayKey(now: Date = Date()) -> String {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: now)
        let reset = calendar.date(byAdding: .hour, value: 8, to: start) ?? start
        return TaskGraph.dateKey(now < reset ? (calendar.date(byAdding: .day, value: -1, to: now) ?? now) : now)
    }

    private func currentDocuments() throws -> [String: JSONValue] {
        ["tasks": try JSONValue(encoding: todos), "notes": try JSONValue(encoding: notes), "plan": try JSONValue(encoding: plan)]
    }

    private func cacheState() -> MobileCache {
        MobileCache(epoch: documentEpoch, serverScope: serverURL, todos: todos, notes: notes, plan: plan,
                    baseTodos: baseTodos, baseTodoValue: baseTodoValue, todoDirty: todoDirty,
                    todoConflict: todoConflict, versions: versions, documentDirty: documentDirty,
                    documentBases: documentBases, documentConflicts: documentConflicts,
                    revisions: localRevisions, receipts: commitReceipts, receiptOrder: receiptOrder,
                    drafts: preservedDrafts, backups: documentBackups, editorDrafts: editorDrafts, timeZone: syncedTimeZone)
    }

    private func install(_ cache: MobileCache) {
        documentEpoch = cache.epoch ?? 0
        todos = cache.todos; notes = cache.notes; plan = cache.plan
        baseTodos = cache.baseTodos; baseTodoValue = cache.baseTodoValue; todoDirty = cache.todoDirty
        todoConflict = cache.todoConflict; versions = cache.versions
        documentDirty = cache.documentDirty; documentBases = cache.documentBases; documentConflicts = cache.documentConflicts
        localRevisions = cache.revisions; commitReceipts = cache.receipts; receiptOrder = cache.receiptOrder
        preservedDrafts = cache.drafts; documentBackups = cache.backups
        editorDrafts = cache.editorDrafts
        syncedTimeZone = cache.timeZone
        lastDocuments = (try? currentDocuments()) ?? [:]
    }

    @discardableResult private func persist() -> Bool {
        guard !localStorageBlocked else { return false }
        do {
            let documents = try currentDocuments()
            var next = localRevisions
            for (key, value) in documents where lastDocuments[key] != value { next[key, default: 0] += 1 }
            var cache = cacheState(); cache.revisions = next; cache.epoch = documentEpoch + 1
            try cache.write(to: storageURL)
            localRevisions = next; lastDocuments = documents; persistenceError = nil
            if legacyCaching { persistLegacyCaches() }
            documentEpoch += 1
            return true
        } catch {
            persistenceError = "Could not save on this device: \(error.localizedDescription)"
            errorMessage = persistenceError
            return false
        }
    }

    func mobileSnapshot() throws -> MobileSnapshot {
        guard !localStorageBlocked else { throw MobileDocumentError.invalid(persistenceError ?? "Local data needs recovery.") }
        let values = try currentDocuments()
        var documents: [String: MobileDocumentSnapshot] = [:]
        for key in MobileDocumentKey.allCases {
            documents[key.rawValue] = MobileDocumentSnapshot(value: values[key.rawValue]!, revision: localRevisions[key.rawValue] ?? 0, pending: key == .tasks ? todoDirty : documentDirty[key.rawValue] == true)
        }
        var conflicts = Array(documentConflicts.values)
        if let conflict = todoConflict {
            conflicts.append(MobileConflict(key: "tasks", detail: conflict.detail, local: values["tasks"]!, remote: try JSONValue(encoding: conflict.remote), version: conflict.version))
        }
        for index in conflicts.indices { conflicts[index].local = values[conflicts[index].key] ?? conflicts[index].local }
        return MobileSnapshot(epoch: documentEpoch, documents: documents, status: status, error: persistenceError ?? errorMessage,
                              syncing: isSyncing, timeZone: syncedTimeZone, conflicts: conflicts, drafts: preservedDrafts)
    }

    private func assignDocument(_ key: MobileDocumentKey, value: JSONValue) throws {
        switch key {
        case .tasks:
            let next = try value.decode(TodoData.self)
            guard next.schemaVersion == 2 else { throw MobileDocumentError.invalid("Unsupported task schema. Update LocalFlow.") }
            try TaskGraph.validate(next)
            todos = next
        case .notes:
            let next = try value.decode(NotesData.self)
            var nodes: [String: NoteNode] = [:]
            for node in next.items {
                guard !node.id.isEmpty, ["note", "folder"].contains(node.type), nodes[node.id] == nil else { throw MobileDocumentError.invalid("Invalid or duplicate note.") }
                nodes[node.id] = node
            }
            for node in next.items {
                var seen: Set<String> = [node.id], parent = node.parentId
                while let id = parent {
                    guard seen.insert(id).inserted, let ancestor = nodes[id], ancestor.type == "folder" else { throw MobileDocumentError.invalid("Invalid note folder hierarchy.") }
                    parent = ancestor.parentId
                }
            }
            notes = next
        case .plan:
            let next = try value.decode(PlanData.self)
            guard next.plans.keys.allSatisfy({ TaskGraph.date($0) != nil }) else { throw MobileDocumentError.invalid("Invalid planning date.") }
            plan = next
        }
    }

    func commitMobile(_ commit: MobileCommit, draftDecision: Bool? = nil) throws -> MobileCommitReply {
        guard !localStorageBlocked, commit.transactionId.count <= 160, !commit.transactionId.isEmpty else { throw MobileDocumentError.invalid("Invalid local commit.") }
        let canonical = JSONEncoder(); canonical.outputFormatting = [.sortedKeys]
        let fingerprint = SHA256.hash(data: try canonical.encode(commit.value)).map { String(format: "%02x", $0) }.joined()
        let operation = draftDecision.map { $0 ? "keepDraft" : "discardDraft" } ?? "commit"
        if let receipt = commitReceipts[commit.transactionId] {
            guard receipt.key == commit.key, receipt.expectedRevision == commit.expectedRevision, receipt.fingerprint == fingerprint, (receipt.operation ?? "commit") == operation else { throw MobileDocumentError.invalid("Transaction ID was reused for a different edit.") }
            return MobileCommitReply(accepted: true, snapshot: try mobileSnapshot())
        }
        guard commit.expectedRevision == (localRevisions[commit.key.rawValue] ?? 0) else {
            try preserveMobileDraft(commit.key, value: commit.value)
            return MobileCommitReply(accepted: false, snapshot: try mobileSnapshot(), error: "Another change arrived. Your draft has been preserved; review it before saving.")
        }
        if draftDecision != nil {
            guard preservedDrafts[commit.key.rawValue] == commit.value else { throw MobileDocumentError.invalid("The preserved draft changed. Reload and review it again.") }
        } else if preservedDrafts[commit.key.rawValue] != nil {
            throw MobileDocumentError.invalid("Review the preserved draft before saving this document.")
        }
        let previous = cacheState()
        let replaced = try currentDocuments()[commit.key.rawValue]!
        if draftDecision != false {
            try assignDocument(commit.key, value: commit.value)
            if commit.key == .tasks { todoDirty = true; taskUndo.removeAll(); canUndoTasks = false }
            else { documentDirty[commit.key.rawValue] = true }
        }
        if let keep = draftDecision { documentBackups[commit.key.rawValue] = keep ? replaced : commit.value }
        commitReceipts[commit.transactionId] = MobileReceipt(key: commit.key, expectedRevision: commit.expectedRevision, fingerprint: fingerprint, operation: operation)
        receiptOrder.append(commit.transactionId)
        if receiptOrder.count > 128 { commitReceipts.removeValue(forKey: receiptOrder.removeFirst()) }
        preservedDrafts.removeValue(forKey: commit.key.rawValue)
        status = "Saved locally"
        guard persist() else {
            let failure = persistenceError ?? "Local save failed."
            install(previous)
            throw MobileDocumentError.invalid(failure)
        }
        if draftDecision != false { Task { if commit.key == .tasks { await pushTodos() } else { await pushDocument(commit.key) } } }
        return MobileCommitReply(accepted: true, snapshot: try mobileSnapshot())
    }

    func preserveMobileDraft(_ key: MobileDocumentKey, value: JSONValue) throws {
        let previous = cacheState()
        preservedDrafts[key.rawValue] = value
        guard persist() else { install(previous); throw MobileDocumentError.invalid(persistenceError ?? "Could not preserve the draft.") }
    }

    func discardMobileDraft(_ key: MobileDocumentKey) throws {
        let previous = cacheState()
        // Retain the discarded draft as an exportable recovery copy.
        documentBackups[key.rawValue] = preservedDrafts[key.rawValue] ?? documentBackups[key.rawValue]
        preservedDrafts.removeValue(forKey: key.rawValue)
        guard persist() else {
            install(previous)
            throw MobileDocumentError.invalid(persistenceError ?? "Could not save the draft decision.")
        }
    }

    func resolveMobileConflict(_ key: MobileDocumentKey, useLocal: Bool) throws {
        if key == .tasks {
            resolveTodoConflict(useLocal: useLocal)
            if let persistenceError { throw MobileDocumentError.invalid(persistenceError) }
            return
        }
        guard let conflict = documentConflicts[key.rawValue] else { return }
        let previous = cacheState()
        let local = try currentDocuments()[key.rawValue]!
        documentBackups[key.rawValue] = useLocal ? conflict.remote : local
        let empty = try key == .notes ? JSONValue(encoding: NotesData()) : JSONValue(encoding: PlanData())
        let remote = conflict.remote == .null ? empty : conflict.remote
        if !useLocal { try assignDocument(key, value: remote) }
        documentBases[key.rawValue] = remote
        versions[key.serverKey] = conflict.version
        documentDirty[key.rawValue] = useLocal
        documentConflicts.removeValue(forKey: key.rawValue)
        guard persist() else {
            install(previous)
            throw MobileDocumentError.invalid(persistenceError ?? "Could not save conflict resolution.")
        }
        if useLocal { Task { await pushDocument(key) } }
    }

    func mobileBackup(_ key: MobileDocumentKey) throws -> JSONValue {
        if let value = documentBackups[key.rawValue] { return value }
        if key == .tasks, let data = Self.load(TodoData.self, key: "cache.todos.conflictBackup") { return try JSONValue(encoding: data) }
        throw MobileDocumentError.invalid("No preserved backup for this document.")
    }

    func readMobileEditorDraft(_ id: String) -> JSONValue { editorDrafts[id] ?? .null }

    func writeMobileEditorDraft(_ id: String, value: JSONValue) throws {
        guard id.count <= 200 else { throw MobileDocumentError.invalid("Invalid task draft.") }
        if value == .null { editorDrafts.removeValue(forKey: id) } else { editorDrafts[id] = value }
        guard persist() else { throw MobileDocumentError.invalid(persistenceError ?? "Could not save the task draft.") }
    }

    func mobileHistory(_ key: MobileDocumentKey) async throws -> JSONValue {
        try await historyRequest(path: "/v1/history", query: [URLQueryItem(name: "store", value: storeName), URLQueryItem(name: "key", value: key.serverKey), URLQueryItem(name: "limit", value: "50")])
    }

    func restoreMobileRevision(_ key: MobileDocumentKey, version: Int, baseVersion: Int) async throws -> MobileSnapshot {
        await syncLock.acquire()
        do {
            let pending = key == .tasks ? todoDirty || todoConflict != nil : documentDirty[key.rawValue] == true || documentConflicts[key.rawValue] != nil
            guard !pending, preservedDrafts[key.rawValue] == nil else { throw MobileDocumentError.invalid("Save or resolve local changes before restoring a server revision.") }
            documentBackups[key.rawValue] = try currentDocuments()[key.rawValue]
            guard persist() else { throw MobileDocumentError.invalid(persistenceError ?? "Could not preserve the current version.") }
            _ = try await historyRequest(path: "/v1/history/restore", body: .object([
                "store": .string(storeName), "key": .string(key.serverKey), "version": .number(Double(version)),
                "baseVersion": .number(Double(baseVersion)), "clientId": .string(clientId), "todoSchemaVersion": .number(2)
            ]))
            apply(snapshot: try await requestSnapshot())
            await syncLock.release()
            return try mobileSnapshot()
        } catch { await syncLock.release(); throw error }
    }

    private func historyRequest(path: String, query: [URLQueryItem] = [], body: JSONValue? = nil) async throws -> JSONValue {
        let scope = serverURL, token = authToken
        guard !scope.isEmpty, var url = URLComponents(string: scope.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { throw MobileDocumentError.invalid("Configure a sync server to use revision history.") }
        if !query.isEmpty { url.queryItems = query }
        guard let endpoint = url.url else { throw URLError(.badURL) }
        var request = URLRequest(url: endpoint)
        applyHeaders(to: &request)
        if let body { request.httpMethod = "POST"; request.httpBody = try encoder.encode(body) }
        let (data, response) = try await transport(request)
        guard scope == serverURL, token == authToken else { throw SyncError.connectionChanged }
        try validate(response: response)
        return try decoder.decode(JSONValue.self, from: data)
    }

    private func persistLegacyCaches() {
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

    private static func load<T: Decodable>(_ type: T.Type, key: String, defaults: UserDefaults = .standard) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
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
