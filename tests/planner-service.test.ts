import { describe, expect, it } from 'vitest';
import { PlannerService } from '../src/core/application/planner-service.js';
import type { CreateTaskInput, PriorityLevel, Quadrant } from '../src/core/domain/model.js';
import type { Clock, IdGenerator } from '../src/core/ports/clock.js';
import { MemoryStore } from '../src/infrastructure/persistence/memory-store.js';

class ManualClock implements Clock {
  constructor(private instant = '2026-10-27T00:00:00.000Z') {}

  now(): Date { return new Date(this.instant); }
  set(instant: string): void { this.instant = instant; }
}

class SequentialIds implements IdGenerator {
  private sequence = 0;
  next(): string { return `test-id-${++this.sequence}`; }
}

function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    title: '完成架构设计',
    importance: 'high',
    urgency: 'low',
    dueAt: '2026-10-27T18:00:00+08:00',
    ...overrides,
  };
}

function setup() {
  const repository = new MemoryStore();
  const clock = new ManualClock();
  const service = new PlannerService(repository, clock, new SequentialIds());
  return { service, repository, clock };
}

describe('创建、分类和更新', () => {
  it('保存 UTC 截止时刻和独立的二维标签，产生创建历史', async () => {
    const { service, repository } = setup();
    const created = await service.createTask(input());

    expect(created).toMatchObject({
      title: '完成架构设计', importance: 'high', urgency: 'low',
      dueAt: '2026-10-27T10:00:00.000Z', timeZone: 'Asia/Shanghai',
      status: 'open', completedAt: null, deletedAt: null,
      quadrant: 'important-not-urgent', displayState: 'upcoming',
    });
    const store = await repository.read();
    expect(store.activities).toHaveLength(1);
    expect(store.activities[0]).toMatchObject({
      taskId: created.id, kind: 'created', localDate: '2026-10-27',
      previousSnapshot: null, taskSnapshot: { title: created.title, revision: created.revision },
    });
    expect(store.tasks[0]).not.toHaveProperty('isExpired');
    expect(store.tasks[0]).not.toHaveProperty('shouldStrikeThrough');
  });

  const quadrants: [PriorityLevel, PriorityLevel, Quadrant][] = [
    ['high', 'high', 'important-urgent'],
    ['high', 'low', 'important-not-urgent'],
    ['low', 'high', 'not-important-urgent'],
    ['low', 'low', 'neither'],
  ];

  it('四种组合均独立保存，两个维度可以分别筛选或组合筛选', async () => {
    const { service } = setup();
    for (const [importance, urgency, quadrant] of quadrants) {
      const created = await service.createTask(input({ importance, urgency }));
      expect(created.quadrant).toBe(quadrant);
    }
    expect(await service.listTasks()).toHaveLength(4);
    const important = await service.listTasks({ importance: 'high' });
    expect(important).toHaveLength(2);
    expect(important.every((entry) => entry.importance === 'high')).toBe(true);
    const urgent = await service.listTasks({ urgency: 'high' });
    expect(urgent).toHaveLength(2);
    expect(urgent.every((entry) => entry.urgency === 'high')).toBe(true);
    for (const [importance, urgency, quadrant] of quadrants) {
      const matches = await service.listTasks({ importance, urgency });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.quadrant).toBe(quadrant);
    }
  });

  it('修改递增版本并记录前后快照，旧创建记录不被改写', async () => {
    const { service, repository, clock } = setup();
    const created = await service.createTask(input());
    const before = await repository.read();
    clock.set('2026-10-27T01:00:00.000Z');
    const updated = await service.updateTask(created.id, { title: '完成实现', urgency: 'high' }, created.revision);
    const after = await repository.read();

    expect(updated).toMatchObject({
      title: '完成实现', urgency: 'high', revision: created.revision + 1,
      updatedAt: '2026-10-27T01:00:00.000Z',
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.activities[0]).toEqual(before.activities[0]);
    expect(after.activities[1]).toMatchObject({
      kind: 'updated', previousSnapshot: { title: created.title },
      taskSnapshot: { title: updated.title },
    });
  });
});

