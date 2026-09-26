# 独立助理与双入口阶段验证（TASK-042）

状态：**in_progress；离线场景通过，真实企业微信往返未验证。** 本记录只验证已列明的运行模式，不把模拟渠道、loopback 模型、编译或 SEA 启动冒烟算作真实账号收发。

## 基线与环境

- 产品基线：`8345075264d7176c8d9a410b525d837cf71fd808`（已集成 TASK-040/041），分支 `task/task-042-assistant-verification`，独占 worktree `.worktrees/assistant-verification`。运行阶段的 tracked diff 为空；验证新增的未跟踪 `apps/runtime/test/task-042-stage.test.mjs` SHA-256 为 `78fe926de727cdf89b84c37bda06cab6ce068e6504c9b02da85ff2d8e02663e8`。本文件及 handoff 是运行后编写的证据，不改变产品代码。
- 平台：macOS 26.5.2 arm64；Node `24.15.0`、pnpm `11.22.0`。命令均通过 `python3 ~/.agents/skills/coding-owner/scripts/worktree-kit.py --root /Users/linxinhong/projects/yuanpu-agent/.worktrees/assistant-verification run --label <label> --timeout <seconds> --require ... -- <command>` 运行；私有 runner JSON/log 在主仓 `.git/worktrees/assistant-verification/coding-owner/`。测试只使用临时 Home、loopback HTTP 模型和模拟企微 transport，没有读取用户企微账号内容、打印凭据或发送外部消息。
- 检索：当前宿主无可调用 zvec-grep；按已知 TASK-042、AssistantHostService、Worker、父进程锚点，使用 scoped `rg` 和对应范围读取 `apps/runtime/test`、`apps/runtime/src`、`packages/yuanpu-runtime`、`.tasks`、`docs/assistant-memory-proposal.md`。
- 环境准备：`prepare` 与 `doctor` 选定 Node 24/pnpm 11，隔离 worktree 安装 `task042-install` 成功（runner `1790436212323377000.json`）。首次 `pnpm build:runtime`（`1790436234079001000.json`）与随后 `pnpm build:pi`（`1790436254558641000.json`）因 `models.dev/api.json` 连接超时而失败，属于生成模型目录的外部网络前置条件。未修改生成器或产品代码；执行 `mkdir -p packages/ai/src/providers/data && cp -R /Users/linxinhong/projects/yuanpu-agent/packages/ai/src/providers/data/. packages/ai/src/providers/data/`，复用当前主线同一源码树下已有的忽略型目录数据（约 772 KiB），没有提交这批生成数据。然后 `pnpm build:pi` 通过（`1790436285493466000.json`）。直接 `pnpm build:runtime` 仍会调用 Pi AI 的在线 `generate-models`，再次超时（`1790436302600333000.json`）；改用仓库 `pnpm check` 的 `build:pi` 离线数据路径，完整检查通过。此数据复用只能证明本机离线构建，不证明实时模型目录同步。

## 场景结果

