import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initializeAssistantHome, loadAssistantSkills } from '@yuanpu-agent/assistant';
import { bundledAssistantSkillFiles } from '../src/assistant-skill-assets.generated.ts';

test('SEA skill asset seeds delegate-and-verify into discoverable Assistant Home skills', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-skill-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundled = bundledAssistantSkillFiles.map((file) => ({
    path: file.path, bytes: Buffer.from(file.base64, 'base64'),
  }));
  assert.ok(bundled.some((file) => file.path === 'delegate-and-verify/SKILL.md'));
  const paths = await initializeAssistantHome(join(root, 'assistant'), { bundledSkillFiles: bundled });
  const skills = await loadAssistantSkills(paths);
  assert.ok(skills.some((skill) => skill.name === 'delegate-and-verify'));
});
