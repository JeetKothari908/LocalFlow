import React, { useEffect, useId, useRef, useState } from "react";
import { Data, Task } from "../../../core/src/tasks/types";
import {
  ancestorsOf,
  blockerDetails,
  childrenOf,
  taskPath,
  taskProgress,
  taskSummary,
} from "../../../core/src/tasks/tasks";

export type Mutation = (
  operation: (data: Data) => Data,
  message?: string,
) => boolean;
export const finished = (task: Task) =>
  task.completed || task.status === "done" || task.status === "canceled";
export const visible = (data: Data, task: Task) =>
  !task.deletedAt &&
  !task.archivedAt &&
  !task.dismissed &&
  !ancestorsOf(data, task.id).some(
    (item) =>
      item.deletedAt ||
      item.archivedAt ||
      item.dismissed ||
      item.status === "canceled",
  );
export const occurrenceTitle = (occurrence: {
  taskId: string;
  items: Task[];
}) =>
  (
    occurrence.items.find((item) => item.id === occurrence.taskId) ??
    occurrence.items[0]
  )?.contents ?? "Recurring task";
export const deadline = (task: Task) =>
  task.dueDate
    ? `${task.dueDate}${task.dueTime ? ` · ${task.dueTime}` : ""}`
    : "No deadline";
export const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

type Props = {
  task: Task;
  data: Data;
  now: Date;
  onOpen: (id: string) => void;
  onComplete: (task: Task) => void;
  context?: boolean;
  depth?: number;
  expanded?: boolean;
  onExpand?: () => void;
  onReorder?: (offset: number) => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  onDrop?: (id: string) => void;
  guides?: boolean[];
  isLast?: boolean;
  highlighted?: boolean;
  canIndent?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  compact?: boolean;
};

