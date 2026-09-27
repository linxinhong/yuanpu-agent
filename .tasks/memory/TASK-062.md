# TASK-062 用户撤销助理来源

- Keywords: `source revocation`, `tombstone`, `source_current`, `Worker replay`, `DesktopBridge`, `memory withdrawal`。
- Owner: `root-assistant-source-revoke-10414-10414`；分支 `task/task-062-assistant-source-revoke`；2026-09-27。实现与测试源修订 `2fa5cdb`；任务状态以 `.tasks/tasks.yaml` 为准。
- 入口：`RuntimeAssistantSourceHost.revokeSource` 对 Work 回合、工具/产物与助理回合检查个人归属、当前版本和可撤销前缀；`AssistantSourceLifecycleStore.markDeleted` 以稳定版本单行持久化 tombstone/事件。Host `readSource/currentSource` 随即拒读，Worker 的 `refresh-sources` IPC、定时扫描和重启补扫消费事件。
- `AssistantWorkspaceService` 公开个人当前来源及分页标记；`DesktopBridge.revokeAssistantSource` 经认证 HTTP 进入宿主。助理记忆页的来源详情有两步确认与 receipt，明确原始记录仍保留、后续整理尚需核对。工作对话未增加建议。
- 陷阱：工具/产物 ledger 命中不等于有归属；撤销前还需 `workspaceForSource`。删除 tombstone 已登记不等于 Worker 已撤回派生记忆，界面不能提前宣称完成。委派 `followUp` IPC 签名为四个字符串；旧三参校验会拒绝真实追问，已加回归。
- 验证：临时 Home 真 Worker 的 Work/助理来源双证据、审阅、停止后撤销、重启补扫、重复提交、HTTP 认证和版本冲突，以及原始行保留；聚焦 runner `1790466421531342000.log`、`1790466469746806000.log`。Node 24.15.0 / pnpm 11.22.0 / macOS arm64 最终 `pnpm check` `1790466478998033000.log`，原生构建和 smoke `1790466546696017000.log`、`1790466559158033000.log` 均通过。独立只读复核的两处问题均已修复。浏览器虚构数据点击、刷新与脱敏图见 `docs/frontend/evidence/task-062/results.md`。
- 集成主线 `e368b7e` 的稳定 `pnpm check` `1790466913667927000.log` 通过；源码运行中未变。此前主线检查与 TASK-064 合入重叠，重跑时桌面重启测试曾单次 `ECONNRESET`，聚焦和完整稳定复跑通过。
- 边界：不物理删除 Work/Pi/助理原始记录，不把暂不可用或归档当用户撤销。真实桌面组合旅程、进行中的模型请求在事件消费前的窗口、Windows/Linux 与云端由后续验收或设计处理；TASK-050 是完整业务验收。若以后支持物理删除，必须先协调原始事务与 tombstone 的时序。
- 检索：宿主无 zvec-grep；按既知源码符号在 Runtime、Assistant、Protocol、Desktop 和任务卡做限定 `rg`，未创建索引。
