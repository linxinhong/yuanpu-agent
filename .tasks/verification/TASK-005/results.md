# Python 调用与授权阶段验证（TASK-005）

## 基线与范围

- 待测 revision：`8e6c0ad69c29bffb36301be044bddc6a9b309d7c`
- 基线 main：`73666181f7e28f337d5425c34e70f8b1550b0738`
- diff：3 个测试/fixture 文件，93 insertions、2 deletions；无产品实现变更
- 环境：macOS 26.5.2 / Darwin 25.5.0 / arm64；Node 24.15.0；pnpm 11.22.0；uv 0.11.9
- 模式：本地真实 SEA、真实 Runtime 子进程、真实 Python FastMCP；未使用模型或外部 API 密钥
- 检索：host 未提供 zvec-grep；按规则回退 scoped `rg`，范围为 TASK-005、
  `docs/python-capabilities.md`、Runtime/capabilities/Python fixture 入口与测试
- 独立性：场景由非主要实现者 `/root/task005_business_verifier` 推导并执行；最终 verdict PASS

规则来源为 TASK-005 卡片与 `docs/python-capabilities.md` 的能力入口、一次性授权和进程
生命周期约束。两个元工具只是 Yuanpu 管理能力的代理接口，不代表 Pi/bash 或操作系统沙箱。

## 场景结果

| 场景 | 预期与操作 | 权威观察 | 结果与证据 |
| --- | --- | --- | --- |
| S1-SEA-01 | darwin-arm64 SEA 经两个元工具调用真实 Python | 工具仅为 `search_capabilities`、`execute_capability`；echo 返回 `{text, length}` 与 `isError:false`；诊断错误保留 `isError:true` 与错误内容 | PASS；`pnpm smoke:native`、直接执行 `YuanpuAgentRuntime-darwin-arm64 --capability-smoke`；`apps/runtime/scripts/native/smoke.mjs` |
| S2-AUTH-01 | 缺失或错误 bearer 不能访问 Runtime | 两种请求均为 HTTP 401 | PASS；真实 Runtime 子进程；`apps/runtime/test/runtime.test.mjs` |
| S2-AUTH-02 | 伪签名和 nonce 重放拒绝 | 随机伪签名 403；有效签名首次因未知 request 为 409；同 nonce 重放 403；bearer 不在 argv | PASS；真实 Runtime HTTP 边界；`apps/runtime/test/runtime.test.mjs` |
| S2-AUTH-03 | request 伪造、参数/版本/会话/工作区改变、并发消费和重放均不能增权 | 绑定变化均为 `approval_invalid`；两个并发消费仅一次执行；后续重放拒绝 | PASS；持久 `CapabilityApprovalStore`；`packages/yuanpu-runtime/test/capabilities.test.mjs` |
| S2-CRASH-01 | 授权先持久消费；真实副作用后崩溃/结果未知不得自动重做 | Python 写入并 fsync marker 后 `os._exit(23)`；调用为 `result_unknown`；磁盘状态 `consumed`；重开 store 重放为 `approval_invalid`，marker 仍一行 | PASS；真实 Python 与持久 store；`packages/yuanpu-runtime/test/mcp-source.test.mjs` |
| S3-ISO-01 | 真实无响应 source 不隐藏健康 source | Python `sleep(10)` 不响应 MCP，初始化有界失败；并行真实 FastMCP echo 仍被发现 | PASS；已固化跨平台回归；`packages/yuanpu-runtime/test/mcp-source.test.mjs` |
| S3-CANCEL-01 | 取消到达真实 Python | 5 秒 wait 在约 50ms 后取消，返回 `cancelled`；关闭后根 PID 不存在 | PASS；真实 Python；同上 |
| S3-EXIT-01 | 主动关闭回收根与后代 | sleeping descendant 在 `source.close()` 后不存在 | PASS；真实进程树；同上 |
| S3-EXIT-02 | MCP 根异常退出也回收继承 stdio 的后代 | 根 `os._exit(17)` 后 descendant 不存在 | PASS；真实进程树；同上 |
| S3-UNIT-01 | 超时恢复、并发 waiter 独立取消、重启预算、未知结果不重试 | 所有辅助断言通过 | PASS；辅助单元证据，不替代上述真实进程场景 |
| S3-XPLAT | Linux/Windows SEA 和 Windows Job Object 实机生命周期 | 当前没有对应本地主机运行记录 | UNVERIFIED；本卡提示由最终跨平台门 TASK-008 补齐，不计为本 macOS 后端阶段失败 |

## 命令与结果

所有 Node/pnpm 命令由 coding-owner worktree kit 固定到 Node 24.15.0、pnpm 11.22.0。

```sh
pnpm run prepare:python-capabilities
pnpm --filter @yuanpu-agent/runtime-kit run build
pnpm --filter @yuanpu-agent/runtime-kit exec node --test test/capabilities.test.mjs test/mcp-source.test.mjs
pnpm --filter @yuanpu-agent/runtime run test
pnpm check
pnpm build:native
pnpm smoke:native
```

- 聚焦 capabilities/MCP：最终新增真实崩溃和真实挂起 source 场景均通过。
- Runtime HTTP：3/3 通过。
- `pnpm check`：通过；最终 revision 仅比全量门 revision 新增已单独通过的真实挂起 source 回归。
- `pnpm build:native`：通过，Mach-O 64-bit arm64 SEA。
- `pnpm smoke:native`：通过；直接 SEA 输出已脱敏记录成功与 MCP error 结构。
- 原始命令日志位于工作树 Git 元数据的 `coding-owner/*.log`，不纳入版本库；证据中不含 token、签名私钥或用户数据。

## 结论与剩余边界

S1–S3 在 macOS 后端阶段通过，未发现阻断缺陷。Linux/Windows 实际 runner 结果仍是
`UNVERIFIED`，必须由 TASK-008 汇总三平台 CI 证据后才能声称跨平台验收通过。