| ID | 模式与预期 | 实际观察与判定 | 命令／证据 |
| --- | --- | --- | --- |
| V42-01 | **真实 Runtime/Worker + loopback 模型**：两个独立本地进程客户端中，第一个丢弃已接受响应，第二个按业务 ID 重连重投并查询；只能有一个任务和一次模型调用。 | **PASS**：两个客户端收到同一 `asst_` run，后续 transcript 为用户与助理各一条，fixture provider 计数 1。此处是真实 Runtime/Worker/API，不是真实外部模型或 Electron UI。 | `node --test apps/runtime/test/assistant-channel-live.test.mjs`，包含于 `task042-focused-baseline` runner `1790436342083027000.json`；完整 `pnpm check` runner `1790436457693024000.json`。 |
| V42-02 | **真实 Worker + 模拟企微渠道**：已配对且绑定的私聊进同一助理进程，但桌面与企微会话 ID 不同；原请求回复，不进入 Work；陌生人和群拒绝。 | **PASS（fixture WeCom）**：真实 Worker 的两渠道 loopback 调用共 2 次、不同 Session；独立阶段探针验证旧 AgentService 不接收新助理消息、未配对与群拒绝。未使用真实企微账号。 | `node --test apps/runtime/test/assistant-channel-live.test.mjs apps/runtime/test/task-042-stage.test.mjs`；runner `1790436342083027000.json`、`1790436447526433000.json`。 |
| V42-03 | **隔离 SQLite/Home 旧数据迁移**：旧绑定与原 Pi 会话可读，迁移后产生新助理会话；旧档案可按宿主内容引用读取且受众隔离；原件不被覆写。 | **PASS（fixture）**：预置旧绑定与 Pi 对话，Host 自动迁移；旧 desktop/WeCom session ID 保留，新会话 ID 不等于旧共享 ID；原会话迁移前后仍可读，非本人的 contentRef 读取失败。 | `node --test apps/runtime/test/task-042-stage.test.mjs`，runner `1790436447526433000.json`；迁移/归档持久层回归也在 `task042-focused-baseline`。 |
| V42-04 | **重复入站、响应未知与撤销**：同平台消息 ID 重投不重复执行；平台回执未知不盲重发；撤销配对后旧请求失去投递权。 | **PASS（fixture）**：独立探针确认 prompt 1 次、transport reply 1 次，重复入站 `duplicate=true`，delivery=`unknown` 后恢复仍 1 次外发；撤销配对后 `canDeliver=false`。慢回合解绑和同联系人重绑的 0 外发回归通过。 | `node --test apps/runtime/test/task-042-stage.test.mjs apps/runtime/test/assistant-host.test.mjs`；runner `1790436447526433000.json`、`1790436342083027000.json`。 |
| V42-05 | **无 Electron host、换 Home 根、第二写入者**：停止后搬迁 Home，已接受任务仍可查；重复 ID 不再次调用模型；同时启动的第二写入者拒绝。 | **PASS（真实 Worker + loopback）**：独立阶段探针在不同绝对根启动 headless manager，迁移后的任务状态/正文不变，模型调用仍 1；竞争 Worker 启动报单写锁，第一 Worker 继续可查，停止后 PID 清空。只验证停机复制，不声称运行中目录同步或云端部署。 | `node --test apps/runtime/test/task-042-stage.test.mjs`，runner `1790436447526433000.json`。 |
| V42-06 | **强制断开／杀 Worker／父进程退出**：运行中被杀的已接受任务重启显示 interrupted；Runtime 就绪后父进程强杀时 Runtime 与 Worker 均无孤儿；就绪前父进程退出也不留 Runtime。 | **PASS（真实进程）**：Worker SIGKILL 后未完成 task 查询为 `interrupted`；父进程强杀后由 PID 存活探针确认 Runtime/Worker 退出，MCP 后代亦退出。该父进程是测试 harness 模拟 Electron 监督关系，不是打包 App UI。 | `node --test apps/runtime/test/assistant-worker.test.mjs apps/runtime/test/runtime-parent-exit.test.mjs`，runner `1790436575202399000.json`；完整检查再次覆盖。 |
| V42-07 | **当前平台 SEA**：单文件 SEA 能启动助理 Worker、查询任务；Runtime staged update 后可启动，子进程清理。 | **PASS（darwin-arm64 smoke）**：`pnpm build:native` runner `1790436515689506000.json`、`pnpm smoke:native` runner `1790436531270730000.json` 均 exit 0；日志含自包含 Python 能力包冒烟及 staged Runtime update 成功。此为 SEA 冒烟，非签名打包 App 的完整退出旅程。 | `pnpm build:native`；`pnpm smoke:native`。 |
| V42-08 | **仓库完整门禁**：TASK-042 新增探针及现有回归都通过。 | **PASS**：`pnpm check` exit 0；Runtime suite 43/43，含本轮两条阶段探针、真实 HTTP 双客户端与进程退出。 | `pnpm check`，runner `1790436457693024000.json`，运行时产品 HEAD `8345075` + 上述未跟踪探针 SHA；`changed_during_run=false`。 |
| V42-09 | **真实获授权企微用户私聊**：真实平台入站、原路回复、桌面/企微上下文独立、重连时效。 | **UNVERIFIED**：宿主有启用连接与配对元数据，但本轮没有具体外发测试目标和发送授权；未接入、未读账号正文、未发送任何消息。fixture 结果不能替代这一场景。 | 待明确测试目标与授权后，在隔离记录中运行受控往返；本轮无执行命令。 |
| V42-10 | **跨平台/云端迁移**：Windows/Linux SEA 与真实远程同步。 | **UNVERIFIED／未实现边界**：本轮仅 macOS arm64；Home 停机搬迁及窄 Host→Worker 接缝通过，不证明云端持久服务、远程鉴权、运行中双向同步或跨平台包。 | TASK-042 卡与 `docs/assistant-memory-proposal.md` 本地先行约束。 |

离线必需场景 8 项通过，真实企业微信 1 项未验证；跨平台／云端边界另列为未验证。**TASK-042 保持 in_progress，不解锁依赖 TASK-043。** 旧来源在归档空读或原件失效时仍保留快照，不产生删除／暂不可用事件；TASK-041 交接已明确该来源生命周期与分片预算归 TASK-043，不能把本阶段的旧档案保留判定扩写为遗忘能力。当前未发现离线产品阻断，真实企微往返及打包 App 完整退出仍缺阶段证据。
