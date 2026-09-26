import { randomUUID } from 'node:crypto';
import type { AssistantDelegationBrief } from '@yuanpu-agent/protocol';
import type { ProfessionalTaskHost } from './assistant-delegation-local.js';
import type { RuntimeAssistantSourceHost } from './assistant-source-host.js';

export interface ProfessionalCapabilityClient {
  execute(input: { name: string; arguments: Record<string, unknown>; approvalRequestId?: string },
    context: { sessionId: string; workspaceId: string; signal?: AbortSignal }): Promise<{
      isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown }>;
}

/** Task-level approval gates the allowed capability names; MCP still checks each concrete call. */
export function createProfessionalTaskHost(sources: RuntimeAssistantSourceHost,
  capabilities?: ProfessionalCapabilityClient,
  verifyGrant?: (brief: AssistantDelegationBrief, approvalRequestId: string) => Promise<boolean>): ProfessionalTaskHost {
  return {
    async authorizeTask(brief, approvedGrantId) {
      if (!brief.readOnly || brief.authorizedCapabilities.length) {
        if (!approvedGrantId || !verifyGrant || !await verifyGrant(brief, approvedGrantId)) {
          throw new Error('Professional execution requires a trusted user grant.');
        }
      }
      const versions = new Map(await Promise.all(brief.contextRefs.map(async (ref) => {
        const current = await sources.delegatedSourceVersion(ref);
        const expected = brief.sourceVersions?.[ref] ?? current;
        if (current !== expected) throw new Error('Delegated source changed after task authorization.');
        return [ref, expected] as const;
      })));
      const allowed = new Set(brief.authorizedCapabilities);
      const assertCurrentGrant = async (): Promise<void> => {
        if (approvedGrantId && (!verifyGrant || !await verifyGrant(brief, approvedGrantId))) {
          throw new Error('Professional task grant is no longer active.');
        }
      };
      return {
        async readSource(ref) {
          const version = versions.get(ref);
          if (!version) throw new Error('Source reference is outside this task grant.');
          await assertCurrentGrant();
          return sources.readDelegatedSource(ref, version);
        },
        async executeCapability(input, signal) {
          if (!allowed.has(input.name) || !capabilities || !approvedGrantId) {
            throw new Error('Professional execution requires a trusted user grant.');
          }
          signal?.throwIfAborted();
          await assertCurrentGrant();
          signal?.throwIfAborted();
          try {
            const output = await capabilities.execute(input, {
              sessionId: brief.assistantSessionId,
              workspaceId: `assistant-delegation:${brief.taskId}`,
              signal,
            });
            const text = output.content.filter((part) => part.type === 'text')
              .map((part) => part.text ?? '').join('\n').slice(0, 16_000);
            return output.isError ? { status: 'failed' as const, text }
              : { status: 'completed' as const, text,
                resultRef: `capability-result:${brief.taskId}:${randomUUID()}` };
          } catch (error) {
            const failure = (error as { failure?: { error?: string; approvalRequestId?: string } }).failure;
            if (failure?.error === 'needs_approval' && failure.approvalRequestId) {
              return { status: 'needs_approval' as const, approvalRequestId: failure.approvalRequestId };
            }
            if (failure?.error === 'result_unknown' || failure?.error === 'timeout') {
              return { status: 'unknown' as const };
            }
            throw error;
          }
        },
      };
    },
  };
}

/** Read-only fixture convenience; production uses createProfessionalTaskHost. */
export const createReadOnlyProfessionalTaskHost = (sources: RuntimeAssistantSourceHost): ProfessionalTaskHost =>
  createProfessionalTaskHost(sources);
