import { nanoid } from "nanoid";
import { Data } from "./types";
import { normalizeTaskData, validateTaskGraph } from "./tasks";

/** Object key order may change across the Swift JSON bridge. Array order matters. */
export function equalDocument(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equalDocument(value, b[index]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    const keys = Object.keys(left).filter(key => left[key] !== undefined);
    return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length && keys.every(key => equalDocument(left[key], right[key]));
  }
  return false;
}

export function undoTaskChange(before: Data, after: Data, current: Data, now = new Date().toISOString()): Data {
  if (!equalDocument(normalizeTaskData(current), normalizeTaskData(after))) throw new Error("Another change arrived. Undo is unavailable so that change is preserved.");
  const next = normalizeTaskData(JSON.parse(JSON.stringify(before)));
  const priorIds = new Set(next.items.map(task => task.id));
  const currentById = new Map(current.items.map(task => [task.id, task]));
  next.items = next.items.map(task => equalDocument(task, currentById.get(task.id)) ? task : { ...task, updatedAt: now });
  for (const task of current.items) if (!priorIds.has(task.id)) next.items.push({ ...task, deletedAt: now, deletedByTaskId: task.id, updatedAt: now });
  const dependencyIds = new Set(next.dependencies.map(edge => edge.id));
  for (const edge of current.dependencies ?? []) if (!dependencyIds.has(edge.id)) next.dependencies.push({ ...edge, deletedAt: now, updatedAt: now });
  const listIds = new Set(next.customLists.map(list => list.id));
  for (const list of current.customLists ?? []) if (!listIds.has(list.id)) next.customLists.push({ ...list, deletedAt: now, updatedAt: now });
  next.activity.push({ id: nanoid(), type: "undo", at: now, detail: "Previous task change undone" });
  validateTaskGraph(next);
  return next;
}
