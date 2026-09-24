# TASK-008 跨平台技能安装与升级业务验收

- 验收基线：`bc83168828e5cb12203cfc471d58c969af6811f7`；本地修复补充至 TASK-010 集成 revision `3907f35`
- 本地环境：macOS 26.5.2 arm64；Node 24.15.0；pnpm 11.22.0；uv 0.11.9
- 独立验收者：`/root/task005_business_verifier`
- 检索：当前 host 未提供 zvec-grep，按仓库指令使用 scoped `rg` 定位 workflow、发布门、Runtime 更新与既有 S1–S7 证据；未创建索引。
- 最终结论：**NOT PASS / 当前不可发布**

## 场景矩阵

| 场景 | 状态 | 证据与边界 |
| --- | --- | --- |
| S1 SEA 经两个元工具调用冻结 Python MCP | PASS（macOS arm64） | TASK-009 从干净输出首次重建并通过 `pnpm build:native && pnpm smoke:native`；搜索、正常调用及 MCP 错误保真通过。Linux/Windows 未验证。 |
| S2 宿主审批、一次消费和防重放 | PASS（已有回归） | TASK-005/TASK-007 的真实 Runtime 与桌面链路证据仍通过 `pnpm check`；本卡没有将模型输出视为授权。 |
| S3 单源失败隔离、取消和进程清理 | PASS（macOS arm64） | TASK-009 新增已初始化但挂起 `tools/list` 的真实进程回归，超时后 PID 消失；验收结束没有本工作树的 Runtime/Python MCP 遗留进程。Windows Job Object 实机仍未验证。 |
| S4 无系统 Python 的自包含安装 | PASS（macOS 制品级） / UNVERIFIED（三平台） | 冻结 Python 制品在隔离 PATH smoke 通过，并被打进 `.app`；应用内 Runtime 与 `YuanpuEchoMcp` 均为 Mach-O arm64、版本 0.1.0。Linux/Windows hosted artifact 未运行。 |
| S5 Python 能力更新失败保旧、成功更新与回滚 | PASS（macOS 既有桌面场景） | TASK-007 真实桌面测试覆盖坏签名保留 0.1.0、成功升级 0.2.0 和显式回滚。Windows 文件占用实机恢复未验证。 |
| S5 SEA Runtime 独立更新 | PASS（macOS arm64） / UNVERIFIED（Linux/Windows） | TASK-010 通过 loopback HTTP 下载刚构建的真实 SEA，证明校验后只暂存、模拟重启才原子激活；故障矩阵覆盖大小、哈希、传输中断、版本与 metadata 错误并保留旧版。Linux/Windows hosted run 尚无结果。 |
| S6 离线、旧 npm 插件/配置保留 | PARTIAL | TASK-007 覆盖旧 `pi-mcp-adapter` 冲突显式选择且配置保留；macOS 自包含二进制可直接执行。三平台断外网桌面安装/调用未验证。 |
| S7 搜索→信任→安装→配置→对话→审批→更新/回滚 | PASS（macOS 既有桌面场景） | TASK-007 在真实 Electron/LongCat 链路完成并保留截图和持久状态证据。本卡未在 Linux/Windows 重复该桌面旅程。 |

## 命令与制品

- `pnpm check`：PASS（集成 TASK-009 后全仓构建、类型检查及测试；runtime-kit 45/45、runtime 3/3、desktop 2/2、server 2/2）。
- 干净输出首次 `pnpm build:native && pnpm smoke:native`：PASS；根级 smoke 会自行准备并验证冻结 Python 制品。
- `pnpm package:desktop`：PASS（macOS arm64），同时包含完整 build/native/smoke 门。
- ZIP：`YuanpuAgent-0.1.0-mac-arm64.zip`，SHA-256 `d2ab15fc1d476e1a63dc0a4184b0cbe959db38f73ec9a38ae521c10951886543`。
- DMG：`YuanpuAgent-0.1.0-mac-arm64.dmg`，SHA-256 `205a688601e2c1930872873c4b75d268a3976688799a5c43088502870e7844bd`。
- 应用内 `YuanpuAgentRuntime-darwin-arm64 --version` 与 `YuanpuEchoMcp --version` 均输出 `0.1.0`。

生成物位于被 git 忽略的 `apps/desktop/release/`，不作为源码提交。

## 发布硬门

