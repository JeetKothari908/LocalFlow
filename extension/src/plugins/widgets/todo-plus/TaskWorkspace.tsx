import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Data, Task } from "../todo/types";
import { Repeat } from "../todo/reducer";
import {
  createTask,
  updateTask,
  moveTask,
  completeTask,
  reopenTask,
  deleteTask,
  archiveTask,
  restoreTask,
  childrenOf,
  descendantsOf,
  taskPath,
  rootOf,
  blockersOf,
  previewScheduleShift,
  shiftSchedule,
  timelineIssues,
  ancestorsOf,
  outlineRows,
  blockerDetails,
  taskSummary,
  scheduleShiftIssues,
} from "../todo/tasks";
import TaskRow, { Mutation, deadline, finished, visible } from "./TaskRow";
import TaskMenu from "./TaskMenu";
import { DependencyView, TimelineView, HistoryView } from "./TaskPlanning";
import TaskMap from "./TaskMap";
import { MapDirection } from "./taskMapLayout";
import { taskWorkspacePlacement } from "./taskWorkspacePlacement";

export type Mode =
  | "focus"
  | "outline"
  | "dependencies"
  | "timeline"
  | "history";
type Draft = {
  contents: string;
  description: string;
  dueDate: string;
  dueTime: string;
  plannedStart: string;
  estimatedMinutes: string;
  priority: string;
  status: string;
  repeatType: string;
  repeatDays: number[];
  repeatDay: string;
  repeatScope: string;
  parentTaskId: string;
  listId: string;
};
const draftFor = (task: Task, data: Data): Draft => ({
  contents: task.contents,
  description: task.description ?? "",
  dueDate: task.dueDate ?? "",
  dueTime: task.dueTime ?? "",
  plannedStart: task.plannedStart ?? "",
  estimatedMinutes: String(task.estimatedMinutes ?? ""),
  priority: task.priority ?? "normal",
  status: task.status ?? (task.completed ? "done" : "todo"),
  repeatType: task.repeat?.type ?? "none",
  repeatDays:
    task.repeat && "days" in task.repeat ? task.repeat.days ?? [] : [],
  repeatDay:
    task.repeat?.type === "monthly"
      ? String(
          task.repeat.day ??
            Number(task.dueDate?.slice(8) ?? new Date().getDate()),
        )
      : "",
  repeatScope:
    task.repeatScope ?? (childrenOf(data, task.id).length ? "branch" : "task"),
  parentTaskId: task.parentTaskId ?? "",
  listId: rootOf(data, task.id)?.listId ?? "",
});
type Props = {
  task: Task;
  mapRootId: string;
  anchor: React.RefObject<HTMLDivElement>;
  data: Data;
  now: Date;
  initialMode: Mode;
  outlineTarget?: string;
  mutate: Mutation;
  onOpen: (id: string, mode?: Mode) => void;
  onClose: () => void;
  onComplete: (task: Task) => void;
  onModeChange: (mode: Mode) => void;
  error: string;
  confirmComplete: boolean;
  onDismissConfirmation: () => void;
  notice: string;
  onUndo?: () => void;
};

