# Agent execution and host event contracts

Status: contract baseline for TASK-011. Implementation of the multi-session service and its HTTP
transport belongs to TASK-012. This document records the boundary that those implementations must
follow; a type or table declaration is not evidence that a live provider exists.

## Compatibility boundary

- `PROTOCOL_VERSION` remains 3. The existing authenticated `POST /v1/chat` request and
  `ChatResponse` are unchanged and remain the desktop compatibility path.
- The additive execution DTOs use `AGENT_CONTRACT_VERSION = 1`; host events independently use
  `HOST_EVENT_CONTRACT_VERSION = 1`. Consumers reject unknown versions with an observable error.
- No AgentService HTTP route or host-event transport is advertised by TASK-011. TASK-012 and
  TASK-015 must add routes only when their providers are live and tested. A transport must carry the
  contract version and preserve the rejection/result shapes in `@yuanpu-agent/protocol`.
- A future incompatible change increments the affected contract version. Additive optional fields
  may retain the version only when old consumers can safely ignore them. Runtime update manifests
  continue to use the existing exact desktop/Runtime protocol check until a separately tested
  negotiation mechanism replaces it.

## Request identity and ownership

`AgentRunRequest` keeps three trust domains separate:

1. `identity` is authenticated by the host. Desktop uses Electron's local principal, IM uses the
   authenticated channel adapter and connection, and Scheduler uses its local service identity.
2. `conversation` is a host-owned routing reference. An optional `sessionBindingId` represents an
   explicit persisted mapping to a Pi session; message text cannot select or forge that binding.
3. `input` is model input. It is untrusted content and never supplies identity, authority, workspace,
   approval, or delivery routing facts.

The validation code rejects an entry-point/identity-authenticator mismatch. Workspace access and
available tools remain policy decisions made after validation; accepting a DTO does not authorize
filesystem, network, credential, notification, or background access.

An idempotency key is unique within `(entryPoint, identity.authorityId)`. The stored request
fingerprint covers the normalized complete request. Repeating the same key and fingerprint returns
the original `runId` and current status with `duplicate: true`. Reusing a key for changed input,
identity, conversation, workspace, or delivery produces `idempotency_conflict`; it never starts a
second run.

## Run lifecycle

The only run statuses are:

| Current | Event | Next |
| --- | --- | --- |
| `queued` | start | `running` |
| `queued` | cancellation observed | `cancelled` |
| `queued` | shutdown before safe persistence | `interrupted` |
| `running` | approval required | `waiting_approval` |
| `waiting_approval` | approval granted after revalidation | `running` |
| `running` | success / failure | `succeeded` / `failed` |
| `running`, `waiting_approval` | cancellation observed | `cancelled` |
| `running`, `waiting_approval` | restart, no possible external effect | `interrupted` |
| `running`, `waiting_approval` | restart after possible external effect | `result_unknown` |

Terminal states are `succeeded`, `failed`, `cancelled`, `interrupted`, and `result_unknown`.
Transitions out of a terminal state are rejected. Recovery may create a new run with a new
idempotency key after an explicit user/service decision; it does not mutate an uncertain run back
to queued.

Cancelling a queued run synchronously records `cancelled`. Cancelling a running or approval-waiting
run returns `cancellation_requested`; it becomes `cancelled` only after the worker observes the
signal and stops. Cancellation does not undo tool or remote side effects that already occurred.
Unknown run ids and already-terminal runs have distinct receipts.

After Runtime restart, safely persisted queued work may remain queued. Active work is never claimed
as successful: it becomes `interrupted` when no external effect could have happened, otherwise
`result_unknown`. Approval-waiting runs are interrupted and must revalidate execution context and
authorization before any newly submitted continuation. Consumed one-time approvals are not replayed.

## Delivery and host events

Agent completion and result delivery are separate facts. Delivery moves from `pending` to
`delivering`, then to `delivered` or `failed`. A restart while `delivering` produces
`result_unknown`; downstream retry requires the stored delivery idempotency key and adapter-specific
support. Agent success alone must not be presented as successful channel delivery.

Host events are versioned envelopes with stable `eventId`, per-process `sequence`, and timestamp.
Hosts deduplicate by `eventId`; reconnect may replay events. The initial event union is run-state
change and notification request. Receipts distinguish accepted, duplicate, unsupported, and rejected.

Notification handling reports `submitted`, `suppressed`, `unavailable`, or `failed`, always with
`userVisibility: unknown`. OS submission is not proof that a person saw or read a notification.
Notification targets contain only host-validated conversation/run ids; they are not arbitrary URLs
or commands.

## SQLite ownership and migration

Yuanpu workflow metadata lives in `~/.yuanpu/workflows/automation.sqlite`. It is separate from Pi's
session store: Pi owns conversation content, while Yuanpu owns external conversation bindings, run
metadata, deduplication, and delivery state. The Runtime is the single writer.

Schema version 1 is managed by `packages/yuanpu-runtime/src/persistence/index.ts` using Node 24's
built-in `node:sqlite` driver:

| Table | Owner and purpose |
| --- | --- |
| `yp_schema_migrations` | persistence module; ordered applied versions |
| `yp_runtime_metadata` | persistence module; small Runtime metadata/probes |
| `yp_conversation_bindings` | AgentService; external-to-Pi session mapping only |
| `yp_agent_runs` | AgentService; normalized request fingerprint, status, output/failure |
| `yp_delivery_attempts` | delivery adapters; delivery state independent of execution |
| `yp_inbound_deduplication` | channel ingress; authenticated source message deduplication |

Migrations run in `BEGIN IMMEDIATE` transactions, are forward-only and additive, and refuse a schema
newer than the running Runtime. Rollback of a Runtime binary therefore does not imply database
rollback. An incompatible/destructive migration requires a separate backup and recovery design.
Tests use real files, including migration over a pre-existing fixture. The native smoke executes the
actual SEA twice against the same file and verifies a persisted counter after close/reopen; Node
development mode alone is not accepted as driver compatibility evidence.

## Deliberately unresolved product boundaries

- “Full access” has no expanded meaning in this contract. Existing Pi tool availability and current
  Yuanpu capability approval behavior remain unchanged. In particular, model input and remote
  channel content cannot modify their own permissions or approve pending work.
- Closing the last window keeps today's platform behavior: non-macOS quits the App; macOS may remain
  active under Electron's current lifecycle. No tray/background promise is added. An explicit App
  quit must stop Runtime and managed child processes; process-lifecycle hardening is TASK-013.
- The first IM platform and its verified identity environment remain a TASK-017 decision. Generic
  `im` contracts do not claim any platform SDK or live message support.

