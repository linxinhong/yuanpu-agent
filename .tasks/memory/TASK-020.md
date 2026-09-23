# 连接与定时任务管理界面（TASK-020）

- 关键词：Electron、连接管理、定时任务、执行历史、IM 投递、Keychain、鉴权、取消任务
- Owner：`codex-t019sep23-12136`；记录日期：2026-09-23；源提交：`b3c22d0`；测试树与此提交一致（证据文档变更除外）。
- 依赖 TASK-019 的单用户企业微信与调度基线；原生通知界面/系统显示属于 TASK-029，不在此卡。

## 入口与交付

- `apps/app/src/main.tsx` 的侧栏加入连接、定时任务视图；`management.tsx` 提供列表/详情/编辑、空/加载/错误/等待状态、历史 Agent 与 IM 投递的分列展示、移动端退回列表。无 Electron 桥时只显示标明的合成演示数据。
- `packages/yuanpu-protocol/src/index.ts` → `apps/desktop/src/preload.ts` / `main.ts` / `runtime-manager.ts` → `apps/runtime/src/index.ts` 是管理与聊天取消的授权链。所有 Electron IPC 仍经现有 trustedHandler、Runtime 请求仍需本地令牌。
- `apps/runtime/src/wecom-channel.ts` 写入严格配置并仅存固定 Keychain 引用，响应不回显 Bot ID 或 Secret。启用保存只定向重连目标，等待最多 12 秒鉴权；失败恢复原文档并保留 UI 草稿，检测可对不可用连接定向重试。新增停用连接不影响现有路由。
- `packages/yuanpu-runtime/src/scheduler/service.ts` 的 `preview` 做与保存一致的校验但不持久化；任务历史在“刷新”时重新读取。桌面对话走异步提交、运行轮询与取消，App 退出时仍清理 Runtime 子进程。

## 验证与边界

- 用户于 2026-09-23 批准设计 v001；提案、截图及浏览器任务流见 `docs/frontend/tasks/connection-schedule-management.md` 和 `.tasks/ui/TASK-020/images/`。1440/1280/1024/390 px 无水平溢出；Reload 后 axe-core WCAG A/AA 零确定违规，渐变背景文字的对比度仍需人工复核。
- `pnpm check` 在 Node 24.15.0 / pnpm 11.22.0 PASS，runner `1790160933445340000.json`；默认 Node 26 下桌面更新器的既有临时可执行文件因缺 `libnode.147.dylib` 失败，不是项目规定环境。
- `apps/desktop/test/task-020-management-app-probe.mjs` 在隔离 `YUANPU_HOME`/userData/工作区上 PASS：真实 Electron IPC 保存停用连接与计划、刷新、聊天提交/取消、退出后无 Runtime 子进程。专门的 Runtime/SDK fixture 覆盖配置回滚、定向启动与鉴权失败脱敏；没有向真实企业微信发消息，也未读取用户凭据。
- 独立只读审查发现历史刷新、过早宣称鉴权成功、全量重连，以及已启用连接保存未重连；均修复后复测。真实 SDK 鉴权失败/重试、已连接机器人收发期间的定向重连、签名包与跨平台旅程留给 TASK-021/TASK-029，不将 fixture 扩大为现场通过。
- 新连接仅引用预先写入系统 Keychain 的 Secret；UI 不提供 Keychain 写入器。更换凭据需在外部安全更新后于 App 保存当前连接以定向重连。配置失败不阻断 App 启动。
- 下次复核：若改动授权桥、SDK 状态事件、调度持久化或连接配置格式，先重跑 focused 测试和隔离 Electron 探针，再跑项目规定环境 `pnpm check`。
