import { equalJson } from "./taskMerge";

export type RecoveryDifference = {
  path: string;
  group: string;
  groupTitle: string;
  local: unknown;
  remote: unknown;
  base: unknown;
  localPresent: boolean;
  remotePresent: boolean;
  basePresent: boolean;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const byId = (value: unknown[]): Map<string, unknown> | undefined => {
  const result = new Map<string, unknown>();
  for (const item of value) {
    if (!record(item) || typeof item.id !== "string" || result.has(item.id))
      return;
    result.set(item.id, item);
  }
  return result;
};
const fieldPath = (path: string, key: string) =>
  /^[a-zA-Z_$][\w$]*$/.test(key)
    ? `${path ? `${path}.` : ""}${key}`
    : `${path}[${JSON.stringify(key)}]`;
const idPath = (path: string, id: string) =>
  `${path}[${/^[\w-]+$/.test(id) ? id : JSON.stringify(id)}]`;
const entityTitle = (
  path: string,
  id: string,
  value: unknown,
  recordKey: string,
) => {
  const kind =
    path === "items"
      ? recordKey === "data/default-todo"
        ? "Task"
        : recordKey === "data/default-notes"
          ? "Note"
          : "Item"
      : path === "customLists"
        ? "List"
        : path === "dependencies"
          ? "Dependency"
          : path === "occurrences"
            ? "Occurrence"
            : path === "activity"
              ? "Activity entry"
              : "Record";
  const name = record(value)
    ? value.contents ?? value.name ?? value.type
    : undefined;
  return `${kind}${typeof name === "string" && name ? `: ${name}` : ""} · ${id}`;
};

/** Compare raw values without migrating them; entity arrays match stable IDs. */
export function recoveryDifferences(
  local: unknown,
  remote: unknown,
  base?: unknown,
  recordKey = "data/default-todo",
): RecoveryDifference[] {
  const result: RecoveryDifference[] = [];
  const stack: RecoveryDifference[] = [
    {
      path: "",
      group: "$document",
      groupTitle: "Document fields",
      local,
      remote,
      base,
      localPresent: local !== undefined,
      remotePresent: remote !== undefined,
      basePresent: base !== undefined,
    },
  ];
  while (stack.length) {
    const next = stack.pop()!;
    if (equalJson(next.local, next.remote)) continue;
    if (record(next.local) && record(next.remote)) {
      const old = record(next.base) ? next.base : {};
      const keys = [
        ...new Set([...Object.keys(next.local), ...Object.keys(next.remote)]),
      ].sort();
      for (const key of keys.reverse())
        stack.push({
          ...next,
          path: fieldPath(next.path, key),
          local: next.local[key],
          remote: next.remote[key],
          base: old[key],
          localPresent: Object.hasOwn(next.local, key),
          remotePresent: Object.hasOwn(next.remote, key),
          basePresent: Object.hasOwn(old, key),
        });
      continue;
    }
    if (Array.isArray(next.local) && Array.isArray(next.remote)) {
      const left = byId(next.local),
        right = byId(next.remote);
      if (left && right) {
        const old = Array.isArray(next.base) ? byId(next.base) : undefined;
        const ids = [...new Set([...left.keys(), ...right.keys()])];
        const leftOrder = [...left.keys()].filter((id) => right.has(id));
        const rightOrder = [...right.keys()].filter((id) => left.has(id));
        if (!equalJson(leftOrder, rightOrder))
          result.push({
            ...next,
            path: `${next.path}.$order`,
            local: [...left.keys()],
            remote: [...right.keys()],
            base: old ? [...old.keys()] : undefined,
            basePresent: !!old,
          });
        for (const id of ids.reverse()) {
          const path = idPath(next.path, id);
          stack.push({
            path,
            group: path,
            groupTitle: entityTitle(
              next.path,
              id,
              left.get(id) ?? right.get(id),
              recordKey,
            ),
            local: left.get(id),
            remote: right.get(id),
            base: old?.get(id),
            localPresent: left.has(id),
            remotePresent: right.has(id),
            basePresent: old?.has(id) ?? false,
          });
        }
        continue;
      }
    }
    result.push({ ...next, path: next.path || "$document" });
  }
  return result;
}

export function recoveryRecordName(key: string): string {
  return key === "data/default-todo"
    ? "Tasks"
    : key === "data/default-notes"
      ? "Notes"
      : key === "data/default-plan-of-day" || key === "data/default-plan"
        ? "Daily plan"
        : key.startsWith("widget/")
          ? "Widget settings"
          : "Stored record";
}

export function recoveryFieldName(path: string, recordKey: string): string {
  const field = path.split(".").at(-1) ?? path;
  const names: Record<string, string> = {
    contents: "Title",
    title: "Title",
    name: "Name",
    dueDate: "Deadline date",
    dueTime: "Deadline time",
    parentTaskId: "Parent task",
    parentId: "Recurring task reference",
    listId: "List",
    description: "Description",
    status: "State",
    completed: "Completion",
    priority: "Priority",
    estimatedMinutes: "Estimated minutes",
    plannedStart: "Planned start",
    repeat: "Repeat rule",
    repeatScope: "Repeat scope",
    days: "Repeat weekdays",
    order: "Task order",
    $order: "Collection order",
    schemaVersion: "Data format version",
    updatedAt: "Last updated",
    createdAt: "Created",
    completedAt: "Completed at",
    deletedAt: "Trashed at",
    archivedAt: "Archived at",
    id: "Identity",
  };
  if (field === "contents" && recordKey !== "data/default-todo")
    return "Contents";
  return (
    names[field] ??
    (field.endsWith("]") || field === "$document" ? "Whole record" : field)
  );
}

export function recoveryValueSummary(value: unknown): string {
  if (value === undefined) return "Record absent (no stored value)";
  if (value === null) return "Stored value is null";
  if (record(value)) {
    if (Array.isArray(value.items))
      return `${value.items.length} items · ${value.items.filter((item) => record(item) && !item.parentTaskId && !item.deletedAt).length} top-level items${value.schemaVersion !== undefined ? ` · schema ${value.schemaVersion}` : ""}`;
    return `Object with fields: ${Object.keys(value).join(", ") || "none"}`;
  }
  if (Array.isArray(value)) return `Array with ${value.length} entries`;
  return typeof value === "string"
    ? `Text value (${value.length} characters)`
    : `${typeof value} value: ${String(value)}`;
}

export const recoveryValueText = (value: unknown, present: boolean): string =>
  !present ? "Not present" : JSON.stringify(value, null, 2) ?? "undefined";
