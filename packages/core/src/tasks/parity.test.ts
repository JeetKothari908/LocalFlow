import fixture from "../../../../app/appTests/mobile-parity.json";
import { blockersOf, completeTask, dueTasks, normalizeTaskData, taskProgress, taskPath } from "./tasks";
import { Data } from "./types";

test("the shared iOS fixture has matching hierarchy, blockers, due order, and completion", () => {
  const data = normalizeTaskData(fixture as Data);
  expect(taskPath(data, "build").map(task => task.id)).toEqual(["project", "build"]);
  expect(blockersOf(data, "build").map(task => task.id)).toEqual(["design"]);
  expect(dueTasks(data, "2026-10-05").map(task => task.id)).toEqual(["design", "build"]);
  expect(taskProgress(data, "project")).toMatchObject({ completed: 0, total: 2 });
  const completed = completeTask(data, "project", { cascade: true });
  expect(completed.items.every(task => task.completed)).toBe(true);
  expect(taskProgress(completed, "project")).toMatchObject({ completed: 2, total: 2 });
  expect(completed).toMatchObject({ futureDocumentField: "preserve" });
  expect(completed.items.find(task => task.id === "project")).toMatchObject({ futureTaskField: { preserve: true } });
});
