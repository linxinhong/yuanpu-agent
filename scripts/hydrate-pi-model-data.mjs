import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = resolve(repositoryRoot, 'packages/ai/src/providers/data/.manifest.json');

try {
  await access(manifest);
} catch {
  const args = ['--dir', 'packages/ai', 'run', 'hydrate-model-data'];
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli && /(?:^|[\\/])pnpm(?:\.c?js)?$/i.test(pnpmCli)) {
    execFileSync(process.execPath, [pnpmCli, ...args], { cwd: repositoryRoot, stdio: 'inherit' });
  } else if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'pnpm --dir packages/ai run hydrate-model-data'], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
  } else {
    execFileSync('pnpm', args, { cwd: repositoryRoot, stdio: 'inherit' });
  }
}
