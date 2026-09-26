import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_CONTRACT_VERSION,
  sameAssistantAudience,
  validateAssistantIngress,
} from '../dist/index.mjs';

const principal = {
  principalId: 'owner', assistantId: 'personal-assistant', pairingId: 'explicit-pairing',
  channel: 'wecom', accountId: 'bot-a', organizationId: 'org-a', externalUserId: 'user-a',
};

function request(overrides = {}) {
  return {
    contractVersion: ASSISTANT_CONTRACT_VERSION,
    requestId: 'request-1', assistantId: principal.assistantId, principalId: principal.principalId,
    conversationId: 'conversation-1', sessionId: 'session-1',
    audience: { kind: 'personal', id: principal.principalId },
    inbound: {
      channel: 'wecom', accountId: 'bot-a', organizationId: 'org-a', externalUserId: 'user-a',
      externalConversationId: 'chat-a', threadId: 'thread-a', externalMessageId: 'message-1',
      receivedAt: '2026-09-26T00:00:00Z', text: 'Check my work',
    },
    replyTarget: {
      routeId: 'route-a', channel: 'wecom', accountId: 'bot-a', organizationId: 'org-a',
      externalConversationId: 'chat-a', threadId: 'thread-a',
    },
    acceptedAt: '2026-09-26T00:00:01Z',
    ...overrides,
  };
}

function binding(input = request()) {
  return {
    assistantId: input.assistantId, principalId: input.principalId,
    conversationId: input.conversationId, sessionId: input.sessionId,
    audience: input.audience, replyTarget: input.replyTarget,
  };
}

function validate(input, trustedPrincipal = principal, trustedBinding = binding()) {
  return validateAssistantIngress(input, trustedPrincipal, trustedBinding);
}

test('trusted pairing binds identity and reply route to the incoming scope', () => {
  assert.deepEqual(validate(request()), {
    ok: true,
    dedupKey: JSON.stringify(['wecom', 'bot-a', 'org-a', 'chat-a', 'thread-a', 'message-1']),
  });
  assert.equal(validate(request({ principalId: 'spoofed' })).code, 'identity_mismatch');
  assert.equal(validate(request({
    inbound: { ...request().inbound, externalUserId: 'other' },
  })).code, 'identity_mismatch');
  assert.equal(validate(request({
    replyTarget: { ...request().replyTarget, externalConversationId: 'other-chat' },
  })).code, 'route_mismatch');
  assert.equal(validate(request({ sessionId: 'someone-else-session' })).code, 'route_mismatch');
  assert.equal(validate(request({ audience: { kind: 'conversation', id: 'public-group' } })).code, 'route_mismatch');
  const forgedPersonal = request({ audience: { kind: 'personal', id: 'other-person' } });
  assert.equal(validate(forgedPersonal, principal, binding(forgedPersonal)).code, 'route_mismatch');
  assert.equal(validate(request({ inbound: { ...request().inbound, text: '  ' } })).code, 'invalid_request');
  assert.equal(validate(request({ inbound: {
    ...request().inbound, text: '', attachments: [{ sourceRef: 'host-attachment-1' }],
  } })).ok, true);
});

test('business dedup includes account, organization, conversation and thread', () => {
  const original = validate(request());
  const otherBot = { ...principal, accountId: 'bot-b' };
  const forOtherBot = request({
    inbound: { ...request().inbound, accountId: 'bot-b' },
    replyTarget: { ...request().replyTarget, accountId: 'bot-b' },
  });
  assert.notEqual(validate(forOtherBot, otherBot, binding(forOtherBot)).dedupKey, original.dedupKey);
  const otherThread = request({
    inbound: { ...request().inbound, threadId: 'thread-b' },
    replyTarget: { ...request().replyTarget, threadId: 'thread-b' },
  });
  assert.notEqual(validate(otherThread, principal, binding(otherThread)).dedupKey, original.dedupKey);
});

test('assistant IPC version and audience are explicit', () => {
  assert.equal(validate(request({ contractVersion: 2 })).code, 'unsupported_contract_version');
  assert.equal(sameAssistantAudience({ kind: 'conversation', id: 'group-a' },
    { kind: 'personal', id: 'owner' }), false);
  assert.equal(sameAssistantAudience({ kind: 'personal', id: 'owner' },
    { kind: 'personal', id: 'owner' }), true);
});
