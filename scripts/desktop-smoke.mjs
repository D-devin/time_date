import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const packagedExecutable = process.argv[2] ? resolve(process.argv[2]) : undefined;
const runs = join(root, '.local', 'desktop-test');
await mkdir(runs, { recursive: true });
const profile = await mkdtemp(join(runs, 'run-'));
const dataFile = join(profile, 'planner', 'state.json');
const preview = join(dirname(runs), 'desktop-preview.png');
const title = '桌面测试 · 核对明日安排';
const editedTitle = '桌面测试 · 已核对明日安排';
const errors = [];
const rows = '[data-testid="task-row"]';
let taskId;
let sampleCount;
let manualOrder;

async function withWindow(run) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: packagedExecutable ?? electronPath,
    args: [...(packagedExecutable ? [] : ['.']), '--demo', `--data-dir=${profile}`], cwd: root,
    env, timeout: 30_000,
  });
  try {
    const page = await app.firstWindow({ timeout: 20_000 });
    page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.locator(rows).first().waitFor();
      await run(app, page);
    } catch (error) {
      const screenshot = join(profile, 'failure.png');
      await page.screenshot({ path: screenshot, timeout: 2_000 }).catch(() => {});
      console.error(`出错时的窗口截图路径 ${screenshot}`);
      throw error;
    }
  } finally {
    await app.close();
  }
  await assert.rejects(access(`${dataFile}.lock`), { code: 'ENOENT' });
  assert.deepEqual(errors, [], '渲染进程抛出了异常');
}

async function selectLevel(page, name, value) {
  const radio = page.locator(`input[name="${name}"][value="${value}"]`);
  await page.locator('label').filter({ has: radio }).click();
  assert.equal(await radio.isChecked(), true);
}

async function nativeWindow(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { bounds: win.getBounds(), pinned: win.isAlwaysOnTop() };
  });
}

