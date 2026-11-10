import type { Quadrant, Task, TaskView } from './model.js';

export function getQuadrant(task: Pick<Task, 'importance' | 'urgency'>): Quadrant {
  if (task.importance === 'high') {
    return task.urgency === 'high' ? 'important-urgent' : 'important-not-urgent';
  }
  return task.urgency === 'high' ? 'not-important-urgent' : 'neither';
}

/** 时间状态只计算，不修改完成状态，也不写入历史。 */
export function toTaskView(task: Task, now: Date): TaskView {
  const isExpired = now.getTime() >= Date.parse(task.dueAt);
  const displayState = task.deletedAt !== null ? 'deleted'
    : task.status === 'completed' ? 'completed'
    : task.status === 'cancelled' ? 'cancelled'
    : isExpired ? 'expired' : 'upcoming';

  return {
    ...structuredClone(task),
    quadrant: getQuadrant(task),
    isExpired,
    shouldStrikeThrough: displayState === 'completed' || displayState === 'expired',
    displayState,
  };
}
