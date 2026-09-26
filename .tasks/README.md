# YuanpuAgent 任务入口

YuanpuAgent 面向桌面工作场景：用户在 Electron 中与 Pi 对话，通过统一的“技能”入口安装指令、扩展和外部能力。Pi 上游源码保持原样；Yuanpu 负责配置、能力治理、分发和桌面体验。

阅读顺序：

1. [项目与开发命令](../README.md)、[领域术语](../CONTEXT.md)。
2. [总体架构](../docs/application-architecture.md)：App 生命周期、IM 入口、定时任务、系统通知与升级；[Python 能力包设计与产品映射](../docs/python-capabilities.md)提供专项设计和阶段验收。
3. [用户数据边界](../docs/adr/0001-user-data-boundaries.md)、[Pi 集成](../docs/pi-integration.md)。
4. [任务注册表](tasks.yaml)：状态、依赖、归属、验收证据的唯一来源。

本轮任务卡覆盖总体架构的契约、执行、App 生命周期、通知、调度、IM、管理界面及阶段验收；任务名称与产出索引见总体架构第 13 节。首发平台固定为企业微信智能机器人长连接，由“确定首个 IM 接入契约与验证环境（TASK-017）”落实。2026-09-25 用户确认当前企业微信已满足使用需求，原腾讯微信 ClawBot 架构、实现、验收三张卡从当前队列移除；此决定不表示腾讯微信已接通。

## 基线与约束

2026-09-21 的 Python 能力专项任务及其历史基线见注册表。2026-09-22 总体设计基于现有两个 Yuanpu 包和 Electron 管理 Runtime 的源码边界；新设计不代表功能实现或发布，不覆盖已有任务证据与用户改动。

当前方向：工作对话保持独立上下文；新增 packages/yuanpu-assistant 承载独立个人助理，自动评估工作内容、整理记忆与台账并委派专业子任务。本地与企业微信连接同一助理身份但默认独立聊天上下文。所有进程跟随 App 生命周期，关闭后停止。Python 保持独立能力包；设计权威在 docs，`.tasks/architecture.md` 只作导航。原“只复用两个 Yuanpu 包”是此前阶段边界，本轮新增助理包取代该限制。

2026-09-23 范围调整：当前按个人助手验收，首发企业微信只需一位获授权用户的真实私聊；第二名真人和真实群聊不再是阶段门槛。身份拒绝、跨会话隔离、去重与恢复仍须测试。决策和边界见[总体架构第 7 节](../docs/application-architecture.md)，当前状态与缺口以[任务注册表](tasks.yaml)和[通知渠道与调度阶段验证记录](verification/TASK-019/results.md)为准。

2026-09-25 提醒范围调整：用户当前不需要提醒，[原生通知范围决策](../docs/adr/0003-defer-native-notifications.md)已更新；原 TASK-029 待办卡已移除。既有通知实现与历史未验证记录保留，不将开发版回执视为系统展示通过。旧验收证据中提到 TASK-029 仅反映当时的任务安排，不是当前待办。

2026-09-25 渠道范围调整：当前只保留已接入的企业微信主路径，原腾讯微信 ClawBot 三张未开工卡不再是待办；见[总体架构第 7 节](../docs/application-architecture.md)。

检索：沿用评审的源码证据，并用 scoped rg 核对 capabilities、packages、Pi 适配及 runtime 装配的确切符号；本会话未提供可用的 ZG 检索入口，未创建索引。证据入口见设计文档“当前事实”。

本次提醒范围整理仅需精确查找：当前宿主未提供 ZG 工具，以 scoped `rg` 检索 `.tasks`、`docs`、`apps`、`packages`、`.github` 的 TASK-029 引用；保留历史证据原文。

本次渠道范围整理同样是精确查找：当前宿主未提供 ZG 工具，以 scoped `rg` 检索 `.tasks`、`docs`、`apps`、`packages` 的腾讯微信卡片和 ClawBot 引用；未创建索引。

实施者更新受影响文档与 result.evidence；只有集成并在 main 验证后才能标 done。阶段验收必须由非该阶段主要实现者执行，记录版本、环境、命令及 pass/fail/unverified；无环境不得以构建通过替代验收。当前没有授权自动提交或推送。

2026-09-24 UI 方向：按用户选定的 Muse 浅色三栏预览完成聊天 UI，见[按 Muse 参考框架交付 Yuanpu 聊天 UI（TASK-036）](../docs/frontend/tasks/muse-chat-redesign.md)与[验收证据](../docs/frontend/evidence/task-036/results.md)；状态以注册表为准。

## 独立助理开发（2026-09-26）

用户已要求制作开发卡，设计权威见[独立助理设计与任务映射](../docs/assistant-memory-proposal.md)。本轮只做本地与企业微信，飞书、微信、钉钉不在开发和验收范围。助理评估的是工作对话、执行过程及产物，不是给助理自身跑离线评测；packages/evals 仅作方法参考，不新增生产依赖。历史提醒暂缓记录保留，本轮新范围包含助理侧主动回顾与可选企微建议，不恢复系统原生通知的必交要求。

从“固定助理契约并验证 Pi 会话适配（TASK-037）”开始，最终由“独立助理完整业务验收（TASK-050）”验证闭环；状态和依赖只以[注册表](tasks.yaml)为准。三个阶段分别验证双入口与进程、工作评估/记忆/委派、真实桌面完整业务。复用[已确认的助理双面板](ui/assistant-home/proposal.md)，不以占位数据代替后端接通。

当前源码取证基线为 main fbe7c05 及未提交增量：已有 subagents、内置工具、助理页面和协议修改，实施前必须保留并复核。检索：ZG 查询 assistant/work/runtime/subagents 与 packages/evals，命中 runtime/index、agent-runtime-contracts、evals README；再精确核对 subagents/runner、assistant-home、package.json。未创建或重建索引。卡片本身不是实现证据；既有历史 done 状态不改写，不自动领取、提交或推送。
