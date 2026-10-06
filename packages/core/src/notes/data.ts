export type NoteItem = {
  id: string;
  type: "note";
  name: string;
  parentId: string | null;
  contents: string;
  deleted?: boolean;
  deletedAt?: string;
};

export type FolderItem = {
  id: string;
  type: "folder";
  name: string;
  parentId: string | null;
  deleted?: boolean;
  deletedAt?: string;
};

export type Item = NoteItem | FolderItem;

export interface Data {
  items: Item[];
  selectedNoteId: string | null;
  currentFolderId: string | null;
}

export const defaultData: Data = {
  items: [],
  selectedNoteId: null,
  currentFolderId: null,
};
