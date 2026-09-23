# 隔离验证 Pi v0.87.1 内核同步（TASK-031）

- 关键词：Pi、0.87.1、上游镜像、Runtime 依赖、SEA、升级兼容
- Owner：`codex-d21sep23-12136-12136`；记录日期：2026-09-23；基线 main `66dbee8`，候选提交 `da8e488`，macOS arm64 / Node 24.15.0 / pnpm 11.22.0。
- 正式 Pi 来源由 `docs/pi-upstream.json` 记录；`scripts/sync-pi-packages.mjs` 只替换同步镜像、共享配置及版本记录，不更新 `packages/yuanpu-runtime/package.json` 的精确 Pi 依赖。要测试真实新版内核，候选树必须同步修改依赖，检查锁文件及安装链接；本候选链接到本地 `packages/coding-agent` 0.87.1。
- 另一处版本源是 `packages/yuanpu-runtime/src/pi/index.ts` 的 `PI_UPSTREAM_VERSION`；候选保持旧值 0.86.1，因此健康信息误报。正式升级应把它与上游记录统一，且更新相邻测试。
- 完整证据见 `.tasks/verification/TASK-031/results.md`。候选通过 Pi/Runtime 构建、Pi/Agent/调度/IM 聚焦测试、`pnpm check`、macOS SEA 构建/烟测、macOS 打包 App 的隔离四次启动探针。所有运行均为合成数据，无真实模型或企业微信调用。
- 主线未升级；`task/task-031-pi-0871-candidate` 专门保存未经集成的候选，不能当作发布分支。正式升级需单独授权，补版本元数据、目标平台和授权业务验收；生产签名仍是独立缺口。
- 检索：ZG 以 Pi 同步/Runtime 适配与版本关系查询，命中 `docs/pi-integration.md`；scoped `rg` 定位同步脚本、依赖 pin、`PI_UPSTREAM_VERSION` 和回归入口。
