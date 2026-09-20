# yuanpu-agent

用于验证 pnpm monorepo、TypeScript CLI、Node.js SEA 单文件构建和 GitHub Actions 发布链路的最小项目。目录边界参考 Kimi Code 与 OpenWork：

- `apps/yuanpu-agent`：可运行、可发布的 CLI 应用及 native 构建脚本。
- `packages/core`：不感知 CLI 的共享领域逻辑，由应用通过 `workspace:*` 引用。
- 根目录：只负责编排 workspace、统一工具链和 CI/CD。

## 本地运行

要求 Node.js 22 和 pnpm 11。

```bash
pnpm install
pnpm check
pnpm start -- --name Yuanpu
```

## 构建单文件可执行程序

```bash
pnpm build:native
pnpm smoke:native
pnpm package:native
```

产物位于 `apps/yuanpu-agent/dist-native/artifacts/`，文件名中包含当前平台和架构。

## CI/CD

- `CI`：向 `main` push 或创建 PR 时执行类型检查、JS 构建和测试。
- `Manual native bundle`：可在 Actions 页面手动触发，复用正式发布的构建矩阵，但不做正式签名；分别生成 Linux x64、macOS arm64 和 Windows x64 单文件。
- `Release`：push 与 `apps/yuanpu-agent/package.json` 版本一致的 tag（例如 `v0.1.0`）后，构建三个平台、执行真实二进制冒烟测试，并创建 GitHub Release。

发布附件包含各平台裸二进制、对应的 `.sha256` 文件，以及供未来自动更新器读取的 `manifest.json`。

```bash
git tag v0.1.0
git push origin v0.1.0
```

当前版本只做 ad-hoc macOS 签名，没有配置 Apple 公证或 Windows 正式代码签名。正式对外分发前应补齐签名步骤。
