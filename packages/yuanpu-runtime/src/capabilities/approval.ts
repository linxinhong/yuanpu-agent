import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  CapabilityApprovalRecord,
  CapabilityAuthorizationInput,
  CapabilityAuthorizationResult,
  CapabilityAuthorizer,
  JsonValue,
} from './contracts.js';

interface ApprovalDocument {
  schemaVersion: 1;
  records: CapabilityApprovalRecord[];
}

export interface ApprovalStoreOptions {
  ttlMs?: number;
  now?: () => Date;
  createId?: () => string;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(value[key]!)}`
  )).join(',')}}`;
}

export function digestCapabilityArguments(value: Record<string, JsonValue>): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function sameBinding(record: CapabilityApprovalRecord, input: CapabilityAuthorizationInput): boolean {
  return record.sessionId === input.sessionId
    && record.workspaceId === input.workspaceId
    && record.sourceInstanceId === input.sourceInstanceId
    && record.packageVersion === input.packageVersion
    && record.capabilityId === input.capabilityId
    && record.argumentsDigest === digestCapabilityArguments(input.arguments);
}

export class CapabilityApprovalStore implements CapabilityAuthorizer {
  readonly #path: string;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  readonly #createId: () => string;
  #records: CapabilityApprovalRecord[];
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string, records: CapabilityApprovalRecord[], options: ApprovalStoreOptions) {
    this.#path = path;
    this.#records = records;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  static async open(path: string, options: ApprovalStoreOptions = {}): Promise<CapabilityApprovalStore> {
    let records: CapabilityApprovalRecord[] = [];
    try {
      const document = JSON.parse(await readFile(path, 'utf8')) as Partial<ApprovalDocument>;
      if (document.schemaVersion !== 1 || !Array.isArray(document.records)) {
        throw new Error(`Invalid capability approval store: ${path}`);
      }
      records = document.records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const store = new CapabilityApprovalStore(path, records, options);
    const hadRestartableRecords = store.#records.some((record) => (
      record.status === 'pending' || record.status === 'approved'
    ));
    if (hadRestartableRecords) {
      store.#records = store.#records.map((record) => (
        record.status === 'pending' || record.status === 'approved'
          ? { ...record, status: 'cancelled' }
          : record
      ));
      await store.#persist();
    }
    return store;
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#queue.then(operation, operation);
    this.#queue = current.then(() => undefined, () => undefined);
    return current;
  }

  #isExpired(record: CapabilityApprovalRecord): boolean {
    return new Date(record.expiresAt).getTime() <= this.#now().getTime();
  }

  #expireRecords(): boolean {
    let changed = false;
    this.#records = this.#records.map((record) => {
      if ((record.status === 'pending' || record.status === 'approved') && this.#isExpired(record)) {
        changed = true;
        return { ...record, status: 'expired' };
      }
      return record;
    });
    return changed;
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tempPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    const document: ApprovalDocument = { schemaVersion: 1, records: this.#records.slice(-500) };
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.#path);
  }

  async authorize(input: CapabilityAuthorizationInput): Promise<CapabilityAuthorizationResult> {
    return this.#locked(async () => {
      if (!input.sessionId || !input.workspaceId) {
        return { status: 'invalid', message: 'Host session and workspace context are required.' };
      }
      if (!input.approvalRequestId) {
        const now = this.#now();
        const record: CapabilityApprovalRecord = {
          requestId: this.#createId(),
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          sourceInstanceId: input.sourceInstanceId,
          packageVersion: input.packageVersion,
          capabilityId: input.capabilityId,
          argumentsDigest: digestCapabilityArguments(input.arguments),
          status: 'pending',
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
        };
        this.#records.push(record);
        await this.#persist();
        return { status: 'pending', requestId: record.requestId };
      }

      const index = this.#records.findIndex((record) => record.requestId === input.approvalRequestId);
      if (index < 0) return { status: 'invalid', message: 'Approval request was not created by this host.' };
      const record = this.#records[index]!;
      if (!sameBinding(record, input)) return { status: 'invalid', message: 'Approval binding does not match this execution.' };
      if (this.#isExpired(record)) {
        this.#records[index] = { ...record, status: 'expired' };
        await this.#persist();
        return { status: 'invalid', message: 'Approval request has expired.' };
      }
      if (record.status === 'pending') return { status: 'pending', requestId: record.requestId };
      if (record.status !== 'approved') {
        return { status: 'invalid', message: `Approval request is ${record.status}.` };
      }

      this.#records[index] = {
        ...record,
        status: 'consumed',
        consumedAt: this.#now().toISOString(),
      };
      await this.#persist();
      return { status: 'authorized' };
    });
  }

  async listPending(): Promise<CapabilityApprovalRecord[]> {
    return this.#locked(async () => {
      if (this.#expireRecords()) await this.#persist();
      return this.#records.filter((record) => record.status === 'pending').map((record) => ({ ...record }));
    });
  }

  async decide(requestId: string, decision: 'approved' | 'denied'): Promise<CapabilityApprovalRecord> {
    return this.#locked(async () => {
      this.#expireRecords();
      const index = this.#records.findIndex((record) => record.requestId === requestId);
      if (index < 0) throw new Error('Unknown approval request.');
      const record = this.#records[index]!;
      if (record.status !== 'pending') throw new Error(`Approval request is ${record.status}.`);
      const next: CapabilityApprovalRecord = {
        ...record,
        status: decision,
        decidedAt: this.#now().toISOString(),
      };
      this.#records[index] = next;
      await this.#persist();
      return { ...next };
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.#locked(async () => {
      let changed = false;
      this.#records = this.#records.map((record) => {
        if (record.sessionId === sessionId && (record.status === 'pending' || record.status === 'approved')) {
          changed = true;
          return { ...record, status: 'cancelled' };
        }
        return record;
      });
      if (changed) await this.#persist();
    });
  }
}
