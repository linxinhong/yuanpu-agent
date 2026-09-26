# 接入受管 Python MCP 示例（TASK-004）

- 关键词：Python、MCP、stdio、SEA、process-group、Job-Object、cancellation
- Owner：codex-yuanpu；记录日期：2026-09-21
- 实现修订：`8f4f9d7`、`ae8820a`、`626b93b`、`73e6164`、`d749967`
- 依赖：固定能力与制品公共契约（TASK-002）

`apps/python-capabilities` 提供锁定 MCP Python SDK `1.26.0` 的 FastMCP 示例，包含
结构化 echo、受控 MCP 错误与仅测试环境启用的生命周期 fixture。根脚本和 CI 使用
`uv sync --frozen` 创建开发环境；最终用户无需本机 Python 的冻结制品属于 TASK-006。

`ManagedMcpCapabilitySource` 使用绝对命令、固定参数、能力私有 HOME/APPDATA 和最小环境
启动 stdio MCP。初始化、发现、执行与重启预算均有界；未知派发结果返回
`result_unknown` 且不重试。MCP annotations 不参与授权，未知工具默认 R2，只有宿主
风险策略可降级。每次执行前重新发现定义，CallToolResult 的 content、
structuredContent 与 isError 原样保留。

发现按 source 隔离；共享底层发现的并发等待者有独立取消语义。单源超时不会隐藏健康
source，超时后可恢复。POSIX 使用独立进程组；Windows supervisor 在启动 Python 前把
自身加入 `KILL_ON_JOB_CLOSE` Job Object。正常关闭、MCP 根异常退出、supervisor 退出及
后代继承协议管道均有回收测试。

Runtime 的 `--capability-smoke` 通过唯一两个元工具 `search_capabilities`、
`execute_capability` 调用真实 Python，并同时断言结构化成功与 MCP 错误。普通 Runtime
不暴露测试用生进程能力。Runtime Bundle 三平台矩阵会运行相同生命周期测试。

独立审查经过五轮：先后修复 annotations 审批绕过、直接 PID 清理、干净 CI、SEA 错误
缺口、共享取消串扰、POSIX 异常退出、Windows Job/管道继承竞态；最终结论 PASS。

验证环境：macOS arm64、Node 24.15.0、pnpm 11.22.0、uv 0.4.25。

- 移走本机 `.venv` 后 `pnpm check`：通过，证明按锁文件自举开发环境。
- runtime-kit：33/33 通过，含真实 Python、超时/恢复、并发取消与进程树。
- `pnpm build:native`：通过。
- `pnpm smoke:native`：通过，真实 SEA 完成两工具 → Python MCP 全链路。
- Windows/Linux CI 的实际 runner 记录由最终跨平台验收卡汇总。
