# 独立助理完整业务验收（TASK-050）阶段记录

状态：**业务场景通过，任务结项待主线整合。** 本次验证者不是 TASK-049/062/065 的主要实现者。阶段验收增量 `8417d12`、`efdf902` 和记忆缺陷红测 `d0543af` 已集成 main。独立复测基线 main `f405cc0`（TASK-065 集成及结项）；本卡没有产品源码修改。临时场景使用自动清理的 `YUANPU_HOME`、独立 Electron `user-data` 和合成 loopback 模型。本次真实 Home/企微单次往返由主任务按用户明确授权执行；本验证者未读取真实 Home 内容、真实账号标识或凭据，也未发送企微消息。

环境：macOS arm64，Node 24.15.0，pnpm 11.22.0，uv。独立 worktree `.worktrees/assistant-e2e-verification`；`worktree-kit.py` 的 runner 记录保存在此 worktree 私有 Git 目录的 `coding-owner/` 下。首次 `pnpm check` 因新 worktree 缺少忽略的模型目录且 models.dev 连接超时，在测试前失败；从主线同版本 `packages/ai/src/providers/data` 复制忽略的离线目录后，完整检查通过。没有创建或刷新 zvec 索引；当前宿主无 zvec 工具，已知任务卡、设计、阶段证据和测试入口用限定 `rg` 与定向读取。

| 场景 | 预期与事实 | 判定、模式及证据 |
| --- | --- | --- |
| V50-01 两个新 Work | 两个独立工作会话分别落盘并被助理审阅，第二个 Work 的模型输入不继承第一个 Work 标记。打包 Electron preload 创建两会话并提交两回合；真实 SEA/Worker 产生两份不同 workId 的审阅。 | **PASS（真实打包进程 + 合成 loopback 模型）**。[打包业务探针](../../../apps/desktop/test/task-050-packaged-assistant-probe.mjs)，runner `1790467782588067000.log`。模型语义质量不由此证明。 |
| V50-02 修订、来源撤销和重启 | 桌面桥接导入纯测试记忆后，在真实打包界面打开记忆、输入并保存纠正；来源详情经“撤销助理读取”与“确认撤销”两步点击。宿主登记一条 tombstone，Worker 停止读取；完整退出再打开，修订和撤销保持，原始 Work 回合仍在。 | **PASS（真实打包进程、临时 Home）**。[最终打包 UI 探针](../../../apps/desktop/test/task-050-packaged-assistant-probe.mjs)、runner `1790468606540187000.log`、[合成桌面截图](assistant-desktop.png)。源码级和真实 Worker 的双来源撤回/旧游标回归也在本次 `pnpm check` 通过。 |
| V50-03 主动建议 | 后台从未核实的 Work 形成建议，真实桌面“今日”页打开建议并点击“忽略”，App 重启后反馈仍为 ignored；没有向企微主动投递。 | **PASS（真实打包进程 + 合成 loopback 模型）**。同 V50-01。该场景只证明本地建议、界面与持久化；真实渠道送达另列未验证。 |
| V50-04 专业委派与可信产物 | 助理只读委派独立 Pi 会话，专业结果成为来源，Work 从 partial 变 supported 只能依据后续真实 write 工具与宿主快照。 | **PASS（真实 Runtime/Worker/Pi + 合成 loopback 模型）**。复跑 [TASK-047 服务级场景](../../../apps/runtime/test/task-047-work-repair-stage.test.mjs)，包含于本次完整检查。此前 [TASK-047 独立阶段证据](../TASK-047/results.md) 的环境边界不变。 |
| V50-05 拒绝、重复与恢复 | 重复桌面/企微入站、来源撤销、委派取消与未知结果不得重复执行或越权；遗忘后旧事件不复活。 | **PASS（临时 Host、真实 Worker 和合成渠道适配器的回归）**。本次 `pnpm check` 中 `assistant-channel-live`、`assistant-source-live`、`assistant-delegation-service`、`assistant-suggestion-worker` 与 TASK-047 场景通过。此行不是一次真人企微故障注入。 |
| V50-06 七项技能与进程生命周期 | 打包 App 首次启动后助理 Home 有七项专属技能；完整退出时 SEA Runtime 与 Assistant Worker 停止，再启动不重复建议或来源撤销。 | **PASS（真实打包 Electron/SEA、临时 Home）**。V50-01 探针直接检查七个目录及两个子 PID 退出；重复启动核对持久状态。`pnpm package:desktop` 内含 native 构建、smoke 和 Runtime 更新 smoke。 |
| V50-07 更新/回退 | 打包 App 激活新版 SEA，拒绝协议不兼容与启动失败候选，继续读取会话/计划且不留 Runtime 或 Worker 子进程。 | **PASS（真实打包 Electron/SEA、临时 Home）**。[更新/回退探针](../../../apps/desktop/test/task-021-packaged-electron-app-probe.mjs) 在本卡中补充 Worker 退出等待，并把 Work 模型请求与后台助理 review 请求分开计数；runner `1790468015649433000.log`。首轮 `ENOTEMPTY` 是未等待 Worker 的测试清理竞态，第二轮旧请求计数断言过时；修正后完整回退场景通过。 |
| V50-08 真人企微修订记忆 | 同一已配对测试账号私聊应引用桌面纠正后的测试记忆，且独立于 Work 会话；主动建议仅在另行同意时推送。 | **PASS（经用户收件确认的单次真实企微往返；主任务执行、独立验证者接收脱敏汇总）**。用户先明确授权；主任务在真实桌面 UI 将 personal/local-user 的纯测试记忆从蓝色 v1 修订为绿色 v2。精确入站请求在 Runtime 记录为 `channel=wecom`、`status=completed`、回复“绿色纸鹤”，投递为 accepted 且无失败；用户确认测试账号收到“绿色纸鹤”。Work 保存回合中验收口令文本计数为 0。随后主任务经桌面 UI 确认遗忘，数据库中该测试记忆的文档和修订行均为 0，正常退出后 Electron/Runtime/Worker 均停止。仅汇总这些观察，不记录真实账号、内部 ID、原始入站或凭据；没有主动建议外发或第二条测试消息。 |
| V50-09 外部模型与平台 | 外部模型在多样工作上的事实判断、费用和长期用户理解；真实用户 Home 迁移；Windows/Linux 发布；云端同步。 | **UNVERIFIED**。本机打包与固定 loopback 不能推出这些结果；云端及其他 IM 不在本卡范围。 |

