# TASK-013 Memory

- Task: 完善 App 进程生命周期与升级恢复（TASK-013）
- Keywords: RuntimeManager, parent monitor, bounded shutdown, restart budget, staged activation, SQLite snapshot, MCP process group
- Owner: `sol-owner-task-013-94721-72012`; recorded 2026-09-22
- Branch/worktree: `task/task-013-app-lifecycle` / `.worktrees/sol-task-013`
- Claim/source revision: `d17a3fd`; implementation and tested revision: `e3e887f`

Desktop assembly is in `apps/desktop/src/main.ts`; `RuntimeManager` in
`apps/desktop/src/runtime-manager.ts` is the single owner of Runtime start, readiness, restart, and
bounded stop. Concurrent starts share one promise; an explicit stop also closes a child that appears
after an in-flight spawn. POSIX uses a detached process group and SIGTERM→SIGKILL; Windows uses
`taskkill /T /F`. Electron enforces a single instance and waits for bounded Runtime cleanup on quit.

Runtime bootstrap requires `parentPid`. `apps/runtime/src/process-lifecycle.ts` installs the parent
monitor before `listen`, including the parent-before-ready case. Runtime shutdown rejects new work
with 503, drains the server, closes MCP/direct sessions, and has an absolute hard-exit bound.
`ManagedMcpCapabilitySource.close()` can interrupt initialization and closes the published transport;
the Windows supervisor write await has a second closing check before transport creation.

`RuntimeUpdater.prepareActivation` switches only the next App start. It atomically records the prior
Runtime and snapshots the actual `~/.yuanpu/workflows/automation.sqlite` plus present WAL/SHM files.
A two-second stable process confirms activation; an unconfirmed activation is rolled back on the next
start, restoring both the previous Runtime pointer and database snapshot without replacing Yuanpu home.
Protocol/version incompatibility fails startup explicitly; no live binary switch is attempted.

Integration trap with TASK-012: both branches change `apps/runtime/src/index.ts`. Do not take either
shutdown block wholesale. Preserve TASK-012 `agentService.close()` and `metadata.close()`, then compose
TASK-013's pre-listen parent monitor, 503 shutdown gate, bounded server drain/hard exit, and MCP cleanup.
TASK-013 deliberately did not edit TASK-012's AgentService or persistence ownership.

Verification at `e3e887f` on macOS darwin-arm64, Node 24.15.0 / pnpm 11.22.0:
- `pnpm check`: passed; desktop 12/12, Runtime app 6/6, runtime-kit 61/61; record `1790067223916375000.json`
- `pnpm build:native`: passed; record `1790067267215583000.json`
- `pnpm smoke:native`: frozen Python MCP, SEA, and staged Runtime update passed; record `1790067329883169000.json`
- real lifecycle test killed the parent and observed Runtime, MCP root, and MCP descendant all exit
- updater rollback test simulated a failed v2 migration and restored the v1 schema and original data
- independent Sol review: PASS; all original blocker/high findings cleared at `e3e887f`

The Python artifact smoke uses an ephemeral development trust root; production publishing/signing was
not authorized. Linux/Windows packaged behavior, Windows taskkill/Job Object and ACL behavior, a live
Electron quit flow, and an explicit WAL/SHM fixture remain unverified platform/integration risks.

ZG retrieval was unavailable; scoped `rg` covered the task/dependency cards, Runtime/desktop lifecycle,
updater, MCP source, and contract callers. No index was created. This branch is verified but intentionally
not merged, pushed, or marked complete; main integration must rerun gates after resolving TASK-012.
