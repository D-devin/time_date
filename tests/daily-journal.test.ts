import { describe, expect, it } from 'vitest';
import { DailyJournalService, MemoryStore, PlannerService, createEmptyStore, parseStore } from '../src/index.js';

function setup() {
  const repository = new MemoryStore();
  const clock = { now: () => new Date('2026-11-10T12:00:00Z') };
  let sequence = 0;
  const ids = { next: () => `entry-${++sequence}` };
  return { repository, journal: new DailyJournalService(repository, clock, ids), planner: new PlannerService(repository, clock, ids) };
}
const input = { date: '2026-11-09', content: '读了方法部分\n整理三个问题', effort: 'medium' as const };

describe('日结', () => {
  it('按手选日期保存内容与可选投入，不改变日程状态或完成统计', async () => {
    const { journal, repository, planner } = setup();
    await planner.createTask({ title: '阅读整篇论文', importance: 'high', urgency: 'low', dueAt: '2026-11-20T10:00:00Z' });
    const before = await repository.read();
    const entry = await journal.create(input);
    await journal.create({ ...input, date: '2026-11-10', effort: null });
    expect(await journal.list(input.date)).toEqual([entry]);
    expect(await journal.list('2026-11-08')).toEqual([]);
    const after = await repository.read();
    expect(after.tasks).toEqual(before.tasks);
    expect(after.activities).toEqual(before.activities);
    expect((await planner.getDay(input.date)).completedCount).toBe(0);
    const restored = new DailyJournalService(new MemoryStore(after), { now: () => new Date() }, { next: () => 'fresh' });
    expect(await restored.list(input.date)).toEqual([entry]);
  });

  it('允许修改日期和投入，拒绝过期编辑，软删除后从日期列表隐藏', async () => {
    const { journal, repository } = setup();
    const entry = await journal.create(input);
    const edited = await journal.update(entry.id, { ...input, date: '2026-11-08', effort: 'low' }, entry.revision);
    expect(await journal.list(input.date)).toEqual([]);
    expect(await journal.list('2026-11-08')).toEqual([edited]);
    const saved = await repository.read();
    await journal.update(edited.id, { ...input, date: edited.date, effort: 'low' }, edited.revision);
    expect(await repository.read()).toEqual(saved);
    await expect(journal.update(entry.id, input, entry.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    await journal.remove(edited.id, edited.revision);
    expect(await journal.list(edited.date)).toEqual([]);
    expect((await repository.read()).dailyEntries[0]?.deletedAt).toBeTruthy();
    await expect(journal.update(edited.id, input, edited.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('校验空内容、长度、日期和投入，并原子拒绝无效输入', async () => {
    const { journal, repository } = setup();
    const before = await repository.read();
    for (const patch of [{ content: ' \n ' }, { content: '字'.repeat(1001) }, { date: '2026-02-30' }, { effort: 'huge' }]) {
      await expect(journal.create({ ...input, ...patch } as typeof input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await repository.read()).toEqual(before);
  });

  it('无损读取旧格式，并拒绝缺少日结集合的新版数据', () => {
    const { dailyEntries, ...base } = createEmptyStore();
    const legacy = { ...base, schemaVersion: 1 };
    expect(parseStore(legacy)).toEqual(createEmptyStore());
    expect(legacy).not.toHaveProperty('dailyEntries');
    expect(() => parseStore({ ...base, schemaVersion: 2 })).toThrow();
  });
});
