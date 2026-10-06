import Foundation

/// Version 2 keeps a flat set of tasks. Only parentTaskId expresses structural nesting.
struct TodoData: Codable, Equatable {
    var items: [TodoItem] = []
    var show: Int = 3
    var keyBind: String? = "T"
    var lastClearedDate: String?
    var customLists: [CustomList] = []
    var schemaVersion: Int = 2
    var dependencies: [TaskDependency] = []
    var occurrences: [TaskOccurrence] = []
    var activity: [TaskActivity] = []
    var legacyBackup: JSONValue?
    var extraFields: [String: JSONValue] = [:]

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([TodoItem].self, forKey: .items) ?? []
        show = try c.decodeIfPresent(Int.self, forKey: .show) ?? 3
        keyBind = try c.decodeIfPresent(String.self, forKey: .keyBind) ?? "T"
        lastClearedDate = try c.decodeIfPresent(String.self, forKey: .lastClearedDate)
        customLists = try c.decodeIfPresent([CustomList].self, forKey: .customLists) ?? []
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        dependencies = try c.decodeIfPresent([TaskDependency].self, forKey: .dependencies) ?? []
        occurrences = try c.decodeIfPresent([TaskOccurrence].self, forKey: .occurrences) ?? []
        activity = try c.decodeIfPresent([TaskActivity].self, forKey: .activity) ?? []
        legacyBackup = try c.decodeIfPresent(JSONValue.self, forKey: .legacyBackup)
        if schemaVersion < 2 && legacyBackup == nil { legacyBackup = try? JSONValue(from: decoder) }
        let raw = try decoder.container(keyedBy: OpenCodingKey.self)
        let known = Set(CodingKeys.allCases.map(\.stringValue))
        for key in raw.allKeys where !known.contains(key.stringValue) { extraFields[key.stringValue] = try raw.decode(JSONValue.self, forKey: key) }
    }
    enum CodingKeys: String, CodingKey, CaseIterable { case items, show, keyBind, lastClearedDate, customLists, schemaVersion, dependencies, occurrences, activity, legacyBackup }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(items, forKey: OpenCodingKey("items"))
        try c.encode(show, forKey: OpenCodingKey("show"))
        try c.encodeIfPresent(keyBind, forKey: OpenCodingKey("keyBind"))
        try c.encodeIfPresent(lastClearedDate, forKey: OpenCodingKey("lastClearedDate"))
        try c.encode(customLists, forKey: OpenCodingKey("customLists"))
        try c.encode(schemaVersion, forKey: OpenCodingKey("schemaVersion"))
        try c.encode(dependencies, forKey: OpenCodingKey("dependencies"))
        try c.encode(occurrences, forKey: OpenCodingKey("occurrences"))
        try c.encode(activity, forKey: OpenCodingKey("activity"))
        try c.encodeIfPresent(legacyBackup, forKey: OpenCodingKey("legacyBackup"))
    }

}

struct CustomList: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var updatedAt: String?
    var deletedAt: String?
    var extraFields: [String: JSONValue] = [:]
    init(id: String, name: String, updatedAt: String? = nil, deletedAt: String? = nil) {
        self.id = id
        self.name = name
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        id = try c.decode(String.self, forKey: OpenCodingKey("id"))
        name = try c.decode(String.self, forKey: OpenCodingKey("name"))
        updatedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("updatedAt"))
        deletedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("deletedAt"))
        let known: Set<String> = ["id", "name", "updatedAt", "deletedAt"]
        for key in c.allKeys where !known.contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(id, forKey: OpenCodingKey("id"))
        try c.encode(name, forKey: OpenCodingKey("name"))
        try c.encodeIfPresent(updatedAt, forKey: OpenCodingKey("updatedAt"))
        try c.encodeIfPresent(deletedAt, forKey: OpenCodingKey("deletedAt"))
    }
}

