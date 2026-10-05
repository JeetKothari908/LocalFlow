import XCTest
@testable import app

@MainActor
final class TaskGraphTests: XCTestCase {
    private func task(_ id: String, parent: String? = nil, due: String? = nil) -> TodoItem { TodoItem(id: id, contents: id, dueDate: due, parentTaskId: parent) }

    func testScheduleRetainsZeroEffortMilestones() throws {
        var data = TodoData()
        var root = task("root", due: "2026-10-01"); root.plannedStart = "2026-10-01"
        var approval = task("approval", parent: "root"); approval.estimatedMinutes = 0
        var release = task("release", parent: "root"); release.estimatedMinutes = 0
        data.items = [root, approval, release]
        try TaskGraph.addDependency(&data, prerequisite: "approval", dependent: "release")
        XCTAssertEqual(TaskGraph.analyzeSchedule(data, "root").criticalTaskIds, ["approval", "release"])
    }

    func testScheduleSupportsDeepBranchesWithoutCopyingDates() {
        var data = TodoData()
        data.items = (0..<6000).map { index in
            var value = task(String(index), parent: index > 0 ? String(index - 1) : nil)
            if index == 0 { value.plannedStart = "2026-10-01"; value.dueDate = "2026-10-01" }
            if index == 5999 { value.estimatedMinutes = 1 }
            return value
        }
        let analysis = TaskGraph.analyzeSchedule(data, "0")
        XCTAssertEqual(analysis.rows.count, 6000)
        XCTAssertEqual(analysis.earliestFinish, TaskGraph.date("2026-10-01")!.addingTimeInterval(60))
        XCTAssertEqual(analysis.criticalTaskIds, ["5999"])
        XCTAssertNil(data.items.last?.plannedStart)
    }

    func testScheduledCriticalPathAndParallelFloatWithoutSummaryDoubleCounting() throws {
        var data = TodoData()
        var root = task("root", due: "2026-10-01"); root.plannedStart = "2026-10-01"; root.dueTime = "02:00"; root.estimatedMinutes = 999
        var a = task("a", parent: "root"); a.estimatedMinutes = 60
        var b = task("b", parent: "root"); b.estimatedMinutes = 30
        var parallel = task("parallel", parent: "root"); parallel.estimatedMinutes = 20
        data.items = [root, a, b, parallel]
        try TaskGraph.addDependency(&data, prerequisite: "a", dependent: "b")
        let original = data, analysis = TaskGraph.analyzeSchedule(data, "root")
        XCTAssertEqual(analysis.earliestFinish, TaskGraph.date("2026-10-01")!.addingTimeInterval(90 * 60))
        XCTAssertEqual(analysis.deadlineMarginMinutes, 30)
        XCTAssertEqual(analysis.criticalTaskIds, ["a", "b"])
        XCTAssertEqual(analysis.rows.first(where: { $0.id == "parallel" })?.floatMinutes, 70)
        XCTAssertEqual(data, original)
    }

    func testScheduledInheritedBlockersWaitForPrerequisiteBranchCompletion() throws {
        var data = TodoData()
        var root = task("root", due: "2026-10-01"); root.dueTime = "02:00"
        var leaf = task("leaf", parent: "root"); leaf.estimatedMinutes = 30
        var prep = task("prep", parent: "external"); prep.plannedStart = "2026-10-01"; prep.estimatedMinutes = 60
        data.items = [root, leaf, task("external"), prep]
        try TaskGraph.addDependency(&data, prerequisite: "external", dependent: "root")
        let analysis = TaskGraph.analyzeSchedule(data, "root")
        XCTAssertEqual(analysis.criticalTaskIds, ["prep", "leaf"])
        XCTAssertEqual(analysis.earliestFinish, TaskGraph.date("2026-10-01")!.addingTimeInterval(90 * 60))
    }

