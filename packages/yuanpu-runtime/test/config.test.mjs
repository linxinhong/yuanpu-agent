import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureYuanpuHome } from '../dist/index.mjs';

test('Yuanpu home separates application, Agent, packages, and workflow data', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-home-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const home = await ensureYuanpuHome(root);
  const config = JSON.parse(await readFile(home.configPath, 'utf8'));
  await Promise.all([
    access(home.skillsPath),
    access(join(home.memoryPath, 'MEMORY.md')),
    access(home.packagesPath),
    access(home.sessionsPath),
    access(home.workflowsPath),
  ]);

  assert.equal(config.schemaVersion, 1);
  assert.equal(config.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(home.root, root);
  assert.equal(home.configPath, join(root, 'app', 'config.json'));
  assert.equal(home.agentPath, join(root, 'agent'));
});

test('Yuanpu home migrates the legacy flat layout without losing package paths', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-home-migration-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const oldInstallPath = join(root, 'plugins', 'installed', 'example', 'node_modules', 'example');
  await mkdir(oldInstallPath, { recursive: true });
  await mkdir(join(root, 'skills', 'example'), { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    apiKeyEnv: 'OPENAI_API_KEY',
    workingDirectory: root,
  }));
  await writeFile(join(root, 'settings.json'), JSON.stringify({ packages: [oldInstallPath] }));
  await writeFile(join(root, 'models-store.json'), '{}');
  await writeFile(join(root, 'plugins', 'state.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: { example: { name: 'example', installPath: oldInstallPath } },
  }));

  const home = await ensureYuanpuHome(root);
  const state = JSON.parse(await readFile(join(home.packagesPath, 'state.json'), 'utf8'));
  const settings = JSON.parse(await readFile(join(home.agentPath, 'settings.json'), 'utf8'));
  const newInstallPath = join(root, 'packages', 'installed', 'example', 'node_modules', 'example');
  assert.equal(state.plugins.example.installPath, newInstallPath);
  assert.deepEqual(settings.packages, [newInstallPath]);
  await access(join(home.skillsPath, 'example'));
  await access(join(home.agentPath, 'models-store.json'));
});
