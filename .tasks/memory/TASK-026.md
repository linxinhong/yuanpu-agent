# TASK-026：补齐计划到已绑定 IM 的投递

- 关键词：计划投递、企业微信私聊、主动发送、授权绑定、双出口回执、SQLite 迁移、未知结果
- Owner：`codex-t026sep23-12136`；记录日期：2026-09-23
- 分支：`task/task-026-scheduled-im-delivery`；worktree：`.worktrees/codex-task-026`
- 实现与已测 revision：`e2010136dd08990d1c5e6e7b4aa47d60cec03d02`、`67a2e18096373de604fcf51226b7501c8f5bf742`

## 入口与契约

- Runtime 装配在 `apps/runtime/src/index.ts`；`scheduled-im-delivery.ts` 实现已认证的 `/v1/channels/schedule-targets` 列表、显式绑定、解绑及计划 HTTP 入口。
- `ChannelRouter`、`ChannelStore`、`WecomSdkTransport` 在 `packages/yuanpu-runtime/src/channels/` 提供已绑定目标校验和官方 SDK 私聊主动发送；任意客户端 `userid` / `routeId` 不能作为新授权目标。
- SQLite schema v5 增 `yp_channel_private_contacts` 与 `yp_schedule_notification_receipts`；计划历史分别查询 `deliveryStatus` 和 `notificationStatus`。数据库保存最小原始目标映射于既有 0600 元数据文件；API、日志和计划记录仅用随机引用。
- 决策和限制见 `docs/adr/0002-scheduled-im-targets.md`。现有 `pairedSenderDigests` 是新增配对种子，不是撤销清单；计划投递必须通过目标 DELETE 显式撤销。

## 故障与恢复

- 发送前连接未认证：延后且不消耗尝试；明确失败：记录失败；可能写出的未知结果：记录 `result_unknown`，无 provider 幂等键时不自动重发，也不重跑 Agent。
- 目标解绑清空原始成员标识，等待已启动发送落定；旧引用、错连接、重启后的身份变更均拒绝。App 退出先停调度再停渠道。
- 系统提醒宿主回执独立记录；`submitted` 仅表示交给操作系统。未落定回执在重启后变 `result_unknown`，不自动重新弹出。记录写失败不会改变 Agent 终态。

## 验证与边界

- `pnpm check` PASS：`1790135017325740000.json`；最终原生构建/冒烟 PASS：`1790135059055664000.json` / `1790135071213067000.json`，Node 24.15.0、pnpm 11.22.0、darwin-arm64。
- HTTP loopback 测试覆盖绑定、计划接受、双出口相反失败、撤销；邻近测试覆盖 SQLite 重开、未知发送不重试、错误身份/连接。重建 v4 数据库迁至 v5 的带配对数据回归已过。
- 独立只读安全复核完成，后续高风险发现均修复；复核指出 v4 fixture 是按旧表结构重建，并非旧版本二进制产物。
- 未声称真实企业微信私聊展示或 Electron 点击验收；这仍由独立 TASK-019 复验。没有接触或输出 Bot Secret / 原始用户标识。
- 检索：host 未提供 zvec-grep，以限定 `rg` 和任务卡/相邻测试定位；未建索引。
