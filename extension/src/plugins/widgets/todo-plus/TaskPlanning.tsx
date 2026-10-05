import React, { useState } from "react";
import { Data, Task } from "../todo/types";
import { addDependency, removeDependency, blockerDetails, rootOf, taskPath, descendantsOf, ancestorsOf, criticalPath } from "../todo/tasks";
import { Mutation, deadline, dateKey, visible } from "./TaskRow";
import DependencyGraph from "./DependencyGraph";
import { analyzeSchedule } from "../todo/planning";
const activityLabels: Record<string, string> = {
  created: "Created", updated: "Edited", moved: "Moved", completed: "Completed",
  branchCompleted: "Completed branch", occurrenceCompleted: "Completed occurrence",
  reopened: "Reopened", ancestorsReopened: "Reopened parent tasks", deleted: "Moved to trash",
  restored: "Restored", archived: "Archived", unarchived: "Restored from archive", canceled: "Canceled",
  dependencyAdded: "Added prerequisite", dependencyRemoved: "Removed prerequisite", scheduleShifted: "Shifted schedule",
};

export function DependencyView({ data, task, mutate, onOpen }: { data: Data; task: Task; mutate: Mutation; onOpen: (id: string) => void }) {
  const [prerequisiteId, setPrerequisiteId] = useState("");
  const branchIds = new Set([task.id, ...descendantsOf(data, task.id).map((item) => item.id), ...ancestorsOf(data, task.id).map((item) => item.id)]);
  const activeEdges = (data.dependencies ?? []).filter((edge) => !edge.deletedAt);
  const prerequisiteIds = new Set(branchIds);
  const incoming = new Map<string, string[]>();
  for (const edge of activeEdges) incoming.set(edge.dependentTaskId, [...(incoming.get(edge.dependentTaskId) ?? []), edge.prerequisiteTaskId]);
  const pending = [...prerequisiteIds];
  for (let index = 0; index < pending.length; index++) for (const id of incoming.get(pending[index]) ?? []) {
    if (!prerequisiteIds.has(id)) {
      for (const item of [data.items.find((candidate) => candidate.id === id), ...descendantsOf(data, id), ...ancestorsOf(data, id)]) {
        if (item && !prerequisiteIds.has(item.id)) { prerequisiteIds.add(item.id); pending.push(item.id); }
      }
    }
  }
  const edges = activeEdges.filter((edge) => prerequisiteIds.has(edge.dependentTaskId) || branchIds.has(edge.prerequisiteTaskId));
  const blockers = blockerDetails(data, task.id); const analysis = criticalPath(data, task.id);
  return <div className="dependencies-view"><h3>Blocked by</h3>
    {blockers.length ? blockers.map(({ task: item, inheritedFrom }) => <div className="dependency-row" key={item.id}><button onClick={() => onOpen(item.id)}>{taskPath(data, item.id).map((ancestor) => ancestor.contents).join(" › ")}</button><span>{inheritedFrom ? <>Inherited through <button onClick={() => onOpen(inheritedFrom.id)}>{inheritedFrom.contents}</button></> : "Direct"}</span></div>) : <p className="empty-state">No unresolved prerequisites.</p>}
    <div className="dependency-add"><select aria-label="Prerequisite task" value={prerequisiteId} onChange={(event) => setPrerequisiteId(event.target.value)}><option value="">Choose a prerequisite…</option>{data.items.filter((item) => item.id !== task.id && visible(data, item)).map((item) => <option key={item.id} value={item.id}>{taskPath(data, item.id).map((ancestor) => ancestor.contents).join(" › ")}</option>)}</select><button disabled={!prerequisiteId} onClick={() => { if (mutate((value) => addDependency(value, prerequisiteId, task.id), "Dependency added")) setPrerequisiteId(""); }}>Add</button></div>
    <h3>Dependency map</h3><p className="planning-note">Each arrow connects a prerequisite to the task it unblocks.</p>
    {edges.length ? <><DependencyGraph data={data} task={task} edges={edges} onOpen={onOpen} /><details className="dependency-map"><summary>Manage dependency links ({edges.length})</summary>{edges.map((edge) => { const prerequisite = data.items.find((item) => item.id === edge.prerequisiteTaskId); const dependent = data.items.find((item) => item.id === edge.dependentTaskId); return <div className="dependency-edge" key={edge.id}><button className={prerequisite?.completed ? "dependency-complete" : ""} onClick={() => onOpen(edge.prerequisiteTaskId)}>{prerequisite?.contents ?? "Unavailable task"}<small>{rootOf(data, edge.prerequisiteTaskId)?.contents}</small></button><span aria-label="must finish before">→</span><button onClick={() => onOpen(edge.dependentTaskId)}>{dependent?.contents ?? "Unavailable task"}<small>{rootOf(data, edge.dependentTaskId)?.contents}</small></button><button aria-label="Remove dependency" onClick={() => mutate((value) => removeDependency(value, edge.id))}>×</button></div>; })}</details></> : <p className="empty-state">Connect prerequisites to trace the order of work.</p>}
    <h3>Unblocks</h3>{(data.dependencies ?? []).filter((edge) => !edge.deletedAt && edge.prerequisiteTaskId === task.id).map((edge) => <button className="linked-task" key={edge.id} onClick={() => onOpen(edge.dependentTaskId)}>{data.items.find((item) => item.id === edge.dependentTaskId)?.contents}</button>)}
    <ScheduleAnalysisView data={data} task={task} onOpen={onOpen} />
    <p className="planning-note">{analysis.completeEstimates ? `Longest effort chain: ${analysis.estimatedMinutes} estimated minutes` : "Add estimates to every unfinished step to calculate its effort chain."}{analysis.completeEstimates && analysis.taskIds.length > 0 && <span>{analysis.taskIds.map((id) => data.items.find((item) => item.id === id)?.contents).join(" → ")}</span>}</p>
  </div>;
}

