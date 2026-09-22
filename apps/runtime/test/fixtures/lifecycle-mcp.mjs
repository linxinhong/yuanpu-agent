import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const descendants = new Set();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize' && message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'lifecycle-mcp', version: '1.0.0' },
      },
    })}\n`);
  } else if (message.method === 'tools/list' && message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'yuanpu_spawn_child',
          description: 'Spawn a lifecycle fixture descendant.',
          inputSchema: { type: 'object', additionalProperties: false },
        }],
      },
    })}\n`);
  } else if (message.method === 'tools/call' && message.id !== undefined) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 60000)'], {
      stdio: 'ignore',
    });
    descendants.add(child);
    child.once('exit', () => descendants.delete(child));
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: String(child.pid) }],
        structuredContent: { pid: child.pid },
      },
    })}\n`);
  }
}