struct TodoItem: Codable, Identifiable, Equatable {
    var id: String
    var contents: String
    var completed: Bool
    var dismissed: Bool?
    var dueDate: String?
    var dueTime: String?
    var `repeat`: RepeatRule?
    var parentId: String?
    var listId: String?
    var parentTaskId: String?
    var description: String?
    var status: String?
    var priority: String?
    var plannedStart: String?
    var estimatedMinutes: Double?
    var order: Double?
    var createdAt: String?
    var updatedAt: String?
    var completedAt: String?
    var deletedAt: String?
    var archivedAt: String?
    var deletedByTaskId: String?
    var repeatScope: String?
    var extraFields: [String: JSONValue] = [:]
    init(id: String, contents: String, completed: Bool = false, dismissed: Bool? = nil, dueDate: String? = nil, dueTime: String? = nil, `repeat`: RepeatRule? = nil, parentId: String? = nil, listId: String? = nil, parentTaskId: String? = nil, description: String? = nil, status: String? = nil, priority: String? = nil, plannedStart: String? = nil, estimatedMinutes: Double? = nil, order: Double? = nil, createdAt: String? = nil, updatedAt: String? = nil, completedAt: String? = nil, deletedAt: String? = nil, archivedAt: String? = nil, deletedByTaskId: String? = nil, repeatScope: String? = nil) {
        self.id = id
        self.contents = contents
        self.completed = completed
        self.dismissed = dismissed
        self.dueDate = dueDate
        self.dueTime = dueTime
        self.`repeat` = `repeat`
        self.parentId = parentId
        self.listId = listId
        self.parentTaskId = parentTaskId
        self.description = description
        self.status = status
        self.priority = priority
        self.plannedStart = plannedStart
        self.estimatedMinutes = estimatedMinutes
        self.order = order
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.deletedAt = deletedAt
        self.archivedAt = archivedAt
        self.deletedByTaskId = deletedByTaskId
        self.repeatScope = repeatScope
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        id = try c.decode(String.self, forKey: OpenCodingKey("id"))
        contents = try c.decode(String.self, forKey: OpenCodingKey("contents"))
        completed = try c.decodeIfPresent(Bool.self, forKey: OpenCodingKey("completed")) ?? false
        dismissed = try c.decodeIfPresent(Bool.self, forKey: OpenCodingKey("dismissed"))
        dueDate = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("dueDate"))
        dueTime = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("dueTime"))
        `repeat` = try c.decodeIfPresent(RepeatRule.self, forKey: OpenCodingKey("repeat"))
        parentId = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("parentId"))
        listId = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("listId"))
        parentTaskId = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("parentTaskId"))
        description = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("description"))
        status = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("status"))
        priority = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("priority"))
        plannedStart = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("plannedStart"))
        estimatedMinutes = try c.decodeIfPresent(Double.self, forKey: OpenCodingKey("estimatedMinutes"))
        order = try c.decodeIfPresent(Double.self, forKey: OpenCodingKey("order"))
        createdAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("createdAt"))
        updatedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("updatedAt"))
        completedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("completedAt"))
        deletedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("deletedAt"))
        archivedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("archivedAt"))
        deletedByTaskId = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("deletedByTaskId"))
        repeatScope = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("repeatScope"))
        let known: Set<String> = ["id", "contents", "completed", "dismissed", "dueDate", "dueTime", "repeat", "parentId", "listId", "parentTaskId", "description", "status", "priority", "plannedStart", "estimatedMinutes", "order", "createdAt", "updatedAt", "completedAt", "deletedAt", "archivedAt", "deletedByTaskId", "repeatScope"]
        for key in c.allKeys where !known.contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(id, forKey: OpenCodingKey("id"))
        try c.encode(contents, forKey: OpenCodingKey("contents"))
        try c.encode(completed, forKey: OpenCodingKey("completed"))
        try c.encodeIfPresent(dismissed, forKey: OpenCodingKey("dismissed"))
        try c.encodeIfPresent(dueDate, forKey: OpenCodingKey("dueDate"))
        try c.encodeIfPresent(dueTime, forKey: OpenCodingKey("dueTime"))
        try c.encodeIfPresent(`repeat`, forKey: OpenCodingKey("repeat"))
        try c.encodeIfPresent(parentId, forKey: OpenCodingKey("parentId"))
        try c.encodeIfPresent(listId, forKey: OpenCodingKey("listId"))
        try c.encodeIfPresent(parentTaskId, forKey: OpenCodingKey("parentTaskId"))
        try c.encodeIfPresent(description, forKey: OpenCodingKey("description"))
        try c.encodeIfPresent(status, forKey: OpenCodingKey("status"))
        try c.encodeIfPresent(priority, forKey: OpenCodingKey("priority"))
        try c.encodeIfPresent(plannedStart, forKey: OpenCodingKey("plannedStart"))
        try c.encodeIfPresent(estimatedMinutes, forKey: OpenCodingKey("estimatedMinutes"))
        try c.encodeIfPresent(order, forKey: OpenCodingKey("order"))
        try c.encodeIfPresent(createdAt, forKey: OpenCodingKey("createdAt"))
        try c.encodeIfPresent(updatedAt, forKey: OpenCodingKey("updatedAt"))
        try c.encodeIfPresent(completedAt, forKey: OpenCodingKey("completedAt"))
        try c.encodeIfPresent(deletedAt, forKey: OpenCodingKey("deletedAt"))
        try c.encodeIfPresent(archivedAt, forKey: OpenCodingKey("archivedAt"))
        try c.encodeIfPresent(deletedByTaskId, forKey: OpenCodingKey("deletedByTaskId"))
        try c.encodeIfPresent(repeatScope, forKey: OpenCodingKey("repeatScope"))
    }
    var isDone: Bool { completed || status == "done" }
    var isCanceled: Bool { status == "canceled" }
}