    func testScheduleWithholdsUnknownStartsAndEstimatesOrUnavailablePrerequisites() throws {
        var data = TodoData(); data.items = [task("root", due: "2026-10-01"), task("leaf", parent: "root")]
        let unknown = TaskGraph.analyzeSchedule(data, "root")
        XCTAssertEqual(unknown.missingStartIds, ["leaf"]); XCTAssertEqual(unknown.missingEstimateIds, ["leaf"])
        XCTAssertNil(unknown.earliestFinish)
        var root = task("root", due: "2026-10-01"); root.plannedStart = "2026-10-01"; root.estimatedMinutes = 30
        var canceled = task("canceled"); canceled.status = "canceled"
        data.items = [root, canceled]
        try TaskGraph.addDependency(&data, prerequisite: "canceled", dependent: "root")
        XCTAssertEqual(TaskGraph.analyzeSchedule(data, "root").unavailableIds, ["canceled"])
        XCTAssertTrue(TaskGraph.analyzeSchedule(data, "root").rows.isEmpty)
    }

    func testScheduledCriticalityRequiresAnOutcomeDeadlineAndAllowsZeroEffort() {
        var data = TodoData(); var item = task("a"); item.plannedStart = "2026-10-01"; item.estimatedMinutes = 0; data.items = [item]
        let analysis = TaskGraph.analyzeSchedule(data, "a")
        XCTAssertEqual(analysis.earliestFinish, TaskGraph.date("2026-10-01"))
        XCTAssertTrue(analysis.criticalTaskIds.isEmpty)
        XCTAssertNil(analysis.rows.first?.floatMinutes)
    }

    func testScheduledDeadlineRiskAndInheritedStartWithoutChangingDates() {
        var data = TodoData(); var item = task("a", due: "2026-10-01"); item.plannedStart = "2026-10-01"; item.estimatedMinutes = 120; item.dueTime = "01:00"; data.items = [item]
        XCTAssertEqual(TaskGraph.analyzeSchedule(data, "a").deadlineMarginMinutes, -60)
        XCTAssertEqual(TaskGraph.analyzeSchedule(data, "a").rows.first?.lateMinutes, 60)
        var root = task("root"); root.plannedStart = "2026-10-02"
        item.parentTaskId = "root"; item.estimatedMinutes = 30; data.items = [root, item]
        XCTAssertEqual(TaskGraph.analyzeSchedule(data, "a").earliestFinish, TaskGraph.date("2026-10-02")!.addingTimeInterval(30 * 60))
        XCTAssertEqual(data.items[1].plannedStart, "2026-10-01")
    }

    func testDependencyTraceIncludesTheEntireInheritedPrerequisiteChain() throws {
        var data = TodoData(); data.items = [task("root"), task("leaf", parent: "root"), task("first"), task("approval"), task("after"), task("unrelated")]
        try TaskGraph.addDependency(&data, prerequisite: "first", dependent: "approval")
        try TaskGraph.addDependency(&data, prerequisite: "approval", dependent: "root")
        try TaskGraph.addDependency(&data, prerequisite: "leaf", dependent: "after")
        let trace = TaskGraph.dependencyTrace(data, "leaf")
        XCTAssertEqual(trace.edgeIds.count, 3)
        XCTAssertTrue(Set(["leaf", "root", "first", "approval", "after"]).isSubset(of: trace.taskIds))
        XCTAssertFalse(trace.taskIds.contains("unrelated"))
    }

    func testDependencyTraceStopsAtFulfilledPrerequisites() throws {
        var data = TodoData(); var done = task("done"); done.completed = true
        data.items = [task("target"), done, task("beforeDone")]
        try TaskGraph.addDependency(&data, prerequisite: "beforeDone", dependent: "done")
        try TaskGraph.addDependency(&data, prerequisite: "done", dependent: "target")
        XCTAssertFalse(TaskGraph.dependencyTrace(data, "target").taskIds.contains("beforeDone"))
    }

