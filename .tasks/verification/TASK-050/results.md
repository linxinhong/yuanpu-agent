# 独立助理完整业务验收（TASK-050）阶段记录

状态：**部分通过，整卡仍在进行。** 本次验证者不是 TASK-049/062 的主要实现者。产品验收基线为 main `15a1430`（产品树 `5e9a4f1` 加 TASK-050 领卡提交）；验收增量 `8417d12` 已集成 main，并在该修订重跑 `pnpm check` exit 0。本卡新增打包业务探针与历史探针清理修正，没有产品源码修改。所有新数据均在自动清理的临时 `YUANPU_HOME`、独立 Electron `user-data` 和合成 loopback 模型中；未读真实用户 Home、未用真实凭据、未发送企微消息。

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
| V50-08 真人企微修订记忆 | 同一已配对测试账号私聊应引用桌面纠正后的测试记忆，且独立于 Work 会话；主动建议仅在另行同意时推送。 | **UNVERIFIED**。用户此前确认过一次普通企微私聊机器人回复“收到”，但未授权本次新的真实 Home 测试记忆写入或新往返；本卡未重复使用该授权。当前只通过合成 `ChannelRouter`/Worker 的渠道、身份和去重回归。 |
| V50-09 外部模型与平台 | 外部模型在多样工作上的事实判断、费用和长期用户理解；真实用户 Home 迁移；Windows/Linux 发布；云端同步。 | **UNVERIFIED**。本机打包与固定 loopback 不能推出这些结果；云端及其他 IM 不在本卡范围。 |

执行命令与结果：

1. `pnpm check`：分支 runner `1790467376378716000.log`，exit 0（Assistant 45、Runtime 128、runtime-kit 189、Desktop 21 等均通过）；集成 main `8417d12` 的直接复跑 exit 0（Runtime 128/128）。首次下载失败 runner `1790467257389091000.log`，不计产品失败。
2. `pnpm package:desktop`：runner `1790467509360909000.log`，exit 0；包括 `build:native`、`smoke:native` 与 `smoke:runtime-update`。
3. `node apps/desktop/test/task-050-packaged-assistant-probe.mjs`：最终 runner `1790468606540187000.log`，exit 0；包含七技能目录、真实桌面纠正/两步撤销/忽略点击及合成截图。早期 runner `1790468060790104000.log` 通过桥接纠正/撤销与 UI 忽略；本次把前两项也改为真实界面点击。
4. `node apps/desktop/test/task-021-packaged-electron-app-probe.mjs`：最终 runner `1790468015649433000.log`，exit 0。早期失败 runner `1790467842769413000.log` 和 `1790467959237961000.log` 分别暴露测试清理竞态与过时模型请求计数。

本记录的 PASS 只覆盖注明的环境和输入。TASK-050 的真实企微“修订后记忆”结果尚未取得，不将卡标为 done；如获授权，再执行一次限定的测试账号往返、清理测试记忆，并补充真实桌面与渠道结果。否则保持 UNVERIFIED，避免把 fixture 或已有“收到”回执冒充本轮完整业务验收。
