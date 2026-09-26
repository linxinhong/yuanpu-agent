# TASK-015 实现 Electron 系统通知闭环

- 关键词：Electron Notification、authenticated SSE、host receipt、reconnect dedupe、notification target
- Owner：`sol-task015-owner-20260922-72012`
- 记录日期：2026-09-22
- 源码/验证 revision：`262eb773e4c6a311d0497dc5c874d74919d63d4b`
- 分支/工作树：`task/task-015-electron-notifications` / `.worktrees/sol-task-015`

## 结果与边界

Runtime 通过认证 SSE 将通知请求交给 Electron，仅在认证回执后移除待处理事件；断线会重放，Electron 按 `eventId`/`requestId` 去重。`notify_user` 继续通过现有两个 MCP 元工具暴露，Agent `succeeded`/`failed` 终态另有不依赖模型选择工具的系统通知路径。系统事件只携带通用文案和受信任的 run/conversation ID，不包含 prompt、模型输出或失败详情。

Electron 明确返回 submitted/suppressed/unavailable/failed；`submitted` 的 `userVisibility` 始终是 `unknown`。无支持、权限拒绝、用户关闭和 App 退出均有可观测状态。原生通知对象有 50 个上限和 5 分钟 TTL，SSE 异常会取消 reader/响应并指数退避，防止长连接和日志放大。

通知点击只会把 `{conversationId, runId}` 送回 Runtime 做归属和存在性验证；通过后 Electron 聚焦窗口，renderer 再经受信 IPC 读取真实 `AgentRunRecord`。URL、命令或任意 renderer 路由不在目标契约内。

## 主要入口

- `packages/yuanpu-runtime/src/notifications/index.ts`：`HostNotificationRouter`、`requestTerminalRunNotification`、`createNotificationCapabilitySource`
- `packages/yuanpu-runtime/src/agent/service.ts`：`onRunStateChanged` 宿主观察口
- `apps/runtime/src/index.ts`：通知组装、SSE/回执/目标验证路由
- `apps/desktop/src/host-event-client.ts`：认证连接、重连、DTO 校验和资源回收
- `apps/desktop/src/notification-host.ts`：原生提交、回执、去重、点击与退出清理
- `apps/desktop/src/runtime-manager.ts` / `preload.ts` / `main.ts`：窄 Runtime/IPC 边界
- `apps/app/src/main.tsx`：通知目标定位并读取真实 run
- `docs/agent-runtime-contracts.md`：宿主通知契约和可见性语义

## 验证证据

- `pnpm check`：PASS，Node `v24.15.0` / pnpm `11.22.0`，包含构建、Yuanpu typecheck 和全部测试。记录：`1790075288605553000.json`
- `pnpm build:native`：PASS，macOS arm64 SEA Runtime。记录：`1790075324946442000.json`
- `pnpm smoke:native`：PASS，macOS arm64，覆盖冻结 Python 能力、SEA Runtime 和分阶段 Runtime update。记录：`1790075340041164000.json`
- Runtime 真实 HTTP/SSE 测试覆盖认证、非模型通知触发、回执和目标归属；desktop 测试覆盖重连去重、退避可中断、权限/关闭状态、伪造目标、TTL/上限和退出停止。
- 独立 Sol 复审：PASS，Spec 与安全/标准两轴均无 blocker/high/medium/low 发现。
- 检索：宿主未提供 zvec-grep 工具，按仓库规则使用 scoped `rg` 定位 TASK-015、契约、路由、Agent 状态和 Electron 调用点；未创建或重建索引。

## 未验证与交接

- 未在真实签名 Electron App 中手工点击 macOS 通知；Linux/Windows 原生通知权限和点击行为也未实机验证。fixture 通过不等于这些平台已验收。
- 通知队列在 Runtime 进程内重放；App/Runtime 都退出后不保留后台服务，也不承诺跨 Runtime 重启投递。
- 当 host-event 契约、Agent 终态、Electron Notification API 或 renderer 会话模型变更时，需重跑 focused + `pnpm check` + native smoke。
- 分支已验证且可交付，但未 merge/push/complete。Task Integrator 需将 `d2e0043` 和 `262eb77` 集成到 main，处理与 TASK-016 在 AgentService/Runtime 组装处的可能冲突，然后在 main 重验并记录 done。
