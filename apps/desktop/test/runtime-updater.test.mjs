import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import test from 'node:test';

import { PROTOCOL_VERSION } from '@yuanpu-agent/protocol';
import { RuntimeUpdater } from '../dist/runtime-updater.cjs';

const execFileAsync = promisify(execFile);
const executableVersion = process.version.replace(/^v/, '');
const target = `${process.platform}-${process.arch}`;

async function temporaryRuntimeRoot(context) {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-runtime-update-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'current.json'),
    `${JSON.stringify({ version: '0.1.0', executable: '/old/runtime' }, null, 2)}\n`,
  );
  return root;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function manifest(baseUrl, artifact, overrides = {}) {
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    minDesktopVersion: '0.1.0',
    version: executableVersion,
    platforms: {
      [target]: {
        filename: process.platform === 'win32' ? 'runtime.exe' : 'runtime',
        url: `${baseUrl}/runtime`,
        ...artifact,
      },
    },
    ...overrides,
  };
}

test('stages a real executable and activates it only on the next startup', async (context) => {
  const root = await temporaryRuntimeRoot(context);
  const executable = await readFile(process.execPath);
  const sha256 = createHash('sha256').update(executable).digest('hex');
  let baseUrl = '';
  const server = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(manifest(baseUrl, { size: executable.byteLength, sha256 })));
      return;
    }
    if (request.url === '/runtime') {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(executable);
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  baseUrl = await listen(server);

  const updater = new RuntimeUpdater({ runtimeRoot: root, desktopVersion: '0.1.0' });
  const staged = await updater.stage('0.1.0', `${baseUrl}/manifest.json`);
  assert.deepEqual(staged, {
    status: 'ready',
    currentVersion: '0.1.0',
    availableVersion: executableVersion,
    message: 'Runtime update is staged and will activate after restart.',
  });

  const beforeRestart = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
  assert.deepEqual(beforeRestart, { version: '0.1.0', executable: '/old/runtime' });
  assert.equal(JSON.parse(await readFile(join(root, '.staging', 'staged.json'), 'utf8')).sha256, sha256);

  const activeExecutable = await updater.activate('/bundled/runtime');
  const afterRestart = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
  assert.equal(afterRestart.version, executableVersion);
  assert.equal(afterRestart.executable, activeExecutable);
  assert.equal(createHash('sha256').update(await readFile(activeExecutable)).digest('hex'), sha256);
  assert.equal((await execFileAsync(activeExecutable, ['--version'])).stdout.trim(), process.version);
  await assert.rejects(stat(join(root, '.staging')), { code: 'ENOENT' });
});

test('rejects invalid downloads without changing the active runtime', async (context) => {
  const root = await temporaryRuntimeRoot(context);
  const body = Buffer.from('not-a-runtime');
  let baseUrl = '';
  let scenario = 'size';
  const server = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      const artifact = scenario === 'hash'
        ? { size: body.byteLength, sha256: '0'.repeat(64) }
        : { size: body.byteLength + 1, sha256: createHash('sha256').update(body).digest('hex') };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(manifest(baseUrl, artifact)));
      return;
    }
    if (request.url === '/runtime') {
      if (scenario === 'interrupted') {
        response.writeHead(200, { 'content-length': body.byteLength + 1 });
        response.write(body);
        response.destroy();
        return;
      }
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  baseUrl = await listen(server);

  const updater = new RuntimeUpdater({ runtimeRoot: root, desktopVersion: '0.1.0' });
  const badSize = await updater.stage('0.1.0', `${baseUrl}/manifest.json`);
  assert.equal(badSize.status, 'error');
  assert.match(badSize.message, /size mismatch/);

  scenario = 'hash';
  const badHash = await updater.stage('0.1.0', `${baseUrl}/manifest.json`);
  assert.equal(badHash.status, 'error');
  assert.match(badHash.message, /checksum mismatch/);

  scenario = 'interrupted';
  const interrupted = await updater.stage('0.1.0', `${baseUrl}/manifest.json`);
  assert.equal(interrupted.status, 'error');

  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'current.json'), 'utf8')),
    { version: '0.1.0', executable: '/old/runtime' },
  );
  await assert.rejects(stat(join(root, '.staging')), { code: 'ENOENT' });
});

