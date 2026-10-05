import {
  addDependency, ancestorsOf, archiveTask, blockersOf, childrenOf, completeTask,
  createTask, criticalPath, deleteCustomList, deleteTask, descendantsOf, dueTasks,
  moveTask, normalizeTaskData, previewScheduleShift, removeDependency, reopenTask,
  restoreTask, rootOf, shiftSchedule, taskPath, taskProgress, timelineIssues,
  updateTask, validateTaskGraph, blockerDetails, taskSummary, outlineRows,
} from "./tasks";
import { Data, Task } from "./types";

const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, contents: id, completed: false, ...patch });
const data = (...items: Task[]): Data => ({ items, show: 3, schemaVersion: 2, dependencies: [], occurrences: [], activity: [], customLists: [{ id: "work", name: "Work" }] });

describe("recursive tasks", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date("2026-10-01T12:00:00Z")); });
  afterEach(() => jest.useRealTimers());

  it("preserves previous child completion dates when completing a branch or snapshotting recurrence", () => {
    const completedAt = "2026-09-20T12:00:00Z";
    const tree = data(task("root", { repeat: { type: "daily" }, repeatScope: "branch", dueDate: "2026-10-01" }), task("done", { parentTaskId: "root", completed: true, status: "done", completedAt, updatedAt: completedAt }), task("open", { parentTaskId: "root" }));
    const finished = completeTask(tree, "root", { cascade: true, permanent: true });
    expect(finished.items.find((task) => task.id === "done")).toMatchObject({ completedAt, updatedAt: completedAt });
    const repeated = completeTask(tree, "root", { cascade: true });
    expect(repeated.occurrences[0].items.find((task) => task.id === "done")?.completedAt).toBe(completedAt);
    expect(repeated.items.every((task) => !task.completed)).toBe(true);
  });

  it("reopens all completed ancestors when archived unfinished descendants are restored", () => {
    let tree = archiveTask(data(task("root"), task("parent", { parentTaskId: "root" }), task("child", { parentTaskId: "parent" })), "child");
    tree = completeTask(tree, "root", { cascade: true });
    tree = archiveTask(tree, "child", false);
    expect(tree.items.every((task) => !task.completed)).toBe(true);
    expect(() => validateTaskGraph(tree)).not.toThrow();
    expect(tree.activity.some((event) => event.type === "ancestorsReopened")).toBe(true);
  });

  it("rejects completion of inactive work reached through a task link", () => {
    const tree = data(task("root", { status: "canceled" }), task("child", { parentTaskId: "root" }));
    expect(() => completeTask(tree, "child")).toThrow("Restore this task's branch");
    expect(tree.items[1].completed).toBe(false);
  });

  it("ignores external prerequisites belonging only to canceled or hidden work in critical chains", () => {
    const tree = data(task("root"), task("active", { parentTaskId: "root", estimatedMinutes: 5 }), task("canceled", { parentTaskId: "root", status: "canceled" }), task("archived", { parentTaskId: "root", archivedAt: "2026-09-30" }), task("external", { estimatedMinutes: 100 }));
    tree.dependencies = [{ id: "one", prerequisiteTaskId: "external", dependentTaskId: "canceled" }, { id: "two", prerequisiteTaskId: "external", dependentTaskId: "archived" }];
    expect(criticalPath(tree, "root")).toMatchObject({ estimatedMinutes: 5, completeEstimates: true });
    expect(criticalPath(tree, "root").taskIds).not.toContain("external");
  });

  it("summarizes active commitments and reports the ancestor supplying an inherited blocker", () => {
    let tree = data(task("root"), task("parent", { parentTaskId: "root" }), task("today", { parentTaskId: "parent", dueDate: "2026-10-01" }), task("overdue", { parentTaskId: "root", dueDate: "2026-09-30" }), task("done", { parentTaskId: "root", completed: true, dueDate: "2026-09-01" }), task("hidden", { parentTaskId: "root", archivedAt: "2026-09-30", dueDate: "2026-10-01" }), task("prerequisite"));
    tree = addDependency(tree, "prerequisite", "parent");
    expect(taskSummary(tree, "root", "2026-10-01")).toMatchObject({ dueToday: 1, overdue: 1, blocked: 2, next: { id: "overdue" } });
    expect(blockerDetails(tree, "today")[0].inheritedFrom?.id).toBe("parent");
    tree = addDependency(tree, "prerequisite", "today");
    expect(blockerDetails(tree, "today")[0].inheritedFrom).toBeUndefined();
  });

  it("expands the search target's ancestry with correct outline connector continuations", () => {
    const tree = data(task("root"), task("first", { parentTaskId: "root", order: 0 }), task("child", { parentTaskId: "first" }), task("last", { parentTaskId: "root", order: 1 }), task("other", { parentTaskId: "last" }));
    const expanded = new Set(ancestorsOf(tree, "child").map((task) => task.id));
    expect(outlineRows(tree, "root", expanded).map((row) => ({ id: row.task.id, guides: row.guides, isLast: row.isLast }))).toEqual([{ id: "first", guides: [], isLast: false }, { id: "child", guides: [true], isLast: true }, { id: "last", guides: [], isLast: true }]);
  });

  it("migrates flat tasks without losing IDs, lists, deadlines, or original JSON", () => {
    const old: Data = { items: [task("workTask", { listId: "work", dueDate: "2026-10-02", dueTime: "16:00", repeat: { type: "weekly", days: [5] } })], show: 5, customLists: [{ id: "work", name: "Work" }], keyBind: "K" };
    const migrated = normalizeTaskData(old);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.items[0]).toMatchObject(old.items[0]);
    expect(migrated.legacyBackup).toEqual(old);
    expect(normalizeTaskData(migrated)).toEqual(migrated);
    expect(old.items[0].status).toBeUndefined();
  });

  it("moves legacy recurring parentId records into immutable history, never the hierarchy", () => {
    const original = { items: [task("repeat", { repeat: { type: "daily" } }), task("instance", { parentId: "repeat", completed: true, dueDate: "2026-09-30" })], show: 3 };
    const migrated = normalizeTaskData(original);
    expect(migrated.items.map((item) => item.id)).toEqual(["repeat"]);
    expect(migrated.occurrences).toEqual([expect.objectContaining({ id: "instance", taskId: "repeat", dueDate: "2026-09-30" })]);
    expect(migrated.occurrences[0].items[0].parentTaskId).toBeUndefined();
    expect(normalizeTaskData(migrated).occurrences).toHaveLength(1);
  });

  it("repairs imported orphan parents and structural cycles without deleting work", () => {
    const normalized = normalizeTaskData(data(task("a", { parentTaskId: "b" }), task("b", { parentTaskId: "a" }), task("orphan", { parentTaskId: "gone" })));
    expect(normalized.items).toHaveLength(3);
    expect(normalized.items.find((item) => item.id === "orphan")?.parentTaskId).toBeUndefined();
    expect(() => validateTaskGraph(normalized)).not.toThrow();
  });

  it("handles deep imported chains iteratively and returns full ancestry", () => {
    const items = Array.from({ length: 6000 }, (_, index) => task(String(index), { parentTaskId: index ? String(index - 1) : undefined }));
    const tree = normalizeTaskData(data(...items));
    expect(descendantsOf(tree, "0")).toHaveLength(5999);
    expect(ancestorsOf(tree, "5999")).toHaveLength(5999);
    expect(rootOf(tree, "5999")?.id).toBe("0");
    expect(taskPath(tree, "5999")[0].id).toBe("0");
    expect(() => validateTaskGraph(tree)).not.toThrow();
  });

  it("shows every project's overdue and due tasks regardless of custom list or nesting", () => {
    const tree = data(task("root", { listId: "work" }), task("nested", { parentTaskId: "root", dueDate: "2026-09-29" }), task("inbox", { dueDate: "2026-10-01" }), task("future", { dueDate: "2026-10-02" }), task("done", { dueDate: "2026-10-01", completed: true, status: "done" }));
    expect(dueTasks(tree, "2026-10-01").map((item) => item.id)).toEqual(["nested", "inbox"]);
  });

  it("hides archived, trashed, and canceled branches from the daily queue", () => {
    let tree = data(task("root"), task("child", { parentTaskId: "root", dueDate: "2026-10-01" }));
    expect(dueTasks(archiveTask(tree, "root"), "2026-10-01")).toEqual([]);
    expect(dueTasks(deleteTask(tree, "root"), "2026-10-01")).toEqual([]);
    tree = updateTask(tree, "root", { status: "canceled" });
    expect(dueTasks(tree, "2026-10-01")).toEqual([]);
  });

  it("adding or reopening unfinished work reopens all completed ancestors", () => {
    let tree = data(task("root", { completed: true, status: "done" }), task("parent", { parentTaskId: "root", completed: true, status: "done" }));
    tree = createTask(tree, { id: "child", parentTaskId: "parent", contents: "New work" });
    expect(tree.items.every((item) => !item.completed)).toBe(true);
    tree = completeTask(tree, "root", { cascade: true });
    tree = reopenTask(tree, "child");
    expect(tree.items.every((item) => !item.completed)).toBe(true);
  });

  it("requires explicit cascade and leaves parents ready for review when all steps finish", () => {
    let tree = data(task("root"), task("child", { parentTaskId: "root" }));
    expect(() => completeTask(tree, "root")).toThrow(/unfinished subtasks/);
    tree = completeTask(tree, "child");
    expect(tree.items.find((item) => item.id === "root")?.completed).toBe(false);
    expect(taskProgress(tree, "root")).toEqual({ completed: 1, total: 1, readyToComplete: true });
    tree = completeTask(tree, "root");
    expect(tree.items.every((item) => item.completed)).toBe(true);
  });

  it("progress counts leaves and excludes canceled work without double counting parents", () => {
    const tree = data(task("root"), task("summary", { parentTaskId: "root" }), task("leaf", { parentTaskId: "summary", completed: true }), task("other", { parentTaskId: "root" }), task("canceled", { parentTaskId: "root", status: "canceled" }));
    expect(taskProgress(tree, "root")).toEqual({ completed: 1, total: 2, readyToComplete: false });
  });

  it("moves full subtrees, changes project ancestry, and orders siblings", () => {
    const original = data(task("a", { listId: "work" }), task("b"), task("child", { parentTaskId: "a" }), task("grandchild", { parentTaskId: "child" }), task("existing", { parentTaskId: "b" }));
    const changed = moveTask(original, "child", "b", undefined, 0);
    expect(childrenOf(changed, "b").map((item) => item.id)).toEqual(["child", "existing"]);
    expect(taskPath(changed, "grandchild").map((item) => item.id)).toEqual(["b", "child", "grandchild"]);
    expect(taskPath(original, "grandchild").map((item) => item.id)).toEqual(["a", "child", "grandchild"]);
    expect(() => moveTask(changed, "b", "grandchild")).toThrow(/own subtasks/);
  });

  it("promotes tasks to roots and returns projects to Inbox when a list is deleted", () => {
    let tree = data(task("root", { listId: "work" }), task("child", { parentTaskId: "root" }));
    tree = moveTask(tree, "child", undefined, "work");
    expect(rootOf(tree, "child")?.id).toBe("child");
    tree = deleteCustomList(tree, "work");
    expect(tree.customLists).toEqual([]);
    expect(tree.items.every((item) => !item.listId)).toBe(true);
  });

  it("inherits branch prerequisites and keeps blocked work visible in Due Today", () => {
    let tree = data(task("approval"), task("project"), task("step", { parentTaskId: "project", dueDate: "2026-10-01" }));
    tree = addDependency(tree, "approval", "project");
    expect(blockersOf(tree, "step").map((item) => item.id)).toEqual(["approval"]);
    expect(dueTasks(tree, "2026-10-01").map((item) => item.id)).toEqual(["step"]);
    expect(() => updateTask(tree, "step", { status: "inProgress" })).toThrow(/prerequisites/);
    expect(() => completeTask(tree, "step")).toThrow(/prerequisites/);
    tree = completeTask(tree, "approval");
    expect(blockersOf(tree, "step")).toEqual([]);
    expect(() => completeTask(tree, "step")).not.toThrow();
  });

  it("rejects direct, transitive, and inherited structural dependency cycles", () => {
    let tree = data(task("a"), task("b"), task("c"), task("child", { parentTaskId: "a" }));
    expect(() => addDependency(tree, "a", "a")).toThrow(/circular/);
    expect(() => addDependency(tree, "a", "child")).toThrow(/circular/);
    expect(() => addDependency(tree, "child", "a")).toThrow(/circular/);
    tree = addDependency(addDependency(tree, "a", "b"), "b", "c");
    expect(() => addDependency(tree, "c", "child")).toThrow(/circular/);
    expect(() => addDependency(tree, "c", "a")).toThrow(/circular/);
    expect(() => moveTask(tree, "a", "b")).toThrow(/circular/);
  });

  it("canceling or deleting a prerequisite requires explicit dependency resolution", () => {
    const tree = addDependency(data(task("a"), task("b")), "a", "b");
    expect(blockersOf(updateTask(tree, "a", { status: "canceled" }), "b")).toHaveLength(1);
    expect(blockersOf(deleteTask(tree, "a"), "b")).toHaveLength(1);
    expect(blockersOf(removeDependency(tree, tree.dependencies![0].id), "b")).toEqual([]);
    expect(blockersOf(archiveTask(completeTask(tree, "a"), "a"), "b")).toEqual([]);
  });

  it("deduplicates dependencies and supports external project prerequisites", () => {
    let tree = addDependency(data(task("a", { listId: "work" }), task("b")), "a", "b");
    tree = addDependency(tree, "a", "b");
    expect(tree.dependencies).toHaveLength(1);
    expect(blockersOf(tree, "b")[0].id).toBe("a");
  });

  it("restores a deleted subtree without restoring descendants deleted earlier", () => {
    let tree = data(task("root"), task("child", { parentTaskId: "root" }), task("oldTrash", { parentTaskId: "root" }));
    tree = deleteTask(tree, "oldTrash");
    tree = deleteTask(tree, "root");
    expect(childrenOf(tree)).toEqual([]);
    tree = restoreTask(tree, "root");
    expect(childrenOf(tree).map((item) => item.id)).toEqual(["root"]);
    expect(childrenOf(tree, "root").map((item) => item.id)).toEqual(["child"]);
    expect(tree.items.find((item) => item.id === "oldTrash")?.deletedAt).toBeDefined();
  });

  it("restoring a child while its former parent is trashed makes it a root", () => {
    const tree = restoreTask(deleteTask(data(task("root"), task("child", { parentTaskId: "root" })), "root"), "child");
    expect(rootOf(tree, "child")?.id).toBe("child");
    expect(tree.items.find((item) => item.id === "root")?.deletedAt).toBeDefined();
  });

  it("retains dates on ordinary edits and previews explicit schedule shifts", () => {
    let tree = data(task("root", { dueDate: "2026-10-10" }), task("child", { parentTaskId: "root", dueDate: "2026-10-09", plannedStart: "2026-10-05" }), task("undated", { parentTaskId: "root" }));
    tree = updateTask(tree, "root", { dueDate: "2026-10-20" });
    expect(tree.items.find((item) => item.id === "child")?.dueDate).toBe("2026-10-09");
    const preview = previewScheduleShift(tree, "root", 3);
    expect(preview).toHaveLength(2);
    expect(preview.find((change) => change.taskId === "child")).toMatchObject({ toDueDate: "2026-10-12", toPlannedStart: "2026-10-08" });
    const shifted = shiftSchedule(tree, "root", 3);
    expect(shifted.items.find((item) => item.id === "child")?.dueDate).toBe("2026-10-12");
    expect(tree.items.find((item) => item.id === "child")?.dueDate).toBe("2026-10-09");
  });

  it("flags deadline, inherited prerequisite, start, and unscheduled conflicts", () => {
    const tree = addDependency(data(task("prerequisite", { dueDate: "2026-10-15" }), task("root", { dueDate: "2026-10-10" }), task("child", { parentTaskId: "root", dueDate: "2026-10-12", plannedStart: "2026-10-14" }), task("undated", { parentTaskId: "root" })), "prerequisite", "root");
    const issues = timelineIssues(tree, "root");
    expect(issues.map((issue) => issue.type)).toEqual(expect.arrayContaining(["childAfterParent", "dependencyAfterDeadline", "startAfterDeadline", "unscheduled"]));
  });

  it("schedule shifts preserve completed and canceled historical deadlines", () => {
    const tree = data(task("root", { dueDate: "2026-10-10" }), task("done", { parentTaskId: "root", completed: true, status: "done", dueDate: "2026-10-01" }), task("canceled", { parentTaskId: "root", status: "canceled", dueDate: "2026-10-03" }), task("hidden", { parentTaskId: "canceled", dueDate: "2026-10-04" }));
    expect(previewScheduleShift(tree, "root", 3).map((change) => change.taskId)).toEqual(["root"]);
    const shifted = shiftSchedule(tree, "root", 3);
    expect(shifted.items.find((item) => item.id === "done")?.dueDate).toBe("2026-10-01");
    expect(shifted.items.find((item) => item.id === "hidden")?.dueDate).toBe("2026-10-04");
  });

  it("snapshots individual repeat completions and advances overdue schedules after today", () => {
    let tree = data(task("repeat", { dueDate: "2026-09-29", dueTime: "16:00", repeat: { type: "daily" } }));
    tree = completeTask(tree, "repeat");
    expect(tree.items[0]).toMatchObject({ dueDate: "2026-10-02", completed: false, dueTime: "16:00" });
    expect(tree.occurrences).toHaveLength(1);
    expect(tree.occurrences![0].items[0]).toMatchObject({ dueDate: "2026-09-29", completed: true });
    const edited = updateTask(tree, "repeat", { contents: "Renamed" });
    expect(edited.occurrences![0].items[0].contents).toBe("repeat");
  });

  it("repeats branches with reset children, shifted dates, and immutable dependency history", () => {
    let tree = data(task("external", { completed: true, status: "done" }), task("monthly", { dueDate: "2026-10-01", plannedStart: "2026-09-28", repeat: { type: "monthly", day: 1 }, repeatScope: "branch" }), task("a", { parentTaskId: "monthly", dueDate: "2026-09-29" }), task("b", { parentTaskId: "monthly", dueDate: "2026-10-01" }));
    tree = addDependency(addDependency(tree, "a", "b"), "external", "monthly");
    tree = completeTask(tree, "monthly", { cascade: true });
    expect(tree.items.find((item) => item.id === "monthly")).toMatchObject({ dueDate: "2026-11-01", plannedStart: "2026-10-29", completed: false });
    expect(tree.items.find((item) => item.id === "a")).toMatchObject({ dueDate: "2026-10-30", completed: false });
    expect(tree.occurrences![0].items.every((item) => item.completed)).toBe(true);
    expect(tree.occurrences![0].dependencies).toHaveLength(1);
    expect(tree.dependencies).toHaveLength(2);
    expect(blockersOf(tree, "b").map((item) => item.id)).toEqual(["a"]);
  });

  it("keeps a recurring root first in snapshots even when moved children precede it in storage", () => {
    const tree = data(task("child", { parentTaskId: "repeat" }), task("repeat", { dueDate: "2026-10-01", repeat: { type: "daily" }, repeatScope: "branch" }));
    const result = completeTask(tree, "repeat", { cascade: true });
    expect(result.occurrences[0].items.map((item) => item.id)).toEqual(["repeat", "child"]);
    expect(createTask(data(), { contents: "Done", status: "done", completed: false }).items[0].completed).toBe(true);
  });

  it("branch recurrence retains canceled branches and their dates while resetting active steps", () => {
    const tree = data(task("repeat", { dueDate: "2026-10-01", repeat: { type: "daily" }, repeatScope: "branch" }), task("done", { parentTaskId: "repeat", completed: true, status: "done", dueDate: "2026-09-30" }), task("canceled", { parentTaskId: "repeat", status: "canceled", dueDate: "2026-09-30" }), task("hidden", { parentTaskId: "canceled", dueDate: "2026-09-30" }));
    const result = completeTask(tree, "repeat");
    expect(result.items.find((item) => item.id === "done")).toMatchObject({ completed: false, status: "todo", dueDate: "2026-10-01" });
    expect(result.items.find((item) => item.id === "canceled")).toMatchObject({ status: "canceled", dueDate: "2026-09-30" });
    expect(result.items.find((item) => item.id === "hidden")?.dueDate).toBe("2026-09-30");
    expect(result.occurrences[0].items.map((item) => item.id)).toEqual(["repeat", "done", "canceled", "hidden"]);
    expect(dueTasks(result, "2026-10-01").map((item) => item.id)).toEqual(["done"]);
  });

  it("clamps monthly dates while retaining the preferred day for later months", () => {
    jest.setSystemTime(new Date("2026-01-31T12:00:00Z"));
    let tree = completeTask(data(task("month", { dueDate: "2026-01-31", repeat: { type: "monthly" } })), "month");
    expect(tree.items[0].dueDate).toBe("2026-02-28");
    jest.setSystemTime(new Date("2026-02-28T12:00:00Z"));
    tree = completeTask(tree, "month");
    expect(tree.items[0].dueDate).toBe("2026-03-31");
    expect(tree.occurrences).toHaveLength(2);
  });

  it("supports weekly/custom repeats and permanently completing a repeating branch", () => {
    const weekly = completeTask(data(task("weekly", { dueDate: "2026-10-01", repeat: { type: "weekly", days: [1] } })), "weekly");
    expect(weekly.items[0].dueDate).toBe("2026-10-05");
    const custom = completeTask(data(task("custom", { dueDate: "2026-10-01", repeat: { type: "custom", days: [0, 6] } })), "custom");
    expect(custom.items[0].dueDate).toBe("2026-10-03");
    const parent = data(task("parent", { repeat: { type: "daily" }, repeatScope: "task" }), task("child", { parentTaskId: "parent" }));
    expect(() => completeTask(parent, "parent", { cascade: true })).toThrow(/repeat their branch/);
    expect(completeTask(parent, "parent", { cascade: true, permanent: true }).items.every((item) => item.completed)).toBe(true);
  });

  it("initializes an undated recurrence so it can appear in the daily queue", () => {
    const daily = createTask(data(), { contents: "Daily", repeat: { type: "daily" } });
    expect(daily.items[0].dueDate).toBe("2026-10-01");
    const custom = createTask(data(), { contents: "Monday", repeat: { type: "custom", days: [1] } });
    expect(custom.items[0].dueDate).toBe("2026-10-05");
    const monthly = createTask(data(), { contents: "Monthly", repeat: { type: "monthly", day: 15 } });
    expect(monthly.items[0].dueDate).toBe("2026-10-15");
    const migrated = normalizeTaskData({ items: [task("legacyDaily", { repeat: { type: "daily" } })] });
    expect(migrated.items[0].dueDate).toBe("2026-10-01");
    expect(dueTasks(migrated, "2026-10-01")).toHaveLength(1);
  });

  it("finds the longest prerequisite chain including external prerequisites without counting summaries twice", () => {
    let tree = data(task("external", { estimatedMinutes: 30 }), task("root", { estimatedMinutes: 200 }), task("a", { parentTaskId: "root", estimatedMinutes: 40 }), task("b", { parentTaskId: "root", estimatedMinutes: 50 }), task("parallel", { parentTaskId: "root", estimatedMinutes: 60 }));
    tree = addDependency(addDependency(tree, "external", "a"), "a", "b");
    const path = criticalPath(tree, "root");
    expect(path).toMatchObject({ estimatedMinutes: 120, completeEstimates: true });
    expect(path.taskIds.slice(0, 3)).toEqual(["external", "a", "b"]);
    expect(criticalPath(data(task("missing"))).completeEstimates).toBe(false);
    const blocked = addDependency(data(task("unavailable", { status: "canceled", estimatedMinutes: 30 }), task("dependent", { estimatedMinutes: 20 })), "unavailable", "dependent");
    expect(criticalPath(blocked, "dependent").completeEstimates).toBe(false);
  });

  it("validates metadata without mutating existing data and records task activity", () => {
    const original = data(task("root"));
    expect(() => createTask(original, { contents: " " })).toThrow(/title/);
    expect(() => updateTask(original, "root", { dueDate: "2026-02-30" })).toThrow(/valid date/);
    expect(() => updateTask(original, "root", { dueTime: "24:00" })).toThrow(/valid time/);
    expect(() => updateTask(original, "root", { estimatedMinutes: -2 })).toThrow(/nonnegative/);
    expect(() => createTask(original, { contents: "Repeat", repeat: { type: "custom", days: [] } })).toThrow(/weekday/);
    const changed = updateTask(original, "root", { description: "Instructions" });
    expect(changed.activity.at(-1)).toMatchObject({ taskId: "root", type: "updated" });
    expect(changed.activity.at(-1)?.detail).toBe("Description updated");
    const deadline = updateTask(data(task("root", { dueDate: "2026-10-01" })), "root", { dueDate: "2026-10-02", priority: "high" });
    expect(deadline.activity.at(-1)?.detail).toContain("Deadline: 2026-10-01 → 2026-10-02");
    expect(deadline.activity.at(-1)?.detail).toContain("Priority: normal → high");
    const moved = moveTask(data(task("child"), task("root", { contents: "Website launch" })), "child", "root");
    expect(moved.activity.at(-1)?.detail).toBe("Moved under Website launch");
    expect(original.items[0].description).toBeUndefined();
  });
});