console.log(`桌面端到端测试使用独立目录 ${profile}`);
await withWindow(async (app, page) => {
  const windowState = await page.evaluate(() => window.planner.windowState());
  assert.equal(windowState.demo, true);
  sampleCount = await page.evaluate(async () => (await window.planner.list()).length);
  assert.ok(sampleCount > 0, '演示仓库应包含样例事件');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    '主视图不能出现横向滚动条');
  const corner = page.locator('#new-task');
  const plannerTab = await page.locator('#tab-planner').boundingBox();
  const historyTab = await page.locator('#tab-history').boundingBox();
  assert.equal(await page.locator('.window-controls button:visible').count(), 3);
  assert.ok(plannerTab.x < historyTab.x && Math.abs(plannerTab.width - historyTab.width) < 1);
  assert.ok((await corner.boundingBox()).y < plannerTab.y);
  const listHeading = await page.locator('#plan-heading').boundingBox();
  assert.ok(listHeading.y - (plannerTab.y + plannerTab.height) < 35, '标签下方应直接显示清单');
  assert.equal(await page.locator('#editor').isVisible(), false);
  const firstRow = page.locator(rows).first();
  const grip = await firstRow.locator('.drag-handle').boundingBox();
  const titleBox = await firstRow.locator('.task-title').boundingBox();
  const checkBox = await firstRow.locator('.check-button').boundingBox();
  assert.ok(grip.x < titleBox.x && checkBox.x > titleBox.x + titleBox.width, '拖动柄在前、完成框在最后');
  const original = await page.evaluate(async () => (await window.planner.list()).map((task) => task.id));
  const destination = await page.locator(rows).nth(2).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 6, { steps: 3 });
  await page.locator('body.sorting').waitFor();
  // 主进程刷新不能在拖动中替换列表。
  await page.evaluate(async () => window.planner.setPinned((await window.planner.windowState()).pinned));
  await page.mouse.move(grip.x + grip.width / 2, destination.y + destination.height - 5, { steps: 20 });
  await page.waitForFunction((id) => document.querySelector('#task-list')?.children[2]?.getAttribute('data-task-id') === id, original[0]);
  await page.mouse.up();
  manualOrder = [original[1], original[2], original[0], ...original.slice(3)];
  const waitOrder = async () => page.waitForFunction(async (ids) =>
    JSON.stringify((await window.planner.list()).map((task) => task.id)) === JSON.stringify(ids), manualOrder);
  await waitOrder();
  await page.locator(rows).first().locator('.drag-handle').focus();
  await page.keyboard.press('ArrowDown');
  [manualOrder[0], manualOrder[1]] = [manualOrder[1], manualOrder[0]];
  await waitOrder();
  await page.waitForFunction(() => [...document.querySelectorAll('#task-list > li')].every((row) => !row.style.transform));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: preview, animations: 'disabled' });
  console.log(`1. 已载入 ${sampleCount} 个演示事件并保存窗口截图 ${preview}`);

  const initial = await nativeWindow(app);
  await page.locator('#toggle-pin').click();
  await page.locator(`#toggle-pin[aria-pressed="${!initial.pinned}"]`).waitFor();
  assert.equal((await nativeWindow(app)).pinned, !initial.pinned);
  await page.locator('#collapse').click();
  await page.locator('body[data-collapsed="true"] #expand').waitFor();
  const compact = await nativeWindow(app);
  assert.ok(compact.bounds.height < initial.bounds.height && compact.bounds.width < initial.bounds.width);
  assert.equal(compact.pinned, true, '折叠时应强制置顶');
  const pending = await page.evaluate(async () => (await window.planner.list()).filter((task) => task.status === 'open'));
  const titles = page.locator('#compact-titles li');
  const checkPreview = async (expected) => {
    await page.waitForFunction((names) => {
      const actual = [...document.querySelectorAll('#compact-titles li')].map((el) => el.textContent);
      return JSON.stringify(actual) === JSON.stringify(names);
    }, expected.slice(0, 3).map((task) => task.title));
  };
  await checkPreview(pending);
  assert.equal(await titles.count(), 3);
  for (const [index, task] of pending.slice(0, 3).entries()) {
    assert.equal(await titles.nth(index).evaluate((el) => getComputedStyle(el).textDecorationLine), task.shouldStrikeThrough ? 'line-through' : 'none');
  }
  assert.equal(compact.bounds.height, 86);
  await page.screenshot({ path: join(dirname(runs), 'compact-preview.png'), omitBackground: true });
  const completed = [];
  for (const [index, task] of pending.entries()) {
    completed.push(await page.evaluate((t) => window.planner.complete(t.id, t.revision), task));
    await checkPreview(pending.slice(index + 1));
  }
  const empty = await nativeWindow(app);
  assert.ok(empty.bounds.height < compact.bounds.height && empty.pinned);
  for (const task of completed) await page.evaluate((t) => window.planner.reopen(t.id, t.revision), task);
  await checkPreview(pending);
  await page.locator('#expand').click();
  await page.locator('body[data-collapsed="false"] #new-task').waitFor();
  const expanded = await nativeWindow(app);
  assert.equal(expanded.bounds.height, initial.bounds.height);
  assert.equal(expanded.pinned, !initial.pinned);
  console.log('2. 鼠标和键盘排序已保存；折叠时强制置顶，前三条待办按手动顺序显示、完成后递补。');

  const baseline = await page.evaluate(async () => {
    const { today } = await window.planner.windowState();
    return (await window.planner.day(today)).completedCount;
  });
  await page.locator('#tab-history').click();
  await corner.click();
  assert.equal(await corner.getAttribute('aria-expanded'), 'true');
  await page.locator('#task-title').fill(title);
  await selectLevel(page, 'importance', 'low');
  await selectLevel(page, 'urgency', 'high');
  const draftDue = await page.locator('#task-due').inputValue();
  await corner.click();
  assert.equal(await page.locator('#history-pane').isVisible(), true);
  assert.equal(await corner.getAttribute('aria-expanded'), 'false');
  await corner.click();
  await page.locator('#tab-planner').click();
  await corner.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#task-title').inputValue(), title);
  assert.equal(await page.locator('#task-due').inputValue(), draftDue);
  assert.equal(await page.locator('input[name="importance"][value="low"]').isChecked(), true);
  assert.equal(await page.locator('input[name="urgency"][value="high"]').isChecked(), true);
  await page.keyboard.press('Escape');
  assert.equal(await corner.evaluate((el) => document.activeElement === el), true);
  assert.equal((await page.evaluate(() => window.planner.list())).length, sampleCount);
  await corner.click();
  // 通过真实表单安排几秒后的截止点，然后让窗口保持静止，检查自动刷新。
  const deadline = await page.evaluate(() => {
    const due = new Date(Date.now() + 6_000);
    return new Date(due.getTime() - due.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  });
  await page.locator('#task-due').fill(deadline);
  await page.locator('#save-task').click();
  const namedRow = page.locator(rows).filter({ has: page.getByText(title, { exact: true }) });
  await namedRow.waitFor();
  await corner.click();
  assert.equal(await page.locator('#task-title').inputValue(), '');
  await corner.click();
  taskId = await namedRow.getAttribute('data-task-id');
  assert.ok(taskId);
  const selector = `${rows}[data-task-id="${taskId}"]`;
  const row = page.locator(selector);
  await page.locator(`${selector}[data-display-state="upcoming"]`).waitFor();
  await page.locator(`${selector}[data-display-state="expired"]`).waitFor({ timeout: 15_000 });
  const crossedOut = await row.getByText(title, { exact: true }).evaluate((node) => {
    for (let el = node; el; el = el.parentElement) {
      if (getComputedStyle(el).textDecorationLine.includes('line-through')) return true;
      if (el.dataset.testid === 'task-row') break;
    }
    return false;
  });
  assert.ok(crossedOut, '事件标题到期后应实际显示划线');
  const expired = await page.evaluate(async (id) => (await window.planner.list()).find((t) => t.id === id), taskId);
  assert.equal(expired.importance, 'low');
  assert.equal(expired.urgency, 'high');
  assert.equal(expired.status, 'open');
  assert.equal(expired.completedAt, null);
  console.log('3. 表单保存了轻 / 急标签，到期后窗口自动划线，事件仍为未完成。');

  await row.locator('[data-action="complete"]').click();
  await page.locator(`${selector}[data-display-state="completed"]`).waitFor();
  await row.locator('[data-action="edit"]').click();
  await page.locator('#task-title').fill(editedTitle);
  await page.locator('#save-task').click();
  await row.getByText(editedTitle, { exact: true }).waitFor();
  await page.locator('#tab-history').click();
  const historyRows = page.locator('[data-testid="activity-row"]');
  await historyRows.filter({ hasText: '确认完成' }).filter({ has: page.getByText(title, { exact: true }) }).waitFor();
  assert.equal(Number(await page.locator('#day-completed-count').innerText()), baseline + 1);
  await page.locator('#tab-planner').click();
  await row.locator('[data-action="reopen"]').click();
  await page.locator(`${selector}[data-display-state="expired"]`).waitFor();
  await page.locator('#tab-history').click();
  await historyRows.filter({ hasText: '确认完成 · 已撤销' }).filter({ has: page.getByText(title, { exact: true }) }).waitFor();
  assert.equal(Number(await page.locator('#day-completed-count').innerText()), baseline);
  console.log('4. 完成进入当日历史，编辑后保留原记录，撤销修正了当日完成数。');
});

