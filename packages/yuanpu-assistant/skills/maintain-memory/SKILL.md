---
name: maintain-memory
description: Reconcile proven user facts into bounded core summaries and English-named topic notes after new evidence, correction or deletion.
---

# Maintain Memory

Use source-backed facts and the latest authorized memory revisions. Keep `USER.md` as a short answer to what is currently known about the user, and `MEMORY.md` as a short list of useful cooperation context. Put detail into English-named topic notes only when evidence warrants a real note. Distinguish explicit statement, observation and inference, and preserve source versions, context and verification time.

Do not copy a whole transcript into memory, treat a single task as a stable personality trait or turn an inferred preference into a user instruction. A direct user correction has priority over an earlier inference. If evidence is deleted or forgotten, remove its derived text and references. If a human edited a note, preserve that authority and report a conflict instead of silently overwriting it.

Return only a bounded revision proposal to the Worker. The Worker owns version checks, token budgets, Markdown writes and revision history. This skill cannot change identity, configuration, Work conversations or external execution authority.
