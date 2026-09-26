# 隔离企业微信连接启动失败（TASK-027）

- 关键词：企业微信、可选连接、Runtime 启动、降级、Keychain、脱敏日志。
- Owner：`codex-t027sep23-12136`；记录日期：2026-09-23；分支/工作树：`task/task-027-wecom-startup-isolation` / `.worktrees/codex-task-027`。
- 实现与测试提交：`f5beed0`。入口：`apps/runtime/src/index.ts` 的 `serve()`；严格校验与连接回滚仍在 `apps/runtime/src/wecom-channel.ts` 的 `startConfiguredWecomChannels()`。

## 起因和处理

- 用户本机 `~/.yuanpu/app/connections/wecom.json` 中有旧版空 `groupAllowlist` 字段；当前配置解析拒绝未知字段。修复前 `pnpm dev` 的 Electron 启动阶段，Runtime 因该可选连接配置错误在 `ready` 前退出，App 无法打开。旧字段已从本机配置移除，不触碰 Bot ID、Secret、配对或群聊授权。
- 现在 Runtime 只在企业微信装配边界捕获失败。连接代码仍严格拒绝无效配置/凭据并回滚已启动的该渠道实例；Runtime 继续执行 scheduler tick 和 HTTP listen。标准错误仅记录 `[wecom] configuration_invalid`、`credential_unavailable` 或 `connection_unavailable`，不输出原始异常、Bot ID、Secret、成员标识。
- 缺陷修复不自动启用现有连接，也不等于 TASK-019 的正式企业微信/Electron 业务验收。

## 验证与交接

- Node 24.15.0、pnpm 11.22.0；`apps/runtime/test/runtime.test.mjs` 以隔离 `YUANPU_HOME` 覆盖畸形 JSON、旧字段、缺失 Keychain 凭据：修复前均在 ready 前退出，修复后均 ready 且 `/v1/health` 为 200，stderr 只含脱敏类别。
- `apps/runtime/test/wecom-channel.test.mjs` 保留有效连接启动、严格拒绝不安全配置，并新增后续连接失败时关闭先前适配器的断言。focused 11/11 PASS（runner `1790142333398115000.json`）。
- `pnpm check` 于实现提交 `f5beed0` 完整通过（runner `1790142345012952000.json`）；生成的无关 lockfile checksum 已移除。真实 App 窗口此前在清理用户本机旧字段后显示“本地 Runtime 已连接”，但该窗口是修复前代码；集成后需重启以加载新代码，再做 TASK-019 的正式连接、重启与原生通知验收。
- 检索：ZG 查询可选企业微信启动失败与 Runtime ready 关系，定位 `apps/runtime/src/index.ts`、`apps/runtime/src/wecom-channel.ts` 和相邻测试；未建立索引。
