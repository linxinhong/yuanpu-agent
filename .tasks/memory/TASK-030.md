# 修复 SEA 更新回退后的用户提示（TASK-030）

- 关键词：Runtime、SEA、协议不兼容、回退、Electron IPC、用户提示
- Owner：`codex-d21sep23-12136-12136`；记录日期：2026-09-23；实现提交：`758f808`，集成 main：`90e5787`；环境：macOS arm64、Node 24.15.0、pnpm 11.22.0。
- 根因：`RuntimeManager.startInternal` 在候选 SEA 协议不兼容后成功回退，只调用默认 `reportError` 写宿主日志；`main.ts` 的错误框仅覆盖整个 Runtime 无法启动的路径，恢复后的 App 没有可见提示。
- 修复：`RuntimeManager` 仅在回退并重新启动旧 Runtime 成功后发出 `incompatible_protocol` 或 `activation_failed` 类别。Electron 主进程只保存类别，经过 `trustedHandler` 的 IPC 和 preload getter 传入渲染进程；页面显示固定、可关闭的提示，不传递原始 stderr、路径或凭据。更新/数据库回滚逻辑未改。
- 验证：修复分支的 `pnpm build:desktop`、聚焦 `runtime-manager`/`runtime-updater` 测试、`pnpm check`、`pnpm package:desktop` 通过。集成 main `90e5787` 的 `pnpm check` 通过，runner `1790165973173983000.json`。独立验证者将集成代码同步到 任务多入口与升级完整业务验收（TASK-021）分支 `ed13cde`，重打包后以合成数据完成四次 App 启动：正常无误报，协议 999 和一般激活失败均显示固定可关闭提示且无合成标记/临时路径泄漏，旧任务保留，Runtime 子进程清理；runner `1790166220699941000.json`，证据提交 `197f713`。
- 边界：上述为 ad-hoc macOS 打包、合成数据；未验证生产签名、Windows/Linux，也未把 任务多入口与升级完整业务验收（TASK-021）整体宣称通过。
- 检索：ZG 以 `RuntimeManager.reportError`、回退到 Electron/renderer 的错误流查询，命中 `apps/desktop/src/runtime-manager.ts` 与运行契约；随后 scoped `rg` 定位 `main.ts`、`preload.ts`、`apps/app/src/main.tsx`。
