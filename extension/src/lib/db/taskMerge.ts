import { validateTaskGraph } from "../../plugins/widgets/todo/tasks";
import { Data } from "../../plugins/widgets/todo/types";

const missing = Symbol("missing");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const isRecursiveTodo = (value: unknown): value is Data => object(value) && value.schemaVersion === 2 && Array.isArray(value.items);
export const copyJson = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));

export function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equalJson(value, b[index]));
  if (object(a) && object(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    const other = Object.keys(b).filter((key) => b[key] !== undefined);
    return keys.length === other.length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equalJson(a[key], b[key]));
  }
  return false;
}

export class TaskMergeConflict extends Error {
  constructor(readonly conflicts: string[]) { super(`Concurrent changes require review: ${conflicts.join(", ")}`); }
}

/** Matches server/todo_schema.py: fields merge, entity arrays merge by ID, timestamps take latest. */
export function mergeTaskDocuments(base: unknown, local: unknown, remote: unknown): unknown {
  const conflicts: string[] = [];
  const merge = (before: unknown, ours: unknown, theirs: unknown, path: string): unknown => {
    if (equalJson(ours, theirs)) return ours === missing ? missing : copyJson(ours);
    if (equalJson(ours, before)) return theirs === missing ? missing : copyJson(theirs);
    if (equalJson(theirs, before)) return ours === missing ? missing : copyJson(ours);
    if (before === missing || ours === missing || theirs === missing) { conflicts.push(path); return missing; }
    if (object(before) && object(ours) && object(theirs)) {
      if ("id" in before && (!!before.deletedAt !== !!ours.deletedAt || !!before.deletedAt !== !!theirs.deletedAt)) { conflicts.push(`${path}.deletedAt`); return missing; }
      const result: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(ours), ...Object.keys(theirs)])) {
        const read = (value: Record<string, unknown>) => value[key] === undefined ? missing : value[key];
        const left = read(ours), right = read(theirs);
        if (key === "updatedAt" && typeof left === "string" && typeof right === "string" && Number.isFinite(Date.parse(left)) && Number.isFinite(Date.parse(right))) { result[key] = Date.parse(left) >= Date.parse(right) ? left : right; continue; }
        const value = merge(read(before), left, right, path ? `${path}.${key}` : key);
        if (value !== missing) result[key] = value;
      }
      return result;
    }
    if (Array.isArray(before) && Array.isArray(ours) && Array.isArray(theirs)) {
      const byId = (values: unknown[]) => {
        const map = new Map<string, unknown>();
        for (const value of values) {
          if (!object(value) || typeof value.id !== "string" || map.has(value.id)) return undefined;
          map.set(value.id, value);
        }
        return map;
      };
      const old = byId(before), left = byId(ours), right = byId(theirs);
      if (old && left && right) {
        const result: unknown[] = [];
        for (const id of new Set([...right.keys(), ...left.keys(), ...old.keys()])) {
          const value = merge(old.has(id) ? old.get(id) : missing, left.has(id) ? left.get(id) : missing, right.has(id) ? right.get(id) : missing, `${path}[${id}]`);
          if (value !== missing) result.push(value);
        }
        return result;
      }
    }
    conflicts.push(path || "$document");
    return missing;
  };
  const result = merge(base, local, remote, "");
  if (conflicts.length) throw new TaskMergeConflict([...new Set(conflicts)]);
  if (isRecursiveTodo(result)) {
    try { validateTaskGraph(result); } catch (error) { throw new TaskMergeConflict([error instanceof Error ? error.message : "Invalid combined hierarchy"]); }
  }
  return result;
}
