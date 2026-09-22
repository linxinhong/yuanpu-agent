import { createHash } from 'node:crypto';

export type ChannelConversationType = 'single' | 'group';

export interface NormalizedChannelMessage {
  provider: 'wecom';
  connectionId: string;
  providerBotId: string;
  providerRequestId: string;
  providerMessageId: string;
  senderId: string;
  conversationType: ChannelConversationType;
  conversationId: string;
  messageType: string;
  text?: string;
}

export interface ChannelReplyRoute {
  providerRequestId: string;
  providerMessageId: string;
}

export type ChannelDeliveryResult =
  | { status: 'accepted' }
  | { status: 'failed'; code: string }
  | { status: 'unknown'; code: string };

export interface ChannelTransport {
  connect(onMessage: (message: NormalizedChannelMessage) => void): void;
  reply(route: ChannelReplyRoute, outboundId: string, content: string): Promise<ChannelDeliveryResult>;
  close(): Promise<void> | void;
}

export interface ChannelConnectionConfig {
  provider: 'wecom';
  connectionId: string;
  providerAccountRef: string;
  workspaceId: string;
  acceptedMessageTypes: readonly ['text'];
  pairedSenderDigests: readonly string[];
  groupEnabled: boolean;
  groupAllowlistDigests: readonly string[];
}

export type ChannelInboundReceipt =
  | { accepted: true; duplicate: boolean; runId: string }
  | {
    accepted: false;
    code: 'wrong_connection' | 'wrong_bot' | 'unpaired' | 'group_disabled'
      | 'group_not_allowed' | 'unsupported_message' | 'invalid_message' | 'submission_rejected';
  };

export function digestChannelValue(connectionId: string, kind: string, value: string): string {
  return createHash('sha256')
    .update('yuanpu-channel-v1\0')
    .update(connectionId)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(value)
    .digest('hex');
}

export function contentDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
