# TASK-057 工作文件夹与会话内容搜索

- 日期：2026-09-27；owner conversation-search-sol-10677；分支 `task/task-057-work-search`，独占 worktree `.worktrees/conversation-search-sol`。
- 关键词：Work 搜索、Pi JSONL 可见消息、entryId、祖先路径、归档、分页游标、读租约。
- 依赖：TASK-055 已在 main 完成；本分支先合入 TASK-056 验证分支 `0bfba5b`，形成 merge `519bc5b`，再接线。
- 实现提交 `02f136d`、`b051e1b`、`1acaf3c`、`72e066c`，协议断言修复 `317fd69` 为已验证代码 HEAD。主线集成及卡片 complete 由主任务负责；没有 push 或操作真实用户 Home。

## 入口与行为

- `packages/yuanpu-runtime/src/pi/work-message-search.ts`：受限读取管理目录中的 Pi JSONL，只从当前 `SessionManager.getBranch()` 提取 `message.role` 为 user/assistant 的字符串或 text 块。thinking、toolCall、toolResult、system、诊断与工具参数/结果不进入结果。每个可见消息保留 Pi entry ID 与分支位置。
- 同模块 `readSavedWorkMessageWindow` 按 entryId 返回最多 101 条可见消息和目标下标；支持默认 transcript 仅显示末尾 100 条时定位更早命中。
- `packages/yuanpu-runtime/src/persistence/work-search.ts`：`searchWorkConversations` 从当前 Work scope 查询标题、祖先文件夹名、标签与可见正文；结果带稳定 conversationId、messageEntryId、最新树路径、摘要、归档状态。旧 `default` 保持历史只读入口。
- 搜索不写持久索引，每次从 Pi JSONL 和 SQLite 权威数据读取；文件缺失、损坏、不可读、过大或总扫描预算耗尽通过 `contentFailures` 明示，元数据结果仍可返回。查询长度 1–200，页大小 1–50，单文件 32 MiB、单次扫描 128 MiB。
- keyset 游标绑定查询、scope、归档筛选和当前结果摘要；改名、移动或新消息令旧游标显式失效，避免静默跳项。
- protocol v7 的 `WorkSearchQuery/Result`、`WorkMessageWindowResult` 经 `apps/runtime/src/index.ts` 两条 GET 路由和 Desktop runtime-manager/main/preload 转发。Runtime 注入 scope 与 sessionsPath；Renderer 无绝对路径输入。两路由在 TASK-056 的 HTTP `acquireRead()` 租约内，finally 释放。

## 检索、验证与限制

- ZG 查询 TASK-057/055、Pi JSONL/Runtime/Work store 关系，返回 fresh；再用定点 `rg`/源码读取核对 session-format、`transcript-summary.ts`、store、协议与 Desktop 路由。没有创建或重建索引。
- Node 24.15.0 / pnpm 11.22.0；worktree-kit prepare/install 后复用 main 忽略的 Pi model data。直接 `pnpm build:runtime` 会让 Pi upstream 再向 models.dev 请求并超时，改根 `pnpm check` 的离线 hydration 流程成功。
- 聚焦 `node --test test/work-search.test.mjs`：真实临时 SQLite/Pi JSONL 验证 scope、隐藏字段过滤、归档、标签、祖先路径、分页、重命名旧游标、损坏/缺失和 >100 消息 entryId 窗口；日志 `1790451665236086000.log`。
- Runtime 真实进程测试验证搜索、窗口、无效请求与异域 404，以及搬迁前后 Pi entryId 不变、路径与 cwd 更新；日志 `1790451665236088000.log`。Desktop RuntimeManager 桥接聚焦测试通过，日志 `1790451640547477000.log`。
- Yuanpu 全类型检查通过，日志 `1790451665451059000.log`。独立只读 reviewer `review_search_wiring` 对 HEAD `72e066c` 未发现 P1/P2；此前核心 reviewer 的分页、无关文件读取和 ENOENT 分类问题均已修复。
- 最终 `pnpm check` 在 `317fd69` 全通过；日志 `.git/worktrees/conversation-search-sol/coding-owner/1790451784971829000.log`。首次全量仅 Desktop 旧协议版本正则失败，修正后聚焦和全量均通过。
- Renderer 搜索框、点击与滚动属于后续 TASK-059；UI 必须保留 DTO 的 Pi entryId，并在早期命中时调用窗口 API。未验证 Windows/Linux、SEA/native、真实用户库或大型真实会话的交互延迟；若 128 MiB 扫描预算妨碍使用，再按卡片升级为可重建本地索引。
