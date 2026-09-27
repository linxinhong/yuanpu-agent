import { CAPABILITY_ID_PREFIX } from './contracts.js';

function encodeCapabilityPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCapabilityPart(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return encodeCapabilityPart(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function createCapabilityId(sourceInstanceId: string, originalName: string): string {
  if (!sourceInstanceId.trim() || !originalName.trim()) {
    throw new Error('Capability source and tool names must be non-empty.');
  }
  return `${CAPABILITY_ID_PREFIX}:${encodeCapabilityPart(sourceInstanceId)}:${encodeCapabilityPart(originalName)}`;
}

export function parseCapabilityId(id: string): {
  sourceInstanceId: string;
  originalName: string;
} | undefined {
  const [prefix, sourcePart, namePart, extra] = id.split(':');
  if (prefix !== CAPABILITY_ID_PREFIX || !sourcePart || !namePart || extra !== undefined) return undefined;
  const sourceInstanceId = decodeCapabilityPart(sourcePart);
  const originalName = decodeCapabilityPart(namePart);
  return sourceInstanceId && originalName ? { sourceInstanceId, originalName } : undefined;
}
