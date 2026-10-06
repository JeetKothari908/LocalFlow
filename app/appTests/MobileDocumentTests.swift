import XCTest
@testable import app

@MainActor
final class MobileDocumentTests: XCTestCase {
    private func file() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("documents.json") }
    private func store(_ url: URL) -> SyncStore { SyncStore(storageURL: url, loadLegacy: false, syncEnabled: false) }
    private func plan(_ text: String) throws -> JSONValue {
        var data = PlanData(); data.plans["2026-10-05"] = text
        return try JSONValue(encoding: data)
    }
    private func commit(_ value: JSONValue, revision: Int = 0, id: String = UUID().uuidString, key: MobileDocumentKey = .plan) -> MobileCommit {
        MobileCommit(key: key, value: value, expectedRevision: revision, transactionId: id)
    }

    func testOfflineCommitSurvivesRelaunchWithPendingMetadata() throws {
        let url = file(), first = store(url)
        let result = try first.commitMobile(commit(plan("Offline plan")))
        XCTAssertTrue(result.accepted)
        XCTAssertTrue(result.snapshot.documents["plan"]!.pending)
        let reopened = store(url)
        XCTAssertEqual(reopened.plan.plans["2026-10-05"], "Offline plan")
        XCTAssertEqual(try reopened.mobileSnapshot().documents["plan"]?.revision, 1)
        XCTAssertTrue(try reopened.mobileSnapshot().documents["plan"]!.pending)
    }

    func testStaleCommitPreservesDraftWithoutReplacingAcceptedData() throws {
        let url = file(), subject = store(url)
        _ = try subject.commitMobile(commit(plan("Newer")))
        let result = try subject.commitMobile(commit(plan("Stale")))
        XCTAssertFalse(result.accepted)
        XCTAssertEqual(subject.plan.plans["2026-10-05"], "Newer")
        XCTAssertEqual(try store(url).mobileSnapshot().drafts["plan"], try plan("Stale"))
    }

    func testFailedDiskWriteDoesNotAcceptTheEditOrTransaction() throws {
        let url = file(), subject = store(url)
        let parent = url.deletingLastPathComponent()
        // A file where the journal directory belongs makes persistence fail.
        try Data("occupied".utf8).write(to: parent)
        defer { try? FileManager.default.removeItem(at: parent) }
        let edit = try commit(plan("Retry me"), id: "retry-after-disk-error")
        XCTAssertThrowsError(try subject.commitMobile(edit))
        XCTAssertTrue(subject.plan.plans.isEmpty)
        XCTAssertEqual(try subject.mobileSnapshot().documents["plan"]?.revision, 0)
        try FileManager.default.removeItem(at: parent)
        let result = try subject.commitMobile(edit)
        XCTAssertTrue(result.accepted)
        XCTAssertEqual(result.snapshot.documents["plan"]?.revision, 1)
        XCTAssertEqual(store(url).plan.plans["2026-10-05"], "Retry me")
    }

    func testTransactionReplayIsIdempotentAcrossRelaunch() throws {
        let url = file(), subject = store(url)
        let edit = try commit(plan("Once"), id: "stable-transaction")
        _ = try subject.commitMobile(edit)
        let reopened = store(url)
        let result = try reopened.commitMobile(edit)
        XCTAssertTrue(result.accepted)
        XCTAssertEqual(result.snapshot.documents["plan"]?.revision, 1)
        XCTAssertThrowsError(try reopened.commitMobile(commit(plan("Different"), id: "stable-transaction")))
    }

    func testDraftDecisionsRetainTheUnchosenCopyAcrossRelaunch() throws {
        for keep in [true, false] {
            let url = file(), subject = store(url)
            let accepted = try plan("Unsynced accepted version"), draft = try plan("Draft")
            _ = try subject.commitMobile(commit(accepted))
            try subject.preserveMobileDraft(.plan, value: draft)
            let decision = commit(draft, revision: 1)
            XCTAssertTrue(try subject.commitMobile(decision, draftDecision: keep).accepted)
            let reopened = store(url)
            XCTAssertEqual(try reopened.mobileSnapshot().documents["plan"]?.value, keep ? draft : accepted)
            XCTAssertEqual(try reopened.mobileBackup(.plan), keep ? accepted : draft)
            XCTAssertNil(try reopened.mobileSnapshot().drafts["plan"])
            XCTAssertTrue(try reopened.commitMobile(decision, draftDecision: keep).accepted)
            XCTAssertThrowsError(try reopened.commitMobile(decision, draftDecision: !keep))
        }
    }

    func testStaleDraftDecisionRequiresAnotherReview() throws {
        let subject = store(file()), draft = try plan("Draft")
        _ = try subject.commitMobile(commit(plan("New accepted version")))
        try subject.preserveMobileDraft(.plan, value: draft)
        XCTAssertFalse(try subject.commitMobile(commit(draft), draftDecision: true).accepted)
        XCTAssertEqual(subject.plan.plans["2026-10-05"], "New accepted version")
        XCTAssertEqual(try subject.mobileSnapshot().drafts["plan"], draft)
    }

    func testFailedDraftDecisionKeepsBothCopiesAndCanRetry() throws {
        for keep in [true, false] {
            let url = file(), subject = store(url), draft = try plan("Draft")
            _ = try subject.commitMobile(commit(plan("Accepted")))
            try subject.preserveMobileDraft(.plan, value: draft)
            let saved = try Data(contentsOf: url)
            try FileManager.default.removeItem(at: url)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
            let decision = commit(draft, revision: 1)
            XCTAssertThrowsError(try subject.commitMobile(decision, draftDecision: keep))
            XCTAssertEqual(subject.plan.plans["2026-10-05"], "Accepted")
            XCTAssertEqual(try subject.mobileSnapshot().drafts["plan"], draft)
            try FileManager.default.removeItem(at: url)
            try saved.write(to: url)
            XCTAssertTrue(try subject.commitMobile(decision, draftDecision: keep).accepted)
            XCTAssertEqual(try store(url).mobileBackup(.plan), try plan(keep ? "Accepted" : "Draft"))
        }
    }

    func testInvalidTaskHierarchyIsRejected() throws {
        let subject = store(file())
        var data = TodoData()
        data.items = [TodoItem(id: "loop", contents: "Invalid", parentTaskId: "loop")]
        XCTAssertThrowsError(try subject.commitMobile(commit(JSONValue(encoding: data), key: .tasks)))
        XCTAssertTrue(subject.todos.items.isEmpty)
    }

    func testNoteFolderCyclesAreRejected() throws {
        let subject = store(file())
        var data = NotesData(); data.items = [NoteNode(id: "folder", type: "folder", name: "Folder", parentId: "folder")]
        XCTAssertThrowsError(try subject.commitMobile(commit(JSONValue(encoding: data), key: .notes)))
    }

    func testUnknownNoteAndPlanFieldsRoundTrip() throws {
        let raw = Data("""
        {"items":[{"id":"note","type":"note","name":"Note","parentId":null,"contents":"Body","futureNode":42}],"futureDocument":{"enabled":true}}
        """.utf8)
        let decoded = try JSONDecoder().decode(NotesData.self, from: raw)
        let encoded = try JSONValue(encoding: decoded)
        guard case .object(let object) = encoded, case .array(let items) = object["items"], case .object(let node) = items[0] else { return XCTFail("Missing note") }
        XCTAssertEqual(node["futureNode"], .number(42))
        XCTAssertEqual(object["futureDocument"], .object(["enabled": .bool(true)]))
        let planRaw = Data("{\"plans\":{},\"futureSetting\":true}".utf8)
        let plan = try JSONDecoder().decode(PlanData.self, from: planRaw)
        XCTAssertEqual(plan.extraFields["futureSetting"], .bool(true))
    }

    func testDifferentPlanningDatesMergeAndSameDateConflicts() throws {
        let base: JSONValue = .object(["plans": .object([:])])
        let local: JSONValue = .object(["plans": .object(["2026-10-05": .string("Local")])])
        let remote: JSONValue = .object(["plans": .object(["2026-10-06": .string("Remote")])])
        let merged = try MobileDocumentMerge.merge(base: base, local: local, remote: remote)
        XCTAssertEqual(merged, .object(["plans": .object(["2026-10-05": .string("Local"), "2026-10-06": .string("Remote")])]))
        XCTAssertThrowsError(try MobileDocumentMerge.merge(base: base, local: local, remote: .object(["plans": .object(["2026-10-05": .string("Other")])])) )
    }

    func testPlanningDayChangesAtEightWithoutChangingTaskCalendarDay() {
        let calendar = Calendar.current
        let early = calendar.date(from: DateComponents(year: 2026, month: 10, day: 5, hour: 7, minute: 59))!
        let morning = calendar.date(from: DateComponents(year: 2026, month: 10, day: 5, hour: 8))!
        XCTAssertEqual(SyncStore.planningDayKey(now: early), "2026-10-04")
        XCTAssertEqual(SyncStore.planningDayKey(now: morning), "2026-10-05")
        XCTAssertEqual(TaskGraph.dateKey(early), "2026-10-05")
    }

    func testCorruptJournalDoesNotGetOverwritten() throws {
        let url = file()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let original = Data("unreadable".utf8); try original.write(to: url)
        let subject = store(url)
        XCTAssertThrowsError(try subject.mobileSnapshot())
        XCTAssertThrowsError(try subject.commitMobile(commit(plan("Must not overwrite"))))
        XCTAssertEqual(try Data(contentsOf: url), original)
    }

    func testSharedTypeScriptFixtureHasMatchingTaskBehavior() throws {
        let url = try XCTUnwrap(Bundle(for: MobileDocumentTests.self).url(forResource: "mobile-parity", withExtension: "json"))
        var data = try JSONDecoder().decode(TodoData.self, from: Data(contentsOf: url))
        XCTAssertEqual(TaskGraph.path(data, "build").map(\.id), ["project", "build"])
        XCTAssertEqual(TaskGraph.blockers(data, "build").compactMap { $0.prerequisite?.id }, ["design"])
        XCTAssertEqual(TaskGraph.dueToday(data, today: "2026-10-05").map(\.id), ["design", "build"])
        XCTAssertEqual(TaskGraph.progress(data, "project").total, 2)
        try TaskGraph.complete(&data, id: "project", cascade: true)
        XCTAssertTrue(data.items.allSatisfy(\.isDone))
        XCTAssertEqual(TaskGraph.progress(data, "project").completed, 2)
        XCTAssertEqual(data.extraFields["futureDocumentField"], .string("preserve"))
        XCTAssertEqual(data.items.first?.extraFields["futureTaskField"], .object(["preserve": .bool(true)]))
    }

    func testSharedRecurrenceAndRecoveryFixture() throws {
        let url = try XCTUnwrap(Bundle(for: MobileDocumentTests.self).url(forResource: "mobile-recurrence-recovery", withExtension: "json"))
        let original = try JSONDecoder().decode(TodoData.self, from: Data(contentsOf: url))
        var recurring = original
        try TaskGraph.complete(&recurring, id: "root", cascade: true, now: TaskGraph.date("2026-10-01")!)
        XCTAssertEqual(TaskGraph.item(recurring, "root")?.dueDate, "2026-10-02")
        XCTAssertEqual(TaskGraph.item(recurring, "child")?.dueDate, "2026-10-01")
        XCTAssertEqual(TaskGraph.item(recurring, "child")?.plannedStart, "2026-09-30")
        XCTAssertFalse(TaskGraph.item(recurring, "child")!.isDone)
        XCTAssertEqual(recurring.occurrences.first?.items.first(where: { $0.id == "child" })?.dueDate, "2026-09-19")
        XCTAssertTrue(recurring.occurrences.first!.items.first(where: { $0.id == "child" })!.isDone)
        var recovered = original
        TaskGraph.trash(&recovered, id: "root"); try TaskGraph.restore(&recovered, id: "root")
        XCTAssertNil(TaskGraph.item(recovered, "root")?.deletedAt)
        XCTAssertNil(TaskGraph.item(recovered, "child")?.deletedAt)
        XCTAssertEqual(TaskGraph.item(recovered, "child")?.parentTaskId, "root")
        XCTAssertEqual(TaskGraph.item(recovered, "independent-trash")?.deletedAt, "2026-09-01T00:00:00Z")
    }

    func testLegacyCachesMigrateWithoutLosingHierarchyOrUnknownFields() throws {
        let suite = "LocalFlow-migration-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let fixture = try XCTUnwrap(Bundle(for: MobileDocumentTests.self).url(forResource: "mobile-parity", withExtension: "json"))
        let tasks = try Data(contentsOf: fixture)
        let notes = Data("""
        {"items":[{"id":"folder","type":"folder","name":"Work","parentId":null},{"id":"note","type":"note","name":"Note","parentId":"folder","contents":"Note\\nBody","future":42}],"futureRoot":true}
        """.utf8)
        defaults.set(tasks, forKey: "cache.todos"); defaults.set(notes, forKey: "cache.notes")
        defaults.set(try JSONEncoder().encode(plan("Existing plan")), forKey: "cache.plan")
        let url = file(), migrated = SyncStore(storageURL: url, loadLegacy: true, syncEnabled: false, legacyDefaults: defaults)
        XCTAssertEqual(migrated.notes.items.first(where: { $0.id == "note" })?.parentId, "folder")
        let snapshot = try migrated.mobileSnapshot()
        XCTAssertTrue(snapshot.documents["notes"]!.pending)
        XCTAssertTrue(snapshot.documents["plan"]!.pending)
        let revision = snapshot.documents["tasks"]!.revision
        _ = try migrated.commitMobile(commit(snapshot.documents["tasks"]!.value, revision: revision, key: .tasks))
        let reopened = store(url)
        XCTAssertEqual(reopened.todos, migrated.todos)
        XCTAssertEqual(reopened.notes, migrated.notes)
        XCTAssertEqual(reopened.plan, migrated.plan)
        XCTAssertEqual(defaults.data(forKey: "cache.todos"), tasks)
        XCTAssertEqual(defaults.data(forKey: "cache.notes"), notes)
    }
}
