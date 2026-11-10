import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, screen, Tray } from 'electron/main';
import type { Rectangle } from 'electron/main';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsonStore, PlannerError, PlannerService, RandomIdGenerator, SystemClock, toLocalDate } from '../index.js';
import type { TaskView } from '../index.js';
import type { DesktopApi, DesktopWindowState } from './api.js';
import { seedDemo } from './demo-data.js';
import { createGlassSwitch } from './window-glass.js';
import { DailyJournalService } from '../core/application/daily-journal-service.js';

const demo = process.argv.includes('--demo');
const rendererPath = join(import.meta.dirname, '../renderer/index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
const expandedSize = { width: 370, height: 480 };
let store: JsonStore | undefined;
let quitting = false;
let exitReady = false;
let startPromise: Promise<void>;
let reveal: (() => void) | undefined;
let dispose: (() => void) | undefined;

function prepareProfile(): void {
  const flag = process.argv.find((arg) => arg.startsWith('--data-dir='));
  const specified = flag?.slice('--data-dir='.length);
  if (specified !== undefined && !isAbsolute(specified)) {
    throw new Error('--data-dir 必须是绝对路径。');
  }
  // A portable launcher extracts the runtime temporarily. Keep user data beside the original EXE.
  const baseDirectory = app.isPackaged
    ? (process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe')))
    : app.getAppPath();
  let profile = specified ?? join(baseDirectory, 'data');
  if (demo && specified === undefined) {
    const demos = join(baseDirectory, '.local', 'desktop-demo');
    mkdirSync(demos, { recursive: true });
    profile = mkdtempSync(join(demos, 'run-'));
  }
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}

function fit(bounds: Rectangle, area: Rectangle, snap: boolean): Rectangle {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const right = area.x + area.width - width;
  let x = Math.max(area.x, Math.min(bounds.x, right));
  if (snap && x - area.x <= 20) x = area.x;
  else if (snap && right - x <= 20) x = right;
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height));
  return { x, y, width, height };
}

function changeBounds(win: BrowserWindow, bounds: Rectangle): void {
  const old = win.getBounds();
  if (old.x !== bounds.x || old.y !== bounds.y || old.width !== bounds.width || old.height !== bounds.height) {
    win.setBounds(bounds);
  }
}

function bindApi(win: BrowserWindow, api: Omit<DesktopApi, 'onChange'>): void {
  for (const name of Object.keys(api) as (keyof typeof api)[]) {
    const action = api[name];
    ipcMain.handle('planner:' + name, async (event, ...args: unknown[]) => {
      const frame = event.senderFrame;
      if (quitting || win.isDestroyed() || event.sender !== win.webContents || !frame
        || frame !== win.webContents.mainFrame || frame.url !== rendererUrl) {
        return { ok: false, message: '当前窗口无权执行此操作。' };
      }
      if (args.length !== action.length) return { ok: false, message: '调用参数数量有误。' };
      try {
        // Zod 校验业务方法的全部外部输入；两个窗口开关在各自入口校验布尔值。
        const handler: (...values: never[]) => Promise<unknown> = action;
        return { ok: true, value: await handler(...args as never[]) };
      } catch (error) {
        if (error instanceof PlannerError) return { ok: false, message: error.message };
        console.error(error);
        return { ok: false, message: '操作失败，请重试。' };
      }
    });
  }
}

