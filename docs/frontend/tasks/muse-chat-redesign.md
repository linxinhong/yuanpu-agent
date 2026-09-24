# 按 Muse 参考框架交付 Yuanpu 聊天 UI（TASK-036）

## 决定与交付边界

2026-09-24，用户查看当前浏览器预览后要求“先按这个 UI 进行修改，新建开发卡”。沿用已选 Muse 框架：左侧窄导航、中央聊天与底部输入、右侧可收起会话面板；细节使用 Yuanpu 标识并按真实能力打磨。本卡接续既有草稿并完成真实桥接验收。

[已接受实现基线](../evidence/task-036/accepted-ui-baseline.png)是本轮直接参考，[生成设计](../evidence/task-036/reference-design-v001.png)用于视觉方向；原始方案保留于本地 `.tasks/ui/muse-chat-redesign/proposal.md`。本卡已将基线与最终脱敏截图持久保存于 `docs/frontend/evidence/task-036/`，验收记录见 [results.md](../evidence/task-036/results.md)。

## 已核实事实与实现入口

- React/Vite 页面由 `apps/app/src/main.tsx` 的 App/ChatPanel 组织，四个视图是聊天、技能、连接、定时任务；无须新增路由系统。
- 当前未提交实现包含 `muse-theme.css`、聊天右栏及 Electron `hiddenInset`。实施者应先核对差异并接续，保留用户其他改动。
- 聊天仍使用 DesktopBridge 的提交、轮询、取消和授权接口；协议位于 `packages/yuanpu-protocol/src/index.ts` 与 `agent.ts`。不改变进程、凭据或权限边界。
- 既有方案记录了多视口、模拟运行与隔离 Electron 启动验证；真实模型中的授权、取消和工具结果时序仍有验收缺口。过去的验证不自动覆盖后续修改。

检索：ZG 查询 ChatPanel/muse-theme/桌面对话及任务关系（fresh）仅命中管理页面设计和协议片段，未充分覆盖新草稿；以 scoped rg 核对 main.tsx、任务注册表、desktop 测试与既有方案，未创建或扩大索引。

## 页面和操作契约

聊天是主操作区，右栏是同一会话的辅助状态，不新增设置或外部连接入口。发送消息后展示真实运行状态；授权动作经宿主执行；取消和失败必须有明确结果及下一步。窄屏右栏使用可关闭抽屉，保持聊天可操作。技能、连接和定时任务沿用既有页面结构，仅适配公共外壳与颜色。

运行记录仅表示当前会话观测到的状态；不得从截图推导历史持久化、实时工具事件或 Gmail 等能力。所有示意内容与 fixture 必须与正式运行区分。回退可撤回本卡 UI 与窗口样式改动，不涉及用户数据迁移。

## 执行与验收

一张卡覆盖同一 UI 结果，单一实施者维护共享页面与样式。依赖已完成的实现连接与定时任务管理界面（TASK-020），不将其他平台业务验收串入本卡。推荐 gpt-6 sol；实际执行时核对宿主可用模型。

具体场景、命令、风险和状态以[任务注册表](../../../.tasks/tasks.yaml)中的按 Muse 参考框架交付 Yuanpu 聊天 UI（TASK-036）为唯一来源。验收必须包含真实 Electron 对话与无副作用授权场景；没有环境的项明确保留未验证。用户本次接受的是 UI 基线，不是最终业务验收。

## 验证发现的最小边界修正

受控模型 HTTP 400 经真实 Electron/Runtime 提交后，Pi 适配层曾返回“完成”并使运行误标成功。补充 `packages/yuanpu-runtime/src/pi/index.ts` 对最终 assistant 错误状态的传递，沿用现有 failed 协议与通用脱敏文案；不修改 Pi 上游。对应回归由本卡 Electron 探针覆盖。
