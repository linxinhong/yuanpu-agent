import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AGENT_CONTRACT_VERSION } from '@yuanpu-agent/protocol';
import { YuanpuMetadataDatabase } from '../dist/index.mjs';

const now = '2026-09-24T00:00:00.000Z';

function submit(metadata, entryPoint, conversationId, runId, piSessionId) {
  const identity = entryPoint === 'im'
    ? { kind: 'channel_user', subjectId: 'conversation-digest', authorityId: 'wecom-1', authenticatedBy: 'channel_adapter' }
    : { kind: 'local_user', subjectId: 'local-user', authorityId: 'local-desktop', authenticatedBy: 'electron' };
  return metadata.agentRuns.submit({
    request: {
      contractVersion: AGENT_CONTRACT_VERSION,
      entryPoint,
      identity,
      workspaceId: '/work',
      conversation: { namespace: entryPoint === 'im' ? 'im:wecom:account' : 'desktop', conversationId },
      input: { type: 'text', text: 'hello' },
      idempotencyKey: runId,
      delivery: { kind: entryPoint === 'im' ? 'channel' : 'desktop', ...(entryPoint === 'im' ? { routeId: 'inbound-1' } : {}) },
    },
    requestFingerprint: runId,
    inputDigest: runId,
    runId,
    bindingId: `${runId}-binding`,
    piSessionId,
    now,
    maximumQueuedRuns: 100,
  });
}

test('explicit private contact binding shares its Pi session and restores desktop history on unlink', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const metadata = new YuanpuMetadataDatabase(raw);
  metadata.channels.bindConnection({ provider: 'wecom', connectionId: 'wecom-1', providerAccountDigest: 'a'.repeat(64), credentialBindingDigest: 'b'.repeat(64), now });
  metadata.channels.pair('wecom', 'wecom-1', 'sender-digest', now);
  metadata.channels.observePrivateSender({ provider: 'wecom', connectionId: 'wecom-1', senderDigest: 'sender-digest', recipientId: 'recipient-1', now });
  const im = submit(metadata, 'im', 'single:conversation-digest', 'im-run', 'pi-im');
  assert.equal(im.kind, 'created');
  metadata.agentRuns.claimQueued('im-run', now);
  metadata.agentRuns.finish({ runId: 'im-run', status: 'succeeded', now });
  metadata.channels.acceptInbound({
    inboundId: 'inbound-1', provider: 'wecom', connectionId: 'wecom-1', providerMessageId: 'message-1',
    providerRequestId: 'request-1', senderDigest: 'sender-digest', conversationType: 'single',
    conversationDigest: 'conversation-digest', messageType: 'text', runId: 'im-run', receivedAt: now,
  });
  const contact = metadata.channels.listPrivateContacts('wecom')[0];
  assert.ok(contact);
  const link = metadata.assistantLink.bind(contact.contactId, '/work');
  assert.equal(link.piSessionId, 'pi-im');
  assert.equal(metadata.assistantLink.sessionId('assistant'), 'pi-im');
  assert.ok(metadata.assistantLink.archivedAssistantSessionId());
  assert.notEqual(metadata.assistantLink.archivedAssistantSessionId(), 'pi-im');
  assert.equal(metadata.assistantLink.current()?.contactId, contact.contactId);
  metadata.assistantLink.unbind();
  assert.equal(metadata.assistantLink.current(), undefined);
  assert.equal(metadata.assistantLink.archivedAssistantSessionId(), undefined);
  assert.notEqual(metadata.assistantLink.sessionId('assistant'), 'pi-im');
  metadata.close();
});

test('mirrored content is cleared after provider acceptance and uncertain delivery cannot retry', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const metadata = new YuanpuMetadataDatabase(raw);
  submit(metadata, 'desktop', 'assistant', 'desktop-run', 'pi-desktop');
  const mirror = metadata.assistantLink.queueMirror('desktop-run', 'user', 'target-1', 'private prompt');
  assert.equal(metadata.assistantLink.claimMirror(mirror.mirrorId), true);
  metadata.assistantLink.finishMirror(mirror.mirrorId, 'accepted');
  assert.equal(metadata.assistantLink.mirrorById(mirror.mirrorId)?.content, undefined);
  assert.equal(metadata.assistantLink.retryMirror(mirror.mirrorId), false);
  const reply = metadata.assistantLink.queueMirror('desktop-run', 'assistant', 'target-1', 'response');
  metadata.assistantLink.claimMirror(reply.mirrorId);
  metadata.assistantLink.markInterruptedMirrorsUnknown();
  assert.equal(metadata.assistantLink.mirrorById(reply.mirrorId)?.status, 'unknown');
  assert.equal(metadata.assistantLink.retryMirror(reply.mirrorId), false);
  metadata.close();
});
