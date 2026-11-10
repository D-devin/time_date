import type { ActivityKind, DailyHistory, HistoryDay, PriorityLevel, TaskView, UpdateTaskInput } from '../core/domain/model.js';
import type { DesktopWindowState } from '../desktop/api.js';
import Sortable from './vendor/sortable.js';
import type { DailyEntry, DailyEntryInput, Effort } from '../core/domain/model.js';

const api = window.planner;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => byId<HTMLButtonElement>(id);
const editor = byId('editor');
const editorToggle = button('new-task');
const form = byId<HTMLFormElement>('task-form');
const dateInput = byId<HTMLInputElement>('history-date');
const dueInput = byId<HTMLInputElement>('task-due');
const titleInput = byId<HTMLInputElement>('task-title');
const filter = byId<HTMLSelectElement>('task-filter');
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
let pane: 'planner' | 'journal' | 'history' = 'planner';
let windowInfo: DesktopWindowState | undefined;
let tasks: TaskView[] = [];
let historyDays: HistoryDay[] = [];
let selectedDay = '';
let generation = 0;
let busy = false;
let editing: TaskView | null = null;
let draft: FormData | null = null;
let listSignature = '';
let sorting = false;
const journalForm = byId<HTMLFormElement>('journal-form');
const journalDate = byId<HTMLInputElement>('journal-date');
const journalEntryDate = byId<HTMLInputElement>('journal-entry-date');
const journalContent = byId<HTMLTextAreaElement>('journal-content');
let journalDay = '';
let journalEditing: DailyEntry | null = null;
let journalDraft: FormData | null = null;
let editorKind: 'task' | 'journal' = 'task';

function drawJournal(entries: DailyEntry[]): void {
  journalDate.value = journalDay;
  byId('journal-count').textContent = String(entries.length);
  byId('journal-empty').hidden = entries.length > 0;
  const labels: Record<Effort, string> = { high: '多', medium: '中', low: '少' };
  byId('journal-list').replaceChildren(...entries.map((entry) => {
    const row = el('li', 'journal-row');
    row.dataset.entryId = entry.id;
    const copy = el('div');
    copy.append(el('p', 'journal-content', entry.content));
    if (entry.effort) {
      const tag = el('span', 'effort-tag', labels[entry.effort]);
      tag.dataset.effort = entry.effort;
      tag.title = '投入：' + labels[entry.effort];
      copy.append(tag);
    }
    const edit = el('button', 'icon-button');
    edit.type = 'button';
    edit.setAttribute('aria-label', '编辑日结：' + entry.content);
    edit.title = '编辑日结';
    edit.append(icon('pen'));
    edit.addEventListener('click', () => openJournalEditor(entry));
    row.append(copy, edit);
    return row;
  }));
}

function openJournalEditor(entry: DailyEntry | null): void {
  if (busy || sorting || !editor.hidden) return;
  editorKind = 'journal';
  journalEditing = entry;
  form.hidden = true;
  journalForm.hidden = false;
  journalForm.reset();
  showError('journal-form-error');
  byId('journal-actions').hidden = false;
  byId('journal-delete-confirm').hidden = true;
  byId('journal-editor-heading').textContent = entry ? '编辑日结' : '新增日结';
  // A draft belongs to its chosen day; selecting another day starts a fresh note.
  const saved = journalDraft?.get('date') === journalDay ? journalDraft : null;
  journalEntryDate.value = entry?.date ?? String(saved?.get('date') ?? journalDay);
  journalContent.value = entry?.content ?? String(saved?.get('content') ?? '');
  const effort = entry ? entry.effort ?? '' : saved?.get('effort') ?? '';
  journalForm.querySelector<HTMLInputElement>('input[name="effort"][value="' + effort + '"]')!.checked = true;
  button('journal-delete').hidden = !entry;
  setEditorVisible(true);
  editor.scrollTop = 0;
  journalContent.focus();
}