| 门 | 状态 | 观察 |
| --- | --- | --- |
| 当前 revision 的 hosted CI | UNVERIFIED | 集成 main 尚未推送，当前本地 revision 没有 GitHub Actions 运行结果。不能用旧 revision 的 workflow 代替。 |
| Linux x64 / Windows x64 bundle | UNVERIFIED | workflow 声明了三平台矩阵，但当前 revision 没有托管 runner 产物与执行证据。 |
| 生产能力签名 | FAIL-CLOSED / 未配置 | 清空生产密钥、公钥、key id、下载基址后 `verify-release-signing-env.mjs` 以 exit 1 拒绝发布；本地制品使用开发临时信任根，不是生产 Ed25519 信任链。 |
| macOS Developer ID 与公证 | UNVERIFIED / 不可发布 | 本地 `.app` 为 ad-hoc 签名，`TeamIdentifier=not set`，`spctl` exit 1；没有 Developer ID 或公证票据。 |
| Windows Authenticode / SmartScreen | UNVERIFIED | 没有 Windows 签名凭据、签名制品或真实系统提示记录。 |
| 三系统安全提示与离线旅程 | UNVERIFIED | 当前只有 macOS arm64 本地环境，不能把构建矩阵定义当成真实用户验收。 |

## 独立复核与后续动作

独立 verifier 在 `bc83168` 上确认 TASK-009 已清除 macOS 首次冷启动与进程清理阻塞，且应用内两个二进制均为 arm64 0.1.0。TASK-010 随后补齐 macOS 真实 SEA 分阶段更新回归；由于三平台 hosted runner、离线旅程和生产签名仍缺失，结论维持 **TASK-008 NOT PASS**。

解除阻塞需要：

1. 将待验 revision 推到远端并取得 Linux、macOS、Windows hosted bundle 的成功运行和制品证据。
2. 配置生产 Ed25519、Apple Developer ID/公证及 Windows Authenticode 凭据，记录各系统真实安装提示。
3. 在三平台执行无系统 Python、断外网的安装/调用旅程。
4. 为 Runtime manifest 增加独立生产信任验证；当前 SHA-256 随同 manifest 获取，不能替代发布者签名和平台代码签名。

## 2026-09-24 当前版本复验（仍 NOT PASS）

- 产品基线：`main` `710a5e8`；验收探针提交 `46787b9`，仅新增打包资源探针及 Desktop Bundle 调用。此前 `bc83168`/`3907f35` 的 macOS 结果是历史证据，不外推到当前三平台。
- 本机：macOS arm64，Node 24.15.0、pnpm 11.22.0；`pnpm check` PASS。首次在错误的 Node 26/pnpm 9 环境检查出现依赖缺失，随后使用项目指定版本执行 `pnpm install --frozen-lockfile --ignore-pnpmfile` 并重跑通过；错误环境结果不计入验收。
- [Runtime Bundle 35965998926](https://github.com/linxinhong/yuanpu-agent/actions/runs/35965998926)：`710a5e8` 上 Linux x64、macOS arm64、Windows x64 三 job 均 PASS；包含原生 SEA/冻结 Python 的搜索、执行、错误保真 smoke，以及 Runtime 分阶段更新 smoke。工作流安装 Python/uv 且联网，不代表无系统 Python 或离线安装。
- [Desktop Bundle 35966874652](https://github.com/linxinhong/yuanpu-agent/actions/runs/35966874652)：`46787b9` 上三平台均完成打包；新增探针从 electron-builder 的 `release/*-unpacked/resources` 而非开发输出目录取 SEA 与冻结 Python。在空 PATH 下 macOS/Linux PASS。Windows 搜索、调用和错误保真已输出正确 JSON，但进程在 30 秒内未退出，探针 FAIL：空 PATH 同时移除了 MCP 清理依赖的 `taskkill`。本地已将 Windows 探针 PATH 缩为 System32，尚未运行 hosted 复测，故 Windows 此项保持 **UNVERIFIED/FAIL（探针）**，不能据 JSON 输出算 PASS。
- 探针使用打包阶段的 unpacked 资源，尚未安装或解压上传的 DMG/ZIP/AppImage/EXE，也没有断网；它仅缩小 S4 的证据缺口，不满足 S4/S6 完整目标机验收。
- 独立非实现者复核认为当前 S1、SEA 更新三平台 smoke 有新增证据；S2/S3 和旧 npm 兼容仍主要依靠既有回归；S5 能力包更新/回滚、Windows 文件占用，S6 三平台无 Python/断网安装，S7 当前版真实 UI 全链路，以及生产签名、系统提示仍缺当前完整证据。总体 **BLOCKED / NOT PASS**。
- 过程偏差：任务卡约束“本轮不自动提交或推送”；为运行 hosted CI 已将 `46787b9` 提交并推送至专用 `task/task-008-release-verification` 分支，未集成 main。后续修正和本记录仅留本地，不再自动提交、推送或集成。
