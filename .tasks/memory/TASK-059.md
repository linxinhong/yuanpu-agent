# 接入工作会话文件夹树管理界面（TASK-059）

- 2026-09-27；owner `conversation-tree-ui-sol-10677-10677`；独占 worktree `/Users/linxinhong/.codex/worktrees/conversation-tree-verification/yuanpu-agent`，分支 `task/task-059-work-tree-ui`。实施基线 `259a2bb`。集成由主任务负责，本分支不标 done、不 push。
- 实现 `WorkTree` + 独立树模型：真实服务数据驱动的无限层级，创建/重命名/图标/多标签/排序/归档恢复/拖放/移动到，搜索分页及 Pi entryId 历史定位。维持全宽顶栏下的左栏、右侧文件预览与宽度调整；三主题使用语义 token。
- 服务端补最小持久 run 守卫：已存在的 Work run 处于 queued/running/waiting_approval 时，切换、新建、归档和已归档只读预览均拒绝，避免重载后审批上下文错位；仅检查当前 Work workspace 的 desktop binding。`previewArchived` 不改当前会话。
- 聚焦模型测试、真实 Runtime 守卫测试通过。隔离 Runtime + 浏览器旅程通过；最终全量构建/类型检查通过，Runtime 并发测试有既有临时 Home 清理竞态，串行全集 117/117 通过。命令、fixture 边界及截图见 `docs/frontend/evidence/task-059/results.md`。获批原型的可跟踪摘要见 `docs/frontend/work-tree-v003.md`。
- 独立只读复核发现的搜索 50 条截断、隐藏归档排序、持久 run 切换及 active `previewArchived:false` 兼容问题均已修正。剩余 Windows/Linux、SEA/Electron 实机与真实用户库属于后续集成/验收。
- 追加窄屏复核：≤560px Work 树与正文单列，左树作为覆盖层；Work 右栏非 modal 并从顶栏下方展开，使顶部左右展开按钮可操作。480px 浏览器真实交互与截图已纳入结果文档；桌面宽度的右栏拖宽/70%→全屏路径未触及。
