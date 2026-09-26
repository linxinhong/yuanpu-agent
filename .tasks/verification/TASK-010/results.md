# TASK-010 SEA Runtime 分阶段更新回归

- 实现 revision：`ffe459f`（包含前置实现 `507e5cf`）
- 环境：macOS 26.5.2 arm64；Node 24.15.0；pnpm 11.22.0
- 检索：当前 host 未提供 zvec-grep，使用 scoped `rg` 定位 Runtime manager、manifest 生成器、desktop build 与 workflow；未创建索引。

## 实现

Runtime 更新被提炼为 `RuntimeUpdater` 深模块，外部 interface 只有 `stage` 与 `activate`：Electron Runtime manager 不再同时承担下载、文件切换与进程管理。生产与测试均通过同一 interface；测试使用真实 loopback HTTP、真实文件系统和真实可执行文件，不暴露私有方法或复制算法。

- `stage` 校验 manifest/protocol/桌面版本、平台、512 MiB 大小上限、实际长度、SHA-256 与 `--version`，只在全部通过后写入 `.staging/staged.json`。
- `activate` 在下一次 Runtime 启动前重新检查 metadata、SHA-256 和版本；成功后移动到不可变版本目录，并通过临时文件 rename 原子更新 `current.json`。
- 失败下载、损坏/残缺 staging 或版本不符均清理不可用 staging，保持既有 `current.json` 不变。
- 根级 `smoke:native` 及三平台 `runtime-bundle` workflow 现在会通过 loopback HTTP 下载刚构建的真实 SEA，证明暂存时旧版仍活动、模拟重启后才切换。

## 验证

| 场景 | 状态 | 证据 |
| --- | --- | --- |
| 普通可执行文件分阶段更新 | PASS | desktop test 通过 loopback HTTP 下载当前 Node 可执行文件；暂存前后 `current.json` 保持旧版，`activate` 后版本、路径和 SHA-256 一致。 |
| 下载/暂存失败保旧 | PASS | 长度错误、SHA-256 错误、传输中断、`--version` 不符、路径型 metadata 与残缺 staging 均保留旧版并清理不可用目录。 |
| 真实 SEA 下载→暂存→重启激活 | PASS（macOS arm64） | `pnpm smoke:native` 在既有 SEA 能力 smoke 后输出 `Staged Runtime update smoke passed for darwin-arm64`；激活后再次执行真实 SEA `--version` 并核对 SHA-256。 |
| Electron 制品包含 updater | PASS（macOS arm64） | `pnpm package:desktop` 生成 ZIP/DMG；`app.asar` 含 `dist/main.cjs`、`runtime-updater.cjs` 及共享实现 chunk。 |
| 全仓回归 | PASS | `pnpm check`：desktop 5/5、runtime-kit 45/45、runtime 3/3、server 2/2。 |
| 进程/临时服务清理 | PASS | 测试、native smoke 结束后无本 worktree 的 Runtime、Python MCP、loopback server 或 `yuanpu-*-update-*` 临时目录进程遗留。 |
| Linux/Windows 实际执行 | UNVERIFIED | workflow 已接线，但当前 revision 尚未推送，没有 hosted runner 结果；不能用 YAML 定义代替运行证据。 |

## 边界

本卡验证分阶段更新和失败保旧，不提供生产发布凭据。Runtime manifest 当前通过 HTTPS 来源与 manifest 内 SHA-256 约束制品完整性，但没有独立的 Ed25519 manifest 签名；生产 Apple/Windows 代码签名、manifest 信任强化及 hosted runner 仍是 TASK-008 的发布门。
