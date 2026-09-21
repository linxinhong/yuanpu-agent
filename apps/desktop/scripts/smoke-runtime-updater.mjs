import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { PROTOCOL_VERSION } from '@yuanpu-agent/protocol';
import { RuntimeUpdater } from '../dist/runtime-updater.cjs';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(import.meta.dirname, '..');
const target = `${process.platform}-${process.arch}`;
const suffix = process.platform === 'win32' ? '.exe' : '';
const sourceExecutable = resolve(
  desktopRoot,
  '../runtime/dist-native/bin',
  `YuanpuAgentRuntime-${target}${suffix}`,
);
const executable = await readFile(sourceExecutable);
const { stdout } = await execFileAsync(sourceExecutable, ['--version'], { timeout: 10_000 });
const version = stdout.trim().replace(/^v/, '');
const sha256 = createHash('sha256').update(executable).digest('hex');
const runtimeRoot = await mkdtemp(resolve(tmpdir(), 'yuanpu-sea-update-'));
let server;

try {
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    resolve(runtimeRoot, 'current.json'),
    `${JSON.stringify({ version: '0.0.0', executable: '/old/runtime' }, null, 2)}\n`,
  );

  let baseUrl = '';
  server = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        schemaVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
        minDesktopVersion: '0.1.0',
        version,
        platforms: {
          [target]: {
            filename: `YuanpuAgentRuntime-${target}${suffix}`,
            url: `${baseUrl}/runtime`,
            size: executable.byteLength,
            sha256,
          },
        },
      }));
      return;
    }
    if (request.url === '/runtime') {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(executable);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const updater = new RuntimeUpdater({ runtimeRoot, desktopVersion: '0.1.0' });
  const staged = await updater.stage('0.0.0', `${baseUrl}/manifest.json`);
  assert.equal(staged.status, 'ready');
  assert.deepEqual(
    JSON.parse(await readFile(resolve(runtimeRoot, 'current.json'), 'utf8')),
    { version: '0.0.0', executable: '/old/runtime' },
  );

  const activeExecutable = await updater.activate('/bundled/runtime');
  const current = JSON.parse(await readFile(resolve(runtimeRoot, 'current.json'), 'utf8'));
  assert.deepEqual(current, { version, executable: activeExecutable });
  assert.equal(createHash('sha256').update(await readFile(activeExecutable)).digest('hex'), sha256);
  assert.equal(
    (await execFileAsync(activeExecutable, ['--version'], { timeout: 10_000 })).stdout.trim(),
    stdout.trim(),
  );
  console.log(`Staged Runtime update smoke passed for ${target}`);
} finally {
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await rm(runtimeRoot, { recursive: true, force: true });
}
