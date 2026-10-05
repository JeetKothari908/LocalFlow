import React, { useLayoutEffect, useMemo, useRef } from "react";
import { Data, Task } from "../todo/types";
import { taskPath, moveTask } from "../todo/tasks";
import TaskRow, { visible, Mutation } from "./TaskRow";
import { mapCardHeight, taskMapLayout, MapDirection } from "./taskMapLayout";

type Props = {
  data: Data;
  rootId: string;
  selectedId: string;
  expanded: Set<string>;
  now: Date;
  onExpand: (id: string) => void;
  onSelect: (id: string) => void;
  onComplete: (task: Task) => void;
  mutate: Mutation;
  direction: MapDirection;
};

export default function TaskMap({
  data,
  rootId,
  selectedId,
  expanded,
  now,
  onExpand,
  onSelect,
  onComplete,
  mutate,
  direction,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const layout = useMemo(
    () =>
      taskMapLayout(
        data.items.filter((task) => task.id === rootId || visible(data, task)),
        rootId,
        expanded,
        direction,
      ),
    [data.items, rootId, expanded, direction],
  );
  useLayoutEffect(() => {
    const panel = viewport.current,
      node = layout.nodes.find((item) => item.task.id === selectedId);
    if (!panel || !node) return;
    // Keep the selected task beside the originating panel, with descendants inward.
    const reveal = () => {
      panel.scrollLeft = Math.max(
        0,
        direction === "right"
          ? node.x - 12
          : node.x + node.width + 12 - panel.clientWidth,
      );
      panel.scrollTop = Math.max(
        0,
        node.y + mapCardHeight / 2 - panel.clientHeight / 2,
      );
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [layout, selectedId, direction]);
  return (
    <div
      ref={viewport}
      className="task-map-viewport"
      tabIndex={0}
      aria-label={`Subtask map. Descendants expand to the ${direction}.`}
    >
      <div
        className="task-map-canvas"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          className="task-map-connectors"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          {layout.edges.map(({ parent, child }) => {
            const x1 =
                direction === "right" ? parent.x + parent.width : parent.x,
              x2 = direction === "right" ? child.x : child.x + child.width,
              y1 = parent.y + mapCardHeight / 2,
              y2 = child.y + mapCardHeight / 2;
            return (
              <path
                key={child.task.id}
                d={`M ${x1} ${y1} H ${(x1 + x2) / 2} V ${y2} H ${x2}`}
              />
            );
          })}
        </svg>
        {layout.nodes.map(({ task, x, y, width }) => (
          <article
            key={task.id}
            data-task-id={task.id}
            className={`task-map-panel${selectedId === task.id ? " map-selected" : ""}`}
            style={{ left: x, top: y, width, height: mapCardHeight }}
            aria-label={taskPath(data, task.id)
              .map((item) => item.contents)
              .join(" \u203a ")}
          >
            <TaskRow
              task={task}
              data={data}
              now={now}
              compact
              highlighted={selectedId === task.id}
              expanded={expanded.has(task.id)}
              onExpand={() => onExpand(task.id)}
              onOpen={onSelect}
              onComplete={onComplete}
              onDrop={(id) =>
                mutate((value) => moveTask(value, id, task.id), "Task moved")
              }
            />
          </article>
        ))}
      </div>
    </div>
  );
}
