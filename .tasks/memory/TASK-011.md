# TASK-011 Memory

- Task: 固定多入口执行与宿主事件契约（TASK-011）
- Keywords: AgentService, authenticated caller, idempotency, result_unknown, host events, node:sqlite, SEA
- Owner: `sol-owner-task-011-72012`; recorded 2026-09-22
- Branch/worktree: `task/task-011-agent-contracts` / `.worktrees/sol-task-011`
- Claim/source revision: `15a8cbe`; implementation and tested revision: `c2fb4a9`

Public DTOs are in `packages/yuanpu-protocol/src/{agent,host-events}.ts`.
Behavioral seams are `AuthenticatedAgentCaller`, `AgentService`,
`validateAgentRunRequest`, `canCallerAccessAgentRun`, the run/delivery transition helpers, and
restart recovery in `packages/yuanpu-runtime/src/agent/contracts.ts`.
Durable records contain owner/context/digests, not full model input/output. The legacy
`POST /v1/chat` route remains unchanged; no AgentService/host-event route is advertised yet.

Identity is injected separately by a trusted host and must exactly match the request. Workspace,
conversation/session binding, delivery route, and later get/cancel/subscribe access are checked by
host-owned caller policy. Idempotency is scoped by entry point + authority + subject; same key with a
different fingerprint is a conflict.

Approval bindings now optionally include `runId`; `CapabilityApprovalStore.cancelRun` invalidates only
that run. SQLite requires a complete approval binding for `waiting_approval`, persists the external
effect checkpoint used for restart classification, and permits unknown delivery retry only through
the explicit idempotent retry event.

Persistence entry: `openYuanpuMetadataDatabase` in
`packages/yuanpu-runtime/src/persistence/index.ts`. Schema v1 owns only `yp_*` tables in
`~/.yuanpu/workflows/automation.sqlite`; composite foreign keys reject cross-subject run/binding and
dedup/run references. POSIX workflow/database permissions are 0700/0600. Final-path symlinks are
rejected, but this is not a race-proof filesystem sandbox.

Verification at `c2fb4a9` on macOS darwin-arm64, Node 24.15.0 / pnpm 11.22.0:
- focused contract, persistence, and capability tests: passed
- `pnpm check`: passed; record `1790063329591562000.json`
- `pnpm build:native && pnpm smoke:native`: passed; record `1790063364158732000.json`
- actual SEA opened the same SQLite file twice and asserted persisted count 1 then 2 after reopen
- independent Sol security/contract review: no remaining blocker after 5 high + 2 medium repairs

ZG retrieval was unavailable; scoped `rg` covered protocol/runtime/desktop symbols, task IDs, Pi
SessionManager/approval boundaries, and exact affected callers. No index was created.

Remaining: integration and verification on main are intentionally not done. Linux/Windows SEA and
Windows ACL behavior remain unverified; TASK-012 must implement the service/provider and TASK-013/015
must consume these lifecycle/event contracts without introducing parallel state machines.