async function start(): Promise<void> {
  store = await JsonStore.open(join(app.getPath('userData'), 'planner', 'state.json'));
  if (demo) await seedDemo(store);
  const { settings } = await store.read();
  const timeZone = settings.historyTimeZone;
  const service = new PlannerService(store, new SystemClock(), new RandomIdGenerator());
  const journal = new DailyJournalService(store, new SystemClock(), new RandomIdGenerator());
  const deadlines = new Map<string, number>();
  for (const task of await service.listTasks({ status: 'open' })) {
    deadlines.set(task.id, Date.parse(task.dueAt));
  }
  if (quitting) return;

  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    ...fit({ x: area.x + area.width - expandedSize.width - 12, y: area.y + 36, ...expandedSize }, area, false),
    title: '时笺', icon: join(import.meta.dirname, 'tray.png'), frame: false,
    show: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true,
    transparent: true, backgroundColor: '#00000000', roundedCorners: false, hasShadow: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  const setGlass = await createGlassSwitch(win);
  setGlass?.(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  let collapsed = false;
  let expandedPinned = win.isAlwaysOnTop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastTime = Date.now();
  let lastDay = toLocalDate(new Date(lastTime), timeZone);

  function notify(): void {
    if (!quitting && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('planner:changed');
    }
  }

  // 每个整分钟校准系统时钟，跨日时刷新事件日期。
  function refresh(force: boolean): void {
    clearTimeout(timer);
    if (quitting) return;
    const now = Date.now();
    const day = toLocalDate(new Date(now), timeZone);
    let changed = force || day !== lastDay;
    let delay = 60_000 - now % 60_000;
    for (const due of deadlines.values()) {
      if ((due <= now) !== (due <= lastTime)) changed = true;
      if (due > now) delay = Math.min(delay, due - now);
    }
    lastTime = now;
    lastDay = day;
    if (changed) notify();
    timer = setTimeout(() => refresh(false), delay);
  }

  async function changed(result: Promise<TaskView>): Promise<TaskView> {
    const task = await result;
    if (!task.deletedAt && task.status === 'open') deadlines.set(task.id, Date.parse(task.dueAt));
    else deadlines.delete(task.id);
    if (collapsed) resizeWidget();
    refresh(true);
    return task;
  }

  function state(): DesktopWindowState {
    return { collapsed, pinned: win.isAlwaysOnTop(), demo, today: toLocalDate(new Date(), timeZone), timeZone };
  }
  function resizeWidget(): void {
    const old = win.getBounds();
    const workArea = screen.getDisplayMatching(old).workArea;
    // The compact header is 22 DIP with 2 DIP vertical padding and 20 DIP per title.
    const size = collapsed ? { width: deadlines.size ? 164 : 74, height: 26 + 20 * Math.min(3, deadlines.size) } : expandedSize;
    const atRight = old.x + old.width / 2 >= workArea.x + workArea.width / 2;
    const x = atRight ? old.x + old.width - size.width : old.x;
    changeBounds(win, fit({ x, y: old.y, ...size }, workArea, false));
  }
  bindApi(win, {
    journalList: (date) => journal.list(date),
    journalCreate: async (input) => { const entry = await journal.create(input); notify(); return entry; },
    journalUpdate: async (id, input, revision) => { const entry = await journal.update(id, input, revision); notify(); return entry; },
    journalRemove: async (id, revision) => { const entry = await journal.remove(id, revision); notify(); return entry; },
    list: () => service.listTasks(),
    reorder: async (ids) => { await service.reorderTasks(ids); notify(); },
    create: (input) => changed(service.createTask(input)),
    update: (id, patch, revision) => changed(service.updateTask(id, patch, revision)),
    complete: (id, revision) => changed(service.completeTask(id, revision)),
    reopen: (id, revision) => changed(service.reopenTask(id, revision)),
    remove: (id, revision) => changed(service.deleteTask(id, revision)),
    days: () => service.listHistoryDays(),
    day: (date) => service.getDay(date),
    windowState: async () => state(),
    setCollapsed: async (value) => {
      if (typeof value !== 'boolean') throw new PlannerError('VALIDATION_ERROR', '折叠状态无效。');
      if (value === collapsed) return state();
      collapsed = value;
      setGlass?.(!collapsed);
      win.setAlwaysOnTop(collapsed || expandedPinned, collapsed ? 'screen-saver' : 'floating');
      resizeWidget();
      return state();
    },
    setPinned: async (value) => {
      if (typeof value !== 'boolean') throw new PlannerError('VALIDATION_ERROR', '置顶状态无效。');
      expandedPinned = value;
      if (!collapsed) win.setAlwaysOnTop(value);
      return state();
    },
    hide: async () => { win.hide(); },
  });
  function snapToEdge(): void {
    const bounds = win.getBounds();
    changeBounds(win, fit(bounds, screen.getDisplayMatching(bounds).workArea, true));
  }
  if (process.platform === 'win32') {
    // Keep the native move loop free of blur recomposition and position corrections.
    win.hookWindowMessage(0x0231, () => { if (!collapsed) setGlass?.(false); }); // WM_ENTERSIZEMOVE
    win.hookWindowMessage(0x0232, () => { // WM_EXITSIZEMOVE
      snapToEdge();
      if (!collapsed) setGlass?.(true);
    });
  } else {
    win.on('moved', snapToEdge);
  }
  screen.on('display-metrics-changed', resizeWidget);
  screen.on('display-removed', resizeWidget);
  screen.on('display-added', resizeWidget);
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  const showWidget = () => {
    if (quitting || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    resizeWidget();
    win.show();
    win.focus();
  };
  reveal = showWidget;
  const resume = () => refresh(true);
  powerMonitor.on('resume', resume);
  powerMonitor.on('unlock-screen', resume);
  win.on('show', resume);
  const tray = new Tray(join(import.meta.dirname, 'tray.png'));
  tray.setToolTip(demo ? '时笺 · 演示' : '时笺');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示时笺', click: showWidget },
    { label: '隐藏窗口', click: () => win.hide() },
    { type: 'separator' },
    { label: '退出时笺', click: () => app.quit() },
  ]));
  tray.on('click', showWidget);
  dispose = () => {
    clearTimeout(timer);
    screen.off('display-metrics-changed', resizeWidget);
    screen.off('display-removed', resizeWidget);
    screen.off('display-added', resizeWidget);
    powerMonitor.off('resume', resume);
    powerMonitor.off('unlock-screen', resume);
    tray.destroy();
  };
  win.once('ready-to-show', () => { if (!quitting) win.showInactive(); });
  await win.loadFile(rendererPath);
  refresh(false);
  if (store.recovery && !quitting) {
    void dialog.showMessageBox(win, {
      type: 'info', title: '时笺', message: '已从备份恢复日程',
      detail: store.recovery.reason + '。已恢复到版本 ' + store.recovery.revision + '。',
    });
  }
}

function launch(): void {
  prepareProfile();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => reveal?.());
  app.on('activate', () => reveal?.());
  app.on('before-quit', (event) => {
    if (exitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      await startPromise.catch(() => undefined);
      dispose?.();
      await store?.close();
    })().catch((error: unknown) => {
      dialog.showErrorBox('时笺 · 退出失败', error instanceof Error ? error.message : String(error));
    }).finally(() => {
      exitReady = true;
      app.quit();
    });
  });
  startPromise = app.whenReady().then(start);
  void startPromise.catch((error: unknown) => {
    dialog.showErrorBox('时笺 · 启动失败', error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

try {
  launch();
} catch (error) {
  dialog.showErrorBox('时笺 · 启动失败', error instanceof Error ? error.message : String(error));
  app.exit(1);
}
