# 固定能力与制品公共契约（TASK-002）

- 关键词：capability-contract、MCP、JSON-Schema、artifact-manifest、opaque-id
- Owner：codex-yuanpu；记录日期：2026-09-21
- 实现与验证修订：`2f3761f`
- 依赖：确认合并基线与回归（TASK-001）

公共入口位于 `packages/yuanpu-runtime/src/capabilities/contracts.ts`，路由与校验位于
`src/capabilities/index.ts`。`createCapabilityId` 用 source instance 与原始工具名的
base64url 分段生成不透明 ID，重复 source instance 在装配时拒绝。

输入采用 MCP 默认 JSON Schema 2020-12，由 Ajv 2020 在派发前校验。执行结果使用 MCP
SDK 的 `CallToolResult` 类型，保留 content、structuredContent、isError；Pi 只直接传递
text/image，其他块以明确提示降级且完整结果仍保留在 details。

`approvalRequestId` 只是待审批记录引用，不能授权。敏感能力在 TASK-003 前始终返回
needs_approval。制品 DTO 位于 `packages/yuanpu-protocol/src/index.ts`，区分
`pi-extension` 与 `python-mcp`，声明平台制品、兼容范围和 Ed25519 元数据签名。

验证环境：macOS arm64、Node 24.15.0、pnpm 11.22.0。

- runtime-kit build + 19 tests：通过。
- runtime-kit typecheck：通过。
- `pnpm check`：通过。

一次 focused test 暴露中文检索仅按分词精确匹配，已改为允许描述 token 包含查询并回归。
一次全量 typecheck 暴露 Pi 内容块联合类型推断错误，改为显式 AgentToolResult 后通过。
若升级 MCP SDK/Ajv、修改 source identity 或扩展 Pi 内容类型，需重查此契约。
