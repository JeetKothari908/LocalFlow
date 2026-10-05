"""Validation and three-way merging for the recursive todo document.

The hierarchy is flat on the wire. Graph algorithms deliberately avoid recursive
tree traversal so task depth is not limited by Python's recursion limit.
"""

from collections import deque
from copy import deepcopy
from datetime import date, datetime
import math
import re
from typing import Any


TODO_STORE = "tabliss/config"
TODO_KEY = "data/default-todo"
_MISSING = object()


class TodoValidationError(ValueError):
    pass


class MergeConflict(ValueError):
    def __init__(self, paths: list[str]):
        self.paths = paths
        super().__init__("Concurrent changes conflict at " + ", ".join(paths))


def is_recursive_todo(value: Any) -> bool:
    return isinstance(value, dict) and value.get("schemaVersion") == 2


def _fail(path: str, message: str) -> None:
    raise TodoValidationError(f"{path}: {message}")


def _string(value: Any, path: str, *, nonempty: bool = False) -> None:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        _fail(path, "must be a nonempty string" if nonempty else "must be a string")


def _optional_string(record: dict, field: str, path: str) -> None:
    if record.get(field) is not None:
        _string(record[field], f"{path}.{field}")


def _day(value: Any, path: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        _fail(path, "must be a calendar date in YYYY-MM-DD format")
    try:
        date.fromisoformat(value)
    except ValueError:
        _fail(path, "must be a valid calendar date")


def _timestamp(value: Any, path: str) -> None:
    _string(value, path, nonempty=True)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            _fail(path, "must include a timezone")
    except ValueError:
        _fail(path, "must be an ISO 8601 timestamp with a timezone")


def _metadata(record: dict, path: str) -> None:
    for field in ("createdAt", "updatedAt", "deletedAt", "archivedAt", "completedAt"):
        if record.get(field) is not None:
            _timestamp(record[field], f"{path}.{field}")


def _records(value: Any, path: str) -> dict[str, dict]:
    if not isinstance(value, list):
        _fail(path, "must be an array")
    records = {}
    for index, record in enumerate(value):
        location = f"{path}[{index}]"
        if not isinstance(record, dict):
            _fail(location, "must be an object")
        _string(record.get("id"), f"{location}.id", nonempty=True)
        if record["id"] in records:
            _fail(location, "duplicate id")
        _metadata(record, location)
        records[record["id"]] = record
    return records


def _acyclic(edges: dict[str, set[str]], path: str) -> None:
    incoming = {node: 0 for node in edges}
    for destinations in edges.values():
        for destination in destinations:
            incoming[destination] += 1
    ready = deque(node for node, count in incoming.items() if count == 0)
    visited = 0
    while ready:
        node = ready.popleft()
        visited += 1
        for destination in edges[node]:
            incoming[destination] -= 1
            if incoming[destination] == 0:
                ready.append(destination)
    if visited != len(edges):
        _fail(path, "contains a cycle, including inherited parent blockers")


def _validate_items(items: Any, path: str, lists: dict | None = None, *, historical: bool = False) -> dict[str, dict]:
    records = _records(items, path)
    parent_edges = {task_id: set() for task_id in records}
    for task_id, task in records.items():
        location = f"{path}[{task_id}]"
        _string(task.get("contents"), f"{location}.contents")
        if not isinstance(task.get("completed"), bool):
            _fail(f"{location}.completed", "must be a boolean")
        for field in ("description", "parentId", "parentTaskId", "listId"):
            _optional_string(task, field, location)
        parent = task.get("parentTaskId")
        if parent:
            if parent not in records and not historical:
                _fail(f"{location}.parentTaskId", "references a missing task")
            if parent in records:
                parent_edges[task_id].add(parent)
            if task.get("listId"):
                _fail(f"{location}.listId", "only root tasks can belong to a list")
        list_id = task.get("listId")
        if list_id and lists is not None and not task.get("deletedAt"):
            if list_id not in lists or lists[list_id].get("deletedAt"):
                _fail(f"{location}.listId", "references a missing or deleted list")
        if task.get("status") is not None:
            if task["status"] not in ("todo", "inProgress", "done", "canceled"):
                _fail(f"{location}.status", "must be todo, inProgress, done, or canceled")
            if (task["status"] == "done") != task["completed"]:
                _fail(location, "completed must agree with done status")
        if task.get("priority") is not None and task["priority"] not in ("low", "normal", "high"):
            _fail(f"{location}.priority", "must be low, normal, or high")
        for field in ("dueDate", "plannedStart"):
            if task.get(field) is not None:
                _day(task[field], f"{location}.{field}")
        if task.get("dueTime") is not None:
            if not isinstance(task["dueTime"], str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", task["dueTime"]):
                _fail(f"{location}.dueTime", "must be HH:MM in 24-hour time")
        for field in ("estimatedMinutes", "order"):
            number = task.get(field)
            if number is not None and (
                isinstance(number, bool) or not isinstance(number, (int, float))
                or not math.isfinite(number) or (field == "estimatedMinutes" and number < 0)
            ):
                _fail(f"{location}.{field}", "must be a finite number" + (" greater than or equal to zero" if field == "estimatedMinutes" else ""))
        if task.get("repeatScope") is not None and task["repeatScope"] not in ("task", "branch"):
            _fail(f"{location}.repeatScope", "must be task or branch")
        repeat = task.get("repeat")
        if repeat is not None:
            if not isinstance(repeat, dict) or repeat.get("type") not in ("daily", "weekly", "custom", "monthly"):
                _fail(f"{location}.repeat", "must have daily, weekly, custom, or monthly type")
            days = repeat.get("days")
            if repeat.get("type") == "custom" and (not isinstance(days, list) or not days):
                _fail(f"{location}.repeat.days", "custom repetition requires at least one weekday")
            if days is not None and (
                not isinstance(days, list) or any(type(day) is not int or not 0 <= day <= 6 for day in days)
                or len(set(days)) != len(days)
            ):
                _fail(f"{location}.repeat.days", "must contain unique weekdays from 0 to 6")
            if repeat.get("day") is not None and (type(repeat["day"]) is not int or not 1 <= repeat["day"] <= 31):
                _fail(f"{location}.repeat.day", "must be a day of the month from 1 to 31")
        for field in ("dismissed",):
            if task.get(field) is not None and not isinstance(task[field], bool):
                _fail(f"{location}.{field}", "must be a boolean")
    _acyclic(parent_edges, path)
    return records


def _validate_dependencies(dependencies: Any, tasks: dict[str, dict], path: str, *, historical: bool = False) -> None:
    records = _records(dependencies, path)
    # A task has a start and a completion node. Parent start gates descendant
    # start; children complete before their parent. Dependencies gate starts.
    # This detects inherited blockers in linear space without expanding every
    # dependency into all its descendants.
    edges = {}
    for task_id in tasks:
        edges[f"start:{task_id}"] = {f"done:{task_id}"}
        edges[f"done:{task_id}"] = set()
    for task_id, task in tasks.items():
        parent = task.get("parentTaskId")
        if parent and parent in tasks:
            edges[f"start:{parent}"].add(f"start:{task_id}")
            edges[f"done:{task_id}"].add(f"done:{parent}")
    pairs = set()
    for dependency_id, dependency in records.items():
        location = f"{path}[{dependency_id}]"
        prerequisite = dependency.get("prerequisiteTaskId")
        dependent = dependency.get("dependentTaskId")
        for field, task_id in (("prerequisiteTaskId", prerequisite), ("dependentTaskId", dependent)):
            _string(task_id, f"{location}.{field}", nonempty=True)
            if task_id not in tasks and not historical:
                _fail(f"{location}.{field}", "references a missing task")
            if historical and task_id not in tasks:
                edges.setdefault(f"start:{task_id}", {f"done:{task_id}"})
                edges.setdefault(f"done:{task_id}", set())
        if prerequisite == dependent:
            _fail(location, "a task cannot depend on itself")
        if dependency.get("deletedAt"):
            continue
        pair = (prerequisite, dependent)
        if pair in pairs:
            _fail(location, "duplicate active dependency")
        pairs.add(pair)
        edges[f"done:{prerequisite}"].add(f"start:{dependent}")
    _acyclic(edges, path)


def _validate_completion(tasks: dict[str, dict]) -> None:
    # Cache inherited visibility and the nearest completed ancestor. Each task
    # is evaluated once, including long chains arriving in reverse order.
    state: dict[str, tuple[bool, str | None, str | None]] = {}
    for task_id in tasks:
        if task_id in state:
            continue
        path = []
        cursor = task_id
        while cursor and cursor not in state:
            path.append(cursor)
            cursor = tasks[cursor].get("parentTaskId")
        hidden, completed_ancestor, deleted_ancestor = state.get(cursor, (False, None, None))
        for current_id in reversed(path):
            task = tasks[current_id]
            if deleted_ancestor and not task.get("deletedAt"):
                _fail(f"items[{current_id}]", f"live work is beneath deleted task {deleted_ancestor}; restore or move the branch before editing")
            hidden = hidden or bool(task.get("deletedAt") or task.get("archivedAt") or task.get("dismissed") or task.get("status") == "canceled")
            if not hidden and completed_ancestor and not task["completed"]:
                _fail(f"items[{current_id}]", f"unfinished work is beneath completed task {completed_ancestor}; reopen that ancestor")
            if task["completed"]:
                completed_ancestor = current_id
            if task.get("deletedAt"):
                deleted_ancestor = current_id
            state[current_id] = (hidden, completed_ancestor, deleted_ancestor)


def validate_todo(value: Any) -> None:
    """Legacy values remain writable until a client performs migration."""
    if not isinstance(value, dict):
        return
    version = value.get("schemaVersion")
    if version is not None and (type(version) is not int or version not in (1, 2)):
        _fail("schemaVersion", "unsupported todo schema version")
    if version != 2:
        return
    lists = _records(value.get("customLists", []), "customLists")
    for list_id, custom_list in lists.items():
        _string(custom_list.get("name"), f"customLists[{list_id}].name", nonempty=True)
    tasks = _validate_items(value.get("items"), "items", lists)
    _validate_completion(tasks)
    _validate_dependencies(value.get("dependencies", []), tasks, "dependencies")
    occurrences = _records(value.get("occurrences", []), "occurrences")
    for occurrence_id, occurrence in occurrences.items():
        path = f"occurrences[{occurrence_id}]"
        _string(occurrence.get("taskId"), f"{path}.taskId", nonempty=True)
        # A historical snapshot remains meaningful after its source is removed.
        _timestamp(occurrence.get("completedAt"), f"{path}.completedAt")
        if occurrence.get("dueDate") is not None:
            _day(occurrence["dueDate"], f"{path}.dueDate")
        frozen = _validate_items(occurrence.get("items", []), f"{path}.items", historical=True)
        if occurrence.get("dependencies") is not None:
            # Historical references can outlive their source task. Validate the
            # frozen graph without mixing today's hierarchy into its past.
            _validate_dependencies(occurrence["dependencies"], frozen, f"{path}.dependencies", historical=True)
    activity = _records(value.get("activity", []), "activity")
    for activity_id, event in activity.items():
        path = f"activity[{activity_id}]"
        _string(event.get("type"), f"{path}.type", nonempty=True)
        _timestamp(event.get("at"), f"{path}.at")
        _optional_string(event, "taskId", path)
        _optional_string(event, "detail", path)


def _by_id(value: list) -> dict | None:
    if all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in value):
        mapped = {item["id"]: item for item in value}
        if len(mapped) == len(value):
            return mapped
    return None


def _deleted_changed(base: dict, value: dict) -> bool:
    return bool(value.get("deletedAt")) != bool(base.get("deletedAt"))


def three_way_merge(base: Any, local: Any, remote: Any) -> Any:
    """Merge disjoint edits, retaining explicit conflicts instead of picking a side."""
    conflicts: list[str] = []

    def merge(before: Any, ours: Any, theirs: Any, path: str) -> Any:
        if ours == theirs:
            return _MISSING if ours is _MISSING else deepcopy(ours)
        if ours == before:
            return _MISSING if theirs is _MISSING else deepcopy(theirs)
        if theirs == before:
            return _MISSING if ours is _MISSING else deepcopy(ours)
        if _MISSING in (before, ours, theirs):
            conflicts.append(path)
            return _MISSING
        if all(isinstance(value, dict) for value in (before, ours, theirs)):
            if "id" in before and (_deleted_changed(before, ours) or _deleted_changed(before, theirs)):
                conflicts.append(path + ".deletedAt")
                return _MISSING
            result = {}
            for key in before.keys() | ours.keys() | theirs.keys():
                child_path = f"{path}.{key}" if path else key
                old = before.get(key, _MISSING)
                left = ours.get(key, _MISSING)
                right = theirs.get(key, _MISSING)
                if key == "updatedAt" and left is not _MISSING and right is not _MISSING:
                    # Both clients timestamp even non-overlapping entity edits.
                    # Preserve the later valid timestamp rather than conflict.
                    if isinstance(left, str) and isinstance(right, str):
                        try:
                            left_time = datetime.fromisoformat(left.replace("Z", "+00:00"))
                            right_time = datetime.fromisoformat(right.replace("Z", "+00:00"))
                            result[key] = left if left_time >= right_time else right
                            continue
                        except (TypeError, ValueError):
                            pass
                merged = merge(old, left, right, child_path)
                if merged is not _MISSING:
                    result[key] = merged
            return result
        if all(isinstance(value, list) for value in (before, ours, theirs)):
            mapped = [_by_id(value) for value in (before, ours, theirs)]
            if all(value is not None for value in mapped):
                old, left, right = mapped
                result = []
                ids = list(right) + [entity_id for entity_id in left if entity_id not in right]
                # Include base-only ids to recognize both sides deleting them.
                ids += [entity_id for entity_id in old if entity_id not in left and entity_id not in right]
                for entity_id in ids:
                    merged = merge(old.get(entity_id, _MISSING), left.get(entity_id, _MISSING), right.get(entity_id, _MISSING), f"{path}[{entity_id}]")
                    if merged is not _MISSING:
                        result.append(merged)
                return result
        conflicts.append(path or "$document")
        return _MISSING

    result = merge(base, local, remote, "")
    if conflicts:
        raise MergeConflict(sorted(set(conflicts)))
    return result
