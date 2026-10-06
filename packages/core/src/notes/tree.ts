import { Data, Item } from "./data";

export const DELETED_FOLDER_ID = "__deleted__";

type LegacyData = {
  notes?: { contents?: string }[];
};

export const normalizeData = (data?: Data | LegacyData): Data => {
  if (!data) return { items: [], selectedNoteId: null, currentFolderId: null };

  if ("items" in data && Array.isArray(data.items)) {
    const ids = new Set(data.items.map((item) => item.id));
    const selectedNote = data.selectedNoteId
      ? data.items.find(
          (item) => item.id === data.selectedNoteId && item.type === "note",
        )
      : undefined;
    const currentFolder = data.currentFolderId
      ? data.items.find(
          (item) => item.id === data.currentFolderId && item.type === "folder",
        )
      : undefined;
    const currentFolderId =
      data.currentFolderId === DELETED_FOLDER_ID
        ? DELETED_FOLDER_ID
        : currentFolder?.id ?? null;

    return {
      ...data,
      items: data.items.map((item) => ({
        ...item,
        parentId: item.parentId && ids.has(item.parentId) ? item.parentId : null,
        contents: item.type === "note" ? item.contents ?? "" : undefined,
        deleted: item.deleted === true,
      })) as Item[],
      selectedNoteId: selectedNote?.id ?? null,
      currentFolderId,
    };
  }

  const legacyContents = "notes" in data ? data.notes?.[0]?.contents ?? "" : "";
  if (!legacyContents)
    return { items: [], selectedNoteId: null, currentFolderId: null };

  return {
    items: [
      {
        id: "imported-note",
        type: "note",
        name: "Imported Note",
        parentId: null,
        contents: legacyContents,
      },
    ],
    selectedNoteId: "imported-note",
    currentFolderId: null,
  };
};

export const getItem = (items: Item[], id?: string | null) =>
  id ? items.find((item) => item.id === id) : undefined;

export const getChildren = (items: Item[], parentId: string | null) =>
  items
    .filter((item) => !item.deleted && item.parentId === (parentId ?? null))
    .sort(sortItems);

export const getDeletedChildren = (items: Item[], parentId: string | null) => {
  const deletedIds = new Set(
    items.filter((item) => item.deleted).map((item) => item.id),
  );

  return items
    .filter((item) => {
      if (!item.deleted) return false;
      if (parentId) return item.parentId === parentId;
      return !item.parentId || !deletedIds.has(item.parentId);
    })
    .sort((a, b) => {
      if ((a.deletedAt ?? "") !== (b.deletedAt ?? "")) {
        return (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "");
      }
      return sortItems(a, b);
    });
};

export const getFolderPath = (items: Item[], folderId: string | null) => {
  const path: Item[] = [];
  let current = getItem(items, folderId);
  const seen = new Set<string>();
  while (current && current.type === "folder" && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = getItem(items, current.parentId);
  }
  return path;
};

export const softDeleteItemWithDescendants = (
  items: Item[],
  id: string,
  deletedAt = new Date().toISOString(),
) => {
  const toDelete = new Set([id]);
  let changed = true;

  while (changed) {
    changed = false;
    items.forEach((item) => {
      if (item.parentId && toDelete.has(item.parentId) && !toDelete.has(item.id)) {
        toDelete.add(item.id);
        changed = true;
      }
    });
  }

  return items.map((item) =>
    toDelete.has(item.id) ? { ...item, deleted: true, deletedAt } : item,
  );
};

const sortItems = (a: Item, b: Item) => {
  if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
};