function selectJournalDay(date: string): void {
  if (busy || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { journalDate.value = journalDay; return; }
  journalDay = date;
  byId('journal-scroll').scrollTop = 0;
  void refresh();
}

function stepJournalDay(offset: number): void {
  const day = new Date(journalDay + 'T12:00:00Z');
  day.setUTCDate(day.getUTCDate() + offset);
  selectJournalDay(day.toISOString().slice(0, 10));
}

const sortable = new Sortable(byId('task-list'), {
  handle: '.drag-handle',
  draggable: '.task-row',
  dataIdAttr: 'data-task-id',
  animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  forceFallback: true,
  fallbackOnBody: true,
  fallbackTolerance: 3,
  ghostClass: 'sort-placeholder',
  fallbackClass: 'sort-floating',
  scrollSensitivity: 32,
  scrollSpeed: 8,
  onStart() {
    sorting = true;
    generation++;
    filter.disabled = true;
    document.body.classList.add('sorting');
  },
  onEnd(event) {
    sorting = false;
    filter.disabled = false;
    document.body.classList.remove('sorting');
    if (event.oldIndex !== event.newIndex) void saveOrder();
    else void refresh();
  },
});

function planSignature(today: string, visible: TaskView[]): string {
  return JSON.stringify([today, visible.map((task) => [task.id, task.revision, task.displayState])]);
}

async function saveOrder(): Promise<void> {
  const ids = sortable.toArray();
  // Keep the existing DOM on success so the final swap animation can finish.
  if (windowInfo) listSignature = planSignature(windowInfo.today, ids.map((id) => tasks.find((task) => task.id === id)!));
  await change(() => api.reorder(ids));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', value?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (value !== undefined) result.textContent = value;
  return result;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showError(id: string, message = ''): void {
  const block = byId(id);
  block.textContent = message;
  block.hidden = !message;
}

function formatLocalInput(instant: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return instant.getFullYear() + '-' + pad(instant.getMonth() + 1) + '-' + pad(instant.getDate())
    + 'T' + pad(instant.getHours()) + ':' + pad(instant.getMinutes()) + ':' + pad(instant.getSeconds());
}

function drawWindow(state: DesktopWindowState): void {
  windowInfo = state;
  document.body.dataset.collapsed = String(state.collapsed);
  byId('demo-tag').hidden = !state.demo;
  const pin = button('toggle-pin');
  pin.setAttribute('aria-pressed', String(state.pinned));
  pin.title = state.pinned ? '取消置顶' : '置顶';
}

const labels: Record<TaskView['displayState'], string> = {
  upcoming: '', expired: '已到期 · 未完成', completed: '已完成', cancelled: '已取消', deleted: '已删除',
};

function taskRow(task: TaskView): HTMLLIElement {
  const row = el('li', 'task-row');
  row.dataset.testid = 'task-row';
  row.dataset.taskId = task.id;
  row.dataset.displayState = task.displayState;
  const grip = el('button', 'drag-handle');
  grip.type = 'button';
  grip.dataset.action = 'reorder';
  grip.title = '拖动排序，也可用 ↑ ↓ 调整';
  grip.setAttribute('aria-label', '调整顺序：' + task.title + '（上、下方向键）');
  grip.append(icon('grip'));
  grip.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (busy || sorting) return;
    const ids = sortable.toArray();
    const current = ids.indexOf(task.id);
    const next = current + (event.key === 'ArrowUp' ? -1 : 1);
    if (next < 0 || next >= ids.length) return;
    [ids[current], ids[next]] = [ids[next]!, ids[current]!];
    sortable.sort(ids, true);
    grip.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
    void saveOrder();
  });
  const toggle = el('button', 'check-button');
  toggle.type = 'button';
  toggle.dataset.action = task.status === 'open' ? 'complete' : 'reopen';
  const verb = task.status === 'open' ? '标记完成' : task.status === 'completed' ? '撤销完成' : '重新打开';
  toggle.title = verb;
  toggle.setAttribute('aria-label', verb + '：' + task.title);
  const check = el('span', 'check-mark');
  if (task.status === 'completed') check.append(icon('check'));
  if (task.status === 'cancelled') check.textContent = '−';
  toggle.append(check);
  toggle.addEventListener('click', () => void change(async () => {
    if (task.status === 'open') await api.complete(task.id, task.revision);
    else await api.reopen(task.id, task.revision);
  }));

  const copy = el('div', 'task-copy');
  const title = el('p', 'task-title' + (task.shouldStrikeThrough ? ' struck' : ''), task.title);
  const meta = el('div', 'task-meta');
  const tag = el('span', 'tag', (task.importance === 'high' ? '重' : '轻') + ' · ' + (task.urgency === 'high' ? '急' : '缓'));
  tag.dataset.quadrant = task.quadrant;
  tag.title = (task.importance === 'high' ? '重要' : '较轻') + ' / ' + (task.urgency === 'high' ? '紧急' : '较缓');
  const deadline = new Date(task.dueAt);
  const localDate = formatLocalInput(deadline).slice(0, 10);
  const dayLabel = localDate === formatLocalInput(new Date()).slice(0, 10) ? '今天'
    : localDate.slice(0, 4) === String(new Date().getFullYear()) ? localDate.slice(5).replace('-', '/') : localDate;
  const time = el('time');
  time.dateTime = task.dueAt;
  time.append(icon('clock'), dayLabel + ' ' + clockFormat.format(deadline));
  time.title = deadline.toLocaleString('zh-CN') + '（' + localZone + '）';
  meta.append(tag, time);
  if (labels[task.displayState]) meta.append(el('span', 'state-label', labels[task.displayState]));
  copy.append(title, meta);

  const edit = el('button', 'icon-button edit-button');
  edit.type = 'button';
  edit.dataset.action = 'edit';
  edit.title = '编辑事件';
  edit.setAttribute('aria-label', '编辑：' + task.title);
  edit.append(icon('pen'));
  edit.addEventListener('click', () => openEditor(task));
  row.append(grip, copy, edit, toggle);
  return row;
}

