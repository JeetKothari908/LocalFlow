import { Data, defaultData } from "../../packages/core/src/tasks/types";

/** Isolated preview datasets for repeatable phone profiling; never edits native data. */
export function performanceData(size: "small" | "medium" | "large"): Data {
  const count = { small: 50, medium: 500, large: 2500 }[size];
  return { ...defaultData, schemaVersion: 2, items: Array.from({ length: count }, (_, index) => ({
    id: `profile-${index}`, contents: index % 50 === 0 ? `Project ${index / 50 + 1}` : `Task ${index + 1}`,
    completed: false, parentTaskId: index % 50 ? `profile-${index - index % 50}` : undefined,
    order: index % 50, dueDate: "2026-10-06", estimatedMinutes: 15,
  })) };
}
