# TASK-017：确定首个 IM 接入契约与验证环境

- 关键词：IM、长连接、身份配对、幂等、发送未知、真实验证环境
- Owner：`sol-owner-task-017-72012`；记录日期：2026-09-22
- 状态：`in_progress` / `awaiting-user-selection`；未 merge、未 complete、未做真实 E2E
- Claim revision：`78e0fe2a0def8f04e3cf3a3852490a463d509222`
- 实现与测试 revision：`97fe262622c7bb528a14a77b3d56154ce1120ecf`

## 入口与产出

- 决策、官方来源、候选权衡和环境清单：`docs/im-channel-contract.md`
- 机器契约：`docs/im-channel-contract.json`
- 归一化场景：`docs/fixtures/im-contract/scenarios.json`
- 检查器：`scripts/verify-im-channel-contract.mjs`
- TASK-011 正在拥有共享 Runtime/协议契约，本卡没有并发修改 `packages/yuanpu-protocol`。

## 决策与可复用约束

- 尚无用户平台选择。默认建议候选是“飞书企业自建应用机器人 + WebSocket 长连接”，但不得当作已决定。
- 企业微信智能机器人 WebSocket、钉钉企业内部应用机器人 Stream 也是无需公网入站的正式候选；微信服务号需要公网回调，当前边界下不选。
- 个人微信非官方 Hook/协议逆向明确排除；所有连接随桌面 App 生命周期退出。
- 入站须 ACK 前持久化；以 connection + delivery ID 去重，并以 connection + message ID 防二次执行。
- sender 只信认证事件；配对键为 connection + sender；群聊同时要求 sender 已配对、群 allowlist、明确 @ 机器人。
- 回复路由由入站消息冻结，模型不得改目标；超时且请求可能已写出时标 `unknown`，不盲重发、不重跑 Agent。
- 首个闭环仅承诺文本。附件在平台专用限制、下载隔离和真实验证前显式拒绝。
- 凭据只保留 `env:`/`keychain:` 引用；没有账号、secret 或真实会话写入仓库。

## 官方事实与陷阱

- 飞书官方 Node SDK 可由本机主动建 WebSocket，无需公网 IP/域名；回复支持 message/thread 路由。SDK 的自动 fallback 可能在目标撤回时改发普通消息，首版需禁用、绕开或显式失败。
- 企业微信官方 AiBot Node SDK 使用 Bot ID + Secret，默认 WSS 为 `openws.work.weixin.qq.com`；组织是否开放创建入口仍需真实账号确认。
- 钉钉官方 Stream SDK 使用企业内部应用 Client ID + Secret；群消息需 @，重推要求持久化去重。
- 微信服务号向开发者 URL POST，五秒未响应会重试；选择它意味着新增公网基础设施决策。
- 平台精确限流、附件上限、离线补收和主动消息窗口均不得跨平台推断；选择后重新查官方页面并写 `providerLimits`。

## 验证与检索

- 检索：当前 host 无 ZG 工具；用 `get-task.mjs`、scoped `rg` 和定点读取 `.tasks`、架构草稿、协议入口完成边界核对。
- `node scripts/verify-im-channel-contract.mjs`：pass，Node 24.15.0，10 个 fixture 场景。
- `node --check scripts/verify-im-channel-contract.mjs`：pass。
- `pnpm check`：pass，Node 24.15.0 / pnpm 11.22.0，耗时 97.4s；命令生成的空 `.pnpmfile` checksum 漂移已还原，源码树未变。
- 官方来源批量可达检查曾遇到 `open.feishu.cn` 瞬时 SSL error；单页带重试复核为 HTTP 200。事实来源逐项列在决策文档。
- Fixture 不能证明鉴权、真实投递、离线补收、限流、附件传输或客户端展示；这些保持 `unverified`。

## 阻塞与下一步

- 需要用户最小回答：选择飞书/企业微信/钉钉/另行授权微信服务号中的哪一个，并确认对应组织有创建测试机器人的权限。
- 随后还需机器人凭据引用、两个测试成员、一条私聊和一个隔离测试群；不得向真实业务群试发。
- 下一命令：补齐 `docs/im-channel-contract.json` 的 decision/providerLimits 后运行 `node scripts/verify-im-channel-contract.mjs`，再增加所选平台脱敏原始 fixture 和真实收发验证。
- 本分支达到可审阅交接，不满足 main 集成与真实 E2E 完成条件；保持 TASK-017 `in_progress`。
