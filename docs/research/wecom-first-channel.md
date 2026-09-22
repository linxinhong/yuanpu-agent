# 企业微信首发 IM 接入调研

状态：**首发方式已锁定为“企业微信智能机器人 API 模式 + WebSocket 长连接”**

面向任务：TASK-017 决策与 TASK-018 实现
官方资料核验日期：2026-09-22

本文只使用企业微信开发者中心、Tencent 官方文档和 `WecomTeam` 官方仓库/发布包。尚未取得目标企业的机器人权限、`BotID`、`Secret` 或授权测试会话，因此所有真实平台收发、断线和离线行为仍为 `unverified`。

## 1. 结论

企业微信的几种“机器人/消息”能力不是同一种产品：

| 官方接入类型 | 接收入站 | 回复/发送 | 私聊与群聊 | 是否需要公网入站 | 对 TASK-018 的结论 |
| --- | --- | --- | --- | --- | --- |
| 群机器人/自定义消息推送 Webhook | 官方接口只定义向某个群的 Webhook `POST` 消息，未定义成员消息入站 | 可向该群推送 | 仅固定群出站 | 否 | **不匹配**：没有可信 sender、私聊入站或原消息回复 |
| 企业自建应用消息 | 通过应用的 URL 回调接收成员在应用会话中的消息 | 可被动回复或用应用消息 API 主动发送 | 单聊可收；应用创建的内部群只能发，官方明确“暂不支持接收群聊消息” | **是** | **不匹配**：缺群入站，且要求公网回调服务 |
| 微信客服 | URL 回调只通知有新消息，再用 `sync_msg` 游标拉取；对象是微信客户/接待人员 | 48 小时窗口内最多发 5 条；有发送失败事件 | 客服单会话，不是企业内部成员私聊+群聊 | **是**（官方事件流程） | **不匹配**：业务对象和会话模型不同，且无企业内部群聊 |
| 智能机器人 API 模式：设置接收消息 URL | 加密 URL 回调；单聊和群内 @ 都可触发 | 被动回复/流式刷新 | 支持单聊和群内 @ | **是** | 能满足会话语义，但违反“不建设常驻公网入口” |
| 智能机器人 API 模式：WebSocket 长连接 | 机器人从本机主动连接企业微信；单聊和群内 @ 触发 `aibot_msg_callback` | `aibot_respond_msg` 回原回调；`aibot_send_msg` 主动发单聊/群聊 | 支持 | **否**；只需出站 WSS | **最匹配并已选定** |

选择长连接的决定性理由：企业微信官方文档把它定义为智能机器人 API 模式的正式接收方式；以 `BotID + Secret` 建立到 `wss://openws.work.weixin.qq.com` 的出站连接，不要求固定公网 IP，能同时收到成员单聊和群内 @ 消息，并能使用回调 `req_id` 回复。连接可以跟随桌面 App 创建和销毁，符合“App 退出后停止”。

智能机器人 API 模式的“长连接”和“设置接收消息回调地址”是**互斥选项**；切换模式会使另一模式失效。首版不得同时配置 URL 回调作为隐式兜底。

主要官方依据：

