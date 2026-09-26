import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  createMacOsProfile,
  createSandboxPolicy,
  createWindowsRunnerArguments,
  isSandboxAvailable,
  runSandboxed,
} from '../dist/index.mjs';

test('policy canonicalizes its workspace and rejects filesystem root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-sandbox-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work'));
  await symlink(join(root, 'work'), join(root, 'alias'));
  const policy = await createSandboxPolicy(join(root, 'alias'));
  assert.equal(policy.workspaceRoot, await realpath(join(root, 'work')));
  assert.deepEqual([policy.fileReads, policy.fileWrites, policy.privateTempWrites, policy.network],
    ['host', 'workspace', 'deny', 'deny']);
  await assert.rejects(createSandboxPolicy(resolve('/')), /filesystem root/);
});

test('profile rejects policy widening and escapes unusual paths', () => {
  const policy = { workspaceRoot: '/tmp/quote"slash\\here', fileReads: 'host', fileWrites: 'workspace', privateTempWrites: 'deny', network: 'deny' };
  assert.match(createMacOsProfile(policy), /quote\\"slash\\\\here/);
  assert.throws(() => createMacOsProfile({ ...policy, network: 'allow' }), /Unsupported/);
  assert.throws(() => createMacOsProfile({ ...policy, workspaceRoot: '/tmp/new\nline' }), /control characters/);
});

test('Windows runner plan requires explicit host network and passes argv without a shell', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-sandbox-win-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const denied = await createSandboxPolicy(root);
  assert.throws(() => createWindowsRunnerArguments(denied,
    { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'echo hello'] }, 'C:\\Temp\\private'), /network: host/);
  const networkOnly = await createSandboxPolicy(root, { network: 'host' });
  assert.throws(() => createWindowsRunnerArguments(networkOnly,
    { command: 'C:\\Windows\\System32\\cmd.exe' }, 'C:\\Temp\\private'), /privateTempWrites: allow/);
  const allowed = await createSandboxPolicy(root, { network: 'host', privateTempWrites: 'allow' });
  const args = createWindowsRunnerArguments(allowed,
    { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'echo hello'] }, 'C:\\Temp\\private');
  assert.match(args[0], /runner\.js$/);
  assert.deepEqual(args.slice(1), [
    '--workspace', allowed.workspaceRoot, '--temp', 'C:\\Temp\\private', '--mode', 'workspace-write',
    '--', 'C:\\Windows\\System32\\cmd.exe', '/c', 'echo hello',
  ]);
  assert.throws(() => createMacOsProfile(allowed), /Unsupported/);
});

test('hard links into the workspace are rejected before a command starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-sandbox-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  await mkdir(work);
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'original');
  await link(outside, join(work, 'alias.txt'));
  await assert.rejects(createSandboxPolicy(work), /hard-linked file/);
  await rm(join(work, 'alias.txt'));
  const policy = await createSandboxPolicy(work);
  await link(outside, join(work, 'alias.txt'));
  if (await isSandboxAvailable()) {
    await assert.rejects(runSandboxed(policy, { command: '/bin/echo', args: ['should-not-run'] }), /hard-linked file/);
  }
  assert.equal(await readFile(outside, 'utf8'), 'original');
});

test('macOS runner allows workspace writes and denies writes outside it, including symlink escapes', async (t) => {
  if (!(await isSandboxAvailable())) return t.skip('macOS sandbox-exec unavailable');
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-sandbox-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  await mkdir(work);
  const policy = await createSandboxPolicy(work);
  await assert.rejects(runSandboxed({ ...policy, workspaceRoot: root }, { command: '/bin/echo' }), /must be created/);
  const inside = await runSandboxed(policy, { command: '/bin/sh', args: ['-c', 'printf allowed > allowed.txt; cat allowed.txt'] });
  assert.equal(inside.exitCode, 0, inside.stderr);
  assert.equal(inside.stdout, 'allowed');
  assert.equal(await readFile(join(work, 'allowed.txt'), 'utf8'), 'allowed');

  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'original');
  const direct = await runSandboxed(policy, { command: '/bin/sh', args: ['-c', `printf changed > '${outside}'`] });
  assert.notEqual(direct.exitCode, 0);
  assert.equal(await readFile(outside, 'utf8'), 'original');

  await symlink(root, join(work, 'escape'));
  const viaSymlink = await runSandboxed(policy, { command: '/bin/sh', args: ['-c', 'printf changed > escape/outside.txt'] });
  assert.notEqual(viaSymlink.exitCode, 0);
  assert.equal(await readFile(outside, 'utf8'), 'original');
});

test('macOS runner blocks direct loopback connections and bounds execution', async (t) => {
  if (!(await isSandboxAvailable())) return t.skip('macOS sandbox-exec unavailable');
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-sandbox-net-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = await createSandboxPolicy(root);
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const port = server.address().port;
  execFileSync('/usr/bin/nc', ['-z', '-w', '1', '127.0.0.1', String(port)]);
  const network = await runSandboxed(policy, { command: '/usr/bin/nc', args: ['-z', '-w', '1', '127.0.0.1', String(port)] });
  assert.notEqual(network.exitCode, 0, network.stderr);

  await assert.rejects(runSandboxed(policy, {
    command: '/bin/sh', args: ['-c', 'while :; do :; done'], timeoutMs: 50,
  }), (error) => error.code === 'timeout');
  await assert.rejects(runSandboxed(policy, {
    command: '/bin/sh', args: ['-c', 'yes x'], maxOutputBytes: 1024,
  }), (error) => error.code === 'output_limit');

  const controller = new AbortController();
  const running = runSandboxed(policy, {
    command: '/bin/sh', args: ['-c', 'sleep 5'], signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, (error) => error.code === 'aborted');
});
