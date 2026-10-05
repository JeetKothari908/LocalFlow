import { Data, Task } from "./types";
import { ancestorsOf, blockersOf, descendantsOf, isTaskActive, validateTaskGraph } from "./tasks";

/** The unfinished prerequisite chain, including constraints inherited through ancestors. */
export function dependencyTrace(data: Data, id: string): { taskIds: Set<string>; edgeIds: Set<string>; unavailableIds: Set<string> } {
  const tasks = new Map(data.items.map((task) => [task.id, task]));
  const branch = new Set([id, ...descendantsOf(data, id).filter((task) => isTaskActive(data, task)).map((task) => task.id)]);
  const taskIds = new Set(branch), edgeIds = new Set<string>(), unavailableIds = new Set<string>();
  const pending = [...branch], visited = new Set<string>();
  for (let position = 0; position < pending.length; position++) {
    const currentId = pending[position], current = tasks.get(currentId);
    if (!current || visited.has(currentId) || !isTaskActive(data, current)) continue;
    visited.add(currentId);
    const sources = new Set([currentId, ...ancestorsOf(data, currentId).map((task) => task.id)]);
    const blockers = new Set(blockersOf(data, currentId).map((task) => task.id));
    for (const edge of data.dependencies ?? []) {
      if (edge.deletedAt || !sources.has(edge.dependentTaskId) || !blockers.has(edge.prerequisiteTaskId)) continue;
      edgeIds.add(edge.id); taskIds.add(edge.dependentTaskId); taskIds.add(edge.prerequisiteTaskId);
      const prerequisite = tasks.get(edge.prerequisiteTaskId)!;
      if (!isTaskActive(data, prerequisite)) { unavailableIds.add(prerequisite.id); continue; }
      for (const task of [prerequisite, ...descendantsOf(data, prerequisite.id)].filter((item) => isTaskActive(data, item))) {
        taskIds.add(task.id); pending.push(task.id);
      }
    }
  }
  for (const edge of data.dependencies ?? []) {
    if (!edge.deletedAt && branch.has(edge.prerequisiteTaskId)) { edgeIds.add(edge.id); taskIds.add(edge.dependentTaskId); }
  }
  return { taskIds, edgeIds, unavailableIds };
}

export type ScheduledTask = {
  taskId: string; start: number; finish: number; floatMinutes?: number;
  critical: boolean; lateMinutes: number; summary: boolean;
};
export type ScheduleAnalysis = {
  rows: ScheduledTask[]; missingEstimateIds: string[]; missingStartIds: string[];
  unavailableIds: string[]; targetDeadline?: number; earliestFinish?: number;
  deadlineMarginMinutes?: number; criticalTaskIds: string[];
};
const startNode = (id: string) => `start:${id}`;
const finishNode = (id: string) => `finish:${id}`;
const calendarTime = (date: string, time = "00:00") => new Date(`${date}T${time}:00`).getTime();
const deadlineTime = (task: Task) => task.dueDate ? calendarTime(task.dueDate, task.dueTime ?? "23:59") : undefined;

function plannedStarts(data: Data): Map<string, number> {
  const index = new Map(data.items.map((task) => [task.id, task])), starts = new Map<string, number>();
  for (const task of data.items) {
    const path: Task[] = [];
    let cursor: Task | undefined = task;
    while (cursor && !starts.has(cursor.id)) { path.push(cursor); cursor = cursor.parentTaskId ? index.get(cursor.parentTaskId) : undefined; }
    let inherited = cursor ? starts.get(cursor.id)! : -Infinity;
    for (const item of path.reverse()) {
      inherited = Math.max(inherited, item.plannedStart ? calendarTime(item.plannedStart) : -Infinity);
      starts.set(item.id, inherited);
    }
  }
  return starts;
}

