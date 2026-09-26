# 本机执行与生命周期阶段验证（TASK-014）

状态：分支验证通过，等待集成。独立验证者 `sol-verifier-task-014-20260922-72012`；任务分支
`task/task-014-lifecycle-verification`。产品基线为 `8abf297`，领取提交为 `fb8e2f3`，新增验证
提交及最终完整门禁测试 revision 为 `97a5c12`。本卡尚未合入 main、未 complete、未 push。

## 验证契约与环境

- 规则来源：`docs/application-architecture.md` 第 5、6、10、11、14 节，
  `docs/agent-runtime-contracts.md`，`docs/adr/0001-user-data-boundaries.md`，以及
  TASK-011、TASK-012、TASK-013、TASK-014 的验收条目。
- 验证边界：真实 Runtime HTTP API、Pi 会话适配、SQLite 文件和受管子进程的本机组合；
  不验收 IM 平台或桌面页面，不新增产品功能。
- 隔离：仅使用临时用户目录、临时 SQLite、回环端口、虚构 marker 和可控 Provider/MCP fixture；
  运行后删除临时目录，不记录凭据、聊天正文、数据库副本或原始敏感日志。
- Jev：TASK-022 的采用结论为 `do_not_adopt`，因此本卡由人工逐项核验；不向 TypeSafe 发送
  项目证据，也不以模型判断替代业务裁决。
- 检索：当前主机未暴露 `zvec_grep_search`/`zvec_grep_rg`，未创建索引；先按 TASK、章节和
  已知入口用 scoped `rg`/定点读取，后续会在本文件记录实际有用路径。

## 独立派生的场景

下列预期先由业务规则派生，再检查现有实现和测试。每个场景最终记录命令、观测事实、环境、
revision 及 pass/fail/unverified。

| 场景 | 业务预期与权威事实 | 执行层 | 当前结果 |
| --- | --- | --- | --- |
| LC-01 身份/会话并发隔离 | 两个不同宿主身份和会话可并发；各自只能查询/取消自己的 run，Pi 会话与输出不串话 | Runtime API + Pi + SQLite | pass |
| LC-02 重复入队与副作用去重 | 同一身份域内相同幂等键/指纹返回同一 run；只执行一次；改动指纹明确冲突 | Runtime API + SQLite + 可控副作用 fixture | pass |
| LC-03 排队取消 | 排队 run 取消后不进入执行、不产生副作用，队列载荷被清除，状态为 cancelled | AgentService + SQLite | pass |
| LC-04 运行取消 | 运行 run 返回 cancellation_requested，worker 停止后落 cancelled；已经发生的副作用不声称撤销 | AgentService + 可控 worker + SQLite | pass |
| LC-05 审批后退出再启动 | waiting_approval 绑定到原 run/身份/会话；退出/重启后按外部副作用检查点变为 interrupted 或 result_unknown；一次性授权不重放 | AgentService + 审批 store + SQLite | pass |
| LC-06 宿主身份伪造攻击 | 输入正文或模型输出中的身份/工作区/授权声明不改变宿主 caller；越权查询、取消和跨 owner 会话绑定被拒绝 | Runtime API + 契约策略 | pass |
| LC-07 审批跨 run 复用攻击 | 其他 run、身份或已消费审批不能获权；至多一个决策成功 | 审批 store + AgentService | pass |
| LC-08 正常退出与清理顺序 | 停止接收新任务，唤醒等待者，有界取消/清理 Agent 与 MCP，最后关闭 SQLite；App 退出后无 Runtime/MCP 后代 | Runtime + 受管 MCP 子进程 | pass（macOS fixture） |
| LC-09 强制结束父进程 | Electron/宿主被强杀后，Runtime 通过父进程监视退出，并清理受管 MCP 后代 | Runtime/fixture 真实进程树 | pass（macOS） |
| LC-10 Runtime 崩溃恢复 | Desktop 有限退避重启且同一时刻只有一个受管 Runtime；不会把未知执行当成功或自动整段重跑 | RuntimeManager + 崩溃 fixture + SQLite | pass（macOS fixture） |
| LC-11 staged 更新失败回退 | App 运行期间不切换；下次启动激活失败恢复旧二进制和数据库快照，原数据仍可读取 | RuntimeUpdater + 真实文件/SQLite fixture | pass（macOS fixture） |
| LC-12 协议与迁移边界 | 不兼容协议给出明确失败；新 schema 被旧 Runtime 拒绝；本机迁移/重开可重复 | Desktop/Runtime + SQLite 文件 | pass（macOS） |
| LC-13 平台与真实 Provider 边界 | macOS arm64 只能证明本机范围；Linux、Windows、生产签名和未配置的真实模型不可记为通过 | 环境盘点 | unverified（所列外部边界） |

## 原始观测与复现

### LC-01 至 LC-07

新增可复用测试：

- `packages/yuanpu-runtime/test/task-014-verification.test.mjs` 使用真实临时 SQLite 文件，4/4
  通过。两个身份同时进入 executor，持久化为两个不同 `pi_session_id`；跨身份 get 不可见、
  cancel 为 not_found。相同幂等请求只写一条受控 effects 记录；排队取消不写 effects 且
  `yp_agent_run_queue_payloads` 为 0。运行取消持久化为 `cancelled`、
  `external_effect_state=possible`，并明确副作用未撤销。等待审批退出后为 `result_unknown`，
  审批记录变为 cancelled；重启后 executor 调用数为 0，旧审批和换 run 复用均 invalid。
