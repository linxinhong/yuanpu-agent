# 独立助理与双入口阶段验证（TASK-042）交接

- Owner `assistant-contract-review-verify-20260926-10414`；分支 `task/task-042-assistant-verification`；worktree `.worktrees/assistant-verification`；产品基线 `8345075`。本卡只新增 `apps/runtime/test/task-042-stage.test.mjs` 验证 harness 与 `.tasks/verification/TASK-042/results.md`，不改产品功能。
- 独立阶段探针在隔离 Home 跑真实 headless Worker + loopback 模型：停机搬迁 Home 后已接受任务可查、重复 ID 不二次执行、第二写入者拒绝；旧 Pi 会话/绑定保留与新 Session 隔离；fixture WeCom 入站去重、拒绝陌生人/群、未知回执不重发、撤销后旧请求不能投递。
- Node 24.15.0/pnpm 11.22.0、macOS arm64：`pnpm check`、`pnpm build:native`、`pnpm smoke:native` 均通过。现有真实 Runtime HTTP 双客户端重连、Worker SIGKILL、父进程强杀无孤儿的回归也复跑。具体 revision、脏 diff、命令、runner ID、模式与逐场景判定见 [results.md](../verification/TASK-042/results.md)。
- 初次 Pi 模型目录生成受 `models.dev` 连接超时阻断；复用当前 main 忽略型 `packages/ai/src/providers/data/` 后 `pnpm build:pi` 与 `pnpm check` 通过。直接 `pnpm build:runtime` 仍强制在线 generate-models 而超时；未改生成器或提交该数据。复现命令及边界见结果文档。
- **未完成原因：**真实企业微信往返缺明确测试目标与发送授权，未外发；Windows/Linux、生产 Pi attach/订阅、云端部署及打包 App UI 退出未由本轮证明。任务保持 `in_progress`，不将 fixture 当真实业务完成。收到授权后先固定测试收件人、时间和数据，再执行一位已授权用户的最小私聊与原路回复；复测后更新 results，依主线集成并在 main 验证后才能完成。
- 检索：本宿主无可调用 zvec-grep；按卡片和已知符号用 scoped `rg` 核对 Runtime/Worker、渠道、持久层、设计与依赖交接；未创建索引。
