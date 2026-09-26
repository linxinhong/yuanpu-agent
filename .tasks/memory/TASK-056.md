# TASK-056 安全搬迁工作会话及文件夹的磁盘目录

- 日期：2026-09-27；owner conversation-move-astra-10677；分支 task/task-056-work-directory-move。
- 独占 worktree `.worktrees/conversation-move-astra`；claim 基点 97cb2f8；依赖 TASK-055 在 main 664b9fd done。
- 授权边界：本分支实现、验证及独立复核后交给主任务集成 main/complete；本分支不 push、不操作真实用户 Home。

## 实现与契约

- `apps/runtime/src/work-directory-move.ts`：受控 move 服务、HTTP 读租约、同卷目录和工具状态搬迁、仅 header 改写、恢复协调器。
- `packages/yuanpu-runtime/src/persistence/work-conversation-store.ts`：既有 metadata 表保存 journal，cwd/绑定/树路径与 committed 标记同事务；历史 run、来源 ledger 不改写。会话列表给出 previousWorkingDirectories。
- `packages/yuanpu-runtime/src/pi/index.ts`、`apps/runtime/src/agent-runtime.ts`：验证 Pi findById，缓存定向 awaitable drain，后台子任务/工作流/goal 检查，dispose 等待实际收尾。
- `apps/runtime/src/index.ts`：启动先恢复，来源补扫 busy 跳过；HTTP 统一租约覆盖预览、transcript、两个 run 提交入口、创建/管理与审批。move 本身持独占闸门。
- protocol v6：`WorkMoveRequest {requestId,kind,id,targetFolderId}`；`WorkMoveResult` 返回会话 ID、旧目录和历史引用提示；Desktop IPC/manager/preload 已接。树拖放 UI 属后续卡；现有聊天页只加历史路径提示。
- cwd 派生 goals/workflows stateRoot 与工作目录一起 journal rename，保留原存储公式。无缓存时也解析持久状态；未知/活动/待 checkpoint 拒绝。
- 恢复：prepared 回滚，committed 续迁，done 幂等返回；目录 inode/device、header 两种允许值与正文哈希核对。冲突时保留 journal 并阻止继续操作。

## 检索与环境

- 预检 ZG 查询 Work cwd/Pi findById/JSONL/source ledger/活动执行关系，返回 fresh；部分 Work store 片段落后于 TASK-055 分支，因此用定点源码读取校正。相关路径为 session-manager.ts、pi/index.ts、work-conversation-store.ts、agent-runtime.ts、Runtime index；无索引创建/重建。
- Node 24.15.0 / pnpm 11.22.0；worktree-kit 已 prepare/doctor，所有验证命令走该 runner。
- 文档的 `pnpm install --frozen-lockfile --ignore-pnpmfile` 遇 pinned pnpmfileChecksum 不匹配，改 `pnpm install --frozen-lockfile` 成功，未改锁文件。
- models.dev 网络超时；复用 main 忽略的 `packages/ai/src/providers/data` 后 `pnpm build:pi` 通过。`pnpm build:runtime` 会重复调用 Pi 在线模型生成，因此后续按根 build 的既有流程 build:pi 后仅构建 Yuanpu 包；未修改 Pi 上游。

## 验证与独立复核

- 首个真 SQLite/Pi JSONL 测试通过：移动、重启、findById、历史保留与追加；日志 `1790449627770965000`。
- 最终 focused：`node --test apps/runtime/test/work-directory-move.test.mjs` 全部 24 项通过；日志 `1790450175511005000`。包括 5 个 SIGKILL 点重启恢复、SQLite 提交失败回滚、多后代部分 header 回滚、来源 ID/版本/游标不变、归档与空会话、POSIX mode、租约、非法路径、附加绑定、持久工作流以及真实 loopback 模型下一轮在新 cwd 写入/预览。
- 构建、Yuanpu 全类型检查及 Runtime HTTP move/preview/幂等重试聚焦验收通过；日志 `1790450098413913000`。真实模型使用本地 fixture provider，无外网模型调用。
- 独立只读 reviewer `review_move` 检查迁移顺序、恢复、路径、来源 ID、预览竞争、权限；初查 3 个 P2 已修复：持久 checkpoint 漏检、Git worktree 注册破坏、umask 权限变化；增量复核无新阻塞 P1/P2。额外建议的未知工具状态 fail-closed 已补回归。
- 全量 `pnpm check` 最终通过；日志 `1790450371414911000`，耗时 73.41 秒，测试期间工作树未变化。首轮日志 `1790450274962051000` 仅 Desktop fixture 的旧协议常量造成 7 项失败；修正为 v6 后单跑 Runtime manager 通过（`1790450336619983000`），再重跑全量成功。

## 限制与接力

- 没有 Windows/Linux、SEA/native、真实用户库或新树 UI 手工验收。macOS 上覆盖真实文件/SQLite/Pi/Runtime 重启与强杀。
- 拒绝 linked Git worktree、主库 worktree 注册和 core.worktree 配置，避免损坏绝对 Git 注册；需未来显式 Git 搬迁流程。
- Node `rename` 没有跨平台 no-replace/目录句柄原子隔离，恶意同用户外部进程在检查与操作间换路径的 TOCTOU 仍存在；当前保护本进程租约与正常文件冲突，不能宣传为恶意进程隔离。
- 审批/活动工具状态必须先解决；恢复冲突时保留意图、拒绝继续运行，启动时自动重试恢复。
- TASK-057 搜索接入同一 HTTP acquireRead()/busy 契约，路由返回后 finally 释放；源码所有权暂由本卡独占共享接线文件。后续搜索卡再升协议 v7。
