# 首个 IM 接入契约与验证环境

状态：**平台与接入类型已选择；真实环境未就绪**

任务：确定首个 IM 接入契约与验证环境（TASK-017）

官方资料核验日期：2026-09-22

用户已选择企业微信。本卡把选择精确收敛为：**企业微信智能机器人、API 模式、WebSocket 长连接**。它不是企业微信群机器人 Webhook，不是传统自建应用回调，也不是微信客服。机器可校验版本见 [`im-channel-contract.json`](im-channel-contract.json)，官方资料摘录见 [`research/wecom-first-channel.md`](research/wecom-first-channel.md)。

尚未获得企业微信账号权限证据、Bot ID 引用、SecretStore 绑定或获授权的测试会话，因此本文不声称鉴权、真实收发、群触发、离线补收、限流或客户端展示已经通过 E2E。

## 1. 为什么选择智能机器人长连接

| 企业微信接入类型 | 能力边界 | 公网入站 | 与 Yuanpu 首发目标的匹配 |
| --- | --- | --- | --- |
| **智能机器人 / API 模式 / WebSocket 长连接** | `Bot ID + Secret` 从本机主动连接官方 WSS；接收单聊/群聊消息，使用回调 `req_id` 回复，也可按 userid/chatid 主动发送 | **不需要** | **已选择**。覆盖可信 sender、单聊/群聊 peer、原回调回复，并可随桌面 App 启停 |
| 群机器人 Webhook | 把消息 POST 到固定群的 Webhook；适合通知推送，不提供本卡需要的成员私聊入站与完整双向会话身份 | 不需要入站，但只有出站 Webhook | 不选。无法完成可信用户入站、私聊和原会话双向闭环 |
| 企业自建应用传统回调 | 企业微信向开发者配置的 URL 推送加密消息；配置 URL、Token、EncodingAESKey | **需要**公开可达回调 URL | 不选。会扩大为公网服务，且不符合 App 退出即停止的边界 |
| 微信客服 | 面向微信外部联系人的客服账号；回调通知后用 `sync_msg` 游标拉取消息，身份是 `open_kfid` / `external_userid` | 需要回调服务，并有独立客服权限模型 | 不选。产品身份域与“企业成员使用智能机器人”不同 |

官方依据：

