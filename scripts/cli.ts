import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  JsonStore, PlannerError, PlannerService, RandomIdGenerator, SystemClock,
} from '../src/index.js';
import type {
  ActivityKind, CreateTaskInput, PriorityLevel, TaskFilter, TaskStatus, TaskView, UpdateTaskInput,
} from '../src/index.js';

const help = `桌面日程表后端命令行

用法：npm run cli -- <命令> [参数]

  help                          查看帮助，不打开数据文件
  add --title <标题> --importance high|low --urgency high|low --due <ISO时间>
  list [--status open|completed|cancelled] [--include-deleted]
  update <完整ID> [--title <标题>] [--importance high|low] [--urgency high|low]
                  [--due <ISO时间>] [--time-zone <时区>]
  complete <完整ID>              手动确认完成
  reopen <完整ID>                撤销完成或恢复已取消事件
  cancel <完整ID>                取消未完成事件
  delete <完整ID>                软删除，保留已有历史
  history <YYYY-MM-DD>           查看该日有效完成项和活动
  days                          列出有活动的日期

通用参数：--data-file <路径>     指定数据文件
          --help / -h           查看帮助

重要性 high/low 对应重/轻，紧急性 high/low 对应急/缓。
截止时间需含时区，例如 2026-10-27T18:00:00+08:00。
add 可用 --time-zone 指定显示时区，默认 Asia/Shanghai。
到期只改变查询结果，是否完成由 complete 命令确认。
默认数据文件：.local/planner/state.json（相对于项目运行目录）
`;

const displayLabels: Record<TaskView['displayState'], string> = {
  upcoming: '未到期 · 未完成', expired: '已到期 · 未完成',
  completed: '已完成', cancelled: '已取消', deleted: '已删除',
};
const activityLabels: Record<ActivityKind, string> = {
  created: '新增', updated: '修改', completed: '确认完成',
  reopened: '重新打开', cancelled: '取消', deleted: '删除',
};

function invalid(message: string): never {
  throw new PlannerError('VALIDATION_ERROR', message);
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') invalid(`请提供 ${flag}。`);
  return value;
}

function level(value: string | undefined, flag: string): PriorityLevel | undefined {
  if (value === undefined) return undefined;
  if (value !== 'high' && value !== 'low') invalid(`${flag} 只能为 high 或 low。`);
  return value;
}

function formatTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(instant));
}