- [智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)
- [智能机器人 URL 模式接收消息](https://developer.work.weixin.qq.com/document/path/100719)
- [官方 Node.js SDK README](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/README.md)
- [Tencent Cloud：企业微信后台创建入口示例](https://cloud.tencent.com/document/product/1689/128999)

## 2. 各官方接入类型的边界

### 2.1 群机器人 Webhook

官方“消息推送配置说明”只定义创建者取得群专属 `webhookurl` 后，开发者向其发起 HTTP `POST`；Webhook 中的 `key` 就是调用凭证。支持文本、Markdown、图片、图文、文件、语音和模板卡片，限制为每个消息推送 20 条/分钟。官方示例仓库也只有发送消息和上传文件流程。

官方没有为这种 Webhook 定义成员消息回调、sender 字段、私聊或以入站消息为锚点的回复协议。因此它只能作为固定群通知出口，不能承担“可信用户操作本机 Pi”。Webhook URL 一旦泄漏即可被用于发消息，必须当作 secret，不能进仓库或日志。

来源：[群消息推送配置说明](https://developer.work.weixin.qq.com/document/path/91770)、[WecomTeam/RobotSample](https://github.com/WecomTeam/RobotSample/tree/9915b81427ff7dc9b668d6a53a2e4f3e32336aac)

### 2.2 企业自建应用消息/回调

自建应用在管理后台进入目标应用的“接收消息 → 设置 API 接收”，配置 `URL`、`Token`、`EncodingAESKey`。企业微信向该 URL 发 GET 验证和 POST 消息；POST 需在 5 秒内返回 HTTP 200，否则断连并总共重试 3 次。有 `msgid` 的消息按 `msgid` 排重，事件按 `FromUserName + CreateTime` 排重。不能在 5 秒内完成业务时应先空响应 200，再异步调用主动发送接口。

它能接收成员在应用客户端会话中的单聊消息，也能用 `access_token` 调用应用消息 API。可是官方消息概述明确区分：应用创建的内部群聊可以推送消息，**暂不支持接收群聊消息**。此外回调 URL 必须可被企业微信访问，所以不符合当前不建设公网 Gateway 的约束。

来源：[消息接口概述](https://developer.work.weixin.qq.com/document/path/90235)、[接收消息概述](https://developer.work.weixin.qq.com/document/path/90238)、[发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)、[回调配置](https://developer.work.weixin.qq.com/document/path/90930)

### 2.3 微信客服

微信客服针对微信客户与客服账号。企业微信先向企业 URL 回调 `kf_msg_or_event`，企业再带回调中的 10 分钟有效 `token` 调用 `sync_msg` 拉取具体内容。拉取结果提供 `next_cursor`、`msgid`、`open_kfid`、`external_userid` 和消息来源；游标必须持久化。第一次不带游标可从最近 3 天最早消息开始，回调 token 可省略但会受到严格频率限制。

发送接口只适用于“新接入待处理”或“由智能助手接待”状态；客户主动发消息后的 48 小时内最多发送 5 条。接口 `errcode=0` 不代表最终投递成功，还要消费消息发送失败事件。该接口支持调用方指定客服账号内唯一的 `msgid`。

这套能力适合外部客户服务，不是企业成员通过机器人操作本机 Agent；没有内部群聊入站，并依赖公开事件回调。即使利用三天游标拉取，它也不能替代本任务的企业内部私聊+群聊渠道。

来源：[微信客服接收消息和事件](https://developer.work.weixin.qq.com/document/path/94670)、[微信客服发送消息](https://developer.work.weixin.qq.com/document/path/94677)

### 2.4 智能机器人 URL 回调

URL 模式支持成员单聊和群内 @ 机器人，消息体包含 `msgid`、`aibotid`、群聊时的 `chatid`、`chattype`、`from.userid`、`response_url` 和消息内容。官方明确 `msgid` 用于网络重复回调的事件排重。接收和被动回复均加密，凭据是 `URL + Token + EncodingAESKey`。

它的会话能力与长连接接近，但必须提供公网可访问 URL并处理签名、加解密和回调时限，因此首版不选。它与长连接不能同时启用。

来源：[智能机器人接收消息](https://developer.work.weixin.qq.com/document/path/100719)、[回调和回复的加解密方案](https://developer.work.weixin.qq.com/document/path/101033)、[长短连接对比](https://developer.work.weixin.qq.com/document/path/101463)

## 3. 选定方式的可执行接入契约

### 3.1 账号、创建入口与凭据

真实环境至少需要：

1. 一个已注册的企业微信组织，以及可进入管理后台创建/配置智能机器人的企业管理员。Tencent 官方示例路径为“安全与管理 → 管理工具 → 智能机器人 → 创建机器人 → 手动创建 → API 模式创建”；最终入口和菜单名称要在目标租户核验。
2. 在机器人 API 模式中选择“长连接”，取得 `BotID` 与长连接专用 `Secret`。它们不同于 URL 模式的 `Token/EncodingAESKey`。
3. 机器人对测试成员和测试群可用；具体可见范围、目标租户是否已开放该入口、是否要求企业认证，官方长连接页没有给出完整资格矩阵，必须在真实账号中确认，当前记为 `unknown`。

凭据处理：

- `BotID` 可作为非敏感连接元数据；`Secret` 只保存 Keychain 引用，例如 `keychain:yuanpu/im/<connectionId>/bot-secret`。
- 不把 Secret、解析后的凭据、原始入站体、临时下载 URL 或 `aeskey` 写入配置、fixture、日志或任务证据。
- 每次更换机器人或 Secret 创建新的 Yuanpu `connectionId`，避免复用旧配对与会话映射。

### 3.2 连接与 App 生命周期

- 连接地址是 `wss://openws.work.weixin.qq.com`；私有部署企业可能由管理端给出不同地址。
- 建连后用 `aibot_subscribe` 发送 `BotID + Secret`。官方要求定期 `ping`，建议 30 秒；需要断线检测和重连。
- 每个智能机器人同一时刻只能有一个有效长连接。新连接订阅成功会踢掉旧连接，并向旧连接发送 `disconnected_event`。Yuanpu 必须保证同一机器人单实例拥有连接，不能用同时多连接做 HA。
- 桌面 App 启动 Runtime 时连接；App 退出时调用 SDK `disconnect()`，停止心跳、清除重连定时器和待回执队列并关闭 socket。不得启动独立守护进程。该行为由官方 SDK 当前源码实现，但 TASK-018 仍应做进程级验收。
- 非手动断线可重连；手动退出不得重连。若收到“新连接踢旧连接”，应显示明确冲突，不进入无限抢占。

来源：[长连接协议与连接限制](https://developer.work.weixin.qq.com/document/path/101463)、[SDK `disconnect` 源码](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/ws.ts)

### 3.3 入站信任、标识和会话键

只信任已认证 WSS 连接上的结构化字段，不信任消息正文自报的姓名、手机号或 ID。

| Yuanpu 语义 | 企业微信字段/派生规则 |
| --- | --- |
| 连接 | 本机生成 `connectionId`；平台机器人是 `body.aibotid`/`BotID` |
| 入站去重 ID | `body.msgid`。官方称其为“本次回调的唯一性标志，用于事件排重” |
| 回复相关 ID | `headers.req_id`；所有针对该回调的回复必须透传。它是关联 ID，不是主去重键 |
| 可信 sender | `body.from.userid` |
| 私聊会话 | `provider + connectionId + single + from.userid`；私聊回调不返回 `chatid` |
| 群聊会话 | `provider + connectionId + group + body.chatid` |
| 线程/话题 | 官方协议未给出 thread/topic ID；首版不得虚构线程能力 |

官方只暴露一个 `msgid`，没有另一个独立“投递 ID”和“聊天消息 ID”。若统一 schema 强制两者都存在，应明确把两者设为同一平台 `msgid` 的别名，而不是用 `req_id` 冒充消息 ID。

`from.userid` 可能是明文，也可能是企业主体下的加密 userid：机器人创建者为企业超级管理员时为明文，否则为加密值。首版配对可以把收到的值作为 connection-scoped 不透明身份；如确需换成明文，可用自建应用 access token 调用官方转换接口，且成员必须在该自建应用可见范围内。转换不是首个闭环的必要条件。

权限规则：

- 私聊：只有 `(connectionId, from.userid)` 已配对才执行。
- 群聊：平台只在成员群内 @ 机器人时推送该类消息，因此“收到群回调”可作为平台确认的 @ 触发；仍必须同时检查群 `chatid` allowlist 和 sender 已配对。不要从正文自行解析 `@`。
- 两个机器人、两个 sender 或两个 `chatid` 不共享 Pi session。

来源：[长连接接收消息字段](https://developer.work.weixin.qq.com/document/path/101463)、[自建应用与智能机器人的 userid 转换](https://developer.work.weixin.qq.com/document/path/101521)

### 3.4 接收、回复与主动发送

企业微信用 `aibot_msg_callback` 推送消息：

- 文本和图文混排支持单聊与群聊；图片、语音、文件、视频只支持单聊。群聊必须 @ 机器人。
- 回复原回调使用 `aibot_respond_msg`，透传入站 `req_id`。普通回复窗口为收到消息后的 24 小时。
- 流式回复用 `stream.id` 关联更新，所有帧仍使用同一入站 `req_id`；首次流式发送后 10 分钟内必须 `finish=true`。
- 进入会话欢迎语和模板卡片点击更新要求在事件后 5 秒内回复；这两个时限不是普通 Agent 文本回复的时限。
- 主动发送用 `aibot_send_msg`。单聊目标填用户 `userid`，群聊目标填先前回调得到的 `chatid`，并显式填 `chat_type`。官方要求用户先在该会话中给机器人发过消息，机器人之后才能主动推送到该会话。

TASK-018 的默认路径应是保存入站 `req_id` 后以一个最终 `stream` 回复原回调，而不是把模型生成的目标地址交给主动发送 API。主动发送只用于明确的异步通知场景，并沿用已冻结的 sender/chat 路由。

官方回复和主动发送成功响应只有原样返回的 `req_id`、`errcode`、`errmsg`，没有稳定的 outbound message ID，也没有在长连接文档中发现发送结果查询 API。

### 3.5 ACK、去重、超时、重试和未知结果

平台协议与 SDK 行为必须分开：

- **入站 ACK：**官方长连接协议没有定义单独的“接收成功 ACK”命令；收到的是 `aibot_msg_callback`/`aibot_event_callback` 帧。`aibot_respond_msg` 是用户可见回复，不应伪装成 ACK。收到帧后应先持久化 `msgid`、`req_id`、路由和去重记录，再异步提交 Agent。
- **入站去重：**数据库唯一键使用 `(provider, connectionId, msgid)`。官方要求用 `msgid` 做事件排重；WSS 文档未给出重投次数、顺序或断线重放保证，因此无论是否观察到重复都必须幂等。
- **回复回执：**平台对命令以同一 `req_id` 返回 `errcode/errmsg`。只有收到 `errcode=0` 才能记为平台已受理；文档没有承诺客户端已展示。
- **SDK 超时：**官方 SDK `main@80615b9` 对回复回执使用固定 5 秒超时，并按同一 `req_id` 串行排队；断线会 reject 所有 pending。这个 5 秒是 SDK 实现细节，不是官方协议声明的普通回复时限。
- **未知结果：**帧已写入 socket 后遇到 5 秒无回执、断线或进程退出，消息可能已被平台受理，状态必须是 `unknown`。不重新运行 Agent，不盲目重发。因为协议没有提供幂等键、outbound message ID 或查询接口，首版不能自动把 `unknown` 改为成功/失败。
- **重试：**SDK 会对连接做指数退避重连，但不会安全地重试结果未知的回复。首版宜一次发送最终 `finish=true` 文本，避免一个流式队列中前一帧未知后 SDK 继续发送后一帧。确定在写 socket 前失败可以重试投递；已写出则不能。

Yuanpu 发送前应持久化本地 `outboundId`、`req_id`、不可变路由、内容摘要和 `pending`。收到 `errcode=0` 记 `accepted`；明确非零错误记 `failed`；上述不确定场景记 `unknown`。

来源：[长连接命令响应](https://developer.work.weixin.qq.com/document/path/101463)、[SDK 回执队列源码](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/ws.ts)

### 3.6 限流、附件与离线

已由官方长连接文档确认：

- 对同一会话，回复与主动推送合计 30 条/分钟、1000 条/小时。
- 订阅请求有频率保护，但官方未给具体数值；认证成功后不得反复 subscribe。
- 上传临时素材以 512 KiB（Base64 前）分片，最多 100 片；上传会话 30 分钟有效，素材 3 天有效；单机器人上传 30 次/分钟、1000 次/小时。不同媒体类型的更细上限没有在长连接页完整给出，保持 `unknown`。
- 图片/文件/视频入站 URL 只有 5 分钟有效，并带每个链接唯一的 `aeskey`，使用 AES-256-CBC 解密。语音消息已转为文本。

首个闭环只接收 UTF-8 文本。图片、图文混排、文件、语音、视频显式回复“不支持”，不下载、不落盘、不交给模型；后续开启附件前再实现 MIME/大小校验、隔离目录、清理和恶意内容防护。

离线边界：官方要求心跳和断线重连，但没有声明 App 关闭、连接不存在期间的消息会排队、补推或可用游标拉取；协议也没有 resume cursor。故离线补收为 **unknown/unverified**，不能承诺。真实验收必须在 App 退出期间各发一条私聊和群 @，重启后记录实际结果；即使一次实验收到，也不能外推平台保证，除非获得新的官方契约。

### 3.7 隐私、安全与 SDK 版本门禁

官方 SDK 默认日志不能直接用于产品环境。`main` 当前 commit `80615b987ef69c6028ad764924609247c0725955` 的源码会：

- debug 记录完整入站 `frame.body`，其中可能包含用户 ID、消息正文、临时下载 URL 和 `aeskey`；
- warn 记录完整 unknown frame，invalid frame 会记录前 200 字符；
- `downloadFile` debug 记录完整下载 URL；
- `DefaultLogger` 将 debug/info/warn/error 全部写到 console。

TASK-018 必须在创建 `WSClient` 时注入 Yuanpu redacting logger，并对**所有级别和所有可变参数**脱敏；仅关闭 debug 不够，因为 warn 也可能包含原始帧。允许记录的字段限于本机 `connectionId`、命令类别、哈希化/截断后的关联 ID、状态码和时间，不记录正文、userid、chatid、Secret、URL、aeskey 或卡片内容。原始 fixture 必须人工脱敏。

版本事实也需要门禁：

- 2026-09-22 查询 npm，`@wecom/aibot-node-sdk` 的 `latest` 是 `1.0.7`；
- 官方 GitHub `main@80615b9` 的 manifest 仍是 `1.0.6`，而 npm 1.0.7 标记的 `gitHead` 是仓库当前不可见的 `ea48edf...`；不能把 `main` 源码审计结果自动等同于 npm 1.0.7；
- npm 1.0.7 tarball 仍含上述原始日志行为；
- GitHub manifest 和 npm 1.0.7 package manifest 均没有 `engines`，所以官方没有声明 Node.js 24 兼容范围。

实现时不要使用版本范围；若采用 npm latest，应精确锁定 `@wecom/aibot-node-sdk@1.0.7` 及 lockfile integrity，审计实际 tarball，并在项目的 Node.js 24 上做建连、断线、退出和文件拒绝 smoke test。升级版本需重新审计日志、回执队列和断连行为。

来源：[npm 包页面](https://www.npmjs.com/package/@wecom/aibot-node-sdk)、[GitHub package.json](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/package.json)、[默认日志实现](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/logger.ts)、[原始帧日志源码](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/ws.ts)、[下载 URL 日志源码](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/client.ts)

## 4. 真实 E2E 验证环境与验收卡

### 4.1 环境

- 一个隔离的企业微信测试组织；一名能创建/配置智能机器人的管理员。
- 一个只供 Yuanpu 测试的 API 模式长连接智能机器人，限制到测试范围。
- `BotID` 非敏感引用和 Keychain 中的 `Secret`；仓库、日志和截图不出现 secret。
- 两个测试成员 A/B：A 已配对，B 未配对；一条 A 与机器人的单聊；一个含 A/B/机器人的内部测试群。
- 一台运行项目指定 Node.js 24 的桌面测试机，只开放到企业微信 WSS/API 的出站访问，不开放本机入站端口。
- 可清空的本机测试数据库和脱敏日志；明确授权的测试会话，禁止向真实业务群发送。

### 4.2 必须在真实客户端验证

1. 用 `BotID + Secret` 鉴权，确认同一机器人只存在一个连接。
2. A 私聊发文本，Yuanpu 以原 `req_id` 回复，企业微信客户端在同一单聊展示结果。
3. A 在 allowlist 群内 @ 机器人，回复出现在同一群；不 @ 时不触发。
4. B 私聊与群 @ 均被拒绝且不启动 Agent；A/B、私聊/群聊不串 Pi session。
5. 对同一 `msgid` 重放脱敏帧只产生一次 run；真实平台若出现重复投递也只执行一次。
6. 人为断网再恢复，验证指数退避重连；恢复不能重跑已持久化消息。
7. 在回复帧写出后阻断回执，验证 outbound 进入 `unknown`、不重跑 Agent、不自动重发。
8. App 退出后 socket、心跳和重连计时器全部消失；重开恢复配置和 session 映射。
9. App 退出期间分别发送私聊和群 @，重开后记录是否收到；结果只作为观察，不把单次行为写成平台保证。
10. 收到图片/文件/语音/视频时按首版策略拒绝，日志不出现内容、临时 URL 或 `aeskey`。
11. 用户先发消息后，在同一测试单聊和测试群各验证一次受控主动推送；不向其他会话试发。

### 4.3 Fixture 能证明和不能证明的内容

脱敏 fixture 可证明：字段归一化、`msgid` 去重、`req_id` 回复关联、加密 userid 作为不透明身份、群 allowlist、成员配对、会话隔离、附件拒绝、发送未知状态和退出清理。

Fixture 不能证明：目标租户有创建权限、BotID/Secret 可用、WSS 可达、真实群 @ 行为、客户端展示、平台重投/排序、精确限流、离线补收或 App 退出后的平台行为。这些在取得账号和测试会话前均保持 `unverified`。

## 5. TASK-018 实现前不得遗漏的未知项

- 目标企业是否开放智能机器人 API 模式长连接，以及实际管理员/认证资格。
- App 离线期间是否保存或补推消息；官方没有保证。
- WSS 入站是否存在未公开 ACK、重投次数、顺序或保留时长；公开协议未说明。
- 普通回复/主动推送在 `errcode=0` 后的最终客户端投递语义；没有查询接口和 outbound message ID。
- `req_id` 在断线重连后是否仍可用于 24 小时窗口内回复；需真实故障测试。
- Node.js 24 与精确 npm 包版本的运行兼容性；package manifest 没有 `engines`。
- 附件的逐类型完整大小/MIME 限制和组织侧安全策略；首版不启用附件。

以上未知项不阻止实现文本 fixture、配对、路由、持久化去重和生命周期控制，但在真实账号验收前不能声称企业微信渠道已经接通。
