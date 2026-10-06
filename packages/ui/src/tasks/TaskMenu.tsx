import React from "react";
import { Repeat } from "../../../core/src/tasks/repeat";
import { Data, Task } from "../../../core/src/tasks/types";
import { rootOf } from "../../../core/src/tasks/tasks";
import { finished } from "./TaskRow";

type Props = {
  task: Task;
  data: Data;
  listName: string;
  unavailable: boolean;
  editing: boolean;
  onComplete: (task: Task) => void;
  onEdit: () => void;
  onSchedule: (patch: Pick<Partial<Task>, "dueDate" | "dueTime" | "repeat">) => void;
  onChooseRepeat: (type: "none" | Repeat["type"]) => void;
  onChooseDay: (day: number) => void;
  onMoveList: (listId?: string) => void;
};

const repeatOptions = ["none", "daily", "weekly", "custom", "monthly"] as const;
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function TaskMenu({
  task,
  data,
  listName,
  unavailable,
  editing,
  onComplete,
  onEdit,
  onSchedule,
  onChooseRepeat,
  onChooseDay,
  onMoveList,
}: Props) {
  const repeatDays =
    task.repeat?.type === "weekly" || task.repeat?.type === "custom"
      ? task.repeat.days ?? []
      : [];
  const hasSchedule = Boolean(task.dueDate || task.repeat);

  return (
    <section className="legacy-task-menu" aria-label={`Options for ${task.contents}`}>
      <div className="legacy-menu-title">
        <button
          className="task-check"
          disabled={unavailable}
          aria-label={`${finished(task) ? "Reopen" : "Complete"} task`}
          aria-pressed={finished(task)}
          onClick={() => onComplete(task)}
        >
          {task.status === "canceled" ? "−" : finished(task) ? "✓" : ""}
        </button>
        <div>
          <h2>{task.contents}</h2>
          <small>{listName}</small>
        </div>
      </div>

      <label className="legacy-menu-row">
        <span>Due date</span>
        <input
          type="date"
          aria-label="Task due date"
          disabled={unavailable}
          value={task.dueDate ?? ""}
          onChange={(event) =>
            onSchedule({ dueDate: event.target.value || undefined })
          }
        />
      </label>
      <label className="legacy-menu-row">
        <span>Due time</span>
        <input
          type="time"
          aria-label="Task due time"
          disabled={unavailable || !hasSchedule}
          value={hasSchedule ? task.dueTime ?? "23:59" : ""}
          onChange={(event) =>
            onSchedule({ dueTime: event.target.value || undefined })
          }
        />
      </label>

      <div className="legacy-menu-repeat">
        <span>Repeat</span>
        <div className="repeat-options" role="group" aria-label="Task repeat">
          {repeatOptions.map((option) => (
            <button
              key={option}
              type="button"
              className={task.repeat?.type === option || (!task.repeat && option === "none") ? "active" : ""}
              aria-pressed={task.repeat?.type === option || (!task.repeat && option === "none")}
              disabled={unavailable}
              onClick={() => onChooseRepeat(option)}
            >
              {option === "none" ? "None" : option === "custom" ? "Custom" : option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
        {(task.repeat?.type === "weekly" || task.repeat?.type === "custom") && (
          <div className="custom-days" role="group" aria-label="Repeat weekdays">
            {weekdays.map((label, day) => {
              const active = repeatDays.includes(day);
              return (
                <button
                  key={label}
                  type="button"
                  className={active ? "active" : ""}
                  aria-pressed={active}
                  disabled={
                    unavailable ||
                    (task.repeat?.type === "custom" && active && repeatDays.length === 1)
                  }
                  onClick={() => onChooseDay(day)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {task.repeat?.type === "monthly" && (
          <label className="legacy-menu-row">
            <span>Day of month</span>
            <select
              aria-label="Repeat day of month"
              disabled={unavailable}
              value={task.repeat.day ?? Number(task.dueDate?.slice(8) ?? 1)}
              onChange={(event) =>
                onSchedule({ repeat: { type: "monthly", day: Number(event.target.value) } })
              }
            >
              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>{day}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <label className="legacy-menu-row">
        <span>List</span>
        <select
          aria-label="Task list"
          value={rootOf(data, task.id)?.listId ?? ""}
          disabled={unavailable || Boolean(task.parentTaskId)}
          onChange={(event) => onMoveList(event.target.value || undefined)}
        >
          <option value="">Inbox</option>
          {data.customLists?.filter((list) => !list.deletedAt).map((list) => (
            <option key={list.id} value={list.id}>{list.name}</option>
          ))}
        </select>
      </label>
      {task.parentTaskId && <small>Subtasks use their parent’s list.</small>}
      <button
        type="button"
        className="legacy-menu-edit"
        disabled={unavailable}
        onClick={onEdit}
      >
        {editing ? "Close details" : "Edit details"}
      </button>
    </section>
  );
}
