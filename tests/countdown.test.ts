import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Countdown } from '../src/desktop/countdown.js';

describe('倒计时', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('暂停时保留不足一秒的余量，继续后只提醒一次', () => {
    const remind = vi.fn();
    const timer = new Countdown(remind);
    timer.start(3);
    vi.advanceTimersByTime(1250);
    timer.pause();
    vi.advanceTimersByTime(5000);
    expect(timer.snapshot()).toMatchObject({ status: 'paused', remainingMs: 1750, endsAt: null });
    timer.resume();
    vi.advanceTimersByTime(1749);
    expect(remind).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timer.snapshot()).toMatchObject({ status: 'finished', remainingMs: 0 });
    timer.checkTime();
    vi.advanceTimersByTime(5000);
    expect(remind).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'paused'])('从 %s 重置后恢复原时长并取消旧提醒', (status) => {
    const remind = vi.fn();
    const timer = new Countdown(remind);
    timer.start(5);
    vi.advanceTimersByTime(1600);
    if (status === 'paused') timer.pause();
    timer.reset();
    vi.advanceTimersByTime(6000);
    expect(timer.snapshot()).toMatchObject({ status: 'idle', durationMs: 5000, remainingMs: 5000, endsAt: null });
    expect(remind).not.toHaveBeenCalled();
    timer.start(1);
    vi.advanceTimersByTime(1000);
    expect(remind).toHaveBeenCalledTimes(1);
  });

  it('系统恢复时按剩余时间安排提醒，已过期则立即提醒一次', () => {
    const remind = vi.fn();
    const timer = new Countdown(remind);
    timer.start(10);
    vi.setSystemTime(Date.now() + 8000);
    timer.checkTime();
    vi.advanceTimersByTime(2000);
    expect(remind).toHaveBeenCalledTimes(1);
    timer.start(1);
    vi.setSystemTime(Date.now() + 2500);
    timer.checkTime();
    timer.checkTime();
    expect(remind).toHaveBeenCalledTimes(2);
  });

  it('拒绝零、负数、非整数和超出输入范围的时长', () => {
    const timer = new Countdown(vi.fn());
    for (const value of [0, -1, 1.5, NaN, 360000]) expect(() => timer.start(value)).toThrow();
    expect(timer.snapshot().status).toBe('idle');
  });
});
