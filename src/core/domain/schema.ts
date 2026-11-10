import { z } from 'zod';
import { PlannerError } from './errors.js';
import type { Activity, Store, Task } from './model.js';
import { toLocalDate } from './time.js';

export const timeZoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, '时区无效，例如可填写 Asia/Shanghai');

export const localDateSchema = z.iso.date();
export const idSchema = z.string().trim().min(1).max(200);
export const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const taskOrderSchema = z.array(idSchema).min(2).refine(
  (ids) => new Set(ids).size === ids.length, '排序不能包含重复事件',
);
const levelSchema = z.enum(['high', 'low']);
const statusSchema = z.enum(['open', 'completed', 'cancelled']);
const utcSchema = z.iso.datetime({ precision: 3 }).refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  '存储时间必须是规范的 UTC ISO 时间',
);
const inputDateTimeSchema = z.iso.datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)),
  '截止时间无效，必须包含 Z 或 +08:00 这样的时区偏移',
).transform((value) => new Date(value).toISOString());

export const createTaskInputSchema = z.strictObject({
  title: z.string().trim().min(1, '标题不能为空').max(200, '标题不能超过 200 个字符'),
  importance: levelSchema,
  urgency: levelSchema,
  dueAt: inputDateTimeSchema,
  timeZone: timeZoneSchema.optional(),
});

export const updateTaskInputSchema = createTaskInputSchema.partial().refine(
  (value) => Object.values(value).some((entry) => entry !== undefined),
  '至少提供一个需要修改的字段',
);

export const taskFilterSchema = z.strictObject({
  status: statusSchema.optional(),
  importance: levelSchema.optional(),
  urgency: levelSchema.optional(),
  includeDeleted: z.boolean().optional(),
});

const storedId = z.string().min(1).max(200).refine((value) => value === value.trim());
const taskSchema = z.strictObject({
  id: storedId,
  revision: revisionSchema,
  title: z.string().min(1).max(200).refine((value) => value === value.trim()),
  importance: levelSchema,
  urgency: levelSchema,
  dueAt: utcSchema,
  timeZone: timeZoneSchema,
  status: statusSchema,
  createdAt: utcSchema,
  updatedAt: utcSchema,
  completedAt: utcSchema.nullable(),
  completionActivityId: storedId.nullable(),
  deletedAt: utcSchema.nullable(),
}).refine((task) => task.status === 'completed'
  ? task.completedAt !== null && task.completionActivityId !== null
  : task.completedAt === null && task.completionActivityId === null,
'完成状态与完成时间、完成记录 ID 不一致');

const activitySchema = z.strictObject({
  id: storedId,
  sequence: revisionSchema,
  taskId: storedId,
  kind: z.enum(['created', 'updated', 'completed', 'reopened', 'cancelled', 'deleted']),
  occurredAt: utcSchema,
  localDate: localDateSchema,
  timeZone: timeZoneSchema,
  taskSnapshot: taskSchema,
  previousSnapshot: taskSchema.nullable(),
  relatedActivityId: storedId.nullable(),
});

const legacyStoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  settings: z.strictObject({ historyTimeZone: timeZoneSchema }),
  tasks: z.array(taskSchema),
  activities: z.array(activitySchema),
});

export const dailyEntryInputSchema = z.strictObject({
  date: localDateSchema,
  content: z.string().trim().min(1, '请写下当天做的事').max(1000, '记录不能超过 1000 个字符'),
  effort: z.enum(['high', 'medium', 'low']).nullable(),
});
const dailyEntrySchema = dailyEntryInputSchema.extend({
  id: storedId, revision: revisionSchema,
  createdAt: utcSchema, updatedAt: utcSchema, deletedAt: utcSchema.nullable(),
});
const storeSchema = legacyStoreSchema.extend({
  schemaVersion: z.literal(2),
  dailyEntries: z.array(dailyEntrySchema),
});

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
    throw new PlannerError('VALIDATION_ERROR', details);
  }
  return parsed.data;
}

export function createEmptyStore(timeZone = 'Asia/Shanghai'): Store {
  return {
    schemaVersion: 2,
    revision: 0,
    settings: { historyTimeZone: parseInput(timeZoneSchema, timeZone) },
    tasks: [],
    activities: [],
    dailyEntries: [],
  };
}

