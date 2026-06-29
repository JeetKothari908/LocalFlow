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

    @Published var serverURL = UserDefaults.standard.string(forKey: "sync.serverURL") ?? "https://raspberrypi.tail2db278.ts.net" {
        didSet { UserDefaults.standard.set(serverURL, forKey: "sync.serverURL") }
    }

    @Published var authToken = UserDefaults.standard.string(forKey: "sync.authToken") ?? "jfiweokgerhotrwhtr" {
        didSet { UserDefaults.standard.set(authToken, forKey: "sync.authToken") }
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
        todos = Self.load(TodoData.self, key: "cache.todos") ?? TodoData()
        notes = Self.load(NotesData.self, key: "cache.notes") ?? NotesData()
        plan = Self.load(PlanData.self, key: "cache.plan") ?? PlanData()
    }

    var activeTodos: [TodoItem] {
        todos.items.filter { $0.dismissed != true }
    }

    var finishedTodos: [TodoItem] {
        todos.items.filter { $0.dismissed == true }
    }

    var liveNotes: [NoteNode] {
        notes.items.filter { $0.deleted != true && $0.type == "note" }
    }

    func refresh() async {
        await syncLock.acquire()
        await performSync {
            let snapshot = try await self.requestSnapshot()
            self.apply(snapshot: snapshot)
            self.status = "Synced \(Date.now.formatted(date: .omitted, time: .shortened))"
        }
        await syncLock.release()
    }

    func addTodo(_ contents: String, dueDate: String? = nil, dueTime: String? = nil, repeatRule: RepeatRule? = nil) {
        let trimmed = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        todos.items.append(
            TodoItem(
                id: Self.makeId(),
                contents: trimmed,
                completed: false,
                dismissed: false,
                dueDate: dueDate,
                dueTime: dueDate != nil || repeatRule != nil ? (dueTime ?? Self.defaultDueTime) : nil,
                repeat: repeatRule
            )
        )
        persist()
        Task { await pushTodos() }
    }

    func updateTodo(_ item: TodoItem, contents: String, dueDate: String?, dueTime: String?, repeatRule: RepeatRule?) {
        let trimmed = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let index = todos.items.firstIndex(where: { $0.id == item.id }) else {
            return
        }
        todos.items[index].contents = trimmed
        todos.items[index].dueDate = dueDate
        todos.items[index].dueTime = dueDate != nil || repeatRule != nil ? (dueTime ?? Self.defaultDueTime) : nil
        todos.items[index].repeat = repeatRule
        persist()
        Task { await pushTodos() }
    }

    func toggleTodo(_ item: TodoItem) {
        guard let index = todos.items.firstIndex(where: { $0.id == item.id }) else { return }
        if todos.items[index].completed == false, let repeatRule = todos.items[index].repeat {
            completeRepeatInstance(item: todos.items[index], repeatRule: repeatRule)
            return
        }
        todos.items[index].completed.toggle()
        if todos.items[index].completed == false {
            todos.items[index].dismissed = false
        }
        persist()
        Task { await pushTodos() }
    }

    func dismissTodo(_ item: TodoItem) {
        guard let index = todos.items.firstIndex(where: { $0.id == item.id }) else { return }
        todos.items[index].completed = true
        todos.items[index].dismissed = true
        persist()
        Task { await pushTodos() }
    }

    func deleteTodo(_ item: TodoItem) {
        todos.items.removeAll { $0.id == item.id }
        persist()
        Task { await pushTodos() }
    }

    private func completeRepeatInstance(item: TodoItem, repeatRule: RepeatRule) {
        let currentDueDate = item.dueDate ?? Self.firstRepeatDate(repeatRule)
        guard let nextDueDate = Self.nextRepeatDate(repeatRule, from: currentDueDate) else { return }
        let siblingDates = Set(todos.items.compactMap { sibling -> String? in
            sibling.parentId == item.id && sibling.completed ? sibling.dueDate : nil
        })
        var advancedDate = nextDueDate
        var safety = 0
        while siblingDates.contains(advancedDate), safety < 365,
              let next = Self.nextRepeatDate(repeatRule, from: advancedDate) {
            advancedDate = next
            safety += 1
        }
        guard let parentIndex = todos.items.firstIndex(where: { $0.id == item.id }) else { return }
        todos.items[parentIndex].dueDate = advancedDate
        todos.items.append(
            TodoItem(
                id: Self.makeId(),
                contents: item.contents,
                completed: true,
                dismissed: false,
                dueDate: currentDueDate,
                dueTime: item.dueTime,
                repeat: nil,
                parentId: item.id,
                listId: item.listId
            )
        )
        persist()
        Task { await pushTodos() }
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
        await push(value: todos, key: todoDataKey, label: "Todos saved")
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
        var request = URLRequest(url: try endpoint(""))
        request.httpMethod = "GET"
        applyHeaders(to: &request)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response)
        return try decoder.decode(RemoteSnapshot.self, from: data)
    }

    private func post(changes: [RemoteChange]) async throws -> RemoteWriteResponse {
        var request = URLRequest(url: try endpoint("/changes"))
        request.httpMethod = "POST"
        applyHeaders(to: &request)
        request.httpBody = try encoder.encode(RemoteSnapshot(changes: changes, clientId: clientId))
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response)
        return try decoder.decode(RemoteWriteResponse.self, from: data)
    }

    private func apply(snapshot: RemoteSnapshot) {
        for change in snapshot.changes {
            if let version = change.version {
                versions[change.key] = version
            }
        }
        let values = Dictionary(uniqueKeysWithValues: snapshot.changes.compactMap { change -> (String, JSONValue)? in
            guard change.deleted != true, let value = change.value else { return nil }
            return (change.key, value)
        })

        decodeIfPresent(TodoData.self, key: todoDataKey, values: values) { todos = $0 }
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

    static func firstRepeatDate(_ rule: RepeatRule, today: Date = Date()) -> String? {
        if rule.type == "daily" {
            return Self.dateKey(today)
        }
        let days = repeatDays(rule, fallbackDate: today)
        guard !days.isEmpty else { return nil }
        let calendar = Calendar(identifier: .gregorian)
        for offset in 0...6 {
            guard let candidate = calendar.date(byAdding: .day, value: offset, to: today) else { continue }
            if days.contains(calendar.component(.weekday, from: candidate) - 1) {
                return Self.dateKey(candidate)
            }
        }
        return nil
    }

    static func nextRepeatDate(_ rule: RepeatRule, from dueDate: String?) -> String? {
        let base = date(from: dueDate) ?? Date()
        let calendar = Calendar(identifier: .gregorian)
        if rule.type == "daily" {
            return calendar.date(byAdding: .day, value: 1, to: base).map(Self.dateKey)
        }
        let days = repeatDays(rule, fallbackDate: base)
        guard !days.isEmpty else { return nil }
        for offset in 1...7 {
            guard let candidate = calendar.date(byAdding: .day, value: offset, to: base) else { continue }
            if days.contains(calendar.component(.weekday, from: candidate) - 1) {
                return Self.dateKey(candidate)
            }
        }
        return nil
    }

    private static func repeatDays(_ rule: RepeatRule, fallbackDate: Date) -> [Int] {
        if rule.type == "daily" { return [0, 1, 2, 3, 4, 5, 6] }
        if let days = rule.days, !days.isEmpty { return days }
        return rule.type == "weekly"
            ? [Calendar(identifier: .gregorian).component(.weekday, from: fallbackDate) - 1]
            : []
    }

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

    var errorDescription: String? {
        switch self {
        case .conflict:
            return "This data changed on another device. Refresh before saving again."
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
