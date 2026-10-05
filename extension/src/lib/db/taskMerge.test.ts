import { mergeTaskDocuments, TaskMergeConflict } from "./taskMerge";

const task = (id: string, patch: object = {}) => ({ id, contents: id, completed: false, status: "todo", ...patch });
const document = (items: object[], extra: object = {}) => ({ schemaVersion: 2, items, dependencies: [], occurrences: [], activity: [], customLists: [], show: 3, ...extra });

test("merges disjoint fields and keeps the latest valid timestamp and unknown metadata", () => {
  const base = document([task("a", { future: { color: "blue" } })]);
  const local = document([task("a", { contents: "Rename", updatedAt: "2026-10-01T14:00:00Z", future: { color: "blue" } })]);
  const remote = document([task("a", { dueDate: "2026-10-02", updatedAt: "2026-10-01T16:00:00Z", future: { color: "blue" } })]);
  expect((mergeTaskDocuments(base, local, remote) as any).items[0]).toMatchObject({ contents: "Rename", dueDate: "2026-10-02", updatedAt: "2026-10-01T16:00:00Z", future: { color: "blue" } });
});

test("merges entity additions, removals, and activity history by stable ID", () => {
  const base = document([task("a"), task("removed")]);
  const local = document([task("a"), task("local")], { activity: [{ id: "local", type: "created" }] });
  const remote = document([task("a"), task("removed"), task("remote")], { activity: [{ id: "remote", type: "created" }] });
  const result = mergeTaskDocuments(base, local, remote) as any;
  expect(result.items.map((value: any) => value.id)).toEqual(["a", "remote", "local"]);
  expect(result.activity.map((value: any) => value.id)).toEqual(["remote", "local"]);
});

test("conflicts on the same field or deletion versus concurrent edits", () => {
  const base = document([task("a")]);
  expect(() => mergeTaskDocuments(base, document([task("a", { contents: "left" })]), document([task("a", { contents: "right" })]))).toThrow(TaskMergeConflict);
  expect(() => mergeTaskDocuments(base, document([task("a", { deletedAt: "2026-10-01T12:00:00Z" })]), document([task("a", { description: "Changed" })]))).toThrow(/deletedAt/);
});

test("conflicts when disjoint edits combine into a dependency cycle", () => {
  const base = document([task("a"), task("b")]);
  const local = document(base.items, { dependencies: [{ id: "left", prerequisiteTaskId: "a", dependentTaskId: "b" }] });
  const remote = document(base.items, { dependencies: [{ id: "right", prerequisiteTaskId: "b", dependentTaskId: "a" }] });
  expect(() => mergeTaskDocuments(base, local, remote)).toThrow(/circular/);
});

test("conflicts on concurrent parent completion or trash and new unfinished work", () => {
  const base = document([task("root")]);
  const child = document([task("root"), task("new", { parentTaskId: "root" })]);
  expect(() => mergeTaskDocuments(base, document([task("root", { completed: true, status: "done" })]), child)).toThrow(/completed ancestors/);
  expect(() => mergeTaskDocuments(base, document([task("root", { deletedAt: "2026-10-01T12:00:00Z" })]), child)).toThrow(/deleted task/);
});