describe('手动排序', () => {
  it('保存手动顺序；截止时间、完成状态和后续新增不会重排旧事件', async () => {
    const { service, repository } = setup();
    const first = await service.createTask(input({ title: '先创建，较晚截止', dueAt: '2026-11-01T10:00:00Z' }));
    const second = await service.createTask(input({ title: '后创建，较早截止' }));
    expect((await service.listTasks()).map((task) => task.id)).toEqual([first.id, second.id]);
    const before = await repository.read();
    await service.reorderTasks([second.id, first.id]);
    const saved = await repository.read();
    expect(saved.tasks).toEqual([before.tasks[1], before.tasks[0]]);
    expect(saved.activities).toEqual(before.activities);
    expect(saved.revision).toBe(before.revision + 1);
    await service.reorderTasks([second.id, first.id]);
    expect(await repository.read()).toEqual(saved);
    const restored = new PlannerService(new MemoryStore(saved), new ManualClock(), new SequentialIds());
    expect((await restored.listTasks()).map((task) => task.id)).toEqual([second.id, first.id]);
    await service.completeTask(second.id, second.revision);
    await service.updateTask(first.id, { dueAt: '2026-10-26T10:00:00Z' }, first.revision);
    const added = await service.createTask(input());
    expect((await service.listTasks()).map((task) => task.id)).toEqual([second.id, first.id, added.id]);
  });

  it('筛选排序只交换提交的行，保留隐藏行、已删除行及新添加事件', async () => {
    const { service, repository } = setup();
    const first = await service.createTask(input());
    const hidden = await service.createTask(input());
    const deleted = await service.createTask(input());
    const last = await service.createTask(input());
    await service.completeTask(hidden.id, hidden.revision);
    await service.deleteTask(deleted.id, deleted.revision);
    const added = await service.createTask(input());
    await service.reorderTasks([last.id, first.id]);
    expect((await repository.read()).tasks.map((task) => task.id))
      .toEqual([last.id, hidden.id, deleted.id, first.id, added.id]);
    expect((await service.listTasks({ status: 'open' })).map((task) => task.id))
      .toEqual([last.id, first.id, added.id]);
  });

  it('拒绝重复、未知及已删除的事件，不留下部分排序', async () => {
    const { service, repository } = setup();
    const first = await service.createTask(input());
    const deleted = await service.createTask(input());
    await service.deleteTask(deleted.id, deleted.revision);
    const before = await repository.read();
    await expect(service.reorderTasks([first.id, first.id])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.reorderTasks(['missing', first.id])).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.reorderTasks([deleted.id, first.id])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await repository.read()).toEqual(before);
  });
});

describe('到期与完成相互独立', () => {
  it('到期及时间回拨只改变视图，不写存储也不增加完成统计', async () => {
    const { service, repository, clock } = setup();
    const created = await service.createTask(input());
    const persisted = await repository.read();

    clock.set('2026-10-27T09:59:59.999Z');
    expect((await service.getTask(created.id)).shouldStrikeThrough).toBe(false);
    clock.set(created.dueAt);
    expect(await service.getTask(created.id)).toMatchObject({
      status: 'open', displayState: 'expired', shouldStrikeThrough: true,
    });
    expect((await service.listTasks())[0]?.displayState).toBe('expired');
    expect((await service.getDay('2026-10-27')).completedCount).toBe(0);
    clock.set('2026-10-27T08:00:00.000Z');
    expect(await service.getTask(created.id)).toMatchObject({ displayState: 'upcoming', shouldStrikeThrough: false });
    expect(await repository.read()).toEqual(persisted);
  });

  it('到期后延期恢复未到期显示，不制造完成记录', async () => {
    const { service, clock } = setup();
    const created = await service.createTask(input());
    clock.set('2026-10-27T11:00:00.000Z');
    const extended = await service.updateTask(created.id, { dueAt: '2026-10-28T18:00:00+08:00' }, created.revision);
    expect(extended).toMatchObject({ status: 'open', isExpired: false, shouldStrikeThrough: false });
    expect((await service.getDay('2026-10-27')).completedCount).toBe(0);
  });
});

