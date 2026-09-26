# TASK-009 SEA 冻结 Python 能力冷启动修复

- 基线：`b3ab550`
- 最终实现 revision：`49b73a1`（证据记录提交除外）
- 环境：macOS 26.5.2 arm64；Node 24.15.0；pnpm 11.22.0；Python 3.13.12；PyInstaller 6.16.0
- 检索：当前 host 未提供 zvec-grep，使用 scoped `rg` 检查根 scripts、Runtime MCP 启动与 workflow 入口。

## 复现

在 TASK-008 中移走 `apps/runtime/dist-native` 与 `apps/python-capabilities/dist-artifact` 后，先构建冻结制品和 SEA，首次 `pnpm smoke:native` 在 CapabilityRegistry 的 3 秒总发现预算内返回 `Python echo capability was not discovered.`；重跑会受系统缓存预热影响而通过。

## 修复

- 根级 `smoke:native` 现在先同步锁定依赖、构建冻结 Python 制品并执行其隔离 PATH smoke，因此不依赖遗留生成物。
- 冻结 Python MCP 初始化预算为 15 秒，包含初始化与工具发现的宿主总预算为 20 秒；均为有限等待。
- Runtime 正常启动、制品切换和 SEA smoke 使用相同总发现预算；工具列表请求超时或异常会原子失效当前 client/transport 并终止进程组，下一次调用按既有重启预算重新连接。
- runtime-bundle 在已经构建并验证 Python 制品后调用 package-level native smoke，避免 CI 重复冻结构建。

## 结果

| 场景 | 状态 | 证据 |
| --- | --- | --- |
| 首次冷启动 | PASS | 移走 `dist-native`、`dist-artifact` 后，首次 `pnpm build:native && pnpm smoke:native` 完成冻结 Python MCP 搜索、成功调用及受控错误保真。 |
| 自包含制品 | PASS | 根级 smoke 自动重建 PyInstaller onedir；`smoke:python-artifact` 在隔离 PATH 下通过。 |
| 失败隔离/清理 | PASS | `pnpm check` 中真实取消、无响应源隔离、正常/异常进程树清理回归通过；新增已初始化但挂起 `tools/list` 的真实 Node MCP fixture，超时后 PID 不存在。结束后无本任务 `YuanpuAgentRuntime`/`YuanpuEchoMcp` 残留。 |
| 全仓回归 | PASS | `pnpm check`：desktop 2/2、server 2/2、runtime-kit 45/45、runtime 3/3。 |

生产签名与 Linux/Windows hosted runner 不属于本修复卡，继续由 TASK-008 标为 UNVERIFIED。

独立安全复核 `49b73a1` 为 **PASS**，无 HIGH/MEDIUM 残留；复核确认旧连接失败不会误伤并发建立的新连接，caller-only cancellation 也不会误杀共享 discovery。
