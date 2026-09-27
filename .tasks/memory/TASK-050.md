# TASK-050 独立助理完整业务验收（阶段交接）

- Keywords: `packaged Electron`, `SEA`, `Assistant Worker`, `two Work`, `suggestion`, `source revocation`, `WeCom`。
- Owner: `root-task050-verifier-10414-10414`；分支 `task/task-050-assistant-full-acceptance`；2026-09-27。当前验收脚本修订 `efdf902` 已集成 main；状态仍为 **in_progress**，以 `.tasks/tasks.yaml` 为准。
- 设计与验收入口：`docs/assistant-memory-proposal.md`、`docs/assistant-skills-and-automation.md`、`.tasks/verification/TASK-050/results.md`。新打包探针在 `apps/desktop/test/task-050-packaged-assistant-probe.mjs`；无产品实现修改。
- 临时 Home 的真实打包 Electron/SEA/Worker + loopback 模型已验证两个新 Work 隔离与评估、七项助理专属技能、桌面建议点击忽略、记忆纠正输入保存、来源两步撤销、App 退出/重启恢复和 Runtime/Worker 回收。合成截图在 `.tasks/verification/TASK-050/assistant-desktop.png`。
- 打包更新/回退探针 `apps/desktop/test/task-021-packaged-electron-app-probe.mjs` 原来只等 Runtime 退出，Assistant Worker 写入时清理临时 Home 可报 `ENOTEMPTY`；现明确等待 Worker PID 消失。原“总模型请求数=Work 请求数”断言被助理后台 review 打破；现按 Work `write` 工具面计数并保持会话上下文断言。修正后四次真实打包 App 启动/候选回退通过。
- Node 24.15.0 / pnpm 11.22.0 / macOS arm64：阶段增量已集成 main，main 的 `pnpm check` exit 0；分支全仓 runner `1790467376378716000.log` exit 0；`pnpm package:desktop` runner `1790467509360909000.log` exit 0；完整 UI 业务探针最终 runner `1790468606540187000.log` exit 0；更新/回退探针 runner `1790468015649433000.log` exit 0。runner 原始日志不提交。
- 首次全仓检查因忽略的模型数据目录缺失且 models.dev 超时失败；复用主线同版忽略数据目录后全仓通过，不是产品失败。宿主没有 zvec 工具；按已知卡片/设计/测试入口用 scoped `rg` 和定向读，未建索引。
- **未验证门槛**：获授权的真实 Home 测试记忆修订后，经已配对测试账号新的真实企微私聊查询；外部模型语义质量及 Windows/Linux。用户只授权过此前一次“收到”往返，不能复用为本次外发许可。父任务已向用户提出一次限定的测试记忆/企微往返授权；在答复前不要碰真实 Home 或发消息，不把本卡标 done。
- 下一步：待用户明确授权在真实助理 Home 写入纯测试记忆“蓝色纸鹤”、纠正为“绿色纸鹤”，并允许已配对测试账号发送一次「助理验收：我刚在桌面修订的验收口令偏好是什么？请只回答四个字。」及机器人原路回复；随后清理测试记忆并核对结果和独立会话。若不授权，保持 unverified/in_progress。任何产品缺陷交由独立修复卡，不在验收卡中暗改。
