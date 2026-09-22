import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const [runtimeEntry, home] = process.argv.slice(2);
const token = randomBytes(32).toString('hex');
const keyPair = generateKeyPairSync('ed25519');
const approvalPublicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const runtime = spawn(process.execPath, [runtimeEntry, '--serve', '--port', '0'], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: {
    ...process.env,
    YUANPU_HOME: home,
    YUANPU_PYTHON_MCP_EXECUTABLE: '',
    YUANPU_PYTHON_MCP_ROOT: '',
  },
});
runtime.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
let stdout = '';
runtime.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  const lineEnd = stdout.indexOf('\n');
  if (lineEnd < 0) return;
  process.stdout.write(`${JSON.stringify({ runtimePid: runtime.pid, ready: JSON.parse(stdout.slice(0, lineEnd)) })}\n`);
  runtime.stdout.removeAllListeners('data');
});
setInterval(() => undefined, 60_000);
