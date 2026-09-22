# TASK-014 Memory

- Task: 本机执行与生命周期阶段验证（TASK-014）
- Keywords: Runtime API, Pi session, SQLite, identity isolation, approval replay, parent exit, update rollback
- Owner: `sol-verifier-task-014-20260922-72012`; recorded 2026-09-22
- Branch/worktree: `task/task-014-lifecycle-verification` / `.worktrees/sol-task-014`
- Product baseline: `8abf297`; claim: `fb8e2f3`; tests and final gates: `97a5c12`

Independent scenarios were derived from `docs/application-architecture.md` sections 5/6/10/11/14,
`docs/agent-runtime-contracts.md`, the data-boundary ADR and TASK-011/012/013/014 before inspecting
implementation tests. ZG was unavailable; scoped exact lookup covered the task cards, agent/persistence/
Pi/approval seams, Runtime HTTP and process lifecycle, RuntimeManager/Updater and adjacent tests.

Reusable verification entry points:

- `packages/yuanpu-runtime/test/task-014-verification.test.mjs`: real-file SQLite checks for two
  concurrent identities/Pi bindings, idempotent controlled effects, queued/running cancellation and
  approval invalidation/no replay after restart.
- `apps/runtime/test/task-014-lifecycle-verification.test.mjs`: real Runtime HTTP process + Pi sessions
  + SQLite + loopback OpenAI-compatible fixture; proves two concurrent conversation transcripts,
  deduplication, spoofed identity rejection and clean SIGTERM.
- Existing process/update evidence: `apps/runtime/test/runtime-parent-exit.test.mjs`,
  `apps/desktop/test/{runtime-manager,runtime-updater}.test.mjs`, and persistence/approval suites.

Observed invariants: different owners cannot get/cancel each other's run; duplicate admission does not
repeat the controlled effect; cancelled queued input is deleted; running cancellation preserves the
possible-effect warning; waiting approval becomes result_unknown on shutdown, its approval is cancelled,
and restart performs zero executions; parent loss removes Runtime/MCP descendants; failed activation
restores the prior Runtime pointer, schema and original SQLite data.

Verification at `97a5c12` on macOS arm64, Node 24.15.0 / pnpm 11.22.0:

- focused task tests: runtime-kit 4/4 and Runtime API 1/1 passed
- affected package suites: runtime-kit 80/80, Runtime 7/7, Desktop 12/12 passed
- `pnpm check`: passed; record `1790071781806203000.json`
- `pnpm build:native && pnpm smoke:native`: passed; record `1790071825399750000.json`
- detailed sanitized scenario mapping: `.tasks/verification/TASK-014/results.md`

TASK-022 remains `do_not_adopt`; no project evidence was sent to TypeSafe and all conclusions were
made manually. Initial wrong-cwd/missing-venv and test-assertion failures were harness issues corrected
without product changes, followed by full reruns.

Limits: Linux/Windows native lifecycle, Windows ACL/taskkill behavior, real model Provider, production
signing and a live Electron UI quit journey remain UNVERIFIED. The Python artifact used an ephemeral
development trust root. Evidence-only edits after `97a5c12` do not change the tested tree. The branch is
verified but not merged, completed or pushed; integration must rerun affected tests and required gates
on main before recording completion.