- `apps/runtime/test/task-014-lifecycle-verification.test.mjs` 启动真实 Runtime HTTP 进程、真实 Pi
  会话与真实 SQLite，使用只监听回环地址的可控 OpenAI-compatible fixture。两个会话必须同时
  到达 Provider 后才放行，各自返回 alpha/beta；重复 alpha 返回同一 run，Provider 总调用仅
  两次；伪造身份返回 HTTP 403 `identity_mismatch`。SIGTERM 后 Runtime 以 code 0 退出。
  关闭后 SQLite 中只有两个 succeeded run、两个不同 Pi binding、队列载荷为 0；Pi 目录中有
  两个分别含对应虚构 marker/回复的 JSONL，会话没有串写。
- 运行记录：`1790071665124003000.json`（AgentService/SQLite 4/4）和
  `1790071376767620000.json`（Runtime API/Pi/SQLite 1/1），均 exit 0。
- 原有真实审批测试也在最终门禁复跑：错误 run/session/workspace/参数绑定均拒绝，并发双决策
  仅一个消费成功，消费后不能重放。

### LC-08 至 LC-12

- Runtime 正常退出测试与 AgentService 清理测试证明等待订阅者被唤醒、运行中状态按不确定性
  收敛、executor/MCP 在错误汇报前清理；新增 API 场景观测 SIGTERM exit code 0。
- `apps/runtime/test/runtime-parent-exit.test.mjs` 的真实进程故障注入通过：父进程 SIGKILL 后
  Runtime 退出；ready 前父进程退出不遗留 Runtime；带 MCP root 和 descendant 的进程树均在
  5 秒观测窗内退出。
- `apps/desktop/test/runtime-manager.test.mjs` 通过：并发 start 只产生一个受管 Runtime，崩溃
  有限重启且实例不重叠，预算耗尽停止，忽略优雅退出的进程被强制终止，不兼容协议明确失败。
- `apps/desktop/test/runtime-updater.test.mjs` 使用真实 SQLite 文件验证未确认 activation 回退：
  旧 Runtime pointer、schema 1 和原始 `persistent-user-data` 恢复，失败版本新增表消失；staged
  可执行文件只在下次启动激活。persistence suite 另验证 v1→v2 迁移、真实重开、新 schema 拒绝。
- 原生 smoke 在 darwin-arm64 生成并执行 Node SEA，重开同一 SQLite 文件、运行自包含 Python
  MCP，并完成 staged Runtime update smoke。

## 命令与门禁

环境：macOS arm64，Node 24.15.0，pnpm 11.22.0；临时目录和数据每次执行后清理。

| 命令 | revision | 结果 | 运行记录 |
| --- | --- | --- | --- |
| `node --test --test-timeout=5000 test/task-014-verification.test.mjs`（runtime-kit cwd） | `97a5c12` 对应测试树 | pass 4/4 | `1790071665124003000.json` |
| `node --test test/task-014-lifecycle-verification.test.mjs`（Runtime cwd） | `97a5c12` 对应测试树 | pass 1/1 | `1790071376767620000.json` |
| `pnpm --filter @yuanpu-agent/runtime-kit test && pnpm --filter @yuanpu-agent/runtime test && pnpm --filter @yuanpu-agent/desktop test` | `97a5c12` 对应测试树 | pass 80/80、7/7、12/12 | `1790071730135932000.json` |
| `pnpm check` | `97a5c12` | exit 0；build/typecheck/test 全通过，runtime-kit 80/80、Runtime 7/7、Desktop 12/12 | `1790071781806203000.json` |
| `pnpm build:native && pnpm smoke:native` | `97a5c12` | exit 0；darwin-arm64 SEA、Python artifact、SEA smoke、staged update smoke 通过 | `1790071825399750000.json` |

首次 focused 运行从错误 cwd 启动 Runtime 测试，以及在 Python `.venv` 准备前启动 MCP 测试，
均为验证 harness/environment 错误；改用各 package 原生入口并执行
`pnpm run prepare:python-capabilities` 后复测通过。新增测试早期断言问题也已修正并全量复测，
没有把这些验证脚本问题记为产品缺陷。

## 验收项映射与人工结论

| TASK-014 验收项 | 场景与证据 | 人工结论 |
| --- | --- | --- |
| 双身份/会话并发、重复、取消、审批退出重启，无串话和重复副作用 | LC-01～LC-05；两个新增组合测试、真实 SQLite/受控 effects/真实 Pi JSONL | pass |
| 父进程强杀、Runtime 崩溃、staged 更新失败及状态/数据库/进程证据 | LC-08～LC-12；Runtime parent-exit、RuntimeManager、RuntimeUpdater、persistence 与 native smoke | pass（macOS/fixture 边界） |
| 身份不可由模型伪造、审批不误复用、升级回退可读原数据 | LC-06、LC-07、LC-11；HTTP 403、跨 owner 不可见、approval binding/replay 拒绝、SQLite 原值恢复 | pass |
| revision、环境、模式、命令与缺平台证据完整 | 本文件、固定 revision 与运行记录；LC-13 明确列出缺口 | pass |
| 独立逐项映射；Jev 仅在通过采用门槛后辅助 | 本文件由非 TASK-012/013 实现者独立派生场景并人工确认；TASK-022 为 `do_not_adopt`，未调用 Jev | pass |
| `pnpm check` | 上表完整门禁 | pass |

人工结论：在 macOS arm64、可控本地 Provider/MCP fixture 环境中，本阶段要求的单机执行、
身份隔离、Pi 会话、SQLite 恢复和 App/Runtime 生命周期行为通过，未发现产品 blocker。
Linux 与 Windows 原生生命周期/ACL/进程组行为、真实模型 Provider、生产签名和真实 Electron UI
退出旅程未执行，保持 **UNVERIFIED**，不得由本卡外推为跨平台或生产通过。Python 制品只使用
ephemeral development trust root。分支验证通过不等于 main 已集成；集成后需在 main 重跑受影响
测试及规定门禁，随后才能完成任务卡。
