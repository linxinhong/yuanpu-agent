import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowManager, YuanpuSubagentManager, extractWebText } from '@yuanpu-agent/runtime-kit';

/** No credentials or network calls: verifies portable HTML parser and Worker in SEA. */
export async function smokeBuiltinAgentTools() {
  const directory = await mkdtemp(join(tmpdir(), 'yuanpu-native-agent-tools-'));
  const subagents = new YuanpuSubagentManager({ directory: join(directory, 'children'), tools: () => ['read'], prepareChild: () => async ({ task }) => ({ text: task }) });
  const workflows = new WorkflowManager({ directory: join(directory, 'runs'), cwd: directory, subagents });
  try {
    const run = await workflows.start({ background: false, timeoutMs: 5000, script: "return await parallel([() => agent('native-worker-ok', {agentType:'scout'})]);" });
    const page = extractWebText('<html><body><main><h1>Native reader</h1><p>Portable article extraction works inside the runtime.</p></main></body></html>', 'https://example.com');
    if (run.status !== 'completed' || !page.text.includes('Portable article')) throw new Error(run.error ?? 'Native article extraction failed.');
    return { workflow: run.status, result: JSON.parse(run.result), reader: true };
  } finally { await workflows.dispose(); await subagents.dispose(); await rm(directory, { recursive: true, force: true }); }
}
