import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_CONTRACT_VERSION, RUNTIME_ROUTES } from '@yuanpu-agent/protocol';
import {
  canCallerAccessAgentRun,
  cancellationForRun,
  recoverAgentRunAfterRestart,
  recoverDeliveryAfterRestart,
  resolveIdempotentSubmission,
  transitionAgentRun,
  transitionDelivery,
  validateAgentRunRequest,
} from '../dist/index.mjs';

function request(overrides = {}) {
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    entryPoint: 'desktop',
    identity: {
      kind: 'local_user',
      subjectId: 'local-user',
      authorityId: 'desktop-instance',
      authenticatedBy: 'electron',
    },
    workspaceId: '/workspace',
    conversation: { namespace: 'desktop', conversationId: 'conversation-1' },
    input: { type: 'text', text: 'Summarize the notes.' },
    idempotencyKey: 'desktop-message-1',
    delivery: { kind: 'desktop' },
    ...overrides,
  };
}

function caller(overrides = {}) {
  return {
    entryPoint: 'desktop',
    identity: {
      kind: 'local_user',
      subjectId: 'local-user',
      authorityId: 'desktop-instance',
      authenticatedBy: 'electron',
    },
    authorizeWorkspace: (workspaceId) => workspaceId === '/workspace',
    authorizeConversation: (conversation) => conversation.namespace === 'desktop',
    authorizeDelivery: (delivery) => delivery.kind === 'desktop',
    ...overrides,
  };
}

test('host identity, conversation ownership, and model input remain distinct', () => {
  const validation = validateAgentRunRequest(caller(), request());
  assert.equal(validation.ok, true);
  assert.equal(validation.value.identity.subjectId, 'local-user');
  assert.equal(validation.value.conversation.conversationId, 'conversation-1');
  assert.equal(validation.value.input.text, 'Summarize the notes.');

  const spoofed = validateAgentRunRequest(caller({
    entryPoint: 'im',
    identity: {
      kind: 'channel_user',
      subjectId: 'authenticated-user',
      authorityId: 'channel-connection',
      authenticatedBy: 'channel_adapter',
    },
  }), request({
    entryPoint: 'im',
    identity: {
      kind: 'local_user',
      subjectId: 'claimed-in-message-body',
      authorityId: 'channel-connection',
      authenticatedBy: 'electron',
    },
  }));
  assert.deepEqual(spoofed, {
    ok: false,
    error: {
      accepted: false,
      code: 'identity_mismatch',
      message: 'identity kind/authenticator does not match the im entry point.',
      field: 'identity',
    },
  });
  const forgedSubject = validateAgentRunRequest(caller(), request({
    identity: { ...request().identity, subjectId: 'other-local-user' },
  }));
  assert.equal(forgedSubject.ok, false);
  assert.equal(forgedSubject.error.code, 'identity_mismatch');
  assert.equal(forgedSubject.error.message, 'identity does not match the authenticated caller.');
});

test('invalid requests have observable stable rejection codes', () => {
  const unsupported = validateAgentRunRequest(caller(), request({ contractVersion: 999 }));
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, 'unsupported_contract_version');

  const emptyInput = validateAgentRunRequest(caller(), request({ input: { type: 'text', text: ' ' } }));
  assert.equal(emptyInput.ok, false);
  assert.equal(emptyInput.error.code, 'invalid_request');
  assert.equal(emptyInput.error.field, 'input.text');

  const missingRoute = validateAgentRunRequest(caller(), request({ delivery: { kind: 'channel' } }));
  assert.equal(missingRoute.ok, false);
  assert.equal(missingRoute.error.field, 'delivery.routeId');
});

test('trusted caller policy owns workspace, conversation binding, and delivery route', () => {
  const policyCaller = caller({
    authorizeWorkspace: (workspaceId) => workspaceId === '/allowed',
    authorizeConversation: (conversation) => conversation.sessionBindingId === 'owned-binding',
    authorizeDelivery: (delivery) => delivery.kind === 'channel' && delivery.routeId === 'owned-route',
  });
  const base = request({
    workspaceId: '/allowed',
    conversation: {
      namespace: 'desktop', conversationId: 'conversation-1', sessionBindingId: 'owned-binding',
    },
    delivery: { kind: 'channel', routeId: 'owned-route' },
  });
  assert.equal(validateAgentRunRequest(policyCaller, base).ok, true);

  const wrongWorkspace = validateAgentRunRequest(policyCaller, { ...base, workspaceId: '/other' });
  assert.equal(wrongWorkspace.error.code, 'forbidden');
  assert.equal(wrongWorkspace.error.field, 'workspaceId');
  const wrongBinding = validateAgentRunRequest(policyCaller, {
    ...base,
    conversation: { ...base.conversation, sessionBindingId: 'other-binding' },
  });
  assert.equal(wrongBinding.error.field, 'conversation');
  const wrongRoute = validateAgentRunRequest(policyCaller, {
    ...base,
    delivery: { kind: 'channel', routeId: 'other-route' },
  });
  assert.equal(wrongRoute.error.field, 'delivery');
});

