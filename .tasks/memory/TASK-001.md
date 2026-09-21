# 确认合并基线与回归（TASK-001）

- 关键词：runtime-kit、package consolidation、SEA、Pi upstream、baseline
- Owner：codex-yuanpu；记录日期：2026-09-21
- 源码基线：`badd659`；验证修订：`f40367d`（仅增加任务认领元数据）
- 入口：`packages/yuanpu-runtime/src/index.ts`、`apps/runtime/src/index.ts`、`pnpm-lock.yaml`

五个旧 Yuanpu 包已合并到 `@yuanpu-agent/runtime-kit`，Yuanpu 自有包只保留
`packages/yuanpu-runtime` 与 `packages/yuanpu-protocol`。未修改 Pi 上游镜像目录。
仓库范围精确搜索未发现旧 `@yuanpu-agent/core|mcp|mcp-contracts|pi-runtime|plugins`
引用；本会话无 ZG 工具，按仓库规则使用 scoped `rg`。

验证环境：macOS arm64、Node 24.15.0、pnpm 11.22.0。

- `pnpm check`：通过。
- `pnpm build:native`：通过。
- `pnpm smoke:native`：通过。

首次 `pnpm check` 因 worktree 缺少被 Git 忽略的 Pi 模型数据，联网访问 OpenRouter
超时；从同一仓库主工作区复用已生成的 `packages/ai/src/providers/data` 后重跑通过。
该目录仍保持忽略，不属于交付文件。Pi 上游 revision 或模型生成规则变化时需重查。
