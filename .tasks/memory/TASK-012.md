# TASK-012 Memory

- Task: 实现多会话与持久任务执行（TASK-012）
- Keywords: PersistentAgentService, durable queue, Pi sessions, approval ownership, cancellation, restart recovery
- Owner: `sol-owner-task-012-92584-72012`; recorded 2026-09-22
- Branch/worktree: `task/task-012-multi-session` / `.worktrees/sol-task-012`
- Claim/source revision: `d6895ed`; implementation and tested revision: `8de9c79`

`PersistentAgentService` in `packages/yuanpu-runtime/src/agent/service.ts` is the single run
coordinator. It validates trusted callers through the TASK-011 contract, persists submissions before
dispatch, bounds the durable queue, serializes each conversation binding, and limits execution across
bindings. The Runtime exposes async submit/get/cancel under `/v1/agent/runs`; legacy `POST /v1/chat`
submits through the same service and waits on its run subscription.

`AgentRunStore` owns durable run/binding/queue transitions. Full model input exists only in
`yp_agent_run_queue_payloads` while a run is queued and is deleted atomically on claim/cancel. Exact
idempotent replay returns the original run; conflicting reuse is rejected. Schema v2 cannot recover
queued input created by schema v1, so migration explicitly marks those legacy rows `interrupted`
instead of hiding them or exhausting queue capacity. Claimed work uses the external-effect checkpoint:
runtime shutdown/restart records `result_unknown` and never automatically reruns it, while queued work
remains resumable.

Conversation bindings include owner, workspace, namespace, conversation, and thread. An explicit
binding must match all of them. Pi sessions persist below the existing sessions path and reopen by the
binding's Pi session ID. Runtime keeps an LRU-bounded pool of 16 idle/reusable sessions; retired
sessions are disposed and can later reopen from Pi persistence.

Approval execution has an atomic per-request owner signal. Concurrent signed decisions have one
winner, approved capability calls consume the global execution limit, and denial does not wait for an
execution slot. Waiting approval retains the conversation binding; cancellation, denial, expiry, and
shutdown terminalize the matching run, invalidate its pending approval, release the binding, and wake
queued work. Service shutdown also wakes queued `/v1/chat` subscribers before HTTP server close.

Verification at `8de9c79` on macOS darwin-arm64, Node 24.15.0 / pnpm 11.22.0:
- focused Agent/persistence tests: 19 passed; record `1790067577397989000.json`
- Runtime HTTP tests: passed; record `1790067249094428000.json`
- `pnpm check`: passed; record `1790067609518060000.json`
- `pnpm build:native`: passed; record `1790067644487746000.json`
- `pnpm smoke:native`: passed; record `1790067661360483000.json`
- actual SEA exercised schema-v2 SQLite reopen, frozen Python MCP, and staged Runtime update
- independent Sol contract review at `8de9c79`: passed with no blocker/high/medium finding;
  reviewer independently ran Runtime Kit 74/74 and Runtime 3/3 tests

ZG retrieval was unavailable; scoped `rg` covered the task cards, runtime contracts, Agent/Pi/
approval/persistence seams, and affected HTTP callers. No index was created.

Remaining: integration and verification on main are intentionally not done. Linux/Windows native
execution, Windows ACL behavior, production signing, and live model-provider execution remain
unverified. App exit still stops Runtime as required; no background service was introduced.
The bounded Pi-session LRU is source-reviewed but has no dedicated unit seam/test; a focused
eviction/disposal regression is a reasonable follow-up, not a TASK-012 blocker.
