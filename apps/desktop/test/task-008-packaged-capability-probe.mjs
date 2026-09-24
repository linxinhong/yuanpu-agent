import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const release = resolve(import.meta.dirname, '../release');
const target = `${process.platform}-${process.arch}`;
const unpacked = process.platform === 'darwin'
  ? join(release, `mac-${process.arch}`, 'YuanpuAgent.app', 'Contents', 'Resources')
  : join(release, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', 'resources');
const runtimeDir = join(unpacked, 'runtime');
const runtimeNames = (await readdir(runtimeDir)).filter((name) =>
  name === `YuanpuAgentRuntime-${target}${process.platform === 'win32' ? '.exe' : ''}`);
assert.equal(runtimeNames.length, 1, `Expected packaged Runtime for ${target}`);
const runtime = join(runtimeDir, runtimeNames[0]);
const capabilityDir = join(unpacked, 'capabilities', 'builtin.python.echo', 'YuanpuEchoMcp');
const capability = join(capabilityDir, process.platform === 'win32' ? 'YuanpuEchoMcp.exe' : 'YuanpuEchoMcp');
assert.equal((await stat(capability)).isFile(), true);

// The child can only find executables by absolute packaged paths. In particular,
// neither a system Python nor a checkout-local Python can satisfy this probe.
const emptyPath = await mkdtemp(join(tmpdir(), 'yuanpu-task-008-no-path-'));
try {
  const output = execFileSync(runtime, ['--capability-smoke'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      PATH: emptyPath,
      YUANPU_PYTHON_MCP_EXECUTABLE: capability,
      YUANPU_PYTHON_MCP_ROOT: capabilityDir,
      YUANPU_PYTHON_MCP_ARGS: '[]',
    },
  });
  const result = JSON.parse(output.trim());
  assert.deepEqual(result.tools, ['search_capabilities', 'execute_capability']);
  assert.deepEqual(result.result.structuredContent, { text: 'YuanpuAgent SEA', length: 15 });
  assert.equal(result.errorResult.isError, true);
  assert.match(result.errorResult.content[0].text, /diagnostic error/i);
  console.log(JSON.stringify({ status: 'passed', target, source: 'packaged-app-resources', noSystemPath: true }));
} finally {
  await rm(emptyPath, { recursive: true, force: true });
}
