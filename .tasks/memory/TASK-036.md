# 按 Muse 参考框架交付 Yuanpu 聊天 UI（TASK-036）

- 关键词：Muse、三栏聊天、dialog、授权就绪、轮询恢复、Pi 错误、Electron。
- Owner：`codex-ui-sep24-30665`；日期：2026-09-24；分支 `task/task-036-muse-ui`；工作区 `.worktrees/codex-ui`。
- 实现：`c151456` 和 `49af3bd`；集成验收 revision `886f067`。后续仅更新文档、证据和账本。
- 设计入口：`docs/frontend/tasks/muse-chat-redesign.md`；已接受基线、最终截图与验收：`docs/frontend/evidence/task-036/`。
- 直接依赖：实现连接与定时任务管理界面（TASK-020）；沿用其 DesktopBridge、管理页面与通知导航入口。

## 入口与行为

- `apps/app/src/main.tsx`：App/ChatPanel/AppIcon；`muse-theme.css` 为公共浅色外壳和聊天三栏样式；`apps/desktop/src/main.ts` 使用 macOS hiddenInset。
- 桌面右栏展示已观测的当前会话状态，未引入历史持久化或实时工具订阅。窄屏使用原生 dialog 模态焦点管理和 Escape，关闭恢复触发按钮。
- `sending` ref 阻止重复发送；审批不解除运行中的发送锁；中文输入法 composition Enter 不发送。
- 已接受运行的轮询失败保留 run ID；恢复只继续 getAgentRun，不再次 submit。终态缓存阻止取消后的迟到结果复活任务，失败不覆盖用户已输入的新草稿。
- 授权列表可能早于 run 的 waiting_approval：必须核对 run.pendingApproval 绑定后启用按钮。已处理请求过滤掉迟到的列表结果。
- 当前运行的授权成功结果由终态轮询统一显示，避免授权响应和轮询各显示一份。
- `packages/yuanpu-runtime/src/pi/index.ts`：Pi 的 prompt 可能正常 resolve 但最终消息 stopReason=error。检查最终 assistant 状态，抛出通用脱敏错误，走现有 failed 契约；capabilityError 也不应标为工具成功。
- 不修改 Pi 上游、公共协议、持久化格式、宿主签名或一次性授权边界。

## 验证与复用

- Node 24.15.0 / pnpm 11.22.0；worktree-kit prepare/doctor/run。安装使用 frozen lockfile / ignore-pnpmfile；复用 pnpm 缓存和离线模型元数据，安装树与输出隔离。
- `apps/app/test/task-036-chat-probe.mjs`：agent-browser bridge fixture，覆盖组合输入、恢复不重复、授权就绪/发送锁、取消迟到轮询；main 上 runner `1790217383483447000` PASS。
- `apps/desktop/test/task-036-ui-app-probe.mjs`：真实 Electron IPC/Runtime/SQLite/受管 Python；本地模型 fixture 覆盖失败与取消；`TASK_036_LIVE=1` 使用现有模型配置和环境密钥，仅合成提示与回显。具体命令见 results.md。
- 最终 fixture runner `1790217206296491000`、真实模型 runner `1790217204991895000` PASS；两者代码与 49af3bd 一致；截图是 DPR 1 视口截图。
- main `886f067` 上 `pnpm check` PASS，runner `.git/coding-owner/1790217363497491000.json`；包含 app 类型、desktop tests、Pi HTTP 错误回归。工作树无本卡源码差异。
- 所有四页 axe WCAG A/AA：0 violations / 0 incomplete。真实 macOS AX 观察原生窗口控件；CDP 截图不含交通灯。未声称 Windows/Linux、签名包或真实 IM 验收。
- 本卡为实施者本地复核，没有独立 reviewer 结论。原有通知导航测试继续纳入全量门禁。
- pnpm 运行可能写入空 pnpmfileChecksum；只移除这次环境生成的差异，不提交无关锁文件变化。
- 用户原有 `.gitignore`、任务入口旧改动与 `docs/application-architecture.md` 保留；本卡初始 UI 草稿备份于临时目录 `yuanpu-task036-original-w95lezbr`，完整最终代码已提交。
- 检索：复用建卡 ZG fresh 但对新草稿覆盖不足的证据；本次按卡入口 exact rg/read 核对 main.tsx、Pi 适配、AgentService 和现有 Electron 探针，无新索引。
- 重验条件：修改运行/授权事件、桥接接口、响应式焦点或 Pi Provider 错误处理时，跑对应探针及 pnpm check；图片/记录修订无需重复全量测试。
