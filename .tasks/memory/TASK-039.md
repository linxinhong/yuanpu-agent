# TASK-039 隔离工作会话并保留历史

- 关键词：Work 会话、旧 default 归档、Pi Session、来源事件、审批隔离、内容引用。
- Owner：`work-conversations-sol1`；记录日期：2026-09-26。
- 来源：main 领取提交 `d7a2dde`；实现及测试提交 `7231776`，分支 `task/task-039-work-conversations`，专属 worktree `.worktrees/work-conversations`。
- 当前为已验证分支交接；主线 writer 尚需合并并在 main 验证，再由 task tool 标记 done。

## 公共入口与行为

- `packages/yuanpu-protocol/src/index.ts` 添加 `workConversations` 路由、`WorkConversation` 与桌面桥列表/新建/切换/按 ID 读取契约，原 `PROTOCOL_VERSION=4` 未变。`apps/desktop/src/{runtime-manager,main,preload}.ts` 转发到 Runtime。
- `packages/yuanpu-runtime/src/persistence/work-conversation-store.ts` 在 `automation.sqlite` schema v7 保存新工作 ID、各自 Pi Session ID、当前选中项和 `WorkTurnCommitted` 来源。首次打开 Work 才建空会话；Runtime 启动补扫不会凭空建会话。旧 `default` 绑定和 Pi 文件原样保留，只在列表中作只读归档。
- `apps/runtime/src/index.ts` 使桌面 Work 后续提交按所选 ID 路由，并禁止向 `default` 提交，包括通用 `/v1/agent/runs`；旧归档可按 ID 读取。回合成功后及每 60 秒从 Pi 持久记录补扫，Worker 未就绪也不丢来源。
- 来源只在 Agent run 已持久成功、输出已保存、Pi 用户/最终助理消息均存在且匹配时入账；失败、取消和等待审批不入账。重复扫描按会话/回合及 run 去重。
- `sourceChanges()` 映射到既有 `AssistantSourceChange`：稳定来源 ID、内容哈希版本、`personal/local-user` 受众、无路径的哈希 `contentRef` 和工作 ID。宿主通过 `resolveContentRef()` 读取正文；移动 SQLite 存储根不改变来源 ID/版本。
- `apps/runtime/src/agent-runtime.ts` 仅让旧桌面 `assistant` 读取全局 `MEMORY.md`；新 Work、调度及其他工作入口不注入它，工作技能/审批/取消路径仍沿用既有执行器。
- `apps/app/src/modules/chat.tsx` 沿用现有三栏样式接入真实左侧工作列表、新建、切换、旧归档只读和重启恢复。工作切换清除草稿及旧运行/审批状态；审批刷新、展示和执行都受当前会话或导航目标约束。主动建议未进入 Work 页。

## 验证与交接

- 工具链：Node 24.15.0、pnpm 11.22.0、macOS arm64；worktree-kit `prepare`/`doctor` 通过。按仓库命令 `pnpm install --frozen-lockfile --ignore-pnpmfile` 安装；从主工作区只读复制 Git 忽略的 Pi 模型数据后使用 `pnpm build:pi` 离线构建，未修改 Pi 上游源文件。
- 聚焦测试：`work-conversation.test.mjs`、`persistence.test.mjs`、`pi.test.mjs` 通过；`apps/runtime` 全套 27 项通过。覆盖旧归档真实 Pi 历史重开、新会话 ID/Session 区分、成功前/失败后来源排除、重复补扫、存储根移动、全局记忆提示词隔离与真实 HTTP 路由。
- 最终 `pnpm check` 通过：runtime-kit 141、Runtime 27、Desktop 21、App 7 项测试均无失败；记录于 worktree-kit 私有日志 `1790430320375857000.log`。运行中 pnpm 只生成了无关 `pnpmfileChecksum`，已从分支恢复；实现源码在门禁期间未变。独立只读复核的记忆、来源及审批问题已修复并再次确认。
- 浏览器在 1280×577 视口用隔离桥接数据演练“当前工作 → 旧归档只读 → 新建空工作”；截图留在被忽略的 `.tasks/ui/TASK-039/images/implemented-work-list.png`，不是主线持久证据。真实数据持久化由 Runtime HTTP/SQLite 测试证明，尚未跑完整 Electron 真人模型业务旅程。
- 未验证：真实模型回答、助理 Worker 消费来源、SEA 与跨平台打包；分别由后续 TASK-040/TASK-051 和阶段验收处理。来源读取 API 已可供宿主桥接，未实现网络同步。
- 集成风险：主目录已有未提交的 `chat.tsx`、`muse-theme.css`、Desktop 桥、Runtime `index.ts`、protocol `index.ts`、Pi `index.ts` 等同文件修改；需逐块保留现有 subagent、builtin 工具、hotkey 和 transcript-summary 增量，不能直接覆盖。合并后在 main 重跑 `pnpm check`。
- 检索：ZG 查询 `TASK-039 Work conversation isolation ...` 命中 `docs/assistant-memory-proposal.md`、`.tasks/tasks.yaml`、`docs/agent-runtime-contracts.md`；随后 scoped `rg` 精确核对 Runtime、Pi、持久化、Desktop 桥与 Work UI，未创建索引。