struct RepeatRule: Codable, Equatable {
    var type: String
    var days: [Int]?
    var day: Int?
    var extraFields: [String: JSONValue] = [:]
    init(type: String, days: [Int]? = nil, day: Int? = nil) {
        self.type = type
        self.days = days
        self.day = day
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        type = try c.decode(String.self, forKey: OpenCodingKey("type"))
        days = try c.decodeIfPresent([Int].self, forKey: OpenCodingKey("days"))
        day = try c.decodeIfPresent(Int.self, forKey: OpenCodingKey("day"))
        let known: Set<String> = ["type", "days", "day"]
        for key in c.allKeys where !known.contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(type, forKey: OpenCodingKey("type"))
        try c.encodeIfPresent(days, forKey: OpenCodingKey("days"))
        try c.encodeIfPresent(day, forKey: OpenCodingKey("day"))
    }
}

struct TaskDependency: Codable, Identifiable, Equatable {
    var id: String
    var prerequisiteTaskId: String
    var dependentTaskId: String
    var createdAt: String?
    var updatedAt: String?
    var deletedAt: String?
    var extraFields: [String: JSONValue] = [:]
    init(id: String, prerequisiteTaskId: String, dependentTaskId: String, createdAt: String? = nil, updatedAt: String? = nil, deletedAt: String? = nil) {
        self.id = id
        self.prerequisiteTaskId = prerequisiteTaskId
        self.dependentTaskId = dependentTaskId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        id = try c.decode(String.self, forKey: OpenCodingKey("id"))
        prerequisiteTaskId = try c.decode(String.self, forKey: OpenCodingKey("prerequisiteTaskId"))
        dependentTaskId = try c.decode(String.self, forKey: OpenCodingKey("dependentTaskId"))
        createdAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("createdAt"))
        updatedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("updatedAt"))
        deletedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("deletedAt"))
        let known: Set<String> = ["id", "prerequisiteTaskId", "dependentTaskId", "createdAt", "updatedAt", "deletedAt"]
        for key in c.allKeys where !known.contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(id, forKey: OpenCodingKey("id"))
        try c.encode(prerequisiteTaskId, forKey: OpenCodingKey("prerequisiteTaskId"))
        try c.encode(dependentTaskId, forKey: OpenCodingKey("dependentTaskId"))
        try c.encodeIfPresent(createdAt, forKey: OpenCodingKey("createdAt"))
        try c.encodeIfPresent(updatedAt, forKey: OpenCodingKey("updatedAt"))
        try c.encodeIfPresent(deletedAt, forKey: OpenCodingKey("deletedAt"))
    }
}

