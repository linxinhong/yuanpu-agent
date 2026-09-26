# IM 渠道与调度阶段验证（TASK-019）

- 关键词：阶段验证、企业微信、定时任务、系统通知、渠道投递、SQLite、HTTP 400
- Owner/验证者：`codex-t019sep23`；记录日期：2026-09-23；分支/工作树：`task/task-019-stage-verification` / `.worktrees/codex-task-019`
- 历史源码基线 `d8564c4`、验证脚本 `0fc2458`；2026-09-23 接管后同步到 `bcbb4ea`（含 TASK-026），最终非通知验收补测于集成 `main` `3a6f4cf`。结果见 `.tasks/verification/TASK-019/results.md`；修订后的阶段验收通过，原生通知仍未验证并转 TASK-029。
- 历史验证材料曾并入 `main` 的 `04c5c0c`；下述 D19-01 和 HTTP 400 为修复前观测，当前结论以接管更新及 results.md 增量判定为准。

## 历史基线与入口

- 同一真实 SQLite 的 `ChannelRouter`、`PersistentScheduler`、`PersistentAgentService`、`HostNotificationRouter` 组合验证位于 `packages/yuanpu-runtime/test/task-019-stage-verification.test.mjs`。两名已配对 IM sender 与到期计划并发，重复入站只执行一次；三个 run 分属隔离会话，原 `req_id` 回复与数据库 outbound/trigger 一致。伪造权限的正文没有改变可信 `channel_user` 身份。
- 修复前真实 Runtime HTTP 复现位于 `apps/runtime/test/task-019-channel-delivery-probe.mjs`：`POST /v1/schedules` 带 `delivery.kind=channel` 返回 400 `Schedule delivery target is not authorized.`，列表仍为空。当时 `apps/runtime/src/index.ts` 的 scheduler caller 只授权 desktop/none，且未装配渠道投递适配器；D19-01 后由 TASK-026 修复并复测。
- 企业微信本机配置现为 1 条连接、0 启用、0 配对、0 凭据引用；TASK-017/018 旧机器人与 Secret 已撤销。隔离探针已验证一名获授权成员的真实私聊收发；真实 Electron 展示/点击以及 Linux/Windows 均未验证。
- 用户提供新 Bot 变量于 `~/.yuanpu/app/connections/.env`，权限已改为 `0600`，值未输出。DNS/TLS 通过；原配置 SDK 1.0.7 单次鉴权返回 `853000`，用户核对并更新后，同一探针返回 `authenticated=true`。复跑入口为 `packages/yuanpu-runtime/test/task-019-wecom-auth-probe.mjs`。本机现仍未启用连接或写入 Keychain。
- 仅有一个获授权私聊测试会话，`WECOM_TEST_USER_ID` 尚未配置；`packages/yuanpu-runtime/test/task-019-wecom-live-probe.mjs` 用临时隔离连接、随机 challenge 与首次匹配后锁定 sender 的方式试收。前三轮历史尝试未见入站；第四轮 ready 后用户发送 challenge，脱敏事实为一条私聊入站、一次 Agent 执行、一次 outbound `accepted` 与 SDK `reply_ack`，用户明确确认在企业微信看到了固定回复。单会话端到端收发已通过；重复消息和故障恢复仍未验证。2026-09-23 用户明确个人助手只需自己与机器人真实私聊，第二名真人/真实双会话不再是门槛；历史双 sender fixture 仍用于隔离回归。成功探针残留进程已按 PID 停止，脚本已修正未清理的超时计时器。鉴权脚本提交 `6ce1d60` 的 `pnpm check` 已通过（runner `1790128038312650000.json`）；当前阻断项是 D19-01、其余 IM 场景以及真实 Electron 业务证据。

## 检查与交接

- Node 24.15.0 / pnpm 11.22.0，隔离临时目录与 fixture。focused：runtime-kit 27/27、Runtime 5/5、Desktop 5/5；`pnpm check`：pass（runtime-kit 113/113、Runtime 14/14、Desktop 20/20）。API 探针按目标应为 201，实得 400，退出码 1。runner 记录编号和逐场景边界见 results.md。
- 工作树准备使用 `worktree-kit.py prepare/doctor/run`；安装按仓库命令加 `--ignore-pnpmfile`，不要使用 helper 的默认 frozen install；它会遇到 pnpmfile checksum 不匹配。
- 下一步：`补齐计划到已绑定 IM 的投递（TASK-026）` 修复 D19-01；集成后重跑 API 探针、渠道失败/未知组合与 `pnpm check`。用户已确认后台是长连接；其给的官方 path/100719 与 path/101039 均描述 HTTP 回调，长连接规范是 path/101463。该规范限定每机器人同时一条有效连接；第四轮真实探针已收到应用消息并从入站 sender 路由回复，不需预配置 `WECOM_TEST_USER_ID` 才能接收。用同一授权用户补齐去重、断线/重启、正式 App 连接及真实 Electron 验收；不要求第二成员。不要把 fixture 通知 `submitted` 写成用户已看到。
- 检索：ZG 关系查询定位 `apps/runtime/src/index.ts`、`.tasks/tasks.yaml`、`docs/application-architecture.md`，再用 scoped `rg` 找到 scheduler 授权及相邻测试；未重建索引。

