export type PriorityLevel = 'high' | 'low';
export type TaskStatus = 'open' | 'completed' | 'cancelled';
export type ActivityKind = 'created' | 'updated' | 'completed' | 'reopened' | 'cancelled' | 'deleted';

export interface Task {
  id: string;
  revision: number;
  title: string;
  importance: PriorityLevel;
  urgency: PriorityLevel;
  dueAt: string;
  timeZone: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completionActivityId: string | null;
  deletedAt: string | null;
}

export interface Activity {
  id: string;
  sequence: number;
  taskId: string;
  kind: ActivityKind;
  occurredAt: string;
  localDate: string;
  timeZone: string;
  taskSnapshot: Task;
  previousSnapshot: Task | null;
  relatedActivityId: string | null;
}

export interface Store {
  schemaVersion: 2;
  revision: number;
  settings: { historyTimeZone: string };
  tasks: Task[];
  activities: Activity[];
  dailyEntries: DailyEntry[];
}

export type Effort = 'high' | 'medium' | 'low';
export interface DailyEntryInput {
  date: string;
  content: string;
  effort: Effort | null;
}
export interface DailyEntry extends DailyEntryInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateTaskInput {
  title: string;
  importance: PriorityLevel;
  urgency: PriorityLevel;
  dueAt: string;
  timeZone?: string;
}

export type UpdateTaskInput = Partial<CreateTaskInput>;

export interface TaskFilter {
  status?: TaskStatus;
  importance?: PriorityLevel;
  urgency?: PriorityLevel;
  includeDeleted?: boolean;
}

export type Quadrant = 'important-urgent' | 'important-not-urgent' | 'not-important-urgent' | 'neither';

export interface TaskView extends Task {
  quadrant: Quadrant;
  isExpired: boolean;
  shouldStrikeThrough: boolean;
  displayState: 'upcoming' | 'expired' | 'completed' | 'cancelled' | 'deleted';
}

export interface HistoryActivity extends Activity {
  completionRevoked: boolean;
}

export interface DailyHistory {
  date: string;
  activities: HistoryActivity[];
  completed: HistoryActivity[];
  completedCount: number;
}

export interface HistoryDay {
  date: string;
  activityCount: number;
  completedCount: number;
}
