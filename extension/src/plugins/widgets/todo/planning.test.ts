import { Data, Task } from "./types";
import { addDependency, completeTask, taskProgress, scheduleShiftIssues, timelineIssues } from "./tasks";
import { analyzeSchedule, dependencyTrace } from "./planning";

const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, contents: id, completed: false, ...patch });
const data = (...items: Task[]): Data => ({ items, show: 3, schemaVersion: 2, dependencies: [] });
const time = (clock: string) => new Date(`2026-10-01T${clock}:00`).getTime();

describe("scheduled task planning", () => {
  it("retains zero-effort milestones in a scheduled prerequisite chain", () => {
    let tree = data(task("root", { plannedStart: "2026-10-01", dueDate: "2026-10-01" }), task("approval", { parentTaskId: "root", estimatedMinutes: 0 }), task("release", { parentTaskId: "root", estimatedMinutes: 0 }));
    tree = addDependency(tree, "approval", "release");
    expect(analyzeSchedule(tree, "root").criticalTaskIds).toEqual(["approval", "release"]);
  });

  it("calculates a deeply nested branch without recursion or copying inherited dates", () => {
    const items = Array.from({ length: 6000 }, (_, index) => task(String(index), {
      ...(index ? { parentTaskId: String(index - 1) } : { plannedStart: "2026-10-01", dueDate: "2026-10-01" }),
      ...(index === 5999 ? { estimatedMinutes: 1 } : {}),
    }));
    const plan = analyzeSchedule(data(...items), "0");
    expect(plan.rows).toHaveLength(6000); expect(plan.earliestFinish).toBe(time("00:01"));
    expect(plan.criticalTaskIds).toEqual(["5999"]); expect(items[5999].plannedStart).toBeUndefined();
  });

  it("calculates a dated critical path, parallel float, and deadline margin without double counting summaries", () => {
    let tree = data(task("root", { plannedStart: "2026-10-01", dueDate: "2026-10-01", dueTime: "02:00", estimatedMinutes: 999 }), task("a", { parentTaskId: "root", estimatedMinutes: 60 }), task("b", { parentTaskId: "root", estimatedMinutes: 30 }), task("parallel", { parentTaskId: "root", estimatedMinutes: 20 }));
    tree = addDependency(tree, "a", "b");
    const before = JSON.stringify(tree), plan = analyzeSchedule(tree, "root");
    expect(plan.earliestFinish).toBe(time("01:30"));
    expect(plan.deadlineMarginMinutes).toBe(30);
    expect(plan.criticalTaskIds).toEqual(["a", "b"]);
    expect(plan.rows.find((row) => row.taskId === "parallel")?.floatMinutes).toBe(70);
    expect(plan.rows.find((row) => row.taskId === "root")?.summary).toBe(true);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("inherits branch blockers and traces a prerequisite parent's children to completion", () => {
    let tree = data(task("root", { dueDate: "2026-10-01", dueTime: "02:00" }), task("leaf", { parentTaskId: "root", estimatedMinutes: 30 }), task("external"), task("prep", { parentTaskId: "external", plannedStart: "2026-10-01", estimatedMinutes: 60 }));
    tree = addDependency(tree, "external", "root");
    const plan = analyzeSchedule(tree, "root");
    expect(plan.earliestFinish).toBe(time("01:30"));
    expect(plan.criticalTaskIds).toEqual(["prep", "leaf"]);
    expect(plan.rows.find((row) => row.taskId === "external")?.start).toBe(time("00:00"));
  });

  it("keeps inherited starts as constraints instead of copying them into metadata", () => {
    const tree = data(task("root", { plannedStart: "2026-10-02", dueDate: "2026-10-02" }), task("leaf", { parentTaskId: "root", plannedStart: "2026-10-01", estimatedMinutes: 30 }));
    const plan = analyzeSchedule(tree, "leaf");
    expect(plan.earliestFinish).toBe(new Date("2026-10-02T00:30:00").getTime());
    expect(tree.items[1].plannedStart).toBe("2026-10-01");
  });

  it("withholds calculations for unknown source starts, effort, or unavailable prerequisites", () => {
    const unknown = analyzeSchedule(data(task("root", { dueDate: "2026-10-01" }), task("leaf", { parentTaskId: "root" })), "root");
    expect(unknown.missingEstimateIds).toEqual(["leaf"]); expect(unknown.missingStartIds).toEqual(["leaf"]);
    expect(unknown.earliestFinish).toBeUndefined(); expect(unknown.criticalTaskIds).toEqual([]);
    let tree = data(task("root", { plannedStart: "2026-10-01", estimatedMinutes: 30, dueDate: "2026-10-01" }), task("canceled", { status: "canceled" }));
    tree = addDependency(tree, "canceled", "root");
    const blocked = analyzeSchedule(tree, "root");
    expect(blocked.unavailableIds).toEqual(["canceled"]); expect(blocked.rows).toEqual([]);
  });

  it("requires the selected outcome's deadline before exposing criticality", () => {
    const plan = analyzeSchedule(data(task("a", { plannedStart: "2026-10-01", estimatedMinutes: 0 })), "a");
    expect(plan.earliestFinish).toBe(time("00:00")); expect(plan.criticalTaskIds).toEqual([]);
    expect(plan.rows[0].floatMinutes).toBeUndefined(); expect(plan.rows[0].critical).toBe(false);
  });

  it("flags effort that cannot fit before an individual task's deadline", () => {
    const plan = analyzeSchedule(data(task("a", { plannedStart: "2026-10-01", estimatedMinutes: 120, dueDate: "2026-10-01", dueTime: "01:00" })), "a");
    expect(plan.deadlineMarginMinutes).toBe(-60); expect(plan.rows[0].lateMinutes).toBe(60);
  });

  it("excludes fulfilled, archived, and canceled work and unrelated prerequisite chains", () => {
    let tree = data(task("root", { plannedStart: "2026-10-01", dueDate: "2026-10-01" }), task("a", { parentTaskId: "root", estimatedMinutes: 5 }), task("done", { parentTaskId: "root", completed: true }), task("canceled", { parentTaskId: "root", status: "canceled" }), task("external", { estimatedMinutes: 999 }));
    tree = addDependency(tree, "external", "canceled");
    expect(analyzeSchedule(tree, "root").earliestFinish).toBe(time("00:05"));
    expect(analyzeSchedule(tree, "root").rows.map((row) => row.taskId)).toEqual(["root", "a"]);
  });

  it("does not mark an explicitly open intermediate parent ready just because its leaves are done", () => {
    const tree = data(task("root"), task("parent", { parentTaskId: "root" }), task("leaf", { parentTaskId: "parent", completed: true }));
    expect(taskProgress(tree, "root")).toMatchObject({ completed: 1, total: 1, readyToComplete: false });
    expect(taskProgress(completeTask(tree, "parent", { permanent: true }), "root").readyToComplete).toBe(true);
  });

  it("checks deadline times and reports cross-project effects before a branch shift", () => {
    let tree = data(task("root", { dueDate: "2026-10-01", dueTime: "09:00" }), task("child", { parentTaskId: "root", dueDate: "2026-10-01", dueTime: "16:00" }), task("outside", { dueDate: "2026-10-02", plannedStart: "2026-10-02" }));
    tree = addDependency(tree, "root", "outside");
    expect(timelineIssues(tree, "child")).toEqual(expect.arrayContaining([expect.objectContaining({ type: "childAfterParent", relatedTaskId: "root" })]));
    expect(scheduleShiftIssues(tree, "root", 2)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "dependencyAfterDeadline", taskId: "outside", relatedTaskId: "root" }), expect.objectContaining({ type: "dependencyAfterStart", taskId: "outside" })]));
    expect(tree.items[0].dueDate).toBe("2026-10-01");
  });
});

