# 隔离验证 Pi v0.87.1 内核同步（TASK-031）

## 结论

macOS arm64 的隔离候选可以构建、通过项目测试、生成与运行 SEA，并完成合成数据的打包 App/定时任务回归；这证明当前 Yuanpu 适配面与候选 Pi 0.87.1 在这些路径上兼容，**不等于已正式升级或跨平台发布通过**。main 仍固定 Pi 0.86.1。候选保存于未合入 main 的 `task/task-031-pi-0871-candidate` 提交 `da8e488`。

正式升级不能只执行 `pnpm sync:pi`：`packages/yuanpu-runtime/package.json` 的 `@earendil-works/pi-coding-agent` 仍精确钉在 0.86.1，且 `packages/yuanpu-runtime/src/pi/index.ts` 的 `PI_UPSTREAM_VERSION` 与相邻测试也硬编码 0.86.1。隔离候选只临时把依赖版本改成 0.87.1，锁文件显示 `link:../coding-agent`，安装后的符号链接指向本地 0.87.1 镜像；未改版本常量，因此候选 Runtime 的 `RuntimeInfo.piVersion` 仍会误报 0.86.1。这是正式升级需修正的元数据与依赖边界，不把候选的绿灯扩大为完成升级。

## 来源、方法与影响面

- 现有基线：`docs/pi-upstream.json` 记录 0.86.1、Pi commit `3390bd93630965a12a0a1a5c36ce890ec22f7e1d`；任务起点 main `66dbee8`。候选：官方 [v0.87.1 release](https://github.com/earendil-works/pi/releases/tag/v0.87.1) 的 tag commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`，从官方仓库浅克隆到一次性目录并核对 remote、tag、package version。没有修改现有 `../pi` checkout。
- 在任务工作树用 `node scripts/sync-pi-packages.mjs <isolated-v0.87.1-checkout>` 同步 12 个 Pi 镜像目录及版本记录，仅作为候选。随后只在候选中将 Yuanpu Runtime 的 Pi 依赖钉到 0.87.1、生成候选锁文件并安装；候选提交 `da8e488` 涉及 216 文件，上游部分为官方快照，未混入 Yuanpu 特定改动。main 的 Pi 源、依赖和运行中 App 均未更新。
- 与 Yuanpu 适配面相关的 Pi 导出仍可用于 `createAgentSession`、`DefaultResourceLoader`、`defineTool`、`ModelRuntime`、`SessionManager`、`SettingsManager`，当前 TypeScript 与合成业务路径通过。上游扩展了模型支持及会话/扩展接口；没有用真实模型凭据验证官方发布说明中的新模型可调用性。
- 检索：ZG 查询 Pi 同步/Runtime 适配/版本与入口关系，命中 `docs/pi-integration.md`、`package.json`；scoped `rg` 核对 `scripts/sync-pi-packages.mjs`、`packages/yuanpu-runtime/src/pi/index.ts`、版本常量、测试入口。未创建或更新检索索引。

## 可执行证据

下列命令在 macOS arm64、Node 24.15.0、pnpm 11.22.0 的候选树运行。`coding-owner` runner 记录命令、退出码和候选树指纹；提交 `da8e488` 的上游镜像、Yuanpu 依赖 pin 与锁文件和受测源树一致，提交前 `git diff --cached --check` 通过。`build:pi` 首次从外部模型目录源水合被 Git 忽略的 `packages/ai/src/providers/data/`，所以构建前提交树指纹 `307134aa…` 与水合后的测试/打包树指纹 `288118e3…` 不同；后续测试之间指纹稳定。这份未锁定的生成数据不计为 Pi 版本差异，也不能声称打包制品仅由提交内容完全重现。所有业务测试数据在临时目录中，未使用真实机器人、模型密钥或个人 App 数据。

| 场景 | 结果 | runner |
| --- | --- | --- |
| 官方 tag 同步与锁文件解析 | PASS；候选 `docs/pi-upstream.json` 为 0.87.1，Runtime 依赖解析为 `link:../coding-agent`，安装后的链接指向本地 0.87.1 镜像 | 同步 `1790166404215317000.json`、候选锁文件 `1790166507821468000.json`、安装 `1790166521439931000.json` |
| Pi 与 Runtime 构建 | PASS：`pnpm build:pi`、`pnpm build:runtime` | `1790166542941939000.json`、`1790166565522867000.json` |
| Pi/Agent/调度/IM 聚焦测试 | PASS：`node --test packages/yuanpu-runtime/test/pi.test.mjs packages/yuanpu-runtime/test/agent-service.test.mjs packages/yuanpu-runtime/test/scheduler.test.mjs apps/runtime/test/scheduled-im-delivery.test.mjs` | `1790166584482162000.json` |
| 全仓门禁 | PASS：`pnpm check` | `1790166601158658000.json` |
| macOS SEA | PASS：`pnpm build:native`、`pnpm smoke:native` | `1790166635856206000.json`、`1790166646762652000.json` |
| macOS 打包与隔离 App | PASS：`pnpm package:desktop`，并对候选 `.app` 运行 TASK-021 四次启动探针：任务可见/持久化、SEA 激活与回退、提示及子进程清理 | `1790166734720870000.json`、`1790166812514098000.json` |

复现打包探针：`TASK_021_PACKAGED_APP_PATH=<candidate>/apps/desktop/release/mac-arm64/YuanpuAgent.app node <task-021-worktree>/apps/desktop/test/task-021-packaged-electron-app-probe.mjs`。它使用独立 `YUANPU_HOME`、Electron userData 和合成工作区；没有触碰真实 App。聚焦测试覆盖受控 IM/计划代码路径，未向企业微信发真实消息。

## 未验证与后续决定

- 官方 release 提到的 Claude Opus 5.5、GPT-6 Sol/Luna、xAI 默认 Grok 4.7 未用真实 provider/订阅或新模型请求验证；不推断它们在 Yuanpu 中可用。Windows/Linux 构建、安装、SEA 与系统行为未运行；macOS 包为 ad-hoc，生产签名缺口仍在。
- 没有覆盖真实会话数据在 0.86.1→0.87.1 的迁移、长期运行、更新源制品信任或真实企业微信收发。当前自动化只证实隔离合成路径。
- 若决定正式升级，应另行实施：同步官方镜像、更新 Runtime 依赖与锁文件、使 `PI_UPSTREAM_VERSION`/测试/健康信息与唯一上游版本记录一致，重跑上述门禁及目标平台/授权业务验收。不能把本候选提交直接合入 main 作为完成品。
