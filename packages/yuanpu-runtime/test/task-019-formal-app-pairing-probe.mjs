import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WecomSdkTransport, digestChannelValue } from '../dist/index.mjs';

const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
const configPath = join(process.env.HOME ?? '', '.yuanpu', 'app', 'connections', 'wecom.json');
if (!botId || !secret || !process.env.HOME) {
  console.log(JSON.stringify({ status: 'missing_variables' }));
  process.exitCode = 1;
} else {
  let transport;
  let timer;
  let temporaryPath;
  let inboundSeen = 0;
  let matched = 0;
  const sdkEvents = {};
  const challenge = `Yuanpu-019-pair-${randomBytes(4).toString('hex')}`;
  try {
    const original = await readFile(configPath, 'utf8');
    const originalDigest = createHash('sha256').update(original).digest('hex');
    const document = JSON.parse(original);
    const connection = document?.connections?.[0];
    if (
      document.schemaVersion !== 1
      || document.connections.length !== 1
      || connection?.provider !== 'wecom'
      || connection.enabled !== false
      || !/^[A-Za-z0-9._-]{1,128}$/.test(connection.connectionId)
      || connection.groupEnabled === true
      || (connection.pairedSenderDigests?.length ?? 0) !== 0
    ) throw new Error('configuration_precondition_failed');
    const connectionId = connection.connectionId;
    let resolveMatch;
    const matchedMessage = new Promise((resolve) => { resolveMatch = resolve; });
    transport = new WecomSdkTransport({
      connectionId,
      botId,
      secret,
      log: ({ event }) => { sdkEvents[event] = (sdkEvents[event] ?? 0) + 1; },
    });
    transport.connect(async (message) => {
      inboundSeen += 1;
      if (
        matched !== 0
        || message.conversationType !== 'single'
        || message.messageType !== 'text'
        || message.text?.trim() !== challenge
      ) return;
      matched = 1;
      resolveMatch(digestChannelValue(connectionId, 'sender', message.senderId));
    });
    const authenticated = await Promise.race([
      transport.ready().then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 15_000); }),
    ]);
    clearTimeout(timer);
    if (!authenticated) throw new Error('authentication_timeout');
    console.log(JSON.stringify({ status: 'ready', challenge }));
    const senderDigest = await Promise.race([
      matchedMessage,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 180_000); }),
    ]);
    clearTimeout(timer);
    if (!senderDigest) throw new Error('message_timeout');
    await transport.close();
    transport = undefined;
    const current = await readFile(configPath, 'utf8');
    if (createHash('sha256').update(current).digest('hex') !== originalDigest) {
      throw new Error('configuration_changed');
    }
    const backupPath = `${configPath}.task019-before-pairing.bak`;
    await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
    const updated = {
      ...connection,
      enabled: true,
      providerAccountRef: botId,
      credentialRefs: { botSecret: `keychain:yuanpu/im/${connectionId}/bot-secret` },
      directMessagePolicy: 'paired-only',
      groupPolicy: 'allowlist-paired-sender-and-provider-at-mention',
      groupEnabled: false,
      pairedSenderDigests: [senderDigest],
      groupAllowlistDigests: [],
      acceptedMessageTypes: ['text'],
    };
    document.connections = [updated];
    temporaryPath = `${configPath}.task019-${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, configPath);
    temporaryPath = undefined;
    console.log(JSON.stringify({ status: 'configured', inboundSeen, matched, pairedCount: 1, sdkEvents }));
  } catch (error) {
    const known = error instanceof Error && [
      'configuration_precondition_failed',
      'configuration_changed',
      'authentication_timeout',
      'message_timeout',
    ].includes(error.message) ? error.message : 'probe_error';
    console.log(JSON.stringify({
      status: known, inboundSeen, matched,
      transportReady: transport?.isReady() ?? false,
      sdkEvents,
    }));
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await transport?.close();
    if (temporaryPath) await rm(temporaryPath, { force: true });
  }
}