const saved = JSON.parse(await readFile(dataFile, 'utf8'));
assert.equal(saved.tasks.find((task) => task.id === taskId)?.title, editedTitle);
await withWindow(async (_app, page) => {
  const row = page.locator(`${rows}[data-task-id="${taskId}"][data-display-state="expired"]`);
  await row.getByText(editedTitle, { exact: true }).waitFor();
  const tasks = await page.evaluate(() => window.planner.list());
  assert.equal(tasks.length, sampleCount + 1, '重复启动不应再次播种演示数据');
  assert.equal(tasks.find((task) => task.id === taskId)?.status, 'open');
  assert.deepEqual(tasks.map((task) => task.id), [...manualOrder, taskId]);
  console.log('5. 重启后手动顺序、事件、编辑结果和撤销状态均已从 JSON 恢复。');

  const { today, earlier } = await page.evaluate(async () => {
    const { today } = await window.planner.windowState();
    const previous = (await window.planner.days()).find((day) => day.date < today);
    return { today, earlier: previous && await window.planner.day(previous.date) };
  });
  assert.ok(earlier?.completed.length, '演示应包含前一日完成的样例');
  const historyRows = page.locator('[data-testid="activity-row"]');
  await page.locator('#tab-history').click();
  await historyRows.filter({ hasText: '撤销完成' }).filter({ has: page.getByText(editedTitle, { exact: true }) }).waitFor();
  await page.locator('#history-date').fill(earlier.date);
  await historyRows.filter({ hasText: '确认完成' }).filter({
    has: page.getByText(earlier.completed[0].taskSnapshot.title, { exact: true }),
  }).waitFor();
  assert.equal(Number(await page.locator('#day-completed-count').innerText()), earlier.completedCount);
  await page.locator('#history-date').fill(today);
  await historyRows.filter({ hasText: '撤销完成' }).filter({ has: page.getByText(editedTitle, { exact: true }) }).waitFor();
  await page.locator('#tab-planner').click();
  await row.locator('[data-action="edit"]').click();
  await page.locator('#delete-task').click();
  await page.locator('#confirm-delete').click();
  await row.waitFor({ state: 'detached' });
  await page.locator('#tab-history').click();
  await historyRows.filter({ hasText: '删除事件' }).filter({ has: page.getByText(editedTitle, { exact: true }) }).waitFor();
  await historyRows.filter({ hasText: '确认完成 · 已撤销' }).filter({ has: page.getByText(title, { exact: true }) }).waitFor();
});
console.log('6. 可按日往返查看历史；软删除后事件移出列表、操作记录保留，退出后写入锁已释放。');