function requireIntegrity(condition: boolean, message: string): asserts condition {
  if (!condition) throw new PlannerError('DATA_CORRUPTED', message);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkTransition(activity: Activity, previous: Task | undefined): void {
  const task = activity.taskSnapshot;
  requireIntegrity(task.id === activity.taskId, '历史快照的事件 ID 不一致');
  requireIntegrity(task.updatedAt === activity.occurredAt, '历史快照的更新时间不一致');
  requireIntegrity(toLocalDate(activity.occurredAt, activity.timeZone) === activity.localDate,
    '历史日期与记录时区不一致');

  if (activity.kind === 'created') {
    requireIntegrity(previous === undefined && activity.previousSnapshot === null,
      '同一事件只能创建一次');
    requireIntegrity(task.revision === 1 && task.status === 'open' && task.deletedAt === null
      && task.createdAt === activity.occurredAt && activity.relatedActivityId === null,
    '创建记录无效');
    return;
  }

  requireIntegrity(previous !== undefined && equal(previous, activity.previousSnapshot),
    '历史快照链不完整');
  requireIntegrity(previous.deletedAt === null && task.revision === previous.revision + 1
    && task.createdAt === previous.createdAt, '历史版本或事件状态不一致');

  const expected: Task = { ...previous, revision: task.revision, updatedAt: activity.occurredAt };
  switch (activity.kind) {
    case 'updated':
      Object.assign(expected, {
        title: task.title, importance: task.importance, urgency: task.urgency,
        dueAt: task.dueAt, timeZone: task.timeZone,
      });
      break;
    case 'completed':
      requireIntegrity(previous.status === 'open', '只有未完成事件可以标记完成');
      Object.assign(expected, {
        status: 'completed', completedAt: activity.occurredAt, completionActivityId: activity.id,
      });
      break;
    case 'reopened':
      requireIntegrity(previous.status === 'completed' || previous.status === 'cancelled',
        '重新打开记录的原状态无效');
      requireIntegrity(activity.relatedActivityId === previous.completionActivityId,
        '撤销完成未关联正确的完成记录');
      Object.assign(expected, { status: 'open', completedAt: null, completionActivityId: null });
      break;
    case 'cancelled':
      requireIntegrity(previous.status === 'open', '只有未完成事件可以取消');
      expected.status = 'cancelled';
      break;
    case 'deleted':
      expected.deletedAt = activity.occurredAt;
      break;
  }
  requireIntegrity(equal(expected, task), '历史操作与事件快照不一致');
  requireIntegrity(activity.kind === 'reopened' || activity.relatedActivityId === null,
    '历史关联字段不合法');
}

/** 读盘时同时验证结构与跨记录关系，避免语法正确但业务损坏的数据继续传播。 */
export function parseStore(raw: unknown): Store {
  if (typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
    && typeof raw.schemaVersion === 'number' && raw.schemaVersion !== 1 && raw.schemaVersion !== 2) {
    throw new PlannerError('UNSUPPORTED_SCHEMA_VERSION',
      `不支持数据格式版本 ${raw.schemaVersion}，当前版本为 2；原文件保持不变。`);
  }
  // Upgrade in memory; the next atomic transaction saves v2 and backs up the previous state.
  if (typeof raw === 'object' && raw !== null && 'schemaVersion' in raw && raw.schemaVersion === 1) {
    const legacy = legacyStoreSchema.safeParse(raw);
    if (!legacy.success) throw new PlannerError('DATA_CORRUPTED', '旧版 JSON 数据结构无效。');
    raw = { ...legacy.data, schemaVersion: 2, dailyEntries: [] };
  }
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlannerError('DATA_CORRUPTED', 'JSON 数据结构无效。', { cause: parsed.error });
  }
  const store: Store = parsed.data;
  requireIntegrity(new Set(store.dailyEntries.map((entry) => entry.id)).size === store.dailyEntries.length, '日结记录 ID 重复');
  const taskIds = new Set(store.tasks.map((task) => task.id));
  requireIntegrity(taskIds.size === store.tasks.length, '事件 ID 重复');
  const activityIds = new Set<string>();
  const snapshots = new Map<string, Task>();
  let sequence = 0;
  for (const activity of store.activities) {
    requireIntegrity(!activityIds.has(activity.id), '历史记录 ID 重复');
    requireIntegrity(taskIds.has(activity.taskId), '历史记录缺少对应事件');
    requireIntegrity(activity.sequence > sequence && activity.sequence <= store.revision,
      '历史提交序号无效');
    checkTransition(activity, snapshots.get(activity.taskId));
    activityIds.add(activity.id);
    snapshots.set(activity.taskId, activity.taskSnapshot);
    sequence = activity.sequence;
  }
  for (const task of store.tasks) {
    requireIntegrity(equal(task, snapshots.get(task.id)), '事件当前状态与最新历史不一致');
  }
  return store;
}