/** Read-only, continuous-effort scenario. No guessed starts, estimates, or persisted dates. */
export function analyzeSchedule(data: Data, id: string): ScheduleAnalysis {
  validateTaskGraph(data);
  const target = data.items.find((task) => task.id === id);
  if (!target) throw new Error("Task does not exist.");
  const selected = [target, ...descendantsOf(data, id)].filter((task) => isTaskActive(data, task));
  const scope = new Set(selected.map((task) => task.id)), pending = [...scope], unavailableIds = new Set<string>();
  for (let position = 0; position < pending.length; position++) {
    for (const prerequisite of blockersOf(data, pending[position])) {
      if (!isTaskActive(data, prerequisite)) { unavailableIds.add(prerequisite.id); continue; }
      for (const task of [prerequisite, ...descendantsOf(data, prerequisite.id)].filter((item) => isTaskActive(data, item))) {
        if (!scope.has(task.id)) { scope.add(task.id); pending.push(task.id); }
      }
    }
  }
  const tasks = data.items.filter((task) => scope.has(task.id));
  const parents = new Set(tasks.map((task) => task.parentTaskId));
  const leaves = tasks.filter((task) => !parents.has(task.id));
  const missingEstimateIds = leaves.filter((task) => task.estimatedMinutes == null || !Number.isFinite(task.estimatedMinutes) || task.estimatedMinutes < 0).map((task) => task.id);
  const result: ScheduleAnalysis = { rows: [], missingEstimateIds, missingStartIds: [], unavailableIds: [...unavailableIds], targetDeadline: deadlineTime(target), criticalTaskIds: [] };
  if (!scope.has(id)) return result;

  const outgoing = new Map<string, Map<string, number>>(), indegree = new Map<string, number>();
  const earliest = new Map<string, number>(), previous = new Map<string, string>();
  const starts = plannedStarts(data);
  for (const task of tasks) {
    indegree.set(startNode(task.id), 0); indegree.set(finishNode(task.id), 0);
    // Ancestor planned starts constrain this branch without copying dates into children.
    earliest.set(startNode(task.id), starts.get(task.id)!);
    earliest.set(finishNode(task.id), -Infinity);
  }
  const add = (from: string, to: string, weight = 0) => {
    const links = outgoing.get(from) ?? new Map<string, number>();
    if (!links.has(to)) { links.set(to, weight); indegree.set(to, indegree.get(to)! + 1); }
    outgoing.set(from, links);
  };
  for (const task of tasks) {
    add(startNode(task.id), finishNode(task.id), parents.has(task.id) ? 0 : (task.estimatedMinutes ?? 0) * 60000);
    if (task.parentTaskId && scope.has(task.parentTaskId)) {
      add(startNode(task.parentTaskId), startNode(task.id)); add(finishNode(task.id), finishNode(task.parentTaskId));
    }
    for (const prerequisite of blockersOf(data, task.id)) {
      if (scope.has(prerequisite.id)) add(finishNode(prerequisite.id), startNode(task.id));
    }
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([node]) => node);
  for (let position = 0; position < queue.length; position++) {
    const from = queue[position];
    for (const [to, weight] of outgoing.get(from) ?? []) {
      const candidate = earliest.get(from)! + weight;
      // Keep zero-effort prerequisite/child links traceable when their timestamps tie.
      const tiedLink = Number.isFinite(candidate) && candidate === earliest.get(to)
        && (!previous.has(to) || from.startsWith("finish:"));
      if (candidate > earliest.get(to)! || tiedLink) { earliest.set(to, candidate); previous.set(to, from); }
      indegree.set(to, indegree.get(to)! - 1);
      if (!indegree.get(to)) queue.push(to);
    }
  }
  result.missingStartIds = leaves.filter((task) => !Number.isFinite(earliest.get(startNode(task.id)))).map((task) => task.id);
  if (missingEstimateIds.length || result.missingStartIds.length || unavailableIds.size) return result;
  const finish = earliest.get(finishNode(id))!;
  if (!Number.isFinite(finish)) return result;
  result.earliestFinish = finish;
  const children = new Map<string, string[]>();
  const displayStarts = new Map(tasks.map((task) => [task.id, earliest.get(startNode(task.id))!]));
  for (const task of tasks) if (task.parentTaskId && scope.has(task.parentTaskId)) children.set(task.parentTaskId, [...(children.get(task.parentTaskId) ?? []), task.id]);
  for (const node of queue) if (node.startsWith("finish:")) {
    const taskId = node.slice(7);
    if (!Number.isFinite(displayStarts.get(taskId))) displayStarts.set(taskId, Math.min(...(children.get(taskId) ?? []).map((childId) => displayStarts.get(childId)!)));
  }
  const latest = new Map(queue.map((node) => [node, Infinity]));
  latest.set(finishNode(id), finish);
  for (const from of [...queue].reverse()) {
    for (const [to, weight] of outgoing.get(from) ?? []) latest.set(from, Math.min(latest.get(from)!, latest.get(to)! - weight));
  }
  const hasDeadline = result.targetDeadline != null;
  if (hasDeadline) {
    result.deadlineMarginMinutes = (result.targetDeadline! - finish) / 60000;
    let cursor: string | undefined = finishNode(id);
    while (cursor) {
      if (cursor.startsWith("finish:") && previous.get(cursor) === startNode(cursor.slice(7)) && !parents.has(cursor.slice(7))) result.criticalTaskIds.push(cursor.slice(7));
      cursor = previous.get(cursor);
    }
    result.criticalTaskIds.reverse();
  }
  result.rows = tasks.map((task) => {
    const start = earliest.get(startNode(task.id))!, finish = earliest.get(finishNode(task.id))!;
    const floatMinutes = hasDeadline ? Math.max(0, (latest.get(finishNode(task.id))! - finish) / 60000) : undefined;
    const due = deadlineTime(task);
    return { taskId: task.id, start: displayStarts.get(task.id)!, finish,
      floatMinutes, critical: floatMinutes != null && floatMinutes < 0.00001,
      lateMinutes: due == null ? 0 : Math.max(0, (finish - due) / 60000), summary: parents.has(task.id) };
  });
  return result;
}
