# 通知渠道与调度阶段验证（TASK-019）

验证者：`codex-t019sep23`，非 TASK-015/016/018 主要实现者。记录日期：2026-09-23。
任务分支：`task/task-019-stage-verification`；产品源码基线 `d8564c4`，验证脚本提交 `0fc2458`。环境：macOS arm64、Node 24.15.0、pnpm 11.22.0、隔离临时 SQLite/Runtime、受控模型与渠道 fixture。以下 `pass` 仅覆盖所注明模式；本阶段总判定 **未通过**。

## 场景与结果

| 场景 | 规则、操作与可观察事实 | 结果及证据 |
| --- | --- | --- |
| V19-01 并发与隔离 | 两个已配对 IM sender 和一次到期计划同时进入同一 AgentService；重复第一条消息，另用未配对身份提交伪造本机权限的文本。要求三个不同会话仅执行三次、回复沿原 `req_id`，数据库保留两个 IM outbound 和一个 schedule trigger。 | **pass（fixture）**。`packages/yuanpu-runtime/test/task-019-stage-verification.test.mjs` 断言三条 `yp_agent_runs` 均成功、两个 outbound 均 accepted、一个 trigger，以及远程运行身份仍为 `channel_user`；27/27 focused 测试通过。 |
| V19-02 计划投递到绑定 IM | 计划完成应同时有系统提醒和独立 IM 投递；一个出口失败不得重新执行模型。 | **fail（产品缺口 D19-01）**。真实 Runtime HTTP `POST /v1/schedules` 对 `delivery.kind=channel` 一律返回 400 `Schedule delivery target is not authorized.`，随后 GET 列表为 0。复现：`python3 ~/.agents/skills/coding-owner/scripts/worktree-kit.py --root /Users/linxinhong/projects/yuanpu-agent/.worktrees/codex-task-019 run --cwd apps/runtime --label task-019-im-schedule-api-probe-final --timeout 30 --require node -- node test/task-019-channel-delivery-probe.mjs`，退出码 1；记录 `1790126520215456000.json`。当前 `apps/runtime/src/index.ts` 的 `schedulerCaller.authorizeDelivery` 仅接受 `desktop`/`none`，装配 `PersistentScheduler.open` 时也未传入渠道 delivery adapter。探针使用合成 route；无论 route 值如何，当前授权谓词先拒绝所有 channel 目标。组件级通知请求与回执通过，但不能替代该组合结果。 |
| V19-03 退出、重启与状态 | 运行中关闭 App，再打开后能查询中断、等待授权及投递状态，退出后无后台活动。 | **unverified（完整组合）**。已重跑的 scheduler/channel/Runtime 组件测试覆盖 SQLite 重开、未知结果不重跑、退出时投递 unknown、父进程被杀后的子进程清理；尚未在同一真实 IM + Electron 用户旅程中观察全部状态。证据为 focused 测试及 `pnpm check` 记录。 |
| V19-04 权限与身份 | 远程消息不得改变本机权限策略，未配对身份拒绝，模型正文不得充当可信 sender。 | **pass（fixture）**。V19-01 的伪造文本仍以 `channel_user` 执行，未配对消息在 Agent 前拒绝；Runtime 既有 API 测试也覆盖伪造本机身份拒绝。真实平台身份映射仍待 V19-06。 |
| V19-05 结果语义 | 区分执行失败、投递失败、投递未知和通知 `submitted`；用持久事实确认合法状态转换和执行次数。 | **pass（组件 fixture），组合未验证**。`channels.test.mjs`、`scheduler.test.mjs`、`notifications.test.mjs` 和新组合测试均重跑通过。`submitted` 的 `userVisibility` 为 `unknown`；真实系统展示及计划到 IM 的失败链路尚未证实。 |
| V19-06 企业微信真实收发 | 授权测试成员通过首发智能机器人完成双会话、重复消息、回复和故障恢复。 | **unverified（环境）**。用户提供的新 Bot 凭据仅通过 `.env` 变量传入进程；变量非空且无首尾空白/换行，官方域名 DNS/TLS 可达，但 SDK 1.0.7 的单次鉴权返回数字错误码 `853000`。未读取或记录变量值、原始错误、消息和真实标识。本机配置仍为 1 条连接、0 启用、0 配对、0 Keychain 引用；目前只有一个获授权私聊会话，双会话验收仍缺环境。 |
| V19-07 原生通知与平台 | 在真实 Electron 中展示并点击通知，分别记录目标系统和外部平台结果。 | **unverified**。重跑的 Electron host fixture 证明提交/权限/去重/点击目标校验，但本轮未观察操作系统展示、点击导航或 Linux/Windows 行为。`submitted` 不代表用户看到。 |

