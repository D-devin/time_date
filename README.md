**时笺 · Windows 桌面日程表**

一个使用 TypeScript + Electron 开发的 Windows 桌面悬浮日程工具，包含手动排序的日程、每日工作日结和按日查看的操作历史。

双击本地打包生成的 `时笺.exe` 即可运行 Windows x64 免安装版。日程、日结与历史保存到 EXE 旁的 `data/planner/state.json`，窗口缓存也位于 `data` 内。备份时先从托盘退出，再复制整个 `data` 文件夹。把程序移动到其他目录时，将 EXE 和 `data` 一起移动。Git 仓库只包含源码、资源和开发文档，个人数据、缓存与 EXE 构建产物不提交。

开发者运行 `npm run package:win` 可以重新打包，并将最终 EXE 复制到项目根目录。原始构建产物位于 `release`。

运行 `npm run test:portable` 可验证单文件 EXE 的启动、原生组件加载、默认保存目录和重启读取，测试数据位于项目内的 `.local/portable-test`。

绿色毛玻璃小窗贴在屏幕边缘，顶部切换「日程」「日结」「历史」。点左上角「＋」展开或收起新增面板；在日结页添加当天记录，在其他页添加日程。收起后可在本次运行中继续填写草稿。拖动顶部横条可以挪动浮窗，右上角依次是置顶、折叠和隐藏到托盘。

在「日结」右上角选择日期，用「＋」记录当天实际做的事，也可补记过去某一天。每条最多 1000 字，可换行，投入标记可选「多 / 中 / 少」，不记录精确耗时。点击铅笔可修改内容、投入和日期，或确认删除。日结不会自动完成日程，也不增加日程历史中的完成数。

0.2.0 使用 JSON 格式版本 2：读取旧版格式时保留日程、手动顺序及活动历史，首次保存时写入新格式。之后应继续使用 0.2.0 或更新版本。

清单显示每个事件的截止时间、重要性与紧急性。到期时标题划线并显示「已到期 · 未完成」，手动确认完成后才计入当日历史。

日程按手动顺序显示：拖住每行左侧的小点上下移动，松开后自动保存；聚焦小点后也可以用 ↑ / ↓ 调整。完成框位于最右侧，新增事件放在末尾。筛选后排序只调整当前显示的事件，历史记录保持原有时间顺序。

折叠后的小条始终置顶，下面按手动顺序显示最靠前的三条未完成事件，完成后后续事件自动补上。可以拖住任意一行标题移动浮窗，点击「日程」展开。展开时也能拖动顶部空白或清单标题栏，松手靠近屏幕左右边缘时会自动贴边。

在 Windows 上安装 Node.js 24 或更新版本后，用 PowerShell 启动带样例的桌面版：

```powershell
git clone https://github.com/D-devin/time_date.git
cd time_date
npm ci
npm run desktop:demo
```

演示会创建独立的数据目录，填入已到期、待办和已完成的事件。可以在窗口中新增事件，编辑标题、切换二维标签、修改截止时间，再打开历史查看完成记录。每次重新运行演示都会使用一组新样例。

首次安装需要下载 Electron 的 Windows 运行时。本机连接官方发布地址超时时，使用下面的 PowerShell 命令下载成功。安装程序会用锁定版本所附的 SHA-256 校验值核对文件。

```powershell
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
.\node_modules\.bin\install-electron.cmd
```

开发时运行 `npm start`，使用项目内的 `data/planner/state.json`，与根目录中的 EXE 共用日程数据。CLI 默认使用项目内的 `.local/planner/state.json`，可通过 `--data-file` 指定同一个仓库。

运行 `npm run test:desktop` 可以用真实 Electron 窗口重现桌面操作测试；`npm run test:journal` 检查旧数据升级、日结草稿、补记、改期、删除和重启读取。运行 `npm run check` 进行类型检查、业务与存储测试及编译。

项目需要 Node.js 24 或更新版本。要查看独立的后端演示，可在项目目录运行以下命令。

```powershell
cd E:\project\date
npm run demo
```

