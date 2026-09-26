# 隔离企业微信日志与 Runtime 就绪协议（TASK-028）

- 关键词：企业微信、Runtime、stdout、stderr、Electron、就绪握手。
- Owner：`codex-t028sep23-12136`；日期：2026-09-23；分支 `task/task-028-wecom-ready-logs`。
- 入口：`apps/runtime/src/index.ts` 装配 `startConfiguredWecomChannels`；`apps/runtime/src/wecom-channel.ts` 的 `writeWecomDiagnostic`；Desktop 首行读取在 `apps/desktop/src/runtime-manager.ts`。

## 起因与处理

- 正式 App 启用已配对的企业微信连接后，SDK 的 `info` 事件在 Runtime `ready` 前经 `console.info` 写入 stdout。Desktop 将这行 `[wecom] ...` 当 JSON 解析，报告 `Unexpected token 'w'`，因而启动失败。
- Runtime stdout 保留给首行 JSON 就绪协议；企业微信诊断均经 stderr 输出，只接受安全事件标签，`debug` 仍不输出。SDK 原始日志、凭据、成员与消息正文均不进入诊断。
- 不变更连接配置、配对、Keychain、严格校验、连接失败降级和 App 退出关闭语义。业务验收仍属 TASK-019。

## 验证与后续

- Node 24.15.0、pnpm 11.22.0。`apps/runtime/test/wecom-diagnostic.test.mjs` 的子进程测试先因缺实现为红，再证明 info/warn/error 只到 stderr 且 stdout 首行可解析；相邻企业微信测试通过。
- `pnpm check` 在修复工作树完整通过，runner `1790146192155376000.json`。随后用用户已启用的本机连接启动开发版 Electron：Vite、catalog、Electron renderer 与 Runtime 子进程均运行超过一分钟，无先前的 JSON 就绪解析错误；停止开发进程后无残留。插件搜索报告另一个缺信任根的错误，不属于本卡，也不等于企业微信消息业务通过。
- 检索：ZG 关系查询定位 `apps/runtime/src/index.ts` 与 `apps/desktop/src/runtime-manager.ts`，scoped `rg` 核对相邻测试。最终在 main 集成后应复核本卡 `pnpm check`，TASK-019 再验证真实私聊与系统通知。
