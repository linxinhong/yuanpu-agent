import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
  children.push(child);
  return child;
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const vite = run(pnpm, ['--filter', '@yuanpu-agent/app', 'dev', '--host', '127.0.0.1']);

let rendererReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch('http://127.0.0.1:5173');
    if (response.ok) {
      rendererReady = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (!rendererReady) {
  vite.kill();
  throw new Error('Vite did not become ready on port 5173');
}

const electron = run(
  pnpm,
  ['--filter', '@yuanpu-agent/desktop', 'start'],
  { env: { ...process.env, YUANPU_RENDERER_URL: 'http://127.0.0.1:5173' } },
);

electron.once('exit', (code) => {
  vite.kill();
  process.exitCode = code ?? 0;
});

process.once('SIGINT', () => children.forEach((child) => child.kill()));
process.once('SIGTERM', () => children.forEach((child) => child.kill()));
