import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { JsonStore, PlannerService, RandomIdGenerator } from '../src/index.js';
import type { Clock } from '../src/index.js';

class DemoClock implements Clock {
  constructor(private instant: string) {}
  now(): Date { return new Date(this.instant); }
  set(instant: string): void { this.instant = instant; }
}

async function main(): Promise<void> {
  const demoRoot = resolve('.local/demo');
  await mkdir(demoRoot, { recursive: true });
  const directory = await mkdtemp(join(demoRoot, 'run-'));
  const filePath = join(directory, 'state.json');
  const clock = new DemoClock('2026-10-26T16:00:00+08:00');
  let taskId: string;

  console.log('桌面日程表后端演示（使用固定演示时钟，不修改电脑时间）');
  console.log(`本次数据：${filePath}\n`);
  const store = await JsonStore.open(filePath);
  try {
    const service = new PlannerService(store, clock, new RandomIdGenerator());
    let task = await service.createTask({
      title: '整理项目资料', importance: 'high', urgency: 'low',
      dueAt: '2026-10-26T18:00:00+08:00', timeZone: 'Asia/Shanghai',
    });
    taskId = task.id;
    assert.equal(task.displayState, 'upcoming');
    console.log('1. 新增：整理项目资料；标签为重 / 缓；截止时间为 10 月 26 日 18:00。');

    clock.set('2026-10-26T18:00:00+08:00');
    task = await service.getTask(taskId);
    assert.equal(task.shouldStrikeThrough, true);
    assert.equal(task.status, 'open');
    assert.equal((await service.getDay('2026-10-26')).completedCount, 0);
    console.log('2. 到期：应当划线，但仍未完成；当天完成数为 0。');

    clock.set('2026-10-27T10:00:00+08:00');
    task = await service.completeTask(taskId, task.revision);
    assert.equal((await service.getDay('2026-10-27')).completedCount, 1);
    console.log('3. 次日手动完成：计入 10 月 27 日，而不是截止日期。');

    task = await service.updateTask(taskId, { title: '整理项目资料与截图' }, task.revision);
    assert.equal((await service.getDay('2026-10-27')).completed[0]?.taskSnapshot.title, '整理项目资料');
    console.log('4. 修改标题：当前标题已更新，完成历史仍保留“整理项目资料”。');

    clock.set('2026-10-28T09:00:00+08:00');
    task = await service.reopenTask(taskId, task.revision);
    const originalDay = await service.getDay('2026-10-27');
    assert.equal(originalDay.completedCount, 0);
    assert.equal(originalDay.activities.find((activity) => activity.kind === 'completed')?.completionRevoked, true);
    console.log('5. 跨日撤销：10 月 27 日有效完成数回到 0，原记录保留并标记已撤销。');

    clock.set('2026-10-28T10:00:00+08:00');
    task = await service.completeTask(taskId, task.revision);
    assert.equal((await service.getDay('2026-10-28')).completedCount, 1);
    console.log('6. 再次完成：10 月 28 日有效完成数为 1，不重复累计旧完成记录。');
  } finally {
    await store.close();
  }

  const reopened = await JsonStore.open(filePath);
  try {
    const service = new PlannerService(reopened, clock, new RandomIdGenerator());
    assert.equal((await service.getTask(taskId)).status, 'completed');
    assert.equal((await service.getDay('2026-10-27')).completedCount, 0);
    assert.equal((await service.getDay('2026-10-28')).completedCount, 1);
    console.log('7. 关闭后重新打开：事件及历史已从 JSON 恢复，结果一致。');
    console.log('\n演示全部通过。可用以下命令继续查看本次数据：');
    console.log(`npm run cli -- history 2026-10-28 --data-file "${filePath}"`);
  } finally {
    await reopened.close();
  }
}

main().catch((error: unknown) => {
  console.error(`演示失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
