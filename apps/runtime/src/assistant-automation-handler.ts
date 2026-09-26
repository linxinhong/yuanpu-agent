import type { AssistantMemoryRepository, AssistantAutomationStore, AutomationHandler,
  AutomationJob, AutomationProposal } from '@yuanpu-agent/assistant';

/** Concrete Worker-owned periodic check; behavior skills consume the other durable jobs later. */
export function assistantAutomationHandler(memory: AssistantMemoryRepository,
  store: AssistantAutomationStore): AutomationHandler {
  return {
    async lookup(job) {
      if (job.kind !== 'daily-check' && job.kind !== 'weekly-check') return 'deferred';
      return store.hasCheckpoint(job.effectId) ? 'applied' : 'absent';
    },
    async prepare(job: AutomationJob, signal: AbortSignal): Promise<AutomationProposal> {
      if (signal.aborted) throw signal.reason;
      const database = memory.sources.database;
      const sources = database.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN availability='available' THEN 1 ELSE 0 END) AS available
        FROM source_current`).get() as { total: number; available: number | null };
      const memories = database.prepare(`SELECT COUNT(*) AS total FROM memory_documents
        WHERE status='active'`).get() as { total: number };
      return { costUsd: 0, value: { kind: job.kind, sourceCount: sources.total,
        availableSourceCount: sources.available ?? 0, activeMemoryCount: memories.total } };
    },
    async apply(job, proposal) { store.recordCheckpoint(job, proposal.value); },
  };
}
