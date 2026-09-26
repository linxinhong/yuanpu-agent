# 助理来源撤销（TASK-062）验收记录

- 宿主先核实来源 ID、所属个人受众和当前版本，再以单条持久 tombstone 同时作为删除事件；重复同一请求得到 `already_accepted`。提交后立即拒绝助理读取，Worker 通过通知或重启补扫消费事件。原始 Work/Pi 与助理对话记录不删除。
- 临时 Home 的真实 Runtime→Worker 测试覆盖 Work 与助理来源、提交到消费之间退出、重启补扫、重复撤销、单来源记忆与工作审阅撤回、双来源记忆保留到第二条也撤销，以及原始记录仍在。Host 拒绝未知来源、错误受众、孤立工具来源和过期版本；HTTP 路由拒绝未认证调用，并核对版本冲突及幂等重试。
- 独立只读复核发现孤立工具来源的归属检查和前端过早宣称整理完成两处问题，均已修复并做聚焦回归。界面现在区分“宿主已登记”与“相关整理仍需核对”；来源详情以两步确认解释撤销读取权和保留原始记录。
- Node 24.15.0、pnpm 11.22.0、macOS arm64：聚焦来源测试 runner `1790466421531342000.log`、IPC 测试 `1790466469746806000.log`、最终 `pnpm check` `1790466478998033000.log` 均通过；其后 `pnpm build:native` `1790466546696017000.log` 与 `pnpm smoke:native` `1790466559158033000.log` 通过。测试源码在最终全量检查后未再变更。
- 集成主线 `e368b7e` 的稳定 `pnpm check` runner `1790466913667927000.log` 通过，运行期间源码未变。此前一次检查与 TASK-064 产品代码合入重叠，虽退出 0 但不作为稳定证据；之后桌面 Runtime 重启测试曾遇单次 `ECONNRESET`，同版本聚焦复跑 `1790466904346279000.log` 与最终完整检查均通过。
- 浏览器可控 DesktopBridge 适配器使用虚构来源和记忆，实际点击“来源详情”→“撤销助理读取”→“确认撤销”，刷新后展示已停止读取、记忆撤回和原始记录保留的说明。画面：[确认前](assistant-source-confirm.png)、[登记后](assistant-source-revoked.png)。这不是 Electron、真实用户 Home 或真实企业微信删除旅程；后续 TASK-050 验收真实桌面组合流程。
- 尚未验证：真实桌面用户旅程、进行中的模型请求在事件消费前的窗口、Windows/Linux 与云端。撤销是助理读取权和派生整理的撤回，不是物理删除；界面不声称收到 receipt 时 Worker 已全部处理。
- 检索：本宿主未提供 zvec-grep；以已知 `RuntimeAssistantSourceHost`、`AssistantSourceLifecycleStore`、`AssistantWorkspaceService`、DesktopBridge 和界面入口做限定 `rg` 与差异核对，未创建索引。
