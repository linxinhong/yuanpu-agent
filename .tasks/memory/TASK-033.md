# 区分企业微信运行与回复投递状态（TASK-033）

关键词：IM、outbound、unknown、配对授权、Electron IPC、Runtime 摘要、App 重启。

- 记录：2026-09-23；实施者：codex-task021-followup-20260923。源提交 `06312e9`、授权关联收紧 `c7bfe95` 和 `193fe5a`；依赖实现连接与定时任务管理界面（TASK-020）；源于 App 多入口与升级完整业务验收（TASK-021）的 D21-02。
- 契约入口：`packages/yuanpu-protocol/src/index.ts` 的 `PrivateImRunSummary`/`privateImRuns`/`DesktopBridge.getPrivateImRunSummary`；`apps/runtime/src/index.ts` 的令牌保护 GET 路由；`apps/desktop/src/runtime-manager.ts`、`main.ts`、`preload.ts` 的受信任桥；`apps/app/src/main.tsx` 的现有运行详情卡。
- Runtime 只为当前配置中已配对的企业微信单聊返回 `{runId, runStatus, replyDeliveryStatus}`。`apps/runtime/src/runtime-host.ts` 逐项核对 run owner/身份、工作区、会话 digest、入站 provider/类型/动作、route ID，以及 outbound 的 run/inbound 关联；不匹配统一不可见。撤销配对后不再授权查询旧摘要。
- 显示：运行状态与回复投递分列；`unknown` 明示结果未知且不会自动重发；`accepted` 仅说企业微信已接收，不宣称用户看到。未创建、等待、投递中、失败有独立标签。摘要不包含正文、用户标识、URL、credential、原始错误或 content digest。
- `getAgentRun` 的原桌面/定时任务身份授权不放宽。IM 使用单独的最小只读摘要；已授权目标的通知导航验证可定位同一私聊运行，但原生通知展示/点击仍属于 TASK-029。
- 本机验证：macOS arm64，Node 24.15.0 / pnpm 11.22.0；`pnpm check` 在 `193fe5a` 通过（runner `1790172504403108000.json`），聚焦运行授权测试通过（`1790172477269261000.json`）。`pnpm` 自动添加的空 lockfile checksum 已清理。
- 独立验证：TASK-021 分支合入该修复后，test-only Runtime + 正式 Electron main/preload/React + SQLite 的双启动探针通过（runner `1790172599019589000.json`；证据提交 `1de5775`）。一次 Agent/一次发送、重启后 outbound `unknown`、页面分列显示、重导航保持、撤销配对拒绝、Runtime 子进程清理。其独立 `pnpm check` 也通过（`1790172530489632000.json`）。
- 集成复验：`main` `e16cfef` 同时包含产品修复和独立探针；[Linux CI run 35872482174](https://github.com/linxinhong/yuanpu-agent/actions/runs/35872482174) 的完整 `pnpm check` 通过。该 CI 不运行 Electron 图形化业务旅程。
- 限制：探针的 Runtime/发送端受控，不能替代正式 Runtime/真实企业微信会话。其他投递状态尚未逐一在打包 App 中操作；真正较新 SEA、Windows/Linux 可执行旅程和生产签名仍是 TASK-021 的未验证项。今后若改 IM 配对或本地凭据存储，须重验该只读授权边界。
