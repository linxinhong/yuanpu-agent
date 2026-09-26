import { createRequire } from 'node:module';
import type { SandboxPolicy } from './policy.js';
import type { SandboxRunOptions } from './runner.js';

/** The published DeepSeek runner is a separate Node entry point, not a Pi plugin. */
export function resolveWindowsRunnerPath(): string {
  return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner');
}

export function createWindowsRunnerArguments(
  policy: SandboxPolicy,
  options: SandboxRunOptions,
  privateTempDirectory: string,
): string[] {
  if (policy.fileReads !== 'host' || policy.fileWrites !== 'workspace'
    || policy.privateTempWrites !== 'allow' || policy.network !== 'host') {
    throw new Error('Windows ACL confinement requires network: host and privateTempWrites: allow explicitly.');
  }
  return [
    resolveWindowsRunnerPath(),
    '--workspace', policy.workspaceRoot,
    '--temp', privateTempDirectory,
    '--mode', 'workspace-write',
    '--', options.command,
    ...(options.args ?? []),
  ];
}

export function windowsRunnerEnvironment(
  privateTempDirectory: string,
  additional: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, additional);
  env.TEMP = privateTempDirectory;
  env.TMP = privateTempDirectory;
  return env;
}
