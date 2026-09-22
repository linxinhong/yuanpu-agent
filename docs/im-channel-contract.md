# 首个 IM 接入契约与验证环境

状态：**等待用户选择平台**

任务：确定首个 IM 接入契约与验证环境（TASK-017）

官方资料核验日期：2026-09-22

本文只确定首个渠道的选择门槛、适配器边界和验证环境，不声称任何平台已经接通。当前没有用户确认的平台、组织账号、机器人权限、凭据或测试会话，因此不能完成真实端到端验收。

## 1. 需要用户确认的选择

请选择一个实际拥有管理员或开发权限、可以创建测试机器人的平台：

1. **飞书企业自建应用机器人 + WebSocket 长连接（建议默认候选）**。官方 Node SDK 可从本机主动建立长连接，接收消息事件并回复原消息，无需公网 IP、域名或入站 Gateway；需要可创建并发布企业自建应用的飞书组织、机器人能力、消息权限、事件订阅和受限测试可见范围。
2. **企业微信智能机器人 + WebSocket 长连接**。官方 Node SDK 以 `Bot ID + Secret` 建连，覆盖消息收发、流式回复和附件；需要企业微信组织已开放智能机器人创建入口及测试权限。若目标用户主要使用企业微信，应优先于飞书候选重新评估。
3. **钉钉企业内部应用机器人 + Stream 模式**。官方 Node SDK 支持 Stream 消息接收，无需自建入站 Webhook；需要钉钉组织、企业内部应用、机器人能力、应用发布和测试可见范围。
4. **微信服务号**。官方接入是微信服务器向开发者 URL POST 消息，要求可公开访问的回调端点；这与“本机 Runtime 随 App 退出、不得擅建公网 Gateway”的当前边界不匹配。只有用户同时确认合格的服务号账号和另行授权公网接入后才可选择。

**排除项：**个人微信的非官方 Hook、桌面注入、协议逆向和托管登录均不进入候选。

“建议默认候选”不是产品决策。只有用户明确选择并确认账号条件后，`docs/im-channel-contract.json` 的 `decision.status` 才能从 `awaiting-user-selection` 改为 `selected`。

## 2. 官方能力核验

| 候选 | 官方机器人类型与收发方式 | 公网入站 | 账号与权限前提 | 当前判断 |
| --- | --- | --- | --- | --- |
| 飞书 | 企业自建应用机器人；`im.message.receive_v1` 由官方 SDK 的 WebSocket 长连接接收，回复绑定 `messageId`，线程沿用原消息 | 不需要；本机需能访问飞书公网 API/WSS | 飞书组织内创建/发布自建应用；启用机器人；配置消息事件和所需权限；限制到测试用户/群 | **建议默认候选**：Node/TypeScript 路径成熟，符合本机 App 生命周期 |
| 企业微信 | 智能机器人；官方 `@wecom/aibot-node-sdk` 使用 `Bot ID + Secret` 建立 WebSocket，支持接收与回复 | 不需要；本机需访问 `wss://openws.work.weixin.qq.com` | 企业微信组织具备智能机器人入口；可创建测试机器人并取得凭据 | 合适，但须先确认目标组织确实有该能力和测试入口 |
| 钉钉 | 企业内部应用机器人；官方 Stream SDK 使用 `Client ID + Client Secret` 接收机器人消息 | 不需要；本机需访问钉钉公网 API/WSS | 钉钉组织内创建企业内部应用、启用并发布机器人、设置 Stream 模式 | 可行备选；需要按当前 SDK 版本验证重连、ACK 和回复语义 |
| 微信服务号 | 服务号消息服务器；微信服务器 POST XML 到配置 URL，按原请求被动回复或调用客服消息 API | **需要**公开 HTTPS 回调 | 服务号及相应认证/接口权限、公开 URL、Token/EncodingAESKey | 当前不选；会扩大到公网基础设施 |

核验依据只使用平台官方文档或官方 SDK：

