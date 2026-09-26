---
name: organize-work
description: Turn a verified Work review into current focus, project progress and single-owner commitment candidates.
---

# Organize Work

Read the current source-backed Work review and relevant active ledger items. Return a bounded JSON proposal separating observed progress, a confirmed user commitment, an assistant suggestion and an unresolved question. Cite exact review and source versions. A successful tool step is not business completion; a review marked partial or unverified cannot close a commitment.

Use one stable primary record per commitment. Project and focus notes may refer to its ID, without copying and independently editing its status. Keep current progress in `work/`; durable project background belongs in memory. A temporary state needs a verification time or expiry, and silence never means a task is done.

The Worker checks provenance, identity, budget and versions before updating the ledger. This skill does not authorize a professional task, modify Work files or send a suggestion.
