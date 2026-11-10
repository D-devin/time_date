import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../core/ports/clock.js';

export class RandomIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