export default function TaskRow({
  task,
  data,
  now,
  onOpen,
  onComplete,
  context,
  depth = 0,
  expanded,
  onExpand,
  onReorder,
  onIndent,
  onOutdent,
  onDrop,
  guides,
  isLast,
  highlighted,
  canIndent,
  canMoveUp,
  canMoveDown,
  compact = false,
}: Props) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsId = useId();
  const actionsMenu = useRef<HTMLDivElement>(null);
  const actionsToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (actionsMenu.current?.contains(target) || actionsToggle.current?.contains(target)) return;
      setActionsOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [actionsOpen]);
  const action = (operation: () => void) => {
    operation();
    setActionsOpen(false);
  };
  const path = taskPath(data, task.id);
  const children = childrenOf(data, task.id).filter(
    (item) => !compact || visible(data, item),
  );
  const progress = taskProgress(data, task.id);
  const blockers = blockerDetails(data, task.id);
  const today = dateKey(now);
  const summary =
    !task.parentTaskId && children.length
      ? taskSummary(data, task.id, today)
      : undefined;
  const overdue =
    !finished(task) &&
    !!task.dueDate &&
    (task.dueDate < today ||
      (task.dueDate === today &&
        (task.dueTime ?? "23:59") <
          `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`));
  return (
    <div
      data-task-id={task.id}
      className={`task-row${compact ? " task-row-compact" : ""}${finished(task) ? " task-done" : ""}${overdue ? " task-overdue" : ""}${highlighted ? " task-highlighted" : ""}`}
      style={{ paddingLeft: guides ? (depth + 1) * 14 : undefined }}
      onDragOver={onDrop ? (event) => event.preventDefault() : undefined}
      onDrop={
        onDrop
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              const id = event.dataTransfer.getData(
                "application/localflow-task",
              );
              if (id) onDrop(id);
            }
          : undefined
      }
    >
      {onExpand && children.length ? (
        <button
          className="task-expand"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${task.contents}`}
          aria-expanded={expanded}
          onClick={onExpand}
        >
          {expanded ? "⌄" : "›"}
        </button>
      ) : (
        <span className="task-expand-placeholder" />
      )}
      <button
        className="task-check"
        disabled={compact && !visible(data, task)}
        aria-label={`${finished(task) ? "Reopen" : "Complete"} ${task.contents}`}
        aria-pressed={finished(task)}
        onClick={() => onComplete(task)}
      >
        {task.status === "canceled" ? "−" : finished(task) ? "✓" : ""}
      </button>
      {guides && (
        <span className="outline-guides" aria-hidden="true">
          {guides.map((continuing, index) => (
            <span
              key={index}
              className={continuing ? "outline-vertical" : ""}
              style={{ left: index * 14 }}
            />
          ))}
          <span
            className={`outline-elbow${isLast ? " outline-last" : ""}`}
            style={{ left: depth * 14 }}
          />
        </span>
      )}
      <div className="task-row-body">
        <button
          className="task-title"
          title={task.contents}
          onClick={() => onOpen(task.id)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("application/localflow-task", task.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onKeyDown={(event) => {
            if (!event.altKey) return;
            const action =
              event.key === "ArrowRight"
                ? onIndent
                : event.key === "ArrowLeft"
                  ? onOutdent
                  : event.key === "ArrowUp"
                    ? () => onReorder?.(-1)
                    : event.key === "ArrowDown"
                      ? () => onReorder?.(1)
                      : undefined;
            if (action) {
              event.preventDefault();
              action();
            }
          }}
        >
          {task.contents}
        </button>
        {context && (
          <div className="task-context">
            {path.length > 1 ? (
              path.slice(0, -1).map((item, index) => (
                <React.Fragment key={item.id}>
                  {index > 0 && " › "}
                  <button onClick={() => onOpen(item.id)}>
                    {item.contents}
                  </button>
                </React.Fragment>
              ))
            ) : (
              <span>
                {data.customLists?.find((list) => list.id === task.listId)
                  ?.name ?? "Inbox"}
              </span>
            )}
          </div>
        )}
        <div
          className="task-meta"
          title={
            compact
              ? [
                  children.length
                    ? `${progress.completed} of ${progress.total} steps done`
                    : "",
                  deadline(task),
                  task.repeat
                    ? `Repeats ${task.repeat.type}${task.repeatScope === "branch" ? " branch" : ""}`
                    : "Does not repeat",
                  task.status ?? (task.completed ? "done" : "todo"),
                  task.priority === "high" ? "High priority" : "",
                  task.estimatedMinutes != null
                    ? `${task.estimatedMinutes} min`
                    : "",
                  blockers.length && !finished(task)
                    ? `Waiting on: ${blockers.map(({ task }) => task.contents).join(", ")}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" \u00b7 ")
              : undefined
          }
        >
          {children.length > 0 && (
            <span>
              {progress.completed} of {progress.total} steps done
              {progress.readyToComplete && !finished(task)
                ? " · Ready to complete"
                : ""}
            </span>
          )}
          {task.dueDate && <span>{deadline(task)}</span>}
          {task.priority === "high" && <span>High priority</span>}
          {task.repeat && (
            <span>
              ↻ {task.repeat.type}
              {task.repeatScope === "branch" ? " branch" : ""}
            </span>
          )}
          {compact && task.estimatedMinutes != null && (
            <span>{task.estimatedMinutes} min</span>
          )}
          {compact && blockers.length > 0 && !finished(task) && (
            <button
              className="compact-blocker"
              onClick={() => onOpen(blockers[0].task.id)}
            >
              Waiting
            </button>
          )}
          {summary && summary.dueToday > 0 && (
            <span>{summary.dueToday} due today</span>
          )}
          {summary && summary.overdue > 0 && (
            <span>{summary.overdue} overdue</span>
          )}
          {summary && summary.blocked > 0 && (
            <span>{summary.blocked} blocked</span>
          )}
        </div>
        {!compact && summary?.next && (
          <div className="task-next">
            Next deadline:{" "}
            <button onClick={() => onOpen(summary.next!.id)}>
              {summary.next.contents}
            </button>{" "}
            · {deadline(summary.next)}
          </div>
        )}
        {!compact && !!blockers.length && !finished(task) && (
          <div className="task-blockers">
            Waiting on:{" "}
            {blockers.map(({ task: blocker, inheritedFrom }, index) => (
              <React.Fragment key={blocker.id}>
                {index > 0 && ", "}
                <button onClick={() => onOpen(blocker.id)}>
                  {blocker.contents}
                  {blocker.deletedAt
                    ? " (in trash)"
                    : blocker.status === "canceled"
                      ? " (canceled)"
                      : ""}
                </button>
                {inheritedFrom && (
                  <>
                    {" "}
                    through{" "}
                    <button onClick={() => onOpen(inheritedFrom.id)}>
                      {inheritedFrom.contents}
                    </button>
                  </>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
        {actionsOpen && (
          <div
            ref={actionsMenu}
            id={actionsId}
            className="task-row-actions"
            role="group"
            aria-label={`Structure actions for ${task.contents}`}
          >
            <button onClick={() => action(() => onOpen(task.id))}>
              Open task details
            </button>
            <button
              disabled={!canMoveUp}
              onClick={() => action(() => onReorder?.(-1))}
            >
              Move up
            </button>
            <button
              disabled={!canMoveDown}
              onClick={() => action(() => onReorder?.(1))}
            >
              Move down
            </button>
            <button
              disabled={!canIndent}
              onClick={() => action(() => onIndent?.())}
            >
              Indent under previous task
            </button>
            <button
              disabled={!task.parentTaskId}
              onClick={() => action(() => onOutdent?.())}
            >
              Outdent one level
            </button>
          </div>
        )}
      </div>
      {onReorder ? (
        <div className="task-order">
          <button
            aria-label={`Move ${task.contents} up`}
            disabled={!canMoveUp}
            onClick={() => onReorder(-1)}
          >
            ↑
          </button>
          <button
            aria-label={`Move ${task.contents} down`}
            disabled={!canMoveDown}
            onClick={() => onReorder(1)}
          >
            ↓
          </button>
          <button
            ref={actionsToggle}
            aria-label={`Task actions for ${task.contents}`}
            aria-expanded={actionsOpen}
            aria-controls={actionsId}
            onClick={() => setActionsOpen(!actionsOpen)}
          >
            ⋯
          </button>
        </div>
      ) : (
        <button
          className="task-open"
          aria-label={`Open ${task.contents}`}
          onClick={() => onOpen(task.id)}
        >
          ›
        </button>
      )}
    </div>
  );
}
