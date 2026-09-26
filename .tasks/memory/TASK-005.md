# Python 调用与授权阶段验证（TASK-005）

- 关键词：business-verification、real-SEA、approval-consume、dispatch-crash、process-tree
- Owner：codex-yuanpu-61529；记录日期：2026-09-21
- 验证 revision：`8e6c0ad69c29bffb36301be044bddc6a9b309d7c`
- 完整场景证据：`.tasks/verification/TASK-005/results.md`

独立 verifier 在 macOS arm64 上确认 S1–S3 后端最小闭环 PASS。真实 SEA 只经两个元工具
调用真实 Python，成功结构与 MCP error 均保真；真实 Runtime 拒绝错误 bearer、伪签名
和 nonce 重放；授权绑定变化、并发消费与事后重放均不增权。

本卡新增可复用的非 mock 回归：Python 先 fsync 一次 marker 再 `os._exit(23)`，宿主观察
`result_unknown`，授权已持久化为 consumed；重开 store 后相同 request 被拒且 marker
仍只有一次。另将真实不响应进程与健康 FastMCP 并行发现固化为隔离回归。

取消、主动退出、MCP 根异常退出和继承 stdio 的后代均已用真实进程验证回收。两个元工具
只覆盖 Yuanpu 管理的能力入口，不是 Pi/bash 或系统沙箱。

检索回退：当前 host 无 zvec-grep；使用 scoped `rg` 检索 TASK-005、设计文档、Runtime、
capabilities 与 Python fixture。全量 `pnpm check`、native build/smoke 通过。Linux/Windows
实机证据明确为 UNVERIFIED，由 TASK-008 最终跨平台门补齐，不能沿用本卡 PASS 代替。
