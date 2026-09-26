# TASK-043 实现来源与可修订记忆存储

- Owner：assistant-architecture-memory-10414；分支 `task/task-043-assistant-memory`；固定 worktree `.worktrees/assistant-architecture`；领取基线 `53b4848`；初始实现提交 `d28074e`、`cff0c4a`，本轮复核修复见分支后续提交。主线负责集成和卡状态。
- 关键词：来源游标、opaque contentRef、Assistant Worker IPC、Markdown 修订、人工纠正、遗忘、中文检索、SQLite v12。

## 实现与边界

- `packages/yuanpu-assistant/src/memory-sources.ts` 暴露 `AssistantSourceHost.listChanges/currentSource/readSource` 窄接口。Host 解析不透明引用，Worker 不按 `contentRef` 打开本机路径；Work/Assistant 来源按 feed、事件 ID、版本哈希、受众入 `state.sqlite` 持久队列，页及游标同事务提交。最新权威版本只按相等比较；暂不可用轮转重试且保留旧认识；已删除清除原文索引并驱动撤回；旧事件乱序、重复及重启均不重复处理。来源正文索引上限 32,000 字符；当前无稳定产物引用来源。
- `memory-documents.ts` 管理 `memories/work/reviews/suggestions` Markdown；`user-summary`、`core-memory` 对应核心 `USER.md`、`MEMORY.md`。每篇有稳定 ID/版本/性质/受众/情境/核实时间/证据/依赖；SQLite 写入意图、fsync 临时文件和目录、原子替换与启动重放防止文件/索引分叉。人工直接编辑提升版本和权威性，自动提交需 CAS；冲突拒绝覆盖。删除/版本变化来源时，撤回失去有效证据的认识并级联依赖；暂不可用的同版本证据不会阻止撤回，人工纠正保留。搜索先刷新直接编辑的 Markdown 再查询索引。遗忘写持久 job，清除历史修订曾引用同源的文档及派生评估/建议、索引、文件和修订快照，旧来源 ID 墓碑防回流。
- `RuntimeAssistantSourceHost`、`AssistantWorkerManager`、`assistant-worker.ts` 接通 Runtime Host → 专属 Worker 的私有来源 RPC。启动后异步按页扫描 Work/助理已保存文本回合，单次最多 100 条入队、50 条处理，每 5 秒补扫；来源失败不阻塞用户回合或 Worker ready。Host 校验 personal `local-user` 和 ref/source/version 绑定后才返回有界正文。Worker 单写 Home，退出回收。
- Work 的 `sourcePage` 使用 v11 持久 `event_id`，由独立序列表和插入触发器分配；旧行一次回填，VACUUM、重启和删除最大来源行后都不复用已确认游标。AssistantHost 来源页按 SQL `LIMIT`，双方按 ID 直取权威版本，避免全表装入 JS。
- 旧 `agent/memory/MEMORY.md` 的只读导入由 Host 提供 bounded snapshot 和 v12 持久单调版本事件，A→B→A 仍产生不同事件 ID。Host 检查父目录、以 `O_NOFOLLOW` 打开并经 fd 校验普通文件/大小；Worker 只收到正文和证据，不直接读取旧 Work/Agent 目录。自动导入随来源版本更新，用户手改文档则保留原文并记冲突。未把个人记忆注入 Work 或子代理，未改 Pi 上游。

## 验证和限制

- 聚焦：Assistant 文档/队列 14 个测试、Work v8/v9/v10→v11→v12 迁移、VACUUM/删最大行游标、真实 Runtime Manager→Worker 来源/删除/旧记忆 RPC 与重启去重、205 条 Work 来源 100/100/5 分页均通过。复核回归涵盖暂不可用无新事件恢复、依赖级联撤回、直接编辑后立即检索、历史修订同源遗忘、旧 MEMORY A→B→A 内容回归与人工编辑保护。证据 `1790442167664333000.log`、`1790442727856366000.log`。
- 最终 `pnpm check && pnpm build:native && pnpm smoke:native` 全通过且源码运行中未变，macOS arm64、Node 24.15.0、pnpm 11.22.0；Assistant 14、runtime-kit 176、Runtime 46 测试通过，SEA 和更新 smoke 通过。证据 `.git/worktrees/assistant-architecture/coding-owner/1790442752168083000.log`。一次全量测试遇 desktop `setTypeOfService EINVAL` 环境瞬态失败，隔离复跑与后续全量均通过。
- **尚未满足产物来源验收**：现有 `yp_work_turn_sources` 与 `yp_assistant_sources` 只持久化回合文本引用；`yp_agent_run_outputs` 工具信息仅 `{name,status}`，无稳定且可授权读取的 artifact ID/ref。当前 Host 不凭输出文字或绝对路径猜产物，返回无产物引用。主线新建 TASK-061「建立工作工具结果与产物的助理来源契约」，应补持久 artifact ledger、授权读取、旧 Pi Session 回填边界、删除/离线事件；TASK-044 依赖该卡。不可把本实现称为全量产物已收集。
- v12 Host 生命周期账本提供 `markDeleted()`，生产 Host 调用后会发稳定删除事件，真实 Manager→Worker 测试已验证撤回；当前没有用户删除动作调用它，不能称用户删除或旧 Session 失效会自动撤回。Host 无法解析已排队引用时只报暂不可用而不猜测删除；后续 Work/助理删除入口应显式调用 `markDeleted()`。
- 搜索前刷新所有 Markdown 文件，语义正确但成本随文档数线性增长；旧 MEMORY 快照限 64 KiB，超限拒绝导入。其他受众仍只支持 `personal:local-user`。
- 未验证 Windows/Linux 原生包及真实历史产物迁移；TASK-042 的真实企业微信往返由独立阶段验收记录，不是本卡来源测试。生产来源适配当前仅 `personal:local-user`，其他受众明确拒绝。索引可重建，不能删除 `state.sqlite` 来“重建”队列或遗忘墓碑。
- 检索证据：当前 host 未暴露 zvec-grep 工具；按精确符号 `sourceChanges/resolveContentRef/AssistantWorkerManager/yp_work_turn_sources` 在 `packages/yuanpu-runtime` 与 `apps/runtime` 限定 `rg` 并核对源码。主工作区用户未提交 Work 改动保持只读，集成时需单独消解 schema/WorkStore 差异；未推送。
