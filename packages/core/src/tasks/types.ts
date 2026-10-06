import { Repeat } from "./repeat";

export type CustomList = {
  id: string;
  name: string;
  updatedAt?: string;
  deletedAt?: string;
};

export type Data = {
  items: Task[];
  show: number;
  keyBind?: string;
  lastClearedDate?: string;
  customLists?: CustomList[];
  schemaVersion?: 2;
  dependencies?: Dependency[];
  occurrences?: TaskOccurrence[];
  activity?: TaskActivity[];
  legacyBackup?: unknown;
};

/** Structural parentage is separate from the legacy recurring-history parentId. */
export type Task = {
  id: string;
  contents: string;
  completed: boolean;
  dismissed?: boolean;
  dueDate?: string;
  dueTime?: string;
  repeat?: Repeat;
  parentId?: string;
  listId?: string;
  parentTaskId?: string;
  description?: string;
  status?: "todo" | "inProgress" | "done" | "canceled";
  priority?: "low" | "normal" | "high";
  plannedStart?: string;
  estimatedMinutes?: number;
  order?: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  deletedAt?: string;
  deletedByTaskId?: string;
  archivedAt?: string;
  repeatScope?: "task" | "branch";
};

export type Dependency = {
  id: string;
  prerequisiteTaskId: string;
  dependentTaskId: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
};

export type TaskOccurrence = {
  id: string;
  taskId: string;
  completedAt: string;
  dueDate?: string;
  items: Task[];
  dependencies?: Dependency[];
};

export type TaskActivity = {
  id: string;
  taskId?: string;
  type: string;
  at: string;
  detail?: string;
};

export type NormalizedTaskData = Data & {
  schemaVersion: 2;
  dependencies: Dependency[];
  occurrences: TaskOccurrence[];
  activity: TaskActivity[];
  customLists: CustomList[];
};

export type Props = { data?: Data; setData: (data: Data) => void };

export const defaultData: Data = {
  items: [],
  show: 3,
  keyBind: "T",
  customLists: [],
  schemaVersion: 2,
  dependencies: [],
  occurrences: [],
  activity: [],
};
