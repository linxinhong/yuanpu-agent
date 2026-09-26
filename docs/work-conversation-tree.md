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
