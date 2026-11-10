import ffi from 'koffi';
import { toNamespacedPath } from 'node:path';
import { PlannerError } from '../../core/domain/errors.js';

const kernel = ffi.load('kernel32.dll');
const createFile = kernel.func('intptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, intptr_t)');
const writeFile = kernel.func('int __stdcall WriteFile(intptr_t, const void *, uint32_t, _Out_ uint32_t *, void *)');
const truncateFile = kernel.func('int __stdcall SetEndOfFile(intptr_t)');
const flushFile = kernel.func('int __stdcall FlushFileBuffers(intptr_t)');
const closeHandle = kernel.func('int __stdcall CloseHandle(intptr_t)');
const lastError = kernel.func('uint32_t __stdcall GetLastError()');

/** Exclusive write/delete access is held by the OS and released even on process termination. */
export function acquireWindowsStoreLock(path: string, contents: string): { release(): Promise<void> } {
  // GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, OPEN_ALWAYS, FILE_FLAG_DELETE_ON_CLOSE.
  // Opening an old lock succeeds only when no writer holds it, including pre-upgrade writers.
  const handle = createFile(toNamespacedPath(path), 0xc0000000, 1, null, 4, 0x04000080, 0);
  if (handle === -1 || handle === -1n) {
    const code: number = lastError();
    if (code === 32) {
      throw new PlannerError('STORE_IN_USE', '日程数据正在被另一个运行实例使用，请先从托盘退出该实例。');
    }
    throw new PlannerError('STORAGE_WRITE_FAILED', '无法打开日程写入锁（Windows 错误 ' + code + '）。');
  }

  try {
    const bytes = Buffer.from(contents, 'utf8');
    const written = [0];
    if (!writeFile(handle, bytes, bytes.length, written, null)
      || written[0] !== bytes.length || !truncateFile(handle) || !flushFile(handle)) {
      throw new PlannerError('STORAGE_WRITE_FAILED', '无法初始化日程写入锁（Windows 错误 ' + lastError() + '）。');
    }
  } catch (error) {
    closeHandle(handle);
    throw error;
  }

  return {
    async release() {
      // DELETE_ON_CLOSE also removes the file after a crash without an unlink race.
      if (!closeHandle(handle)) {
        throw new PlannerError('STORAGE_WRITE_FAILED', '无法释放日程写入锁（Windows 错误 ' + lastError() + '）。');
      }
    },
  };
}