    func testIntermediateParentsMustBeExplicitlyCompletedBeforeOutcomeIsReady() throws {
        var data = TodoData(); var leaf = task("leaf", parent: "parent"); leaf.completed = true
        data.items = [task("root"), task("parent", parent: "root"), leaf]
        XCTAssertEqual(TaskGraph.progress(data, "root").completed, 1)
        XCTAssertFalse(TaskGraph.readyToComplete(data, "root"))
        try TaskGraph.complete(&data, id: "parent")
        XCTAssertTrue(TaskGraph.readyToComplete(data, "root"))
    }

    func testScheduleWarningsCompareDeadlineTimesAndShowCrossProjectShiftImpact() throws {
        var data = TodoData(); var root = task("root", due: "2026-10-01"); root.dueTime = "09:00"
        var child = task("child", parent: "root", due: "2026-10-01"); child.dueTime = "16:00"
        var outside = task("outside", due: "2026-10-02"); outside.plannedStart = "2026-10-02"
        data.items = [root, child, outside]
        try TaskGraph.addDependency(&data, prerequisite: "root", dependent: "outside")
        XCTAssertTrue(TaskGraph.scheduleWarnings(data, "child").contains { $0.contains("after root") })
        XCTAssertTrue(TaskGraph.scheduleShiftWarnings(data, "root", days: 2).contains { $0.contains("outside") && $0.contains("root is due after") })
        XCTAssertEqual(data.items[0].dueDate, "2026-10-01")
    }

    func testBulkCompletionPreservesEarlierChildCompletionAndOccurrenceDates() throws {
        var data = TodoData()
        var root = task("root", due: "2026-10-01"); root.repeat = RepeatRule(type: "daily"); root.repeatScope = "branch"
        var done = task("done", parent: "root"); done.completed = true; done.status = "done"
        done.completedAt = "2026-09-20T12:00:00.000Z"; done.updatedAt = done.completedAt
        data.items = [root, done, task("open", parent: "root")]
        var permanent = data
        try TaskGraph.complete(&permanent, id: "root", cascade: true, permanent: true)
        XCTAssertEqual(TaskGraph.item(permanent, "done")?.completedAt, done.completedAt)
        XCTAssertEqual(TaskGraph.item(permanent, "done")?.updatedAt, done.updatedAt)
        try TaskGraph.complete(&data, id: "root", cascade: true, now: TaskGraph.date("2026-10-01")!)
        XCTAssertEqual(data.occurrences.first?.items.first(where: { $0.id == "done" })?.completedAt, done.completedAt)
        XCTAssertTrue(data.items.allSatisfy { !$0.isDone })
    }

    func testUnarchivingUnfinishedWorkReopensCompletedAncestors() throws {
        var data = TodoData(); data.items = [task("root"), task("parent", parent: "root"), task("child", parent: "parent")]
        TaskGraph.archive(&data, id: "child", archived: true)
        try TaskGraph.complete(&data, id: "root", cascade: true)
        TaskGraph.archive(&data, id: "child", archived: false)
        XCTAssertTrue(data.items.allSatisfy { !$0.isDone })
        XCTAssertNoThrow(try TaskGraph.validate(data))
    }

    func testEditingCompletedTaskWithoutStatusPreservesCompletion() throws {
        var data = TodoData(); data.schemaVersion = 2
        var done = task("done"); done.completed = true; done.status = nil; done.completedAt = "2026-09-20T12:00:00.000Z"
        data.items = [done]; done.description = "Additional notes"
        try TaskGraph.update(&data, task: done)
        XCTAssertTrue(data.items[0].isDone)
        XCTAssertEqual(data.items[0].status, "done")
        XCTAssertEqual(data.items[0].completedAt, done.completedAt)
    }