演示会用固定时钟依次运行“新增 → 到期但未完成 → 次日完成 → 修改标题 → 撤销 → 再次完成 → 关闭并重新读取”。每次数据放入 `.local/demo/run-*` 的新目录，不影响下面命令行的日常数据。

**用命令行添加和查看事件。**

```powershell
npm run cli -- help
npm run cli -- add --title "整理项目资料" --importance high --urgency low --due "2026-10-27T18:00:00+08:00"
npm run cli -- list
```

`importance` 的 high / low 对应重 / 轻；`urgency` 的 high / low 对应急 / 缓。截止时间必须带 `Z` 或 `+08:00` 这样的时区偏移。示例日期已经过去时，新增事件会立即显示为已到期。

把输出中的完整事件 ID 复制到变量，再执行操作：

```powershell
$taskId = "在这里粘贴完整事件ID"
npm run cli -- update $taskId --title "整理资料与截图"
npm run cli -- complete $taskId
npm run cli -- history 2026-10-27
npm run cli -- days
npm run cli -- reopen $taskId
```

`history` 的日期替换为实际记录完成的日期。`reopen` 用于撤销完成，也可恢复已取消事件。其他命令：

```powershell
npm run cli -- cancel $taskId
npm run cli -- reopen $taskId
npm run cli -- delete $taskId
npm run cli -- list --include-deleted
```

已完成事件需要先撤销完成，才能取消。删除为软删除，会保留历史；当前版本暂不提供恢复删除功能。默认列表隐藏已删除事件，包含其他状态，也可用 `list --status open` 仅查看未完成事件。

所有命令均可使用 `--data-file "文件路径"` 指向另一个仓库；`help` 不会打开或创建数据文件。

**业务规则已经固定。**

- 业务层根据时钟计算 `isExpired` 和 `shouldStrikeThrough`。桌面窗口会在截止时刻刷新，实际完成时间由手动确认记录。
- 日期按历史时区分组，默认 `Asia/Shanghai`。26 日到期、27 日手动完成，计入 27 日。
- 历史保存当时快照，后来改名不会改写完成记录。跨日撤销会修正原日期的有效完成数，并保留已撤销记录。
- 同一版本的重复完成不会新增历史；修改需匹配当前版本。CLI 会先读取版本，后续界面也应遵守这一接口。

**CLI 数据保存在项目运行目录的 `.local/planner/state.json`。**

任务当前状态和活动历史在同一个 JSON 中提交；`.bak` 保留前一有效版本。主文件损坏时会保留 `.corrupt-*` 副本并尝试恢复有效备份，命令行会告知恢复版本。当前支持 `schemaVersion: 1`，未知版本会拒绝写入，旧格式迁移尚未实现。

Windows 版由系统持有 `.lock` 文件的写入权限，正常退出或强制结束时都会释放。启动时会自动接管无人占用的旧版遗留锁。若提示数据正在使用，请先从托盘退出另一个运行实例。其他平台仍使用文件排他锁，异常退出后需要确认无运行实例再处理遗留锁。

建议按以下顺序阅读代码：

| 入口 | 用途 |
| --- | --- |
| [scripts/demo.ts](scripts/demo.ts) | 从调用示例理解完整流程 |
| [src/core/domain/model.ts](src/core/domain/model.ts) | 事件、历史与视图的数据结构 |
| [src/core/application/planner-service.ts](src/core/application/planner-service.ts) | 新增、修改、完成、撤销、每日查询的主要逻辑 |
| [src/core/domain/task-view.ts](src/core/domain/task-view.ts) | 四象限与到期展示规则 |
| [src/infrastructure/persistence/json-store.ts](src/infrastructure/persistence/json-store.ts) | JSON 保存、锁、备份与恢复 |
| [tests/planner-service.test.ts](tests/planner-service.test.ts) | 用可推进时钟验证业务行为 |

后续开发阶段及接口说明见 [后端开发说明](docs/backend-development.md)，整体设计见 [架构调研](docs/architecture-research.md)。