- 飞书：[官方 Node SDK 长连接说明](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)、[官方 Channel 文档](https://github.com/larksuite/node-sdk/blob/main/docs/channel.zh.md)、[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。官方资料确认长连接仅需出站公网访问；事件可能超时重推；消息包含 `message_id`、`chat_id`、`root_id`/`parent_id` 和可信 sender ID；Channel API 能以 `replyTo` 回原消息并保持线程。
- 企业微信：[官方智能机器人 Node SDK](https://github.com/WecomTeam/aibot-node-sdk)。官方 SDK 说明默认连接 `wss://openws.work.weixin.qq.com`，用 `botId + secret` 认证，支持文本、图片、图文、语音、文件、回复和主动推送。
- 钉钉：[官方 Stream Node SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)、[机器人接收消息](https://opensource.dingtalk.com/developerpedia/docs/learn/bot/appbot/receive/)、[Stream 协议](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/protocol/)。官方资料确认企业内部应用可选择 Stream，单聊直接触发、群聊需 @ 机器人，网络重复推送必须去重。
- 微信服务号：[接入指南](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Access_Overview.html)、[接收普通消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)、[被动回复](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Passive_user_reply_message.html)。官方资料确认消息 POST 到开发者 URL，以 `MsgId` 排重；五秒内未响应会断开并最多重试三次。

以下事实必须在选定平台后再次用对应官方页面核验并写入机器契约，不能从候选资料外推：精确 API 限流数值、附件大小/MIME 限制、租户版本或认证资格、离线期间是否补推、主动消息时间窗及 API 幂等参数。

## 3. 统一适配器契约

机器可校验版本见 [`im-channel-contract.json`](im-channel-contract.json)，归一化 fixture 场景见 [`fixtures/im-contract/scenarios.json`](fixtures/im-contract/scenarios.json)。它们不包含平台原始 payload，也不代表平台已选定。

### 3.1 连接与生命周期

- `connectionId` 是 Yuanpu 生成的不透明 UUID，不包含 secret；平台账号、租户、App/Bot ID 只作为连接元数据。
- 连接由桌面 App 管理的 Runtime 建立和关闭。App 退出后断开，不保留独立后台进程。
- 长连接只允许主动出站访问平台官方 WSS/API；选择需要入站公网回调的方式属于新的架构决策。
- 每个连接持久化 `provider`、`providerAccountRef`、`credentialRefs`、授权状态和最近连接状态；不得把 secret 写入普通配置、fixture、日志或任务证据。

### 3.2 入站确认、标识和去重

适配器必须从平台认证后的事件结构提取：

- `providerDeliveryId`：本次平台投递/事件的稳定 ID；
- `providerMessageId`：聊天消息的稳定 ID；
- `trustedSenderId`：认证事件里的平台用户 ID，不读取正文自报身份；
- `conversationId`、`threadId`、`replyToMessageId` 和 `messageType`；
- `connectionId` 与接收时间。

Runtime 在向平台 ACK 前，原子写入归一化入站记录和去重键。去重键为 `provider + connectionId + providerDeliveryId`；同时对 `provider + connectionId + providerMessageId` 建唯一关联，防止同一消息以不同投递 ID 重放后重复执行。内容哈希不能作为主要去重键。

若持久化失败，不得 ACK 成功；若已经存在去重记录，则 ACK 且返回既有 `runId`，不能再次提交 Agent。模型执行必须脱离平台 ACK 时限异步进行。

离线补收默认记为 `unverified`。没有选定平台的官方补收 API 和真实断线试验前，不承诺 App 退出期间的消息会在重启后收到。

### 3.3 身份配对和会话键

- 配对主键是 `connectionId + trustedSenderId`，保存本机用户显式确认的权限；昵称、手机号、正文和群名都不是身份。
- 私聊只有已配对 sender 可触发；会话键由 `provider + connectionId + conversationId + threadId-or-root` 派生。
- 群聊必须同时满足：群在 allowlist、触发 sender 已配对、事件确认机器人被 @。`@所有人` 不等价于 @ 机器人。
- 群内会话按 conversation/thread 隔离，权限仍逐 sender 检查；不同连接、群、话题或租户绝不能共享会话。
- 桌面续接 IM 会话必须引用已有内部 session 映射，不能仅凭平台昵称或群名查找。

### 3.4 原会话回复

入站归一化后立即生成不可变 `replyRoute`：`provider + connectionId + conversationId + threadId + providerMessageId`。模型只产生内容，不能指定连接、用户或群。

适配器优先调用平台的“回复原消息”能力；原消息在线程中则保持原线程，平铺消息不主动新建线程。不得因为原消息被撤回或回复目标无效而静默改为其他会话、私聊或主动推送。若 SDK 默认会在回复目标撤回时降级成普通新消息，首版必须禁用/绕开该降级或把它变成显式失败。

### 3.5 发送未知结果

发送前先持久化 `outboundId`、目标 `replyRoute`、内容摘要和 `pending` 状态。只有收到平台明确成功响应和稳定消息 ID 才标 `delivered`；明确、确定未受理的校验/权限错误标 `failed`。

请求可能已经写出后发生超时、断连、进程退出或无法解释的 5xx 时，标 `unknown`：

- 不重新运行模型；
- 不盲目重发；
- 仅当选定平台明确提供幂等键或按请求 ID/消息 ID 查询时自动核对/重试；
- 无法核对时在桌面显示“发送结果未知”，由用户决定是否重发。

投递失败只重试投递，不重做 Agent run。限流按平台响应和 `Retry-After`/官方退避要求处理；选定前不编造统一数值。

### 3.6 附件约束

首个闭环只承诺 UTF-8 文本。图片、文件、语音、视频和富文本在未实现平台专用下载、鉴权、大小/MIME 限制、恶意内容隔离与用户可见错误前，统一归一化为 `unsupported`，不把远程 URL 或文件自动交给模型/本机工具。

选定平台后必须把官方附件类型、大小、下载凭据生命周期、落盘临时目录、清理策略和限流写入 `providerLimits`，再添加脱敏原始 fixture 与真实附件验证。

### 3.7 配置字段

首版连接配置只暴露以下字段；未列出的 SDK 开关不得直接透传到产品配置：

- `enabled`、`provider`、`connectionId`、非敏感的 `providerAccountRef`；
- `credentialRefs`（只保存 `env:`/`keychain:` 引用）；
- `directMessagePolicy: paired-only`；
- `groupPolicy: allowlist-and-mention` 与不透明的 `groupAllowlist`；
- `acceptedMessageTypes: [text]`；
- `connectTimeoutMs`、`reconnectBackoff` 和 `outboundConcurrency`，默认值须在选定 SDK 后以官方行为和故障测试确定；
- `providerLimits.sourceUrl/verifiedAt` 及选定平台的限流、附件、ACK/回复时窗；没有官方来源时保持未配置，而不是猜测数值。

用户身份配对、session 映射、入站去重和 outbound 状态是持久化业务数据，不塞进静态连接配置。更改 provider、平台账号或凭据引用应建立新 `connectionId`，防止旧配对和会话错误复用。

## 4. 凭据引用

仓库只记录引用，不记录值：

| 候选 | 非 secret 引用 | secret 引用 |
| --- | --- | --- |
| 飞书 | `env:YUANPU_FEISHU_APP_ID` 或连接元数据 | `keychain:yuanpu/im/<connectionId>/app-secret` |
| 企业微信 | `env:YUANPU_WECOM_BOT_ID` 或连接元数据 | `keychain:yuanpu/im/<connectionId>/bot-secret` |
| 钉钉 | `env:YUANPU_DINGTALK_CLIENT_ID` 或连接元数据 | `keychain:yuanpu/im/<connectionId>/client-secret` |
| 微信服务号 | `env:YUANPU_WECHAT_APP_ID` 或连接元数据 | Keychain 中的 App Secret、Token、EncodingAESKey 独立引用 |

环境变量只适用于受控开发验证；产品配置必须接入系统安全存储。日志只打印 `connectionId` 和凭据引用类型，不打印引用的解析值。

## 5. 真实验证环境

选定平台后，真实 E2E 至少需要：

- 一个隔离测试组织/租户，以及可以创建、发布和限制机器人可见范围的管理员/开发者；
- 一个只用于 Yuanpu 的测试机器人/应用，所需最小消息权限，凭据通过 Keychain/临时环境变量注入；
- 两个测试成员账号 A/B、一条 A 与机器人的私聊、一个包含 A/B/机器人的测试群；若平台支持线程，再增加一个测试话题；
- 运行 Node.js 24 的测试桌面机，允许访问平台官方 WSS/API；不开放本机入站端口；
- 可清空的本机测试数据库和脱敏日志，记录版本、测试时间、connection/message/session/outbound ID 的不透明引用；
- 明确授权的测试会话，禁止向真实业务群试发。

真实验收顺序：连接鉴权 → A 私聊收发 → 群里 A @ 机器人 → B 未配对拒绝 → 重复事件只执行一次 → 同消息跨连接不串线 → 线程原位回复 → 发送超时进入 `unknown` 且不重跑模型 → 断线重连 → App 退出期间发消息并记录是否补收 → 文本外附件得到预期拒绝或受控处理。

当前所有这些项目均为 **unverified**，因为没有用户选择、账号、凭据和测试会话。

## 6. Fixture 能证明与不能证明的内容

归一化 fixture 可以验证：必需标识、可信 sender、配对/群触发、会话隔离、去重、重启后的去重记录、不可变回复路由、附件拒绝、发送未知状态不重跑模型。

Fixture 不能证明：平台权限实际可用、长连接认证、平台真实重推/限流、离线补收、回复到正确客户端会话、附件真实下载、平台消息最终展示或 App 退出后的外部行为。上述结果只能由选定平台的真实测试环境证明。

运行静态契约检查：

```bash
node scripts/verify-im-channel-contract.mjs
```

选定平台时，先补齐机器契约的 `selectedCandidateId`、用户决策引用、账号权限引用、测试会话引用和 `providerLimits`；检查器会拒绝缺项的 `selected` 状态。
