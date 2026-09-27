# TASK-050 独立助理完整业务验收（阶段交接）

- Keywords: `packaged Electron`, `SEA`, `Assistant Worker`, `two Work`, `suggestion`, `source revocation`, `WeCom`。
- Owner: `root-task050-verifier-10414-10414`；分支 `task/task-050-assistant-full-acceptance`；2026-09-27。当前验收脚本修订 `efdf902` 已集成 main；状态仍为 **in_progress**，以 `.tasks/tasks.yaml` 为准。
- 设计与验收入口：`docs/assistant-memory-proposal.md`、`docs/assistant-skills-and-automation.md`、`.tasks/verification/TASK-050/results.md`。新打包探针在 `apps/desktop/test/task-050-packaged-assistant-probe.mjs`；无产品实现修改。
- 临时 Home 的真实打包 Electron/SEA/Worker + loopback 模型已验证两个新 Work 隔离与评估、七项助理专属技能、桌面建议点击忽略、记忆纠正输入保存、来源两步撤销、App 退出/重启恢复和 Runtime/Worker 回收。合成截图在 `.tasks/verification/TASK-050/assistant-desktop.png`。
- 打包更新/回退探针 `apps/desktop/test/task-021-packaged-electron-app-probe.mjs` 原来只等 Runtime 退出，Assistant Worker 写入时清理临时 Home 可报 `ENOTEMPTY`；现明确等待 Worker PID 消失。原“总模型请求数=Work 请求数”断言被助理后台 review 打破；现按 Work `write` 工具面计数并保持会话上下文断言。修正后四次真实打包 App 启动/候选回退通过。
- Node 24.15.0 / pnpm 11.22.0 / macOS arm64：阶段增量已集成 main，main 的 `pnpm check` exit 0；分支全仓 runner `1790467376378716000.log` exit 0；`pnpm package:desktop` runner `1790467509360909000.log` exit 0；完整 UI 业务探针最终 runner `1790468606540187000.log` exit 0；更新/回退探针 runner `1790468015649433000.log` exit 0。runner 原始日志不提交。
- 首次全仓检查因忽略的模型数据目录缺失且 models.dev 超时失败；复用主线同版忽略数据目录后全仓通过，不是产品失败。宿主没有 zvec 工具；按已知卡片/设计/测试入口用 scoped `rg` 和定向读，未建索引。
- **已授权但暂缓的真实验收**：用户授权在真实助理 Home 写入测试记忆“蓝色纸鹤”、纠正为“绿色纸鹤”，由已配对测试账号发送一次「助理验收：我刚在桌面修订的验收口令偏好是什么？请只回答四个字。」并允许机器人原路回复，随后在 App 遗忘并退出。原始消息和最小 tombstone 可留存；不能额外主动外发。另一个任务的 dev App 当前持有真实 Home 的 Runtime/Worker，须协调退出并备份后才能安全开始；本卡尚未访问真实 Home 内容或发送消息。
- **新发现的产品阻断**：临时 Home 中真实 Worker/Pi + loopback 模型复现：同一会话先建立，再导入蓝色记忆并纠正到绿色 v2；下一次模型输入不含绿色记忆，答复“未知”。独立红测 `apps/runtime/test/task-050-memory-refresh-probe.mjs`，runner `1790469379939975000.log` exit 1；结构化证据 `sessionReused=true`、`correctedMemoryVersion=2`、`refreshedMemoryVisibleToModel=false`、`answerMatchesCorrection=false`。此探针故意不纳入当前全仓绿色检查；产品 owner 会建独立修复卡。本卡保持 **in_progress**。
- 下一步：产品修复集成后先在临时 Home 复测同会话 v2 记忆及撤销，再协调真实单实例退出、可恢复备份，最后按唯一授权的企业微信流程验收。外部模型语义质量及 Windows/Linux 仍未验证；任何缺陷不在本验收卡暗改。
