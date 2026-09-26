# TASK-016 Memory

- Task: 实现持久化定时任务与结果投递（TASK-016）
- Keywords: PersistentScheduler, trigger outbox, revision key, IANA cron, misfire, delivery retry, result_unknown
- Owner: `sol-task016-owner-20260922-72012`; recorded 2026-09-22
- Branch/worktree: `task/task-016-persistent-scheduler` / `.worktrees/sol-task-016`
- Claim/source revision: `3284268`; implementation and tested revision: `1952f17`

`PersistentScheduler` in `packages/yuanpu-runtime/src/scheduler/service.ts` is the public seam for
create/update/enable/list/get/history, time scanning, Agent submission and delivery recovery. Runtime
assembles it in `apps/runtime/src/index.ts` and exposes authenticated `/v1/schedules` routes. Runtime
shutdown awaits `scheduler.close()` before closing AgentService, so no new trigger or delivery starts
after close; in-flight delivery receives an AbortSignal and remains `result_unknown` when uncertain.

Schema v3 adds `yp_schedules`, `yp_schedule_triggers`, and Scheduler-only
`yp_agent_run_outputs`. Trigger reservation and next-time advancement share one `BEGIN IMMEDIATE`
transaction. The trigger/idempotency key is `scheduleId:revision:scheduledAt`; a crash after Agent
admission but before run linkage safely replays the same key and obtains the original run. Submitted,
failed, and skipped trigger snapshots redact prompt text; the active schedule retains its configured
prompt, and completed Scheduler output is durable only for restart-safe delivery/history.

Cron uses five fields plus an explicit IANA time zone. Nonexistent DST wall times are skipped and the
first physical occurrence of a repeated wall minute wins. Default recovery coalesces to one eligible
occurrence, maximum lateness is capped at seven days, sparse out-of-window occurrences become
`skipped_misfire`, and default overlap prevention covers queued/running/waiting-approval runs.

Execution and delivery are separate facts. Failed/unknown Agent runs are never automatically
resubmitted. Desktop/none delivery completes locally; injected channel delivery retries at most three
times only when its adapter declares idempotency, always with the stored delivery key. A restart or
shutdown during `delivering` becomes `result_unknown`, not a false failure/success.

Verification at `1952f17` on macOS darwin-arm64, Node 24.15.0 / pnpm 11.22.0:

- Latest Scheduler focused suite: 8/8 passed; record `1790074820240829000.json`
- `pnpm check`: passed; runtime-kit 88/88, Runtime 7/7, Desktop 12/12; record `1790074982255404000.json`
- `pnpm build:native && pnpm smoke:native`: passed; record `1790075042673578000.json`
- Native smoke executed schema v3 and a scheduled Agent run, then reopened SQLite and verified output/history
- Independent Sol review at `1952f17`: PASS, no blocker/high/medium; reviewer reproduced the close race before its fix

ZG retrieval was unavailable; scoped `rg` covered TASK-016/dependency memory, architecture/contracts,
AgentService/persistence/Runtime assembly and tests. No index was created.

Limits: Runtime currently authorizes desktop/none targets; a real channel adapter and live delivery
belong to its channel task. Linux/Windows packaged scheduling, production signing, live model Provider,
and multi-day real sleep/DST passage remain unverified; deterministic clock, real SQLite restart and
darwin SEA evidence cover the implemented behavior. Product-configurable history retention remains a
follow-up and must delete trigger/output/delivery rows consistently without weakening recovery.
