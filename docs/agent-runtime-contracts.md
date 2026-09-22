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

The Runtime service receives an `AuthenticatedAgentCaller` separately from the untrusted request.
Electron, a channel adapter, or Scheduler constructs that caller; model/message content cannot.
Validation requires exact entry-point and identity equality, then calls host-owned policies for the
workspace, conversation/binding, and delivery route. `submit`, `get`, `cancel`, and `subscribe` all
require the caller context; implementations must compare it with the stored run owner before
returning data or acting. Accepting a DTO does not authorize filesystem, network, credential,
notification, or background access.

An idempotency key is unique within `(entryPoint, identity.authorityId, identity.subjectId)`. The stored request
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

Before any external dispatch, AgentService must atomically persist
`externalEffectState = possible`; recovery reads this persisted checkpoint rather than an in-memory
guess. After Runtime restart, safely persisted queued work may remain queued. Active work is never
claimed as successful: it becomes `interrupted` while its persisted checkpoint is `none`, otherwise
`result_unknown`. A run that reached approval after earlier effects can therefore also be unknown.
Approval-waiting runs with no earlier effect are interrupted and must revalidate execution context
and authorization before any newly submitted continuation. Consumed one-time approvals are not
replayed.

Entering `waiting_approval` and persisting its run/request/session/workspace/expiry binding are one
transaction; the schema rejects a waiting run without that binding. Capability approvals also carry
the optional `runId`, and replay from another run fails the existing binding comparison. Cancellation,
denial, expiry, and restart must invalidate the matching approval rather than a caller-supplied id.
The approval JSON store and run SQLite file cannot share one transaction: create the approval first,
then commit the run binding. A crash between them leaves an orphan approval, never a waiting run;
approval-store startup cancels pending/approved orphans, and normal run cancellation calls
`cancelRun`. This recovery rule is required until approvals move into the same database.

## Delivery and host events

Agent completion and result delivery are separate facts. Delivery moves from `pending` to
`delivering`, then to `delivered` or `failed`. A restart while `delivering` produces
`result_unknown`; downstream retry requires the stored delivery idempotency key and adapter-specific
support. A confirmed idempotent retry updates the same delivery record, keeps the same key, increments
attempts, and may move `result_unknown` or `failed` back to `delivering`; an ordinary `start` cannot.
Agent success alone must not be presented as successful channel delivery.

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
| `yp_agent_runs` | AgentService; owner, non-content request/output digests, status, approval/effect checkpoints |
| `yp_delivery_attempts` | delivery adapters; delivery state independent of execution |
| `yp_inbound_deduplication` | channel ingress; authenticated source message deduplication |

Migrations run in `BEGIN IMMEDIATE` transactions, are forward-only and additive, and refuse a schema
newer than the running Runtime. For a staged Runtime activation, Electron snapshots the closed
`automation.sqlite` database (including present WAL/SHM sidecars) before changing `current.json`.
The activation remains provisional through startup health and a stability interval; failure or an
App crash before confirmation restores both the previous Runtime pointer and that database snapshot.
After activation confirmation, binary rollback does not imply database rollback. An incompatible or
destructive migration after that boundary requires a separately designed backup/recovery operation.
Bindings, runs, deduplication, and idempotency include both authenticated authority and subject; a
shared channel connection does not collapse different senders. Composite foreign keys prevent a run
from referencing another owner's binding and prevent inbound deduplication from pointing at another
owner's run. Durable `AgentRunRecord` is deliberately separate from the submission: it contains
owner/context metadata and input/output digests, while live completion may attach optional output.
The run table therefore does not store the complete `AgentRunRequest`, output message, or duplicate
Pi conversation content. Any future durable task or delivery payload needs an explicit
retention/redaction/cleanup design owned by its feature rather than being hidden in this baseline.
Tests use real files, including migration over a pre-existing fixture. The native smoke executes the
actual SEA twice against the same file and verifies a persisted counter after close/reopen; Node
development mode alone is not accepted as driver compatibility evidence.

On POSIX, the workflow directory is set to `0700`, the database is set to `0600`, and a final database
path already observed as a symbolic link is rejected. This is local-path hardening, not a race-proof
`openat` sandbox; the Runtime still supplies its owned fixed path. Windows uses the user's existing
profile ACL; its packaged SEA and ACL behavior remains explicitly unverified until the cross-platform
acceptance card runs.

## Deliberately unresolved product boundaries

- “Full access” has no expanded meaning in this contract. Existing Pi tool availability and current
  Yuanpu capability approval behavior remain unchanged. In particular, model input and remote
  channel content cannot modify their own permissions or approve pending work.
- Closing the last window keeps today's platform behavior: non-macOS quits the App; macOS may remain
  active under Electron's current lifecycle. No tray/background promise is added. An explicit App
  quit must stop Runtime and managed child processes; process-lifecycle hardening is TASK-013.
- The first IM platform and its verified identity environment remain a TASK-017 decision. Generic
  `im` contracts do not claim any platform SDK or live message support.
