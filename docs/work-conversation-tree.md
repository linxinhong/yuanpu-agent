# 工作会话文件夹树：数据、磁盘与会话边界

设计基线：[文件夹树原型 v003](../.tasks/ui/conversation-management/prototype-v003.md)。用户已确定只用可嵌套文件夹与标签，不引入项目类型；拖动会话到文件夹时同步搬迁实际工作目录。本文件固定实施边界，任务状态以 [注册表](../.tasks/tasks.yaml) 为准。

## 当前事实

- Work 列表由 `WorkConversationStore` 保存稳定会话 ID、Pi session ID、时间、当前选中项和 `working_directory`；旧 `default` 只读。`WorkConversation` 尚无标题、文件夹、图标、标签、排序或普通归档状态。
- 新 Work 默认在 `~/.yuanpu/workspace` 下生成独立目录；Runtime 在运行、读历史和来源补扫时使用会话的 `working_directory`。
- Pi `SessionManager` 默认按 cwd 派生 session 目录；Yuanpu 当前显式使用 `~/.yuanpu/agent/sessions`。`SessionManager.findById(cwd, id, directory)` 在这个显式目录下仍用 JSONL header 的 cwd 过滤。只改 `working_directory` 或只移动磁盘目录，会导致历史会话查找失败，甚至被误建为新会话。
- `yp_conversation_bindings.workspace_id` 当前绑定实际工作目录；运行记录与来源事件存在历史引用。聊天 JSONL 仍是会话记录权威，不用树节点替换。
- 工作对话右侧栏文件预览（TASK-052）与本功能同样按会话 ID 解析工作目录，正在实施；修复助理与工作目录的 SQLite v8 迁移冲突（TASK-054）正在实施。新 schema 版本必须以修复完成后的 main 为基线分配。

取证：ZG 查询 Work 会话创建/存储、Pi JSONL lookup/cwd、目录搬迁与树 UI，命中 `packages/yuanpu-runtime/src/persistence/work-conversation-store.ts`、`packages/yuanpu-runtime/src/pi/index.ts`、`packages/coding-agent/src/core/session-manager.ts`、`apps/desktop/src/runtime-manager.ts`；再用 scoped `rg` 核对 Runtime 路由、DesktopBridge、现有 UI 和迁移版本。查询返回 `freshness: fresh`，未创建或更新索引。

## 模型与契约

- `folder`：稳定 ID、父文件夹 ID、显示名、图标 ID、同级顺序和实际相对目录。文件夹可嵌套，无「项目」子类型；根下有系统「未分类」容器。
- `conversation`：稳定 Work ID、Pi session ID、标题、图标 ID、父文件夹 ID、同级顺序、工作目录、归档状态/时间。目录变更不改 Work ID、Pi session ID、已落盘来源 ID。
- `tag`：稳定 ID、名称、外观以及会话关联；一个会话可有多个标签。标签不参与目录路径，也不因移动继承或丢失。
- 树中「文件夹」与物理 `~/.yuanpu/workspace` 目录一一对应。磁盘目录使用稳定、安全的 ID 命名；文件夹或会话的显示名改变时不重命名磁盘目录。新会话在所在文件夹下仍拥有独立叶目录；通过 `conversationId` 可找到当前 cwd。所有服务端写操作以稳定 ID 授权，Renderer 不提交任意绝对目标路径。
- 可恢复的普通归档是会话状态，保留原文件夹与磁盘目录。旧 `default` 历史是独立、不可恢复、不可直接移动的兼容入口；不得把它当作普通归档记录更新。
- `~/.yuanpu/agent/sessions` 继续存 Pi JSONL。树不直接暴露该目录；重命名/移动工作文件夹不把 JSONL 当作普通工作文件搬运。会话内容、旧工具输出与原始用户文字不因路径变化被静默改写。

## 磁盘移动不变量

1. 只在没有活动 run、待审批或进行中的提交时启动移动；受影响的整个文件夹子树都须静止。移动源/目标通过受管理根下的 canonical 路径、realpath 与符号链接检查。文件夹不得移入自己或后代；目标不得覆盖现存内容。
2. 对管理根内的会话做同卷移动，记录可恢复的迁移意图；更新所有后代会话 cwd、会话绑定与 Pi JSONL header cwd，再验证 `findById`、历史读取、下一轮运行与文件预览可读。SQLite 事务无法覆盖文件系统与 JSONL，必须支持失败回滚和重启修复，不能用一半成功的状态继续运行。
3. 对用户手动选定的根外 cwd 或跨卷目标，不经明确导入流程就拒绝树拖放；不静默搬迁外部文件、跟随符号链接或复制后删除。该限制在 UI 给出具体原因。
4. 目录移动后，历史运行记录中的旧绝对路径保持历史原文；在界面提示可能失效的旧路径引用。来源 ID 与既有版本不重算；以后新增运行使用新 cwd。
5. 新建/移动/文件夹重命名、归档、标签修改都以幂等或冲突可识别的服务操作实现；失败后原会话仍可打开。目录空会话尚无 JSONL 时也要可移动。