    func testRootSummaryCountsOnlyActiveCommitmentsAndSelectsNextDeadline() throws {
        var data = TodoData()
        var done = task("done", parent: "root", due: "2026-09-01"); done.completed = true
        var hidden = task("hidden", parent: "root", due: "2026-10-01"); hidden.archivedAt = "2026-09-30"
        data.items = [task("root"), task("parent", parent: "root"), task("today", parent: "parent", due: "2026-10-01"), task("overdue", parent: "root", due: "2026-09-30"), done, hidden, task("prerequisite")]
        try TaskGraph.addDependency(&data, prerequisite: "prerequisite", dependent: "parent")
        let summary = TaskGraph.summary(data, "root", today: "2026-10-01")
        XCTAssertEqual(summary.dueToday, 1); XCTAssertEqual(summary.overdue, 1); XCTAssertEqual(summary.blocked, 2)
        XCTAssertEqual(summary.next?.id, "overdue")
    }

    func testSearchOutlineExpandsOnlyAncestorsAndKeepsConnectorContinuations() {
        var data = TodoData()
        var first = task("first", parent: "root"); first.order = 0
        var last = task("last", parent: "root"); last.order = 1
        data.items = [task("root"), first, task("child", parent: "first"), last, task("other", parent: "last")]
        let rows = TaskGraph.outlineRows(data, "root", expanded: Set(TaskGraph.ancestors(data, "child").map(\.id)))
        XCTAssertEqual(rows.map(\.id), ["first", "child", "last"])
        XCTAssertEqual(rows[1].guides, [true]); XCTAssertTrue(rows[1].isLast)
    }

    func testCriticalChainIgnoresPrerequisitesOfCanceledWork() throws {
        var data = TodoData()
        var active = task("active", parent: "root"); active.estimatedMinutes = 5
        var canceled = task("canceled", parent: "root"); canceled.status = "canceled"
        var external = task("external"); external.estimatedMinutes = 100
        data.items = [task("root"), active, canceled, external]
        try TaskGraph.addDependency(&data, prerequisite: "external", dependent: "canceled")
        XCTAssertEqual(TaskGraph.criticalPath(data, "root")?.minutes, 5)
        XCTAssertFalse(TaskGraph.criticalPath(data, "root")?.ids.contains("external") ?? true)
    }

    func testInactiveTaskLinkCannotCompleteWorkUnderCanceledAncestor() {
        var data = TodoData(); var root = task("root"); root.status = "canceled"
        data.items = [root, task("child", parent: "root")]
        let original = data
        XCTAssertThrowsError(try TaskGraph.complete(&data, id: "child"))
        XCTAssertEqual(data, original)
    }

    func testMigrationPreservesOrdinaryTasksAndSeparatesLegacyOccurrences() throws {
        let raw = Data("""
        {"items":[{"id":"daily","contents":"Daily","completed":false,"repeat":{"type":"daily"}},{"id":"occ","contents":"Daily","completed":true,"parentId":"daily","dueDate":"2026-09-30"}],"customLists":[],"extraSetting":{"keep":true}}
        """.utf8)
        let source = try JSONDecoder().decode(TodoData.self, from: raw)
        let migrated = TaskGraph.migrate(source, now: TaskGraph.date("2026-10-01")!)
        XCTAssertEqual(migrated.schemaVersion, 2)
        XCTAssertEqual(migrated.items.map(\.id), ["daily"])
        XCTAssertNil(migrated.items.first?.parentTaskId)
        XCTAssertEqual(migrated.occurrences.first?.taskId, "daily")
        XCTAssertNotNil(migrated.legacyBackup)
        XCTAssertEqual(migrated.extraFields["extraSetting"], source.extraFields["extraSetting"])
        XCTAssertEqual(TaskGraph.migrate(migrated), migrated)
    }

