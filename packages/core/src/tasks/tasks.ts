import { nanoid } from "nanoid";
import { Data, Dependency, NormalizedTaskData, Task, TaskActivity } from "./types";

export type TaskInput = Partial<Omit<Task, "id">> & { contents: string; id?: string };
export type ScheduleChange = {
  taskId: string;
  fromDueDate?: string;
  toDueDate?: string;
  fromPlannedStart?: string;
  toPlannedStart?: string;
};
export type TimelineIssue = {
  taskId: string;
  relatedTaskId?: string;
  type: "childAfterParent" | "dependencyAfterDeadline" | "dependencyAfterStart" | "unscheduled" | "startAfterDeadline";
  message: string;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
export const localDate = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const terminal = (task: Task) => task.completed || task.status === "done" || task.status === "canceled";
export const isTaskActive = (data: Data, task: Task) => !terminal(task) && !hiddenTaskIds(data).has(task.id);
const unavailable = (task: Task) => !!(task.deletedAt || task.archivedAt || task.dismissed);
const compareTasks = (a: Task, b: Task) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
const indexCache = new WeakMap<Task[], Map<string, Task>>();
const hiddenCache = new WeakMap<Task[], Set<string>>();
const blockerCache = new WeakMap<Data, Map<string, Task[]>>();
const dependencyCache = new WeakMap<Data, Map<string, Dependency[]>>();
const taskIndex = (data: Data) => {
  let index = indexCache.get(data.items);
  if (!index) { index = new Map(data.items.map((task) => [task.id, task])); indexCache.set(data.items, index); }
  return index;
};

function hiddenTaskIds(data: Data): Set<string> {
  const cached = hiddenCache.get(data.items);
  if (cached) return cached;
  const index = taskIndex(data);
  const hidden = new Map<string, boolean>();
  for (const task of data.items) {
    if (hidden.has(task.id)) continue;
    const path: Task[] = [];
    const seen = new Set<string>();
    let cursor: Task | undefined = task;
    let result = false;
    while (cursor && !seen.has(cursor.id)) {
      if (hidden.has(cursor.id)) { result = hidden.get(cursor.id)!; break; }
      seen.add(cursor.id);
      path.push(cursor);
      if (unavailable(cursor) || cursor.status === "canceled") { result = true; break; }
      cursor = cursor.parentTaskId ? index.get(cursor.parentTaskId) : undefined;
    }
    path.forEach((item) => hidden.set(item.id, result));
  }
  const result = new Set([...hidden].filter(([, value]) => value).map(([id]) => id));
  hiddenCache.set(data.items, result);
  return result;
}

function requireTask(data: Data, id: string): Task {
  const task = data.items.find((item) => item.id === id);
  if (!task) throw new Error("Task does not exist.");
  return task;
}

function validDate(value?: string) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(value: string, days: number): string {
  if (!validDate(value)) throw new Error("Use a valid date in YYYY-MM-DD format.");
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDistance(a: string, b: string) {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
}

function record(data: NormalizedTaskData, type: string, taskId?: string, detail?: string): NormalizedTaskData {
  const event: TaskActivity = { id: nanoid(), taskId, type, at: now(), detail };
  return { ...data, activity: [...data.activity, event] };
}

function metadataChanges(before: Task, after: Task): string {
  const changes: string[] = [];
  const transition = (label: string, old: string, next: string) => { if (old !== next) changes.push(`${label}: ${old} → ${next}`); };
  const deadline = (task: Task) => task.dueDate ? `${task.dueDate}${task.dueTime ? ` at ${task.dueTime}` : ""}` : "No deadline";
  transition("Title", before.contents, after.contents);
  transition("Deadline", deadline(before), deadline(after));
  transition("Planned start", before.plannedStart ?? "Not planned", after.plannedStart ?? "Not planned");
  transition("Priority", before.priority ?? "normal", after.priority ?? "normal");
  transition("Estimate", before.estimatedMinutes == null ? "Not estimated" : `${before.estimatedMinutes} min`, after.estimatedMinutes == null ? "Not estimated" : `${after.estimatedMinutes} min`);
  const recurrence = (task: Task) => {
    const repeat = task.repeat;
    if (!repeat) return "None";
    if (repeat.type === "monthly") return `Monthly, day ${repeat.day ?? (task.dueDate ? Number(task.dueDate.slice(8, 10)) : "of deadline")}`;
    if (repeat.type === "daily") return "Daily";
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${repeat.type === "weekly" ? "Weekly" : "Selected weekdays"}${repeat.days?.length ? ` (${repeat.days.map((day) => names[day]).join(", ")})` : ""}`;
  };
  transition("Recurrence", recurrence(before), recurrence(after));
  transition("Repeat scope", before.repeatScope ?? "task", after.repeatScope ?? "task");
  transition("State", before.status ?? "todo", after.status ?? "todo");
  if (before.description !== after.description) changes.push("Description updated");
  return changes.join("; ") || "Task details updated";
}

/** Boundary migration is idempotent and keeps a complete original legacy document. */
export function normalizeTaskData(value?: Partial<Data>): NormalizedTaskData {
  const raw = value ?? {};
  const legacy = raw.schemaVersion !== 2;
  const occurrences = clone(raw.occurrences ?? []);
  const seen = new Set<string>();
  const items: Task[] = [];
  const siblingOrders = new Map<string, number>();
  for (const original of raw.items ?? []) {
    if (!original || typeof original.id !== "string" || seen.has(original.id)) continue;
    seen.add(original.id);
    const task = { ...original };
    if (legacy && task.parentId && task.completed) {
      if (!occurrences.some((occurrence) => occurrence.id === task.id)) {
        occurrences.push({
          id: task.id,
          taskId: task.parentId,
          completedAt: task.completedAt ?? (validDate(task.dueDate) && task.dueDate ? `${task.dueDate}T12:00:00.000Z` : "1970-01-01T00:00:00.000Z"),
          dueDate: task.dueDate,
          items: [{ ...task, parentId: undefined, status: "done", completed: true }],
        });
      }
      continue;
    }
    delete task.parentId;
    task.contents = String(task.contents ?? "");
    task.status = task.status ?? (task.completed ? "done" : "todo");
    task.completed = task.status === "done";
    if (legacy && task.repeat && !task.dueDate && !terminal(task)) task.dueDate = firstRepeatDate(task);
    if (task.estimatedMinutes != null && (!Number.isFinite(task.estimatedMinutes) || task.estimatedMinutes < 0)) delete task.estimatedMinutes;
    const group = task.parentTaskId ?? `list:${task.listId ?? ""}`;
    task.order = Number.isFinite(task.order) ? task.order : siblingOrders.get(group) ?? 0;
    siblingOrders.set(group, (siblingOrders.get(group) ?? 0) + 1);
    items.push(task);
  }
  // Repair imported dangling parents and corrupt cycles without dropping any task.
  const index = new Map(items.map((task) => [task.id, task]));
  for (const task of items) {
    if (task.parentTaskId && !index.has(task.parentTaskId)) delete task.parentTaskId;
  }
  const finished = new Set<string>();
  for (const task of items) {
    const path = new Set<string>();
    let cursor: Task | undefined = task;
    while (cursor && !finished.has(cursor.id)) {
      if (path.has(cursor.id)) { delete cursor.parentTaskId; break; }
      path.add(cursor.id);
      cursor = cursor.parentTaskId ? index.get(cursor.parentTaskId) : undefined;
    }
    path.forEach((id) => finished.add(id));
  }
  const customLists = clone(raw.customLists ?? []);
  const listIds = new Set(customLists.filter((list) => !list.deletedAt).map((list) => list.id));
  for (const task of items) {
    if (task.parentTaskId || (task.listId && !listIds.has(task.listId))) delete task.listId;
  }
  // Reconcile imported completed ancestors when unfinished descendants exist.
  const hidden = hiddenTaskIds({ items, show: 3 });
  const reconciled = new Set<string>();
  for (const task of items) {
    if (terminal(task) || hidden.has(task.id)) continue;
    let cursor = task.parentTaskId ? index.get(task.parentTaskId) : undefined;
    while (cursor && !reconciled.has(cursor.id)) {
      reconciled.add(cursor.id);
      if (cursor.completed) { cursor.completed = false; cursor.status = "todo"; delete cursor.completedAt; }
      cursor = cursor.parentTaskId ? index.get(cursor.parentTaskId) : undefined;
    }
  }
  const dependencies = clone(raw.dependencies ?? []).filter((dependency) =>
    index.has(dependency.prerequisiteTaskId) && index.has(dependency.dependentTaskId),
  );
  return {
    ...raw,
    items,
    show: typeof raw.show === "number" ? raw.show : 3,
    keyBind: raw.keyBind ?? "T",
    customLists,
    schemaVersion: 2,
    dependencies,
    occurrences,
    activity: clone(raw.activity ?? []),
    ...(legacy && value && raw.items ? { legacyBackup: raw.legacyBackup ?? clone(raw) } : {}),
  };
}

/** All tree traversal is iterative so imported trees have no recursion depth limit. */
export function childrenOf(data: Data, id?: string, includeUnavailable = false): Task[] {
  return data.items.filter((task) => task.parentTaskId === id && (includeUnavailable || !unavailable(task))).sort(compareTasks);
}

export function descendantsOf(data: Data, id: string, includeUnavailable = false): Task[] {
  const children = new Map<string, Task[]>();
  for (const task of data.items) {
    if (!task.parentTaskId) continue;
    const group = children.get(task.parentTaskId) ?? [];
    group.push(task);
    children.set(task.parentTaskId, group);
  }
  for (const group of children.values()) group.sort(compareTasks);
  const stack = [...(children.get(id) ?? [])].reverse();
  const result: Task[] = [];
  const seen = new Set([id]);
  while (stack.length) {
    const task = stack.pop()!;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    if (!includeUnavailable && unavailable(task)) continue;
    result.push(task);
    stack.push(...[...(children.get(task.id) ?? [])].reverse());
  }
  return result;
}

export function ancestorsOf(data: Data, id: string): Task[] {
  const index = taskIndex(data);
  const result: Task[] = [];
  const seen = new Set([id]);
  let parentId = index.get(id)?.parentTaskId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = index.get(parentId);
    if (!parent) break;
    result.push(parent);
    parentId = parent.parentTaskId;
  }
  return result;
}

export function rootOf(data: Data, id: string): Task | undefined {
  const parents = ancestorsOf(data, id);
  return parents.length ? parents[parents.length - 1] : data.items.find((task) => task.id === id);
}

export function taskPath(data: Data, id: string): Task[] {
  const task = data.items.find((item) => item.id === id);
  return task ? [...ancestorsOf(data, id).reverse(), task] : [];
}

export function blockersOf(data: Data, id: string): Task[] {
  if (!data.dependencies?.length) return [];
  let cached = blockerCache.get(data);
  if (!cached) { cached = new Map(); blockerCache.set(data, cached); }
  if (cached.has(id)) return [...cached.get(id)!];
  const index = taskIndex(data);
  let direct = dependencyCache.get(data);
  if (!direct) {
    direct = new Map();
    for (const dependency of data.dependencies) {
      if (dependency.deletedAt) continue;
      const group = direct.get(dependency.dependentTaskId) ?? [];
      group.push(dependency);
      direct.set(dependency.dependentTaskId, group);
    }
    dependencyCache.set(data, direct);
  }
  const path: Task[] = [];
  const seen = new Set<string>();
  let cursor = index.get(id);
  while (cursor && !cached.has(cursor.id) && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentTaskId ? index.get(cursor.parentTaskId) : undefined;
  }
  const inherited = new Map((cursor ? cached.get(cursor.id) ?? [] : []).map((task) => [task.id, task]));
  for (let position = path.length - 1; position >= 0; position--) {
    for (const dependency of direct.get(path[position].id) ?? []) {
      const prerequisite = index.get(dependency.prerequisiteTaskId);
      // Archiving fulfilled work preserves its satisfaction. Trash/cancellation need review.
      if (prerequisite && (!prerequisite.completed || prerequisite.status === "canceled" || prerequisite.deletedAt)) inherited.set(prerequisite.id, prerequisite);
    }
    cached.set(path[position].id, [...inherited.values()]);
  }
  return [...(cached.get(id) ?? [])];
}

export function dueTasks(data: Data, today = localDate()): Task[] {
  const hidden = hiddenTaskIds(data);
  return data.items.filter((task) => !terminal(task) && !hidden.has(task.id) && task.dueDate && task.dueDate <= today)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || (a.dueTime ?? "23:59").localeCompare(b.dueTime ?? "23:59") || compareTasks(a, b));
}

/** Retain the nearest source of each blocker; direct links take precedence. */
export function blockerDetails(data: Data, id: string): Array<{ task: Task; inheritedFrom?: Task }> {
  const unresolved = new Map(blockersOf(data, id).map((task) => [task.id, task]));
  if (!unresolved.size) return [];
  const details = new Map<string, { task: Task; inheritedFrom?: Task }>();
  for (const source of taskPath(data, id).reverse()) {
    for (const edge of data.dependencies ?? []) {
      const task = unresolved.get(edge.prerequisiteTaskId);
      if (!edge.deletedAt && edge.dependentTaskId === source.id && task && !details.has(task.id)) {
        details.set(task.id, { task, inheritedFrom: source.id === id ? undefined : source });
      }
    }
  }
  return [...details.values()];
}

export function taskSummary(data: Data, id: string, today = localDate()): { dueToday: number; overdue: number; blocked: number; unscheduled: number; next?: Task } {
  const hidden = hiddenTaskIds(data);
  const descendants = descendantsOf(data, id).filter((task) => !terminal(task) && !hidden.has(task.id));
  const branch = [requireTask(data, id), ...descendants].filter((task) => !terminal(task) && !hidden.has(task.id));
  const dated = descendants.filter((task) => task.dueDate).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || (a.dueTime ?? "23:59").localeCompare(b.dueTime ?? "23:59") || compareTasks(a, b));
  return {
    dueToday: branch.filter((task) => task.dueDate === today).length,
    overdue: branch.filter((task) => task.dueDate && task.dueDate < today).length,
    blocked: branch.filter((task) => blockersOf(data, task.id).length).length,
    unscheduled: descendants.filter((task) => !task.dueDate).length,
    next: dated[0],
  };
}

export type OutlineRow = { task: Task; depth: number; guides: boolean[]; isLast: boolean };
export function outlineRows(data: Data, id: string, expanded: Set<string>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const makeRows = (parentId: string, guides: boolean[]): OutlineRow[] => {
    const children = childrenOf(data, parentId);
    return children.map((task, index) => ({ task, depth: guides.length, guides, isLast: index === children.length - 1 }));
  };
  const stack = makeRows(id, []).reverse();
  const seen = new Set([id]);
  while (stack.length) {
    const row = stack.pop()!;
    if (seen.has(row.task.id)) continue;
    seen.add(row.task.id); rows.push(row);
    if (expanded.has(row.task.id)) stack.push(...makeRows(row.task.id, [...row.guides, !row.isLast]).reverse());
  }
  return rows;
}

export function taskProgress(data: Data, id: string): { completed: number; total: number; readyToComplete: boolean } {
  const allDescendants = descendantsOf(data, id);
  const hidden = hiddenTaskIds(data);
  const descendants = allDescendants.filter((task) => !hidden.has(task.id));
  const parents = new Set(descendants.map((task) => task.parentTaskId));
  const leaves = descendants.filter((task) => !parents.has(task.id));
  return {
    completed: leaves.filter((task) => task.completed).length,
    total: leaves.length,
    readyToComplete: allDescendants.length > 0 && descendants.every(terminal) && blockersOf(data, id).length === 0,
  };
}

function reopenAncestors(data: NormalizedTaskData, id: string): NormalizedTaskData {
  const ids = new Set(ancestorsOf(data, id).filter(terminal).map((task) => task.id));
  if (!ids.size) return data;
  const at = now();
  const result = { ...data, items: data.items.map((task) => ids.has(task.id) ? { ...task, completed: false, completedAt: undefined, status: "todo" as const, updatedAt: at } : task) };
  const names = data.items.filter((task) => ids.has(task.id)).map((task) => task.contents);
  return record(result, "ancestorsReopened", id, `Reopened parent tasks: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`);
}

function validateMetadata(task: Task) {
  if (!task.contents.trim()) throw new Error("Task title is required.");
  if (!validDate(task.dueDate) || !validDate(task.plannedStart)) throw new Error("Use a valid date in YYYY-MM-DD format.");
  if (task.dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.dueTime)) throw new Error("Use a valid time in HH:MM format.");
  if (task.estimatedMinutes != null && (!Number.isFinite(task.estimatedMinutes) || task.estimatedMinutes < 0)) throw new Error("Estimated effort must be a nonnegative number of minutes.");
  if (task.repeat?.type === "custom" && !task.repeat.days.length) throw new Error("Choose at least one repeat weekday.");
  if ((task.repeat?.type === "custom" || task.repeat?.type === "weekly") && task.repeat.days?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Repeat weekdays must be between Sunday (0) and Saturday (6).");
  if ((task.repeat?.type === "custom" || task.repeat?.type === "weekly") && task.repeat.days && new Set(task.repeat.days).size !== task.repeat.days.length) throw new Error("Repeat weekdays must be unique.");
  if (task.repeat?.type === "monthly" && task.repeat.day != null && (!Number.isInteger(task.repeat.day) || task.repeat.day < 1 || task.repeat.day > 31)) throw new Error("Monthly repeat day must be between 1 and 31.");
}

/** Capture the first scheduled occurrence when recurrence is configured without a deadline. */
function firstRepeatDate(task: Task, today = localDate()): string {
  const repeat = task.repeat!;
  if (repeat.type === "daily") return today;
  if (repeat.type === "monthly") {
    const day = repeat.day ?? Number(today.slice(8, 10));
    const date = new Date(`${today}T00:00:00Z`);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const candidate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), Math.min(day, lastDay))).toISOString().slice(0, 10);
    return candidate >= today ? candidate : nextRepeatDate(task, today);
  }
  const selected = repeat.days?.length ? repeat.days : [new Date(`${today}T00:00:00Z`).getUTCDay()];
  for (let offset = 0; offset < 7; offset++) {
    const candidate = addDays(today, offset);
    if (selected.includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) return candidate;
  }
  throw new Error("Repeat schedule has no valid occurrence.");
}

/** Start/finish vertices encode inherited blockers and child completion in linear space. */
export function validateTaskGraph(data: Data): void {
  const index = taskIndex(data);
  const edges = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const task of data.items) { indegree.set(`start:${task.id}`, 0); indegree.set(`finish:${task.id}`, 0); }
  const add = (from: string, to: string) => {
    if (!indegree.has(from) || !indegree.has(to)) throw new Error("Dependency references a missing task.");
    const destinations = edges.get(from) ?? new Set<string>();
    if (!destinations.has(to)) { destinations.add(to); indegree.set(to, (indegree.get(to) ?? 0) + 1); }
    edges.set(from, destinations);
  };
  for (const task of data.items) {
    add(`start:${task.id}`, `finish:${task.id}`);
    if (task.parentTaskId) { add(`start:${task.parentTaskId}`, `start:${task.id}`); add(`finish:${task.id}`, `finish:${task.parentTaskId}`); }
  }
  for (const dependency of data.dependencies ?? []) {
    if (dependency.deletedAt) continue;
    add(`finish:${dependency.prerequisiteTaskId}`, `start:${dependency.dependentTaskId}`);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => !degree).map(([id]) => id);
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    visited++;
    for (const id of edges.get(queue[i]) ?? []) {
      const degree = indegree.get(id)! - 1;
      indegree.set(id, degree);
      if (!degree) queue.push(id);
    }
  }
  if (visited !== data.items.length * 2) throw new Error("This relationship would create a circular dependency or make a task wait on its own branch.");
  const hidden = hiddenTaskIds(data);
  const completion = new Map<string, boolean>();
  const deletedBranch = new Map<string, boolean>();
  for (const task of data.items) {
    if (completion.has(task.id)) continue;
    const path: Task[] = [];
    let cursor: Task | undefined = task;
    while (cursor && !completion.has(cursor.id)) {
      path.push(cursor);
      cursor = cursor.parentTaskId ? index.get(cursor.parentTaskId) : undefined;
    }
    let ancestorDone = cursor ? completion.get(cursor.id)! : false;
    let ancestorDeleted = cursor ? deletedBranch.get(cursor.id)! : false;
    for (let i = path.length - 1; i >= 0; i--) {
      const item = path[i];
      if (ancestorDeleted && !item.deletedAt) throw new Error("Live work cannot be placed beneath a deleted task. Restore the parent first.");
      if (ancestorDone && !item.completed && !hidden.has(item.id)) throw new Error("Unfinished work must reopen its completed ancestors.");
      ancestorDone = ancestorDone || item.completed;
      ancestorDeleted = ancestorDeleted || !!item.deletedAt;
      completion.set(item.id, ancestorDone);
      deletedBranch.set(item.id, ancestorDeleted);
    }
  }
}

export function createTask(data: Data, input: TaskInput): NormalizedTaskData {
  let result = normalizeTaskData(data);
  const id = input.id ?? nanoid();
  if (result.items.some((task) => task.id === id)) throw new Error("Task ID already exists.");
  if (input.parentTaskId && unavailable(requireTask(result, input.parentTaskId))) throw new Error("Restore the parent task before adding subtasks.");
  const at = now();
  const task: Task = {
    ...input, id, contents: input.contents.trim(), completed: input.status ? input.status === "done" : input.completed ?? false,
    status: input.status ?? (input.completed ? "done" : "todo"), priority: input.priority ?? "normal",
    listId: input.parentTaskId ? undefined : input.listId,
    order: input.order ?? childrenOf(result, input.parentTaskId, true).filter((item) => input.parentTaskId || item.listId === input.listId).length,
    createdAt: at, updatedAt: at,
  };
  validateMetadata(task);
  if (task.repeat && !task.dueDate && !terminal(task)) task.dueDate = firstRepeatDate(task);
  if (!task.parentTaskId && task.listId && !result.customLists.some((list) => list.id === task.listId && !list.deletedAt)) throw new Error("List does not exist.");
  result = { ...result, items: [...result.items, task] };
  if (!terminal(task)) result = reopenAncestors(result, id);
  validateTaskGraph(result);
  return record(result, "created", id, task.contents);
}

export function updateTask(data: Data, id: string, patch: Partial<Omit<Task, "id">>): NormalizedTaskData {
  let result = normalizeTaskData(data);
  const previous = requireTask(result, id);
  if (Object.prototype.hasOwnProperty.call(patch, "parentTaskId") || Object.prototype.hasOwnProperty.call(patch, "listId")) {
    result = moveTask(result, id, Object.prototype.hasOwnProperty.call(patch, "parentTaskId") ? patch.parentTaskId : previous.parentTaskId,
      Object.prototype.hasOwnProperty.call(patch, "listId") ? patch.listId : previous.listId);
  }
  const { parentTaskId: _parent, listId: _list, completed: completedPatch, status: statusPatch, ...metadata } = patch;
  let task = { ...requireTask(result, id), ...metadata, updatedAt: now() };
  if (metadata.contents != null) task.contents = metadata.contents.trim();
  validateMetadata(task);
  if (task.repeat && !task.dueDate && !terminal(task)) task.dueDate = firstRepeatDate(task);
  result = { ...result, items: result.items.map((item) => item.id === id ? task : item) };
  if (completedPatch === true || statusPatch === "done") return completeTask(result, id);
  if (completedPatch === false || statusPatch) {
    if (statusPatch === "inProgress" && blockersOf(result, id).length) throw new Error("Resolve prerequisites before starting this task.");
    task = { ...task, completed: false, completedAt: undefined, status: statusPatch ?? "todo" };
    result = { ...result, items: result.items.map((item) => item.id === id ? task : item) };
    if (!terminal(task)) result = reopenAncestors(result, id);
  }
  return record(result, statusPatch === "canceled" ? "canceled" : "updated", id, metadataChanges(previous, task));
}

export function moveTask(data: Data, id: string, parentTaskId?: string, listId?: string, index?: number): NormalizedTaskData {
  let result = normalizeTaskData(data);
  const task = requireTask(result, id);
  if (parentTaskId) {
    const parent = requireTask(result, parentTaskId);
    if (unavailable(parent)) throw new Error("Restore the destination task first.");
    if (parentTaskId === id || descendantsOf(result, id, true).some((item) => item.id === parentTaskId)) throw new Error("A task cannot be moved into its own subtasks.");
  } else if (listId && !result.customLists.some((list) => list.id === listId && !list.deletedAt)) throw new Error("List does not exist.");
  const siblings = childrenOf(result, parentTaskId, true).filter((item) => item.id !== id && (parentTaskId || item.listId === listId));
  const position = index == null ? siblings.length : Math.max(0, Math.min(siblings.length, index));
  const updated = { ...task, parentTaskId, listId: parentTaskId ? undefined : listId, updatedAt: now() };
  siblings.splice(position, 0, updated);
  const positions = new Map(siblings.map((item, order) => [item.id, order]));
  result = { ...result, items: result.items.map((item) => item.id === id ? { ...updated, order: position } : positions.has(item.id) ? { ...item, order: positions.get(item.id), updatedAt: updated.updatedAt } : item) };
  if (!terminal(task)) result = reopenAncestors(result, id);
  validateTaskGraph(result);
  return record(result, "moved", id, parentTaskId ? `Moved under ${requireTask(result, parentTaskId).contents}` : `Moved to ${result.customLists.find((list) => list.id === listId)?.name ?? "Inbox"}`);
}

function nextRepeatDate(task: Task, today: string): string {
  const base = task.dueDate && task.dueDate > today ? task.dueDate : today;
  const repeat = task.repeat!;
  if (repeat.type === "daily") return addDays(base, 1);
  if (repeat.type === "monthly") {
    const preferredDay = repeat.day ?? Number((task.dueDate ?? base).slice(8, 10));
    const cursor = new Date(`${base}T00:00:00Z`);
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    for (let offset = 0; offset < 3; offset++) {
      const lastDay = new Date(Date.UTC(year, month + offset + 1, 0)).getUTCDate();
      const candidate = new Date(Date.UTC(year, month + offset, Math.min(preferredDay, lastDay))).toISOString().slice(0, 10);
      if (candidate > base) return candidate;
    }
  }
  const days = repeat.type === "custom" ? repeat.days : repeat.type === "weekly" ? repeat.days : undefined;
  const selected = days?.length ? days : [new Date(`${task.dueDate ?? base}T00:00:00Z`).getUTCDay()];
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = addDays(base, offset);
    if (selected.includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) return candidate;
  }
  throw new Error("Repeat schedule has no valid next occurrence.");
}

export function completeTask(data: Data, id: string, options: { cascade?: boolean; permanent?: boolean } = {}): NormalizedTaskData {
  let result = normalizeTaskData(data);
  const task = requireTask(result, id);
  if (hiddenTaskIds(result).has(id)) throw new Error("Restore this task's branch before completing it.");
  const descendants = descendantsOf(result, id);
  const hidden = hiddenTaskIds(result);
  const activeDescendants = descendants.filter((item) => !hidden.has(item.id));
  const unfinished = activeDescendants.filter((item) => !terminal(item));
  if (unfinished.length && !options.cascade) throw new Error("This task has unfinished subtasks. Complete them or explicitly complete the whole branch.");
  const ids = new Set([id, ...(options.cascade ? unfinished.map((item) => item.id) : [])]);
  const blocked = [...ids].some((taskId) => blockersOf(result, taskId).some((blocker) => !ids.has(blocker.id)));
  if (blocked) throw new Error("Resolve prerequisites before completing this task.");
  const at = now();
  result = { ...result, items: result.items.map((item) => ids.has(item.id) && !terminal(item) ? { ...item, completed: true, status: "done" as const, completedAt: at, updatedAt: at } : item) };
  if (task.repeat && !options.permanent) {
    const branch = task.repeatScope === "branch" || (task.repeatScope == null && descendants.length > 0);
    if (descendants.length && !branch) throw new Error("Tasks with subtasks must repeat their branch or be completed permanently.");
    const snapshotIds = new Set([id, ...descendants.map((item) => item.id)]);
    const occurrence = {
      id: nanoid(), taskId: id, dueDate: task.dueDate, completedAt: at,
      items: clone([requireTask(result, id), ...descendantsOf(result, id)]),
      dependencies: clone(result.dependencies.filter((dependency) => !dependency.deletedAt && snapshotIds.has(dependency.prerequisiteTaskId) && snapshotIds.has(dependency.dependentTaskId))),
    };
    const nextDueDate = nextRepeatDate(task, localDate());
    const previousDate = task.dueDate ?? localDate();
    const offset = dayDistance(previousDate, nextDueDate);
    const resetIds = branch ? new Set([id, ...activeDescendants.map((item) => item.id)]) : new Set([id]);
    result = {
      ...result, occurrences: [...result.occurrences, occurrence],
      items: result.items.map((item) => resetIds.has(item.id) ? {
        ...item, completed: false, status: "todo" as const, completedAt: undefined, dismissed: false,
        dueDate: item.id === id ? nextDueDate : item.dueDate ? addDays(item.dueDate, offset) : undefined,
        plannedStart: item.plannedStart ? addDays(item.plannedStart, offset) : undefined,
        repeat: item.id === id && item.repeat?.type === "monthly" ? { ...item.repeat, day: item.repeat.day ?? Number(previousDate.slice(8, 10)) } : item.repeat,
        updatedAt: at,
      } : item),
    };
    result = reopenAncestors(result, id);
    return record(result, "occurrenceCompleted", id, `Occurrence completed; next deadline ${nextDueDate}`);
  }
  return record(result, options.cascade ? "branchCompleted" : "completed", id);
}

export function reopenTask(data: Data, id: string): NormalizedTaskData {
  let result = normalizeTaskData(data);
  const task = requireTask(result, id);
  if (task.deletedAt) throw new Error("Restore the task before reopening it.");
  result = { ...result, items: result.items.map((item) => item.id === id ? { ...item, completed: false, status: "todo" as const, completedAt: undefined, dismissed: false, archivedAt: undefined, updatedAt: now() } : item) };
  return record(reopenAncestors(result, id), "reopened", id);
}

export function deleteTask(data: Data, id: string): NormalizedTaskData {
  const result = normalizeTaskData(data);
  requireTask(result, id);
  const ids = new Set([id, ...descendantsOf(result, id, true).map((task) => task.id)]);
  const at = now();
  return record({ ...result, items: result.items.map((task) => ids.has(task.id) && !task.deletedAt ? { ...task, deletedAt: at, deletedByTaskId: id, updatedAt: at } : task) }, "deleted", id);
}

export function restoreTask(data: Data, id: string): NormalizedTaskData {
  let result = normalizeTaskData(data);
  const task = requireTask(result, id);
  const deletedAt = task.deletedAt;
  const ids = new Set([id, ...descendantsOf(result, id, true).filter((child) => child.deletedByTaskId ? child.deletedByTaskId === task.deletedByTaskId : child.deletedAt === deletedAt).map((child) => child.id)]);
  const unavailableParents = ancestorsOf(result, id).some(unavailable);
  result = { ...result, items: result.items.map((item) => ids.has(item.id) ? { ...item, deletedAt: undefined, deletedByTaskId: undefined, parentTaskId: item.id === id && unavailableParents ? undefined : item.parentTaskId, updatedAt: now() } : item) };
  if (!terminal(task)) result = reopenAncestors(result, id);
  return record(result, "restored", id);
}

export function archiveTask(data: Data, id: string, archived = true): NormalizedTaskData {
  let result = normalizeTaskData(data);
  requireTask(result, id);
  const ids = new Set([id, ...descendantsOf(result, id, true).map((task) => task.id)]);
  const at = now();
  result = { ...result, items: result.items.map((task) => ids.has(task.id) ? { ...task, archivedAt: archived ? at : undefined, dismissed: archived, updatedAt: at } : task) };
  if (!archived) {
    for (const task of result.items.filter((item) => ids.has(item.id) && !terminal(item) && !unavailable(item))) {
      result = reopenAncestors(result, task.id);
    }
  }
  validateTaskGraph(result);
  return record(result, archived ? "archived" : "unarchived", id);
}

export function addDependency(data: Data, prerequisiteTaskId: string, dependentTaskId: string): NormalizedTaskData {
  const result = normalizeTaskData(data);
  const prerequisite = requireTask(result, prerequisiteTaskId);
  const dependent = requireTask(result, dependentTaskId);
  if (unavailable(prerequisite) || unavailable(dependent)) throw new Error("Restore tasks before linking prerequisites.");
  if (result.dependencies.some((dependency) => !dependency.deletedAt && dependency.prerequisiteTaskId === prerequisiteTaskId && dependency.dependentTaskId === dependentTaskId)) return result;
  const dependency: Dependency = { id: nanoid(), prerequisiteTaskId, dependentTaskId, createdAt: now() };
  const changed = { ...result, dependencies: [...result.dependencies, dependency] };
  validateTaskGraph(changed);
  return record(changed, "dependencyAdded", dependentTaskId, `Waiting on ${prerequisite.contents}`);
}

export function removeDependency(data: Data, id: string): NormalizedTaskData {
  const result = normalizeTaskData(data);
  const dependency = result.dependencies.find((item) => item.id === id);
  const name = result.items.find((task) => task.id === dependency?.prerequisiteTaskId)?.contents;
  return record({ ...result, dependencies: result.dependencies.filter((item) => item.id !== id) }, "dependencyRemoved", dependency?.dependentTaskId, name ? `Removed prerequisite ${name}` : "Removed prerequisite");
}

export function previewScheduleShift(data: Data, id: string, days: number): ScheduleChange[] {
  if (!Number.isInteger(days)) throw new Error("Schedule shifts use whole days.");
  const task = requireTask(data, id);
  const hidden = hiddenTaskIds(data);
  return [task, ...descendantsOf(data, id)].filter((item) => !terminal(item) && !hidden.has(item.id) && (item.dueDate || item.plannedStart)).map((item) => ({
    taskId: item.id, fromDueDate: item.dueDate, toDueDate: item.dueDate ? addDays(item.dueDate, days) : undefined,
    fromPlannedStart: item.plannedStart, toPlannedStart: item.plannedStart ? addDays(item.plannedStart, days) : undefined,
  }));
}

export function shiftSchedule(data: Data, id: string, days: number): NormalizedTaskData {
  const result = normalizeTaskData(data);
  const changes = new Map(previewScheduleShift(result, id, days).map((change) => [change.taskId, change]));
  return record({ ...result, items: result.items.map((task) => {
    const change = changes.get(task.id);
    return change ? { ...task, dueDate: change.toDueDate, plannedStart: change.toPlannedStart, updatedAt: now() } : task;
  }) }, "scheduleShifted", id, `${days} days`);
}

export function deleteCustomList(data: Data, id: string): NormalizedTaskData {
  const result = normalizeTaskData(data);
  const name = result.customLists.find((list) => list.id === id)?.name ?? "List";
  return record({ ...result, customLists: result.customLists.filter((list) => list.id !== id), items: result.items.map((task) => task.listId === id ? { ...task, listId: undefined, updatedAt: now() } : task) }, "listDeleted", undefined, `Deleted ${name}; projects moved to Inbox`);
}

export function timelineIssues(data: Data, id?: string): TimelineIssue[] {
  const selected = id ? new Set([id, ...descendantsOf(data, id).map((task) => task.id)]) : undefined;
  const tasks = data.items.filter((task) => !unavailable(task) && !terminal(task) && (!selected || selected.has(task.id)) && !ancestorsOf(data, task.id).some((parent) => unavailable(parent) || parent.status === "canceled"));
  const issues: TimelineIssue[] = [];
  for (const task of tasks) {
    if (!task.dueDate) issues.push({ taskId: task.id, type: "unscheduled", message: "No deadline assigned." });
    if (task.dueDate && task.plannedStart && task.plannedStart > task.dueDate) issues.push({ taskId: task.id, type: "startAfterDeadline", message: "Planned start is after the deadline." });
    const ancestors = ancestorsOf(data, task.id);
    const dateTime = (item: Task) => `${item.dueDate}T${item.dueTime ?? "23:59"}`;
    const conflictingParent = ancestors.find((parent) => parent.dueDate && task.dueDate && dateTime(parent) < dateTime(task));
    if (conflictingParent) issues.push({ taskId: task.id, relatedTaskId: conflictingParent.id, type: "childAfterParent", message: `Deadline is after ${conflictingParent.contents}.` });
    for (const blocker of blockersOf(data, task.id)) {
      if (blocker.dueDate && task.dueDate && dateTime(blocker) > dateTime(task)) issues.push({ taskId: task.id, relatedTaskId: blocker.id, type: "dependencyAfterDeadline", message: `${blocker.contents} is due after this task.` });
      if (blocker.dueDate && task.plannedStart && blocker.dueDate > task.plannedStart) issues.push({ taskId: task.id, relatedTaskId: blocker.id, type: "dependencyAfterStart", message: `${blocker.contents} is due after this task's planned start.` });
    }
  }
  return issues;
}

/** Include conflicts created outside the moved branch by cross-project prerequisites. */
export function scheduleShiftIssues(data: Data, id: string, days: number): TimelineIssue[] {
  const changed = new Set(previewScheduleShift(data, id, days).map((change) => change.taskId));
  return timelineIssues(shiftSchedule(data, id, days)).filter((issue) => changed.has(issue.taskId) || (issue.relatedTaskId != null && changed.has(issue.relatedTaskId)));
}

/** Longest remaining prerequisite chain. Summary tasks have zero effort to avoid double counting. */
export function criticalPath(data: Data, id?: string): { taskIds: string[]; estimatedMinutes: number; completeEstimates: boolean } {
  validateTaskGraph(data);
  const hidden = hiddenTaskIds(data);
  const active = (task: Task) => !terminal(task) && !hidden.has(task.id);
  const selected = (id ? [requireTask(data, id), ...descendantsOf(data, id)] : data.items).filter(active);
  const allSelected = new Set(selected.map((task) => task.id));
  // Include external prerequisites required by this branch.
  const pending = [...allSelected];
  let unavailablePrerequisite = false;
  for (let i = 0; i < pending.length; i++) {
    for (const blocker of blockersOf(data, pending[i])) {
      if (!active(blocker)) { unavailablePrerequisite = true; continue; }
      for (const prerequisite of [blocker, ...descendantsOf(data, blocker.id)].filter(active)) {
        if (!allSelected.has(prerequisite.id)) { allSelected.add(prerequisite.id); pending.push(prerequisite.id); }
      }
    }
  }
  const tasks = data.items.filter((task) => allSelected.has(task.id) && !terminal(task) && !unavailable(task) && !ancestorsOf(data, task.id).some((parent) => unavailable(parent) || parent.status === "canceled"));
  const index = new Map(tasks.map((task) => [task.id, task]));
  const edges = new Map<string, Set<string>>();
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const add = (from: string, to: string) => {
    if (!index.has(from) || !index.has(to)) return;
    const links = edges.get(from) ?? new Set<string>();
    if (!links.has(to)) { links.add(to); indegree.set(to, indegree.get(to)! + 1); }
    edges.set(from, links);
  };
  for (const task of tasks) if (task.parentTaskId) add(task.id, task.parentTaskId);
  for (const dependency of data.dependencies ?? []) if (!dependency.deletedAt) {
    add(dependency.prerequisiteTaskId, dependency.dependentTaskId);
    for (const child of descendantsOf(data, dependency.dependentTaskId)) add(dependency.prerequisiteTaskId, child.id);
  }
  const parents = new Set(tasks.map((task) => task.parentTaskId));
  const weight = (task: Task) => parents.has(task.id) ? 0 : task.estimatedMinutes ?? 0;
  const lengths = new Map(tasks.map((task) => [task.id, weight(task)]));
  const previous = new Map<string, string>();
  const queue = tasks.filter((task) => !indegree.get(task.id)).map((task) => task.id);
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    for (const to of edges.get(from) ?? []) {
      const candidate = lengths.get(from)! + weight(index.get(to)!);
      if (candidate > lengths.get(to)!) { lengths.set(to, candidate); previous.set(to, from); }
      const degree = indegree.get(to)! - 1;
      indegree.set(to, degree);
      if (!degree) queue.push(to);
    }
  }
  let end: string | undefined;
  for (const task of selected) if (!end || lengths.get(task.id)! > lengths.get(end)!) end = task.id;
  const path: string[] = [];
  let cursor = end;
  while (cursor) { path.push(cursor); cursor = previous.get(cursor); }
  return { taskIds: path.reverse(), estimatedMinutes: end ? lengths.get(end)! : 0, completeEstimates: !unavailablePrerequisite && tasks.filter((task) => !parents.has(task.id)).every((task) => task.estimatedMinutes != null) };
}
