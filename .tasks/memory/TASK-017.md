# TASK-017：确定首个 IM 接入契约与验证环境

- 关键词：企业微信、智能机器人、WebSocket、身份配对、幂等、发送未知、真实验证环境
- Owner：`sol-owner-task-017-72012`；记录日期：2026-09-22
- 状态：`in_progress` / `selected` / `awaiting-account-permission-credentials-and-test-conversations`
- Claim revision：`78e0fe2a0def8f04e3cf3a3852490a463d509222`
- 企业微信契约 revision：`3e97492`
- 未 merge、未 complete、未 push、未做真实 E2E

## 入口与产出

- 决策与实现边界：`docs/im-channel-contract.md`
- 机器契约：`docs/im-channel-contract.json`
- 官方资料研究：`docs/research/wecom-first-channel.md`
- 归一化场景：`docs/fixtures/im-contract/scenarios.json`
- 检查器：`scripts/verify-im-channel-contract.mjs`
- TASK-011 拥有共享 Runtime/协议契约；本卡没有修改 `packages/yuanpu-protocol` 或其他 owner 文件。

## 已确认决策

- 用户已选择企业微信；首发类型精确锁定为“企业微信智能机器人 / API 模式 / WebSocket 长连接”。不是群机器人 Webhook、自建应用公网回调、微信客服或个人微信非官方接入。
- 官方长连接只需本机出站到 `wss://openws.work.weixin.qq.com`，以 Bot ID + Secret 认证；连接随桌面 App 启停，退出调用 `disconnect()`，不建设公网 Gateway 或后台 daemon。
- TASK-018 采用 Yuanpu 自有 adapter 窄封装官方 `@wecom/aibot-node-sdk`。2026-09-22 npm latest 为 1.0.7，官方仓库 `80615b9` manifest 为 1.0.6，MIT、无 `engines`；实现前必须审计精确 tarball、锁定 integrity 并做 Node 24 spike。

## 可复用契约

- 入站可信字段：`headers.req_id`、`body.msgid`、`body.aibotid`、`body.chattype`、`body.chatid`（群）、`body.from.userid` 和 `body.msgtype`；Bot ID 必须匹配 connection。
- 去重键：`provider + connectionId + msgid`。官方长连接没有独立入站 ACK；先持久化去重与路由，再提交 Agent，不能把用户可见回复伪装成 ACK。
- 配对键：`connectionId + from.userid`。session 按账号/渠道/peer 隔离：单聊 peer 为 userid，群聊 peer 为 chatid；官方协议无 thread/topic ID。
- 官方只在群内 @ 机器人时推送群回调。仍要求群 allowlist + sender 已配对；真实隔离群完成 @/不 @ 验收前保持群功能开关关闭。
- 回复透传原回调 `req_id`；模型不得覆盖目标。回执 `errcode=0` 只记 `accepted`，非零记 `failed`，写出后的 5 秒 SDK 回执超时/断连/退出记 `unknown`，不盲重发、不重跑 Agent。
- 普通回复窗口 24 小时；同会话回复与主动推送合计 30 条/分钟、1000 条/小时。离线补收没有官方保证或 cursor，保持 `unverified`。
- 首发只开文本。图片/文件/视频临时 URL 5 分钟有效且带独立 `aeskey`；未实现下载隔离、MIME/大小/清理前不抓取、不落盘、不交给模型。

## 安全发现

- 官方 SDK 当前默认 logger 会 debug 完整 inbound body，`downloadFile` 打印完整 URL，unknown/invalid frame 路径可能序列化原始帧。
- TASK-018 必须注入全级别 Yuanpu redacting logger；禁止 Bot ID、Secret、userid、chatid、正文、附件 URL、`aeskey`、`response_url` 和 raw frame，只记录哈希稳定 ID、类型、长度、状态与脱敏错误码。
- Secret 只以 `keychain:yuanpu/im/<connectionId>/bot-secret` 引用，解析后仅驻进程内存；仓库、fixture、日志和证据不出现真实值。

## 验证与检索

- 检索：当前 host 没有 zvec-grep 工具；用 `get-task.mjs`、scoped `rg` 和定点读取完成工作区边界核对。
- 官方研究：仅使用企业微信开发者中心、Tencent 官方文档、WecomTeam 官方仓库/源码和发布包元数据；核心来源与逐项证据保存在 `docs/research/wecom-first-channel.md`。
- `node --check scripts/verify-im-channel-contract.mjs`：pass。
- `node scripts/verify-im-channel-contract.mjs`：pass，Node 24.15.0，14 个企业微信归一化场景。
- `pnpm check`：pass，Node 24.15.0 / pnpm 11.22.0，约 28 秒；生成的空 `pnpmfileChecksum` 漂移已用 task-owned patch 清理。
- 独立审阅：主 owner 逐项把研究附件映射到机器契约与任务四条 acceptance；没有发现未覆盖项。fixture 只证明静态策略，不代表平台 E2E。

## 未验证项与交接

- 缺目标企业的智能机器人创建权限证据、Bot ID 元数据引用、SecretStore 绑定、两个测试成员、获授权私聊和隔离测试群。
- 未验证真实 WSS 鉴权、Node 24 下精确 SDK 包、群 @ 投递、真实限流响应、离线补收、附件传输和客户端展示。
- 下一实现入口是 TASK-018：先做官方 SDK tarball/Node 24/logger spike，再实现文本单聊 adapter；群聊和附件分别通过真实门禁后启用。
- 不建议现在完成 TASK-017：平台/契约部分已收敛，但任务 acceptance 仍要求账号权限与测试会话记录，且 done 还要求集成并验证于 main。保持 `in_progress`，等待用户提供真实验证环境后继续。