function printTask(task: TaskView): void {
  console.log(`\n${task.title}`);
  console.log(`  ID：${task.id}`);
  console.log(`  标签：${task.importance === 'high' ? '重' : '轻'} / ${task.urgency === 'high' ? '急' : '缓'}`);
  console.log(`  截止：${formatTime(task.dueAt, task.timeZone)}（${task.timeZone}）`);
  console.log(`  状态：${displayLabels[task.displayState]}；划线：${task.shouldStrikeThrough ? '是' : '否'}；版本：${task.revision}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      'data-file': { type: 'string' }, title: { type: 'string' },
      importance: { type: 'string' }, urgency: { type: 'string' },
      due: { type: 'string' }, 'time-zone': { type: 'string' },
      status: { type: 'string' }, 'include-deleted': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    console.log(help);
    return;
  }

  const commandOptions: Record<string, string[]> = {
    add: ['title', 'importance', 'urgency', 'due', 'time-zone'],
    update: ['title', 'importance', 'urgency', 'due', 'time-zone'],
    list: ['status', 'include-deleted'], complete: [], reopen: [],
    cancel: [], delete: [], history: [], days: [],
  };
  const allowed = commandOptions[command];
  if (!allowed) invalid(`未知命令 ${command}；使用 help 查看用法。`);
  for (const name of Object.keys(values)) {
    if (name !== 'data-file' && name !== 'help' && !allowed.includes(name)) {
      invalid(`${command} 不支持 --${name}。`);
    }
  }
  const takesArgument = ['update', 'complete', 'reopen', 'cancel', 'delete', 'history'].includes(command);
  if (positionals.length !== (takesArgument ? 2 : 1)) {
    invalid(takesArgument ? `${command} 需要且只需要一个 ID 或日期参数。` : `${command} 不接受额外位置参数。`);
  }
  const argument = positionals[1];
  const patch: UpdateTaskInput = {};
  if (values.title !== undefined) patch.title = values.title;
  if (values.due !== undefined) patch.dueAt = values.due;
  if (values['time-zone'] !== undefined) patch.timeZone = values['time-zone'];
  const importance = level(values.importance, '--importance');
  const urgency = level(values.urgency, '--urgency');
  if (importance !== undefined) patch.importance = importance;
  if (urgency !== undefined) patch.urgency = urgency;
  let input: CreateTaskInput | undefined;
  if (command === 'add') {
    input = {
      ...patch,
      title: required(values.title, '--title'),
      importance: importance ?? invalid('请提供 --importance high 或 low。'),
      urgency: urgency ?? invalid('请提供 --urgency high 或 low。'),
      dueAt: required(values.due, '--due'),
    };
  }
  if (command === 'update' && Object.keys(patch).length === 0) invalid('update 至少需要一个修改字段。');
  const filter: TaskFilter = {};
  if (values.status !== undefined) {
    if (!['open', 'completed', 'cancelled'].includes(values.status)) invalid('--status 不合法。');
    filter.status = values.status as TaskStatus;
  }
  if (values['include-deleted'] !== undefined) filter.includeDeleted = values['include-deleted'];

  const path = resolve(values['data-file'] ?? '.local/planner/state.json');
  const store = await JsonStore.open(path);
  try {
    if (store.recovery !== null) {
      console.warn(`已从备份恢复到版本 ${store.recovery.revision}：${store.recovery.reason}`);
    }
    const service = new PlannerService(store, new SystemClock(), new RandomIdGenerator());
    switch (command) {
      case 'add':
        printTask(await service.createTask(input!));
        console.log('\n事件已保存。');
        break;
      case 'list': {
        const tasks = await service.listTasks(filter);
        if (tasks.length === 0) console.log('没有符合条件的事件。');
        tasks.forEach(printTask);
        break;
      }
      case 'history': {
        const day = await service.getDay(argument!);
        console.log(`${day.date}：有效完成 ${day.completedCount} 项，活动 ${day.activities.length} 条。`);
        for (const activity of day.activities) {
          const revoked = activity.completionRevoked ? '（该次完成已撤销）' : '';
          console.log(`  ${formatTime(activity.occurredAt, activity.timeZone)} ${activityLabels[activity.kind]}：${activity.taskSnapshot.title}${revoked}`);
          console.log(`    事件 ID：${activity.taskId}`);
        }
        break;
      }
      case 'days': {
        const days = await service.listHistoryDays();
        if (days.length === 0) console.log('暂无历史记录。');
        days.forEach((day) => console.log(`${day.date}：有效完成 ${day.completedCount} 项，活动 ${day.activityCount} 条。`));
        break;
      }
      default: {
        const task = await service.getTask(argument!);
        let result: TaskView;
        switch (command) {
          case 'update': result = await service.updateTask(task.id, patch, task.revision); break;
          case 'complete': result = await service.completeTask(task.id, task.revision); break;
          case 'reopen': result = await service.reopenTask(task.id, task.revision); break;
          case 'cancel': result = await service.cancelTask(task.id, task.revision); break;
          case 'delete': result = await service.deleteTask(task.id, task.revision); break;
          default: invalid('未知命令。');
        }
        printTask(result);
        console.log('\n操作已保存。');
      }
    }
    console.log(`\n数据文件：${path}`);
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof PlannerError ? error.code
    : error instanceof TypeError ? 'VALIDATION_ERROR' : 'ERROR';
  console.error(`[${code}] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