function drawPlan(today: string): void {
  const visible = tasks.filter((task) => filter.value === 'all' || task.status === filter.value);
  byId('task-count').textContent = String(visible.length);
  const empty = byId('plan-empty');
  empty.hidden = visible.length > 0;
  if (!visible.length) {
    empty.querySelector('strong')!.textContent = filter.value === 'all' ? '还没有日程' : '没有符合条件的事件';
    empty.querySelector('p')!.textContent = filter.value === 'all' ? '点左上角的「＋」添加第一件事。' : '可以切换筛选查看其他事件。';
  }
  // 周期刷新只替换有变化的列表，避免时钟校准打断键盘焦点。
  const signature = planSignature(today, visible);
  if (signature !== listSignature) {
    listSignature = signature;
    const active = document.activeElement instanceof HTMLButtonElement ? document.activeElement : undefined;
    const focusedId = active?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId;
    const action = active?.dataset.action;
    const rows = visible.map(taskRow);
    byId('task-list').replaceChildren(...rows);
    if (focusedId && action && editor.hidden) {
      const matching = rows.find((row) => row.dataset.taskId === focusedId);
      const selector = action === 'edit' ? '.edit-button' : action === 'reorder' ? '.drag-handle' : '.check-button';
      matching?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    }
  }
}

const activityLabels: Record<ActivityKind, string> = {
  created: '新增事件', updated: '修改事件', completed: '确认完成', reopened: '重新打开', cancelled: '取消事件', deleted: '删除事件',
};

function drawHistory(history: DailyHistory): void {
  byId('day-completed-count').textContent = String(history.completedCount);
  byId('day-activity-count').textContent = String(history.activities.length);
  dateInput.value = history.date;
  button('previous-day').disabled = !neighbor(-1);
  button('next-day').disabled = !neighbor(1);
  const rows = [...history.activities].reverse().map((activity) => {
    const row = el('li', 'history-item');
    row.dataset.testid = 'activity-row';
    const time = el('time', '', new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: activity.timeZone,
    }).format(new Date(activity.occurredAt)));
    time.dateTime = activity.occurredAt;
    const copy = el('div');
    const action = activity.relatedActivityId && activity.kind === 'reopened' ? '撤销完成' : activityLabels[activity.kind];
    copy.append(el('div', 'activity-kind', action + (activity.completionRevoked ? ' · 已撤销' : '')),
      el('div', 'history-title', activity.taskSnapshot.title));
    row.append(time, copy);
    return row;
  });
  byId('history-list').replaceChildren(...rows);
  byId('history-empty').hidden = rows.length > 0;
}

async function refresh(): Promise<void> {
  if (sorting || busy) return;
  const token = ++generation;
  try {
    const [state, latestTasks] = await Promise.all([api.windowState(), api.list()]);
    if (token !== generation || sorting || busy) return;
    drawWindow(state);
    tasks = latestTasks;
    if (state.collapsed) {
      // 沿用手动顺序，折叠预览独立于展开清单的筛选。
      const items = tasks.filter((task) => task.status === 'open').slice(0, 3).map((task) => {
        const item = el('li', task.shouldStrikeThrough ? 'struck' : '', task.title);
        item.title = task.title;
        return item;
      });
      byId('compact-titles').replaceChildren(...items);
      return;
    }
    if (pane === 'planner') {
      drawPlan(state.today);
    } else if (pane === 'journal') {
      journalDay ||= state.today;
      const entries = await api.journalList(journalDay);
      if (token !== generation || busy) return;
      drawJournal(entries);
    } else {
      selectedDay ||= state.today;
      const [days, history] = await Promise.all([api.days(), api.day(selectedDay)]);
      if (token !== generation) return;
      historyDays = days;
      drawHistory(history);
    }
  } catch (error) {
    if (token === generation) showError('error', errorText(error));
  }
}

