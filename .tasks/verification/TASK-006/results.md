# TASK-006 自包含制品与安全更新验证

- 验证 revision：`0920c74fce3f0a1e7074f29e2ddb398c19144f0c`
- 系统：macOS Darwin 25.5.0 arm64
- 工具链：Node 24.15.0、pnpm 11.22.0、uv 0.11.9、PyInstaller 6.16.0
- 检索：当前 host 未提供 zvec-grep，按规则回退到 scoped `rg`。

## 结果

| 场景 | 状态 | 观察 |
| --- | --- | --- |
| 签名、兼容、重放、降级 | PASS | 坏签名、运行时不兼容、旧 issuedAt 重放、未授权降级均在下载前拒绝。 |
| 恶意归档与资源上限 | PASS | traversal、symlink、条目/解包大小限制不激活版本；manifest 响应限制 256 KiB。 |
| 原子安装、并发与恢复 | PASS | 并发安装只下载一次；健康检查失败保留旧活动版本；版本目录不可变并可回滚。内核 loopback 端口租约在真实持锁子进程 SIGKILL 后自动释放，等待安装恢复。 |
| 无 Python 目标机 | PASS（darwin-arm64） | PyInstaller onedir 能力包在隔离 PATH 下运行；Node SEA 经冻结 MCP 能力完成 smoke。 |
| 配置兼容 | PASS | `settings.json`、能力配置及旧 `pi-mcp-adapter` 配置保留；Python 制品不写入 Pi extensions。 |
| Catalog 与信任链 | PASS | 固定 trust root、Ed25519、相对 URL、受控文件白名单、symlink/root escape 拒绝；生产私钥只进入 gate 验证 step 与 publish 签名 step，矩阵仅持公钥。 |
| 独立安全复审 | PASS | `/root/task003_security_review` 复审 0920c74，无 HIGH/MEDIUM blocker。 |
| Linux/Windows runner | UNVERIFIED | 工作流矩阵已配置 linux-x64、darwin-arm64、win32-x64，但本机不能替代 GitHub 托管 runner 实证。 |
| 生产签名/公证 | UNVERIFIED | 未提供真实 Ed25519 发布密钥、Apple Developer ID 或 Windows 签名凭据；release 对能力签名 fail-closed，本地 Electron 明确跳过 macOS 签名。 |

## 命令证据

- `pnpm check`：PASS；runtime-kit 42/42、Runtime 3/3、Server 2/2、release manifest 1/1。
- `pnpm build:native && pnpm smoke:native`：PASS；生成并运行 `YuanpuAgentRuntime-darwin-arm64`。
- `pnpm package:desktop`：PASS；生成约 172 MiB ZIP 与 170 MiB DMG，并重复执行冻结 Python 与 SEA smoke。
- 工作流 YAML 使用 Ruby safe-load 校验通过。

## 非阻断边界

确定性端口租约在 28,000 个端口范围内映射。不同 packages 根或无关本地服务理论上可碰撞，
结果是等待后保守失败，不会产生两个安装 owner，也不会破坏旧版本。Desktop/Runtime 始终以
同一规范化 Yuanpu home 绝对路径构造 packages 根。

