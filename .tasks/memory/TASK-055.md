# TASK-055 工作会话文件夹与标签管理契约

- 日期：2026-09-27；owner conversation-tree-sol-055-10677；分支 task/task-055-work-tree-contract，worktree .worktrees/conversation-tree-sol。
- 关键词：Work folder tree、SQLite v13、稳定目录 ID、标签、普通归档、requestId、创建意图、协议 v5。
- 来源：claim 9c9648c；实现 375bbba、重试修复 9ecd819，依赖独立测试稳定性提交 89806d1。主线集成提交 `4015d50`，后续交接补充于 `a59d4b8` 合入；卡状态由任务工具结项。

## 入口与行为

- 协议 packages/yuanpu-protocol/src/index.ts：WorkConversation 新字段、WorkFolder/WorkTag、文件夹/标签/排序路由与 DesktopBridge 管理方法。协议从 v4 升到 v5，现有版本门禁拒绝新旧 Desktop/Runtime 误配。
- 持久层 packages/yuanpu-runtime/src/persistence/index.ts v13 迁移与 work-conversation-store.ts：文件夹、标签及多对多关联，会话标题/图标/排序/归档时间。旧绑定、来源、Pi ID 保留；default 仍只读，普通归档时间为 null 且不能恢复。
- Runtime apps/runtime/src/index.ts、workspace-directory.ts：folder UUID/work UUID 对应安全的 f-UUID/c-UUID 磁盘目录；显示名变更只更新 SQLite。未分类是虚拟根，数据库父节点为 null。选中、历史和文件预览继续按会话 ID 取 cwd。
- Desktop 的 runtime-manager.ts、main.ts、preload.ts 接入路由/IPC；Renderer 无绝对目录写入口。跨文件夹物理移动、消息搜索、树 UI 属后续卡；更新接口明确拒绝改变父节点或 cwd。
- 创建可带 UUID requestId；持久唯一索引支持丢失响应后重试，现有聊天页在失败重试时复用 ID。复用同一 ID 更改文件夹/标签参数会被拒绝。目录创建前写 SQLite 意图，重启清理未提交的空叶目录；非空异常目录保留并阻断恢复。根和父级符号链接被拒绝，创建后复验路径。

## 取证与验证

- ZG 搜索 WorkConversationStore/迁移/Runtime/Desktop 的关系，命中 work-conversation-store.ts、persistence/index.ts、apps/runtime/src/index.ts、runtime-manager.ts；freshness 为 fresh，未建索引。主工作区未跟踪的 v003 原型只读参考；磁盘名以已跟踪设计和卡片为准。
- Node 24.15.0 / pnpm 11.22.0；worktree-kit 已 prepare/doctor。首次 Pi 构建因 models.dev 连接超时失败，复制主检出忽略的 packages/ai/src/providers/data/ 后离线 pnpm build:pi 通过。
- 聚焦构建/类型检查与 runtime-kit 的 Work/持久层测试通过；Runtime 全包 58/58 通过，日志 .git/worktrees/conversation-tree-sol/coding-owner/1790444767478439000.log。
- 合并前最终 pnpm check 全量通过，日志 .git/worktrees/conversation-tree-sol/coding-owner/1790445510293072000.log（含重试修复）。首次全量因旧 Desktop 版本断言与并行 crash fixture 的连接重置失败；第二次因真实 Python MCP 初始化超出默认五秒失败。断言更新归实现提交；两项测试时序容差单列 89806d1，未改生产超时或跳过断言。
- 合并 main 后，Work/persistence 聚焦检查通过；Runtime 全包首跑有新主线并行启动五秒超时（71/74），随后单独 Work 路由/文件预览/目录安全检查通过，日志 .git/worktrees/conversation-tree-sol/coding-owner/1790445666764473000.log。合并结果的 pnpm check 最终全量通过，日志 .git/worktrees/conversation-tree-sol/coding-owner/1790445689509766000.log；无其他 owner 测试代码修改。
- 后续 main 的 UI 提交 1a7bf1e 在独占 worktree 无冲突合入为 26aff69；chat.tsx 的创建重试 UUID 逻辑保留，文件预览标签页改动未覆盖。App typecheck/test 和 Work/persistence 聚焦检查通过，日志 .git/worktrees/conversation-tree-sol/coding-owner/1790447863468281000.log。该合并树的 pnpm check 全量通过，日志 .git/worktrees/conversation-tree-sol/coding-owner/1790447879608776000.log。

## 限制与后续

- 合并后的 macOS arm64 `build:native && smoke:native` 已通过；Windows/Linux、真实用户库写入迁移及桌面树 UI 手工验收未运行。合成旧库升级及重复打开已覆盖，native smoke schema 断言已改 v13。
- requestId 对未来文件夹/标签调用仍可选；后续树 UI 应为每次创建生成并在重试时复用。无 ID 的调用可创建多个同名节点；现有新会话按钮已传稳定重试 ID。
- JavaScript 文件 API 无跨 SQLite/文件系统原子提交；意图恢复只删除空的未提交叶目录。恶意同一用户进程持续在检查与 mkdir 间替换父路径仍需底层目录句柄式原子操作才能完全消除；当前实现复验并拒绝继续。
- 主线已按 v13→v14 顺序接入 TASK-061，并接入 TASK-046；任务工具的完成证据记录最终校验。未推送。
