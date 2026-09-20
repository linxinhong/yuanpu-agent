import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureYuanpuHome } from '../dist/index.mjs';

test('Yuanpu home initializes portable config, skills, memory, and sessions', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-home-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const home = await ensureYuanpuHome(root);
  const config = JSON.parse(await readFile(home.configPath, 'utf8'));
  await Promise.all([
    access(home.skillsPath),
    access(join(home.memoryPath, 'MEMORY.md')),
    access(home.sessionsPath),
  ]);

  assert.equal(config.schemaVersion, 1);
  assert.equal(config.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(home.root, root);
});
