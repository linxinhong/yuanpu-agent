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
| V19-06 企业微信真实收发 | 授权测试成员通过首发智能机器人完成双会话、重复消息、回复和故障恢复。 | **unverified（真实收发）**。用户核对并更新 `.env` 后，SDK 1.0.7 单次鉴权探针返回 `authenticated=true`；此前的 `853000` 是旧配置的历史失败。三轮试收：第一轮用户确认时探针已超时；第二轮和第三轮均在 ready 后由用户确认发送一次性口令，但各自 240 秒内 `inboundSeen=0`、`privateTextSeen=0`、`matched=0`、执行与 outbound 均为 0。第三轮脱敏 SDK 事件包含连接、鉴权、心跳，仍无应用入站。没有试发回复；原因未定，不能归类为产品收发通过或缺陷。未读取或记录变量值、原始错误、消息和真实标识。本机连接仍未启用/配对/绑定 Keychain；只有一个授权私聊会话，双会话还缺第二成员。 |
| V19-07 原生通知与平台 | 在真实 Electron 中展示并点击通知，分别记录目标系统和外部平台结果。 | **unverified**。重跑的 Electron host fixture 证明提交/权限/去重/点击目标校验，但本轮未观察操作系统展示、点击导航或 Linux/Windows 行为。`submitted` 不代表用户看到。 |

## 执行记录

- `node --test packages/yuanpu-runtime/test/task-019-stage-verification.test.mjs packages/yuanpu-runtime/test/channels.test.mjs packages/yuanpu-runtime/test/scheduler.test.mjs packages/yuanpu-runtime/test/notifications.test.mjs`：27/27 pass，runner 记录 `1790126411085618000.json`。
- Runtime 通知/企业微信装配 focused：5/5 pass，记录 `1790126411085624000.json`；Desktop notification host focused：5/5 pass，记录 `1790126411078917000.json`。
- `pnpm check`：pass，runtime-kit 113/113、Runtime 14/14、Desktop 20/20，含构建和 Yuanpu typecheck；记录 `1790126432531431000.json`。安装使用仓库指定 `pnpm install --frozen-lockfile --ignore-pnpmfile`，修复了通用 install 与本仓库 pnpmfile checksum 的配置不匹配；生成的空 checksum 漂移已移除。
- 验证脚本与结果已快进并入本地 `main` 的 `04c5c0c`；在该集成 revision 以 Node 24.15.0 / pnpm 11.22.0 再跑 `pnpm check`，通过（runtime-kit 113/113、Runtime 14/14、Desktop 20/20）。此检查仍不覆盖下列真实平台与渠道投递缺口。
- API 失败探针是预期的验收失败，未编入 `pnpm check`；源码改动仅为验证脚本与证据，未修改产品实现。
- 新 Bot 鉴权复跑命令（从 `packages/yuanpu-runtime` 执行）：`node --env-file=/Users/linxinhong/.yuanpu/app/connections/.env test/task-019-wecom-auth-probe.mjs`。脚本不发送消息，限制一次鉴权尝试，仅输出成功布尔值或数字错误码并断开。2026-09-23 本机观察为 `authenticated=false, errcode=853000`，退出码 1；`.env` 权限已收紧为 `0600`。未将凭据导入 Keychain 或启用现有连接。
- 用户随后核对并更新同一 `.env`；2026-09-23 复跑同一命令得到 `{"authenticated":true}`，退出码 0。`WECOM_TEST_USER_ID` 的布尔存在检查返回 false。使用 `packages/yuanpu-runtime/test/task-019-wecom-live-probe.mjs` 的随机 challenge 模式建立临时隔离连接：只接受私聊中与随机口令完全一致的第一条文本，随后锁定发送者，固定回复，记录脱敏计数与临时 SQLite 事实。首轮 120 秒内无匹配消息；用户发送确认抵达时该轮已退出。第二轮 ready 后用户确认发送新口令，240 秒内 `inboundSeen=0`、`privateTextSeen=0`、`matched=0`、`executions=0`、`runCount=0`、`outboundStatuses=[]`、`providerReceipt=null`，退出码 1。未触发回复。此结果不证明平台未发送或产品存在缺陷，只证明该探针未观察到入站。
- 第三轮在 `7852c50` 的同一探针上再次先 ready、再请用户从企业微信私聊发送新口令，用户确认已发送。240 秒后退出码 1：`inboundSeen=0`、`privateTextSeen=0`、`matched=0`、`executions=0`、`runCount=0`、`outboundStatuses=[]`、`providerReceipt=null`；脱敏 `sdkEvents` 为 `wecom.connection:3`、`wecom.frame:1`、`wecom.authenticated:2`、`wecom.heartbeat:1`，无凭据、sender 或消息正文。`frame` 计数不等于应用消息；仍无真实入站或回复证据。
- 用户提供的企业微信开发者文档 `https://developer.work.weixin.qq.com/document/path/100719` 描述加密 HTTP 回调到接收消息 URL，要求 URL/Token/Encoding-AESKey；本仓库 `packages/yuanpu-runtime/src/channels/adapters/wecom.ts` 使用官方 `@wecom/aibot-node-sdk` 的 `WSClient` 长连接，以 Bot ID/Secret 鉴权并监听 `message`。官方 SDK README 也将其定义为 WebSocket 接入。后台若选择回调 URL 接入，消息不会由当前长连接探针接收；这只是与观测一致的待核对解释，尚未验证后台实际模式。
- 用户随后确认该机器人后台实际为长连接，因此 HTTP 回调模式不匹配假设排除。已核对本仓库监听官方 SDK 的 `message` 事件，SDK 1.0.7 源码在收到 `aibot_msg_callback` 后会触发该事件；第三轮未见 `wecom.message` 或归一化入站。SDK `sendMessage(chatid, body)` 的单聊 `chatid` 必须是成员 `userid`，不提供由 Bot ID/Secret 枚举或查询当前聊天成员的入口；本次 `.env` 的 `WECOM_TEST_USER_ID` 仍未配置。不能从这段 Codex 对话推断企业微信 userid，也不能向猜测的成员主动试发。需核对测试私聊是否为该 Bot ID 对应机器人、该成员是否在机器人可用范围，以及是否有其他连接占用；这些仍是待查项，并非已确认根因。
- 用户进一步指向官方文档 `https://developer.work.weixin.qq.com/document/path/101039`。浏览器核对正文：该页“API设置”写的是 URL 回调地址、Token、Encoding-AESKey；其左侧链接的 `https://developer.work.weixin.qq.com/document/path/101463` 才是长连接规范。后者明确每个机器人同一时间只能保持一个有效长连接，新的订阅会踢掉旧连接；私聊消息的 `from.userid` 随 `aibot_msg_callback` 到达，主动推送 `aibot_send_msg` 必须填该 userid，且用户需先在会话中给机器人发过消息。文档未提供仅凭 Bot ID/Secret 反查当前聊天用户的命令。用户说“用户信息默认授权”不改变当前 0 入站时没有 sender 身份这一事实。此前临时下载的 `wecom-cli` 仅用于检查版本与帮助，未配置授权或调用身份/消息接口；按用户要求已停止该路线并移入废纸篓。
- 变更后以 Node 24.15.0 / pnpm 11.22.0 重跑 `pnpm check`：pass，runtime-kit 113/113、Runtime 14/14、Desktop 20/20，另有脚本与 Python capability 测试全通过。无凭据或网络调用的 `node --check` 通过，live probe 的缺变量分支输出 `{"status":"missing_variables"}`。一次误用系统默认 Node 26/pnpm 9 的检查失败因工具链不符，未作为验收证据；随后已用指定工具链完整重跑通过。
- 鉴权交接提交 `6ce1d60` 再跑 `pnpm check`：pass，runtime-kit 113/113、Runtime 14/14、Desktop 20/20；runner 记录 `1790128038312650000.json`。无产品实现改动，检查通过不改变 V19-02 或 V19-06 的结论。

