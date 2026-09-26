# TASK-018：实现首个 IM 对话渠道

- 关键词：企业微信、智能机器人、WebSocket、持久去重、配对、发送状态、脱敏日志、Keychain
- Owner：`sol-task018-owner-72012`；记录日期：2026-09-22
- 状态：`in_progress` / `verified-branch`；尚未合并 main、complete 或 push
- 分支：`task/task-018-wecom-channel`；worktree：`.worktrees/sol-task-018`
- 实现与最终测试 revision：`f2da77d3174713b45b8e620e586c5602246580c5`

## 入口与实现

- Runtime 装配：`apps/runtime/src/wecom-channel.ts` 的 `startConfiguredWecomChannels`，生命周期入口在 `apps/runtime/src/index.ts`。
- 共用路由：`packages/yuanpu-runtime/src/channels/router.ts` 的 `ChannelRouter`；持久层为同目录 `store.ts`。
- 官方 SDK 窄适配：`channels/adapters/wecom.ts` 的 `WecomSdkTransport` 与 `createWecomRedactingLogger`。
- SQLite schema version 4 增加 `yp_channel_connections`、`yp_channel_pairings`、`yp_channel_inbound`、`yp_channel_outbound`。
- 官方依赖精确固定 `@wecom/aibot-node-sdk@1.0.7`，锁文件 integrity 为 `sha512-51w+sTqunry6GD3HFvmuh0gArMSJDFE418vyvR1wMJHj1N6DaFuGD3HuaY2fazZs3mb9FWeQFX3+vU5t0Qhwmw==`。

## 可复用行为与安全边界

- 配对私聊先持久化，再以平台消息摘要作为 Agent idempotency key；重放不可改变原请求路由、身份、会话、消息类型、正文摘要或 action。
- 崩溃发生在 Agent submit 前后时，启动恢复使用同一幂等键与持久 input/action；不会因回复失败或断线重新执行 Agent。
- outbound 独立记录 `pending → delivering → accepted | failed | unknown`；写前已知断线为 failed，可能写出后的超时/断连为 unknown。
- paired 非文本消息不下载、不落 URL/aeskey、不进入 Agent；unsupported 回复使用同一持久去重、原 `req_id` 和 outbound 状态机。
- SDK 只有 authenticated 后才恢复发送；App 退出会取消订阅、等待在途 callback、落库不确定发送并调用 `disconnect()`。
- 配置仅接受 `~/.yuanpu/app/connections/wecom.json` 的 exact-key schema；Secret 引用必须精确为 `keychain:yuanpu/im/<connectionId>/bot-secret`。
- provider account 与 credential-reference 摘要绑定 connection；换账号或换凭据不能原地复用旧 pairing。
- SDK debug/info/warn/error 全部映射为固定事件，不透传 message、variadic args、raw frame、userid/chatid、正文或附件 URL。
- 群聊路径保留，但 `groupEnabled: true` 会 fail closed；真实隔离群完成 @ 触发验收前不能启用。

## 验证证据

- `pnpm check`：PASS，Node 24.15.0 / pnpm 11.22.0；runtime-kit 110/110、Runtime 14/14，最终记录 `1790083462849411000.json`。
- `pnpm build:native && pnpm smoke:native`：PASS，darwin-arm64 SEA、冻结 Python MCP、分阶段 Runtime 更新；记录 `1790083499773897000.json`。
- 最终 focused：46/46 PASS，覆盖身份拒绝、持久重放、崩溃窗口、authenticated 门禁、关闭竞态、unsupported 恢复和日志脱敏。
- 独立 Sol 复审：Standards PASS、Spec PASS；3 high、1 medium、1 low 均修复，最终无 finding。
- 检索：host 未提供 zvec-grep，使用 scoped `rg`、任务卡及 TASK-017 memory 定点读取；没有重建索引。

## 未验证与后续

- 测试机器人及 Secret 已撤销；没有声称真实私聊、群 @、客户端展示、离线补收、限流或真实断线 E2E。
- macOS Keychain 路径有本地实现；非 macOS 当前明确拒绝，未验证 Windows Credential Manager 或 Linux Secret Service。
- SQLite/WAL 清空字段不是安全擦除；输入只跨 submit/attach 崩溃窗口暂存，Pi 会话仍按自身策略保存正文。
- 合并 main 后需在集成 revision 重跑门禁；真实企业微信业务验收由独立验收卡在新建隔离机器人和授权会话下执行。
