import React, { FC, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { nanoid } from "nanoid";
import { useTime } from "../../../hooks";
import { Data, Props, Task, defaultData } from "../todo/types";
import {
  normalizeTaskData,
  createTask,
  completeTask,
  reopenTask,
  descendantsOf,
  childrenOf,
  blockersOf,
  dueTasks,
  moveTask,
  restoreTask,
  archiveTask,
  deleteCustomList,
  rootOf,
  taskPath,
  ancestorsOf,
} from "../todo/tasks";
import TaskRow, {
  Mutation,
  dateKey,
  finished,
  visible,
  occurrenceTitle,
} from "./TaskRow";
import TaskWorkspace, { Mode } from "./TaskWorkspace";
import "./Tasks.sass";

const TodoPlus: FC<Props> = ({ data: raw = defaultData, setData }) => {
  const data = useMemo(() => normalizeTaskData(raw), [raw]);
  const latest = useRef<Data>(data);
  latest.current = data;
  const now = useTime("absolute");
  const today = dateKey(now);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [listId, setListId] = useState("");
  const [view, setView] = useState("projects");
  const [selection, setSelection] = useState<{
    id: string;
    rootId: string;
    mode: Mode;
    targetId?: string;
  } | null>(null);
  const [completeConfirmation, setCompleteConfirmation] = useState<
    string | null
  >(null);
  const [title, setTitle] = useState("");
  const [quickTitle, setQuickTitle] = useState("");
  const [quickProject, setQuickProject] = useState("");
  const [search, setSearch] = useState("");
  const [newList, setNewList] = useState("");
  const [rename, setRename] = useState("");
  const [readyOnly, setReadyOnly] = useState(false);
  const [priorityFirst, setPriorityFirst] = useState(false);
  const [collapsed, setCollapsed] = useState({ due: false, projects: false });
  const [undo, setUndo] = useState<{ before: Data; after: Data } | null>(null);
  const composer = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const routedHash = useRef<string | null>(null);
  const lists = (data.customLists ?? []).filter((list) => !list.deletedAt);
  const roots = childrenOf(data).filter((task) => visible(data, task));
  const selected = data.items.find((task) => task.id === selection?.id);

  useEffect(() => {
    if (raw.schemaVersion !== 2) setData(data);
  }, [raw, data, setData]);
  useEffect(() => {
    if (listId && !lists.some((list) => list.id === listId)) setListId("");
  }, [lists, listId]);
  useEffect(() => {
    const navigate = () => {
      if (location.hash === routedHash.current) return;
      const match = location.hash.match(/^#task=(.+)$/);
      if (match) {
        try {
          const id = decodeURIComponent(match[1]);
          if (latest.current.items.some((task) => task.id === id)) {
            routedHash.current = location.hash;
            setSelection({ id, rootId: id, mode: "focus" });
            setError("");
          } else {
            setSelection(null);
            setError(
              "This task is not available on this device. Sync to load it, or choose a task from your lists.",
            );
          }
        } catch {
          setSelection(null);
          setError("This task link could not be opened.");
        }
      } else if (routedHash.current?.startsWith("#task=")) {
        routedHash.current = location.hash;
        setSelection(null);
      }
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [data.items]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.isContentEditable ||
        target.closest("input,textarea,select,dialog,.TaskWorkspace")
      )
        return;
      if (
        raw.keyBind &&
        event.key.toLowerCase() === raw.keyBind.toLowerCase() &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        composer.current?.focus();
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [raw.keyBind]);

  const mutate: Mutation = (operation, success = "") => {
    try {
      const before = latest.current;
      const next = operation(before);
      const previous = new Map(before.items.map((task) => [task.id, task]));
      const reopened = next.items.filter(
        (task) =>
          !finished(task) &&
          previous.get(task.id) &&
          finished(previous.get(task.id)!),
      );
      latest.current = next;
      setData(next);
      setUndo({ before, after: next });
      setError("");
      setMessage(
        [
          success,
          reopened.length
            ? `Reopened ${reopened.map((task) => task.contents).join(", ")} because unfinished work was restored or added`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };
  const undoChange = () => {
    if (!undo) return;
    if (JSON.stringify(latest.current) !== JSON.stringify(undo.after)) {
      setError(
        "Another change arrived. Undo is unavailable so that change is preserved.",
      );
      setUndo(null);
      return;
    }
    latest.current = undo.before;
    setData(undo.before);
    setUndo(null);
    setMessage("Change undone");
  };
  const open = (id: string, mode: Mode = "focus", targetId?: string) => {
    const hash = `#task=${encodeURIComponent(id)}`;
    history.replaceState(null, "", hash);
    routedHash.current = hash;
    setSelection({ id, rootId: id, mode, targetId });
    setError("");
    setCompleteConfirmation(null);
  };
  const openInMap = (id: string, mode: Mode = "focus") => {
    const rootId =
      selection &&
      (id === selection.rootId ||
        ancestorsOf(latest.current, id).some(
          (item) => item.id === selection.rootId,
        ))
        ? selection.rootId
        : id;
    const hash = `#task=${encodeURIComponent(id)}`;
    history.replaceState(null, "", hash);
    routedHash.current = hash;
    setSelection({ id, rootId, mode });
    setError("");
    setCompleteConfirmation(null);
  };
  const close = () => {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    routedHash.current = "";
    setSelection(null);
    setCompleteConfirmation(null);
  };
  const complete = (task: Task) => {
    if (finished(task)) {
      mutate((value) => reopenTask(value, task.id));
      return;
    }
    if (
      descendantsOf(latest.current, task.id).some(
        (child) => !finished(child) && visible(latest.current, child),
      )
    ) {
      open(task.id);
      setCompleteConfirmation(task.id);
      return;
    }
    mutate((value) => completeTask(value, task.id), "Task completed");
  };
  const add = (text: string, parentTaskId?: string, dueDate?: string) => {
    if (!text.trim()) return;
    if (
      mutate(
        (value) =>
          createTask(value, {
            contents: text,
            parentTaskId,
            listId: parentTaskId ? undefined : listId || undefined,
            dueDate,
          }),
        "Task added",
      )
    ) {
      setTitle("");
      setQuickTitle("");
    }
  };
  const row = (task: Task, context = false) => (
    <TaskRow
      key={task.id}
      task={task}
      data={data}
      now={now}
      onOpen={open}
      onComplete={complete}
      context={context}
    />
  );
  let due = dueTasks(data, today).filter((task) => !finished(task));
  if (readyOnly)
    due = due.filter(
      (task) =>
        !blockersOf(data, task.id).length &&
        (!task.plannedStart || task.plannedStart <= today),
    );
  if (priorityFirst) {
    const ranks = { high: 0, normal: 1, low: 2 };
    due = [...due].sort(
      (a, b) => ranks[a.priority ?? "normal"] - ranks[b.priority ?? "normal"],
    );
  }
  const doneToday = data.items.filter(
    (task) =>
      task.completedAt &&
      dateKey(new Date(task.completedAt)) === today &&
      finished(task) &&
      visible(data, task),
  );
  const matches = search.trim()
    ? data.items.filter(
        (task) =>
          visible(data, task) &&
          `${taskPath(data, task.id)
            .map((ancestor) => ancestor.contents)
            .join(" ")} ${task.description ?? ""}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      )
    : [];
  const projects = roots.filter((task) => (task.listId ?? "") === listId);
  const exportData = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `localflow-tasks-${today}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const dropRoot = (event: React.DragEvent) => {
    event.preventDefault();
    const id = event.dataTransfer.getData("application/localflow-task");
    if (id)
      mutate(
        (value) => moveTask(value, id, undefined, listId || undefined),
        "Task moved",
      );
  };

  return (
    <div ref={anchor} className={`TodoPlus${selected ? " task-map-open" : ""}`}>
      {error && !selected && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
      <div className="task-status" aria-live="polite">
        {message}
      </div>
      <section className="panel">
        <header>
          <button
            className="panel-title"
            aria-expanded={!collapsed.due}
            onClick={() =>
              setCollapsed((value) => ({ ...value, due: !value.due }))
            }
          >
            Due Today <span>{due.length}</span>
          </button>
          <details className="panel-options">
            <summary aria-label="Due Today options">···</summary>
            <label>
              <input
                type="checkbox"
                checked={readyOnly}
                onChange={(event) => setReadyOnly(event.target.checked)}
              />
              Ready to work
            </label>
            <label>
              <input
                type="checkbox"
                checked={priorityFirst}
                onChange={(event) => setPriorityFirst(event.target.checked)}
              />
              Sort by priority
            </label>
          </details>
        </header>
        {!collapsed.due && (
          <>
            <div className="task-list">
              {!!due.filter((task) => task.dueDate && task.dueDate < today)
                .length && <h3 className="queue-label">Overdue</h3>}
              {due
                .filter((task) => task.dueDate && task.dueDate < today)
                .map((task) => row(task, true))}
              {!!due.filter((task) => !task.dueDate || task.dueDate >= today)
                .length && <h3 className="queue-label">Today</h3>}
              {due
                .filter((task) => !task.dueDate || task.dueDate >= today)
                .map((task) => row(task, true))}
              {!due.length && (
                <p className="empty-state">
                  {readyOnly
                    ? "No due tasks are ready to work."
                    : "Nothing due today."}
                </p>
              )}
              <details className="completed-today">
                <summary>
                  Completed today (
                  {doneToday.length +
                    (data.occurrences ?? []).filter(
                      (item) => dateKey(new Date(item.completedAt)) === today,
                    ).length}
                  )
                </summary>
                {doneToday.map((task) => row(task, true))}
                {(data.occurrences ?? [])
                  .filter(
                    (item) => dateKey(new Date(item.completedAt)) === today,
                  )
                  .map((item) => (
                    <p key={item.id}>
                      ✓ {occurrenceTitle(item)}{" "}
                      <small>Occurrence completed</small>
                    </p>
                  ))}
              </details>
            </div>
            <form
              className="quick-task"
              onSubmit={(event) => {
                event.preventDefault();
                add(quickTitle, quickProject || undefined, today);
              }}
            >
              <input
                aria-label="New task due today"
                placeholder="Add a task due today"
                value={quickTitle}
                onChange={(event) => setQuickTitle(event.target.value)}
              />
              <select
                aria-label="Project for today's task"
                value={quickProject}
                onChange={(event) => setQuickProject(event.target.value)}
              >
                <option value="">New top level task</option>
                {roots
                  .filter((task) => !finished(task))
                  .map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.contents}
                    </option>
                  ))}
              </select>
              <button type="submit">Add</button>
            </form>
          </>
        )}
      </section>
      <section
        className="panel"
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropRoot}
      >
        <header>
          <select
            className="list-select"
            aria-label="Choose project list"
            value={view === "projects" ? listId : view}
            onChange={(event) => {
              const next = event.target.value;
              setView(
                next === "finished" || next === "trash" ? next : "projects",
              );
              if (next !== "finished" && next !== "trash") setListId(next);
            }}
          >
            <option value="">Inbox</option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
            <option value="finished">Finished</option>
            <option value="trash">Trash</option>
          </select>
          <button
            className="collapse-panel"
            aria-label="Collapse project list"
            onClick={() =>
              setCollapsed((value) => ({ ...value, projects: !value.projects }))
            }
          >
            {collapsed.projects ? "›" : "⌄"}
          </button>
          <details className="panel-options">
            <summary aria-label="List options">···</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  newList.trim() &&
                  mutate((value) => ({
                    ...value,
                    customLists: [
                      ...(value.customLists ?? []),
                      { id: nanoid(), name: newList.trim() },
                    ],
                  }))
                )
                  setNewList("");
              }}
            >
              <input
                aria-label="New list name"
                placeholder="New list name"
                value={newList}
                onChange={(event) => setNewList(event.target.value)}
              />
              <button type="submit">Add list</button>
            </form>
            {listId && (
              <>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      rename.trim() &&
                      mutate((value) => ({
                        ...value,
                        customLists: (value.customLists ?? []).map((list) =>
                          list.id === listId
                            ? { ...list, name: rename.trim() }
                            : list,
                        ),
                      }))
                    )
                      setRename("");
                  }}
                >
                  <input
                    aria-label="Rename list"
                    placeholder={lists.find((list) => list.id === listId)?.name}
                    value={rename}
                    onChange={(event) => setRename(event.target.value)}
                  />
                  <button type="submit">Rename</button>
                </form>
                <button
                  className="danger"
                  onClick={() => {
                    if (
                      mutate(
                        (value) => deleteCustomList(value, listId),
                        "Projects moved to Inbox",
                      )
                    )
                      setListId("");
                  }}
                >
                  Delete list
                </button>
              </>
            )}
            <button onClick={exportData}>
              Export tasks and migration backup
            </button>
          </details>
        </header>
        {!collapsed.projects && (
          <>
            <input
              className="task-search"
              type="search"
              aria-label="Search all tasks"
              placeholder="Search all tasks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="task-list">
              {search.trim() ? (
                matches.length ? (
                  matches.map((task) => (
                    <div key={task.id}>
                      {row(task, true)}
                      <button
                        className="open-outline"
                        onClick={() =>
                          open(
                            rootOf(data, task.id)?.id ?? task.id,
                            "outline",
                            task.id,
                          )
                        }
                      >
                        Open in outline
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="empty-state">No matching tasks.</p>
                )
              ) : view === "trash" ? (
                data.items
                  .filter(
                    (task) =>
                      task.deletedAt &&
                      (!task.parentTaskId ||
                        !data.items.find(
                          (parent) => parent.id === task.parentTaskId,
                        )?.deletedAt),
                  )
                  .map((task) => (
                    <div className="recovery-row" key={task.id}>
                      <span>{task.contents}</span>
                      <button
                        onClick={() =>
                          mutate(
                            (value) => restoreTask(value, task.id),
                            "Branch restored",
                          )
                        }
                      >
                        Restore branch
                      </button>
                    </div>
                  ))
              ) : view === "finished" ? (
                <>
                  {data.items
                    .filter(
                      (task) =>
                        (finished(task) || task.archivedAt || task.dismissed) &&
                        !task.deletedAt,
                    )
                    .map((task) => (
                      <div key={task.id}>
                        {row(task, true)}
                        {(task.archivedAt || task.dismissed) && (
                          <button
                            className="open-outline"
                            onClick={() =>
                              mutate(
                                (value) => archiveTask(value, task.id, false),
                                "Branch restored",
                              )
                            }
                          >
                            Restore to active tasks
                          </button>
                        )}
                      </div>
                    ))}
                  {(data.occurrences ?? [])
                    .slice()
                    .reverse()
                    .map((item) => (
                      <details className="occurrence" key={item.id}>
                        <summary>
                          {occurrenceTitle(item)} ·{" "}
                          {item.dueDate ?? item.completedAt.slice(0, 10)}
                        </summary>
                        {item.items.map((task) => (
                          <p key={task.id}>
                            {task.status === "canceled"
                              ? "−"
                              : task.completed
                                ? "✓"
                                : "○"}{" "}
                            {task.contents}
                            {task.status === "canceled" ? " (canceled)" : ""}
                          </p>
                        ))}
                      </details>
                    ))}
                </>
              ) : projects.length ? (
                projects.map((task) => row(task))
              ) : (
                <p className="empty-state">
                  Add a task. Break it into subtasks as the work grows.
                </p>
              )}
            </div>
            {view === "projects" && (
              <form
                className="task-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  add(title);
                }}
              >
                <input
                  ref={composer}
                  aria-label="New top level task"
                  placeholder="New task or project"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <button type="submit">Add</button>
              </form>
            )}
          </>
        )}
      </section>
      {selected &&
        selection &&
        ReactDOM.createPortal(
          <TaskWorkspace
            key={selection.rootId}
            task={selected}
            mapRootId={selection.rootId}
            anchor={anchor}
            data={data}
            now={now}
            initialMode={selection.mode}
            outlineTarget={selection.targetId}
            mutate={mutate}
            onOpen={openInMap}
            onClose={close}
            onComplete={complete}
            onModeChange={(mode) =>
              setSelection((value) => (value ? { ...value, mode } : null))
            }
            error={error}
            notice={message}
            onUndo={undo ? undoChange : undefined}
            confirmComplete={completeConfirmation === selected.id}
            onDismissConfirmation={() => setCompleteConfirmation(null)}
          />,
          document.body,
        )}
    </div>
  );
};
export default TodoPlus;
