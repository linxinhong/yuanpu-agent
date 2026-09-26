import type { SandboxPolicy } from './policy.js';

function seatbeltString(path: string): string {
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error('Sandbox paths cannot contain control characters.');
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function createMacOsProfile(policy: SandboxPolicy): string {
  if (policy.fileReads !== 'host' || policy.fileWrites !== 'workspace'
    || policy.privateTempWrites !== 'deny' || policy.network !== 'deny') {
    throw new Error('Unsupported sandbox policy.');
  }
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${seatbeltString(policy.workspaceRoot)}))`,
  ].join('\n');
}
