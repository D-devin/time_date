import type { Clock } from '../../core/ports/clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
