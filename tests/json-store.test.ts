import { mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import writeFileAtomic from 'write-file-atomic';
import { createEmptyStore } from '../src/core/domain/schema.js';
import { JsonStore } from '../src/infrastructure/persistence/json-store.js';
import type { JsonStoreOptions } from '../src/infrastructure/persistence/json-store.js';

describe('JsonStore', () => {
  let directory: string;
  let filePath: string;
  let stores: JsonStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'desktop-planner-store-'));
    filePath = join(directory, 'state.json');
    stores = [];
  });

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('desktop-planner-store-')) {
      throw new Error('Refusing to remove a path outside the test temporary directory');
    }
    await rm(target, { recursive: true, force: true });
  });

  async function openStore(options?: JsonStoreOptions): Promise<JsonStore> {
    const store = await JsonStore.open(filePath, options);
    stores.push(store);
    return store;
  }

  async function readDisk(path = filePath): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  }

  it('initializes a new store and reloads committed changes', async () => {
    const store = await openStore({ timeZone: 'Asia/Shanghai' });
    expect(store.recovery).toBeNull();
    expect(await store.read()).toEqual(createEmptyStore('Asia/Shanghai'));

    await store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: draft.settings, changed: true };
    });
    expect(await readDisk(`${filePath}.bak`)).toEqual(createEmptyStore('Asia/Shanghai'));
    await store.close();

    const reopened = await openStore();
    expect(await reopened.read()).toMatchObject({ revision: 1, settings: { historyTimeZone: 'UTC' } });
  });

  it('serializes the whole read-modify-write transaction for concurrent commands', async () => {
    const store = await openStore();
    const revisions = await Promise.all(Array.from({ length: 12 }, (_, index) => store.transact((draft) => {
      const previousRevision = draft.revision;
      draft.settings.historyTimeZone = index % 2 === 0 ? 'UTC' : 'Asia/Shanghai';
      return { value: previousRevision, changed: true };
    })));

    expect(revisions).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(await store.read()).toMatchObject({ revision: 12, settings: { historyTimeZone: 'Asia/Shanghai' } });
    expect(await readDisk()).toMatchObject({ revision: 12 });
    expect(await readDisk(`${filePath}.bak`)).toMatchObject({ revision: 11 });
  });

  it('isolates reads, callback drafts, and returned values from committed state', async () => {
    const store = await openStore();
    const original = await store.read();
    original.settings.historyTimeZone = 'UTC';
    expect((await store.read()).settings.historyTimeZone).toBe('Asia/Shanghai');

    let retainedDraft: Awaited<ReturnType<JsonStore['read']>> | undefined;
    const result = await store.transact((draft) => {
      retainedDraft = draft;
      draft.settings.historyTimeZone = 'UTC';
      return { value: draft.settings, changed: true };
    });
    result.historyTimeZone = 'Europe/London';
    if (retainedDraft !== undefined) retainedDraft.settings.historyTimeZone = 'Asia/Tokyo';
    expect((await store.read()).settings.historyTimeZone).toBe('UTC');
    expect(await readDisk()).toMatchObject({ settings: { historyTimeZone: 'UTC' } });
  });

  it('discards a changed draft when the operation reports no change', async () => {
    const writes = vi.fn(async (path: string, data: string) => {
      await writeFileAtomic(path, data, { fsync: true });
    });
    const store = await openStore({ atomicWrite: writes });
    writes.mockClear();

    const result = await store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: draft.settings, changed: false };
    });
    result.historyTimeZone = 'Europe/London';
    expect(writes).not.toHaveBeenCalled();
    expect(await store.read()).toEqual(createEmptyStore());
  });

  it.each(['backup', 'main'] as const)('preserves committed state on a failed %s write and permits retry', async (stage) => {
    let failNextWrite = false;
    const store = await openStore({
      atomicWrite: async (path, data) => {
        const isTarget = stage === 'backup' ? path.endsWith('.bak') : !path.endsWith('.bak');
        if (failNextWrite && isTarget) {
          failNextWrite = false;
          throw new Error('injected disk error');
        }
        await writeFileAtomic(path, data, { fsync: true });
      },
    });
    const before = await store.read();
    failNextWrite = true;

    await expect(store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: undefined, changed: true };
    })).rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED' });
    expect(await store.read()).toEqual(before);
    expect(await readDisk()).toEqual(before);

    await store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: undefined, changed: true };
    });
    expect(await store.read()).toMatchObject({ revision: 1, settings: { historyTimeZone: 'UTC' } });
  });

  it('does not persist an invalid transaction or let its failure poison the queue', async () => {
    const store = await openStore();
    const before = await readFile(filePath, 'utf8');
    await expect(store.transact((draft) => {
      draft.settings.historyTimeZone = 'not-a-time-zone';
      return { value: undefined, changed: true };
    })).rejects.toBeDefined();
    expect(await readFile(filePath, 'utf8')).toBe(before);
    expect((await store.read()).revision).toBe(0);
  });

  it('restores a corrupt main file from its prior valid backup and preserves corrupt bytes', async () => {
    const store = await openStore();
    await store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: undefined, changed: true };
    });
    await store.close();
    const corruption = '{"tasks": broken json';
    await writeFile(filePath, corruption);

    const recovered = await openStore();
    expect(recovered.recovery).toMatchObject({ revision: 0, backupPath: `${filePath}.bak` });
    expect(await recovered.read()).toEqual(createEmptyStore());
    expect(await readDisk()).toEqual(createEmptyStore());
    const corruptFiles = (await readdir(directory)).filter((name) => name.startsWith('state.json.corrupt-'));
    expect(corruptFiles).toHaveLength(1);
    expect(await readFile(join(directory, corruptFiles[0]!), 'utf8')).toBe(corruption);
  });

  it('recovers a missing main file from a backup instead of creating an empty store', async () => {
    const previous = createEmptyStore('UTC');
    previous.revision = 7;
    await writeFile(`${filePath}.bak`, JSON.stringify(previous));

    const store = await openStore();
    expect(store.recovery).toMatchObject({ revision: 7, reason: '主数据文件缺失' });
    expect(await store.read()).toEqual(previous);
    expect(await readDisk()).toEqual(previous);
  });

  it('refuses corrupt data without a valid backup and releases the failed-open lock', async () => {
    await writeFile(filePath, 'broken main');
    await writeFile(`${filePath}.bak`, 'broken backup');
    await expect(openStore()).rejects.toMatchObject({ code: 'DATA_CORRUPTED' });
    expect(await readFile(filePath, 'utf8')).toBe('broken main');
    expect(await readFile(`${filePath}.bak`, 'utf8')).toBe('broken backup');
    expect((await readdir(directory)).filter((name) => name.includes('.corrupt-'))).toHaveLength(2);
    expect(await readdir(directory)).not.toContain('state.json.lock');
  });

  it('never replaces an unknown main schema with an older backup', async () => {
    const future = JSON.stringify({ ...createEmptyStore(), schemaVersion: 999 });
    const backup = JSON.stringify(createEmptyStore());
    await writeFile(filePath, future);
    await writeFile(`${filePath}.bak`, backup);

    await expect(openStore()).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA_VERSION' });
    expect(await readFile(filePath, 'utf8')).toBe(future);
    expect(await readFile(`${filePath}.bak`, 'utf8')).toBe(backup);
    expect(await readdir(directory)).not.toContain('state.json.lock');
  });

  it('does not initialize over an unknown schema in the only available backup', async () => {
    const future = JSON.stringify({ ...createEmptyStore(), schemaVersion: 999 });
    await writeFile(`${filePath}.bak`, future);
    await expect(openStore()).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA_VERSION' });
    expect(await readFile(`${filePath}.bak`, 'utf8')).toBe(future);
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not silently initialize when preserved corrupt data is the only remaining evidence', async () => {
    const preservedPath = `${filePath}.corrupt-previous-run`;
    await writeFile(preservedPath, 'previous data requiring manual recovery');
    await expect(openStore()).rejects.toMatchObject({ code: 'DATA_CORRUPTED' });
    expect(await readFile(preservedPath, 'utf8')).toBe('previous data requiring manual recovery');
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(directory)).not.toContain('state.json.lock');
  });

  it('rejects a second writer until the first store has closed', async () => {
    const first = await openStore();
    await expect(openStore()).rejects.toMatchObject({ code: 'STORE_IN_USE' });
    await first.close();
    const second = await openStore();
    expect(await second.read()).toEqual(createEmptyStore());
  });

  it.skipIf(process.platform === 'win32')('fails closed for a pre-existing lock on platforms without OS locking', async () => {
    const contents = JSON.stringify({ pid: 999999999, token: 'old-owner' });
    await writeFile(`${filePath}.lock`, contents);
    await expect(openStore()).rejects.toMatchObject({ code: 'STORE_IN_USE' });
    expect(await readFile(`${filePath}.lock`, 'utf8')).toBe(contents);
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases the lock when initialization fails so opening can be retried', async () => {
    await expect(openStore({ atomicWrite: async () => { throw new Error('disk full'); } }))
      .rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED' });
    expect(await readdir(directory)).not.toContain('state.json.lock');
    expect(await (await openStore()).read()).toEqual(createEmptyStore());
  });

  it('waits for queued commits before close and rejects new work as soon as closing begins', async () => {
    let pauseMainWrite = false;
    let unblock: (() => void) | undefined;
    const store = await openStore({ atomicWrite: async (path, data) => {
      if (pauseMainWrite && !path.endsWith('.bak')) {
        await new Promise<void>((resolve) => { unblock = resolve; });
      }
      await writeFileAtomic(path, data, { fsync: true });
    } });
    pauseMainWrite = true;
    const transaction = store.transact((draft) => {
      draft.settings.historyTimeZone = 'UTC';
      return { value: 'committed', changed: true };
    });
    const closing = store.close();
    await expect(store.read()).rejects.toMatchObject({ code: 'STORE_CLOSED' });
    await expect(store.transact(() => ({ value: undefined, changed: false })))
      .rejects.toMatchObject({ code: 'STORE_CLOSED' });
    await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));
    await expect(openStore()).rejects.toMatchObject({ code: 'STORE_IN_USE' });
    unblock!();
    expect(await transaction).toBe('committed');
    await closing;
    await store.close();
    expect(await readDisk()).toMatchObject({ revision: 1, settings: { historyTimeZone: 'UTC' } });
    expect(await readdir(directory)).not.toContain('state.json.lock');
  });

  it.skipIf(process.platform === 'win32')('does not delete an externally replaced lock during close', async () => {
    const store = await openStore();
    await writeFile(`${filePath}.lock`, 'different owner');
    await expect(store.close()).rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED' });
    expect(await readFile(`${filePath}.lock`, 'utf8')).toBe('different owner');
    await unlink(`${filePath}.lock`);
  });

  it.runIf(process.platform === 'win32')('recovers an unheld legacy lock without changing committed data', async () => {
    const previous = createEmptyStore('UTC');
    await writeFile(filePath, JSON.stringify(previous));
    // A reused/live PID must not prevent recovery when no process actually holds the file.
    await writeFile(filePath + '.lock', JSON.stringify({ pid: process.pid, token: 'legacy-lock' }));
    const store = await openStore();
    expect(await store.read()).toEqual(previous);
    expect(await readDisk()).toEqual(previous);
  });

  it.runIf(process.platform === 'win32')('protects a lock still held by a pre-upgrade writer', async () => {
    const handle = await open(filePath + '.lock', 'wx');
    try {
      await handle.writeFile('old writer');
      await expect(openStore()).rejects.toMatchObject({ code: 'STORE_IN_USE' });
      expect(await readFile(filePath + '.lock', 'utf8')).toBe('old writer');
    } finally {
      await handle.close();
    }
    expect(await (await openStore()).read()).toEqual(createEmptyStore());
  });

  it.runIf(process.platform === 'win32')('allows only one concurrent opener to reclaim a legacy lock', async () => {
    await writeFile(filePath + '.lock', '{}');
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => openStore()));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') expect(attempt.reason).toMatchObject({ code: 'STORE_IN_USE' });
    }
  });

  it.runIf(process.platform === 'win32')('prevents external replacement and deletion of an active lock', async () => {
    const store = await openStore();
    const original = await readFile(filePath + '.lock', 'utf8');
    await expect(writeFile(filePath + '.lock', 'different owner')).rejects.toBeDefined();
    await expect(unlink(filePath + '.lock')).rejects.toBeDefined();
    expect(await readFile(filePath + '.lock', 'utf8')).toBe(original);
    await store.close();
    expect(await readdir(directory)).not.toContain('state.json.lock');
  });
});