describe("dependency tracing", () => {
  it("emphasizes the full inherited prerequisite chain and immediate work unblocked", () => {
    let tree = data(task("root"), task("leaf", { parentTaskId: "root" }), task("first"), task("approval"), task("after"), task("unrelated"));
    tree = addDependency(tree, "first", "approval"); tree = addDependency(tree, "approval", "root"); tree = addDependency(tree, "leaf", "after");
    const trace = dependencyTrace(tree, "leaf");
    expect([...trace.taskIds]).toEqual(expect.arrayContaining(["leaf", "root", "first", "approval", "after"]));
    expect(trace.taskIds.has("unrelated")).toBe(false); expect(trace.edgeIds.size).toBe(3);
  });

  it("stops the unresolved chain at fulfilled prerequisites while retaining unavailable ones for review", () => {
    let tree = data(task("target"), task("done", { completed: true }), task("beforeDone"), task("canceled", { status: "canceled" }));
    tree = addDependency(tree, "beforeDone", "done"); tree = addDependency(tree, "done", "target"); tree = addDependency(tree, "canceled", "target");
    const trace = dependencyTrace(tree, "target");
    expect(trace.taskIds.has("beforeDone")).toBe(false); expect(trace.taskIds.has("done")).toBe(false);
    expect([...trace.unavailableIds]).toEqual(["canceled"]); expect(trace.edgeIds.size).toBe(1);
  });
});