    func testDueTodayIncludesEveryListAndDepthAndKeepsBlockedTasks() throws {
        var data = TodoData()
        data.customLists = [CustomList(id: "work", name: "Work")]
        var root = task("root"); root.listId = "work"
        data.items = [root, task("child", parent: "root"), task("deep", parent: "child", due: "2026-10-01"), task("inbox", due: "2026-09-30"), task("prerequisite")]
        try TaskGraph.addDependency(&data, prerequisite: "prerequisite", dependent: "root")
        XCTAssertEqual(Set(TaskGraph.dueToday(data, today: "2026-10-01").map(\.id)), ["deep", "inbox"])
        XCTAssertEqual(TaskGraph.path(data, "deep").map(\.id), ["root", "child", "deep"])
        XCTAssertEqual(TaskGraph.blockers(data, "deep").first?.inheritedFrom?.id, "root")
    }

    func testCombinedHierarchyDependencyCycleRejectsWithoutMutation() throws {
        var data = TodoData(); data.items = [task("parent"), task("child", parent: "parent")]
        let original = data
        XCTAssertThrowsError(try TaskGraph.addDependency(&data, prerequisite: "parent", dependent: "child"))
        XCTAssertEqual(data, original)
        XCTAssertThrowsError(try TaskGraph.addDependency(&data, prerequisite: "child", dependent: "parent"))
        XCTAssertEqual(data, original)
        XCTAssertThrowsError(try TaskGraph.move(&data, id: "parent", parent: "child"))
        XCTAssertEqual(data, original)
    }

    func testCompletionRequiresCascadeAndReopeningChildReopensAncestors() throws {
        var data = TodoData(); data.items = [task("parent"), task("child", parent: "parent")]
        let original = data
        XCTAssertThrowsError(try TaskGraph.complete(&data, id: "parent"))
        XCTAssertEqual(data, original)
        try TaskGraph.complete(&data, id: "parent", cascade: true)
        XCTAssertTrue(data.items.allSatisfy(\.isDone))
        TaskGraph.reopen(&data, id: "child")
        XCTAssertFalse(TaskGraph.item(data, "parent")!.isDone)
        try TaskGraph.validate(data)
    }

    func testAddingBelowCompletedTaskReopensIt() throws {
        var data = TodoData(); data.items = [TodoItem(id: "parent", contents: "Parent", completed: true, status: "done")]
        try TaskGraph.add(&data, task: task("new", parent: "parent"))
        XCTAssertFalse(TaskGraph.item(data, "parent")!.isDone)
        XCTAssertTrue(data.activity.contains { $0.taskId == "parent" && $0.type == "reopened" })
    }

    func testTrashRestorePreservesPreviouslyIndependentDeletion() throws {
        var data = TodoData(); data.items = [task("root"), task("old", parent: "root"), task("new", parent: "root")]
        TaskGraph.trash(&data, id: "old")
        TaskGraph.trash(&data, id: "root")
        try TaskGraph.restore(&data, id: "root")
        XCTAssertNotNil(TaskGraph.item(data, "old")?.deletedAt)
        XCTAssertNil(TaskGraph.item(data, "new")?.deletedAt)
        try TaskGraph.validate(data)
    }

    func testArchivedCompletedPrerequisiteIsSatisfiedButDeletedOneIsNot() throws {
        var data = TodoData(); data.items = [TodoItem(id: "ready", contents: "Ready", completed: true, archivedAt: "2026-10-01T00:00:00Z"), task("dependent")]
        data.dependencies = [TaskDependency(id: "edge", prerequisiteTaskId: "ready", dependentTaskId: "dependent")]
        XCTAssertTrue(TaskGraph.blockers(data, "dependent").isEmpty)
        TaskGraph.trash(&data, id: "ready")
        XCTAssertEqual(TaskGraph.blockers(data, "dependent").count, 1)
    }

