import { nanoid } from "nanoid";
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { API } from "../types";
import { Data, defaultData, Item } from "../../../core/src/notes/data";
import Icon from "../Icon";
import { usePlatform } from "../platform";
import {
  DELETED_FOLDER_ID,
  getChildren,
  getDeletedChildren,
  getFolderPath,
  getItem,
  normalizeData,
  softDeleteItemWithDescendants,
} from "../../../core/src/notes/tree";
import "./Notes.sass";

export const Notes: React.FC<API<Data>> = ({ data = defaultData, setData }) => {
  const mobile = usePlatform().layout === "mobile";
  const normalized = useMemo(() => normalizeData(data), [data]);
  const editorRef = useRef<HTMLDivElement>(null);
  const noteTitleRef = useRef<HTMLTextAreaElement>(null);
  const noteBodyRef = useRef<HTMLTextAreaElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const currentFolderId = normalized.currentFolderId;
  const selectedNote = getItem(normalized.items, normalized.selectedNoteId);
  const visibleItems =
    currentFolderId === DELETED_FOLDER_ID
      ? getDeletedChildren(normalized.items, null)
      : getChildren(normalized.items, currentFolderId);
  const folderPath =
    currentFolderId && currentFolderId !== DELETED_FOLDER_ID
      ? getFolderPath(normalized.items, currentFolderId)
      : [];

  const save = (next: Data) => setData(next);

  const splitNoteContents = (contents: string) => {
    const newline = contents.indexOf("\n");
    if (newline === -1) return { title: contents, body: "" };
    return {
      title: contents.slice(0, newline),
      body: contents.slice(newline + 1),
    };
  };

  const noteTitle =
    selectedNote && selectedNote.type === "note"
      ? splitNoteContents(selectedNote.contents).title
      : "";
  const noteBody =
    selectedNote && selectedNote.type === "note"
      ? splitNoteContents(selectedNote.contents).body
      : "";

  useLayoutEffect(() => {
    resizeTitle();
    revealActiveTextareaCaret();
  }, [noteTitle]);

  useLayoutEffect(() => {
    resizeBody();
    revealActiveTextareaCaret();
  }, [noteBody]);

  const resizeTitle = () => {
    const title = noteTitleRef.current;
    if (!title) return;
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  };

  const resizeBody = () => {
    const body = noteBodyRef.current;
    if (!body) return;
    body.style.height = "auto";
    body.style.height = `${body.scrollHeight}px`;
  };

  const getTextareaCaretTop = (textarea: HTMLTextAreaElement) => {
    const style = window.getComputedStyle(textarea);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    const properties = [
      "borderBottomWidth",
      "borderLeftWidth",
      "borderRightWidth",
      "borderTopWidth",
      "boxSizing",
      "fontFamily",
      "fontSize",
      "fontStyle",
      "fontWeight",
      "letterSpacing",
      "lineHeight",
      "paddingBottom",
      "paddingLeft",
      "paddingRight",
      "paddingTop",
      "textTransform",
      "width",
      "wordSpacing",
    ] as const;

    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = "break-word";
    mirror.style.top = "0";
    mirror.style.left = "-9999px";
    properties.forEach((property) => {
      mirror.style[property] = style[property];
    });
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const caretTop = marker.offsetTop;
    document.body.removeChild(mirror);

    return caretTop;
  };

  const revealTextareaCaret = (textarea: HTMLTextAreaElement) => {
    const editor = editorRef.current;
    if (!editor) return;

    const editorRect = editor.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight);
    const caretTop =
      editor.scrollTop + textareaRect.top - editorRect.top + getTextareaCaretTop(textarea);
    const caretBottom = caretTop + (Number.isFinite(lineHeight) ? lineHeight : 20);
    const padding = 36;
    const visibleTop = editor.scrollTop + padding;
    const visibleBottom = editor.scrollTop + editor.clientHeight - padding;

    if (caretTop < visibleTop) {
      editor.scrollTop = Math.max(0, caretTop - padding);
    } else if (caretBottom > visibleBottom) {
      editor.scrollTop = caretBottom - editor.clientHeight + padding;
    }
  };

  const revealActiveTextareaCaret = () => {
    const activeElement = document.activeElement;
    if (
      activeElement === noteTitleRef.current ||
      activeElement === noteBodyRef.current
    ) {
      revealTextareaCaret(activeElement as HTMLTextAreaElement);
    }
  };

  const getDisplayName = (item: Item) => {
    if (item.type === "folder") return item.name;
    const title = splitNoteContents(item.contents).title.trim();
    return title || item.name;
  };

  const createItem = (type: "folder" | "note") => {
    const now = nanoid();
    const item =
      type === "note"
        ? {
            id: `note-${now}`,
            type,
            name: "Untitled Note",
            parentId:
              currentFolderId === DELETED_FOLDER_ID ? null : currentFolderId,
            contents: "",
          }
        : {
            id: `folder-${now}`,
            type,
            name: "New Folder",
            parentId:
              currentFolderId === DELETED_FOLDER_ID ? null : currentFolderId,
          };

    save({
      ...normalized,
      items: [...normalized.items, item as Item],
      selectedNoteId: item.type === "note" ? item.id : normalized.selectedNoteId,
      currentFolderId:
      currentFolderId === DELETED_FOLDER_ID ? null : currentFolderId,
    });
    if (item.type === "folder") startRename(item.id, item.name);
  };

  const startRename = (id: string, name: string) => {
    setRenamingId(id);
    setRenameValue(name);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      save({
        ...normalized,
        items: normalized.items.map((item) =>
          item.id === renamingId ? { ...item, name: trimmed } : item,
        ),
      });
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const selectItem = (item: Item) => {
    if (item.type === "folder") {
      save({ ...normalized, currentFolderId: item.id, selectedNoteId: null });
    } else {
      save({ ...normalized, selectedNoteId: item.id });
    }
  };

  const updateContents = (contents: string) => {
    if (!selectedNote || selectedNote.type !== "note") return;
    save({
      ...normalized,
      items: normalized.items.map((item) =>
        item.id === selectedNote.id && item.type === "note"
          ? { ...item, contents }
          : item,
      ),
    });
  };

  const updateNoteTitle = (title: string) => {
    if (!selectedNote || selectedNote.type !== "note") return;
    updateContents(noteBody ? `${title}\n${noteBody}` : title);
  };

  const updateNoteBody = (body: string) => {
    if (!selectedNote || selectedNote.type !== "note") return;
    updateContents(noteTitle || body ? `${noteTitle}\n${body}` : "");
  };

  const deleteItem = (id: string) => {
    const nextItems = softDeleteItemWithDescendants(normalized.items, id);
    save({
      ...normalized,
      items: nextItems,
      selectedNoteId: normalized.selectedNoteId === id ? null : normalized.selectedNoteId,
      currentFolderId: normalized.currentFolderId === id ? null : normalized.currentFolderId,
    });
  };

  const closeNote = () =>
    save({
      ...normalized,
      selectedNoteId: null,
    });

  const restoreItem = (id: string) => {
    const restored = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      normalized.items.forEach((item) => {
        if (
          item.parentId &&
          restored.has(item.parentId) &&
          !restored.has(item.id)
        ) {
          restored.add(item.id);
          changed = true;
        }
      });
    }

    save({
      ...normalized,
      items: normalized.items.map((item) =>
        restored.has(item.id)
          ? { ...item, deleted: false, deletedAt: undefined, parentId: item.id === id && normalized.items.find(parent => parent.id === item.parentId)?.deleted ? null : item.parentId }
          : item,
      ),
      currentFolderId: null,
      selectedNoteId: id,
    });
  };

  return (
    <div className={`Notes${selectedNote?.type === "note" ? " has-selection" : ""}`} data-layout={mobile ? "mobile" : "desktop"}>
      <div className="panel">
        {selectedNote && selectedNote.type === "note" && (
          <div className="editor" ref={editorRef}>
            <div className="editor-toolbar">
              <button aria-label="Back to notes" onClick={closeNote}>
                <Icon name="chevron-left" size={18} />
              </button>
              <button
                aria-label="Delete note"
                onClick={() => deleteItem(selectedNote.id)}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
            <>
              <textarea
                aria-label="Note title"
                ref={noteTitleRef}
                className="note-title"
                value={noteTitle}
                placeholder="Untitled Note"
                rows={1}
                onChange={(event) => {
                  const textarea = event.currentTarget;
                  updateNoteTitle(event.target.value.replace(/\n/g, " "));
                  requestAnimationFrame(() => {
                    resizeTitle();
                    revealTextareaCaret(textarea);
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    noteBodyRef.current?.focus();
                  }
                }}
                autoFocus
              />
              <textarea
                aria-label="Note contents"
                ref={noteBodyRef}
                value={noteBody}
                onChange={(event) => {
                  const textarea = event.currentTarget;
                  updateNoteBody(event.target.value);
                  requestAnimationFrame(() => {
                    resizeBody();
                    revealTextareaCaret(textarea);
                  });
                }}
                spellCheck={true}
              />
            </>
          </div>
        )}
        {(!selectedNote || selectedNote.type !== "note" || mobile) && <div className="directory">
            <div className="toolbar">
              <button onClick={() => save({ ...normalized, currentFolderId: null })}>
                Notes
              </button>
              <button
                aria-label="Deleted notes"
                onClick={() =>
                  save({
                    ...normalized,
                    currentFolderId: DELETED_FOLDER_ID,
                    selectedNoteId: null,
                  })
                }
              >
                <Icon name="trash-2" size={16} />
              </button>
              <button aria-label="New folder" onClick={() => createItem("folder")}>
                <Icon name="folder-plus" size={16} />
              </button>
              <button aria-label="New note" onClick={() => createItem("note")}>
                <Icon name="file-plus" size={16} />
              </button>
            </div>

            <div className="path">
              {currentFolderId === DELETED_FOLDER_ID ? (
                <button>Deleted</button>
              ) : (
                <>
                  <button onClick={() => save({ ...normalized, currentFolderId: null })}>
                    Home
                  </button>
                  {folderPath.map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() =>
                        save({
                          ...normalized,
                          currentFolderId: folder.id,
                          selectedNoteId: null,
                        })
                      }
                    >
                      {folder.name}
                    </button>
                  ))}
                </>
              )}
            </div>

            <div className="items">
              {visibleItems.length === 0 ? (
                <div className="empty">
                  {currentFolderId === DELETED_FOLDER_ID
                    ? "No deleted notes"
                    : "No notes here"}
                </div>
              ) : (
                visibleItems.map((item) => (
                  <div key={item.id} className="item">
                    <button className="item-main" onClick={() => selectItem(item)}>
                      <Icon
                        name={item.type === "folder" ? "folder" : "file-text"}
                        size={15}
                      />
                      {renamingId === item.id ? (
                        <input
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") commitRename();
                            if (event.key === "Escape") setRenamingId(null);
                          }}
                          autoFocus
                        />
                      ) : (
                        <span>{getDisplayName(item)}</span>
                      )}
                    </button>
                    {currentFolderId === DELETED_FOLDER_ID ? (
                      <button
                        className="icon"
                        aria-label="Restore"
                        onClick={() => restoreItem(item.id)}
                      >
                        <Icon name="rotate-ccw" size={14} />
                      </button>
                    ) : (
                      <>
                        <button
                          className="icon"
                          aria-label="Rename"
                          onClick={() => startRename(item.id, item.name)}
                        >
                          <Icon name="edit-2" size={14} />
                        </button>
                        <button
                          className="icon"
                          aria-label="Delete"
                          onClick={() => deleteItem(item.id)}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>}
      </div>
    </div>
  );
};
