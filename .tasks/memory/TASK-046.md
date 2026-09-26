# TASK-046 接通助理专业任务委派与核验

- Owner: `assistant-contract-review-20260927-046-10414`；branch `task/task-046-assistant-delegation`；状态 `in_progress`。
- 关键提交：`bf96b15`（隔离与逐任务授权）、`f6eea72`（Worker IPC）、`cfc11be`（来源版本绑定）、`f6fd828`（签名任务级审批与界面）、`534157c`（外部效果执行中取消记 unknown）、`5ca59d1`（真实 Electron 探针）、`7e4d226`（TASK-051 队列消费）。分支已合入 main 的 TASK-043 与 TASK-051。
- 独立 Pi 子任务 Session 仅有 `read_task_source`、`execute_authorized_capability` 两个工具；路径及符号链接、任务 Home 与助理 Home 隔离有可执行回归。来源在接受任务时绑定版本，宿主每次读取复核；有副作用任务先经真实用户签名授权，具体 MCP 外部效果另需一次性审批。
- `AssistantDelegationService` 持久保存任务 ID、follow-up、等待审批与未知结果。外部效果批准前持久写入 in-flight 检查点；此时取消/重启只记 `unknown`，不自动重放。宿主每次调用前重新核验任务 grant 和取消信号。
- 真 Runtime 临时 Home + 环回模型集成测试验证签名授权前不启动专业任务、同 ID 审批后完成。`apps/desktop/test/task-046-delegation-ui-probe.mjs` 验证隔离 Electron 助理界面实际显示授权卡、点击“允许一次”后才启动独立专业 Pi 请求；不连接真实企微、不读取真实 Home。
- Node 24 `pnpm check` 在最终消费者分支全绿（Runtime 81/81，含 Worker/自动化新回归）；最终修改后的 `pnpm build:native && pnpm smoke:native` 通过（darwin-arm64）。真实 Electron UI 探针 1/1 通过。此前两次并行 check 在 `packages/yuanpu-runtime/test/mcp-source.test.mjs:97` 的 PID 时序断言失败，该文件独立 14/14 通过；最终整套重跑通过。
- 完成事件由 TASK-051 的 `verify-delegation` 持久队列消费。原助理 Session 收到仅可查询原 taskId 的模型回合，提出严格 JSON 证据关联；Engine 校验真实模型费用和前台抢占后，宿主才按已有 criteria/ref 规则链接证据并提交 checkpoint。模型回合前持久写 attempt；回合丢失、超预算或崩溃不自动重做，原任务 ID 与未知状态保留待核对。真实 Worker 测试验证完成事件→状态查询→证据归档→checkpoint，重启不会再发模型请求；handler 测试验证超预算及 SQLite 关闭重开后的未知不重放。
- 仍待主线集成与独立复核。本卡保持 `in_progress`；模型提供方若未返回用量且声明非零费率，消费者保守失败，不链接证据。零费率配置代表宿主声明免费，费用真值依赖该宿主配置。
