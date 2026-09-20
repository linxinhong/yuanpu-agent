import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = resolve(repositoryRoot, 'packages/ai/src/providers/data/.manifest.json');

try {
  await access(manifest);
} catch {
  execFileSync(
    'pnpm',
    ['--dir', 'packages/ai', 'run', 'hydrate-model-data'],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );
}