    func testRecurringBranchPreservesSnapshotAndOffsetsAndAdvancesBeyondToday() throws {
        var data = TodoData()
        var root = task("root", due: "2026-09-20"); root.repeat = RepeatRule(type: "daily"); root.repeatScope = "branch"
        var child = task("child", parent: "root", due: "2026-09-19"); child.plannedStart = "2026-09-18"
        data.items = [root, child]
        try TaskGraph.complete(&data, id: "root", cascade: true, now: TaskGraph.date("2026-10-01")!)
        XCTAssertEqual(TaskGraph.item(data, "root")?.dueDate, "2026-10-02")
        XCTAssertEqual(TaskGraph.item(data, "child")?.dueDate, "2026-10-01")
        XCTAssertEqual(TaskGraph.item(data, "child")?.plannedStart, "2026-09-30")
        XCTAssertTrue(data.occurrences.first!.items.allSatisfy(\.isDone))
        XCTAssertEqual(data.occurrences.first?.items.first(where: { $0.id == "child" })?.dueDate, "2026-09-19")
        XCTAssertTrue(data.items.allSatisfy { !$0.isDone })
    }

    func testMonthlyClampsWithoutLosingOriginalDay() throws {
        var data = TodoData(); var root = task("monthly", due: "2027-01-31"); root.repeat = RepeatRule(type: "monthly"); data.items = [root]
        try TaskGraph.complete(&data, id: "monthly", now: TaskGraph.date("2027-01-31")!)
        XCTAssertEqual(data.items.first?.dueDate, "2027-02-28")
        XCTAssertEqual(data.items.first?.repeat?.day, 31)
        try TaskGraph.complete(&data, id: "monthly", now: TaskGraph.date("2027-02-28")!)
        XCTAssertEqual(data.items.first?.dueDate, "2027-03-31")
    }

    func testFieldMergePreservesDisjointEditsAndRejectsDeleteEdit() throws {
        var base = TodoData(); base.items = [task("root")]
        var local = base; local.items[0].contents = "Renamed"; local.items[0].updatedAt = "2026-10-01T01:00:00Z"
        var remote = base; remote.items[0].dueDate = "2026-10-03"; remote.items[0].updatedAt = "2026-10-01T02:00:00Z"
        let merged = try TaskGraph.merge(base: base, local: local, remote: remote)
        XCTAssertEqual(merged.items.first?.contents, "Renamed")
        XCTAssertEqual(merged.items.first?.dueDate, "2026-10-03")
        XCTAssertEqual(merged.items.first?.updatedAt, "2026-10-01T02:00:00Z")
        TaskGraph.trash(&remote, id: "root")
        XCTAssertThrowsError(try TaskGraph.merge(base: base, local: local, remote: remote))
    }

    func testScheduleShiftLeavesCompletedTasksAndHistoryUntouched() throws {
        var data = TodoData(); data.items = [task("root", due: "2026-10-03"), TodoItem(id: "done", contents: "Done", completed: true, dueDate: "2026-10-02", parentTaskId: "root"), task("next", parent: "root", due: "2026-10-04")]
        XCTAssertEqual(TaskGraph.shiftPreview(data, id: "root", days: 2).count, 2)
        TaskGraph.shiftSchedule(&data, id: "root", days: 2)
        XCTAssertEqual(TaskGraph.item(data, "root")?.dueDate, "2026-10-05")
        XCTAssertEqual(TaskGraph.item(data, "done")?.dueDate, "2026-10-02")
    }

    func testMergeRejectsDifferentConcurrentCreationsOfSameEntityOrField() throws {
        let base = TodoData()
        var local = base; local.items = [task("new")]
        var remote = base; remote.items = [TodoItem(id: "new", contents: "Other title")]
        XCTAssertThrowsError(try TaskGraph.merge(base: base, local: local, remote: remote))
        local = base; remote = base
        local.extraFields["settings"] = .object(["a": .string("local")])
        remote.extraFields["settings"] = .object(["b": .string("remote")])
        XCTAssertThrowsError(try TaskGraph.merge(base: base, local: local, remote: remote))
    }

