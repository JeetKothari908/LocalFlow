import React, { useEffect, useMemo, useRef, useState } from "react";
import { Data, Dependency, Task } from "../../../core/src/tasks/types";
import { blockerDetails, rootOf, taskPath } from "../../../core/src/tasks/tasks";
import { dependencyTrace } from "../../../core/src/tasks/planning";

/** A local graph of the selected branch, including its links to other projects. */
export default function DependencyGraph({ data, task, edges, onOpen }: { data: Data; task: Task; edges: Dependency[]; onOpen: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600); const [selectedId, setSelectedId] = useState(task.id);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => {
    const ids = new Set(edges.flatMap((edge) => [edge.prerequisiteTaskId, edge.dependentTaskId]));
    ids.add(task.id);
    const nodes = data.items.filter((item) => ids.has(item.id));
    const incoming = new Map(nodes.map((item) => [item.id, 0]));
    const outgoing = new Map<string, string[]>(); const rank = new Map(nodes.map((item) => [item.id, 0]));
    for (const edge of edges) {
      incoming.set(edge.dependentTaskId, (incoming.get(edge.dependentTaskId) ?? 0) + 1);
      outgoing.set(edge.prerequisiteTaskId, [...(outgoing.get(edge.prerequisiteTaskId) ?? []), edge.dependentTaskId]);
    }
    const queue = nodes.filter((item) => !incoming.get(item.id)).map((item) => item.id);
    for (let i = 0; i < queue.length; i++) {
      for (const destination of outgoing.get(queue[i]) ?? []) {
        rank.set(destination, Math.max(rank.get(destination) ?? 0, (rank.get(queue[i]) ?? 0) + 1));
        incoming.set(destination, incoming.get(destination)! - 1);
        if (!incoming.get(destination)) queue.push(destination);
      }
    }
    const groups = new Map<number, Task[]>();
    for (const node of nodes) { const level = rank.get(node.id) ?? 0; groups.set(level, [...(groups.get(level) ?? []), node]); }
    const usableWidth = Math.max(80, width - 36);
    const columns = Math.max(1, Math.floor(usableWidth / 205)); const gap = 16;
    const nodeWidth = Math.max(80, (usableWidth - gap * (columns - 1)) / columns); const nodeHeight = 88;
    const positions = new Map<string, { x: number; y: number }>(); let y = 12;
    for (const [, group] of [...groups].sort(([a], [b]) => a - b)) {
      group.forEach((node, index) => positions.set(node.id, { x: 20 + (index % columns) * (nodeWidth + gap), y: y + Math.floor(index / columns) * (nodeHeight + 18) }));
      y += Math.ceil(group.length / columns) * (nodeHeight + 18) + 35;
    }
    return { nodes, positions, nodeWidth, nodeHeight, height: Math.max(120, y - 15) };
  }, [data.items, edges, width, task.id]);
  const selected = data.items.find((item) => item.id === selectedId);
  const trace = dependencyTrace(data, selectedId);
  const connected = trace.taskIds;
  const selectedInGraph = layout.positions.has(selectedId);
  const markerId = `task-arrow-${task.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  return <><div className="dependency-graph" ref={container} style={{ height: layout.height }} aria-label="Task dependency graph">
    <svg width="100%" height={layout.height} role="img" aria-label="Arrows show tasks that must finish before their dependents">
      <defs><marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      {edges.map((edge) => {
        const from = layout.positions.get(edge.prerequisiteTaskId), to = layout.positions.get(edge.dependentTaskId);
        if (!from || !to) return null;
        const x1 = from.x + layout.nodeWidth / 2, y1 = from.y + layout.nodeHeight + 1;
        const x2 = to.x + layout.nodeWidth / 2, y2 = to.y - 3;
        const active = trace.edgeIds.has(edge.id);
        const path = y2 - y1 > 90 ? `M ${x1} ${y1} L ${x1} ${y1 + 12} L 7 ${y1 + 12} L 7 ${y2 - 15} L ${x2} ${y2 - 15} L ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
        return <path key={edge.id} d={path} className={active ? "graph-edge graph-edge-active" : "graph-edge"} markerEnd={`url(#${markerId})`} />;
      })}
    </svg>
    {layout.nodes.map((node) => {
      const position = layout.positions.get(node.id)!;
      return <button key={node.id} className={`graph-node${node.status === "canceled" ? " graph-node-canceled" : node.completed ? " graph-node-done" : ""}${selectedInGraph && !connected.has(node.id) ? " graph-node-dimmed" : ""}`}
        style={{ left: position.x, top: position.y, width: layout.nodeWidth, height: layout.nodeHeight }}
        aria-pressed={selectedId === node.id} aria-label={taskPath(data, node.id).map((item) => item.contents).join(" › ")} onClick={() => setSelectedId(node.id)}>
        <span>{node.status === "canceled" ? "− " : node.completed ? "✓ " : ""}{node.contents}</span><small>{node.deletedAt ? "Trash · " : node.archivedAt || node.dismissed ? "Archived · " : node.status === "canceled" ? "Canceled · " : ""}{rootOf(data, node.id)?.contents}</small>
      </button>;
    })}
  </div>{selectedInGraph && selected && <div className="graph-selection" aria-live="polite"><span>{taskPath(data, selected.id).map((item) => item.contents).join(" › ")}</span><button onClick={() => onOpen(selected.id)}>Open selected task</button><div>{blockerDetails(data, selectedId).map(({ task: prerequisite, inheritedFrom }) => <p className="task-blockers" key={prerequisite.id}>Waiting on <button onClick={() => onOpen(prerequisite.id)}>{prerequisite.contents}</button>{inheritedFrom && <> through <button onClick={() => onOpen(inheritedFrom.id)}>{inheritedFrom.contents}</button></>}</p>)}</div><p className="planning-note">Highlighted arrows trace the unfinished prerequisite chain and the work this task unblocks.</p></div>}</>;
}
