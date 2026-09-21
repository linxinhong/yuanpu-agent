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
const catalogUrl = process.env.YUANPU_CATALOG_URL || 'http://127.0.0.1:8787';
const catalog = run(pnpm, ['--filter', '@yuanpu-agent/catalog-server', 'dev']);
const vite = run(pnpm, ['--filter', '@yuanpu-agent/app', 'dev', '--host', '127.0.0.1']);

let rendererReady = false;
let catalogReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const [rendererResponse, catalogResponse] = await Promise.all([
      fetch('http://127.0.0.1:5173'),
      fetch(`${catalogUrl}/v1/health`),
    ]);
    rendererReady = rendererResponse.ok;
    catalogReady = catalogResponse.ok;
    if (rendererReady && catalogReady) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (!rendererReady || !catalogReady) {
  vite.kill();
  catalog.kill();
  throw new Error('Vite or the skill catalog did not become ready');
}

const electron = run(
  pnpm,
  ['--filter', '@yuanpu-agent/desktop', 'start'],
  {
    env: {
      ...process.env,
      YUANPU_RENDERER_URL: 'http://127.0.0.1:5173',
      YUANPU_CATALOG_URL: catalogUrl,
    },
  },
);

electron.once('exit', (code) => {
  vite.kill();
  catalog.kill();
  process.exitCode = code ?? 0;
});

process.once('SIGINT', () => children.forEach((child) => child.kill()));
process.once('SIGTERM', () => children.forEach((child) => child.kill()));
