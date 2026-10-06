import { getFolderPath, normalizeData } from "./tree";

test("normalization retains future document and node metadata", () => {
  const value = { items: [{ id: "note", type: "note" as const, name: "Note", parentId: null, contents: "hello", futureNode: 12 }], currentFolderId: null, selectedNoteId: null, futureDocument: { version: 3 } };
  expect(normalizeData(value)).toMatchObject({ futureDocument: { version: 3 }, items: [{ futureNode: 12 }] });
});

test("corrupt folder cycles cannot hang navigation", () => {
  expect(getFolderPath([{ id: "a", type: "folder", name: "A", parentId: "b" }, { id: "b", type: "folder", name: "B", parentId: "a" }], "a")).toHaveLength(2);
});
