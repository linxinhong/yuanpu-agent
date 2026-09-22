import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  ChannelRouter,
  WecomSdkTransport,
  type AgentService,
  type ChannelStore,
  type ChannelTransport,
  type RedactedChannelLogSink,
} from '@yuanpu-agent/runtime-kit';

const execFileAsync = promisify(execFile);
const digestPattern = /^[a-f0-9]{64}$/;
const credentialRefPattern = /^keychain:yuanpu\/im\/[A-Za-z0-9._-]+\/bot-secret$/;

interface PersistedWecomConnection {
  enabled: boolean;
  provider: 'wecom';
  connectionId: string;
  providerAccountRef?: string;
  credentialRefs?: { botSecret?: string };
  directMessagePolicy?: string;
  groupPolicy?: string;
  groupEnabled?: boolean;
  pairedSenderDigests?: string[];
  groupAllowlistDigests?: string[];
  acceptedMessageTypes?: string[];
}

interface PersistedWecomDocument {
  schemaVersion: 1;
  connections: PersistedWecomConnection[];
}

export interface StartConfiguredWecomChannelOptions {
  appPath: string;
  workspaceId: string;
  store: ChannelStore;
  agent: AgentService;
  resolveCredential?: (reference: string) => Promise<string>;
  createTransport?: (input: {
    connectionId: string;
    botId: string;
    secret: string;
    log: RedactedChannelLogSink;
  }) => ChannelTransport;
  log?: RedactedChannelLogSink;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, field: string, pattern?: RegExp): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || (pattern && !pattern.test(item)))) {
    throw new Error(`Invalid Enterprise WeChat ${field}.`);
  }
  return [...new Set(value)];
}

function parseDocument(value: unknown): PersistedWecomDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.connections)) {
    throw new Error('Invalid Enterprise WeChat connection document.');
  }
  const connections = value.connections.map((item): PersistedWecomConnection => {
    if (!isRecord(item) || typeof item.enabled !== 'boolean' || item.provider !== 'wecom') {
      throw new Error('Invalid Enterprise WeChat connection entry.');
    }
    if (typeof item.connectionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(item.connectionId)) {
      throw new Error('Invalid Enterprise WeChat connectionId.');
    }
    if ('secret' in item || 'botSecret' in item || 'botId' in item) {
      throw new Error('Enterprise WeChat credentials must be stored as references.');
    }
    const acceptedMessageTypes = stringArray(item.acceptedMessageTypes, 'acceptedMessageTypes');
    if (acceptedMessageTypes.some((type) => type !== 'text')) {
      throw new Error('Enterprise WeChat currently accepts text messages only.');
    }
    return {
      enabled: item.enabled,
      provider: 'wecom',
      connectionId: item.connectionId,
      ...(typeof item.providerAccountRef === 'string' ? { providerAccountRef: item.providerAccountRef } : {}),
      ...(isRecord(item.credentialRefs)
        ? { credentialRefs: { ...(typeof item.credentialRefs.botSecret === 'string'
            ? { botSecret: item.credentialRefs.botSecret }
            : {}) } }
        : {}),
      ...(typeof item.directMessagePolicy === 'string'
        ? { directMessagePolicy: item.directMessagePolicy }
        : {}),
      ...(typeof item.groupPolicy === 'string' ? { groupPolicy: item.groupPolicy } : {}),
      ...(typeof item.groupEnabled === 'boolean' ? { groupEnabled: item.groupEnabled } : {}),
      pairedSenderDigests: stringArray(item.pairedSenderDigests, 'pairedSenderDigests', digestPattern),
      groupAllowlistDigests: stringArray(item.groupAllowlistDigests, 'groupAllowlistDigests', digestPattern),
      acceptedMessageTypes,
    };
  });
  return { schemaVersion: 1, connections };
}

export async function readWecomConnectionDocument(appPath: string): Promise<PersistedWecomDocument> {
  const path = join(appPath, 'connections', 'wecom.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, connections: [] };
    }
    throw error;
  }
  try {
    return parseDocument(JSON.parse(raw) as unknown);
  } catch {
    throw new Error('Enterprise WeChat connection configuration is invalid.');
  }
}

export async function resolveSystemKeychainCredential(reference: string): Promise<string> {
  if (!credentialRefPattern.test(reference)) {
    throw new Error('Enterprise WeChat credential reference is invalid.');
  }
  const service = reference.slice('keychain:'.length);
  if (process.platform !== 'darwin') {
    throw new Error('Enterprise WeChat system Keychain resolution is unavailable on this platform.');
  }
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      service,
      '-w',
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 8 * 1024,
    });
    const secret = stdout.trim();
    if (!secret) throw new Error('empty');
    return secret;
  } catch {
    throw new Error('Enterprise WeChat credential could not be resolved from the system Keychain.');
  }
}

export async function startConfiguredWecomChannels(
  options: StartConfiguredWecomChannelOptions,
): Promise<ChannelRouter[]> {
  const document = await readWecomConnectionDocument(options.appPath);
  const routers: ChannelRouter[] = [];
  try {
    for (const connection of document.connections) {
      if (!connection.enabled) continue;
      if (
        !connection.providerAccountRef
        || !connection.credentialRefs?.botSecret
        || !credentialRefPattern.test(connection.credentialRefs.botSecret)
        || connection.directMessagePolicy !== 'paired-only'
        || connection.acceptedMessageTypes?.length !== 1
        || connection.acceptedMessageTypes[0] !== 'text'
      ) {
        throw new Error('Enabled Enterprise WeChat connection is incomplete or unsafe.');
      }
      if (connection.groupEnabled) {
        throw new Error('Enterprise WeChat group messages remain disabled until real trigger verification.');
      }
      let secret = await (options.resolveCredential ?? resolveSystemKeychainCredential)(
        connection.credentialRefs.botSecret,
      );
      if (!secret) throw new Error('Enterprise WeChat credential is empty.');
      const transport = options.createTransport
        ? options.createTransport({
            connectionId: connection.connectionId,
            botId: connection.providerAccountRef,
            secret,
            log: options.log ?? (() => undefined),
          })
        : new WecomSdkTransport({
            connectionId: connection.connectionId,
            botId: connection.providerAccountRef,
            secret,
            log: options.log,
          });
      secret = '';
      const router = new ChannelRouter({
        config: {
          provider: 'wecom',
          connectionId: connection.connectionId,
          providerAccountRef: connection.providerAccountRef,
          workspaceId: options.workspaceId,
          acceptedMessageTypes: ['text'],
          pairedSenderDigests: connection.pairedSenderDigests ?? [],
          groupEnabled: false,
          groupAllowlistDigests: connection.groupAllowlistDigests ?? [],
        },
        store: options.store,
        agent: options.agent,
        transport,
      });
      router.start();
      routers.push(router);
    }
    return routers;
  } catch (error) {
    await Promise.allSettled(routers.map((router) => router.close()));
    throw error;
  }
}

export async function closeWecomChannels(routers: readonly ChannelRouter[]): Promise<void> {
  const results = await Promise.allSettled(routers.map((router) => router.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Enterprise WeChat channels did not close cleanly.');
}
