import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const electron = require('electron');
const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-021-path-'));
const appRoot = join(root, 'app');
const userData = join(root, 'user-data');
try {
  await mkdir(appRoot, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({
    name: 'task021-isolated-path-preflight', version: '0.1.0', main: 'entry.cjs',
  }));
  await writeFile(join(appRoot, 'entry.cjs'), `
    const { app } = require('electron');
    app.whenReady().then(() => {
      process.stdout.write(JSON.stringify({ userData: app.getPath('userData') }) + '\\n');
      app.quit();
    });
  `);
  const { stdout } = await execFileAsync(electron, [`--user-data-dir=${userData}`, appRoot], {
    timeout: 15_000,
  });
  const actual = JSON.parse(stdout.trim().split('\n').at(-1)).userData;
  assert.equal(actual, await realpath(userData), 'Electron command-line user-data-dir did not override app.getPath(userData).');
  console.log(JSON.stringify({ status: 'passed', userDataIsDisposable: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