    func testMergeRejectsRestorationAgainstConcurrentEdit() throws {
        var base = TodoData(); base.items = [TodoItem(id: "root", contents: "Root", deletedAt: "2026-10-01T00:00:00Z")]
        var local = base; local.items[0].deletedAt = nil
        var remote = base; remote.items[0].contents = "Edited in trash"
        XCTAssertThrowsError(try TaskGraph.merge(base: base, local: local, remote: remote))
    }

    func testMergeUsesChronologicalTimestampsAndRemoteEntityOrder() throws {
        var base = TodoData(); base.items = [task("root")]
        var local = base; local.items[0].contents = "Renamed"; local.items[0].updatedAt = "2026-10-01T08:00:00+02:00"; local.items.append(task("local"))
        var remote = base; remote.items[0].description = "Remote notes"; remote.items[0].updatedAt = "2026-10-01T07:00:00Z"; remote.items.append(task("remote"))
        let merged = try TaskGraph.merge(base: base, local: local, remote: remote)
        XCTAssertEqual(merged.items.map(\.id), ["root", "remote", "local"])
        XCTAssertEqual(merged.items.first?.updatedAt, "2026-10-01T07:00:00Z")
    }

    func testRecurringBranchKeepsCanceledWorkAndItsDates() throws {
        var data = TodoData(); var root = task("root", due: "2026-10-01"); root.repeat = RepeatRule(type: "daily"); root.repeatScope = "branch"
        var canceled = task("canceled", parent: "root", due: "2026-10-02"); canceled.status = "canceled"
        data.items = [root, task("active", parent: "root", due: "2026-10-01"), canceled, task("hidden", parent: "canceled", due: "2026-10-03")]
        try TaskGraph.complete(&data, id: "root", cascade: true, now: TaskGraph.date("2026-10-01")!)
        XCTAssertEqual(TaskGraph.item(data, "canceled")?.status, "canceled")
        XCTAssertEqual(TaskGraph.item(data, "canceled")?.dueDate, "2026-10-02")
        XCTAssertEqual(TaskGraph.item(data, "hidden")?.dueDate, "2026-10-03")
        XCTAssertEqual(data.occurrences.first?.items.first?.id, "root")
        XCTAssertEqual(data.occurrences.first?.items.first(where: { $0.id == "canceled" })?.status, "canceled")
    }

    func testUnknownMetadataAndFractionalEstimatesRoundTrip() throws {
        let raw = Data("""
        {"schemaVersion":2,"items":[{"id":"a","contents":"A","completed":false,"estimatedMinutes":25.5,"futureMetadata":{"color":"blue"}}],"futureSetting":[1,2]}
        """.utf8)
        let decoded = try JSONDecoder().decode(TodoData.self, from: raw)
        let result = try JSONDecoder().decode(TodoData.self, from: JSONEncoder().encode(decoded))
        XCTAssertEqual(result, decoded)
        XCTAssertEqual(result.items.first?.estimatedMinutes, 25.5)
        XCTAssertNotNil(result.items.first?.extraFields["futureMetadata"])
        XCTAssertNotNil(result.extraFields["futureSetting"])
    }

    func testDeepHierarchyValidationDoesNotUseRecursiveStack() throws {
        var data = TodoData()
        for depth in 0..<5000 { data.items.append(task(String(depth), parent: depth == 0 ? nil : String(depth - 1))) }
        XCTAssertNoThrow(try TaskGraph.validate(data))
    }

    func testNotificationsExcludeDeletedAndCanceledAncestorsAcrossDepth() {
        let tasks = [TodoItem(id: "root", contents: "Root", deletedAt: "2026-10-01T00:00:00Z"), task("deep", parent: "root", due: "2026-10-01")]
        let group = TodoNotificationGroup(filter: .all, includeCompleted: true, includeDismissed: true)
        XCTAssertTrue(TodoNotificationStore.matchingTodos(for: group, todos: tasks).isEmpty)
    }
}
