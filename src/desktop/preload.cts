import electron = require('electron');
import type { DesktopApi } from './api.js' with { 'resolution-mode': 'import' };

// 沙箱 preload 只加载 Electron 自身；页面只能调用列出的业务操作。
async function invoke<T>(command: string, ...args: unknown[]): Promise<T> {
  const reply = await electron.ipcRenderer.invoke('planner:' + command, ...args);
  if (!reply.ok) throw new Error(reply.message);
  return reply.value;
}

const api: DesktopApi = {
  journalList: (date) => invoke('journalList', date),
  journalCreate: (input) => invoke('journalCreate', input),
  journalUpdate: (id, input, revision) => invoke('journalUpdate', id, input, revision),
  journalRemove: (id, revision) => invoke('journalRemove', id, revision),
  list: () => invoke('list'),
  reorder: (ids) => invoke('reorder', ids),
  create: (input) => invoke('create', input),
  update: (id, patch, revision) => invoke('update', id, patch, revision),
  complete: (id, revision) => invoke('complete', id, revision),
  reopen: (id, revision) => invoke('reopen', id, revision),
  remove: (id, revision) => invoke('remove', id, revision),
  days: () => invoke('days'),
  day: (date) => invoke('day', date),
  windowState: () => invoke('windowState'),
  setCollapsed: (value) => invoke('setCollapsed', value),
  setPinned: (value) => invoke('setPinned', value),
  hide: () => invoke('hide'),
  onChange(callback) {
    const listener = () => callback();
    electron.ipcRenderer.on('planner:changed', listener);
    return () => { electron.ipcRenderer.removeListener('planner:changed', listener); };
  },
};

electron.contextBridge.exposeInMainWorld('planner', api);
