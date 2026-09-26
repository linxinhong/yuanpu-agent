# TASK-051 实现助理内部自动化与定时调度

- Owner：assistant-architecture-automation-10414；分支 `task/task-051-assistant-automation`；固定 worktree `.worktrees/assistant-architecture`；领取 main `ff44429`。TASK-046 已在主线 `f6b7b0e` 集成，本分支合入该主线的 merge 为 `708c62e`。主线负责最终集成与卡状态。

## 契约与实现

- `packages/yuanpu-assistant/src/automation.ts` 在助理专属 `state.sqlite` 建立持久 job、周期键、来源补录和实际检查 checkpoint。每项有任务种类、原因去重键、来源/委派 ID 与版本、受众、优先级、到期/执行预算、尝试与重试状态、稳定 effectId。一个 Worker 是唯一写入者，不复用 Runtime 用户计划库。
- Work/助理来源处理完成后补扫 `source_events` 中未关联的记录。来源处理与 automation 登记之间崩溃时，重启可幂等补录；同一 ID/版本去重，新版本取消旧未完成 job；删除事件取消原工作评估 job 并排入记忆维护。`work-evidence` 与 `work-deletions` 同归属 `work`，能消费 TASK-061 的稳定工具结果/产物事件。审阅输出自身不入来源队列。
- Worker 每 5 秒在 App 进程内调度，使用本地自然日与 ISO 周键；只生成当前周期的日/周检查，旧周期尚未执行的 job 在新周期启动时取消，停机期间不补每个错过周期。无 UI 客户端的 Worker 真实进程验证了日/周检查与 checkpoint，退出后不再运行。当前 checkpoint 只记录来源与记忆数量，**不声称完成工作审阅、用户理解或主动建议**；这些来源/委派 jobs 持久 `waiting`，供 TASK-044/045/048 的技能处理器接手。无新信息时不产生可见消息。
- 前台 prompt 暂停并中止后台 proposal；纠正/遗忘及较高优先级 job 可抢占低优先级，来源/委派新版本也会使旧运行任务失效。模型准备阶段只产出 proposal，取消、前台压力、旧版本、超时或费用超额后不能落盘。apply 必须通过引擎提供的同步 SQLite `commit` 回调写入；回调原子核对运行状态并提交 effect/checkpoint，迟到的异步 apply 无法越过取消。effectId 支持幂等，重启先查效果；未知外部结果进入 waiting，不盲目重播。App 退出中止调度并等待当前回合有界回收。
- TASK-046 的委派状态事件不再直接唤醒模型。Worker 查宿主当前状态，以 taskId 和状态关键字段哈希入持久队列；持久比较 `updatedAt` 与状态序，乱序或同毫秒旧 running 不会覆盖新 completed。重启扫描 Worker 自己的 delegation archive 并查询宿主状态作补偿。委派核验的实际模型消费仍由专门技能行为实现。

## 验证与限制

- 包内可控时钟测试覆盖来源重复/版本变化、work-evidence 删除、周期错过合并、前台抢占与迟到结果、异步 apply 在 cancel/stop/foreground 后被拒、预算、Worker 崩溃恢复、效果先落盘后状态未知、委派乱序与状态未知先查、未消费技能 job 保留。
- 真实 Worker/Host 聚焦验证覆盖无界面日/周调度、真实来源到 job、删除来源、委派事件与重启状态补偿、App 停止进程回收。Node 24.15.0、pnpm 11.22.0；最终聚焦 `1790445088875286000.log`，`pnpm check && pnpm build:native && pnpm smoke:native` 全通过且运行中源码未变，macOS arm64 证据 `.git/worktrees/assistant-architecture/coding-owner/1790445139380147000.log`。独立复核四项阻断（异步回调语法、跨期积压、迟到 apply、委派乱序）已按回归修复，最终复核无新增阻断。
- `work-evidence` 的生产 Host feed 由 TASK-061 实现；本卡先交付 Worker 扫描与助理来源 canonical 接缝、包内证据→删除行为测试。若本卡早于 TASK-061 集成，旧 Host 不认识该 feed 时仅跳过此可选 feed；新版本 Host 可在下次 Worker 启动直接补扫。
- 来源/委派 jobs 的具体模型评估、记忆修订和外部投递分别由 TASK-044/045/046/048 实现。本卡不把排队或 checkpoint 当作那些业务产物。未验证 Windows/Linux 原生构建、云端多节点或真实费用账单；预算在任务执行入口强制，后续模型处理器须返回真实成本并以 effectId 幂等提交。
- 同毫秒且同状态序、不同哈希的委派状态可能作为两个待处理 job 并存；消费前须查询宿主权威当前状态，不能仅据 job 关闭承诺。实际模型费用只能由后续技能处理器在 `prepare` 内限制调用预算并返回成本，本卡的引擎在 proposal 落盘前再拒绝超额结果。
- 检索：当前 host 未提供 zvec-grep 工具；按已知 `AssistantWorkerManager`、`source_events`、`delegation-event`、`PersistentScheduler` 符号限定 `rg` 检索 `packages/yuanpu-assistant`、`apps/runtime`、`packages/yuanpu-runtime` 和设计文档，未创建索引。未改 Pi 上游、真实 Home 或主工作区用户未提交 UI 文件，未推送。