## 阻断与下一步

D19-01 是 TASK-019 的阻断缺陷：需要实现 Runtime 对已绑定 IM route 的计划投递授权与渠道 delivery adapter，明确未知发送不自动重发且失败不重跑 Agent。该实现属于开发修复，不在本验收卡内。修复后先重跑 API 探针并补充一个真实 SQLite + 渠道投递失败/未知的组合场景，再重跑 `pnpm check`。新 Bot 已通过鉴权且后台模式已确认为长连接，但临时探针未观察到用户确认发送的消息。需核对测试私聊是否为同一 Bot ID 对应机器人、该成员是否在机器人可用范围及是否有其他连接占用。若用户将获授权成员的 `WECOM_TEST_USER_ID` 仅写入本机 `.env`，可另做限定目标的主动发送探针，但它不替代入站验收；缺少该变量本身不是本轮 0 入站事件的解释。双会话需要第二名获授权测试成员。最后用真实 Electron 完成 V19-07；通过前不得标记 TASK-019 完成或解锁管理界面卡。

检索：ZG 查询“TASK-019 阶段验证：Runtime API/SQLite 中 IM、调度、通知的组装路径及持久状态”，有用路径为 `apps/runtime/src/index.ts`、`.tasks/tasks.yaml` 与 `docs/application-architecture.md`；随后用 scoped `rg` 和相邻源码/测试定位授权谓词、组合入口与状态断言。ZG 返回 fresh；未创建索引。