## 搜索与界面

搜索覆盖文件夹名、会话标题、标签和已保存的用户/助理消息。Pi JSONL 为消息权威；任何索引只是可重建缓存，不能独立改变聊天历史。结果保留命中项祖先路径，消息命中给摘要与定位点；搜索时禁止拖放以免隐藏目标导致误放。归档筛选不删除记录。

左侧继续在全宽顶栏下与正文同层。视觉基线是 [v003 原型图](../.tasks/ui/conversation-management/images/proposal-v003.png)；图中第三方头像、侧栏实际宽度和回复按钮仅为示意，实施沿用 Yuanpu 组件与三套主题 token。现有 `apps/app/src/modules/chat.tsx` 与右侧文件预览工作相交，前端卡应在工作对话右侧栏文件预览（TASK-052）集成后，由单一 writer 接入。若使用 `@pierre/trees`，其 path-first 交互键只作 UI 映射，不替代 Yuanpu 稳定 ID、物理路径授权或迁移事务。

## 交付次序

1. 在修复助理与工作目录的 SQLite v8 迁移冲突（TASK-054）完成后，实施文件夹/会话/标签元数据与管理契约。
2. 目录搬迁与内容搜索可在共享契约完成后分别实施；目录搬迁需等工作对话右侧栏文件预览（TASK-052）集成后验证工作区预览重定位。
3. 后端阶段验证覆盖真实 Runtime/SQLite/Pi JSONL 与故障注入，再接树状 UI。
4. 完整业务验收覆盖新建、嵌套、重命名、移动、重启、搜索、归档恢复、标签、图标及旧 `default`，区分真实数据与 fixture。

分支会话、任意外部路径导入和云端团队同步不在这组卡内；它们继续沿各自功能边界规划。

## 受控目录搬迁实现（TASK-056）

`POST /v1/work/move` 接受 `requestId`、`kind`、稳定节点 `id` 与 `targetFolderId`；
Desktop 使用 `moveWorkNode`，协议版本为 6。相同请求可安全重试；普通 PATCH 仍不能直接改 cwd 或父节点。
迁移结果与会话列表提供旧目录提示，历史正文、来源版本和 run 请求中的绝对路径不变。

Runtime 的 `WorkDirectoryMoveCoordinator` 对 HTTP 读取/提交/管理操作使用租约，移动期间拒绝新租约，
现有读操作完成前拒绝启动移动；来源补扫在移动期间跳过。当前采用全局 Work 闸门，优先保证一致性。
受影响会话有 queued/running/waiting_approval、后台子任务、工作流、活动目标或持久 checkpoint 时拒绝；
只有唯一匹配的 Work/Pi 绑定可搬迁。无缓存的会话也会检查持久工具状态，未知状态失败关闭。

迁移意图复用 `yp_runtime_metadata` 的 `work.move.<requestId>` 键，不单独占用 schema 版本。
流程为：记录意图 → 同卷 rename 工作目录与 cwd 派生工具状态目录 → 原子替换 JSONL header →
单一 SQLite 事务更新全部 live cwd/绑定/树路径并标记 committed → 验证 Pi 发现 → 保存 done。
未 committed 的故障回滚到旧目录；committed 后重启续迁到新目录。启动修复先于 Agent scheduler、来源扫描及 HTTP 服务。
若目录身份冲突、正文被并发改写或权限阻止恢复，则保留意图并禁止继续读写，不覆盖或删除冲突对象。
JSONL 正文逐字节保留，header 未知字段与权限保留；Pi session ID 和 JSONL 文件位置保持不变。

自动搬迁拒绝根外 cwd、跨卷、符号链接、特殊文件、已存在目标、额外 session 绑定及损坏/歧义历史。
含 linked Git worktree 的 `.git` 文件、主库 worktrees 注册目录或 `core.worktree` 配置也拒绝，
因为直接 rename 会破坏 Git 的绝对注册关系；需要未来的显式 Git 搬迁流程。
预检与 inode/device 复验保护普通应用内竞争，但 Node 文件 API 不能消除恶意同用户进程在检查与 rename 间替换路径的 TOCTOU；
不将本实现描述为对同用户恶意进程的原子文件系统隔离。Windows 的目录 fsync 不受 Node 支持，
本轮强杀恢复与 POSIX 权限测试在 macOS 执行，其他平台仍需实际验证。
