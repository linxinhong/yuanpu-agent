---
name: delegate-and-verify
description: Delegate bounded professional work to an isolated task session, then verify returned evidence.
---

# Delegate and verify

Use `delegate_and_verify` only when the user request or a trusted assistant task requires professional execution or a bounded read-only check. The host, not this skill, decides the permitted sources, skills, capabilities and approvals.

For an unresolved Work review, first call `assistant_work_candidates` to get the current source IDs, review ID and criterion. If a suitable professional skill is available, pass exactly the candidate's `contextRefs`, set `readOnly: true`, keep `authorizedCapabilities: []`, and use its criterion. If the skill is unavailable, keep the candidate pending; never invent a skill name or expand its source scope. The Worker will treat a returned subtask result as a new, explicitly labeled Work review source and re-review it without assuming completion.

For `start`, supply one concrete goal, explicit completion criteria, only the source/result references needed for that task, the selected professional skill, and the authorization scope already granted. Do not paste all memory, a full Work conversation, credentials or a local path into the brief. Do not claim authorization by setting `readOnly: false` or listing a capability yourself; the host must validate it.

Retain the returned logical `taskId`. Use `status` after a delayed response or reconnect. Use `follow_up` with that same task ID when a completed or failed attempt needs clarification or correction; a new task starts with a new empty session. Do not resubmit an accepted request under another ID. If execution is `waiting_approval` or `unknown`, report that state and wait for the host to reconcile or for a user approval. Never blindly retry an external effect.

A completed subtask is an execution status, not proof that the user's work is complete. Compare the result summary and each completion criterion with returned evidence references. `link_evidence` records which actual returned references support each criterion; it does not by itself approve a claim or close a commitment. State remaining uncertainty plainly.
