import { Action } from "./actions";

type Todo = {
  id: string;
  contents: string;
  completed: boolean;
  dismissed?: boolean;
  dueDate?: string;
  dueTime?: string;
  repeat?: Repeat;
  parentId?: string;
  listId?: string;
};

export type State = Todo[];

import { Repeat } from "../../../../../packages/core/src/tasks/repeat";
export type { Repeat } from "../../../../../packages/core/src/tasks/repeat";

export function reducer(state: State, action: Action) {
  switch (action.type) {
    case "ADD_TODO":
      return state.concat(action.data);

    case "REMOVE_TODO":
      return state.filter((todo) => todo.id !== action.data.id);

    case "TOGGLE_TODO":
      return state.map((todo) =>
        todo.id === action.data.id
          ? { ...todo, completed: !todo.completed, dismissed: false }
          : todo,
      );

    case "DISMISS_TODO":
      return state.map((todo) =>
        todo.id === action.data.id
          ? { ...todo, dismissed: true }
          : todo,
      );

    case "UPDATE_TODO":
      return state.map((todo) =>
        todo.id === action.data.id
          ? { ...todo, contents: action.data.contents }
          : todo,
      );

    case "UPDATE_TODO_META":
      return state.map((todo) =>
        todo.id === action.data.id
          ? {
              ...todo,
              dueDate: action.data.dueDate,
              dueTime: action.data.dueTime,
              repeat: action.data.repeat,
            }
          : todo,
      );

    case "COMPLETE_INSTANCE":
      return state.map((todo) =>
        todo.id === action.data.id
          ? { ...todo, completed: true }
          : todo,
      );

    case "COMPLETE_TASK":
      return state.filter((todo) => todo.id !== action.data.id);

    case "COMPLETE_REPEAT_INSTANCE": {
      const parent = state.find((todo) => todo.id === action.data.parentId);
      if (!parent) return state;
      // Note: the instance does NOT carry the parent's `repeat`. The instance is a
      // frozen completion record — re-evaluating it against repeat schedules would
      // make it re-appear as a recurring task in its own right.
      const instance = {
        id: action.data.instanceId,
        contents: parent.contents,
        completed: true,
        dueDate: action.data.instanceDueDate,
        dueTime: action.data.instanceDueTime,
        parentId: action.data.parentId,
        listId: parent.listId,
      };
      return state
        .map((todo) =>
          todo.id === action.data.parentId
            ? { ...todo, dueDate: action.data.nextDueDate }
            : todo,
        )
        .concat(instance);
    }

    case "UNCOMPLETE_REPEAT_INSTANCE": {
      // Remove the completed instance
      const filtered = state.filter(
        (todo) => todo.id !== action.data.instanceId,
      );
      // Only roll back parent's dueDate if the instance's date is earlier
      return filtered.map((todo) => {
        if (todo.id !== action.data.parentId) return todo;
        const instanceDate = action.data.instanceDueDate;
        if (
          instanceDate &&
          (!todo.dueDate || instanceDate < todo.dueDate)
        ) {
          return { ...todo, dueDate: instanceDate };
        }
        return todo;
      });
    }

    case "MOVE_TODO":
      return state.map((todo) =>
        todo.id === action.data.id
          ? { ...todo, listId: action.data.listId }
          : todo,
      );

    default:
      throw new Error("Unknown action");
  }
}
