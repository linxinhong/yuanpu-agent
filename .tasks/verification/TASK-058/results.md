# 工作会话文件树后端阶段验证（TASK-058）

## 范围与环境

- 验证者不参与 TASK-055/056/057 的实现。本报告以 `5ced1c4` 的集成代码为基线，新增的独立回归提交为 `396723a`，路径 `apps/runtime/test/task-058-work-tree-stage.test.mjs`。检查运行时该测试文件内容与 `396723a` 一致，报告尚未提交；运行环境为 macOS、Node 24.15.0、pnpm 11.22.0。
- 仅使用 `mkdtemp` 创建的临时 `YUANPU_HOME`，通过真实 Runtime 子进程的认证 loopback HTTP 调用管理、搜索、预览和历史 API；直接读取该临时 Home 中真实 SQLite、Pi JSONL 与工作文件作为交叉事实。每例结束删除临时 Home。模型续跑使用本地 SSE fixture provider；没有调用外网模型或真实用户数据。
- 权威预期来自 `docs/work-conversation-tree.md` 与 TASK-058 卡。Pi JSONL 是正文权威，SQLite 保存树与绑定，文件系统保存工作文件。迁移目标由稳定 ID 决定，历史正文和来源 ID 不应变化。
- 检索记录：本宿主没有可调用的 zvec-grep 工具；从卡片指定的 `docs/work-conversation-tree.md`、`apps/runtime/test/runtime.test.mjs` 和 `work-directory-move.test.mjs` 定点读取，再以 scoped `rg` 定位 Runtime HTTP 路由与 Store API；未创建或重建索引。

## 场景与结果

| ID | 预期、执行及观察 | 模式 | 状态 |
| --- | --- | --- | --- |
| V58-01 | 用真实 HTTP 创建 `Clients/Review` 与两个会话；目录均落在临时 workspace。改标题、图标、标签、排序并归档一个会话。把 `Review` 子树迁至 `Moved here` 后，两个 cwd 都改变，SQLite 会话 cwd 与绑定一致，标题、图标、标签、顺序及归档状态保留。 | Runtime HTTP + SQLite + 磁盘；独立回归首例 | pass |
| V58-02 | 在被归档会话的 Pi JSONL 保存可见消息；搬迁后正文行逐字节一致，header cwd 改为新目录，Pi session ID 不变。Runtime 预览返回原文件，搜索以旧 entry ID 命中并给出最新祖先路径；消息窗口可定位。Runtime 进程重启后历史、预览、搜索、元数据仍一致；在新 cwd 重新打开 Pi session 并追加一条，Runtime 历史变成三条；解除归档后默认搜索可见，原 move request 幂等。 | Runtime HTTP + Pi SessionManager + SQLite + 磁盘；独立回归首例 | pass |
| V58-03 | 文件夹移入自身、直接 PATCH 任意 cwd、源目录内符号链接、占用的目标目录被拒绝。原工作文件与被占用目标文件均未覆盖，SQLite cwd 不变。 | Runtime HTTP + SQLite + 磁盘；独立回归第二例 | pass |
| V58-04 | 在 prepared、directory、header、committed、settled 五个检查点强杀子进程并重启恢复；每次恰有一个权威目录及匹配 JSONL header，重试能完成。另注入 header 中途异常、SQLite 提交失败、多后代部分 header 更新，确认回滚；活动 run、待审批、持久工具状态、根外 cwd、linked Git worktree、符号链接和冲突被拒绝。 | 复用 TASK-056 的真实 SQLite/Pi JSONL 与故障注入测试；非独立新增用例 | pass |
| V58-05 | 消息检索只返回当前 Work 范围的可见用户/助理文本。归档筛选、祖先路径、标签、分页、早于最近 100 条的 entry ID 窗口均正确；损坏或删除 JSONL 时返回 `contentFailures`，元数据仍可找。实现每次读取权威 JSONL，没有持久索引可失效或重建；本例验证了相应的权威扫描及内容不可用边界。 | 复用 TASK-057 的真实 SQLite/Pi JSONL 回归；非独立新增用例 | pass |
| V58-06 | 搬迁前后通过本地 SSE fixture provider 触发真实 Pi Agent 工具写文件；第二轮 run 使用新 cwd，原 session 绑定、历史与来源 ID 保持。 | 复用 TASK-056 的 RuntimeAgentExecutor + PersistentAgentService 行为测试；模型输出为确定性本地 fixture | pass |
| V58-07 | Windows/Linux、打包 SEA/native、真实用户会话库和外部模型服务未在本 macOS 源码 Runtime 验证。 | 平台/环境限制 | unverified |

阶段必需的 V58-01 至 V58-06 均通过；没有阻塞产品缺陷。本阶段没有独立 UI 验收，留给 TASK-060。Node 文件 API 对恶意同用户进程更换目录的 TOCTOU 防护，以及 linked Git worktree 的专门迁移流程，是设计文档已知限制；本结果不扩大其保证。

## 命令与证据

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node --test test/task-058-work-tree-stage.test.mjs`（`apps/runtime`） | 2/2 pass | worktree-kit `task058-stage-focused-v3`，私有日志 `1790453116871855000.log` |
| `node --test test/work-directory-move.test.mjs`（`apps/runtime`） | 24/24 pass | worktree-kit `task058-move-faults`，私有日志 `1790453131685670000.log` |
| `node --test test/work-search.test.mjs`（`packages/yuanpu-runtime`） | 2/2 pass | worktree-kit `task058-search-authority`，私有日志 `1790453126120607000.log` |
| `pnpm check` | pass；构建、类型检查与全部测试通过，Runtime 116/116 | worktree-kit `task058-pnpm-check`，私有日志 `1790453147682222000.log` |

依赖安装使用隔离 worktree。首轮 `pnpm run build` 因 models.dev 网络超时失败；将主检出已有、被 Git 忽略的 Pi 模型数据复制到本 worktree 的同一忽略目录后，离线构建通过。该数据只是构建输入，不是消息、会话或测试断言的替代品。
