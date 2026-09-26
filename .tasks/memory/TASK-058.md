# 工作会话文件树后端阶段验证（TASK-058）

- 2026-09-27；独立验证者 `conversation-verifier-sol-10677-10677`；关键词：Work 文件夹、Pi JSONL、SQLite、迁移恢复、搜索、文件预览。
- 分支 `task/task-058-work-tree-verification`，独占 worktree `/Users/linxinhong/.codex/worktrees/conversation-tree-verification/yuanpu-agent`。集成代码基线 `5ced1c4`，新增回归提交 `396723a`。结果见 `.tasks/verification/TASK-058/results.md`。
- 新增 `apps/runtime/test/task-058-work-tree-stage.test.mjs`：以临时 `YUANPU_HOME` 启动真实 Runtime 子进程，通过认证 loopback HTTP 创建嵌套文件夹与多会话，设置标题/图标/标签/排序/归档，移动子树，交叉读取临时 SQLite/Pi JSONL/磁盘，并在 Runtime 重启后验证历史、预览、搜索、消息定位、解除归档和幂等重试。第二场景验证自身循环、任意 cwd、符号链接及目标占用均拒绝且不覆盖文件。
- 故障窗口复用 `apps/runtime/test/work-directory-move.test.mjs` 的真实 SQLite/Pi JSONL 强杀和注入；24/24 pass。搜索权威复用 `packages/yuanpu-runtime/test/work-search.test.mjs`；2/2 pass。独立 Runtime 场景 2/2 pass。`pnpm check` 通过，Runtime 汇总 116/116。命令、精确模式、日志和剩余风险在结果文件。
- 本地 SSE fixture provider 的真实 Pi Agent 续跑回归验证了搬迁后新 cwd 写入，但不是外网模型验证。没有持久搜索索引，失效情形按 JSONL 缺失/损坏 `contentFailures` 与元数据可用性验证。
- 运行条件：macOS、Node 24.15.0、pnpm 11.22.0；worktree-kit prepare/doctor/install。首次构建因 models.dev 超时；复制主检出已缓存、Git 忽略的 Pi 模型目录到本独立 worktree 后离线 `pnpm run build` 与 `pnpm check` 均通过。未读写真实 `~/.yuanpu`。
- 未验证 Windows/Linux、SEA/native 与真实用户库；linked Git worktree 自动搬迁明确拒绝。该阶段不含 UI。后续 TASK-059 可使用 Runtime 路由 `/v1/work/folders`、`/v1/work/conversations`、`/v1/work/move`、`/v1/work/search`、`/v1/work/messages/window`、`/v1/work/files/content`；TASK-060 仍需桌面 UI 与真实组合验收。
- 检索：宿主未暴露 ZG；按指定入口读取设计、Runtime 测试与移动测试，scoped `rg` 查 HTTP 路由/Store 契约；无索引创建。集成由主任务统一处理，本分支不 complete/push。
