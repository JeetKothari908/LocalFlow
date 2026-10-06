import fixture from "../../../../app/appTests/mobile-recurrence-recovery.json";
import { completeTask, deleteTask, restoreTask } from "./tasks";
import { Data } from "./types";

afterEach(() => jest.useRealTimers());
test("shared recurring branch keeps date offsets and occurrence snapshots", () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 9, 1, 12));
  const result = completeTask(fixture as Data, "root", { cascade: true });
  expect(result.items.find(t => t.id === "root")?.dueDate).toBe("2026-10-02");
  expect(result.items.find(t => t.id === "child")).toMatchObject({ dueDate: "2026-10-01", plannedStart: "2026-09-30", completed: false });
  expect(result.occurrences[0].items.find(t => t.id === "child")).toMatchObject({ dueDate: "2026-09-19", completed: true });
});
test("shared branch restoration preserves independently deleted descendants", () => {
  const restored = restoreTask(deleteTask(fixture as Data, "root"), "root");
  expect(restored.items.find(t => t.id === "root")?.deletedAt).toBeUndefined();
  expect(restored.items.find(t => t.id === "child")).toMatchObject({ parentTaskId: "root" });
  expect(restored.items.find(t => t.id === "child")?.deletedAt).toBeUndefined();
  expect(restored.items.find(t => t.id === "independent-trash")?.deletedAt).toBe("2026-09-01T00:00:00Z");
});
