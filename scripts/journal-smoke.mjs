import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';
import { MemoryStore, PlannerService, SystemClock, RandomIdGenerator } from '../dist/src/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.local', 'journal-test'), { recursive: true });
const profile = await mkdtemp(join(root, '.local', 'journal-test', 'run-'));
await mkdir(join(profile, 'planner'));
const file = join(profile, 'planner', 'state.json');
const repository = new MemoryStore();
const service = new PlannerService(repository, new SystemClock(), new RandomIdGenerator());
const task = await service.createTask({ title: '长期目标：论文阅读', importance: 'high', urgency: 'low', dueAt: '2027-01-01T00:00:00Z' });
await service.completeTask(task.id, task.revision);
const { dailyEntries, ...old } = await repository.read();
await writeFile(file, JSON.stringify({ ...old, schemaVersion: 1 }));
const note = '读完论文方法部分，整理了三个问题。\n补充实验的思路还需要明天继续。';
let entryId;
async function run(action) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: electronPath, args: ['.', `--data-dir=${profile}`], cwd: root, env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.locator('[data-testid="task-row"]').waitFor();
    await action(page);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await app.close(); }
}
async function save(page) {
  await page.locator('#journal-save').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
}
await run(async (page) => {
  await page.locator('#tab-journal').click();
  await page.locator('#journal-date').fill('2026-11-09');
  await page.locator('#journal-empty').waitFor();
  await page.locator('#new-task').click();
  assert.equal(await page.locator('#journal-entry-date').inputValue(), '2026-11-09');
  assert.equal(await page.locator('#task-due').isVisible(), false);
  await page.locator('#journal-content').fill(note);
  await page.locator('label:has(input[name="effort"][value="medium"])').click();
  await page.locator('#new-task').click();
  await page.locator('#tab-planner').click();
  await page.locator('#new-task').click();
  assert.equal(await page.locator('#task-title').inputValue(), '');
  await page.keyboard.press('Escape');
  await page.locator('#tab-journal').click();
  await page.locator('#new-task').click();
  assert.equal(await page.locator('#journal-content').inputValue(), note);
  await page.screenshot({ path: join(root, '.local', 'journal-editor-preview.png') });
  await save(page);
  const row = page.locator('.journal-row');
  await row.waitFor();
  entryId = await row.getAttribute('data-entry-id');
  assert.equal(await row.locator('.effort-tag').innerText(), '中');
  assert.equal(await row.locator('.tag, time, .check-button').count(), 0);
  await page.locator('#journal-prev').click();
  await page.locator('#journal-empty').waitFor();
  assert.equal(await page.locator('#journal-date').inputValue(), '2026-11-08');
  await page.locator('#journal-next').click();
  await row.waitFor();
  await row.locator('button').click();
  await page.locator('#journal-entry-date').fill('2026-11-08');
  await page.locator('label:has(input[name="effort"][value="high"])').click();
  await save(page);
  await page.locator('.effort-tag[data-effort="high"]').waitFor();
  assert.equal(await page.locator('#journal-date').inputValue(), '2026-11-08');
  await page.locator('#new-task').click();
  await page.locator('#journal-content').fill('修正了一个小问题');
  await save(page);
  await page.locator('.journal-row').nth(1).waitFor();
  assert.equal(await page.locator('.journal-row').nth(1).locator('.effort-tag').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(root, '.local', 'journal-preview.png') });
});
const saved = JSON.parse(await readFile(file, 'utf8'));
assert.equal(saved.schemaVersion, 2);
assert.deepEqual(saved.tasks, old.tasks);
assert.deepEqual(saved.activities, old.activities);
assert.equal(saved.dailyEntries.length, 2);
await run(async (page) => {
  await page.locator('#tab-journal').click();
  await page.locator('#journal-date').fill('2026-11-08');
  const row = page.locator(`[data-entry-id="${entryId}"]`);
  await row.waitFor();
  assert.equal(await row.locator('.journal-content').innerText(), note);
  await row.locator('button').click();
  await page.locator('#journal-delete').click();
  await page.locator('#journal-keep').click();
  await page.locator('#journal-delete').click();
  await page.locator('#journal-confirm-delete').click();
  await row.waitFor({ state: 'detached' });
  await page.locator('#journal-next').click();
  await page.locator('#journal-empty').waitFor();
});
console.log('日结验证通过：旧数据升级、补记日期、草稿隔离、投入可选、改期、删除及重启读取。');
console.log(`测试目录 ${profile}`);
