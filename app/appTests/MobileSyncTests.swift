import XCTest
@testable import app

/// Deterministic server-boundary tests: a second client's writes use the same
/// version-conflict responses as the sync API, without connecting to a real account.
@MainActor private final class MobileSyncServer {
    var values: [String: JSONValue] = [:]
    var versions: [String: Int] = [:]
    var beforeNextWrite: (() -> Void)?
    func edit(_ key: MobileDocumentKey, _ value: JSONValue) {
        values[key.serverKey] = value; versions[key.serverKey, default: 0] += 1
    }
    func respond(_ request: URLRequest) throws -> (Data, URLResponse) {
        var status = 200
        let data: Data
        if request.httpMethod == "POST" {
            let before = beforeNextWrite; beforeNextWrite = nil; before?()
            let batch = try JSONDecoder().decode(RemoteSnapshot.self, from: request.httpBody!)
            if batch.changes.contains(where: { $0.baseVersion != (versions[$0.key] ?? 0) }) {
                status = 409; data = Data("{}".utf8)
            } else {
                for change in batch.changes { values[change.key] = change.value; versions[change.key, default: 0] += 1 }
                data = try JSONEncoder().encode(RemoteWriteResponse(ok: true, versions: versions))
            }
        } else {
            data = try JSONEncoder().encode(RemoteSnapshot(changes: values.map { RemoteChange(key: $0.key, value: $0.value, version: versions[$0.key]) }))
        }
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor final class MobileSyncTests: XCTestCase {
    private func plan(_ contents: [String: String]) throws -> JSONValue {
        var value = PlanData(); value.plans = contents; return try JSONValue(encoding: value)
    }
    private func store(_ server: MobileSyncServer, url: URL) -> SyncStore {
        let store = SyncStore(storageURL: url, loadLegacy: false, transport: { try server.respond($0) })
        store.serverURL = "https://localflow.test"; store.authToken = ""
        return store
    }
    private func location() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("documents.json") }

    func testOtherClientPlanEditMergesAfterVersionConflictAndSurvivesRelaunch() async throws {
        let server = MobileSyncServer(), url = location()
        server.edit(.plan, try plan([:]))
        let subject = store(server, url: url); await subject.refresh()
        let local = try plan(["2026-10-05": "Local offline edit"])
        let remote = try plan(["2026-10-06": "Extension edit"])
        server.beforeNextWrite = { server.edit(.plan, remote) }
        let revision = try subject.mobileSnapshot().documents["plan"]!.revision
        _ = try subject.commitMobile(MobileCommit(key: .plan, value: local, expectedRevision: revision, transactionId: "merge-plan"))
        await subject.pushPlan(); await subject.pushPlan()
        let expected = ["2026-10-05": "Local offline edit", "2026-10-06": "Extension edit"]
        XCTAssertEqual(subject.plan.plans, expected)
        XCTAssertEqual(try server.values[MobileDocumentKey.plan.serverKey]?.decode(PlanData.self).plans, expected)
        let reopened = SyncStore(storageURL: url, loadLegacy: false, syncEnabled: false)
        XCTAssertEqual(reopened.plan.plans, expected)
        XCTAssertFalse(try reopened.mobileSnapshot().documents["plan"]!.pending)
    }

    func testConcurrentTextEditPreservesBothVersionsAcrossRelaunch() async throws {
        let server = MobileSyncServer(), url = location()
        server.edit(.plan, try plan(["2026-10-05": "Base"]))
        let subject = store(server, url: url); await subject.refresh()
        let local = try plan(["2026-10-05": "Local"]), remote = try plan(["2026-10-05": "Extension"])
        server.beforeNextWrite = { server.edit(.plan, remote) }
        let revision = try subject.mobileSnapshot().documents["plan"]!.revision
        _ = try subject.commitMobile(MobileCommit(key: .plan, value: local, expectedRevision: revision, transactionId: "conflict-plan"))
        await subject.pushPlan()
        let reopened = SyncStore(storageURL: url, loadLegacy: false, syncEnabled: false)
        let conflict = try XCTUnwrap(reopened.mobileSnapshot().conflicts.first(where: { $0.key == "plan" }))
        XCTAssertEqual(conflict.local, local); XCTAssertEqual(conflict.remote, remote)
        XCTAssertEqual(server.values[MobileDocumentKey.plan.serverKey], remote)
    }

    func testConcurrentNotesInDifferentFoldersMergeWithoutLosingMetadata() async throws {
        let server = MobileSyncServer(), url = location()
        var base = NotesData()
        base.items = [NoteNode(id: "folder", type: "folder", name: "Work"),
                      NoteNode(id: "a", type: "note", name: "A", parentId: "folder", contents: "A"),
                      NoteNode(id: "b", type: "note", name: "B", contents: "B")]
        base.extraFields["futureRoot"] = .bool(true)
        server.edit(.notes, try JSONValue(encoding: base))
        let subject = store(server, url: url); await subject.refresh()
        var local = base; local.items[1].contents = "Local A"
        var remote = base; remote.items[2].contents = "Extension B"
        let remoteValue = try JSONValue(encoding: remote)
        server.beforeNextWrite = { server.edit(.notes, remoteValue) }
        let revision = try subject.mobileSnapshot().documents["notes"]!.revision
        _ = try subject.commitMobile(MobileCommit(key: .notes, value: JSONValue(encoding: local), expectedRevision: revision, transactionId: "merge-notes"))
        await subject.pushNotes(); await subject.pushNotes()
        let reopened = SyncStore(storageURL: url, loadLegacy: false, syncEnabled: false)
        XCTAssertEqual(reopened.notes.items.first(where: { $0.id == "a" })?.contents, "Local A")
        XCTAssertEqual(reopened.notes.items.first(where: { $0.id == "a" })?.parentId, "folder")
        XCTAssertEqual(reopened.notes.items.first(where: { $0.id == "b" })?.contents, "Extension B")
        XCTAssertEqual(reopened.notes.extraFields["futureRoot"], .bool(true))
        XCTAssertTrue(try reopened.mobileSnapshot().conflicts.isEmpty)
    }
}
