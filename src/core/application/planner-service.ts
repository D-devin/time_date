import { PlannerError } from '../domain/errors.js';
import type {
  Activity, ActivityKind, CreateTaskInput, DailyHistory, HistoryActivity,
  HistoryDay, Store, Task, TaskFilter, TaskView, UpdateTaskInput,
} from '../domain/model.js';
import {
  createTaskInputSchema, idSchema, localDateSchema, parseInput,
  revisionSchema, taskFilterSchema, taskOrderSchema, updateTaskInputSchema,
} from '../domain/schema.js';
import { toTaskView } from '../domain/task-view.js';
import { toLocalDate } from '../domain/time.js';
import type { Clock, IdGenerator } from '../ports/clock.js';
import type { StoreRepository } from '../ports/store-repository.js';

type TaskMutation = (task: Task, now: string) => Exclude<ActivityKind, 'created'> | null;

/** 本地业务入口。只依赖仓库、时钟和 ID 接口，不知道 Electron 或文件路径。 */
export class PlannerService {
  constructor(
    private readonly repository: StoreRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async createTask(input: CreateTaskInput): Promise<TaskView> {
    const parsed = parseInput(createTaskInputSchema, input);
    const task = await this.repository.transact((draft) => {
      const now = this.now().toISOString();
      const task: Task = {
        id: this.nextId(draft),
        revision: 1,
        title: parsed.title,
        importance: parsed.importance,
        urgency: parsed.urgency,
        dueAt: parsed.dueAt,
        timeZone: parsed.timeZone ?? draft.settings.historyTimeZone,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        completionActivityId: null,
        deletedAt: null,
      };
      draft.tasks.push(task);
      this.record(draft, task, 'created', now, null, this.nextId(draft));
      return { value: task, changed: true };
    });
    return toTaskView(task, this.now());
  }

  async updateTask(id: string, input: UpdateTaskInput, expectedRevision: number): Promise<TaskView> {
    const parsed = parseInput(updateTaskInputSchema, input);
    return this.mutateTask(id, expectedRevision, (task) => {
      let changed = false;
      for (const key of ['title', 'importance', 'urgency', 'dueAt', 'timeZone'] as const) {
        const value = parsed[key];
        if (value !== undefined && value !== task[key]) {
          // 逐字段更新，禁止通过补丁修改完成状态和系统审计字段。
          Object.assign(task, { [key]: value });
          changed = true;
        }
      }
      return changed ? 'updated' : null;
    });
  }

  async completeTask(id: string, expectedRevision: number): Promise<TaskView> {
    return this.mutateTask(id, expectedRevision, (task, now) => {
      if (task.status === 'completed') return null;
      if (task.status !== 'open') {
        throw new PlannerError('INVALID_STATE', '已取消事件请先重新打开，再标记完成。');
      }
      task.status = 'completed';
      task.completedAt = now;
      return 'completed';
    });
  }

  async reopenTask(id: string, expectedRevision: number): Promise<TaskView> {
    return this.mutateTask(id, expectedRevision, (task) => {
      if (task.status === 'open') return null;
      task.status = 'open';
      task.completedAt = null;
      task.completionActivityId = null;
      return 'reopened';
    });
  }

  async cancelTask(id: string, expectedRevision: number): Promise<TaskView> {
    return this.mutateTask(id, expectedRevision, (task) => {
      if (task.status === 'cancelled') return null;
      if (task.status === 'completed') {
        throw new PlannerError('INVALID_STATE', '已完成事件请先撤销完成，再取消。');
      }
      task.status = 'cancelled';
      return 'cancelled';
    });
  }

  async deleteTask(id: string, expectedRevision: number): Promise<TaskView> {
    return this.mutateTask(id, expectedRevision, (task, now) => {
      task.deletedAt = now;
      return 'deleted';
    });
  }

  /** 可查询已删除事件，供历史详情使用；列表默认隐藏它们。 */
  async getTask(id: string): Promise<TaskView> {
    const validId = parseInput(idSchema, id);
    const store = await this.repository.read();
    const task = store.tasks.find((entry) => entry.id === validId);
    if (!task) throw new PlannerError('NOT_FOUND', '没有找到该事件。');
    return toTaskView(task, this.now());
  }

  async listTasks(filter: TaskFilter = {}): Promise<TaskView[]> {
    const parsed = parseInput(taskFilterSchema, filter);
    const store = await this.repository.read();
    const now = this.now();
    return store.tasks
      .filter((task) => (parsed.includeDeleted || task.deletedAt === null)
        && (parsed.status === undefined || task.status === parsed.status)
        && (parsed.importance === undefined || task.importance === parsed.importance)
        && (parsed.urgency === undefined || task.urgency === parsed.urgency))
      .map((task) => toTaskView(task, now));
  }

  /** Reorder only the submitted rows, preserving hidden rows and concurrent additions. */
  async reorderTasks(ids: string[]): Promise<void> {
    const order = parseInput(taskOrderSchema, ids);
    await this.repository.transact((draft) => {
      const byId = new Map(draft.tasks.filter((task) => !task.deletedAt).map((task) => [task.id, task]));
      const reordered = order.map((id) => {
        const task = byId.get(id);
        if (!task) throw new PlannerError('CONFLICT', '事件清单已变化，请刷新后重新排序。');
        return task;
      });
      const selected = new Set(order);
      let index = 0;
      let changed = false;
      draft.tasks = draft.tasks.map((task) => {
        if (!selected.has(task.id)) return task;
        const replacement = reordered[index++]!;
        changed ||= replacement.id !== task.id;
        return replacement;
      });
      return { value: undefined, changed };
    });
  }

  async getDay(localDate: string): Promise<DailyHistory> {
    const date = parseInput(localDateSchema, localDate);
    const store = await this.repository.read();
    // 撤销可能发生在别的日期，必须先解析全部历史，再筛选当天。
    const activities = this.historyActivities(store).filter((activity) => activity.localDate === date);
    const completed = activities.filter((activity) => activity.kind === 'completed' && !activity.completionRevoked);
    return { date, activities, completed, completedCount: completed.length };
  }

  async listHistoryDays(): Promise<HistoryDay[]> {
    const store = await this.repository.read();
    const days = new Map<string, HistoryDay>();
    for (const activity of this.historyActivities(store)) {
      const day = days.get(activity.localDate) ?? {
        date: activity.localDate, activityCount: 0, completedCount: 0,
      };
      day.activityCount += 1;
      if (activity.kind === 'completed' && !activity.completionRevoked) day.completedCount += 1;
      days.set(day.date, day);
    }
    return [...days.values()].sort((left, right) => right.date.localeCompare(left.date));
  }

  private async mutateTask(id: string, expectedRevision: number, mutate: TaskMutation): Promise<TaskView> {
    const validId = parseInput(idSchema, id);
    const revision = parseInput(revisionSchema, expectedRevision);
    const task = await this.repository.transact((draft) => {
      const task = draft.tasks.find((entry) => entry.id === validId);
      if (!task) throw new PlannerError('NOT_FOUND', '没有找到该事件。');
      if (task.revision !== revision) {
        throw new PlannerError('CONFLICT', '事件已经被修改，请刷新后重试。');
      }
      if (task.deletedAt !== null) {
        throw new PlannerError('INVALID_STATE', '事件已删除，不能继续修改。');
      }
      const previous = structuredClone(task);
      const now = this.now().toISOString();
      const kind = mutate(task, now);
      if (kind === null) return { value: task, changed: false };

      const activityId = this.nextId(draft);
      task.revision += 1;
      task.updatedAt = now;
      if (kind === 'completed') task.completionActivityId = activityId;
      this.record(draft, task, kind, now, previous, activityId);
      return { value: task, changed: true };
    });
    return toTaskView(task, this.now());
  }

  private record(draft: Store, task: Task, kind: ActivityKind, now: string, previous: Task | null, id: string): void {
    const activity: Activity = {
      id,
      sequence: draft.revision + 1,
      taskId: task.id,
      kind,
      occurredAt: now,
      localDate: toLocalDate(now, draft.settings.historyTimeZone),
      timeZone: draft.settings.historyTimeZone,
      taskSnapshot: structuredClone(task),
      previousSnapshot: previous,
      relatedActivityId: kind === 'reopened' ? previous?.completionActivityId ?? null : null,
    };
    draft.activities.push(activity);
  }

  private historyActivities(store: Store): HistoryActivity[] {
    const revoked = new Set(store.activities
      .filter((activity) => activity.kind === 'reopened' && activity.relatedActivityId !== null)
      .map((activity) => activity.relatedActivityId));
    return store.activities.map((activity) => ({
      ...structuredClone(activity),
      completionRevoked: activity.kind === 'completed' && revoked.has(activity.id),
    }));
  }

  private nextId(store: Store): string {
    const id = parseInput(idSchema, this.ids.next());
    if (store.tasks.some((task) => task.id === id) || store.activities.some((activity) => activity.id === id)) {
      throw new PlannerError('INVALID_STATE', 'ID 生成冲突，请重试。');
    }
    return id;
  }

  private now(): Date {
    const now = this.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new PlannerError('VALIDATION_ERROR', '当前时钟无效。');
    }
    return now;
  }
}
