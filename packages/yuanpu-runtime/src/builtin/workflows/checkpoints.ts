import type { CapabilitySource } from '../../capabilities/index.js';
import type { CapabilityDefinition } from '../../capabilities/contracts.js';
export const WORKFLOW_CHECKPOINT_SOURCE = 'builtin.workflow-checkpoints';
export const WORKFLOW_CHECKPOINT_CAPABILITY = 'confirm_workflow_checkpoint';
/** Confirmation is authorized and consumed by CapabilityRegistry before execution. */
export function createWorkflowCheckpointSource(): CapabilitySource {
  const definition: CapabilityDefinition = {
    name: WORKFLOW_CHECKPOINT_CAPABILITY, description: 'Confirm a workflow checkpoint using host-signed, one-time user approval. Does not run the workflow itself.',
    packageVersion: '1.0.0', type: 'workflow', riskLevel: 'R3', status: 'needs_approval',
    inputSchema: { type: 'object', required: ['runId', 'checkpointId', 'prompt'], additionalProperties: false, properties: {
      runId: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, checkpointId: { type: 'string', maxLength: 64 }, prompt: { type: 'string', maxLength: 2000 },
    } },
  };
  return { sourceInstanceId: WORKFLOW_CHECKPOINT_SOURCE,
    async list() { return [definition]; },
    async resolve(name) { return name === definition.name ? definition : undefined; },
    async execute(input) { return { content: [{ type: 'text', text: JSON.stringify({ approved: true, ...input.arguments }) }] }; },
  };
}
