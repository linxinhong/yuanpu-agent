# TASK-007 记忆

技能管理与审批 UI 已接通真实 Runtime：catalog item 必须用稳定 `id` 与已安装制品关联，不能用展示/包名。Python 制品安装、更新、回滚后 Runtime 会重建 MCP surface、重置 Pi chat 并关闭旧 source，无需重启应用。

Electron preload 增加回滚、冲突检查与审批的窄接口；main 对所有 IPC invoke 校验当前主窗口、main frame 和配置的入口文档 URL，并阻止普通外部导航、新窗与 webview。R2 审批卡只显示参数摘要，决定由主进程签名；Runtime 在内存中保存原能力、参数与宿主上下文，允许后直接执行绑定调用，不依赖模型重述，消费后删除；拒绝直接回到对话。待审批由 Runtime 持久化，精确执行参数仅保存到进程内，Runtime 重启会取消未完成审批。

升级失败保持活动版本并显示重试；历史版本仅显式回滚。Runtime 先验签 manifest，再把其权限、配置 schema 和连接名用于 UI/冲突判断；搜索、冲突检查和安装以签名 payload 的 SHA-256 摘要绑定同一快照，源变化必须重新确认。只有连接名与旧 `pi-mcp-adapter` 配置重合才要求用户选择，停用不会删除配置。能力配置存放于版本目录之外，展示、默认值、校验和保存均以当前活动版本的签名 schema 为准；Python MCP 每次调用读取，因此更新/回滚均保留且无需重启。PyInstaller 冻结入口必须在导入 MCP 依赖前处理 `--version`；macOS 冷启动仍可能接近 10 秒，安装健康检查使用 20 秒上限。

完整证据见 `.tasks/verification/TASK-007/results.md` 和 `.tasks/ui/task-007-skill-ui/`。跨平台和生产签名仍留给 TASK-008。
