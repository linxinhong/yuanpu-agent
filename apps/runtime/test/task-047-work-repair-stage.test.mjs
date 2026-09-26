import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const entry = resolve(import.meta.dirname, '../dist/index.cjs');

async function eventually(read, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; }
    catch { /* Runtime and Worker may be between durable writes. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function modelText(messages) {
  return messages.flatMap((message) => typeof message.content === 'string'
    ? [message.content] : Array.isArray(message.content)
      ? message.content.filter((item) => item?.type === 'text').map((item) => item.text)
      : []).join('\n');
}

function sourceRefs(text, prefix) {
  return [...text.matchAll(new RegExp(`${prefix}:[A-Za-z0-9_:-]+`, 'gu'))].map((match) => match[0]);
}

test('TASK-047 real Runtime Work repair changes a partial review only after new evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-stage-047-repair-'));
  const app = join(root, 'app');
  const professionalSkill = join(root, 'agent', 'skills', 'reviewer');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(app, { recursive: true }), mkdir(professionalSkill, { recursive: true }),
    mkdir(workspace)]);
  await writeFile(join(professionalSkill, 'SKILL.md'), '---\nname: reviewer\ndescription: Read one authorized Work source.\n---\n\n# Reviewer\nRead only the supplied source and report what it says.\n');
  let modelCalls = 0;
  let candidate;
  let delegatedTaskId;
  const toolSurfaces = { work: [], assistant: [], professional: [], review: [] };
  const provider = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const tools = (input.tools ?? []).map((tool) => tool.function?.name);
    const text = modelText(input.messages);
    const lastUserIndex = input.messages.findLastIndex((message) => message.role === 'user');
    const lastUserText = modelText(input.messages.slice(lastUserIndex, lastUserIndex + 1));
    const newToolResults = input.messages.slice(lastUserIndex + 1)
      .filter((message) => message.role === 'tool');
    modelCalls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: `stage-${modelCalls}`, object: 'chat.completion.chunk', created: 1,
      model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (tools.includes('write')) {
      toolSurfaces.work.push(tools);
      const messages = input.messages;
      const lastUser = messages.findLastIndex((message) => message.role === 'user');
      const returned = messages.slice(lastUser + 1).some((message) => message.role === 'tool');
      if (!returned) {
        const content = text.includes('Please fix report.md') ? '# Report' : '# Incomplete';
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `write-${modelCalls}`,
          type: 'function', function: { name: 'write',
            arguments: JSON.stringify({ path: 'report.md', content }) } }] });
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: 'The file was written.' });
        send({}, 'stop');
      }
    } else if (tools.includes('read_task_source')) {
      toolSurfaces.professional.push(tools);
      if (!newToolResults.length) {
        assert.ok(candidate?.contextRefs[0]);
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `read-${modelCalls}`,
          type: 'function', function: { name: 'read_task_source',
            arguments: JSON.stringify({ ref: candidate.contextRefs[0] }) } }] });
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: 'The bounded Work source was read; the report content still needs checking.' });
        send({}, 'stop');
      }
    } else if (lastUserText.includes('A delegated task changed state')) {
      if (!newToolResults.length) {
        const taskId = delegatedTaskId;
        assert.ok(taskId && lastUserText.includes(taskId));
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `status-${modelCalls}`,
          type: 'function', function: { name: 'delegate_and_verify',
            arguments: JSON.stringify({ action: 'status', taskId }) } }] });
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: JSON.stringify({ checks: [{
          criterion: 'Check report material', evidenceRefs: [candidate.contextRefs[0]],
        }] }) });
        send({}, 'stop');
      }
    } else if (tools.includes('assistant_work_candidates') && lastUserText.includes('Please verify')) {
      toolSurfaces.assistant.push(tools);
      if (newToolResults.length === 0) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `candidates-${modelCalls}`,
          type: 'function', function: { name: 'assistant_work_candidates',
            arguments: '{}' } }] });
        send({}, 'tool_calls');
      } else if (newToolResults.length === 1) {
        const result = JSON.parse(newToolResults[0].content);
        candidate = Array.isArray(result) ? result[0] : result;
        assert.ok(candidate?.contextRefs?.length);
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `delegate-${modelCalls}`,
          type: 'function', function: { name: 'delegate_and_verify',
            arguments: JSON.stringify({ action: 'start', skillName: 'reviewer',
              goal: 'Check the saved report material without changing Work.',
              completionCriteria: ['Check report material'],
              contextRefs: candidate.contextRefs, authorizedCapabilities: [], readOnly: true }) } }] });
        send({}, 'tool_calls');
      } else {
        const response = JSON.parse(newToolResults.at(-1).content);
        delegatedTaskId = response.taskId;
        send({ role: 'assistant', content: 'The bounded read-only verification was started.' });
        send({}, 'stop');
      }
    } else if (text.includes('Review this saved Work snapshot')) {
      toolSurfaces.review.push(tools);
      const toolRefs = sourceRefs(text, 'work-tool');
      const artifacts = sourceRefs(text, 'work-artifact');
      const repaired = text.includes('Please fix report.md');
      const evidenceRefs = repaired ? [toolRefs.at(-1), artifacts.at(-1)] : [toolRefs.at(-1)];
      send({ role: 'assistant', content: JSON.stringify({
        goal: 'Write exactly # Report to report.md', constraints: [],
        judgment: repaired ? 'supported' : 'partial',
        findings: [{ claim: repaired ? 'The corrected payload was written'
          : 'A write step completed, but the required payload is missing',
        judgment: repaired ? 'supported' : 'partial', evidenceRefs }],
        unresolved: repaired ? [] : ['report.md does not contain # Report'],
        followUp: repaired ? [] : ['Inspect and repair report.md'],
        memoryCandidates: [], ledgerCandidates: [],
      }) });
      send({}, 'stop');
    } else {
      send({ role: 'assistant', content: '{"observations":[]}' });
      send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
  await writeFile(join(app, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(app, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }));
  await writeFile(join(app, 'config.json'), JSON.stringify({ schemaVersion: 1,
    provider: 'fixture', model: 'fixture-model', workingDirectory: workspace }));
  const token = randomBytes(32).toString('hex');
  const keys = generateKeyPairSync('ed25519');
  const approvalPublicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const runtime = spawn(process.execPath, [entry, '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, YUANPU_HOME: root,
      YUANPU_PYTHON_MCP_EXECUTABLE: '', YUANPU_PYTHON_MCP_ROOT: '' },
  });
  let stderr = '';
  runtime.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (runtime.exitCode === null && runtime.signalCode === null) {
      runtime.kill('SIGTERM');
      await new Promise((resolveExit) => runtime.once('exit', resolveExit));
    }
    provider.closeAllConnections();
    await new Promise((resolveClose) => provider.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  });
  runtime.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const ready = await new Promise((resolveReady, rejectReady) => {
    let output = '';
    const timeout = setTimeout(() => rejectReady(new Error(`Runtime ready timeout: ${stderr}`)), 15_000);
    runtime.once('exit', (code) => rejectReady(new Error(`Runtime exited ${code}: ${stderr}`)));
    runtime.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(output.slice(0, newline)));
    });
  });
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`http://${ready.host}:${ready.port}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const created = await api('/v1/work/conversations', 'POST', {});
  assert.equal(created.status, 201);
  const workId = created.body.id;
  const submit = async (message, clientMessageId) => {
    const receipt = await api('/v1/chat/submit', 'POST', {
      surface: 'work', conversationId: workId, message, clientMessageId,
    });
    assert.equal(receipt.status, 202);
    const run = await eventually(async () => {
      const current = await api(`/v1/agent/runs/${receipt.body.runId}`);
      return ['succeeded', 'failed', 'result_unknown'].includes(current.body.status)
        ? current.body : undefined;
    }, `Work ${clientMessageId}`);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
  };
  const review = async (minimumVersion) => eventually(() => {
    const state = new DatabaseSync(join(root, 'assistant', 'state.sqlite'));
    try {
      const row = state.prepare(`SELECT review_json FROM work_reviews WHERE work_id=?
        AND review_version>=? ORDER BY review_version DESC LIMIT 1`).get(workId, minimumVersion);
      return row && JSON.parse(row.review_json);
    } finally { state.close(); }
  }, `review version ${minimumVersion}`);
  const stateRows = (sql, ...args) => {
    const state = new DatabaseSync(join(root, 'assistant', 'state.sqlite'));
    try { return state.prepare(sql).all(...args); }
    finally { state.close(); }
  };
  await submit('Write exactly `# Report` to `report.md`.', 'stage-first');
  const first = await review(1);
  assert.equal(first.judgment, 'partial');
  assert.equal(await readFile(join(created.body.workingDirectory, 'report.md'), 'utf8'), '# Incomplete');
  const firstReviewFile = join(root, 'assistant', 'reviews', workId.slice('work:'.length),
    `${first.reviewId}.md`);
  await eventually(async () => (await readFile(firstReviewFile, 'utf8')).includes('Judgment: partial'),
    'persisted partial Markdown review');
  await eventually(() => stateRows(`SELECT id FROM memory_documents WHERE id='work-focus'
    AND status='active'`).length === 1, 'persisted active Work focus');
  assert.equal(stateRows(`SELECT source_id FROM source_current WHERE source_id LIKE 'work-artifact:%'
    AND availability='available'`).length, 1);
  assert.deepEqual((await readdir(join(root, 'assistant', 'skills'))).sort(),
    ['delegate-and-verify', 'follow-up', 'maintain-memory', 'organize-work',
      'review-work', 'understand-user']);
  assert.equal((await readFile(join(root, 'assistant', 'skills', 'review-work', 'SKILL.md'),
    'utf8')).includes('reviewer'), false, 'professional skill must stay outside Assistant Home');
  const assistantRun = await api('/v1/chat/submit', 'POST', { surface: 'assistant',
    clientMessageId: 'stage-delegate',
    message: 'Please verify the current Work report with the reviewer skill, without modifying it.' });
  assert.equal(assistantRun.status, 202);
  const ledger = join(root, 'workflows', 'delegation-ledger');
  const delegated = await eventually(async () => {
    const names = (await readdir(ledger)).filter((name) => name.endsWith('.json'));
    if (names.length !== 1) return undefined;
    const record = JSON.parse(await readFile(join(ledger, names[0]), 'utf8'));
    return record.status === 'completed' ? record : undefined;
  }, `read-only professional result (model calls ${modelCalls}, stderr ${stderr})`, 30_000);
  assert.equal(delegated.readOnly, true);
  assert.deepEqual(delegated.authorizedCapabilities, []);
  assert.ok(delegated.result.evidenceRefs.includes(candidate.contextRefs[0]));
  assert.ok(toolSurfaces.professional.length > 0);
  assert.ok(toolSurfaces.professional.every((tools) => !tools.includes('write')
    && !tools.includes('delegate_and_verify')));
  assert.ok(toolSurfaces.assistant.length > 0);
  assert.ok(toolSurfaces.assistant.every((tools) => !tools.includes('write')
    && !tools.includes('read_task_source')));
  assert.ok(toolSurfaces.review.length > 0);
  assert.ok(toolSurfaces.review.every((tools) => !tools.includes('write')
    && !tools.includes('delegate_and_verify')));
  const afterDelegation = await review(first.reviewVersion + 1);
  assert.equal(afterDelegation.judgment, 'partial');
  assert.ok(stateRows(`SELECT source_id FROM source_current WHERE source_id LIKE 'delegation:%'
    AND availability='available'`).length > 0, 'delegation result enters persisted source feed');
  const delegatedReviewMaterials = stateRows(`SELECT material_versions_json FROM work_reviews
    WHERE review_id=?`, afterDelegation.reviewId)[0];
  assert.ok(JSON.parse(delegatedReviewMaterials.material_versions_json).some((ref) =>
    ref.sourceId.startsWith('delegation:')), 're-review consumes delegated result source');
  await submit('Please fix report.md so it contains exactly `# Report`.', 'stage-repair');
  const second = await review(afterDelegation.reviewVersion + 1);
  assert.equal(await readFile(join(created.body.workingDirectory, 'report.md'), 'utf8'), '# Report');
  assert.equal(second.judgment, 'supported', JSON.stringify({ judgment: second.judgment,
    reviewVersion: second.reviewVersion, unresolved: second.unresolved }));
  await eventually(() => stateRows(`SELECT id FROM memory_documents WHERE id='work-focus'
    AND status='withdrawn'`).length === 1, 'persisted follow-up withdrawal after repair');
  assert.match(await readFile(firstReviewFile, 'utf8'), /Judgment: partial/u);
  const latestReviewFile = join(root, 'assistant', 'reviews', workId.slice('work:'.length),
    `${second.reviewId}.md`);
  await eventually(async () => (await readFile(latestReviewFile, 'utf8')).includes('Judgment: supported'),
    'persisted supported Markdown review');
});
