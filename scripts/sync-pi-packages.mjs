import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.argv[2] ?? join(repositoryRoot, '..', 'pi'));
const mirroredPackages = [
  'agent',
  'ai',
  'chord',
  'client',
  'coding-agent',
  'durable',
  'evals',
  'protocol',
  'server',
  'session-backends',
  'telemetry',
  'tui',
];
const unavailablePackages = ['storage'];

function git(args, options = {}) {
  return execFileSync('git', ['-C', sourceRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

const remote = git(['remote', 'get-url', 'origin']);
if (!remote.includes('github.com/earendil-works/pi')) {
  throw new Error(`Refusing to sync from unexpected Pi remote: ${remote}`);
}

const commit = git(['rev-parse', 'HEAD']);
const trackedPackages = mirroredPackages.filter((name) =>
  git(['ls-tree', '-d', '--name-only', 'HEAD', `packages/${name}`]) === `packages/${name}`,
);
const archiveRoot = await mkdtemp(join(tmpdir(), 'yuanpu-pi-sync-'));
const archivePath = join(archiveRoot, 'pi.tar');

try {
  execFileSync('git', [
    '-C',
    sourceRoot,
    'archive',
    '--format=tar',
    `--output=${archivePath}`,
    'HEAD',
    '--',
    ...trackedPackages.map((name) => `packages/${name}`),
    'scripts/build-coding-agent-bundle.mjs',
    'tsconfig.base.json',
  ]);
  execFileSync('tar', ['-xf', archivePath, '-C', archiveRoot]);

  for (const name of [...mirroredPackages, ...unavailablePackages]) {
    const destination = join(repositoryRoot, 'packages', name);
    await rm(destination, { recursive: true, force: true });
    if (!trackedPackages.includes(name)) continue;
    await cp(join(archiveRoot, 'packages', name), destination, { recursive: true });
  }

  await cp(
    join(archiveRoot, 'scripts', 'build-coding-agent-bundle.mjs'),
    join(repositoryRoot, 'scripts', 'build-coding-agent-bundle.mjs'),
  );
  await cp(join(archiveRoot, 'tsconfig.base.json'), join(repositoryRoot, 'tsconfig.base.json'));

  const codingAgentPackage = JSON.parse(
    await readFile(join(repositoryRoot, 'packages', 'coding-agent', 'package.json'), 'utf8'),
  );
  await mkdir(join(repositoryRoot, 'docs'), { recursive: true });
  await writeFile(
    join(repositoryRoot, 'docs', 'pi-upstream.json'),
    `${JSON.stringify({
      repository: remote,
      commit,
      version: codingAgentPackage.version,
      packages: trackedPackages,
      unavailablePackages: [
        ...mirroredPackages.filter((name) => !trackedPackages.includes(name)),
        ...unavailablePackages,
      ],
    }, null, 2)}\n`,
  );
  console.log(`Synchronized Pi ${codingAgentPackage.version} at ${commit}`);
} finally {
  await rm(archiveRoot, { recursive: true, force: true });
}
