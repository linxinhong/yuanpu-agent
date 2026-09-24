# YuanpuAgent 任务入口

YuanpuAgent 面向桌面工作场景：用户在 Electron 中与 Pi 对话，通过统一的“技能”入口安装指令、扩展和外部能力。Pi 上游源码保持原样；Yuanpu 负责配置、能力治理、分发和桌面体验。

阅读顺序：

1. [项目与开发命令](../README.md)、[领域术语](../CONTEXT.md)。
2. [Python 能力包设计与产品映射](../docs/python-capabilities.md)：当前事实、目标、决策、兼容边界和阶段验收。
3. [用户数据边界](../docs/adr/0001-user-data-boundaries.md)、[Pi 集成](../docs/pi-integration.md)。
4. [任务注册表](tasks.yaml)：状态、依赖、归属、验收证据的唯一来源。

## 基线与约束

本次设计基于 2026-09-21 工作区。`packages/yuanpu-runtime` 合并尚在未提交改动中，不能当作 main 已集成事实。第一张卡负责确认该基线及回归；不得恢复被合并的旧包或覆盖用户改动。设计与建卡不代表功能实现或发布。

本轮方向：复用现有两个 Yuanpu 包；Python 插件先做独立完整能力包，不引入共享 Python 环境或多层 MCP 网关。设计权威在 docs，`.tasks/architecture.md` 只作导航，不复制设计。

检索：沿用评审的源码证据，并用 scoped rg 核对 capabilities、packages、Pi 适配及 runtime 装配的确切符号；本会话未提供可用的 ZG 检索入口，未创建索引。证据入口见设计文档“当前事实”。

实施者更新受影响文档与 result.evidence；只有集成并在 main 验证后才能标 done。阶段验收必须由非该阶段主要实现者执行，记录版本、环境、命令及 pass/fail/unverified；无环境不得以构建通过替代验收。当前没有授权自动提交或推送。

2026-09-24 UI 方向：按用户选定的 Muse 浅色三栏预览完成聊天 UI，见[按 Muse 参考框架交付 Yuanpu 聊天 UI（TASK-036）](../docs/frontend/tasks/muse-chat-redesign.md)与[验收证据](../docs/frontend/evidence/task-036/results.md)；状态以注册表为准。