test('discards staged executables whose version or metadata is invalid', async (context) => {
  const root = await temporaryRuntimeRoot(context);
  const updater = new RuntimeUpdater({ runtimeRoot: root, desktopVersion: '0.1.0' });
  const stagingRoot = join(root, '.staging');
  const stagedName = process.platform === 'win32' ? 'runtime.exe' : 'runtime';
  const executable = await readFile(process.execPath);

  await mkdir(stagingRoot, { recursive: true });
  await writeFile(join(stagingRoot, stagedName), executable);
  await writeFile(
    join(stagingRoot, 'staged.json'),
    JSON.stringify({
      version: '99.0.0',
      filename: stagedName,
      sha256: createHash('sha256').update(executable).digest('hex'),
    }),
  );
  assert.equal(await updater.activate('/bundled/runtime'), '/old/runtime');
  await assert.rejects(stat(stagingRoot), { code: 'ENOENT' });

  await mkdir(stagingRoot, { recursive: true });
  await writeFile(join(stagingRoot, stagedName), Buffer.from('partial-download'));
  assert.equal(await updater.activate('/bundled/runtime'), '/old/runtime');
  await assert.rejects(stat(stagingRoot), { code: 'ENOENT' });

  await mkdir(stagingRoot, { recursive: true });
  await writeFile(join(stagingRoot, 'staged.json'), JSON.stringify({
    version: executableVersion,
    filename: '../runtime',
    sha256: '0'.repeat(64),
  }));
  assert.equal(await updater.activate('/bundled/runtime'), '/old/runtime');
  await assert.rejects(stat(stagingRoot), { code: 'ENOENT' });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'current.json'), 'utf8')),
    { version: '0.1.0', executable: '/old/runtime' },
  );
});

test('rolls back an unconfirmed activation on the next App start without touching user data', async (context) => {
  const root = await temporaryRuntimeRoot(context);
  const updater = new RuntimeUpdater({ runtimeRoot: root, desktopVersion: '0.1.0' });
  const stagingRoot = join(root, '.staging');
  const stagedName = process.platform === 'win32' ? 'runtime.exe' : 'runtime';
  const executable = await readFile(process.execPath);
  const sha256 = createHash('sha256').update(executable).digest('hex');
  const userDatabase = join(root, 'user-data', 'automation.sqlite');
  await mkdir(join(root, 'user-data'), { recursive: true });
  const database = new DatabaseSync(userDatabase);
  database.exec('CREATE TABLE user_fixture(value TEXT NOT NULL) STRICT');
  database.prepare('INSERT INTO user_fixture(value) VALUES (?)').run('persistent-user-data');
  database.close();
  await mkdir(stagingRoot, { recursive: true });
  await writeFile(join(stagingRoot, stagedName), executable);
  await writeFile(join(stagingRoot, 'staged.json'), JSON.stringify({
    version: executableVersion,
    filename: stagedName,
    sha256,
  }));

  const activation = await updater.prepareActivation('/bundled/runtime');
  assert.equal(activation.pending, true);
  assert.equal(activation.version, executableVersion);
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'current.json'), 'utf8')),
    { version: executableVersion, executable: activation.executable },
  );

  const afterCrash = await new RuntimeUpdater({
    runtimeRoot: root,
    desktopVersion: '0.1.0',
  }).prepareActivation('/bundled/runtime');
  assert.deepEqual(afterCrash, {
    executable: '/old/runtime',
    version: '0.1.0',
    pending: false,
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'current.json'), 'utf8')),
    { version: '0.1.0', executable: '/old/runtime' },
  );
  const reopened = new DatabaseSync(userDatabase, { readOnly: true });
  assert.equal(reopened.prepare('SELECT value FROM user_fixture').get().value, 'persistent-user-data');
  reopened.close();
  await assert.rejects(stat(join(root, 'activation-pending.json')), { code: 'ENOENT' });
});