describe('完成和按天历史', () => {
  it('跨日撤销关联原完成记录，再次完成计入新的一天', async () => {
    const { service, repository, clock } = setup();
    clock.set('2026-10-27T15:30:00.000Z');
    const created = await service.createTask(input());
    clock.set('2026-10-27T15:50:00.000Z');
    const completed = await service.completeTask(created.id, created.revision);
    const firstCompletion = (await service.getDay('2026-10-27')).completed[0]!;
    expect(firstCompletion).toMatchObject({ kind: 'completed', completionRevoked: false });
    expect(completed.completedAt).toBe('2026-10-27T15:50:00.000Z');

    clock.set('2026-10-27T16:10:00.000Z');
    const reopened = await service.reopenTask(created.id, completed.revision);
    expect(reopened).toMatchObject({ status: 'open', completedAt: null, completionActivityId: null });
    const oldDay = await service.getDay('2026-10-27');
    expect(oldDay.completedCount).toBe(0);
    expect(oldDay.completed).toEqual([]);
    expect(oldDay.activities.find((activity) => activity.id === firstCompletion.id)).toMatchObject({
      completionRevoked: true, taskSnapshot: { status: 'completed' },
    });
    expect((await service.getDay('2026-10-28')).activities[0]).toMatchObject({
      kind: 'reopened', relatedActivityId: firstCompletion.id,
    });
    expect((await repository.read()).activities.find((activity) => activity.id === firstCompletion.id)?.taskSnapshot)
      .toEqual(firstCompletion.taskSnapshot);

    clock.set('2026-10-27T16:20:00.000Z');
    await service.completeTask(created.id, reopened.revision);
    expect((await service.getDay('2026-10-28')).completedCount).toBe(1);
    expect((await service.getDay('2026-10-27')).completedCount).toBe(0);
    const days = await service.listHistoryDays();
    expect(days.find((day) => day.date === '2026-10-27')).toMatchObject({ activityCount: 2, completedCount: 0 });
    expect(days.find((day) => day.date === '2026-10-28')).toMatchObject({ activityCount: 2, completedCount: 1 });
  });

  it('修改和软删除保留完成时的内容，并可单独查询删除的任务', async () => {
    const { service, clock } = setup();
    const created = await service.createTask(input());
    const completed = await service.completeTask(created.id, created.revision);
    const completion = (await service.getDay('2026-10-27')).completed[0]!;
    clock.set('2026-10-28T00:00:00.000Z');
    const updated = await service.updateTask(created.id, { title: '新的任务标题' }, completed.revision);
    const deleted = await service.deleteTask(created.id, updated.revision);

    expect(await service.listTasks()).toEqual([]);
    expect(await service.listTasks({ includeDeleted: true })).toHaveLength(1);
    expect(await service.getTask(created.id)).toMatchObject({
      title: '新的任务标题', deletedAt: deleted.deletedAt, displayState: 'deleted',
    });
    const oldDay = await service.getDay('2026-10-27');
    expect(oldDay.completedCount).toBe(1);
    expect(oldDay.completed[0]).toEqual(completion);
  });

  it('没有活动的日期返回空历史', async () => {
    const { service } = setup();
    expect(await service.getDay('2026-10-27')).toEqual({
      date: '2026-10-27', activities: [], completed: [], completedCount: 0,
    });
    expect(await service.listHistoryDays()).toEqual([]);
  });
});

