import { describe, expect, it } from 'vitest';
import type { PriorityLevel, Quadrant, Task } from '../src/core/domain/model.js';
import { getQuadrant, toTaskView } from '../src/core/domain/task-view.js';
import { toLocalDate } from '../src/core/domain/time.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    revision: 1,
    title: '整理项目方案',
    importance: 'high',
    urgency: 'low',
    dueAt: '2026-10-27T10:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    status: 'open',
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    completedAt: null,
    completionActivityId: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('二维优先级', () => {
  const cases: [PriorityLevel, PriorityLevel, Quadrant][] = [
    ['high', 'high', 'important-urgent'],
    ['high', 'low', 'important-not-urgent'],
    ['low', 'high', 'not-important-urgent'],
    ['low', 'low', 'neither'],
  ];

  it.each(cases)('%s / %s 映射到 %s', (importance, urgency, expected) => {
    expect(getQuadrant({ importance, urgency })).toBe(expected);
  });
});

describe('时间状态投影', () => {
  it('截止瞬间划线，时钟回拨后恢复，并保留原始任务状态', () => {
    const source = task();
    const original = structuredClone(source);

    expect(toTaskView(source, new Date('2026-10-27T09:59:59.999Z'))).toMatchObject({
      displayState: 'upcoming', isExpired: false, shouldStrikeThrough: false,
    });
    expect(toTaskView(source, new Date(source.dueAt))).toMatchObject({
      displayState: 'expired', isExpired: true, shouldStrikeThrough: true, status: 'open',
    });
    expect(toTaskView(source, new Date('2026-10-27T09:00:00.000Z'))).toMatchObject({
      displayState: 'upcoming', isExpired: false, shouldStrikeThrough: false,
    });
    expect(source).toEqual(original);
  });

  it('完成、取消、删除的显示状态优先于到期状态', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    expect(toTaskView(task({ status: 'completed' }), now)).toMatchObject({
      displayState: 'completed', shouldStrikeThrough: true,
    });
    expect(toTaskView(task({ status: 'cancelled' }), now)).toMatchObject({
      displayState: 'cancelled', shouldStrikeThrough: false,
    });
    expect(toTaskView(task({ deletedAt: '2026-10-27T11:00:00.000Z' }), now)).toMatchObject({
      displayState: 'deleted', shouldStrikeThrough: false,
    });
  });

  it('返回视图与源任务相互隔离', () => {
    const source = task();
    const view = toTaskView(source, new Date(source.createdAt));
    view.title = '外部改写';
    expect(source.title).toBe('整理项目方案');
  });
});

describe('历史日期归属', () => {
  it('使用指定时区的日期，准确处理上海午夜边界', () => {
    expect(toLocalDate('2026-10-26T15:59:59.999Z', 'Asia/Shanghai')).toBe('2026-10-26');
    expect(toLocalDate('2026-10-26T16:00:00.000Z', 'Asia/Shanghai')).toBe('2026-10-27');
    expect(toLocalDate('2026-10-26T16:00:00.000Z', 'UTC')).toBe('2026-10-26');
  });

  it('按当地夏令时规则归日，而非固定 UTC 偏移', () => {
    expect(toLocalDate('2026-07-01T04:30:00.000Z', 'America/New_York')).toBe('2026-07-01');
    expect(toLocalDate('2026-01-01T04:30:00.000Z', 'America/New_York')).toBe('2025-12-31');
  });
});