export default function TaskWorkspace({
  task,
  mapRootId,
  anchor,
  data,
  now,
  initialMode,
  outlineTarget,
  mutate,
  onOpen,
  onClose,
  onComplete,
  onModeChange,
  error,
  notice,
  onUndo,
  confirmComplete,
  onDismissConfirmation,
}: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [expanded, setExpanded] = useState(
    () =>
      new Set([
        mapRootId,
        task.id,
        ...(outlineTarget
          ? ancestorsOf(data, outlineTarget).map((item) => item.id)
          : []),
      ]),
  );
  const [newTitle, setNewTitle] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFor(task, data));
  const originalDraft = useRef(draft);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [shiftDays, setShiftDays] = useState(0);
  const [copied, setCopied] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const [pendingCompletion, setPendingCompletion] = useState<
    "save" | "permanent" | null
  >(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [direction, setDirection] = useState<MapDirection>("left");
  const [dock, setDock] = useState<React.CSSProperties>({
    left: 16,
    bottom: 16,
    width: "min(600px, calc(100vw - 32px))",
    height: "min(300px, 33.333dvh)",
  });
  useLayoutEffect(() => {
    const position = () => {
      if (!anchor.current) return;
      const panel = anchor.current.closest(".SidePanel"),
        origin = (panel ?? anchor.current).getBoundingClientRect(),
        nextDirection: MapDirection = panel
          ? panel.classList.contains("side-panel-left")
            ? "right"
            : "left"
          : (origin.left + origin.right) / 2 < window.innerWidth / 2
            ? "right"
            : "left",
        opposite = document.querySelector(
          nextDirection === "left" ? ".side-panel-left" : ".side-panel-right",
        ),
        row = Array.from(
          anchor.current.querySelectorAll<HTMLElement>(
            ".task-row[data-task-id]",
          ),
        ).find((item) => item.dataset.taskId === mapRootId);
      setDirection(nextDirection);
      setDock(
        taskWorkspacePlacement(
          origin,
          row?.getBoundingClientRect() ??
            anchor.current.getBoundingClientRect(),
          nextDirection,
          { width: window.innerWidth, height: window.innerHeight },
          opposite?.getBoundingClientRect(),
        ),
      );
    };
    position();
    const observer = new ResizeObserver(position);
    if (anchor.current) observer.observe(anchor.current);
    document
      .querySelectorAll(".SidePanel")
      .forEach((panel) => observer.observe(panel));
    const pageScrolled = (event: Event) => {
      if (
        !(
          event.target instanceof Element &&
          event.target.closest(".TaskWorkspace")
        )
      )
        position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", pageScrolled, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", pageScrolled, true);
    };
  }, [anchor, mapRootId]);
  useEffect(() => {
    const next = draftFor(task, data);
    originalDraft.current = next;
    setDraft(next);
    setEditing(false);
    setShiftOpen(false);
    setPendingCompletion(null);
    setCopied(false);
    setMenuDismissed(false);
    setSettingsOpen(true);
    setExpanded(
      (value) =>
        new Set([
          ...value,
          task.id,
          ...ancestorsOf(data, task.id).map((item) => item.id),
        ]),
    );
  }, [task.id]);
  useEffect(() => {
    const outsideMenu = (target: EventTarget | null) => {
      if (confirmComplete || pendingCompletion || !(target instanceof Element))
        return false;
      if (
        target.closest(
          ".workspace-settings,.map-toolbar .mobile-settings-toggle,[aria-label='Close task workspace']",
        )
      )
        return false;
      const menu = workspace.current?.querySelector(".workspace-settings");
      return !!menu && getComputedStyle(menu).display !== "none";
    };
    const dismissOnClick = (event: MouseEvent) => {
      if (!outsideMenu(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("click", dismissOnClick, true);
    return () => document.removeEventListener("click", dismissOnClick, true);
  }, [confirmComplete, pendingCompletion]);
  useEffect(() => {
    if (!confirmComplete && !pendingCompletion) return;
    setSettingsOpen(true);
    const review = workspace.current?.querySelector<HTMLElement>(
      ".completion-confirm",
    );
    review?.scrollIntoView({ block: "center" });
    review?.focus({ preventScroll: true });
  }, [confirmComplete, pendingCompletion, settingsOpen]);
  useEffect(() => {
    setMode(initialMode);
    if (outlineTarget)
      setExpanded(
        new Set([
          mapRootId,
          ...ancestorsOf(data, outlineTarget).map((item) => item.id),
        ]),
      );
  }, [initialMode, outlineTarget]);
  useEffect(() => {
    if (mode !== "outline" || !outlineTarget) return;
    const row = Array.from(
      workspace.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [],
    ).find((element) => element.dataset.taskId === outlineTarget);
    row?.scrollIntoView({ block: "center" });
  }, [mode, expanded, outlineTarget]);
  const listName =
    data.customLists?.find((list) => list.id === rootOf(data, task.id)?.listId)
      ?.name ?? "Inbox";
  const unavailable = !!(task.deletedAt || task.archivedAt || task.dismissed);
  const branch = [task, ...descendantsOf(data, task.id)].filter((item) =>
    visible(data, item),
  );
  const branchIds = new Set([
    task.id,
    ...descendantsOf(data, task.id, true).map((item) => item.id),
  ]);
  const completionIds = new Set(
    branch.filter((item) => !finished(item)).map((item) => item.id),
  );
  const issues = timelineIssues(data, task.id);
  const summary = taskSummary(data, task.id);
  const blockers = blockerDetails(data, task.id);
  const rows = outlineRows(
    data,
    task.id,
    mode === "outline" ? expanded : new Set(),
  );
  const unfinished = branch.filter(
    (item) => item.id !== task.id && !finished(item),
  );
  const reorder = (item: Task, offset: number) => {
    const siblings = childrenOf(data, item.parentTaskId);
    const index =
      siblings.findIndex((sibling) => sibling.id === item.id) + offset;
    if (index >= 0 && index < siblings.length)
      mutate((value) =>
        moveTask(
          value,
          item.id,
          item.parentTaskId,
          rootOf(value, item.id)?.listId,
          index,
        ),
      );
  };
  const indent = (item: Task) => {
    const siblings = childrenOf(data, item.parentTaskId);
    const previous =
      siblings[siblings.findIndex((sibling) => sibling.id === item.id) - 1];
    if (previous) {
      mutate((value) => moveTask(value, item.id, previous.id));
      setExpanded((value) => new Set([...value, previous.id]));
    }
  };
  const outdent = (item: Task) => {
    const parent = data.items.find(
      (candidate) => candidate.id === item.parentTaskId,
    );
    if (parent)
      mutate((value) =>
        moveTask(
          value,
          item.id,
          parent.parentTaskId,
          rootOf(value, item.id)?.listId,
        ),
      );
  };
  const field = (key: keyof Draft, value: string) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const startEdit = () => {
    const next = draftFor(task, data);
    originalDraft.current = next;
    setDraft(next);
    setEditing(!editing);
  };
  const setSchedule = (
    patch: Pick<Partial<Task>, "dueDate" | "dueTime" | "repeat">,
  ) =>
    mutate((value) => {
      const current = value.items.find((item) => item.id === task.id);
      if (!current) throw new Error("Task no longer exists.");
      const nextDate = Object.prototype.hasOwnProperty.call(patch, "dueDate")
        ? patch.dueDate
        : current.dueDate;
      const nextRepeat = Object.prototype.hasOwnProperty.call(patch, "repeat")
        ? patch.repeat
        : current.repeat;
      const nextTime = Object.prototype.hasOwnProperty.call(patch, "dueTime")
        ? patch.dueTime
        : current.dueTime;
      return updateTask(value, task.id, {
        ...patch,
        dueTime: nextDate || nextRepeat ? nextTime ?? "23:59" : undefined,
      });
    }, "Task schedule updated");
  const chooseRepeat = (type: "none" | Repeat["type"]) => {
    const repeat: Repeat | undefined =
      type === "none"
        ? undefined
        : type === "daily"
          ? { type: "daily" }
          : type === "weekly"
            ? {
                type: "weekly",
                days:
                  task.repeat?.type === "weekly"
                    ? task.repeat.days
                    : task.repeat?.type === "custom"
                      ? task.repeat.days
                      : [now.getDay()],
              }
            : type === "custom"
              ? {
                  type: "custom",
                  days:
                    task.repeat?.type === "custom"
                      ? task.repeat.days
                      : [now.getDay()],
                }
              : {
                  type: "monthly",
                  day:
                    task.repeat?.type === "monthly"
                      ? task.repeat.day
                      : task.dueDate
                        ? Number(task.dueDate.slice(8))
                        : now.getDate(),
                };
    setSchedule({ repeat });
  };
  const chooseDay = (day: number) => {
    const repeat = task.repeat;
    if (repeat?.type === "weekly")
      setSchedule({ repeat: { type: "weekly", days: [day] } });
    if (repeat?.type === "custom") {
      const days = repeat.days.includes(day)
        ? repeat.days.filter((item) => item !== day)
        : [...repeat.days, day].sort();
      if (days.length) setSchedule({ repeat: { type: "custom", days } });
    }
  };
  const save = (cascade = false) => {
    const original = originalDraft.current;
    const changed = (key: keyof Draft) =>
      JSON.stringify(draft[key]) !== JSON.stringify(original[key]);
    if (
      changed("status") &&
      draft.status === "done" &&
      unfinished.length &&
      !cascade
    ) {
      setPendingCompletion("save");
      return;
    }
    const patch: Partial<Task> = {};
    if (changed("contents")) patch.contents = draft.contents;
    if (changed("description"))
      patch.description = draft.description || undefined;
    if (changed("dueDate")) patch.dueDate = draft.dueDate || undefined;
    if (changed("plannedStart"))
      patch.plannedStart = draft.plannedStart || undefined;
    if (changed("estimatedMinutes"))
      patch.estimatedMinutes = draft.estimatedMinutes
        ? Number(draft.estimatedMinutes)
        : undefined;
    if (changed("priority"))
      patch.priority = draft.priority as Task["priority"];
    if (changed("repeatScope"))
      patch.repeatScope = draft.repeatScope as Task["repeatScope"];
    if (
      changed("repeatType") ||
      changed("repeatDays") ||
      changed("repeatDay")
    ) {
      const repeat: Repeat | undefined =
        draft.repeatType === "none"
          ? undefined
          : draft.repeatType === "daily"
            ? { type: "daily" }
            : draft.repeatType === "monthly"
              ? {
                  type: "monthly",
                  day: draft.repeatDay
                    ? Number(draft.repeatDay)
                    : draft.dueDate
                      ? Number(draft.dueDate.slice(8))
                      : now.getDate(),
                }
              : draft.repeatType === "weekly"
                ? {
                    type: "weekly",
                    days: draft.repeatDays.length
                      ? draft.repeatDays
                      : [now.getDay()],
                  }
                : { type: "custom", days: draft.repeatDays };
      patch.repeat = repeat;
      patch.repeatScope = draft.repeatScope as Task["repeatScope"];
    }
    if (
      mutate((value) => {
        const currentTask = value.items.find((item) => item.id === task.id);
        if (!currentTask || currentTask.deletedAt)
          throw new Error(
            "This task was removed while you were editing. Your draft has been preserved.",
          );
        const current = draftFor(currentTask, value);
        const overlaps = (Object.keys(original) as Array<keyof Draft>).filter(
          (key) =>
            changed(key) &&
            JSON.stringify(current[key]) !== JSON.stringify(original[key]) &&
            JSON.stringify(current[key]) !== JSON.stringify(draft[key]),
        );
        if (overlaps.length)
          throw new Error(
            "The same task details changed while you were editing. Reload the latest details before saving; your changes have not overwritten them.",
          );
        if (changed("dueTime") || changed("dueDate") || changed("repeatType")) {
          const finalDate = Object.prototype.hasOwnProperty.call(
            patch,
            "dueDate",
          )
            ? patch.dueDate
            : currentTask.dueDate;
          const finalRepeat = Object.prototype.hasOwnProperty.call(
            patch,
            "repeat",
          )
            ? patch.repeat
            : currentTask.repeat;
          patch.dueTime =
            finalDate || finalRepeat
              ? changed("dueTime")
                ? draft.dueTime || "23:59"
                : currentTask.dueTime ?? "23:59"
              : undefined;
        }
        let next = Object.keys(patch).length
          ? updateTask(value, task.id, patch)
          : value;
        if (changed("parentTaskId") || changed("listId"))
          next = moveTask(
            next,
            task.id,
            draft.parentTaskId || undefined,
            draft.listId || undefined,
          );
        if (changed("status")) {
          if (draft.status === "done")
            next = completeTask(next, task.id, { cascade });
          else {
            if (next.items.find((item) => item.id === task.id)?.completed)
              next = reopenTask(next, task.id);
            next = updateTask(next, task.id, {
              status: draft.status as Task["status"],
            });
          }
        }
        return next;
      }, "Task saved")
    ) {
      setEditing(false);
      setPendingCompletion(null);
    }
  };
  let shiftPreview: ReturnType<typeof previewScheduleShift> = [];
  let shiftError = "";
  if (shiftOpen && Number.isInteger(shiftDays)) {
    try {
      shiftPreview = previewScheduleShift(data, task.id, shiftDays);
    } catch (reason) {
      shiftError = reason instanceof Error ? reason.message : String(reason);
    }
  }
  let shiftIssues = issues;
  if (shiftOpen && Number.isInteger(shiftDays) && shiftDays) {
    try {
      shiftIssues = scheduleShiftIssues(data, task.id, shiftDays);
    } catch {
      /* mutation displays validation on apply */
    }
  }

  return (
    <section
      ref={workspace}
      style={dock}
      data-direction={direction}
      data-compact={
        (typeof dock.width === "number" && dock.width < 480) ||
        window.innerWidth <= 740
      }
      className={`TaskWorkspace task-map-workspace${settingsOpen ? " mobile-settings-open" : ""}${menuDismissed ? " menu-dismissed" : ""}`}
      aria-label={`Task workspace: ${task.contents}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          editing ? setEditing(false) : onClose();
        }
      }}
    >
      <aside className="workspace-settings" aria-label="Task menu">
        <div className="settings-heading">
          <span>Task menu</span>
          <button
            className="mobile-settings-toggle"
            onClick={() => setSettingsOpen(false)}
          >
            Hide
          </button>
        </div>
        <TaskMenu
          task={task}
          data={data}
          listName={listName}
          unavailable={unavailable}
          editing={editing}
          onComplete={onComplete}
          onEdit={startEdit}
          onSchedule={setSchedule}
          onChooseRepeat={chooseRepeat}
          onChooseDay={chooseDay}
          onMoveList={(listId) =>
            mutate(
              (value) => moveTask(value, task.id, undefined, listId),
              "Task moved",
            )
          }
        />
        <footer className="workspace-actions" aria-label="Task actions">
          <button
            onClick={() => {
              setShiftOpen(!shiftOpen);
              setShiftDays(0);
            }}
          >
            Shift schedule
          </button>
          <button
            onClick={() => {
              navigator.clipboard
                .writeText(
                  `${location.href.split("#")[0]}#task=${encodeURIComponent(task.id)}`,
                )
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? "Link copied" : "Copy task link"}
          </button>
          {task.repeat && (
            <button
              onClick={() => {
                if (unfinished.length) setPendingCompletion("permanent");
                else
                  mutate(
                    (value) =>
                      completeTask(value, task.id, { permanent: true }),
                    "Recurring task finished",
                  );
              }}
            >
              Finish recurring task
            </button>
          )}
          <button
            onClick={() => {
              if (
                mutate((value) => archiveTask(value, task.id), "Task archived")
              )
                onClose();
            }}
          >
            Archive
          </button>
          <button
            className="danger"
            onClick={() => {
              if (
                mutate(
                  (value) => deleteTask(value, task.id),
                  "Branch moved to trash",
                )
              )
                onClose();
            }}
          >
            Move to trash
          </button>
        </footer>
        {!!blockers.length && !finished(task) && (
          <div className="task-blockers">
            Waiting on: {blockers.map(({ task: blocker, inheritedFrom }, index) => (
              <React.Fragment key={blocker.id}>
                {index > 0 && ", "}
                <button onClick={() => onOpen(blocker.id)}>{blocker.contents}</button>
                {inheritedFrom && <> through <button onClick={() => onOpen(inheritedFrom.id)}>{inheritedFrom.contents}</button></>}
              </React.Fragment>
            ))}
          </div>
        )}
        {summary.unscheduled > 0 && (
          <p className="planning-note">
            {summary.unscheduled} unfinished subtask{summary.unscheduled === 1 ? "" : "s"} have no deadline.
          </p>
        )}
        {unavailable && (
          <div className="task-unavailable">
            <p>
              {task.deletedAt
                ? "This branch is in trash. Restore it to continue working."
                : "This branch is archived. Restore it to continue working."}
            </p>
            <button
              onClick={() =>
                mutate(
                  (value) =>
                    task.deletedAt
                      ? restoreTask(value, task.id)
                      : archiveTask(value, task.id, false),
                  "Branch restored",
                )
              }
            >
              Restore branch
            </button>
          </div>
        )}
        {(notice || onUndo) && (
          <div className="task-status" aria-live="polite">
            {notice}
            {onUndo && <button onClick={onUndo}>Undo</button>}
          </div>
        )}
        {error && (
          <p className="task-error" role="alert">
            {error}
          </p>
        )}
        {editing && (
          <form
            className="task-editor"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <details open className="settings-group">
              <summary>Name and notes</summary>
              <label className="span-full">
                Task name
                <input
                  required
                  value={draft.contents}
                  onChange={(event) => field("contents", event.target.value)}
                />
              </label>
              <label className="span-full">
                Description
                <textarea
                  rows={3}
                  value={draft.description}
                  onChange={(event) => field("description", event.target.value)}
                />
              </label>
            </details>
            <details className="settings-group">
              <summary>Dates and effort</summary>
              <label>
                Deadline
                <input
                  type="date"
                  value={draft.dueDate}
                  onChange={(event) => field("dueDate", event.target.value)}
                />
              </label>
              <label>
                Due time
                <input
                  type="time"
                  disabled={!draft.dueDate && draft.repeatType === "none"}
                  value={draft.dueTime}
                  onChange={(event) => field("dueTime", event.target.value)}
                />
              </label>
              <label>
                Planned start
                <input
                  type="date"
                  value={draft.plannedStart}
                  onChange={(event) =>
                    field("plannedStart", event.target.value)
                  }
                />
              </label>
              <label>
                Estimated minutes
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={draft.estimatedMinutes}
                  onChange={(event) =>
                    field("estimatedMinutes", event.target.value)
                  }
                />
              </label>
            </details>
            <details open className="settings-group">
              <summary>State and priority</summary>
              <label>
                Priority
                <select
                  value={draft.priority}
                  onChange={(event) => field("priority", event.target.value)}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label>
                State
                <select
                  value={draft.status}
                  onChange={(event) => field("status", event.target.value)}
                >
                  <option value="todo">To do</option>
                  <option value="inProgress">In progress</option>
                  <option value="done">Done</option>
                  <option value="canceled">Canceled</option>
                </select>
              </label>
            </details>
            <details className="settings-group">
              <summary>Repeat</summary>
              <label>
                Repeat
                <select
                  value={draft.repeatType}
                  onChange={(event) => field("repeatType", event.target.value)}
                >
                  <option value="none">None</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="custom">Selected weekdays</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Repeat scope
                <select
                  value={draft.repeatScope}
                  onChange={(event) => field("repeatScope", event.target.value)}
                >
                  <option value="task">This task</option>
                  <option value="branch">Task and subtasks</option>
                </select>
              </label>
              {draft.repeatType === "monthly" && (
                <label>
                  Day of month
                  <select
                    value={draft.repeatDay}
                    onChange={(event) => field("repeatDay", event.target.value)}
                  >
                    <option value="">Use deadline day</option>
                    {Array.from({ length: 31 }, (_, index) => index + 1).map(
                      (day) => (
                        <option key={day} value={String(day)}>
                          {day}
                        </option>
                      ),
                    )}
                  </select>
                  <small>Uses the last day in shorter months.</small>
                </label>
              )}
              {(draft.repeatType === "weekly" ||
                draft.repeatType === "custom") && (
                <fieldset className="span-full repeat-days">
                  <legend>Repeat on</legend>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                    (label, index) => (
                      <label key={label}>
                        <input
                          type="checkbox"
                          checked={draft.repeatDays.includes(index)}
                          onChange={() =>
                            setDraft((value) => ({
                              ...value,
                              repeatDays: value.repeatDays.includes(index)
                                ? value.repeatDays.filter(
                                    (day) => day !== index,
                                  )
                                : [...value.repeatDays, index],
                            }))
                          }
                        />
                        {label}
                      </label>
                    ),
                  )}
                </fieldset>
              )}
            </details>
            <details className="settings-group">
              <summary>Parent and list</summary>
              <label className="span-full">
                Parent task
                <select
                  value={draft.parentTaskId}
                  onChange={(event) =>
                    field("parentTaskId", event.target.value)
                  }
                >
                  <option value="">Top level task</option>
                  {data.items
                    .filter(
                      (item) => visible(data, item) && !branchIds.has(item.id),
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {taskPath(data, item.id)
                          .map((ancestor) => ancestor.contents)
                          .join(" › ")}
                      </option>
                    ))}
                </select>
              </label>
              {!draft.parentTaskId && (
                <label>
                  List
                  <select
                    value={draft.listId}
                    onChange={(event) => field("listId", event.target.value)}
                  >
                    <option value="">Inbox</option>
                    {data.customLists
                      ?.filter((list) => !list.deletedAt)
                      .map((list) => (
                        <option key={list.id} value={list.id}>
                          {list.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </details>
            <div className="span-full editor-actions">
              <button type="submit" className="primary">
                Save changes
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = draftFor(task, data);
                  originalDraft.current = next;
                  setDraft(next);
                }}
              >
                Reload latest details
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {(confirmComplete || pendingCompletion) && (
          <div
            className="completion-confirm"
            role="region"
            tabIndex={-1}
            aria-label="Review branch completion"
          >
            <p>
              Complete {task.contents} and {unfinished.length} unfinished
              subtask{unfinished.length === 1 ? "" : "s"}? Earlier completions
              keep their original dates.
            </p>
            <ul className="completion-preview">
              {unfinished.map((item) => (
                <li key={item.id}>
                  <strong>{item.contents}</strong>
                  <small>
                    {taskPath(data, item.id)
                      .slice(0, -1)
                      .map((ancestor) => ancestor.contents)
                      .join(" › ")}{" "}
                    · {deadline(item)}
                  </small>
                  {blockerDetails(data, item.id).some(
                    ({ task: blocker }) => !completionIds.has(blocker.id),
                  ) && (
                    <small className="task-blockers">
                      Requires prerequisite resolution before completion
                    </small>
                  )}
                </li>
              ))}
            </ul>
            <button
              className="primary"
              onClick={() => {
                if (pendingCompletion === "save") {
                  save(true);
                  return;
                }
                if (
                  mutate(
                    (value) =>
                      completeTask(value, task.id, {
                        cascade: true,
                        permanent: pendingCompletion === "permanent",
                      }),
                    "Branch completed",
                  )
                ) {
                  setPendingCompletion(null);
                  onDismissConfirmation();
                }
              }}
            >
              Complete remaining subtasks
            </button>
            <button
              onClick={() => {
                setPendingCompletion(null);
                onDismissConfirmation();
              }}
            >
              Keep working
            </button>
          </div>
        )}
        <label className="workspace-view-menu">
          View
          <select
            aria-label="Task view"
            value={mode}
            onChange={(event) => onModeChange(event.target.value as Mode)}
          >
            <option value="focus">Subtask map</option>
            <option value="outline">Outline editor</option>
            <option value="dependencies">Dependencies</option>
            <option value="timeline">Timeline</option>
            <option value="history">History</option>
          </select>
        </label>
        <details className="settings-group">
          <summary>Reorganize task</summary>
          <div className="structure-actions">
            <button onClick={() => reorder(task, -1)}>Move up</button>
            <button onClick={() => reorder(task, 1)}>Move down</button>
            <button onClick={() => indent(task)}>
              Indent under previous task
            </button>
            <button disabled={!task.parentTaskId} onClick={() => outdent(task)}>
              Outdent one level
            </button>
          </div>
        </details>
        {mode !== "history" &&
          issues.some((issue) => issue.type !== "unscheduled") && (
            <details className="schedule-warnings">
              <summary>
                {issues.filter((issue) => issue.type !== "unscheduled").length}{" "}
                scheduling conflict(s)
              </summary>
              {issues
                .filter((issue) => issue.type !== "unscheduled")
                .map((issue, index) => (
                  <p key={index}>{issue.message}</p>
                ))}
            </details>
          )}
        {shiftOpen && (
          <div className="schedule-shift">
            <label>
              Shift this branch by{" "}
              <input
                type="number"
                step="1"
                min="-36500"
                max="36500"
                value={shiftDays}
                onChange={(event) => setShiftDays(Number(event.target.value))}
              />{" "}
              days
            </label>
            <div className="shift-preview">
              {shiftPreview.map((item) => (
                <p key={item.taskId}>
                  <span>
                    {
                      data.items.find(
                        (candidate) => candidate.id === item.taskId,
                      )?.contents
                    }
                  </span>
                  <small>
                    {item.fromDueDate && (
                      <span>
                        Deadline: {item.fromDueDate} → {item.toDueDate}
                      </span>
                    )}
                    {item.fromPlannedStart && (
                      <span>
                        Start: {item.fromPlannedStart} → {item.toPlannedStart}
                      </span>
                    )}
                  </small>
                </p>
              ))}
            </div>
            {shiftError && (
              <p className="task-error" role="alert">
                {shiftError}
              </p>
            )}
            {shiftIssues
              .filter((issue) => issue.type !== "unscheduled")
              .map((issue, index) => (
                <p className="task-error" key={index}>
                  {taskPath(data, issue.taskId)
                    .map((item) => item.contents)
                    .join(" \u203a ")}
                  : {issue.message}
                </p>
              ))}
            <button
              className="primary"
              disabled={
                !!shiftError || !Number.isInteger(shiftDays) || !shiftDays
              }
              onClick={() => {
                if (
                  mutate(
                    (value) => shiftSchedule(value, task.id, shiftDays),
                    "Schedule shifted",
                  )
                )
                  setShiftOpen(false);
              }}
            >
              Apply shift
            </button>
            <button onClick={() => setShiftOpen(false)}>Cancel</button>
          </div>
        )}
      </aside>
      <div className="workspace-map-area">
        <header className="map-toolbar">
          <button
            className="mobile-settings-toggle"
            aria-expanded={!menuDismissed && settingsOpen}
            onClick={() => {
              setMenuDismissed(false);
              setSettingsOpen(menuDismissed || !settingsOpen);
            }}
          >
            Menu
          </button>
          <div>
            <strong>
              {data.items.find((item) => item.id === mapRootId)?.contents ??
                task.contents}
            </strong>
            <small>
              {mode === "focus"
                ? `Subtasks unfold to the ${direction}. Select a task to explore.`
                : `Planning ${task.contents}`}
            </small>
          </div>
          <button aria-label="Close task workspace" onClick={onClose}>
            ×
          </button>
        </header>
        <div
          className="workspace-content"
          id="task-view-panel"
          role="region"
          aria-label={`${mode} view`}
          tabIndex={0}
        >
          {mode === "focus" && (
            <TaskMap
              direction={direction}
              data={data}
              rootId={mapRootId}
              selectedId={task.id}
              expanded={expanded}
              now={now}
              mutate={mutate}
              onComplete={onComplete}
              onSelect={(id) => {
                setExpanded((value) => new Set([...value, id]));
                onOpen(id, "focus");
              }}
              onExpand={(id) =>
                setExpanded((value) => {
                  const next = new Set(value);
                  next.has(id) ? next.delete(id) : next.add(id);
                  return next;
                })
              }
            />
          )}
          {mode === "outline" && (
            <>
              <div
                className="workspace-subtasks"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData(
                    "application/localflow-task",
                  );
                  if (id) mutate((value) => moveTask(value, id, task.id));
                }}
              >
                {rows.length ? (
                  rows.map(({ task: item, depth, guides, isLast }) => (
                    <TaskRow
                      key={item.id}
                      task={item}
                      data={data}
                      now={now}
                      depth={depth}
                      guides={mode === "outline" ? guides : undefined}
                      isLast={isLast}
                      highlighted={
                        mode === "outline" && item.id === outlineTarget
                      }
                      onOpen={onOpen}
                      onComplete={onComplete}
                      onExpand={
                        mode === "outline"
                          ? () =>
                              setExpanded((value) => {
                                const next = new Set(value);
                                next.has(item.id)
                                  ? next.delete(item.id)
                                  : next.add(item.id);
                                return next;
                              })
                          : undefined
                      }
                      expanded={expanded.has(item.id)}
                      canIndent={
                        childrenOf(data, item.parentTaskId).findIndex(
                          (sibling) => sibling.id === item.id,
                        ) > 0
                      }
                      canMoveUp={
                        childrenOf(data, item.parentTaskId).findIndex(
                          (sibling) => sibling.id === item.id,
                        ) > 0
                      }
                      canMoveDown={
                        childrenOf(data, item.parentTaskId).findIndex(
                          (sibling) => sibling.id === item.id,
                        ) <
                        childrenOf(data, item.parentTaskId).length - 1
                      }
                      onReorder={(offset) => reorder(item, offset)}
                      onIndent={() => indent(item)}
                      onOutdent={() => outdent(item)}
                      onDrop={(id) =>
                        mutate((value) => moveTask(value, id, item.id))
                      }
                    />
                  ))
                ) : (
                  <p className="empty-state">
                    Add the steps needed to complete this task.
                  </p>
                )}
              </div>
              <form
                className="task-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    newTitle.trim() &&
                    mutate(
                      (value) =>
                        createTask(value, {
                          contents: newTitle,
                          parentTaskId: task.id,
                        }),
                      "Subtask added",
                    )
                  )
                    setNewTitle("");
                }}
              >
                <input
                  disabled={unavailable}
                  aria-label="New subtask"
                  placeholder="Add subtask"
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                />
                <button disabled={unavailable} type="submit">
                  Add
                </button>
              </form>
              {mode === "outline" && (
                <p className="planning-note">
                  Drag onto a task to nest it. Alt + arrow keys reorder, indent,
                  or outdent the focused task.
                </p>
              )}
            </>
          )}
          {mode === "dependencies" && (
            <DependencyView
              data={data}
              task={task}
              mutate={mutate}
              onOpen={onOpen}
            />
          )}
          {mode === "timeline" && (
            <TimelineView
              data={data}
              tasks={branch}
              now={now}
              onOpen={onOpen}
            />
          )}
          {mode === "history" && (
            <HistoryView data={data} taskIds={branchIds} />
          )}
        </div>
        {mode === "focus" && (
          <form
            className="task-composer map-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                newTitle.trim() &&
                mutate(
                  (value) =>
                    createTask(value, {
                      contents: newTitle,
                      parentTaskId: task.id,
                    }),
                  "Subtask added",
                )
              ) {
                setNewTitle("");
                setExpanded((value) => new Set([...value, task.id]));
              }
            }}
          >
            <input
              disabled={unavailable}
              aria-label="New subtask"
              placeholder={`Add a subtask to ${task.contents}`}
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
            />
            <button disabled={unavailable} type="submit">
              Add
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
