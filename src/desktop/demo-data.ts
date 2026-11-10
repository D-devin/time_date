import { PlannerService, RandomIdGenerator } from '../index.js';
import type { StoreRepository } from '../index.js';

/** 仅在独立的演示仓库首次打开时写入，重新启动保留用户对样例的修改。 */
export async function seedDemo(store: StoreRepository): Promise<void> {
  const state = await store.read();
  if (state.revision !== 0 || state.tasks.length !== 0) return;

  const now = Date.now();
  const minute = 60_000;
  const at = (offsetMinutes: number) => new Date(now + offsetMinutes * minute).toISOString();
  let instant = at(-24 * 60);
  const service = new PlannerService(store, { now: () => new Date(instant) }, new RandomIdGenerator());
  const yesterday = await service.createTask({
    title: '归档上周的会议笔记', importance: 'low', urgency: 'low', dueAt: at(-24 * 60 + 10),
  });
  await service.completeTask(yesterday.id, yesterday.revision);

  instant = at(0);
  await service.createTask({
    title: '确认本周的交付清单', importance: 'high', urgency: 'high', dueAt: at(-12),
  });
  await service.createTask({
    title: '准备项目讨论提纲', importance: 'high', urgency: 'low', dueAt: at(40),
  });
  await service.createTask({
    title: '回复读书会的邀请', importance: 'low', urgency: 'high', dueAt: at(85),
  });
  const finished = await service.createTask({
    title: '整理今天的阅读摘记', importance: 'low', urgency: 'low', dueAt: at(-25),
  });
  await service.completeTask(finished.id, finished.revision);
}
