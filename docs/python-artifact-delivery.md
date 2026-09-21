# Python 能力制品与安全更新

本文记录 `python-mcp` 能力包的已实现交付边界。通用进程模型、授权和 MCP 两工具契约见 [python-capabilities.md](./python-capabilities.md)。

## 制品形态

`apps/python-capabilities` 使用固定版本 PyInstaller `onedir`，把 Python 解释器、FastMCP 服务和运行依赖构建成目标平台目录，再生成 `tar.gz`。目标机不需要 Python、pip、uv，也不会在安装或首次调用时从 PyPI 补依赖。

构建入口：

```sh
pnpm build:python-artifact
pnpm smoke:python-artifact
```

烟测将 `PATH` 指向一个空目录后直接执行冻结程序。`pnpm smoke:native` 进一步让 Node SEA 通过 stdio 调用冻结后的真实 MCP 服务，验证 `search_capabilities` 和 `execute_capability` 全链路。

桌面打包把 `dist-artifact/bundle` 放入 `resources/capabilities/builtin.python.echo`。生成目录只属于本地/CI 构建输出，受 `.gitignore` 管理，不提交仓库。

## 签名与信任根

manifest 使用 Ed25519 对去掉 `signature` 字段后的确定性 JSON 签名。客户端 `CapabilityArtifactManager` 的信任根只能由宿主本地构造参数提供；远端 catalog、manifest 和制品都不能新增或替换信任根。

正式构建必须注入：

- `YUANPU_ARTIFACT_SIGNING_KEY_FILE`：Ed25519 私钥 PEM 文件；
- `YUANPU_ARTIFACT_SIGNING_KEY_ID`：与客户端预置公钥匹配的稳定 ID；
- `YUANPU_ARTIFACT_BASE_URL`：不可变制品发布基址。

没有发布凭据时，构建脚本只生成一次性的开发密钥和 `development: true` 的本地 trust-root 文件，用于测试及本次桌面包内部装配。它不具备生产发布资格。当前生产密钥托管、轮换和正式发布仍为 **UNVERIFIED**，不得把开发根上传为生产根。

## 安装和恢复

进程外制品与旧 Pi 插件分开管理：

```text
~/.yuanpu/packages/
├── state.json                 # 原 npm/Git Pi 插件，保持兼容
├── installed/                # 原 Pi 插件
├── artifact-state.json       # python-mcp 活动版本
├── artifacts/<id>/<version>/<platform-arch>/
├── .staging/artifacts/
├── .artifact-install.lock
└── config/                   # 用户配置；更新/回滚不删除
```

安装顺序为：本地信任根验签 → Runtime 版本与平台匹配 → 有界下载及 SHA-256 → 拒绝穿越、链接和超限归档 → 暂存目录健康检查 → 不可变版本目录 → 原子改写活动状态。

跨进程排他锁防止并发安装。新旧版本使用不同目录，不覆盖正在运行的 Windows 文件；健康检查或状态切换失败时活动版本仍指向旧目录。显式 `rollback()` 只切换已有且入口仍存在的历史版本。离线查询活动版本只读取本地状态。

Python 制品不会写入 Pi `settings.packages`。`detectMcpOwnershipConflicts()` 只报告 Yuanpu 和旧 `pi-mcp-adapter` 对同名连接的重复托管，不修改或删除旧配置。

## Catalog 发布入口

目录服务提供：

- `GET /v1/capability-packages/builtin.python.echo/manifest`
- `GET /v1/capability-packages/builtin.python.echo/artifacts/<filename>`

服务端通过 `YUANPU_ARTIFACT_ROOT` 指向已经签名的输出目录；服务只原样返回 manifest 和不可变制品，不代替客户端验签。生产发布时构建使用的签名 URL 必须与实际制品地址一致。
开发 manifest 使用相对的 `artifacts/<filename>`；安装器以实际 manifest URL 为基址解析，但验签仍针对原始相对 URL，不会通过改写字段破坏签名。

## CI 平台

现有 GitHub Actions 矩阵保持为 `linux-x64`、`darwin-arm64`、`win32-x64`。Runtime 与 Desktop 工作流都安装固定 uv、在对应 runner 上构建和烟测 Python 制品；Desktop 随包携带当前平台目录。非当前 macOS 主机的无 Python 运行、系统签名提示及真实更新/回滚证据由最终跨平台验收任务记录，不能由本机结果推断。