执行命令与结果：

1. `pnpm check`：分支 runner `1790467376378716000.log`，exit 0（Assistant 45、Runtime 128、runtime-kit 189、Desktop 21 等均通过）；集成 main `8417d12` 的直接复跑 exit 0（Runtime 128/128）。首次下载失败 runner `1790467257389091000.log`，不计产品失败。
2. `pnpm package:desktop`：runner `1790467509360909000.log`，exit 0；包括 `build:native`、`smoke:native` 与 `smoke:runtime-update`。
3. `node apps/desktop/test/task-050-packaged-assistant-probe.mjs`：最终 runner `1790468606540187000.log`，exit 0；包含七技能目录、真实桌面纠正/两步撤销/忽略点击及合成截图。早期 runner `1790468060790104000.log` 通过桥接纠正/撤销与 UI 忽略；本次把前两项也改为真实界面点击。
4. `node apps/desktop/test/task-021-packaged-electron-app-probe.mjs`：最终 runner `1790468015649433000.log`，exit 0。早期失败 runner `1790467842769413000.log` 和 `1790467959237961000.log` 分别暴露测试清理竞态与过时模型请求计数。
5. TASK-065 集成后的独立临时 Home 复测：Node 24 定向构建 Assistant/Runtime runner `1790471935722621000.log`、`1790471950768759000.log` 均 exit 0；`node apps/runtime/test/task-050-memory-refresh-probe.mjs` runner `1790471966800243000.log` exit 0。真实 Worker/Pi 的同一 session 请求包含纠正后的绿色 v2、不含蓝色 v1；重启后仍如此；遗忘后新 session 的模型输入无蓝/绿且答复“未知”。原红测 runner `1790469379939975000.log` exit 1，修复由 TASK-065 完成。
6. TASK-065 集成后的独立打包复测：Node 24 定向构建新版 SEA、renderer、Electron main，再打包，runner `1790472018935126000.log`、`1790472038894226000.log`、`1790472056040038000.log`、`1790472068914628000.log` 均 exit 0；`node apps/desktop/test/task-050-packaged-assistant-probe.mjs` runner `1790472132705158000.log` exit 0，重新确认两个 Work 隔离、七技能、桌面纠正/两步撤销、建议忽略、重启恢复和进程退出，截图已更新。尝试 `pnpm build:runtime` 的 runner `1790471893950438000.log` 因 models.dev 严格生成网络超时而失败，随后用既有离线模型产物完成上述定向构建；产品主线 `f405cc0` 的 Node 24 `pnpm check` 已由 TASK-065 主任务执行并通过（runner `1790471730579155000.log`）。

历史红测最小复现：[记忆刷新探针](../../../apps/runtime/test/task-050-memory-refresh-probe.mjs) 使用临时 Home、真实 Worker/Pi 与 loopback 模型；旧版 runner `1790469379939975000.log` exit 1，纠正 v2 后同一 session 的模型输入未见新记忆。TASK-065 将个人记忆改为每次模型请求按当前版本、受众和来源临时检索，并保留 SOUL/技能身份冻结；修复后的同探针已转绿并进入 Runtime 测试命令。前后的证据区分缺陷发现与最终产品行为。

本记录的 PASS 只覆盖注明的环境和输入。真人收件由用户确认，服务器端请求、投递、遗忘及退出由主任务核对；独立验证者没有读取真实私聊正文或数据库。外部模型在多样工作上的事实判断和长期记忆质量、Windows/Linux 打包、云端同步仍未验证，不能由本机 loopback 或本次四字往返推断。
