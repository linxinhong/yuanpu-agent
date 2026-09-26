import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import { YuanpuMetadataDatabase, readYuanpuChatTranscript } from '../dist/index.mjs';

const now = '2026-09-26T00:00:00.000Z';

function fixture() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const metadata = new YuanpuMetadataDatabase(raw);
  metadata.channels.bindConnection({ provider: 'wecom', connectionId: 'bot-1',
    providerAccountDigest: 'a'.repeat(64), credentialBindingDigest: 'b'.repeat(64), now });
  metadata.channels.pair('wecom', 'bot-1', 'sender-1', now);
  metadata.channels.observePrivateSender({ provider: 'wecom', connectionId: 'bot-1',
    senderDigest: 'sender-1', recipientId: 'member-1', now });
  const contact = metadata.channels.listPrivateContacts('wecom')[0];
  return { raw, metadata, contact };
}

test('desktop and paired WeCom retain distinct sessions, with one durable request per scoped message ID', () => {
  const { metadata, contact } = fixture();
  try {
    const desktop = metadata.assistantHost.desktop();
    const wecom = metadata.assistantHost.linkWecomContact(contact.contactId);
    assert.equal(desktop.principalId, wecom.principalId);
    assert.notEqual(desktop.sessionId, wecom.sessionId);
    assert.equal(metadata.assistantHost.wecomForMessage('bot-1', 'member-2', 'member-2'), undefined);
    assert.equal(metadata.assistantHost.wecomForMessage('bot-1', 'member-1', 'member-1')?.sessionId, wecom.sessionId);
    const input = { dedupKey: JSON.stringify(['wecom', 'bot-1', '', 'member-1', '', 'msg-1']),
      channel: 'wecom', conversationId: wecom.conversationId, sessionId: wecom.sessionId,
      principalId: wecom.principalId, bindingGeneration: wecom.generation,
      accountId: 'bot-1', externalUserId: 'member-1',
      externalConversationId: 'member-1', externalMessageId: 'msg-1', providerRequestId: 'req-1', text: 'hello' };
    const first = metadata.assistantHost.accept(input);
    assert.equal(first.duplicate, false);
    const repeat = metadata.assistantHost.accept({ ...input, providerRequestId: 'req-new' });
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.record.requestId, first.record.requestId);
    assert.equal(repeat.record.providerRequestId, 'req-1');
    assert.throws(() => metadata.assistantHost.accept({ ...input, text: 'different' }), /Conflicting/);
    metadata.assistantHost.finish(first.record.requestId, 'completed', 'world');
    assert.equal(metadata.assistantHost.transcript(wecom.conversationId).length, 2);
    assert.equal(metadata.assistantHost.transcript(desktop.conversationId).length, 0);
    const source = metadata.assistantHost.sourceChanges()[0];
    assert.equal(source.eventId, 1);
    assert.equal(source.change.audience.id, desktop.principalId);
    assert.deepEqual(metadata.assistantHost.resolveContentRef(source.change.contentRef, desktop.principalId),
      { userText: 'hello', assistantText: 'world' });
    assert.equal(metadata.assistantHost.resolveContentRef(source.change.contentRef, 'other-user'), undefined);
    assert.deepEqual(metadata.assistantHost.sourceChanges(1), []);
  } finally { metadata.close(); }
});

