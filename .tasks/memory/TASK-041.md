# TASK-041 接通本地与企业微信独立助理

- Owner：work_conversations；分支 `task/task-041-assistant-channel`；固定 worktree `.worktrees/work-conversations`；领取基线 `488c2ad`；实现提交 `2a32dc9`。本记录仅作 owner 交接，main 集成和任务 complete 由主线负责人执行。
- 关键词：Desktop Assistant、企业微信私聊、AssistantWorkerManager、持久身份与会话、原路回复、幂等、断线恢复、旧归档。

## 实现边界

- Desktop `surface: assistant` 经 Electron preload/IPC 和 Runtime HTTP 入 `AssistantHostService`，由同一 `AssistantWorkerManager` 转发到专属 Worker；已配对且显式绑定的企业微信私聊经 `ChannelRouter` 入同一 host service。桌面和企业微信共享 `local-user` 助理主体，但各有独立持久会话。未绑定的已配对 Work 用户和先于绑定入账的旧消息仍走原 AgentService；群聊、未配对和非文本不能进入助理回合。旧默认镜像不再自动双向投递。
- SQLite schema v8 的助理表持久保存绑定 generation、受众、请求及客户端/平台消息去重键、Worker task ID、取消意图、回复投递状态和有序来源事件。重启补扫先查 Worker task 再决定是否提交；投递 `unknown/accepted/failed` 不盲重发。解绑等待已开始的投递并阻断新投递，同联系人重新绑定也不能发送旧回合回复。企微回复使用原始 `providerRequestId`。桌面客户端消息 ID 供响应丢失重试；renderer 仅在短时间窗口保留待提交 ID。
- 旧 `yp_agent_runs`、`run_id` 外键和镜像记录保留可读。旧助理绑定迁移到新会话而不重写原 Pi Session；原桌面/企微 Session 通过只读归档展示。旧归档按完整可见文本补扫，超过默认 100 条窗口仍入来源快照。来源事件带稳定 source ID、递增 cursor、版本、personal audience 和由宿主解析的不透明 contentRef；没有绝对路径或在线连接依赖。旧归档空读或文件失效时当前快照仍保留，尚不发 deleted/temporarily_unavailable 事件。
- 泛化 `/v1/agent/runs` 保留历史自定义 Work conversation ID 的提交与旧 run 读取能力，拒绝 `default` 和助理保留 ID 的新提交；桌面 Work chat 仍要求现存 Work 会话。旧镜像投递状态只读显示，重试接口返回 410。`docs/assistant-memory-proposal.md` 记录本轮生产接线为宿主 HTTP/IPC 加 WeCom ChannelRouter；TASK-037 的 Pi client/server 仅实验探针，生产 attach/订阅未实现，后续可替换窄传输接缝。

## 验证与复核

- 独立只读复审发现撤销/重绑后慢回合外发风险及旧镜像 UI 无效重试，均已修复并覆盖服务级测试。主线只读复核发现旧消息跨执行器重放、桌面响应丢失重试、取消离线复活、终态待投递恢复、旧归档 100 条截断与 Work 恢复兼容等问题，均已处理。
- 聚焦测试：持久化/渠道/host 测试通过；真实 Runtime HTTP → Worker loopback 测试中，首客户端收到 202 后丢弃响应体并退出，独立第二客户端以同业务 ID 重投并查询同一 run/transcript，模型仅调用一次；模拟 WeCom adapter 经 ChannelRouter → 同 Worker 回合验证独立 Session 与原请求路由。旧 TASK-014/TASK-019 Runtime API 回归通过，助理保留 ID 的泛化 API 提交返回 403。
- `pnpm check` 在 macOS arm64、Node 24.15.0、pnpm 11.22.0 通过；runner 证据 `.git/worktrees/work-conversations/coding-owner/1790435707015065000.log`，期间工作树未变化。新增 schema v8 的 native smoke 断言，但本卡未执行原生 SEA 打包/冒烟。
- 未验证：真实企业微信账号的长连接、配对/回复时效与断线投递；Windows/Linux 原生包；生产 Pi client/server attach/订阅；超大旧 Session 完整扫描的内存/SQLite 体量。旧归档来源删除/暂不可用生命周期及分片预算留给 TASK-043；当前保留历史快照与原 Session，不声称自动撤回。未修改 Pi 上游包，未推送，未覆盖 main 的未提交修改。
