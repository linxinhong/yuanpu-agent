# TASK-037 固定助理契约并验证 Pi 会话适配

- 关键词：assistant contract、Pi Session、Harness、双入口、受众、重连、工作评估。
- Owner：assistant-architecture-sol1；记录日期：2026-09-26。
- 来源：main 领取提交 `c931ea1`；实现和测试提交 `af5333b`（分支 `task/task-037-assistant-contract`）。
- 专属 worktree：`.worktrees/assistant-architecture`；本记录为分支交接，尚未集成 main，也未将卡片标记 done。

## 公共入口与结论

- `packages/yuanpu-protocol/src/assistant.ts` 导出 `ASSISTANT_CONTRACT_VERSION=1`、身份与会话绑定、归一化输入、来源变更、工作审阅、记忆修订、委派、回复类型及 `validateAssistantIngress`。现有桌面 HTTP `PROTOCOL_VERSION=4` 不因添加助理 IPC 类型而变更。
- `validateAssistantIngress` 要求可信 principal、可信 conversation binding 与请求的身份、受众和原路回复目标一致；个人受众 ID 必须等于 principalId。去重键包含渠道、账号、组织、会话、线程、平台消息 ID；附件消息可没有正文。
- 设计权威：`docs/assistant-memory-proposal.md` 的 “TASK-037 通信适配结论与契约”。宿主拥有配对、来源、入站去重、回复投递和 `automation.sqlite`；Assistant Worker 单写助理会话、记忆、台账、评估与委派记录。评估对象是工作内容与产物。
- `packages/yuanpu-runtime/test/assistant-pi-session-probe.test.mjs` 使用 Pi 0.86.1 的真实 Unix server/client、JsonlSessionRepo、AgentHarness 和离线 faux provider。两个获授权连接共享一个 Session 并订阅状态；无凭证连接不能 attach 或借用 attachment。响应丢失后显式重连/attach、旧 attachment 拒绝；临时请求日志重载和 Pi server 重启后重复提交不重复执行。
- 同一探针实际调用 `createYuanpuChatSession`。该旧适配返回 `YuanpuChatSession`，使用 `SessionManager`，无法直接用作新 server 的 durable Session/RoutedSessionHandle。新助理包应独立装配 Pi Session/Harness；Work 旧会话只读归档，不能与助理 Jsonl repo 同写。

## 验证与限制

- 工具链：Node 24.15.0、pnpm 11.22.0、macOS arm64；worktree-kit `prepare`/`doctor` 已通过。安装使用仓库文档要求的 `pnpm install --frozen-lockfile --ignore-pnpmfile`；从主工作区复制被 Git 忽略的 Pi 模型数据到本 worktree，未修改同步的 Pi 源码。
- 已执行：`pnpm build:pi`、protocol build/typecheck/test、Pi Session 探针，以及最终 `pnpm check`，均通过。最终 `pnpm check` 耗时 30.9 秒，工作树在执行期间未变；runtime-kit 138 个测试、apps/runtime 27 个测试通过。实施提交 `af5333b` 在同一代码树上产生；证据日志在 worktree-kit 私有目录。
- 独立只读审查指出个人受众越权及探针授权/恢复证据缺口；已修复并补回归后运行上述最终门禁。探针凭证与 JSON 日志只验证宿主适配方法，不代表真实企业微信配对或生产并发事务。
- 未验证：真实企业微信账号和模型、SEA Worker 生命周期、进程崩溃期间的原子请求日志、Windows 的非 Unix 传输。这些由 TASK-040、TASK-041 及阶段业务验收覆盖。Windows 跳过 Unix 探针，旧聊天工厂测试仍运行。
- 后续：主线 writer 在保留现有未提交 UI/protocol/runtime 增量后集成此提交与本 memory，解决 `index.ts` 相邻新增导出；在集成后的 main 运行 `pnpm check`，再由 task tool 完成 TASK-037。
- 检索：当前宿主未提供 zvec-grep 工具；按精确锚点用 scoped `rg` 检索 `docs/assistant-memory-proposal.md`、`packages/{server,client,agent,yuanpu-protocol,yuanpu-runtime}` 和相关测试，未创建索引。