## 执行记录

- `node --test packages/yuanpu-runtime/test/task-019-stage-verification.test.mjs packages/yuanpu-runtime/test/channels.test.mjs packages/yuanpu-runtime/test/scheduler.test.mjs packages/yuanpu-runtime/test/notifications.test.mjs`：27/27 pass，runner 记录 `1790126411085618000.json`。
- Runtime 通知/企业微信装配 focused：5/5 pass，记录 `1790126411085624000.json`；Desktop notification host focused：5/5 pass，记录 `1790126411078917000.json`。
- `pnpm check`：pass，runtime-kit 113/113、Runtime 14/14、Desktop 20/20，含构建和 Yuanpu typecheck；记录 `1790126432531431000.json`。安装使用仓库指定 `pnpm install --frozen-lockfile --ignore-pnpmfile`，修复了通用 install 与本仓库 pnpmfile checksum 的配置不匹配；生成的空 checksum 漂移已移除。
- 验证脚本与结果已快进并入本地 `main` 的 `04c5c0c`；在该集成 revision 以 Node 24.15.0 / pnpm 11.22.0 再跑 `pnpm check`，通过（runtime-kit 113/113、Runtime 14/14、Desktop 20/20）。此检查仍不覆盖下列真实平台与渠道投递缺口。
- API 失败探针是预期的验收失败，未编入 `pnpm check`；源码改动仅为验证脚本与证据，未修改产品实现。
- 新 Bot 鉴权复跑命令（从 `packages/yuanpu-runtime` 执行）：`node --env-file=/Users/linxinhong/.yuanpu/app/connections/.env test/task-019-wecom-auth-probe.mjs`。脚本不发送消息，限制一次鉴权尝试，仅输出成功布尔值或数字错误码并断开。2026-09-23 本机观察为 `authenticated=false, errcode=853000`，退出码 1；`.env` 权限已收紧为 `0600`。未将凭据导入 Keychain 或启用现有连接。
- 鉴权交接提交 `6ce1d60` 再跑 `pnpm check`：pass，runtime-kit 113/113、Runtime 14/14、Desktop 20/20；runner 记录 `1790128038312650000.json`。无产品实现改动，检查通过不改变 V19-02 或 V19-06 的结论。

## 阻断与下一步

D19-01 是 TASK-019 的阻断缺陷：需要实现 Runtime 对已绑定 IM route 的计划投递授权与渠道 delivery adapter，明确未知发送不自动重发且失败不重跑 Agent。该实现属于开发修复，不在本验收卡内。修复后先重跑 API 探针并补充一个真实 SQLite + 渠道投递失败/未知的组合场景，再重跑 `pnpm check`。另需由用户在企业微信后台核对同一 API 模式长连接机器人的 Bot ID/Secret，更新原 `.env` 后先复跑鉴权；成功后才绑定 Keychain、启用隔离连接，并在已授权私聊中执行单会话场景。双会话需要第二名获授权测试成员。最后用真实 Electron 完成 V19-07；通过前不得标记 TASK-019 完成或解锁管理界面卡。

检索：ZG 查询“TASK-019 阶段验证：Runtime API/SQLite 中 IM、调度、通知的组装路径及持久状态”，有用路径为 `apps/runtime/src/index.ts`、`.tasks/tasks.yaml` 与 `docs/application-architecture.md`；随后用 scoped `rg` 和相邻源码/测试定位授权谓词、组合入口与状态断言。ZG 返回 fresh；未创建索引。
