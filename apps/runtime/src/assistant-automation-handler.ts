import type { AssistantMemoryRepository, AssistantAutomationStore, AutomationHandler,
  AutomationJob, AutomationProposal } from '@yuanpu-agent/assistant';
import type { AssistantDelegationRecord } from '@yuanpu-agent/protocol';

export interface DelegationAutomationHost {
  current(taskId: string): Promise<AssistantDelegationRecord | undefined>;
  notify(record: AssistantDelegationRecord, signal: AbortSignal,
    beforeModel: () => boolean): Promise<{ costUsd: number; message: string }>;
  linkEvidence(record: AssistantDelegationRecord,
    checks: Array<{ criterion: string; evidenceRefs: string[] }>): Promise<void>;
}

function parseEvidenceProposal(message: string): Array<{ criterion: string; evidenceRefs: string[] }> {
  if (message.length > 16_000) throw new Error('Delegation verification proposal exceeds budget.');
  const parsed = JSON.parse(message) as { checks?: unknown };
  if (!Array.isArray(parsed.checks) || parsed.checks.length > 12
    || parsed.checks.some((item) => !item || typeof item !== 'object'
      || typeof item.criterion !== 'string' || !Array.isArray(item.evidenceRefs)
      || item.evidenceRefs.some((ref: unknown) => typeof ref !== 'string'))) {
    throw new Error('Invalid delegation verification proposal.');
  }
  return parsed.checks;
}

/** Worker-owned periodic check and one-shot, crash-conservative delegation wake. */
export function assistantAutomationHandler(memory: AssistantMemoryRepository,
  store: AssistantAutomationStore, delegations?: DelegationAutomationHost): AutomationHandler {
  return {
    async lookup(job) {
      if (job.kind === 'verify-delegation') {
        if (store.hasCheckpoint(job.effectId)) return 'applied';
        if (store.preparedProposal(job)) return 'absent';
        if (store.hasEffectAttempt(job.effectId)) return 'unknown';
        if (!delegations || !job.delegationId) return 'deferred';
        const record = await delegations.current(job.delegationId);
        return record && ['completed', 'failed', 'cancelled', 'unknown', 'waiting_approval']
          .includes(record.status) ? 'absent' : 'deferred';
      }
      if (job.kind !== 'daily-check' && job.kind !== 'weekly-check') return 'deferred';
      return store.hasCheckpoint(job.effectId) ? 'applied' : 'absent';
    },
    async prepare(job: AutomationJob, signal: AbortSignal): Promise<AutomationProposal> {
      if (signal.aborted) throw signal.reason;
      if (job.kind === 'verify-delegation') {
        const prepared = store.preparedProposal(job);
        if (prepared) return prepared;
        if (!delegations || !job.delegationId) throw new Error('Delegation automation host is unavailable.');
        const record = await delegations.current(job.delegationId);
        if (!record || !['completed', 'failed', 'cancelled', 'unknown', 'waiting_approval']
          .includes(record.status)) throw new Error('Delegation is not ready for verification.');
        signal.throwIfAborted();
        const billed = await delegations.notify(record, signal, () => store.beginEffectAttempt(job));
        const checks = parseEvidenceProposal(billed.message);
        const proposal = { costUsd: billed.costUsd, value: { taskId: record.taskId,
          status: record.status, updatedAt: record.updatedAt, checks } };
        store.savePreparedProposal(job, proposal);
        return proposal;
      }
      const database = memory.sources.database;
      const sources = database.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN availability='available' THEN 1 ELSE 0 END) AS available
        FROM source_current`).get() as { total: number; available: number | null };
      const memories = database.prepare(`SELECT COUNT(*) AS total FROM memory_documents
        WHERE status='active'`).get() as { total: number };
      return { costUsd: 0, value: { kind: job.kind, sourceCount: sources.total,
        availableSourceCount: sources.available ?? 0, activeMemoryCount: memories.total } };
    },
    async apply(job, proposal, commit, signal) {
      if (job.kind === 'verify-delegation') {
        if (!delegations || !job.delegationId) throw new Error('Delegation automation host is unavailable.');
        const value = proposal.value as { taskId: string; status: string; updatedAt: string;
          checks: Array<{ criterion: string; evidenceRefs: string[] }> };
        signal.throwIfAborted();
        const current = await delegations.current(job.delegationId);
        signal.throwIfAborted();
        if (!current || current.taskId !== value.taskId || current.updatedAt !== value.updatedAt
          || current.status !== value.status || store.get(job.jobId)?.status !== 'running') {
          throw new Error('Delegation changed before verification commit.');
        }
        if (current.status === 'completed') {
          await delegations.linkEvidence(current, value.checks);
        } else if (value.checks.length) {
          throw new Error('Noncompleted delegation proposed evidence linkage.');
        }
        commit(() => store.recordCheckpoint(job, { taskId: current.taskId,
          status: current.status, updatedAt: current.updatedAt,
          evidenceLinked: current.status === 'completed' }));
        return;
      }
      commit(() => store.recordCheckpoint(job, proposal.value));
    },
  };
}
