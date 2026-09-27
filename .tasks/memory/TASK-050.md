# TASK-050 独立助理完整业务验收（阶段交接）

- Keywords: `packaged Electron`, `SEA`, `Assistant Worker`, `two Work`, `suggestion`, `source revocation`, `WeCom`。
- Owner: `root-task050-verifier-10414-10414`；分支 `task/task-050-assistant-full-acceptance`；2026-09-27。当前验收脚本修订 `efdf902` 已集成 main；状态仍为 **in_progress**，以 `.tasks/tasks.yaml` 为准。
- 设计与验收入口：`docs/assistant-memory-proposal.md`、`docs/assistant-skills-and-automation.md`、`.tasks/verification/TASK-050/results.md`。新打包探针在 `apps/desktop/test/task-050-packaged-assistant-probe.mjs`；无产品实现修改。
- 临时 Home 的真实打包 Electron/SEA/Worker + loopback 模型已验证两个新 Work 隔离与评估、七项助理专属技能、桌面建议点击忽略、记忆纠正输入保存、来源两步撤销、App 退出/重启恢复和 Runtime/Worker 回收。合成截图在 `.tasks/verification/TASK-050/assistant-desktop.png`。
- 打包更新/回退探针 `apps/desktop/test/task-021-packaged-electron-app-probe.mjs` 原来只等 Runtime 退出，Assistant Worker 写入时清理临时 Home 可报 `ENOTEMPTY`；现明确等待 Worker PID 消失。原“总模型请求数=Work 请求数”断言被助理后台 review 打破；现按 Work `write` 工具面计数并保持会话上下文断言。修正后四次真实打包 App 启动/候选回退通过。
- Node 24.15.0 / pnpm 11.22.0 / macOS arm64：阶段增量已集成 main，main 的 `pnpm check` exit 0；分支全仓 runner `1790467376378716000.log` exit 0；`pnpm package:desktop` runner `1790467509360909000.log` exit 0；完整 UI 业务探针最终 runner `1790468606540187000.log` exit 0；更新/回退探针 runner `1790468015649433000.log` exit 0。runner 原始日志不提交。
- 首次全仓检查因忽略的模型数据目录缺失且 models.dev 超时失败；复用主线同版忽略数据目录后全仓通过，不是产品失败。宿主没有 zvec 工具；按已知卡片/设计/测试入口用 scoped `rg` 和定向读，未建索引。
- **记忆缺陷已修复并独立复测**：先前临时 Home 真实 Worker/Pi + loopback 模型红测（runner `1790469379939975000.log`）证明同 session 纠正 v2 后不可见。TASK-065 已集成 main `c48373c` 并结项 `f405cc0`；独立 Node 24 复测 runner `1790471966800243000.log` exit 0，同 session 见绿色 v2、不见蓝色 v1，重启仍正确，遗忘后新 session 不再取回。新版打包 Electron/SEA/Worker 关键业务探针 runner `1790472132705158000.log` exit 0；打包 runner `1790472068914628000.log` exit 0。尝试完整依赖链构建曾因 models.dev 请求超时失败，随后使用已存在的离线模型产物定向构建成功；TASK-065 主线 `pnpm check` runner `1790471730579155000.log` exit 0。
- **已授权真实企微往返通过**：主任务使用真实桌面 UI 将 personal/local-user 的纯测试记忆从蓝色 v1 修订为绿色 v2；保存的 Work 回合无测试口令。一次已配对私聊入站在 Runtime 完成，回复“绿色纸鹤”、投递 accepted 且无 failure，用户确认实际收到。主任务随后通过 UI 遗忘，数据库该记忆文档/修订行均为 0；App 正常退出，Electron/Runtime/Worker 均停止。本验证者仅接收脱敏核对结果，没有读取真实 Home 内容、账号或凭据，也没有自行发送消息。未推送主动建议或第二条消息。
- 阶段证据已由主任务集成。真实 Home 试验前创建了受限权限的本机完整备份；助理与工作数据库备份的 SQLite 完整性检查均为 `ok`，备份未进入仓库。外部模型语义质量、Windows/Linux 和云端同步仍未验证，不冒充本次本机业务验收。任何后续产品缺陷仍走独立修复卡。