async function change(operation: () => Promise<void>): Promise<void> {
  if (busy || sorting) return;
  busy = true;
  sortable.option('disabled', true);
  const destination = editor.hidden ? 'error' : editorKind === 'journal' ? 'journal-form-error' : 'form-error';
  showError(destination);
  for (const id of ['save-task', 'confirm-delete', 'new-task', 'journal-save', 'journal-confirm-delete']) button(id).disabled = true;
  try {
    await operation();
  } catch (error) {
    listSignature = ''; // Restore authoritative order if saving the drag failed.
    showError(destination, errorText(error));
  } finally {
    busy = false;
    for (const id of ['save-task', 'confirm-delete', 'new-task', 'journal-save', 'journal-confirm-delete']) button(id).disabled = false;
    await refresh();
    sortable.option('disabled', false);
  }
}

function switchPane(next: typeof pane): void {
  if (sorting) return;
  if (!editor.hidden) closeEditor();
  pane = next;
  const plan = next === 'planner';
  byId('plan-pane').hidden = !plan;
  byId('journal-pane').hidden = next !== 'journal';
  byId('history-pane').hidden = next !== 'history';
  button('tab-planner').setAttribute('aria-pressed', String(plan));
  button('tab-journal').setAttribute('aria-pressed', String(next === 'journal'));
  button('tab-history').setAttribute('aria-pressed', String(next === 'history'));
  if (next === 'journal') journalDay ||= windowInfo?.today ?? formatLocalInput(new Date()).slice(0, 10);
  setEditorVisible(false);
  showError('error');
  void refresh();
}

function neighbor(direction: -1 | 1): string | undefined {
  const dates = historyDays.map((day) => day.date).sort();
  if (direction === -1) return dates.filter((date) => date < selectedDay).at(-1);
  return dates.find((date) => date > selectedDay);
}

function selectDay(date: string | undefined): void {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    dateInput.value = selectedDay;
    return;
  }
  selectedDay = date;
  byId('history-scroll').scrollTop = 0;
  void refresh();
}

function deleteConfirmation(visible: boolean): void {
  byId('editor-actions').hidden = visible;
  byId('delete-confirm').hidden = !visible;
  if (visible) button('keep-task').focus();
}

function setEditorVisible(visible: boolean): void {
  editor.hidden = !visible;
  byId('view-content').hidden = visible;
  editorToggle.setAttribute('aria-expanded', String(visible));
  editor.setAttribute('aria-labelledby', editorKind === 'journal' ? 'journal-editor-heading' : 'editor-heading');
  const label = visible ? '收起编辑面板' : pane === 'journal' ? '新增日结' : '新增事件';
  editorToggle.setAttribute('aria-label', label);
  editorToggle.title = label;
}

function closeEditor(saved = false): void {
  if (editorKind === 'journal') {
    if (!journalEditing) journalDraft = saved ? null : new FormData(journalForm);
    journalEditing = null;
  } else if (!editing) draft = saved ? null : new FormData(form);
  setEditorVisible(false);
  editing = null;
}

function openEditor(task: TaskView | null): void {
  if (busy || sorting || !editor.hidden) return;
  editorKind = 'task';
  form.hidden = false;
  journalForm.hidden = true;
  editing = task;
  form.reset();
  showError('form-error');
  deleteConfirmation(false);
  byId('editor-heading').textContent = task ? '编辑事件' : '新增事件';
  titleInput.value = task?.title ?? String(draft?.get('title') ?? '');
  const dueDate = task ? new Date(task.dueAt) : new Date(Date.now() + 60 * 60_000);
  if (!task) dueDate.setSeconds(0, 0);
  dueInput.value = !task && draft ? String(draft.get('due') ?? '') : formatLocalInput(dueDate);
  for (const name of ['importance', 'urgency'] as const) {
    const value = task?.[name] ?? draft?.get(name) ?? (name === 'importance' ? 'high' : 'low');
    form.querySelector<HTMLInputElement>('input[name=' + name + '][value=' + value + ']')!.checked = true;
  }
  button('delete-task').hidden = !task;
  byId('zone-note').textContent = '本地时间 · ' + localZone;
  setEditorVisible(true);
  editor.scrollTop = 0;
  titleInput.focus();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!byId('delete-confirm').hidden || busy) return;
  void change(async () => {
    const title = titleInput.value.trim();
    if (!title) throw new Error('请填写事件标题。');
    const fields = new FormData(form);
    const importance = fields.get('importance') as PriorityLevel;
    const urgency = fields.get('urgency') as PriorityLevel;
    const instant = new Date(dueInput.value);
    if (!Number.isFinite(instant.getTime())) throw new Error('请填写有效的截止时间。');
    // 本地时间遇到夏令时跳跃会被 Date 自动进位，保存前要求选择真实存在的时刻。
    const normalized = dueInput.value.length === 16 ? dueInput.value + ':00' : dueInput.value;
    if (formatLocalInput(instant) !== normalized) throw new Error('此时刻在当前时区不存在，请选择其他时间。');
    if (editing) {
      const patch: UpdateTaskInput = { title, importance, urgency };
      if (formatLocalInput(new Date(editing.dueAt)) !== normalized) {
        patch.dueAt = instant.toISOString();
        patch.timeZone = localZone;
      }
      await api.update(editing.id, patch, editing.revision);
    } else {
      await api.create({ title, importance, urgency, dueAt: instant.toISOString(), timeZone: localZone });
      filter.value = 'all';
    }
    closeEditor(true);
    switchPane('planner');
    button('tab-planner').focus();
  });
});

