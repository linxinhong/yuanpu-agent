# TASK-043 实现来源与可修订记忆存储

- Owner：assistant-architecture-memory-10414；分支 `task/task-043-assistant-memory`；固定 worktree `.worktrees/assistant-architecture`；领取基线 `53b4848`；实现提交 `d28074e`、`cff0c4a`。主线负责集成和卡状态。
- 关键词：来源游标、opaque contentRef、Assistant Worker IPC、Markdown 修订、人工纠正、遗忘、中文检索、SQLite v11。

## 实现与边界

- `packages/yuanpu-assistant/src/memory-sources.ts` 暴露 `AssistantSourceHost.listChanges/currentSource/readSource` 窄接口。Host 解析不透明引用，Worker 不按 `contentRef` 打开本机路径；Work/Assistant 来源按 feed、事件 ID、版本哈希、受众入 `state.sqlite` 持久队列，页及游标同事务提交。最新权威版本只按相等比较；暂不可用保留旧认识，显式重试；已删除清除原文索引并驱动撤回；旧事件乱序、重复及重启均不重复处理。来源正文索引上限 32,000 字符，返回的产物引用可登记、按受众读取，Worker 不解析引用位置。
- `memory-documents.ts` 管理 `memories/work/reviews/suggestions` Markdown；`user-summary`、`core-memory` 对应核心 `USER.md`、`MEMORY.md`。每篇有稳定 ID/版本/性质/受众/情境/核实时间/证据/依赖；SQLite 写入意图、fsync 临时文件和目录、原子替换与启动重放防止文件/索引分叉。人工直接编辑提升版本和权威性，自动提交需 CAS；冲突拒绝覆盖。删除来源只撤回单独受其支持的认识，其他证据或人工纠正保留；遗忘写持久 job，清除同源文档及其派生评估/建议、索引、文件和修订快照，旧来源 ID 墓碑防回流。
- `RuntimeAssistantSourceHost`、`AssistantWorkerManager`、`assistant-worker.ts` 接通 Runtime Host → 专属 Worker 的私有来源 RPC。启动后异步按页扫描 Work/助理已保存文本回合，单次最多 100 条入队、50 条处理，每 5 秒补扫；来源失败不阻塞用户回合或 Worker ready。Host 校验 personal `local-user` 和 ref/source/version 绑定后才返回有界正文。Worker 单写 Home，退出回收。
- Work 的 `sourcePage` 使用 v11 持久 `event_id`，由独立序列表和插入触发器分配；旧行一次回填，VACUUM、重启和删除最大来源行后都不复用已确认游标。AssistantHost 来源页按 SQL `LIMIT`，双方按 ID 直取权威版本，避免全表装入 JS。
- 旧 `MEMORY` 的只读导入由 Host 授权提供内容和证据；助理包不直接读取旧 Work/Agent 目录。未把个人记忆注入 Work 或子代理，未改 Pi 上游。

## 验证和限制

- 聚焦：Assistant 文档/队列 12 个测试、Work v8/v9/v10→v11 迁移、VACUUM/删最大行游标、真实 Runtime Manager→Worker 来源 RPC 与重启去重、205 条 Work 来源 100/100/5 分页均通过。运行器证据：`1790440763921231000.log`、`1790440331943569000.log`、`1790440262974454000.log`。
- 最终 `pnpm check && pnpm build:native && pnpm smoke:native` 全通过，macOS arm64、Node 24.15.0、pnpm 11.22.0；Assistant 12、runtime-kit 175、Runtime 45 测试通过，SEA smoke 通过。证据 `.git/worktrees/assistant-architecture/coding-owner/1790440774360817000.log`。一次前置全量测试遇 Runtime 测试清理 Home 与新异步 Worker 写库竞态，已等待 Runtime/Worker 退出后清理并在最终全量验证通过。
- **尚未满足产物来源验收**：现有 `yp_work_turn_sources` 与 `yp_assistant_sources` 只持久化回合文本引用；`yp_agent_run_outputs` 工具信息仅 `{name,status}`，无稳定且可授权读取的 artifact ID/ref。当前 Host 不凭输出文字或绝对路径猜产物，返回无产物引用。主线新建 TASK-061「建立工作工具结果与产物的助理来源契约」，应补持久 artifact ledger、授权读取、旧 Pi Session 回填边界、删除/离线事件；TASK-044 依赖该卡。不可把本实现称为全量产物已收集。
- 未验证 Windows/Linux 原生包及真实历史产物迁移；TASK-042 的真实企业微信往返由独立阶段验收记录，不是本卡来源测试。生产来源适配当前仅 `personal:local-user`，其他受众明确拒绝。索引可重建，不能删除 `state.sqlite` 来“重建”队列或遗忘墓碑。
- 检索证据：当前 host 未暴露 zvec-grep 工具；按精确符号 `sourceChanges/resolveContentRef/AssistantWorkerManager/yp_work_turn_sources` 在 `packages/yuanpu-runtime` 与 `apps/runtime` 限定 `rg` 并核对源码。主工作区用户未提交 Work 改动保持只读，集成时需单独消解 schema/WorkStore 差异；未推送。
