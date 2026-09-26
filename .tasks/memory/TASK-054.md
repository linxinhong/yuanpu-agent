# TASK-054 修复助理与工作目录的 SQLite v8 迁移冲突

- Owner：assistant-architecture-schema-repair-10414；分支 `task/task-054-assistant-schema-repair`；固定 worktree `.worktrees/assistant-architecture`；领取基线 `d4b324d`。本记录用于 owner 分支交接；main 集成和 task complete 由主线 writer 执行。
- 关键词：schema v8 碰撞、Work working_directory、Assistant Host 表、幂等迁移、原子升级、fail-closed。

## 缺陷与修复

- 真实用户库的只读预检发现 Work 目录版 v8：`yp_work_conversations` 已有 `workspace_id` 和 `working_directory`，迁移账本到 8，但缺 `yp_assistant_bindings/requests/deliveries/sources`，旧助理镜像仍在。未读取、复制或迁移真实用户数据库/聊天正文。
- `packages/yuanpu-runtime/src/persistence/index.ts` 将当前版本推进至 10。v9 按实际结构补齐 Work `working_directory`（兼容该列已由另一条开发线以 v8 建立）；v10 在校验现有同名表/索引结构后幂等补建 Assistant Host 对象，并兼容可能已有 v9 但仍缺助理表的库。已标 v10 却缺对象、未知 Work 列结构或不兼容的助理对象会拒绝打开，不猜测修复。
- 所有待执行迁移在同一 `BEGIN IMMEDIATE` 事务中提交；异常时回滚表、列和迁移账本，避免只推进版本或留下半套表。已有助理版 v8 的对象和数据保持原样，旧 Work 会话、企微配对、旧 link/mirror 保持可读；重复打开不重复改写。未重置或清空旧迁移账本。
- 原生 SEA 冒烟的 schema 断言同步更新为 10。

## 回归与证据

- 红灯复现：合成 Work v8 缺四张助理表时旧代码打开后仍为零张表；同名坏表旧代码未拒绝。runner：`.git/worktrees/assistant-architecture/coding-owner/1790437513397452000.log`。
- 绿灯 fixture：合成 Work v8、缺表 Work v9、已有助理表的 v8 均升级并重复打开；验证 Work 会话、企微配对、旧 link/mirror 与助理绑定数据未丢失。不兼容助理表触发整批事务回滚且版本仍为 8；当前 v10 缺表、缺 `workspace_id` 均 fail-closed。聚焦 runtime-kit build/typecheck/persistence tests 通过，日志 `.git/worktrees/assistant-architecture/coding-owner/1790437968582441000.log`。
- 最终 `pnpm check && pnpm build:native && pnpm smoke:native` 全通过（macOS arm64、Node 24.15.0、pnpm 11.22.0），runtime-kit 175/175、Runtime 43/43，SEA 和 staged Runtime update smoke 通过；日志 `.git/worktrees/assistant-architecture/coding-owner/1790438023276169000.log`，执行期间工作树未变化。
- 独立源码复核未见新阻断。TASK-042 verifier 另有无私人正文的真实历史形态 fixture，将在本提交后独立复测并更新阶段验证结果；此处不预称其已通过。
- 未验证：Windows/Linux 原生升级、真实用户 Home 写入迁移、未知高于 v9 的第三方 schema 形态；遇不兼容结构会停止。主工作区含 Work 目录的未提交增量，owner worktree 未覆盖；集成时需保留其业务代码并消解版本号重叠。未改同步 Pi 上游包，未推送。
