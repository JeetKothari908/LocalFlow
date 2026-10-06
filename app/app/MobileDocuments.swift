import Foundation

enum MobileDocumentKey: String, Codable, CaseIterable {
    case tasks, notes, plan
    var serverKey: String {
        switch self {
        case .tasks: return "data/default-todo"
        case .notes: return "data/default-notes"
        case .plan: return "data/default-plan-of-day"
        }
    }
}

struct MobileDocumentSnapshot: Codable {
    var value: JSONValue
    var revision: Int
    var pending: Bool
}

struct MobileSnapshot: Codable {
    var `protocol` = 1
    var epoch: Int
    var documents: [String: MobileDocumentSnapshot]
    var status: String
    var error: String?
    var syncing: Bool
    var timeZone: String?
    var conflicts: [MobileConflict]
    var drafts: [String: JSONValue]
}

struct MobileConflict: Codable {
    var key: String
    var detail: String
    var local: JSONValue
    var remote: JSONValue
    var version: Int
}

struct MobileCommit: Codable {
    var key: MobileDocumentKey
    var value: JSONValue
    var expectedRevision: Int
    var transactionId: String
}

struct MobileCommitReply: Codable {
    var accepted: Bool
    var snapshot: MobileSnapshot
    var error: String?
}

struct MobileReceipt: Codable {
    var key: MobileDocumentKey
    var expectedRevision: Int
    var fingerprint: String
    var operation: String?
}

/// One atomic file holds documents and their sync metadata. Legacy caches are
/// retained for migration recovery; successful local commits never depend on JS storage.
struct MobileCache: Codable {
    var schemaVersion = 1
    var epoch: Int?
    var serverScope: String
    var todos: TodoData
    var notes: NotesData
    var plan: PlanData
    var baseTodos: TodoData?
    var baseTodoValue: JSONValue?
    var todoDirty: Bool
    var todoConflict: TodoSyncConflict?
    var versions: [String: Int]
    var documentDirty: [String: Bool]
    var documentBases: [String: JSONValue]
    var documentConflicts: [String: MobileConflict]
    var revisions: [String: Int]
    var receipts: [String: MobileReceipt]
    var receiptOrder: [String]
    var drafts: [String: JSONValue]
    var backups: [String: JSONValue]
    var editorDrafts: [String: JSONValue]
    var timeZone: String?

    static var defaultURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LocalFlow", isDirectory: true).appendingPathComponent("documents.json")
    }
    static func read(from url: URL) throws -> MobileCache? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let cache = try JSONDecoder().decode(MobileCache.self, from: Data(contentsOf: url))
        guard cache.schemaVersion == 1 else { throw MobileDocumentError.invalid("Update LocalFlow before opening this local data.") }
        return cache
    }
    func write(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
    }
}

enum MobileDocumentError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

extension JSONValue {
    func bridgeObject() throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(self), options: .fragmentsAllowed) }
}

/// Notes and plans use a conservative three-way merge. Edits to different
/// fields/notes/dates merge; conflicting edits remain available for review.
enum MobileDocumentMerge {
    static func merge(base: JSONValue?, local: JSONValue?, remote: JSONValue?) throws -> JSONValue? {
        if local == remote { return local }
        if local == base { return remote }
        if remote == base { return local }
        if case .object(let b) = base, case .object(let l) = local, case .object(let r) = remote {
            // Deleting a note/folder concurrently with editing it needs review.
            if b["id"] != nil && (b["deleted"] != l["deleted"] || b["deleted"] != r["deleted"]) {
                throw MobileDocumentError.invalid("A note was edited and deleted on different devices.")
            }
            var result: [String: JSONValue] = [:]
            for key in Set(b.keys).union(l.keys).union(r.keys) {
                if ["selectedNoteId", "currentFolderId", "selectedDate", "activeDate"].contains(key) {
                    result[key] = l[key] ?? r[key]
                } else { result[key] = try merge(base: b[key], local: l[key], remote: r[key]) }
            }
            return .object(result)
        }
        if case .array(let b) = base, case .array(let l) = local, case .array(let r) = remote {
            func byID(_ values: [JSONValue]) throws -> [String: JSONValue] {
                var result: [String: JSONValue] = [:]
                for value in values {
                    guard case .object(let object) = value, case .string(let id) = object["id"], result[id] == nil else { throw MobileDocumentError.invalid("Concurrent list changes need review.") }
                    result[id] = value
                }
                return result
            }
            let old = try byID(b), left = try byID(l), right = try byID(r)
            let ids = (r + l).compactMap { value -> String? in if case .object(let object) = value, case .string(let id) = object["id"] { return id }; return nil }
            var seen: Set<String> = [], merged: [JSONValue] = []
            for id in ids where seen.insert(id).inserted {
                if let value = try merge(base: old[id], local: left[id], remote: right[id]) { merged.append(value) }
            }
            return .array(merged)
        }
        throw MobileDocumentError.invalid("The same content changed on both devices. Both versions are preserved.")
    }
}
