# YuanpuAgent 任务入口

YuanpuAgent 面向桌面工作场景：用户在 Electron 中与 Pi 对话，通过统一的“技能”入口安装指令、扩展和外部能力。Pi 上游源码保持原样；Yuanpu 负责配置、能力治理、分发和桌面体验。

阅读顺序：

1. [项目与开发命令](../README.md)、[领域术语](../CONTEXT.md)。
2. [总体架构](../docs/application-architecture.md)：App 生命周期、IM 入口、定时任务、系统通知与升级；[Python 能力包设计与产品映射](../docs/python-capabilities.md)提供专项设计和阶段验收。
3. [用户数据边界](../docs/adr/0001-user-data-boundaries.md)、[Pi 集成](../docs/pi-integration.md)。
4. [任务注册表](tasks.yaml)：状态、依赖、归属、验收证据的唯一来源。

本轮任务卡覆盖总体架构的契约、执行、App 生命周期、通知、调度、IM、管理界面及阶段验收；编号 TASK-011 至 TASK-025。任务名称与产出索引见总体架构第 13 节。首发平台固定为企业微信智能机器人长连接，由“确定首个 IM 接入契约与验证环境（TASK-017）”落实；企业微信完整业务验收完成后，再按 TASK-023 至 TASK-025 推进腾讯微信 ClawBot，不让高适配成本阻塞首发。

## 基线与约束

2026-09-21 的 Python 能力专项任务及其历史基线见注册表。2026-09-22 总体设计基于现有两个 Yuanpu 包和 Electron 管理 Runtime 的源码边界；新设计不代表功能实现或发布，不覆盖已有任务证据与用户改动。

当前方向：本机 Pi 工作助手，桌面、IM 与定时任务共用 Runtime；所有运行能力跟随 App 生命周期，不引入独立后台服务。复用现有两个 Yuanpu 包；Python 保持独立能力包，不引入共享 Python 环境或多层 MCP 网关。设计权威在 docs，`.tasks/architecture.md` 只作导航，不复制设计。

2026-09-23 范围调整：当前按个人助手验收，首发企业微信只需一位获授权用户的真实私聊；第二名真人和真实群聊不再是阶段门槛。身份拒绝、跨会话隔离、去重与恢复仍须测试。决策和边界见[总体架构第 7 节](../docs/application-architecture.md)，当前状态与缺口以[任务注册表](tasks.yaml)和[通知渠道与调度阶段验证记录](verification/TASK-019/results.md)为准。

检索：沿用评审的源码证据，并用 scoped rg 核对 capabilities、packages、Pi 适配及 runtime 装配的确切符号；本会话未提供可用的 ZG 检索入口，未创建索引。证据入口见设计文档“当前事实”。

实施者更新受影响文档与 result.evidence；只有集成并在 main 验证后才能标 done。阶段验收必须由非该阶段主要实现者执行，记录版本、环境、命令及 pass/fail/unverified；无环境不得以构建通过替代验收。当前没有授权自动提交或推送。

2026-09-24 UI 方向：按用户选定的 Muse 浅色三栏预览完成聊天 UI，见[按 Muse 参考框架交付 Yuanpu 聊天 UI（TASK-036）](../docs/frontend/tasks/muse-chat-redesign.md)与[验收证据](../docs/frontend/evidence/task-036/results.md)；状态以注册表为准。
