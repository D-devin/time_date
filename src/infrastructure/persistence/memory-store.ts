import { PlannerError } from '../../core/domain/errors.js';
import type { Store } from '../../core/domain/model.js';
import { createEmptyStore, parseStore } from '../../core/domain/schema.js';
import type { StoreRepository, TransactionResult } from '../../core/ports/store-repository.js';

/** 供单元测试和临时演示使用；接口与 JSON 仓库一致。 */
export class MemoryStore implements StoreRepository {
  private state: Store;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(initialStore: Store = createEmptyStore()) {
    this.state = parseStore(initialStore);
  }

  async read(): Promise<Store> {
    this.ensureOpen();
    await this.tail;
    return structuredClone(this.state);
  }

  async transact<T>(operation: (draft: Store) => TransactionResult<T>): Promise<T> {
    this.ensureOpen();
    const pending = this.tail.then(() => {
      const draft = structuredClone(this.state);
      const result = operation(draft);
      const value = structuredClone(result.value);
      if (result.changed) {
        draft.revision = this.state.revision + 1;
        this.state = parseStore(draft);
      }
      return value;
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  private ensureOpen(): void {
    if (this.closed) throw new PlannerError('STORE_CLOSED', '仓库已经关闭。');
  }
}
