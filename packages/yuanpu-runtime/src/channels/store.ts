import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { ChannelConversationType } from './contracts.js';

export type ChannelOutboundStatus = 'pending' | 'delivering' | 'accepted' | 'failed' | 'unknown';

export interface ChannelInboundRoute {
  inboundId: string;
  provider: string;
  connectionId: string;
  providerMessageId: string;
  providerRequestId: string;
  senderDigest: string;
  conversationType: ChannelConversationType;
  conversationDigest: string;
  messageType: string;
  contentDigest?: string;
  pendingInput?: string;
  action?: 'run' | 'cancel' | 'unsupported';
  cancelTargetRunId?: string;
  runId?: string;
  receivedAt: string;
}

export interface ChannelOutboundRecord {
  outboundId: string;
  inboundId: string;
  runId?: string;
  contentDigest: string;
  status: ChannelOutboundStatus;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateContactSummary {
  contactId: string;
  connectionId: string;
  lastSeenAt: string;
  boundRouteId?: string;
}

export interface BoundPrivateTarget {
  connectionId: string;
  recipientId: string;
}

interface InboundRow {
  inbound_id: string;
  provider: string;
  connection_id: string;
  provider_message_id: string;
  provider_request_id: string;
  sender_digest: string;
  conversation_type: ChannelConversationType;
  conversation_digest: string;
  message_type: string;
  content_digest: string | null;
  input_text: string | null;
  action: 'run' | 'cancel' | 'unsupported';
  cancel_target_run_id: string | null;
  run_id: string | null;
  received_at: string;
}

interface OutboundRow {
  outbound_id: string;
  inbound_id: string;
  run_id: string | null;
  content_digest: string;
  status: ChannelOutboundStatus;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

function inboundFromRow(row: InboundRow): ChannelInboundRoute {
  return {
    inboundId: row.inbound_id,
    provider: row.provider,
    connectionId: row.connection_id,
    providerMessageId: row.provider_message_id,
    providerRequestId: row.provider_request_id,
    senderDigest: row.sender_digest,
    conversationType: row.conversation_type,
    conversationDigest: row.conversation_digest,
    messageType: row.message_type,
    ...(row.content_digest ? { contentDigest: row.content_digest } : {}),
    ...(row.input_text ? { pendingInput: row.input_text } : {}),
    action: row.action,
    ...(row.cancel_target_run_id ? { cancelTargetRunId: row.cancel_target_run_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    receivedAt: row.received_at,
  };
}

function outboundFromRow(row: OutboundRow): ChannelOutboundRecord {
  return {
    outboundId: row.outbound_id,
    inboundId: row.inbound_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    contentDigest: row.content_digest,
    status: row.status,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ChannelStore {
  constructor(private readonly database: DatabaseSync) {}

  bindConnection(input: {
    provider: string;
    connectionId: string;
    providerAccountDigest: string;
    credentialBindingDigest: string;
    now: string;
  }): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO yp_channel_connections(
        provider, connection_id, provider_account_digest, credential_binding_digest, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.provider,
      input.connectionId,
      input.providerAccountDigest,
      input.credentialBindingDigest,
      input.now,
    );
    const row = this.database.prepare(`
      SELECT provider_account_digest, credential_binding_digest
      FROM yp_channel_connections WHERE provider = ? AND connection_id = ?
    `).get(input.provider, input.connectionId) as {
      provider_account_digest: string;
      credential_binding_digest: string;
    } | undefined;
    if (
      !row
      || row.provider_account_digest !== input.providerAccountDigest
      || row.credential_binding_digest !== input.credentialBindingDigest
    ) {
      throw new Error('Channel connection identity cannot be changed in place.');
    }
  }

  pair(provider: string, connectionId: string, senderDigest: string, now: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO yp_channel_pairings(provider, connection_id, sender_digest, created_at)
      VALUES (?, ?, ?, ?)
    `).run(provider, connectionId, senderDigest, now);
  }

  unpair(provider: string, connectionId: string, senderDigest: string): void {
    this.database.prepare(`
      DELETE FROM yp_channel_private_contacts
      WHERE provider = ? AND connection_id = ? AND sender_digest = ?
    `).run(provider, connectionId, senderDigest);
    this.database.prepare(`
      DELETE FROM yp_channel_pairings
      WHERE provider = ? AND connection_id = ? AND sender_digest = ?
    `).run(provider, connectionId, senderDigest);
  }

  observePrivateSender(input: {
    provider: string;
    connectionId: string;
    senderDigest: string;
    recipientId: string;
    now: string;
  }): void {
    this.database.prepare(`
      INSERT INTO yp_channel_private_contacts(
        contact_id, provider, connection_id, sender_digest, recipient_id, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, connection_id, sender_digest)
      DO UPDATE SET recipient_id = excluded.recipient_id, last_seen_at = excluded.last_seen_at
    `).run(randomUUID(), input.provider, input.connectionId, input.senderDigest, input.recipientId, input.now);
  }

  listPrivateContacts(provider: string): PrivateContactSummary[] {
    const rows = this.database.prepare(`
      SELECT c.contact_id, c.connection_id, c.last_seen_at, c.bound_target_id
      FROM yp_channel_private_contacts c
      JOIN yp_channel_pairings p
        ON p.provider = c.provider AND p.connection_id = c.connection_id
        AND p.sender_digest = c.sender_digest
      WHERE c.provider = ? AND c.recipient_id IS NOT NULL
      ORDER BY c.last_seen_at DESC
    `).all(provider) as Array<{
      contact_id: string;
      connection_id: string;
      last_seen_at: string;
      bound_target_id: string | null;
    }>;
    return rows.map((row) => ({
      contactId: row.contact_id,
      connectionId: row.connection_id,
      lastSeenAt: row.last_seen_at,
      ...(row.bound_target_id ? { boundRouteId: row.bound_target_id } : {}),
    }));
  }

  bindPrivateContact(contactId: string, connectionId: string): string | undefined {
    const row = this.database.prepare(`
      SELECT c.bound_target_id, c.recipient_id
      FROM yp_channel_private_contacts c
      JOIN yp_channel_pairings p
        ON p.provider = c.provider AND p.connection_id = c.connection_id
        AND p.sender_digest = c.sender_digest
      WHERE c.contact_id = ? AND c.provider = 'wecom' AND c.connection_id = ?
    `).get(contactId, connectionId) as { bound_target_id: string | null; recipient_id: string | null } | undefined;
    if (!row?.recipient_id) return undefined;
    if (row.bound_target_id) return row.bound_target_id;
    const targetId = `imtarget:${randomUUID()}`;
    const updated = this.database.prepare(`
      UPDATE yp_channel_private_contacts SET bound_target_id = ?
      WHERE contact_id = ? AND connection_id = ? AND recipient_id IS NOT NULL AND bound_target_id IS NULL
    `).run(targetId, contactId, connectionId);
    return updated.changes === 1 ? targetId : undefined;
  }

  getBoundPrivateTarget(targetId: string, connectionId: string): BoundPrivateTarget | undefined {
    const row = this.database.prepare(`
      SELECT c.connection_id, c.recipient_id
      FROM yp_channel_private_contacts c
      JOIN yp_channel_pairings p
        ON p.provider = c.provider AND p.connection_id = c.connection_id
        AND p.sender_digest = c.sender_digest
      WHERE c.bound_target_id = ? AND c.provider = 'wecom' AND c.connection_id = ?
        AND c.recipient_id IS NOT NULL
    `).get(targetId, connectionId) as { connection_id: string; recipient_id: string } | undefined;
    return row ? { connectionId: row.connection_id, recipientId: row.recipient_id } : undefined;
  }

  revokePrivateTarget(targetId: string): string | undefined {
    const row = this.database.prepare(`
      SELECT connection_id FROM yp_channel_private_contacts
      WHERE bound_target_id = ? AND provider = 'wecom'
    `).get(targetId) as { connection_id: string } | undefined;
    if (!row) return undefined;
    this.database.prepare(`
      UPDATE yp_channel_private_contacts
      SET bound_target_id = NULL, recipient_id = NULL
      WHERE bound_target_id = ? AND provider = 'wecom'
    `).run(targetId);
    return row.connection_id;
  }

  isPaired(provider: string, connectionId: string, senderDigest: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM yp_channel_pairings
      WHERE provider = ? AND connection_id = ? AND sender_digest = ?
    `).get(provider, connectionId, senderDigest));
  }

  acceptInbound(input: ChannelInboundRoute): { inserted: boolean; record: ChannelInboundRoute } {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO yp_channel_inbound(
        inbound_id, provider, connection_id, provider_message_id, provider_request_id,
        sender_digest, conversation_type, conversation_digest, message_type,
        content_digest, input_text, action, cancel_target_run_id, run_id, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.inboundId,
      input.provider,
      input.connectionId,
      input.providerMessageId,
      input.providerRequestId,
      input.senderDigest,
      input.conversationType,
      input.conversationDigest,
      input.messageType,
      input.contentDigest ?? null,
      input.pendingInput ?? null,
      input.action ?? 'run',
      input.cancelTargetRunId ?? null,
      input.runId ?? null,
      input.receivedAt,
    ).changes === 1;
    const row = this.database.prepare(`
      SELECT * FROM yp_channel_inbound
      WHERE provider = ? AND connection_id = ? AND provider_message_id = ?
    `).get(input.provider, input.connectionId, input.providerMessageId) as unknown as InboundRow;
    return { inserted, record: inboundFromRow(row) };
  }

  attachRun(inboundId: string, runId: string): ChannelInboundRoute {
    this.database.prepare(`
      UPDATE yp_channel_inbound
      SET run_id = COALESCE(run_id, ?), input_text = NULL
      WHERE inbound_id = ?
    `).run(runId, inboundId);
    return this.getInbound(inboundId)!;
  }

  getInbound(inboundId: string): ChannelInboundRoute | undefined {
    const row = this.database.prepare(
      'SELECT * FROM yp_channel_inbound WHERE inbound_id = ?',
    ).get(inboundId) as unknown as InboundRow | undefined;
    return row ? inboundFromRow(row) : undefined;
  }

  clearPendingInput(inboundId: string): void {
    this.database.prepare(
      'UPDATE yp_channel_inbound SET input_text = NULL WHERE inbound_id = ?',
    ).run(inboundId);
  }

  pendingInbound(provider: string, connectionId: string): ChannelInboundRoute[] {
    const rows = this.database.prepare(`
      SELECT * FROM yp_channel_inbound
      WHERE provider = ? AND connection_id = ? AND run_id IS NULL AND input_text IS NOT NULL
      ORDER BY received_at
    `).all(provider, connectionId) as unknown as InboundRow[];
    return rows.map(inboundFromRow);
  }

  latestRunId(provider: string, connectionId: string, conversationDigest: string): string | undefined {
    const row = this.database.prepare(`
      SELECT run_id FROM yp_channel_inbound
      WHERE provider = ? AND connection_id = ? AND conversation_digest = ? AND run_id IS NOT NULL
      ORDER BY received_at DESC LIMIT 1
    `).get(provider, connectionId, conversationDigest) as { run_id: string } | undefined;
    return row?.run_id;
  }

  recoverableInbound(provider: string, connectionId: string): ChannelInboundRoute[] {
    const rows = this.database.prepare(`
      SELECT i.* FROM yp_channel_inbound i
      LEFT JOIN yp_channel_outbound o ON o.inbound_id = i.inbound_id
      WHERE i.provider = ? AND i.connection_id = ? AND i.run_id IS NOT NULL
        AND (o.outbound_id IS NULL OR o.status = 'pending')
      ORDER BY i.received_at
    `).all(provider, connectionId) as unknown as InboundRow[];
    return rows.map(inboundFromRow);
  }

  recoverableUnsupported(provider: string, connectionId: string): ChannelInboundRoute[] {
    const rows = this.database.prepare(`
      SELECT i.* FROM yp_channel_inbound i
      LEFT JOIN yp_channel_outbound o ON o.inbound_id = i.inbound_id
      WHERE i.provider = ? AND i.connection_id = ? AND i.action = 'unsupported'
        AND (o.outbound_id IS NULL OR o.status = 'pending')
      ORDER BY i.received_at
    `).all(provider, connectionId) as unknown as InboundRow[];
    return rows.map(inboundFromRow);
  }

  createOutbound(input: ChannelOutboundRecord): { inserted: boolean; record: ChannelOutboundRecord } {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO yp_channel_outbound(
        outbound_id, inbound_id, run_id, content_digest, status,
        failure_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.outboundId,
      input.inboundId,
      input.runId ?? null,
      input.contentDigest,
      input.status,
      input.failureCode ?? null,
      input.createdAt,
      input.updatedAt,
    ).changes === 1;
    const row = this.database.prepare(
      'SELECT * FROM yp_channel_outbound WHERE inbound_id = ?',
    ).get(input.inboundId) as unknown as OutboundRow;
    return { inserted, record: outboundFromRow(row) };
  }

  claimOutbound(outboundId: string, now: string): boolean {
    return this.database.prepare(`
      UPDATE yp_channel_outbound SET status = 'delivering', updated_at = ?
      WHERE outbound_id = ? AND status = 'pending'
    `).run(now, outboundId).changes === 1;
  }

  finishOutbound(
    outboundId: string,
    status: Extract<ChannelOutboundStatus, 'accepted' | 'failed' | 'unknown'>,
    now: string,
    failureCode?: string,
  ): ChannelOutboundRecord {
    this.database.prepare(`
      UPDATE yp_channel_outbound SET status = ?, failure_code = ?, updated_at = ?
      WHERE outbound_id = ? AND status = 'delivering'
    `).run(status, failureCode ?? null, now, outboundId);
    return this.getOutbound(outboundId)!;
  }

  markDeliveringUnknown(provider: string, connectionId: string, now: string): number {
    return Number(this.database.prepare(`
      UPDATE yp_channel_outbound SET status = 'unknown', failure_code = 'process_interrupted', updated_at = ?
      WHERE status = 'delivering' AND inbound_id IN (
        SELECT inbound_id FROM yp_channel_inbound WHERE provider = ? AND connection_id = ?
      )
    `).run(now, provider, connectionId).changes);
  }

  getOutbound(outboundId: string): ChannelOutboundRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM yp_channel_outbound WHERE outbound_id = ?',
    ).get(outboundId) as unknown as OutboundRow | undefined;
    return row ? outboundFromRow(row) : undefined;
  }

  getOutboundForRun(runId: string): ChannelOutboundRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM yp_channel_outbound WHERE run_id = ?',
    ).get(runId) as unknown as OutboundRow | undefined;
    return row ? outboundFromRow(row) : undefined;
  }

  getOutboundForInbound(inboundId: string): ChannelOutboundRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM yp_channel_outbound WHERE inbound_id = ?',
    ).get(inboundId) as unknown as OutboundRow | undefined;
    return row ? outboundFromRow(row) : undefined;
  }
}