- [企业微信智能机器人长连接协议](https://developer.work.weixin.qq.com/document/path/101463)和官方团队的 [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)明确其为正式 WebSocket 接入，支持消息收发、回复、主动推送、事件和媒体能力。Tencent 官方的[企业微信智能机器人接入指南](https://cloud.tencent.com/document/product/1689/128999)给出“智能机器人 → API 模式创建 → 使用长连接 → 获取 Bot ID/Secret”的具体入口。
- [群机器人消息推送配置](https://developer.work.weixin.qq.com/document/path/91770)使用群级 Webhook；它是固定群消息推送入口，不是本卡选择的智能机器人 API 长连接。
- [企业微信回调配置](https://developer.work.weixin.qq.com/document/path/90930)与[接收消息概述](https://developer.work.weixin.qq.com/document/path/92109)要求开发者提供 URL、Token、EncodingAESKey，故属于公网回调路线。
- [微信客服接收消息和事件](https://developer.work.weixin.qq.com/document/path/94670)使用 `open_kfid`、`external_userid` 和增量游标 `next_cursor`，是不同的客服产品与身份模型。

个人微信 Hook、桌面注入、协议逆向、托管扫码登录和非官方中继继续明确排除。

## 2. 选定方式的官方协议事实

### 2.1 SDK、连接和生命周期

- 官方包为 `@wecom/aibot-node-sdk`，默认地址为 `wss://openws.work.weixin.qq.com`，认证帧使用 `botId + secret`。SDK 提供心跳、进程存活期间的指数退避重连以及显式 `disconnect()`。[README](https://github.com/WecomTeam/aibot-node-sdk/blob/main/README.md)和[`src/ws.ts`](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/ws.ts)是协议与实现依据。
- 2026-09-22 查询 npm 得到最新包版本 `1.0.7`，而官方仓库 revision `80615b987ef69c6028ad764924609247c0725955` 的 `package.json` 仍为 `1.0.6`。仓库声明 MIT，依赖 `axios`、`eventemitter3`、`ws`，但未声明 `engines`；因此 Node.js 24 兼容性是 TASK-018 必须执行的安装/连接 spike，不得从构建元数据推断已兼容。[官方仓库 package.json](https://github.com/WecomTeam/aibot-node-sdk/blob/main/package.json)、[npm 1.0.7 包页](https://www.npmjs.com/package/@wecom/aibot-node-sdk/v/1.0.7)。
- Yuanpu 只在桌面 Runtime 存活时持有连接。App 退出流程必须调用 `disconnect()`，不得留下 Gateway 或后台 daemon。SDK 收到“新连接已建立”事件时会停止旧连接且不再自动重连；每个 Bot 只能由 Yuanpu 明确管理一个活动连接。

### 2.2 入站标识与消息范围

官方 SDK 的回调帧提供：

- `headers.req_id`：回复同一次回调时必须透传；
- `body.msgid`：本次回调唯一标志，官方类型注释明确用于排重；
- `body.aibotid`：智能机器人 ID；
- `body.chattype`：`single` 或 `group`；
- `body.chatid`：群聊时返回；
- `body.from.userid`：可信发送者 ID；
- `body.msgtype`、可选 `response_url` 和引用内容。

SDK 暴露 `text`、`image`、`mixed`、`voice`、`file`、`video` 消息事件，但首发契约只接收文本。SDK 没有暴露独立的“入站 ACK”调用，因此 Yuanpu 不得沿用其他平台的 ACK 假设：先持久化 `msgid` 去重记录，再调度 Agent；回复回执是另一条链路。

官方长连接协议明确群内只有 @ 机器人时才推送回调。Yuanpu 把“收到认证连接上的 group 回调”作为平台已确认 @ 的信号，不从正文自行解析 `@`；仍须同时检查群 `chatid` allowlist 和 sender 已配对。首发实现只有在隔离群完成真实 @/不 @ 验证后才打开群开关。

### 2.3 回复、主动发送与回执

- 被动回复走 `aibot_respond_msg`，必须使用原回调 `headers.req_id`。`replyStream()` 的 Promise 在收到回执帧后 resolve；`errcode != 0` 时 reject。
- 主动发送走 `aibot_send_msg`。单聊目标填 userid，群聊目标填 chatid；SDK 为主动发送生成新的 `req_id`。
- SDK 在发送后等待回执 5 秒；这只是 SDK 的本地超时实现，不是平台普通消息回复时限。回执 `errcode == 0` 只标 `accepted`，不能证明客户端已展示；官方协议也没有要求成功回执携带新消息 ID。
- `errcode != 0` 是明确失败；帧可能已经写出后遇到回执超时、断连或进程退出，结果必须标 `unknown`。SDK 文档没有给出可供 Yuanpu 使用的幂等键或投递查询接口，所以不得盲重发，也不得重跑 Agent。
- 普通消息应在收到消息后 24 小时内回复；回复与主动推送合计按同一会话限制为 30 条/分钟、1000 条/小时。欢迎语/模板卡更新的 5 秒时限不能误套到普通文本回复。

### 2.4 附件、限流和离线语义

- 图片/文件/视频下载 URL 的官方有效期为 5 分钟，每个链接带独立 `aeskey`；SDK 可下载并 AES-256-CBC 解密。首发不自动下载，不把 URL/aeskey 交给模型或普通日志。群聊只支持文本与图文混排入站；图片、语音、文件、视频只支持单聊。
- 上传以不超过 512 KiB 的分片传输，最多 100 片；上传会话 30 分钟有效、临时素材 3 天有效，单 Bot 上传限 30 次/分钟、1000 次/小时。SDK 还会对失败分片重试最多 2 次，属于实现行为；首发文本闭环不启用上传。
- 官方没有承诺 App 离线期间补推，也没有 resume cursor。离线补收保持 `unverified`，真实环境中必须做受控断线/恢复测试；不得把 SDK 的自动重连等同于离线补收。

## 3. Yuanpu 适配器契约

### 3.1 连接、身份与会话

- `connectionId` 是 Yuanpu 生成的不透明 UUID。`botId` 是连接元数据，Secret 只以 `keychain:yuanpu/im/<connectionId>/bot-secret` 引用。
- 配对键是 `connectionId + from.userid`。不信昵称、手机号、群名或正文自报身份。
- peer 映射：单聊用 `from.userid`，群聊用 `chatid`。session 键必须包含 `provider + providerAccountRef + connectionId + conversationType + peerId`；群内每次触发仍逐 sender 授权。官方协议没有 thread/topic ID，首版不得虚构线程能力。
- 不同 Bot 账号、连接、单聊用户或群绝不能共享 session。更换 Bot ID/Secret 必须建立新 connection，不复用旧配对和会话。

### 3.2 去重与执行

- 入站唯一键为 `provider + connectionId + msgid`。先原子持久化去重记录，再提交 Agent；重复 `msgid` 返回既有 run，不产生第二次执行。
- `body.aibotid` 必须与 connection 绑定的 Bot ID 一致；不一致的帧拒绝进入业务层。
- SDK 没有单独的入站 ACK API，因此契约是“持久化先于 Agent 调度”，不是虚构“ACK 先后”。
- 内容哈希不是去重键。重启后必须继续读取持久化去重记录；同一 `msgid` 在不同 connection 下仍是不同消息。

### 3.3 原会话回复

入站时冻结不可变 `replyRoute`：

`provider + providerAccountRef + connectionId + providerRequestId + providerMessageId + conversationType + conversationId`

`providerRequestId` 必须来自原回调 `headers.req_id`。模型只生成内容，不能指定 Bot、用户、群或 `req_id`。目标无效时显式失败，不降级到其他会话或主动私聊。

发送前持久化 Yuanpu `outboundId`、route、内容摘要与 `pending` 状态。状态机为 `pending → accepted | failed | unknown`。`accepted` 只表示 `errcode=0`；超时/断连 unknown 不自动重发。用户显式重发应建立新的 outbound，并显示可能重复的警告。

### 3.4 日志与消息隐私门禁

官方 SDK 的默认 `DefaultLogger` **不能在生产中使用**：当前源码会在 debug 级别打印完整 inbound frame body，`downloadFile()` 会打印完整下载 URL，unknown/invalid frame 路径会 `JSON.stringify` 原帧。消息正文、附件 URL、`aeskey`、`response_url` 和平台 ID 因而可能进入控制台日志。

TASK-018 必须在构造 SDK 客户端时注入 Yuanpu redacting logger：

- 禁止原始帧、正文、Bot ID、Secret、附件 URL、`aeskey`、`response_url`；
- 只允许哈希后的稳定 ID、类型、长度、连接状态和脱敏 `errcode`；
- warn/error 的额外参数也必须结构化白名单，不能直接透传 SDK 对象或异常 response；
- Secret 从系统安全存储解析后只驻留进程内存，退出时释放引用；fixture、任务证据与普通配置都不得出现真实值。

## 4. 配置字段

首版产品配置只允许：

- `enabled`、`provider=wecom`、`connectionId`；
- 非敏感 `providerAccountRef`（Bot ID 的连接元数据引用）；
- `credentialRefs.botSecret`（系统 Keychain 引用）；
- `directMessagePolicy=paired-only`；
- `groupPolicy=allowlist-paired-sender-and-provider-at-mention`，但在真实隔离群验收前保持功能开关关闭；
- `acceptedMessageTypes=[text]`；
- 经 TASK-018 验证后的连接/重连运行参数。

不得把 SDK 任意 options 直接透传为产品配置。特别是自定义 `wsUrl`、TLS CA、无限重连和日志实例只能由受审实现装配；普通用户配置不能把连接改向非官方中继。

## 5. 真实验证环境

当前环境状态：**unavailable / E2E unverified**。

开始 E2E 前必须补齐：

1. 一个可创建“智能机器人”的隔离企业微信组织，以及管理员/开发者权限证据；
2. 机器人以“API 模式 + 使用长连接”创建；Bot ID 写入连接元数据，Secret 绑定到 SecretStore，仓库和证据只保留引用；
3. 两个测试成员 A/B，一条 A 与机器人的单聊，一个仅含测试成员的隔离群；
4. 对这些会话试发的明确授权；
5. Node.js 24 桌面环境，允许出站访问官方 WSS/API，不开放入站端口；
6. 可清空的测试数据库与脱敏日志。

验收顺序：

1. 固定 SDK 版本/完整性并完成 Node 24 加载、鉴权、心跳、断开；
2. A 配对后单聊入站，检查 `msgid`、`req_id`、userid 与同会话回复；
3. B 未配对必须在 Agent 前拒绝；
4. 重放同一 `msgid`，包括进程重启后，只能产生一个 run；
5. 隔离群分别测试未 @、@ 机器人、@所有人和重复消息，记录平台真实触发语义后才启用群；
6. 制造回执 `errcode != 0` 与写出后超时/断连，分别得到 `failed` 与 `unknown`，均不重跑 Agent；
7. 断网重连、第二连接挤掉旧连接、App 退出调用 `disconnect()`；
8. App 退出期间发送消息，再启动后只记录实测是否补收，不预设结果；
9. 非文本消息得到可见的 unsupported 结果，且日志无 URL/aeskey/正文。

## 6. Fixture 边界

[`fixtures/im-contract/scenarios.json`](fixtures/im-contract/scenarios.json) 的归一化 fixture 可以证明：字段映射约束、配对策略、账号/渠道/peer 隔离、`msgid` 去重、原 `req_id` 路由、发送 unknown 状态、日志禁止项和 App 退出策略。

Fixture 不能证明：真实账号权限、Bot ID/Secret 有效、WSS 鉴权、目标租户里的群 @ 实际投递、平台限流实际响应、离线补收、附件传输、Node 24 兼容或客户端最终展示。

运行静态契约检查：

```bash
node scripts/verify-im-channel-contract.mjs
```

检查器允许“平台已选择但环境未就绪”，只有状态改成 `ready-for-e2e` 时才强制账号权限证据、SecretStore 绑定和至少两个测试会话引用。

## 7. TASK-018 实现建议

TASK-018 应实现 Yuanpu 自有 adapter，对官方 SDK 做窄封装，而不是把 SDK 对象直接暴露给 Runtime：

- 精确固定 `@wecom/aibot-node-sdk` 版本与 integrity，先完成 Node 24 spike；
- adapter 负责归一化、持久化去重、身份/群门禁、replyRoute、outbound 状态机和 redacting logger；
- App 启动时连接，退出时等待在途状态落库后调用 `disconnect()`；
- 首版只开文本单聊；群聊与附件必须分别通过真实门禁后再启用；
- 不建设公网 Gateway，不使用个人微信非官方接入，不修改 Pi 上游。
