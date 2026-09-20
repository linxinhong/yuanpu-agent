# Yuanpu Agent

Electron 图形界面与 Node.js SEA Runtime 解耦的 pnpm monorepo。工程组织参考 OpenWork，独立 Runtime 更新机制参考 Kimi Code。

## 架构

- `apps/app`：React/Vite renderer，只能访问 preload 暴露的窄接口。
- `apps/desktop`：Electron main/preload，负责窗口、Runtime 生命周期与桌面端更新。
- `apps/runtime`：Node SEA sidecar，承载 Agent 与本地服务，可以独立于桌面壳更新。
- `packages/protocol`：Renderer、Electron 和 Runtime 共用的协议版本与类型。
- `packages/core`：不感知界面的领域逻辑。

Electron 首次使用安装包中携带的 Runtime。独立更新会下载到 Electron `userData/runtime/.staging`，校验文件大小和 SHA-256，执行 `--version` 冒烟测试，并在下次启动时原子切换。Runtime API 只监听 `127.0.0.1` 的随机端口。

## 本地开发

要求 Node.js 22 和 pnpm 11。

```bash
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` 会构建 Runtime 和 Electron main/preload，启动 Vite，然后打开 Electron。

## 构建产物

构建当前平台的 SEA Runtime：

```bash
pnpm build:native
pnpm smoke:native
pnpm package:native
```

构建当前平台的 Electron 安装包（会先构建并嵌入 SEA Runtime）：

```bash
pnpm package:desktop
```

Runtime 产物位于 `apps/runtime/dist-native/artifacts/`，桌面产物位于 `apps/desktop/release/`。

## CI/CD

- `CI`：对 push 和 PR 执行类型检查、构建和测试。
- `Runtime Bundle`：既可手动构建三个平台的独立 SEA Runtime，也供正式发布复用。
- `Desktop Bundle`：既可手动构建三个平台的 Electron 安装包，也供正式发布复用。
- `Release`：推送 `v*.*.*` tag 后，同时发布桌面安装包、Runtime 裸二进制和 `manifest.json`。

Runtime manifest 包含协议版本、最低桌面版本、各平台 URL、大小和 SHA-256，供桌面端的独立更新器消费。

```bash
git tag v0.1.0
git push origin v0.1.0
```

当前 macOS 仅使用 ad-hoc 签名，Windows 尚未正式签名。正式对外分发前仍需配置 Apple Developer ID、公证和 Windows 代码签名。
