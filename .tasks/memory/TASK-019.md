# 通知渠道与调度阶段验证（TASK-019）

- 关键词：阶段验证、企业微信、定时任务、系统通知、渠道投递、SQLite、HTTP 400
- Owner/验证者：`codex-t019sep23`；记录日期：2026-09-23；分支/工作树：`task/task-019-stage-verification` / `.worktrees/codex-task-019`
- 产品源码基线 `d8564c4`；验证脚本提交 `0fc2458`；结果见 `.tasks/verification/TASK-019/results.md`。当前阶段 **未通过**，卡片不得 complete。
- 验证材料快进并入本地 `main` 的 `04c5c0c`，集成后的 `pnpm check` 再次通过；产品缺口未修复。

## 入口与结论

- 同一真实 SQLite 的 `ChannelRouter`、`PersistentScheduler`、`PersistentAgentService`、`HostNotificationRouter` 组合验证位于 `packages/yuanpu-runtime/test/task-019-stage-verification.test.mjs`。两名已配对 IM sender 与到期计划并发，重复入站只执行一次；三个 run 分属隔离会话，原 `req_id` 回复与数据库 outbound/trigger 一致。伪造权限的正文没有改变可信 `channel_user` 身份。
- 真实 Runtime HTTP 复现位于 `apps/runtime/test/task-019-channel-delivery-probe.mjs`：`POST /v1/schedules` 带 `delivery.kind=channel` 返回 400 `Schedule delivery target is not authorized.`，列表仍为空。`apps/runtime/src/index.ts` 的 scheduler caller 只授权 desktop/none，且未装配渠道投递适配器。D19-01 阻断“定时任务向绑定 IM 投递”及其失败不重跑验收。
- 企业微信本机配置现为 1 条连接、0 启用、0 配对、0 凭据引用；TASK-017/018 旧机器人与 Secret 已撤销。真实 IM 收发、真实 Electron 展示/点击以及 Linux/Windows 均未验证。
- 用户提供新 Bot 变量于 `~/.yuanpu/app/connections/.env`，权限已改为 `0600`，值未输出。DNS/TLS 通过；原配置 SDK 1.0.7 单次鉴权返回 `853000`，用户核对并更新后，同一探针返回 `authenticated=true`。复跑入口为 `packages/yuanpu-runtime/test/task-019-wecom-auth-probe.mjs`。本机现仍未启用连接或写入 Keychain。
- 仅有一个获授权私聊测试会话，`WECOM_TEST_USER_ID` 尚未配置；`packages/yuanpu-runtime/test/task-019-wecom-live-probe.mjs` 用临时隔离连接、随机 challenge 与首次匹配后锁定 sender 的方式执行两轮。首轮确认发送时已超时；第二轮鉴权 ready 后用户确认发送，但 240 秒内 `inboundSeen=0`，无 Agent 执行或 outbound。原因未定，不能认定真实收发通过或产品缺陷。双会话仍缺第二成员。鉴权脚本提交 `6ce1d60` 的 `pnpm check` 已通过（runner `1790128038312650000.json`）；当前阻断项是 D19-01 以及真实 IM/Electron 业务证据。

## 检查与交接

- Node 24.15.0 / pnpm 11.22.0，隔离临时目录与 fixture。focused：runtime-kit 27/27、Runtime 5/5、Desktop 5/5；`pnpm check`：pass（runtime-kit 113/113、Runtime 14/14、Desktop 20/20）。API 探针按目标应为 201，实得 400，退出码 1。runner 记录编号和逐场景边界见 results.md。
- 工作树准备使用 `worktree-kit.py prepare/doctor/run`；安装按仓库命令加 `--ignore-pnpmfile`，不要使用 helper 的默认 frozen install；它会遇到 pnpmfile checksum 不匹配。
- 下一步：开发修复 D19-01 并在集成 revision 重跑 API 探针、渠道失败/未知组合与 `pnpm check`；先核对私聊是否连向该 API 模式机器人及后台长连接推送，再运行带脱敏 SDK 事件计数的单会话探针，第二成员到位后补齐双会话与真实 Electron 验收。不要把 fixture 通知 `submitted` 写成用户已看到。
- 检索：ZG 关系查询定位 `apps/runtime/src/index.ts`、`.tasks/tasks.yaml`、`docs/application-architecture.md`，再用 scoped `rg` 找到 scheduler 授权及相邻测试；未重建索引。