test('stored run access rejects another authenticated subject on the same authority', () => {
  const validated = validateAgentRunRequest(caller(), request());
  assert.equal(validated.ok, true);
  const run = {
    runId: 'run-1',
    owner: {
      entryPoint: validated.value.entryPoint,
      identity: validated.value.identity,
    },
    context: {
      workspaceId: validated.value.workspaceId,
      conversation: validated.value.conversation,
      delivery: validated.value.delivery,
    },
    requestFingerprint: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64),
    status: 'queued',
    externalEffectState: 'none',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
  assert.equal(canCallerAccessAgentRun(caller(), run), true);
  assert.equal(canCallerAccessAgentRun(caller({
    identity: { ...caller().identity, subjectId: 'other-user' },
  }), run), false);
});

test('duplicate submissions replay only an identical request', () => {
  const first = resolveIdempotentSubmission(caller(), request());
  assert.equal(first.kind, 'new');
  const replay = resolveIdempotentSubmission(caller(), request(), {
    runId: 'run-1',
    status: 'running',
    requestFingerprint: first.requestFingerprint,
    owner: { entryPoint: 'desktop', authorityId: 'desktop-instance', subjectId: 'local-user' },
  });
  assert.deepEqual(replay, {
    kind: 'replay',
    result: { accepted: true, runId: 'run-1', status: 'running', duplicate: true },
  });

  const conflict = resolveIdempotentSubmission(caller(), request({
    input: { type: 'text', text: 'Different request, same key.' },
  }), {
    runId: 'run-1',
    status: 'running',
    requestFingerprint: first.requestFingerprint,
    owner: { entryPoint: 'desktop', authorityId: 'desktop-instance', subjectId: 'local-user' },
  });
  assert.equal(conflict.kind, 'rejected');
  assert.equal(conflict.result.code, 'idempotency_conflict');

  const wrongOwner = resolveIdempotentSubmission(caller(), request(), {
    runId: 'run-other',
    status: 'queued',
    requestFingerprint: first.requestFingerprint,
    owner: { entryPoint: 'desktop', authorityId: 'desktop-instance', subjectId: 'other-user' },
  });
  assert.equal(wrongOwner.kind, 'rejected');
  assert.equal(wrongOwner.result.code, 'identity_mismatch');
});

test('run transitions cover queueing, approval, completion, and invalid terminal changes', () => {
  assert.equal(transitionAgentRun('queued', 'start'), 'running');
  assert.equal(transitionAgentRun('running', 'await_approval'), 'waiting_approval');
  assert.equal(transitionAgentRun('waiting_approval', 'approval_granted'), 'running');
  assert.equal(transitionAgentRun('running', 'succeed'), 'succeeded');
  assert.throws(() => transitionAgentRun('succeeded', 'start'), /Invalid Agent run transition/);
});

test('queued cancellation is final while active cancellation requires worker observation', () => {
  assert.deepEqual(cancellationForRun('run-queued', 'queued'), {
    runId: 'run-queued', result: 'cancelled', status: 'cancelled',
  });
  assert.deepEqual(cancellationForRun('run-active', 'waiting_approval'), {
    runId: 'run-active', result: 'cancellation_requested', status: 'waiting_approval',
  });
  assert.deepEqual(cancellationForRun('run-done', 'succeeded'), {
    runId: 'run-done', result: 'already_terminal', status: 'succeeded',
  });
  assert.deepEqual(cancellationForRun('missing', undefined), {
    runId: 'missing', result: 'not_found',
  });
});

test('restart recovery never claims an uncertain run or delivery succeeded', () => {
  assert.equal(recoverAgentRunAfterRestart('queued', 'none'), 'queued');
  assert.equal(recoverAgentRunAfterRestart('running', 'none'), 'interrupted');
  assert.equal(recoverAgentRunAfterRestart('running', 'possible'), 'result_unknown');
  assert.equal(recoverAgentRunAfterRestart('waiting_approval', 'none'), 'interrupted');
  assert.equal(recoverAgentRunAfterRestart('succeeded', 'possible'), 'succeeded');

  assert.equal(transitionDelivery('pending', 'start'), 'delivering');
  assert.equal(recoverDeliveryAfterRestart('delivering'), 'result_unknown');
  assert.equal(transitionDelivery('result_unknown', 'retry_idempotent'), 'delivering');
  assert.equal(transitionDelivery('delivering', 'confirm'), 'delivered');
  assert.throws(() => transitionDelivery('result_unknown', 'start'), /Invalid delivery transition/);
});

test('the legacy chat route remains unchanged while AgentService is contract-only', () => {
  assert.equal(RUNTIME_ROUTES.chat, '/v1/chat');
  assert.equal('agentRuns' in RUNTIME_ROUTES, false);
});
