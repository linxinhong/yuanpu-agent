import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_CONTRACT_VERSION, RUNTIME_ROUTES } from '@yuanpu-agent/protocol';
import {
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

test('host identity, conversation ownership, and model input remain distinct', () => {
  const validation = validateAgentRunRequest(request());
  assert.equal(validation.ok, true);
  assert.equal(validation.value.identity.subjectId, 'local-user');
  assert.equal(validation.value.conversation.conversationId, 'conversation-1');
  assert.equal(validation.value.input.text, 'Summarize the notes.');

  const spoofed = validateAgentRunRequest(request({
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
});

test('invalid requests have observable stable rejection codes', () => {
  const unsupported = validateAgentRunRequest(request({ contractVersion: 999 }));
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, 'unsupported_contract_version');

  const emptyInput = validateAgentRunRequest(request({ input: { type: 'text', text: ' ' } }));
  assert.equal(emptyInput.ok, false);
  assert.equal(emptyInput.error.code, 'invalid_request');
  assert.equal(emptyInput.error.field, 'input.text');

  const missingRoute = validateAgentRunRequest(request({ delivery: { kind: 'channel' } }));
  assert.equal(missingRoute.ok, false);
  assert.equal(missingRoute.error.field, 'delivery.routeId');
});

test('duplicate submissions replay only an identical request', () => {
  const first = resolveIdempotentSubmission(request());
  assert.equal(first.kind, 'new');
  const replay = resolveIdempotentSubmission(request(), {
    runId: 'run-1',
    status: 'running',
    requestFingerprint: first.requestFingerprint,
  });
  assert.deepEqual(replay, {
    kind: 'replay',
    result: { accepted: true, runId: 'run-1', status: 'running', duplicate: true },
  });

  const conflict = resolveIdempotentSubmission(request({
    input: { type: 'text', text: 'Different request, same key.' },
  }), {
    runId: 'run-1',
    status: 'running',
    requestFingerprint: first.requestFingerprint,
  });
  assert.equal(conflict.kind, 'rejected');
  assert.equal(conflict.result.code, 'idempotency_conflict');
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
  assert.equal(recoverAgentRunAfterRestart('queued', false), 'queued');
  assert.equal(recoverAgentRunAfterRestart('running', false), 'interrupted');
  assert.equal(recoverAgentRunAfterRestart('running', true), 'result_unknown');
  assert.equal(recoverAgentRunAfterRestart('waiting_approval', false), 'interrupted');
  assert.equal(recoverAgentRunAfterRestart('succeeded', true), 'succeeded');

  assert.equal(transitionDelivery('pending', 'start'), 'delivering');
  assert.equal(recoverDeliveryAfterRestart('delivering'), 'result_unknown');
  assert.equal(transitionDelivery('delivering', 'confirm'), 'delivered');
  assert.throws(() => transitionDelivery('result_unknown', 'confirm'), /Invalid delivery transition/);
});

test('the legacy chat route remains unchanged while AgentService is contract-only', () => {
  assert.equal(RUNTIME_ROUTES.chat, '/v1/chat');
  assert.equal('agentRuns' in RUNTIME_ROUTES, false);
});

