# TASK-007 记忆

技能管理与审批 UI 已接通真实 Runtime：catalog item 必须用稳定 `id` 与已安装制品关联，不能用展示/包名。Python 制品安装、更新、回滚后 Runtime 会重建 MCP surface、重置 Pi chat 并关闭旧 source，无需重启应用。

Electron preload 增加回滚与审批的窄接口；main 对所有 IPC invoke 校验当前主窗口和 main frame。R2 审批卡只显示参数摘要，决定由主进程签名；允许一次后使用原 requestId 续跑一次，拒绝直接回到对话。待审批由 Runtime 持久化，renderer 刷新可恢复。

升级失败保持活动版本并显示重试；历史版本仅显式回滚。旧 `pi-mcp-adapter` 冲突要求用户选择，停用不会删除配置。PyInstaller 冻结入口必须在导入 MCP 依赖前处理 `--version`，否则健康检查可能超时。

完整证据见 `.tasks/verification/TASK-007/results.md` 和 `.tasks/ui/task-007-skill-ui/`。跨平台和生产签名仍留给 TASK-008。
