import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/infrastructure/persistence/memory-store.js';

describe('MemoryStore 事务合同', () => {
  it('返回值无法隔离时拒绝整个事务，后续事务仍然可用', async () => {
    const store = new MemoryStore();
    const before = await store.read();
    await expect(store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: () => undefined, changed: true };
    })).rejects.toBeDefined();
    expect(await store.read()).toEqual(before);
    await store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: undefined, changed: true };
    });
    expect((await store.read()).settings.historyTimeZone).toBe('UTC');
    await store.close();
  });

  it('关闭等待已提交到队列的操作，新操作返回拒绝的 Promise', async () => {
    const store = new MemoryStore();
    const pending = store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: 'saved', changed: true };
    });
    const closing = store.close();
    await expect(store.transact(() => ({ value: undefined, changed: false })))
      .rejects.toMatchObject({ code: 'STORE_CLOSED' });
    expect(await pending).toBe('saved');
    await closing;
    await expect(store.read()).rejects.toMatchObject({ code: 'STORE_CLOSED' });
  });
});
