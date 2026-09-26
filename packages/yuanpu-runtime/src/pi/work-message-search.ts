import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';

const maxSessionBytes = 32 * 1024 * 1024;

export interface SavedWorkMessage {
  entryId: string;
  position: number;
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export type SavedWorkMessages =
  | { status: 'ok'; messages: SavedWorkMessage[]; bytesRead: number }
  | { status: 'missing' | 'unreadable' | 'corrupt' | 'too_large'; messages: []; bytesRead: number };

function visibleText(entry: SessionEntry, position: number): SavedWorkMessage | undefined {
  if (entry.type !== 'message') return undefined;
  const message = entry.message;
  if (message.role !== 'user' && message.role !== 'assistant') return undefined;
  const content = message.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((block) => block.type === 'text')
      .map((block) => block.text).filter((part): part is string => typeof part === 'string').join('\n') : '';
  if (!text.trim()) return undefined;
  return { entryId: entry.id, position, role: message.role, text, at: entry.timestamp };
}

/** Read one Pi session as a bounded, immutable snapshot. Never index raw JSONL fields. */
export function readSavedWorkMessages(cwd: string, piSessionId: string, directory: string): SavedWorkMessages {
  let names: string[];
  try {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
      return { status: 'unreadable', messages: [], bytesRead: 0 };
    }
    names = readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return { status: 'unreadable', messages: [], bytesRead: 0 };
  }
  for (const name of names) {
    const path = join(directory, name);
    const namedSession = name.endsWith(`_${piSessionId}.jsonl`);
    let fd: number | undefined;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile()) continue;
      const headerBytes = Buffer.alloc(Math.min(opened.size, 64_000));
      readSync(fd, headerBytes, 0, headerBytes.length, 0);
      const firstLine = headerBytes.toString('utf8').split('\n').find((line) => line.trim());
      let header: { type?: unknown; id?: unknown; cwd?: unknown };
      try { header = JSON.parse(firstLine ?? ''); }
      catch {
        if (namedSession) return { status: 'corrupt', messages: [], bytesRead: 0 };
        continue;
      }
      if (header.type !== 'session' || header.id !== piSessionId
        || typeof header.cwd !== 'string') {
        if (namedSession) return { status: 'corrupt', messages: [], bytesRead: 0 };
        continue;
      }
      if (resolve(header.cwd) !== resolve(cwd)) continue;
      if (opened.size > maxSessionBytes) return { status: 'too_large', messages: [], bytesRead: 0 };
      const bytes = Buffer.alloc(opened.size);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, count);
        if (!read) break;
        count += read;
      }
      if (count !== opened.size || fstatSync(fd).size !== opened.size) {
        return { status: 'unreadable', messages: [], bytesRead: count };
      }
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return { status: 'corrupt', messages: [], bytesRead: count }; }
      const lines = content.split('\n').filter((line) => line.trim());
      const entries: unknown[] = [];
      try { for (const line of lines) entries.push(JSON.parse(line)); }
      catch { return { status: 'corrupt', messages: [], bytesRead: count }; }
      if (!entries.length || typeof entries[0] !== 'object' || entries[0] === null
        || (entries[0] as { type?: unknown }).type !== 'session') {
        return { status: 'corrupt', messages: [], bytesRead: count };
      }
      try {
        const branch = SessionManager.inMemory(cwd, { id: piSessionId }, entries as Parameters<typeof SessionManager.inMemory>[2]).getBranch();
        return { status: 'ok', messages: branch.flatMap((entry, position) => visibleText(entry, position) ?? []), bytesRead: count };
      } catch { return { status: 'corrupt', messages: [], bytesRead: count }; }
    } catch {
      return { status: 'unreadable', messages: [], bytesRead: 0 };
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return { status: 'missing', messages: [], bytesRead: 0 };
}
