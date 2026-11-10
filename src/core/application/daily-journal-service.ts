import { PlannerError } from '../domain/errors.js';
import type { DailyEntry, DailyEntryInput } from '../domain/model.js';
import { dailyEntryInputSchema, idSchema, localDateSchema, parseInput, revisionSchema } from '../domain/schema.js';
import type { Clock, IdGenerator } from '../ports/clock.js';
import type { StoreRepository } from '../ports/store-repository.js';

/** Daily notes share the atomic store, but do not change scheduled tasks or completion counts. */
export class DailyJournalService {
  constructor(private readonly repository: StoreRepository, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  async list(date: string): Promise<DailyEntry[]> {
    const day = parseInput(localDateSchema, date);
    return (await this.repository.read()).dailyEntries.filter((entry) => entry.date === day && !entry.deletedAt);
  }

  async create(input: DailyEntryInput): Promise<DailyEntry> {
    const fields = parseInput(dailyEntryInputSchema, input);
    return this.repository.transact((draft) => {
      const id = parseInput(idSchema, this.ids.next());
      if (draft.dailyEntries.some((entry) => entry.id === id)) throw new PlannerError('INVALID_STATE', '记录 ID 冲突，请重试。');
      const now = this.clock.now().toISOString();
      const entry: DailyEntry = { ...fields, id, revision: 1, createdAt: now, updatedAt: now, deletedAt: null };
      draft.dailyEntries.push(entry);
      return { value: entry, changed: true };
    });
  }

  async update(id: string, input: DailyEntryInput, revision: number): Promise<DailyEntry> {
    const fields = parseInput(dailyEntryInputSchema, input);
    return this.mutate(id, revision, (entry) => {
      if (entry.content === fields.content && entry.date === fields.date && entry.effort === fields.effort) return false;
      Object.assign(entry, fields);
      return true;
    });
  }

  async remove(id: string, revision: number): Promise<DailyEntry> {
    return this.mutate(id, revision, (entry) => { entry.deletedAt = this.clock.now().toISOString(); return true; });
  }

  private async mutate(id: string, revision: number, operation: (entry: DailyEntry) => boolean): Promise<DailyEntry> {
    const validId = parseInput(idSchema, id);
    const expected = parseInput(revisionSchema, revision);
    return this.repository.transact((draft) => {
      const entry = draft.dailyEntries.find((item) => item.id === validId && !item.deletedAt);
      if (!entry) throw new PlannerError('NOT_FOUND', '没有找到这条日结记录。');
      if (entry.revision !== expected) throw new PlannerError('CONFLICT', '记录已变化，请重新打开后编辑。');
      const changed = operation(entry);
      if (changed) { entry.revision++; entry.updatedAt = this.clock.now().toISOString(); }
      return { value: entry, changed };
    });
  }
}