struct TaskOccurrence: Codable, Identifiable, Equatable {
    var id: String
    var taskId: String
    var completedAt: String
    var dueDate: String?
    var items: [TodoItem]
    var dependencies: [TaskDependency]?
    var extraFields: [String: JSONValue] = [:]
    init(id: String, taskId: String, completedAt: String, dueDate: String? = nil, items: [TodoItem] = [], dependencies: [TaskDependency]? = nil) {
        self.id = id
        self.taskId = taskId
        self.completedAt = completedAt
        self.dueDate = dueDate
        self.items = items
        self.dependencies = dependencies
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        id = try c.decode(String.self, forKey: OpenCodingKey("id"))
        taskId = try c.decode(String.self, forKey: OpenCodingKey("taskId"))
        completedAt = try c.decode(String.self, forKey: OpenCodingKey("completedAt"))
        dueDate = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("dueDate"))
        items = try c.decodeIfPresent([TodoItem].self, forKey: OpenCodingKey("items")) ?? []
        dependencies = try c.decodeIfPresent([TaskDependency].self, forKey: OpenCodingKey("dependencies"))
        let known: Set<String> = ["id", "taskId", "completedAt", "dueDate", "items", "dependencies"]
        for key in c.allKeys where !known.contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(id, forKey: OpenCodingKey("id"))
        try c.encode(taskId, forKey: OpenCodingKey("taskId"))
        try c.encode(completedAt, forKey: OpenCodingKey("completedAt"))
        try c.encodeIfPresent(dueDate, forKey: OpenCodingKey("dueDate"))
        try c.encode(items, forKey: OpenCodingKey("items"))
        try c.encodeIfPresent(dependencies, forKey: OpenCodingKey("dependencies"))
    }
}

struct TaskActivity: Codable, Identifiable, Equatable {
    var id: String
    var taskId: String?
    var type: String
    var at: String
    var detail: String?
    var extraFields: [String: JSONValue] = [:]
    init(id: String, taskId: String? = nil, type: String, at: String, detail: String? = nil) {
        self.id = id
        self.taskId = taskId
        self.type = type
        self.at = at
        self.detail = detail
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        id = try c.decode(String.self, forKey: OpenCodingKey("id"))
        taskId = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("taskId"))
        type = try c.decode(String.self, forKey: OpenCodingKey("type"))
        at = try c.decode(String.self, forKey: OpenCodingKey("at"))
        detail = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("detail"))
        let known: Set<String> = ["id", "taskId", "type", "at", "detail"]
        for key in c.allKeys where !known.contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(id, forKey: OpenCodingKey("id"))
        try c.encodeIfPresent(taskId, forKey: OpenCodingKey("taskId"))
        try c.encode(type, forKey: OpenCodingKey("type"))
        try c.encode(at, forKey: OpenCodingKey("at"))
        try c.encodeIfPresent(detail, forKey: OpenCodingKey("detail"))
    }
}

struct NotesData: Codable, Equatable {
    var items: [NoteNode] = []
    var selectedNoteId: String?
    var currentFolderId: String?
    var extraFields: [String: JSONValue] = [:]
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        items = try c.decodeIfPresent([NoteNode].self, forKey: OpenCodingKey("items")) ?? []
        selectedNoteId = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("selectedNoteId"))
        currentFolderId = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("currentFolderId"))
        for key in c.allKeys where !["items", "selectedNoteId", "currentFolderId"].contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(items, forKey: OpenCodingKey("items"))
        try c.encodeIfPresent(selectedNoteId, forKey: OpenCodingKey("selectedNoteId"))
        try c.encodeIfPresent(currentFolderId, forKey: OpenCodingKey("currentFolderId"))
    }
}

struct NoteNode: Codable, Identifiable, Equatable {
    var id: String
    var type: String
    var name: String
    var parentId: String?
    var contents: String?
    var deleted: Bool?
    var deletedAt: String?
    var extraFields: [String: JSONValue] = [:]
    init(id: String, type: String, name: String, parentId: String? = nil, contents: String? = nil, deleted: Bool? = nil, deletedAt: String? = nil) {
        self.id = id; self.type = type; self.name = name; self.parentId = parentId; self.contents = contents; self.deleted = deleted; self.deletedAt = deletedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        id = try c.decode(String.self, forKey: OpenCodingKey("id"))
        type = try c.decode(String.self, forKey: OpenCodingKey("type"))
        name = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("name")) ?? "Untitled Note"
        parentId = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("parentId"))
        contents = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("contents"))
        deleted = try c.decodeIfPresent(Bool.self, forKey: OpenCodingKey("deleted"))
        deletedAt = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("deletedAt"))
        for key in c.allKeys where !["id", "type", "name", "parentId", "contents", "deleted", "deletedAt"].contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(id, forKey: OpenCodingKey("id")); try c.encode(type, forKey: OpenCodingKey("type")); try c.encode(name, forKey: OpenCodingKey("name"))
        // The shared note tree represents root parentage explicitly as null.
        try c.encode(parentId, forKey: OpenCodingKey("parentId"))
        try c.encodeIfPresent(contents, forKey: OpenCodingKey("contents")); try c.encodeIfPresent(deleted, forKey: OpenCodingKey("deleted")); try c.encodeIfPresent(deletedAt, forKey: OpenCodingKey("deletedAt"))
    }
}