describe('状态转换与版本冲突', () => {
  it('完成请求幂等，但重复请求仍需持有当前版本', async () => {
    const { service, repository } = setup();
    const created = await service.createTask(input());
    const completed = await service.completeTask(created.id, created.revision);
    const persisted = await repository.read();
    expect(await service.completeTask(created.id, completed.revision)).toEqual(completed);
    expect(await repository.read()).toEqual(persisted);
    await expect(service.completeTask(created.id, created.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await repository.read()).toEqual(persisted);
  });

  it('旧版本更新失败且不留下部分修改或历史', async () => {
    const { service, repository } = setup();
    const created = await service.createTask(input());
    await service.updateTask(created.id, { title: '先保存的内容' }, created.revision);
    const persisted = await repository.read();
    await expect(service.updateTask(created.id, { title: '过时的修改' }, created.revision))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await repository.read()).toEqual(persisted);
  });

  it('两个窗口并发提交同一版本时只有一次更新成功', async () => {
    const { service, repository } = setup();
    const created = await service.createTask(input());
    const before = await repository.read();
    const results = await Promise.allSettled([
      service.updateTask(created.id, { title: '窗口一' }, created.revision),
      service.updateTask(created.id, { title: '窗口二' }, created.revision),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' ? failure.reason : undefined).toMatchObject({ code: 'CONFLICT' });
    const after = await repository.read();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.activities).toHaveLength(before.activities.length + 1);
    expect((await service.getTask(created.id)).revision).toBe(created.revision + 1);
  });

  it('取消后可以恢复，未关闭的任务再次恢复不产生新历史', async () => {
    const { service, repository } = setup();
    const created = await service.createTask(input());
    const cancelled = await service.cancelTask(created.id, created.revision);
    expect(cancelled.status).toBe('cancelled');
    const reopened = await service.reopenTask(created.id, cancelled.revision);
    expect(reopened.status).toBe('open');
    expect(reopened.revision).toBe(cancelled.revision + 1);
    const persisted = await repository.read();
    expect(await service.reopenTask(created.id, reopened.revision)).toEqual(reopened);
    expect(await repository.read()).toEqual(persisted);
    expect((await service.getDay('2026-10-27')).completedCount).toBe(0);
  });

  it('删除后禁止修改、完成、取消或恢复', async () => {
    const { service, repository } = setup();
    const created = await service.createTask(input());
    const deleted = await service.deleteTask(created.id, created.revision);
    const persisted = await repository.read();
    await expect(service.updateTask(deleted.id, { title: '禁止修改' }, deleted.revision))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(service.completeTask(deleted.id, deleted.revision)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(service.cancelTask(deleted.id, deleted.revision)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(service.reopenTask(deleted.id, deleted.revision)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await repository.read()).toEqual(persisted);
  });

  it('未知任务返回明确错误', async () => {
    const { service } = setup();
    await expect(service.getTask('missing-task')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('输入校验和数据隔离', () => {
  const invalidInputs: [string, Partial<CreateTaskInput>][] = [
    ['空白标题', { title: '  \n\t ' }],
    ['非法重要程度', { importance: 'medium' as PriorityLevel }],
    ['非法紧急程度', { urgency: 'urgent' as PriorityLevel }],
    ['没有时区', { dueAt: '2026-10-27T18:00:00' }],
    ['不存在的日期', { dueAt: '2026-02-30T18:00:00+08:00' }],
    ['错误闰日', { dueAt: '2026-02-29T18:00:00Z' }],
    ['非法时间', { dueAt: '2026-10-27T25:00:00Z' }],
    ['非法时区', { timeZone: 'Invalid/Nowhere' }],
  ];

  it.each(invalidInputs)('拒绝%s，且不写入存储', async (_label, patch) => {
    const { service, repository } = setup();
    const before = await repository.read();
    await expect(service.createTask(input(patch))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await repository.read()).toEqual(before);
  });

  it('修改也必须满足截止时刻校验', async () => {
    const { service, repository } = setup();
    const created = await service.createTask(input());
    const persisted = await repository.read();
    await expect(service.updateTask(created.id, { dueAt: '2026-02-30T10:00:00Z' }, created.revision))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await repository.read()).toEqual(persisted);
  });

  it.each(['2026-02-30', '2026-2-03', '2026-10-27T00:00:00Z'])('拒绝非法历史日期 %s', async (date) => {
    const { service } = setup();
    await expect(service.getDay(date)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('外部修改返回的任务、历史快照和列表不能污染后端状态', async () => {
    const { service, repository } = setup();
    const created = await service.createTask(input());
    const originalTitle = created.title;
    const persisted = await repository.read();
    created.title = '改写创建结果';
    const found = await service.getTask(created.id);
    found.title = '改写查询结果';
    const listed = await service.listTasks();
    listed[0]!.title = '改写列表结果';
    const history = await service.getDay('2026-10-27');
    history.activities[0]!.taskSnapshot.title = '改写历史快照';
    history.activities.length = 0;
    expect((await service.getTask(created.id)).title).toBe(originalTitle);
    expect(await repository.read()).toEqual(persisted);
  });
});
