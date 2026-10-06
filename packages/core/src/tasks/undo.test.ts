import { createTask } from "./tasks";
import { defaultData } from "./types";
import { undoTaskChange } from "./undo";
test("undo survives JSON key reordering and tombstones newly created tasks", () => {
  const after = createTask(defaultData, { id: "new", contents: "New task" });
  const reordered = Object.fromEntries(Object.entries(after).reverse()) as typeof after;
  const undone = undoTaskChange(defaultData, after, reordered, "2026-10-05T12:00:00Z");
  expect(undone.items[0]).toMatchObject({ id: "new", deletedAt: "2026-10-05T12:00:00Z" });
});
test("undo refuses to overwrite a concurrent task edit", () => {
  const after = createTask(defaultData, { id: "new", contents: "New task" });
  const remote = { ...after, items: [{ ...after.items[0], contents: "Changed elsewhere" }] };
  expect(() => undoTaskChange(defaultData, after, remote)).toThrow("Another change arrived");
});