struct PlanData: Codable, Equatable {
    var plans: [String: String] = [:]
    var activeDate: String?
    var selectedDate: String?
    var extraFields: [String: JSONValue] = [:]
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OpenCodingKey.self)
        plans = try c.decodeIfPresent([String: String].self, forKey: OpenCodingKey("plans")) ?? [:]
        activeDate = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("activeDate"))
        selectedDate = try c.decodeIfPresent(String.self, forKey: OpenCodingKey("selectedDate"))
        for key in c.allKeys where !["plans", "activeDate", "selectedDate"].contains(key.stringValue) { extraFields[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OpenCodingKey.self)
        for (key, value) in extraFields { try c.encode(value, forKey: OpenCodingKey(key)) }
        try c.encode(plans, forKey: OpenCodingKey("plans")); try c.encodeIfPresent(activeDate, forKey: OpenCodingKey("activeDate")); try c.encodeIfPresent(selectedDate, forKey: OpenCodingKey("selectedDate"))
    }
}

struct RemoteSnapshot: Codable {
    var changes: [RemoteChange]
    var clientId: String?

    init(changes: [RemoteChange], clientId: String? = nil) {
        self.changes = changes
        self.clientId = clientId
    }
}

struct RemoteChange: Codable {
    var key: String
    var value: JSONValue?
    var deleted: Bool?
    var version: Int?
    var updatedAt: Int?
    var baseVersion: Int?
    var baseValue: JSONValue?
    var todoSchemaVersion: Int?

    init(
        key: String,
        value: JSONValue? = nil,
        deleted: Bool? = nil,
        version: Int? = nil,
        updatedAt: Int? = nil,
        baseVersion: Int? = nil,
        baseValue: JSONValue? = nil,
        todoSchemaVersion: Int? = nil
    ) {
        self.key = key
        self.value = value
        self.deleted = deleted
        self.version = version
        self.updatedAt = updatedAt
        self.baseVersion = baseVersion
        self.baseValue = baseValue
        self.todoSchemaVersion = todoSchemaVersion
    }
}

struct RemoteWriteResponse: Codable {
    var ok: Bool
    var versions: [String: Int]?
    var requestId: String?
    var changes: [RemoteChange]?
}

enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

}

extension JSONValue {
    init<T: Encodable>(encoding value: T, encoder: JSONEncoder = JSONEncoder()) throws {
        let data = try encoder.encode(value)
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    func decode<T: Decodable>(_ type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try decoder.decode(type, from: data)
    }
}


struct OpenCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

extension TaskActivity {
    var displayTitle: String {
        let labels = ["created": "Created task", "updated": "Updated task", "moved": "Moved task", "reordered": "Reordered tasks", "completed": "Completed task", "branchCompleted": "Completed branch", "occurrenceCompleted": "Completed recurring occurrence", "reopened": "Reopened task", "ancestorsReopened": "Reopened ancestor tasks", "repeated": "Started next occurrence", "trashed": "Moved branch to trash", "deleted": "Moved branch to trash", "restored": "Restored branch", "archived": "Archived branch", "unarchived": "Unarchived branch", "dependencyAdded": "Added prerequisite", "dependencyRemoved": "Removed prerequisite", "scheduleShifted": "Shifted schedule", "listUpdated": "Updated list", "listDeleted": "Deleted list", "undo": "Undid task change", "backupRecovered": "Recovered task backup"]
        return labels[type] ?? type.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).capitalized
    }
}