export function TimelineView({ data, tasks, now, onOpen }: { data: Data; tasks: Task[]; now: Date; onOpen: (id: string) => void }) {
  const today = dateKey(now);
  const dated = tasks.filter((task) => task.dueDate || task.plannedStart).sort((a, b) => (a.plannedStart ?? a.dueDate ?? "").localeCompare(b.plannedStart ?? b.dueDate ?? ""));
  const dates = dated.flatMap((task) => [task.plannedStart, task.dueDate].filter((date): date is string => !!date));
  const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86400000;
  const minimum = Math.min(...dates.map(day), day(today)); const maximum = Math.max(...dates.map(day), day(today)) + 1;
  const position = (date: string) => `${Math.max(0, Math.min(100, (day(date) - minimum) / (maximum - minimum) * 100))}%`;
  const edges = (data.dependencies ?? []).filter((edge) => !edge.deletedAt && tasks.some((task) => task.id === edge.dependentTaskId));
  return <div className="timeline-view"><div className="timeline-axis"><span>{new Date(minimum * 86400000).toISOString().slice(0, 10)}</span><span>{new Date(maximum * 86400000).toISOString().slice(0, 10)}</span></div>
    {dated.map((task) => <div className="timeline-row" key={task.id}><button onClick={() => onOpen(task.id)}>{task.contents}<small>{taskPath(data, task.id).slice(0, -1).map((item) => item.contents).join(" › ")}</small></button><div className="timeline-track" aria-label={`${task.plannedStart ? `Start ${task.plannedStart}; ` : ""}${deadline(task)}`}><span className="timeline-today" style={{ left: position(today) }} />{task.plannedStart && task.dueDate && <span className="timeline-bar" style={{ left: position(task.plannedStart), width: `${Math.max(1, (day(task.dueDate) - day(task.plannedStart)) / (maximum - minimum) * 100)}%` }} />}{task.dueDate && <span className="timeline-deadline" style={{ left: position(task.dueDate) }}>◆</span>}{task.plannedStart && !task.dueDate && <span className="timeline-start" style={{ left: position(task.plannedStart) }}>○</span>}</div><small>{deadline(task)}</small></div>)}
    {!dated.length && <p className="empty-state">Add deadlines or planned starts to map this branch.</p>}
    <p className="timeline-legend">◆ Deadline · ○ Planned start · Bars span planned start to deadline · Vertical line: today</p>
    {!!edges.length && <details><summary>Scheduling dependencies ({edges.length})</summary>{edges.map((edge) => <p key={edge.id}><button onClick={() => onOpen(edge.prerequisiteTaskId)}>{data.items.find((task) => task.id === edge.prerequisiteTaskId)?.contents}</button> → <button onClick={() => onOpen(edge.dependentTaskId)}>{data.items.find((task) => task.id === edge.dependentTaskId)?.contents}</button></p>)}</details>}
    {tasks.some((task) => !task.dueDate && !task.plannedStart) && <details><summary>Unscheduled ({tasks.filter((task) => !task.dueDate && !task.plannedStart).length})</summary>{tasks.filter((task) => !task.dueDate && !task.plannedStart).map((task) => <button className="linked-task" key={task.id} onClick={() => onOpen(task.id)}>{task.contents}</button>)}</details>}
    {tasks[0] && <ScheduleAnalysisView data={data} task={tasks[0]} onOpen={onOpen} />}
  </div>;
}