test('delivery unknown is sticky; old link migration preserves old row and explicit unlink survives restart', () => {
  const { raw, metadata, contact } = fixture();
  try {
    raw.prepare(`INSERT INTO yp_desktop_assistant_link(id, contact_id, connection_id, target_id,
      previous_pi_session_id, linked_pi_session_id, updated_at) VALUES (1, ?, 'bot-1', 'target-1',
      'old-desktop', 'old-wecom', ?)`).run(contact.contactId, now);
    metadata.assistantHost.migrateLegacyLink();
    const link = metadata.assistantHost.wecomLink();
    assert.equal(link.contactId, contact.contactId);
    assert.notEqual(link.sessionId, 'old-wecom');
    assert.deepEqual(metadata.assistantLink.legacySessionIds(), ['old-desktop', 'old-wecom']);
    const accepted = metadata.assistantHost.accept({ dedupKey: 'request-2', channel: 'wecom',
      conversationId: link.conversationId, sessionId: link.sessionId, principalId: link.principalId,
      bindingGeneration: link.generation,
      accountId: 'bot-1', externalUserId: 'member-1', externalConversationId: 'member-1',
      externalMessageId: 'msg-2', providerRequestId: 'req-2', text: 'hi' }).record;
    metadata.assistantHost.finish(accepted.requestId, 'completed', 'reply');
    assert.equal(metadata.assistantHost.beginDelivery(accepted.requestId), true);
    metadata.assistantHost.markUncertainDeliveries();
    assert.equal(metadata.assistantHost.delivery(accepted.requestId).status, 'unknown');
    assert.equal(metadata.assistantHost.beginDelivery(accepted.requestId), false);
    assert.equal(metadata.assistantHost.pendingReplies('bot-1').length, 0);
    metadata.assistantHost.unlinkWecom();
    metadata.assistantHost.migrateLegacyLink();
    assert.equal(metadata.assistantHost.wecomLink(), undefined);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM yp_desktop_assistant_link').get().count, 1);
  } finally { metadata.close(); }
});

test('revoked pair blocks migrated owner access without destroying historical requests', () => {
  const { metadata, contact } = fixture();
  try {
    const link = metadata.assistantHost.linkWecomContact(contact.contactId);
    metadata.channels.unpair('wecom', 'bot-1', 'sender-1');
    assert.equal(metadata.assistantHost.wecomLink(), undefined);
    assert.equal(metadata.assistantHost.wecomForMessage('bot-1', 'member-1', 'member-1'), undefined);
    assert.equal(link.principalId, metadata.assistantHost.desktop().principalId);
  } finally { metadata.close(); }
});

test('legacy archive and assistant turns expose ordered, repeatable personal source events', () => {
  const { metadata } = fixture();
  try {
    const archive = [{ id: 'legacy:1', role: 'user', text: 'old question', at: now },
      { id: 'legacy:2', role: 'assistant', text: 'old reply', at: now }];
    metadata.assistantHost.recordLegacyArchive('legacy-session', archive);
    metadata.assistantHost.recordLegacyArchive('legacy-session', archive);
    const first = metadata.assistantHost.sourceChanges();
    assert.equal(first.length, 1);
    assert.equal(first[0].change.kind, 'created');
    assert.deepEqual(metadata.assistantHost.resolveContentRef(first[0].change.contentRef, 'local-user'),
      { transcript: archive });
    metadata.assistantHost.recordLegacyArchive('legacy-session', [...archive,
      { id: 'legacy:3', role: 'user', text: 'later', at: now }]);
    const update = metadata.assistantHost.sourceChanges(first[0].eventId);
    assert.equal(update.length, 1);
    assert.equal(update[0].change.kind, 'updated');
    assert.equal(update[0].change.sourceId, first[0].change.sourceId);
    assert.notEqual(update[0].change.sourceVersion, first[0].change.sourceVersion);
    assert.equal(metadata.assistantHost.resolveContentRef(first[0].change.contentRef, 'another'), undefined);
  } finally { metadata.close(); }
});

test('legacy assistant archive scan preserves messages older than the default transcript window', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-assistant-archive-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const session = SessionManager.create(workspace, join(root, 'sessions'), { id: 'old-assistant' });
  for (let index = 0; index < 60; index++) {
    session.appendMessage({ role: 'user', content: `legacy message ${index}`, timestamp: Date.now() });
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `legacy answer ${index}` }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
  }
  const transcript = readYuanpuChatTranscript(workspace, 'old-assistant', join(root, 'sessions'),
    Number.MAX_SAFE_INTEGER);
  assert.equal(transcript.length, 120);
  assert.equal(transcript[0].text, 'legacy message 0');
  const { metadata } = fixture();
  try {
    metadata.assistantHost.recordLegacyArchive('old-assistant', transcript);
    const source = metadata.assistantHost.sourceChanges()[0];
    const content = metadata.assistantHost.resolveContentRef(source.change.contentRef, 'local-user');
    assert.equal(content.transcript.length, 120);
    assert.equal(content.transcript[0].text, 'legacy message 0');
  } finally { metadata.close(); }
});
