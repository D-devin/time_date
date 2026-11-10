import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { PlannerError } from '../../core/domain/errors.js';
import type { Store } from '../../core/domain/model.js';
import { createEmptyStore, parseStore } from '../../core/domain/schema.js';
import type { StoreRepository } from '../../core/ports/store-repository.js';

export interface JsonStoreOptions {
  timeZone?: string;
  atomicWrite?: (path: string, data: string) => Promise<void>;
}

export interface StoreRecovery {
  revision: number;
  backupPath: string;
  reason: string;
}

type Candidate =
  | { kind: 'valid'; store: Store }
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string };

interface StoreLock {
  release(): Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function storageError(message: string, cause: unknown): PlannerError {
  return new PlannerError('STORAGE_WRITE_FAILED', message, { cause });
}

function serialize(store: Store): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

async function readCandidate(path: string): Promise<Candidate> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { kind: 'missing' };
    throw storageError(`无法读取数据文件：${path}`, error);
  }

  try {
    const raw: unknown = JSON.parse(contents);
    return { kind: 'valid', store: parseStore(raw) };
  } catch (error) {
    // 新版本数据不能被旧程序当作损坏数据，用旧备份覆盖。
    if (hasCode(error, 'UNSUPPORTED_SCHEMA_VERSION')) throw error;
    return {
      kind: 'corrupt',
      reason: error instanceof Error ? error.message : '数据格式无效',
    };
  }
}

async function preserveCorrupt(path: string): Promise<void> {
  const target = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
  try {
    await copyFile(path, target, constants.COPYFILE_EXCL);
  } catch (error) {
    throw storageError('无法保留损坏文件，已停止恢复以免覆盖原始数据', error);
  }
}

async function acquireLock(path: string): Promise<StoreLock> {
  const contents = JSON.stringify({ token: randomUUID(), pid: process.pid, openedAt: new Date().toISOString() });
  if (process.platform === 'win32') {
    const { acquireWindowsStoreLock } = await import('./windows-store-lock.js');
    return acquireWindowsStoreLock(path, contents);
  }
  let handle: FileHandle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new PlannerError(
        'STORE_IN_USE',
        '数据仓库已有写入锁。若上次异常退出，请确认没有运行实例后再移除 .lock 文件。',
        { cause: error },
      );
    }
    throw storageError('无法创建数据仓库写入锁', error);
  }

  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    return { release: () => releaseFileLock(path, contents, handle) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw storageError('无法初始化数据仓库写入锁', error);
  }
}

async function releaseFileLock(path: string, contents: string, handle: FileHandle): Promise<void> {
  try {
    await handle.close();
    // 不删除被外部替换的锁；崩溃遗留锁也不会根据 PID 自动清理。
    const current = await readFile(path, 'utf8');
    if (current !== contents) {
      throw new Error('写入锁已被外部修改，未删除该锁');
    }
    await unlink(path);
  } catch (error) {
    throw storageError('无法释放数据仓库写入锁', error);
  }
}

/**
 * 单进程串行事务与跨进程排他锁共同保护 JSON 仓库。
 * 仅支持本地文件系统；运行中不要从其他程序编辑数据或锁文件。
 * Windows 由系统持有文件锁，崩溃时自动释放，并可接管无人持有的旧版锁。
 */
export class JsonStore implements StoreRepository {
  readonly recovery: Readonly<StoreRecovery> | null;
  private state: Store;
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly filePath: string,
    private readonly lock: StoreLock,
    private readonly atomicWrite: (path: string, data: string) => Promise<void>,
    state: Store,
    recovery: StoreRecovery | null,
  ) {
    this.state = structuredClone(state);
    this.recovery = recovery === null ? null : Object.freeze({ ...recovery });
  }

  static async open(filePath: string, options: JsonStoreOptions = {}): Promise<JsonStore> {
    const requestedPath = resolve(filePath);
    let canonicalPath: string;
    try {
      await mkdir(dirname(requestedPath), { recursive: true });
      const directory = await realpath(dirname(requestedPath));
      canonicalPath = join(directory, basename(requestedPath));
      // 已有文件的符号链接也统一到真实路径，避免同一文件出现两个写者。
      try {
        canonicalPath = await realpath(canonicalPath);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    } catch (error) {
      throw storageError('无法准备数据目录', error);
    }

    const lock = await acquireLock(`${canonicalPath}.lock`);
    const atomicWrite = options.atomicWrite ?? (async (path: string, data: string) => {
      await writeFileAtomic(path, data, { encoding: 'utf8', fsync: true });
    });

    try {
      const main = await readCandidate(canonicalPath);
      if (main.kind === 'valid') {
        return new JsonStore(canonicalPath, lock, atomicWrite, main.store, null);
      }
      if (main.kind === 'corrupt') await preserveCorrupt(canonicalPath);

      const backupPath = `${canonicalPath}.bak`;
      const backup = await readCandidate(backupPath);
      if (backup.kind === 'valid') {
        try {
          await atomicWrite(canonicalPath, serialize(backup.store));
        } catch (error) {
          throw storageError('无法从备份恢复数据文件', error);
        }
        return new JsonStore(canonicalPath, lock, atomicWrite, backup.store, {
          revision: backup.store.revision,
          backupPath,
          reason: main.kind === 'missing' ? '主数据文件缺失' : `主数据文件损坏：${main.reason}`,
        });
      }
      if (backup.kind === 'corrupt') await preserveCorrupt(backupPath);

      if (main.kind === 'missing' && backup.kind === 'missing') {
        const name = basename(canonicalPath);
        const remnants = await readdir(dirname(canonicalPath));
        if (remnants.some((entry) => entry.startsWith(`${name}.corrupt-`)
          || entry.startsWith(`${name}.bak.corrupt-`))) {
          throw new PlannerError('DATA_CORRUPTED',
            '主文件和备份缺失，但存在先前保留的损坏文件；请先恢复数据，未创建空仓库。');
        }
        const state = parseStore(createEmptyStore(options.timeZone));
        try {
          await atomicWrite(canonicalPath, serialize(state));
        } catch (error) {
          throw storageError('无法初始化数据文件', error);
        }
        return new JsonStore(canonicalPath, lock, atomicWrite, state, null);
      }

      throw new PlannerError('DATA_CORRUPTED', '主数据文件不可用，且没有有效备份；原始文件已保留。');
    } catch (error) {
      try {
        await lock.release();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], '打开数据仓库失败，且写入锁释放失败');
      }
      throw error;
    }
  }

  read(): Promise<Store> {
    return this.enqueue(async () => structuredClone(this.state));
  }

  transact<T>(operation: (draft: Store) => { value: T; changed: boolean }): Promise<T> {
    return this.enqueue(async () => {
      const draft = structuredClone(this.state);
      const result = operation(draft);
      if (!result.changed) return structuredClone(result.value);

      draft.revision = this.state.revision + 1;
      const nextState = parseStore(draft);
      // 返回值必须先能被隔离；克隆失败不能发生在磁盘已提交之后。
      const value = structuredClone(result.value);
      try {
        await this.atomicWrite(`${this.filePath}.bak`, serialize(this.state));
        await this.atomicWrite(this.filePath, serialize(nextState));
      } catch (error) {
        throw storageError('数据保存失败，未更新内存中的已提交状态', error);
      }
      this.state = structuredClone(nextState);
      return value;
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = this.queue.then(() => this.lock.release());
    return this.closePromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new PlannerError('STORE_CLOSED', '数据仓库已关闭或正在关闭'));
    }
    const pending = this.queue.then(operation);
    // 单个事务失败不能阻断后续事务或 close。
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