export function ScheduleAnalysisView({ data, task, onOpen }: { data: Data; task: Task; onOpen: (id: string) => void }) {
  const analysis = analyzeSchedule(data, task.id);
  const timestamp = (value: number) => new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const minutes = (value: number) => `${Math.round(value * 10) / 10} min`;
  const links = (ids: string[]) => ids.map((id, index) => <React.Fragment key={id}>{index > 0 && ", "}<button onClick={() => onOpen(id)}>{data.items.find((item) => item.id === id)?.contents ?? id}</button></React.Fragment>);
  return <section className="schedule-analysis" aria-label="Scheduled critical path">
    <h3>Schedule analysis</h3>
    <p className="planning-note">This scenario uses planned dates and uninterrupted estimated effort. It leaves your dates unchanged and does not assume working hours.</p>
    {!!analysis.unavailableIds.length && <p className="task-blockers">Resolve unavailable prerequisites: {links(analysis.unavailableIds)}</p>}
    {!!analysis.missingEstimateIds.length && <p>Add effort estimates: {links(analysis.missingEstimateIds)}</p>}
    {!!analysis.missingStartIds.length && <p>Add a planned start to anchor this work or its branch: {links(analysis.missingStartIds)}</p>}
    {analysis.earliestFinish != null && <><p>Earliest planned finish: <strong>{timestamp(analysis.earliestFinish)}</strong></p>
      {analysis.targetDeadline == null ? <p>Add a deadline to {task.contents} to calculate the scheduled critical path and deadline margin.</p> : <>
        <p className={analysis.deadlineMarginMinutes! < 0 ? "task-error" : ""}>{analysis.deadlineMarginMinutes! < 0 ? `Beyond deadline by ${minutes(-analysis.deadlineMarginMinutes!)}` : `Deadline margin: ${minutes(analysis.deadlineMarginMinutes!)}`}</p>
        <p className="scheduled-critical-chain">Scheduled critical path: {links(analysis.criticalTaskIds)}</p>
      </>}
      <details><summary>Scheduled steps ({analysis.rows.length})</summary><div className="schedule-table"><table><thead><tr><th>Task</th><th>Earliest start</th><th>Finish</th><th>Float</th></tr></thead><tbody>{analysis.rows.map((row) => <tr key={row.taskId} className={row.critical ? "schedule-critical" : ""}><td><button onClick={() => onOpen(row.taskId)}>{taskPath(data, row.taskId).map((item) => item.contents).join(" › ")}</button>{row.summary && <small>Summary outcome</small>}{row.lateMinutes > 0 && <small className="task-blockers">Beyond own deadline by {minutes(row.lateMinutes)}</small>}</td><td>{timestamp(row.start)}</td><td>{timestamp(row.finish)}</td><td>{row.floatMinutes == null ? "Add outcome deadline" : minutes(row.floatMinutes)}</td></tr>)}</tbody></table></div><p className="planning-note">Float is the delay a step can absorb without changing the earliest planned finish. The outcome's deadline margin is separate.</p></details>
    </>}
  </section>;
}

export function HistoryView({ data, taskIds }: { data: Data; taskIds: Set<string> }) {
  const events = (data.activity ?? []).filter((event) => event.taskId && taskIds.has(event.taskId)).slice().reverse();
  const occurrences = (data.occurrences ?? []).filter((item) => taskIds.has(item.taskId)).slice().reverse();
  const tasks = new Map(data.items.map((item) => [item.id, item]));
  return <div className="history-view"><h3>Activity</h3>{events.map((event) => <div className="activity-row" key={event.id}><time>{new Date(event.at).toLocaleString()}</time><span><strong>{activityLabels[event.type] ?? event.type}</strong>{event.taskId && tasks.get(event.taskId) && ` · ${tasks.get(event.taskId)!.contents}`}{event.detail && <small>{event.detail}</small>}</span></div>)}{!events.length && <p className="empty-state">Changes to this branch will appear here.</p>}<h3>Recurring occurrences</h3>{occurrences.map((item) => <details className="occurrence" key={item.id}><summary>{item.dueDate ?? item.completedAt.slice(0, 10)} · {item.items.length} task{item.items.length !== 1 ? "s" : ""}</summary>{item.items.map((task) => <p key={task.id}>{task.status === "canceled" ? "−" : task.completed ? "✓" : "○"} {task.contents} <small>{deadline(task)}{task.status === "canceled" ? " · Canceled" : ""}</small></p>)}</details>)}{!occurrences.length && <p className="empty-state">Completed recurring branches are preserved here.</p>}</div>;
}
