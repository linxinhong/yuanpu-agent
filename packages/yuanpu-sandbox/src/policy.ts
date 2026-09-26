import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { join, parse } from 'node:path';

const issuedPolicies = new WeakSet<SandboxPolicy>();

async function rejectHardlinks(directory: string): Promise<void> {
  for await (const entry of await opendir(directory)) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) await rejectHardlinks(path);
    else if (metadata.isFile() && metadata.nlink !== 1) {
      throw new Error(`Sandbox workspace contains a hard-linked file: ${path}`);
    }
  }
}

/** The initial policy restricts writes and direct network access, but not reads. */
export interface SandboxPolicy {
  readonly workspaceRoot: string;
  readonly fileReads: 'host';
  readonly fileWrites: 'workspace';
  readonly privateTempWrites: 'deny' | 'allow';
  readonly network: 'deny' | 'host';
}

export async function createSandboxPolicy(
  workspaceRoot: string,
  options: { network?: 'deny' | 'host'; privateTempWrites?: 'deny' | 'allow' } = {},
): Promise<SandboxPolicy> {
  if (!workspaceRoot) throw new Error('A workspace directory is required.');
  const network = options.network ?? 'deny';
  if (network !== 'deny' && network !== 'host') throw new Error('Unsupported sandbox network policy.');
  const privateTempWrites = options.privateTempWrites ?? 'deny';
  if (privateTempWrites !== 'deny' && privateTempWrites !== 'allow') {
    throw new Error('Unsupported sandbox private temp write policy.');
  }
  const canonicalRoot = await realpath(workspaceRoot);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error('The workspace must be a directory.');
  if (canonicalRoot === parse(canonicalRoot).root) throw new Error('The filesystem root cannot be a sandbox workspace.');
  await rejectHardlinks(canonicalRoot);
  const policy: SandboxPolicy = Object.freeze({
    workspaceRoot: canonicalRoot,
    fileReads: 'host',
    fileWrites: 'workspace',
    privateTempWrites,
    network,
  });
  issuedPolicies.add(policy);
  return policy;
}

export async function assertSandboxPolicy(policy: SandboxPolicy): Promise<void> {
  if (!issuedPolicies.has(policy)) throw new Error('Sandbox policy must be created by createSandboxPolicy.');
  const currentRoot = await realpath(policy.workspaceRoot);
  if (currentRoot !== policy.workspaceRoot || !(await stat(currentRoot)).isDirectory()) {
    throw new Error('Sandbox workspace has changed since policy creation.');
  }
  await rejectHardlinks(currentRoot);
}
