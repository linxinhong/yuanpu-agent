import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const [runtimeEntry, home, mode = 'ready'] = process.argv.slice(2);
const token = randomBytes(32).toString('hex');
const keyPair = generateKeyPairSync('ed25519');
const approvalPublicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const runtimeArgs = mode === 'mcp'
  ? [runtimeEntry, '--capability-lifecycle-smoke', '--parent-pid', String(process.pid)]
  : [runtimeEntry, '--serve', '--port', '0'];
const runtime = spawn(process.execPath, runtimeArgs, {
  stdio: ['pipe', 'pipe', mode === 'mcp' ? 'inherit' : 'ignore'],
  env: {
    ...process.env,
    YUANPU_HOME: home,
    ...(mode === 'mcp' ? {} : {
      YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '',
    }),
  },
});
if (mode !== 'mcp') {
  runtime.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
}
if (mode === 'before-ready') {
  process.stdout.write(`${JSON.stringify({ runtimePid: runtime.pid })}\n`);
  setTimeout(() => process.exit(0), 10);
}
let stdout = '';
runtime.stdout.on('data', (chunk) => {
  if (mode === 'before-ready') return;
  stdout += chunk.toString();
  const lineEnd = stdout.indexOf('\n');
  if (lineEnd < 0) return;
  const ready = JSON.parse(stdout.slice(0, lineEnd));
  process.stdout.write(`${JSON.stringify({ runtimePid: runtime.pid, ready })}\n`);
  runtime.stdout.removeAllListeners('data');
});
setInterval(() => undefined, 60_000);
