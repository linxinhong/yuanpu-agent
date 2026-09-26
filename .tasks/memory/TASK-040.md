# TASK-040 接入助理进程与 SEA 生命周期

- Owner：assistant-architecture-sol1；分支 `task/task-040-assistant-worker`；专属 worktree `.worktrees/assistant-architecture`；领取提交 `ab72894`。本记录用于 owner 分支交接，main 集成与任务 complete 由主线 writer 执行。
- 关键词：Assistant Worker、Runtime 宿主、模型 IPC、Home 单写锁、SEA、父进程、取消、崩溃恢复。

## 实现边界

- `apps/runtime/src/assistant-worker-manager.ts` 由 Runtime 宿主启动专属子进程，IPC 使用独立 correlation ID，公开 `start/prompt/task/cancel/stop`。启动失败不发 Runtime `ready`，以免 Desktop 更新健康检查把助理不可用版本标为成功；启动后崩溃最多重试三次，Work 执行器不随 Worker 退出。旧桌面/企微用户入口仍归 TASK-041 切换，本卡没有把旧 AgentRun 路由改接 Worker。
- `apps/runtime/src/assistant-worker.ts` 使用显式绝对 Assistant Home，SQLite 独占事务保持单写锁，持久记录已接受任务。并发重复 task ID 共用一次结果；重启将残留 `running` 标为 `interrupted`。任务期限和取消通过每回合 AbortSignal 传给 Pi Session，排队任务的取消不会 abort 同 Session 中正在执行的其他任务。宿主断开、显式停止和父进程异常退出会回收 Worker；Runtime 关闭资源时先停止 Worker。
- `apps/runtime/src/assistant-model.ts` 在 Runtime 宿主读取 App 模型配置与凭据，私有 IPC 仅传一次回合所需模型与认证；Worker 不读取 App 凭据路径、不依赖 Electron 或 Work 数据库。当前支持 OpenAI completions/responses、Anthropic messages、Google generative AI 适配；其他模型 API 明确报错。
- 内置技能从 `packages/yuanpu-assistant/skills` 构建时生成数据模块，嵌入 Runtime 单文件/SEA，再由 Worker 向 Assistant Home 种子复制。没有独立的执行文件相邻资源目录，因此 Desktop updater 仅迁移 SEA 文件时，技能资源不会丢失。已有用户编辑不会覆盖；七份具体默认技能仍由 TASK-044/045/046/048 交付。
- Runtime `ready` 保持单行 JSON 旧协议，新增可观察的 `assistantWorkerPid`。无 Electron 的测试宿主可执行真实模型回合；客户端生命周期不参与 Worker 停止决策。

## 验证与复核

- 独立只读复核发现两项 P1：执行文件相邻技能资源不随 updater 迁移，以及排队任务取消误 abort 当前任务；均已修复并有测试。复核另指出初次启动失败仍发 `ready` 的 P2；已改为拒绝启动并测试双写锁占用下无 `ready`。
- 聚焦测试覆盖：真实 Pi loopback 回合及宿主解析模型、任务查询与取消、重复 ID 仅执行一次、同 Session 排队取消互不干扰、Home 第二写入者拒绝、Worker SIGKILL 后重启和未完成任务 `interrupted`、父进程强杀后 Runtime 与 Worker PID 均消失。
- 最终在 macOS arm64 / Node 24.15.0 / pnpm 11.22.0 执行 `pnpm check && pnpm build:native && pnpm smoke:native`，全部通过；`@yuanpu-agent/assistant` 5/5、`apps/runtime` 33/33。SEA 冒烟在清空 `PATH` 后仍从单文件启动 Worker，Runtime staged update 冒烟通过。日志：`.git/worktrees/assistant-architecture/coding-owner/1790433037729371000.log`，执行期间工作树未变化。
- 未验证：Windows/Linux 原生包与签名链、真实外部模型账户、TASK-041 用户入口和企业微信端到端、云端部署。Runtime 初次启动失败会使整体 sidecar 无 `ready`，以保证升级回退判断可靠；Worker 在 Runtime 就绪后的崩溃不终止 Work。
- 检索：当前宿主未提供 zvec-grep 工具；按精确锚点使用 scoped `rg`。未修改同步 Pi 上游包或 main 工作区未提交源码，未推送。
