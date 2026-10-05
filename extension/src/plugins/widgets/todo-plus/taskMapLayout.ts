import { Task } from "../todo/types";

export type TaskMapNode = {
  task: Task;
  depth: number;
  x: number;
  y: number;
  width: number;
};
export type TaskMapLayout = {
  nodes: TaskMapNode[];
  edges: Array<{ parent: TaskMapNode; child: TaskMapNode }>;
  width: number;
  height: number;
};
export const mapCardHeight = 28;

export type MapDirection = "left" | "right";

/** Iterative bracket layout: siblings occupy separate rows in either direction. */
export function taskMapLayout(
  items: Task[],
  rootId: string,
  expanded: Set<string>,
  direction: MapDirection = "right",
): TaskMapLayout {
  const index = new Map(items.map((task) => [task.id, task]));
  const root = index.get(rootId);
  if (!root) return { nodes: [], edges: [], width: 0, height: 0 };
  const children = new Map<string, Task[]>();
  for (const task of items)
    if (task.parentTaskId) {
      const group = children.get(task.parentTaskId) ?? [];
      group.push(task);
      children.set(task.parentTaskId, group);
    }
  for (const group of children.values())
    group.sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
    );
  const nodes: TaskMapNode[] = [],
    seen = new Set<string>();
  const stack = [{ task: root, depth: 0 }];
  let depth = 0;
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next.task.id)) continue;
    seen.add(next.task.id);
    depth = Math.max(depth, next.depth);
    nodes.push({ ...next, x: 0, y: 0, width: 176 });
    if (expanded.has(next.task.id))
      for (const child of [...(children.get(next.task.id) ?? [])].reverse())
        stack.push({ task: child, depth: next.depth + 1 });
  }
  const positions = new Map(nodes.map((node) => [node.task.id, node]));
  let row = 0;
  for (const node of nodes)
    if (
      !(children.get(node.task.id) ?? []).some((child) =>
        positions.has(child.id),
      )
    )
      node.y = 12 + row++ * (mapCardHeight + 8);
  // Parents sit between the first and last child branch, including unequal depths.
  for (const node of [...nodes].reverse()) {
    const visibleChildren = (children.get(node.task.id) ?? [])
      .map((task) => positions.get(task.id))
      .filter((child): child is TaskMapNode => !!child);
    if (visibleChildren.length)
      node.y =
        (visibleChildren[0].y + visibleChildren[visibleChildren.length - 1].y) /
        2;
    node.x =
      12 + (direction === "right" ? node.depth : depth - node.depth) * 208;
  }
  const edges = nodes.flatMap((child) => {
    const parent =
      child.task.parentTaskId && positions.get(child.task.parentTaskId);
    return parent ? [{ parent, child }] : [];
  });
  return {
    nodes,
    edges,
    width: depth * 208 + 200,
    height: row * (mapCardHeight + 8) + 16,
  };
}
