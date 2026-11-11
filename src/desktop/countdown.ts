import { PlannerError } from '../core/domain/errors.js';

export interface CountdownState {
  status: 'idle' | 'running' | 'paused' | 'finished';
  durationMs: number;
  remainingMs: number;
  endsAt: number | null;
}

/** One countdown per running app, independent of the widget's visibility. */
export class Countdown {
  private state: CountdownState = { status: 'idle', durationMs: 300_000, remainingMs: 300_000, endsAt: null };
  private alarm: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onExpire: () => void) {}

  snapshot(): CountdownState {
    this.checkTime();
    return { ...this.state };
  }

  start(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds >= 100 * 3600) {
      throw new PlannerError('VALIDATION_ERROR', '请输入 1 秒到 99 小时 59 分 59 秒之间的时长。');
    }
    if (this.state.status === 'running' || this.state.status === 'paused') return;
    this.state.durationMs = seconds * 1000;
    this.run(this.state.durationMs);
  }

  pause(): void {
    this.checkTime();
    if (this.state.status !== 'running') return;
    clearTimeout(this.alarm);
    this.state.status = 'paused';
    this.state.endsAt = null;
  }

  resume(): void {
    if (this.state.status === 'paused') this.run(this.state.remainingMs);
  }

  reset(): void {
    clearTimeout(this.alarm);
    this.state = { ...this.state, status: 'idle', endsAt: null, remainingMs: this.state.durationMs };
  }

  /** Reconcile on wake as Windows may have slept through the deadline. */
  checkTime(): void {
    if (this.state.endsAt === null) return;
    clearTimeout(this.alarm);
    this.state.remainingMs = Math.max(0, this.state.endsAt - Date.now());
    if (this.state.remainingMs === 0) {
      this.state.status = 'finished';
      this.state.endsAt = null;
      this.onExpire();
    } else {
      this.alarm = setTimeout(() => this.checkTime(), this.state.remainingMs);
    }
  }

  private run(remainingMs: number): void {
    this.state = { ...this.state, status: 'running', endsAt: Date.now() + remainingMs, remainingMs };
    this.checkTime();
  }
}
