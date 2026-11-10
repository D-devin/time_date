**后端与桌面接入说明 · 2026-11-02**

桌面窗口和命令行共用 TypeScript 业务核心和 JSON 存储。业务核心通过接口调用仓库、时钟和 ID 生成器。

| 阶段 | 当前状态 | 内容 |
| --- | --- | --- |
| 业务核心 | 已实现 | 事件增改、完成与撤销、取消、软删除、二维分类、到期视图、每日历史 |
| JSON 存储 | 已实现 | 单文件提交、串行修改、原子替换、前一版本备份、损坏恢复、写者锁、格式版本校验 |
| 可运行入口 | 已实现 | 中文演示与 CLI，编译、类型检查和自动化测试命令 |
| Electron 接入 | 已接入 | 主进程调用 PlannerService，preload 向窗口暴露指定业务方法 |
| 时间与系统事件 | 已接入 | 到期调度、唤醒刷新 |
| 桌面界面 | 已接入 | 悬浮卡片、贴边折叠、新增与编辑、按日历史 |
| 数据扩展 | 后续 | 导入导出、已有旧格式的迁移、设置界面 |

主进程在到期时通知界面刷新。业务层根据查询时的时钟计算状态，重启后用户也能看到正确的截止状态。

**主要目录和调用关系。**

```text
scripts/cli.ts 或 scripts/demo.ts
  → PlannerService
    → domain：校验、状态、历史和日期规则
    → StoreRepository：存储接口
      → JsonStore：真实文件
      → MemoryStore：测试用内存实现
```

`Clock` 允许测试推进日期；真实运行使用 `SystemClock`。`IdGenerator` 的真实实现使用 UUID。入口统一从 `src/index.ts` 导出。

业务调用示例：

```ts
import {
  JsonStore, PlannerService, RandomIdGenerator, SystemClock,
} from './src/index.js';

const store = await JsonStore.open('.local/planner/state.json');
try {
  const planner = new PlannerService(store, new SystemClock(), new RandomIdGenerator());
  const task = await planner.createTask({
    title: '整理项目资料',
    importance: 'high',
    urgency: 'low',
    dueAt: '2026-10-27T18:00:00+08:00',
  });
  await planner.completeTask(task.id, task.revision);
  const history = await planner.getDay('2026-10-27');
  console.log(history.completedCount);
} finally {
  await store.close();
}
```

上述日期用于说明格式，完成记录按调用时的真实日期归档。需要确定结果的完整示例请运行 `npm run demo`。

| 方法 | 行为 |
| --- | --- |
| `createTask(input)` | 校验并创建事件及创建历史 |
| `updateTask(id, patch, revision)` | 修改标题、二维标签、截止时刻或事件时区 |
| `completeTask(id, revision)` | 手动确认完成，产生有效完成记录 |
| `reopenTask(id, revision)` | 撤销完成或恢复取消；撤销关联原完成记录 |
| `cancelTask(id, revision)` | 取消未完成事件 |
| `deleteTask(id, revision)` | 软删除，保留历史 |
| `getTask(id)` | 返回当前事件视图，也能查询软删除事件 |
| `listTasks(filter?)` | 按状态和二维标签筛选，默认隐藏软删除事件 |
| `getDay(date)` | 返回当天活动和有效完成项 |
| `listHistoryDays()` | 返回有活动的日期及数量，日期倒序 |

修改命令使用事件版本 `revision` 检测过时编辑。版本不匹配返回 `CONFLICT`。已完成、已取消和已删除是用户状态；`isExpired` 是时间判断，两个维度互相独立。

日程列表沿用 `tasks` 数组的持久化顺序。`reorderTasks(ids)` 在同一事务中调整提交的事件所在槽位；未提交的事件保留原位，因此筛选排序和新增事件不会丢数据。排序只增加仓库提交序号，不修改事件版本或制造历史活动，兼容原有 JSON 格式。

历史使用 `sequence` 排序，使用操作当时的 `localDate` 分组。撤销可能发生在另一日，因此每日完成统计先解析全历史中的撤销关联，再选择当天记录。软删除不会取消原来有效的完成记录。

JSON 仓库对完整的“读取已提交状态 → 修改副本 → 校验 → 保存 → 发布新状态”进行排队。任务和历史一起保存；失败不发布新内存状态。读取和返回的对象都与已提交状态隔离。

`DailyJournalService` 提供 `list(date)`、`create(input)`、`update(id, input, revision)`、`remove(id, revision)`。每条日结包含记录日期、内容和可空的投入等级 `high / medium / low`，与日程状态、活动历史独立。编辑使用记录版本校验，删除使用 `deletedAt` 隐藏，所有写入复用同一 JSON 事务队列和备份机制。

文件格式当前为版本 2，新增必需的 `dailyEntries` 数组。版本 1 先经过原有结构校验，再在内存中补空数组，下一次写入保存版本 2；原事件与活动内容、数组顺序不变。已有文件必须通过结构与历史关系校验，未知版本拒绝打开。有损坏副本残留、但主文件和备份均缺失时不会自动生成空仓库。Windows 使用系统文件共享权限保证单写者，进程终止时释放，并自动接管无人持有的旧版锁。其他平台的遗留锁需确认不存在运行实例后手动处理。

开发检查命令：

```powershell
npm run typecheck
npm test
npm run build
npm run check
```

`check` 包含前三项。已有测试覆盖时间边界、四象限、跨日完成与撤销、历史快照、并发版本冲突、输入校验、写入失败、备份恢复及仓库关闭等行为。另用 `npm run test:desktop` 检查真实桌面窗口与本地仓库之间的操作流程。
