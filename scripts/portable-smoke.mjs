import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const runs = join(root, '.local', 'portable-test');
await mkdir(runs, { recursive: true });
const folder = await mkdtemp(join(runs, 'run-'));
const executable = join(folder, '时笺.exe');
const dataFile = join(folder, 'data', 'planner', 'state.json');
await copyFile(join(root, '时笺.exe'), executable);
await mkdir(join(folder, 'data', 'planner'), { recursive: true });
await writeFile(dataFile + '.lock', JSON.stringify({ pid: process.pid, token: 'old-unheld-lock' }));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const title = '免安装版验证 · 重新打开后保留';
let expectedOrder;
let expectedPreview;

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function endpoint(port, route) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`).catch(() => null);
    if (response?.ok) return response.json();
    await delay(100);
  }
  throw new Error('EXE 未能在 20 秒内启动调试连接。');
}

async function evaluateMain(port, expression) {
  const [target] = await endpoint(port, 'json/list');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    return await new Promise((done, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('主进程检查超时')); }, 10_000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
      })));
      socket.addEventListener('error', (error) => { clearTimeout(timeout); reject(error); });
      socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message)));
        else done(message.result.result.value);
      });
    });
  } finally {
    socket.close();
  }
}

async function withWindow(run, forceExit = false) {
  const inspectorPort = await freePort();
  const browserPort = await freePort();
  // The NSIS launcher does not forward Electron stderr. Connect to the child over loopback.
  const launcher = spawn(executable, [`--inspect=127.0.0.1:${inspectorPort}`, `--remote-debugging-port=${browserPort}`], { cwd: root, env, stdio: 'ignore' });
  const exited = new Promise((done, reject) => { launcher.once('exit', done); launcher.once('error', reject); });
  let browser;
  const errors = [];
  try {
    await endpoint(browserPort, 'json/version');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent('page');
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('#new-task').waitFor();
    const paths = await evaluateMain(inspectorPort, `(() => {
      const require = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json');
      const { app } = require('electron');
      const koffi = require(app.getAppPath() + '/node_modules/koffi');
      return { packaged: app.isPackaged, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), ffi: koffi.version };
    })()`);
    assert.equal(paths.packaged, true);
    assert.equal(resolve(paths.userData), join(folder, 'data'));
    assert.equal(resolve(paths.sessionData), join(folder, 'data'));
    assert.equal(paths.ffi, '3.3.6', '毛玻璃的本地组件应可从打包文件加载');
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    if (forceExit) {
      const pid = await evaluateMain(inspectorPort, 'process.pid');
      process.kill(pid, 'SIGKILL');
    } else await evaluateMain(inspectorPort, `(() => {
      const require = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json');
      const { app } = require('electron');
      setTimeout(() => app.quit(), 50);
      return true;
    })()`);
    await exited;
    await browser?.close();
  }
  await assert.rejects(access(dataFile + '.lock'), { code: 'ENOENT' });
}

await withWindow(async (page) => {
  assert.deepEqual(await page.evaluate(() => window.planner.list()), []);
  await page.locator('#new-task').click();
  await page.locator('#task-title').fill(title);
  await page.locator('#save-task').click();
  const row = page.locator('[data-testid="task-row"]').filter({ hasText: title });
  await row.locator('[data-action="complete"]').click();
  await page.locator('#tab-history').click();
  await page.locator('[data-testid="activity-row"]').filter({ hasText: '确认完成' }).filter({ hasText: title }).waitFor();
  await page.locator('#tab-planner').click();
  await page.evaluate(async () => {
    for (const name of ['第一条待办', '第二条待办', '第三条待办']) {
      await window.planner.create({ title: name, importance: 'low', urgency: 'low', dueAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
  });
  await page.locator('[data-testid="task-row"]').nth(3).waitFor();
  expectedOrder = await page.evaluate(async () => (await window.planner.list()).map((task) => task.id));
  [expectedOrder[2], expectedOrder[3]] = [expectedOrder[3], expectedOrder[2]];
  await page.locator('[data-testid="task-row"]').last().locator('.drag-handle').focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(async (ids) => JSON.stringify((await window.planner.list()).map((task) => task.id)) === JSON.stringify(ids), expectedOrder);
  await page.locator('#collapse').click();
  expectedPreview = ['第一条待办', '第三条待办', '第二条待办'];
  await page.waitForFunction((titles) => JSON.stringify([...document.querySelectorAll('#compact-titles li')].map((row) => row.textContent)) === JSON.stringify(titles), expectedPreview);
  await page.locator('#expand').click();
  await page.locator('#tab-journal').click();
  await page.locator('#journal-date').fill('2026-11-09');
  await page.locator('#new-task').click();
  await page.locator('#journal-content').fill('成品验证：记录每天的一小步');
  await page.locator('label:has(input[name="effort"][value="low"])').click();
  await page.locator('#journal-save').click();
  await page.locator('.journal-row').filter({ hasText: '成品验证' }).waitFor();
  await page.locator('#tab-timer').click();
  const primary = page.locator('#timer-action');
  const digits = page.locator('#timer-display');
  const setSeconds = async (seconds) => {
    await page.locator('#timer-minutes').fill('0');
    await page.locator('#timer-seconds').fill(String(seconds));
  };
  await setSeconds(4);
  await primary.click();
  await digits.filter({ hasText: '00:00:03' }).waitFor();
  await primary.click();
  await primary.filter({ hasText: '继续' }).waitFor();
  const paused = await digits.innerText();
  await page.locator('#tab-journal').click();
  await page.waitForTimeout(1200);
  await page.locator('#tab-timer').click();
  assert.equal(await digits.innerText(), paused);
  await page.locator('#timer-reset').click();
  await digits.filter({ hasText: '00:00:04' }).waitFor();
  await setSeconds(3);
  await primary.click();
  await primary.filter({ hasText: '暂停' }).waitFor();
  await primary.click();
  await primary.filter({ hasText: '继续' }).waitFor();
  const alarmOpened = page.context().waitForEvent('page', { timeout: 10_000 });
  await primary.click();
  await page.locator('#tab-journal').click();
  await page.locator('#collapse').click();
  await page.locator('#expand').waitFor();
  await page.evaluate(() => window.planner.hide());
  const alarm = await alarmOpened;
  const dismiss = alarm.locator('#dismiss-reminder');
  await dismiss.waitFor();
  assert.equal(await alarm.locator('body').innerText(), '时间到了');
  assert.equal(await page.evaluate(async () => (await window.planner.windowState()).countdown.status), 'finished');
  await Promise.all([alarm.waitForEvent('close'), dismiss.click()]);
  console.log('已验证定时页倒计时、暂停、继续、重置，以及收起并隐藏后到点弹窗和点击关闭。');
});
const saved = JSON.parse(await readFile(dataFile, 'utf8'));
assert.equal(saved.tasks[0].title, title);
assert.equal(saved.tasks[0].status, 'completed');

const checkPersisted = async (page) => {
  await page.locator('[data-display-state="completed"]').filter({ hasText: title }).waitFor();
  assert.deepEqual(await page.evaluate(async () => (await window.planner.list()).map((task) => task.id)), expectedOrder);
  await page.locator('#collapse').click();
  await page.waitForFunction((titles) => JSON.stringify([...document.querySelectorAll('#compact-titles li')].map((row) => row.textContent)) === JSON.stringify(titles), expectedPreview);
  await page.locator('#expand').click();
  await page.locator('#tab-history').click();
  await page.locator('[data-testid="activity-row"]').filter({ hasText: '确认完成' }).filter({ hasText: title }).waitFor();
  await page.locator('#tab-journal').click();
  await page.locator('#journal-date').fill('2026-11-09');
  await page.locator('.journal-row').filter({ hasText: '成品验证' }).waitFor();
  assert.equal(await page.locator('.effort-tag').innerText(), '少');
};
await withWindow(checkPersisted, true);
await withWindow(checkPersisted);
console.log('单文件 EXE 已通过直接启动、新增、完成、历史与重启验证。');
console.log('打包后的排序组件、手动顺序保存及三条缩略预览验证通过。');
console.log('日结已通过单文件 EXE 的新增、投入标记与重启读取验证。');
console.log('已确认日程与窗口缓存均使用 EXE 旁的 data 目录。');
console.log('旧版遗留锁已自动接管，强制结束后的再次启动及历史记录验证通过。');
console.log(`测试目录 ${folder}`);