button('tab-planner').addEventListener('click', () => { if (!busy) switchPane('planner'); });
button('tab-journal').addEventListener('click', () => { if (!busy) switchPane('journal'); });
button('tab-history').addEventListener('click', () => { if (!busy) switchPane('history'); });
filter.addEventListener('change', () => { if (windowInfo && !sorting) drawPlan(windowInfo.today); });
dateInput.addEventListener('change', () => selectDay(dateInput.value));
button('previous-day').addEventListener('click', () => selectDay(neighbor(-1)));
button('next-day').addEventListener('click', () => selectDay(neighbor(1)));
editorToggle.addEventListener('click', () => {
  if (editor.hidden) { if (pane === 'journal') openJournalEditor(null); else openEditor(null); }
  else closeEditor();
});
button('delete-task').addEventListener('click', () => deleteConfirmation(true));
button('keep-task').addEventListener('click', () => { deleteConfirmation(false); button('delete-task').focus(); });
button('confirm-delete').addEventListener('click', () => void change(async () => {
  if (!editing) return;
  await api.remove(editing.id, editing.revision);
  closeEditor(true);
  button('tab-planner').focus();
}));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !editor.hidden && !busy && !windowInfo?.collapsed) {
    closeEditor();
    editorToggle.focus();
  }
});
button('toggle-pin').addEventListener('click', () => void change(async () => {
  drawWindow(await api.setPinned(!windowInfo?.pinned));
}));
button('collapse').addEventListener('click', () => void change(async () => {
  drawWindow(await api.setCollapsed(true));
  button('expand').focus();
}));
button('expand').addEventListener('click', () => void change(async () => {
  drawWindow(await api.setCollapsed(false));
  button('collapse').focus();
}));
button('hide').addEventListener('click', () => void change(() => api.hide()));

const unsubscribe = api.onChange(() => void refresh());
journalDate.addEventListener('change', () => selectJournalDay(journalDate.value));
button('journal-prev').addEventListener('click', () => stepJournalDay(-1));
button('journal-next').addEventListener('click', () => stepJournalDay(1));
button('journal-today').addEventListener('click', () => selectJournalDay(windowInfo?.today ?? formatLocalInput(new Date()).slice(0, 10)));
journalForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || !byId('journal-delete-confirm').hidden) return;
  void change(async () => {
    const fields = new FormData(journalForm);
    const input: DailyEntryInput = { date: journalEntryDate.value, content: journalContent.value.trim(), effort: fields.get('effort') as Effort || null };
    if (journalEditing) await api.journalUpdate(journalEditing.id, input, journalEditing.revision);
    else await api.journalCreate(input);
    journalDay = input.date;
    closeEditor(true);
    button('tab-journal').focus();
  });
});
button('journal-delete').addEventListener('click', () => {
  byId('journal-actions').hidden = true;
  byId('journal-delete-confirm').hidden = false;
  button('journal-keep').focus();
});
button('journal-keep').addEventListener('click', () => {
  byId('journal-actions').hidden = false;
  byId('journal-delete-confirm').hidden = true;
  button('journal-delete').focus();
});
button('journal-confirm-delete').addEventListener('click', () => void change(async () => {
  if (!journalEditing) return;
  await api.journalRemove(journalEditing.id, journalEditing.revision);
  closeEditor(true);
  button('tab-journal').focus();
}));
window.addEventListener('pagehide', unsubscribe, { once: true });
void refresh();