## 2026-09-23 接管更新

- TASK-026 已完成，`apps/runtime/src/scheduled-im-delivery.ts` 经显式绑定后授权计划目标，`ScheduleHistoryRecord` 分列 IM/通知状态。`bcbb4ea` 上 `pnpm build:runtime` PASS（`1790139225579356000.json`），TASK-019 组合及 channel/scheduler/notification/persistence/Runtime 绑定投递 focused PASS（`1790139247012214000.json`）。D19-01 旧探针仍提交任意 route，预期 400，不能再用作成功判据。
- 新增 `packages/yuanpu-runtime/test/task-019-wecom-scheduled-live-probe.mjs`：通过 `.env` 变量而非读取/输出值，真实私聊挑战命中后才观察成员、绑定临时目标并主动投递。第一轮 SDK authenticated，但 180 秒内无入站，用户未确认在窗口内发送；判定环境未完成，不是产品失败。进程与临时 SQLite 已清理。
- `pnpm check` 在本轮工作树与 `bcbb4ea` 基线上通过（Node 24.15.0，runner `1790139710927758000.json`）；验证脚本与证据改动不代表真实业务已通过。
- 隔离 `YUANPU_HOME` 的开发版 Electron 已启动，但 Computer Use 读取窗口连续超时，未触发运行或通知；V19-07 保持未验证。开发进程和临时家目录已清理，用户配置未动；勿将 UI 自动化超时当作系统通知失败。
- 后续先在探针 ready 后请同一获授权用户发当轮新口令，并确认两条消息可见；再测正式 App 连接、退出/重启、真实 Electron 通知展示与点击。未覆盖前不得 complete。旧验证脚本和事实保留作为历史，不把 fixture `submitted` 当作用户可见。
- 检索：本轮 ZG 针对 TASK-019/TASK-026 的 Runtime、绑定私聊与通知关系返回 fresh，随后 scoped `rg` 核对 `scheduled-im-delivery.ts`、SDK 适配和相邻测试；未建索引。
- 本轮重新 ready 后收到同一授权用户的随机私聊口令：一次入站、两次 Agent 执行与两条持久 run，定时主动发送平台回执 `accepted`、计划 `delivered`；用户确认在企业微信看到两条机器人消息。V19-02 的真实单用户主动投递已通过。探针曾在即时回复 outbound 仍为 `delivering` 时过早取快照而退出 1；SDK 已有 reply ack，且用户看到两条，故不记产品失败。脚本现增加 15 秒有界等待，修正本身尚未再次实发验证。正式 App 连接、重启组合和真实 Electron 通知展示/点击仍未验收，TASK-019 保持 in_progress。
- `main` `1564bf8` 的正式 Electron 窗口已见 Runtime 连接。现有企业微信配置仍禁用/0 配对；新 Bot Secret 已通过变量不回显地写入专用 Keychain，进程内比对可读且一致。正式 App 配对探针首轮已鉴权 ready，但 180 秒未见入站，用户未确认发出本轮口令；没有启用连接或产生配置备份。待用户方便时重新生成口令，收到认证 sender 后仅保存连接作用域摘要并启用，再重启正式 App。虚拟 Keychain 测试项已删除；凭据及 raw userid 未输出。TASK-019 仍 in_progress。
- 用户答复方便后再开第二轮新口令，SDK ready 但 180 秒 `inboundSeen=0`；仍无实际发送确认。连接未启用、无配对和备份。探针现增加脱敏 SDK 事件计数与 `isReady()` 诊断，待下一轮试收；旧口令不可复用。TASK-019 不得据此判定平台失败或完成。
- 第三轮 ready 后用户确认发出新口令；探针收到一条精确私聊消息并保存一个配对摘要，启用本机连接，沿用已验证的 Keychain 凭据。原配置备份在 `~/.yuanpu/app/connections/wecom.json.task019-before-pairing.bak`；只用环境变量与 Keychain 进程内比对，不输出值、userid 或正文。
- 首次启用连接的正式 App 被 Runtime `console.info` 在 JSON ready 前污染 stdout 阻断。独立 TASK-028 已于 `main` `3563d1d` 完成：企业微信脱敏诊断改走 stderr，focused 与完整 `pnpm check` 通过。随后本机正式 Electron 窗口显示“本地 Runtime 已连接”，App 保持运行；此时业务库仍无正式入站、outbound 或 run，已请用户发新的普通测试消息。不要把 App 已打开当作正式私聊业务通过；页面提示模型/密钥尚待配置，若后续 Agent 失败需区分于长连接入站。
- 正式 App 在 `main` `3b9e23f` 收到同一配对私聊的两条不同平台消息；只读 SQLite 关系查询证实两条各执行一次 `im` Agent run（均 `succeeded`），两条 outbound 均 `accepted` 且无失败码。用户确认至少一条回复在企业微信可见。V19-06 单用户正式 App 收发通过；两条消息不是重复回调，不能据此证明平台重放去重。未读取正文、原始 userid、摘要或密钥。TASK-019 仍需 App 重启恢复与真实原生通知展示/点击，保持 in_progress。
- SIGINT 正常关闭后 Runtime 与开发端口均消失，SQLite 两条记录保留；同一 App 重开显示 Runtime 已连接。第三条不同平台私聊消息在重启后入站，新增一次成功 run 与 `accepted` outbound，累计三条消息/三次 run，仍是同一认证 sender 与会话；用户可见性尚待确认。执行中断/等待授权恢复及原生通知显示/点击未覆盖，不能 complete。
- 用户确认“重启后已回复”，补齐至少一条重启后私聊回复的可见性；随后只读库中累计四条不同平台消息、四个成功 IM run、四条 `accepted` outbound，同一 sender/会话。正常退出/重启、持久记录、重连收发已通过；执行中关闭与系统通知用户可见性仍待验收。
- 新增隔离真实 Runtime HTTP/SQLite 的运行中退出测试：模型服务悬停时 SIGTERM，持久 run 为 `result_unknown`/`possible`；重开 Runtime 可查询且不重跑模型。focused 与完整 `pnpm check` 通过（runner `1790154133738838000.json`、`1790154280381299000.json`）。这是受控 Runtime 验证，不是用户真实 IM 运行中断的现场证据。
- 第五条真实私聊 run 与回复都成功，但用户没看到 macOS 通知。开发版 Electron 为 ad-hoc 签名且严格校验失败；同二进制原生通知探针返回 `supported=true, failed_event`。Electron 官方文档要求 macOS 通知使用有效签名，因此需签名包再验证展示与点击；当前原因属高概率环境推断，不冒称已证明正式 App 宿主回执。TASK-019 仍 in_progress。
- 用户确认目前没有 macOS 签名证书；仓库旧打包产物同为 ad-hoc 签名且已过时。V19-07 继续标为缺环境的 `unverified`，不请求密钥、不创建证书、不把开发版通知失败扩大为签名版产品失败。待未来取得有效签名的当前 App，再用同一私聊 run 检查原生展示、点击目标与宿主回执。
- 用户决定本阶段忽略通知功能，后续再处理。`docs/adr/0003-defer-native-notifications.md` 将原生通知展示/点击和提醒界面移交 TASK-029；TASK-019/020/021 的完成条件相应移除通知门槛。保留以上 V19-07 原始结果和已有代码，不声称功能已通过或主动关闭。TASK-019 仍为 `in_progress`；先复核真实 App 运行中退出、重复回调与既有 fixture 的覆盖边界，不能只因通知暂缓就标 complete。本次 ZG 关系检索定位 `.tasks/tasks.yaml`、`docs/application-architecture.md` 和 TASK-019 验证记录；修订后的卡片以 `tasks validate` 校验。
- 集成 `main` `3a6f4cf` 的隔离 Electron 探针从真实 `main.cjs`/preload IPC 提交悬停模型请求，App 正常退出后 Runtime 子进程消失；重开同一隔离 App，原 run 可查为 `result_unknown` / `possible` 且模型请求总数保持 1，再次退出也无残留。探针位于 `apps/desktop/test/task-019-electron-app-probe.mjs`，最小 renderer 只调用正式 preload；临时 App/Home/SQLite 全部清理，未碰用户的在运 App 或机器人。工作树和集成 main 各执行一次均 PASS；main 上 Node 24.15.0/pnpm 11.22.0 `pnpm check` PASS（Runtime 22/22、Desktop 20/20）。受控 App 旅程与既有单人真实 IM、调度主动投递、正常重启、权限/去重/等待授权/投递状态 fixture 合并满足修订后的 TASK-019；不宣称用户真实 IM 消息恰在执行中被关闭或原生通知可见。下一步用现有任务 CLI `preflight`/`complete` 核对、结卡，解锁 TASK-020。
