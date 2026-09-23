import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('WeCom diagnostics never precede the Runtime ready protocol on stdout', () => {
  const script = [
    "import { writeWecomDiagnostic } from './src/wecom-channel.ts';",
    "writeWecomDiagnostic({ level: 'info', event: 'wecom.connection' });",
    "writeWecomDiagnostic({ level: 'warn', event: 'wecom.disconnected' });",
    "writeWecomDiagnostic({ level: 'error', event: 'wecom.transport_error' });",
    "writeWecomDiagnostic({ level: 'debug', event: 'wecom.heartbeat' });",
    "writeWecomDiagnostic({ level: 'info', event: 'secret-value' });",
    "process.stdout.write('{\"event\":\"ready\"}\\n');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"event":"ready"}\n');
  assert.match(result.stderr, /\[wecom\] wecom.connection/);
  assert.match(result.stderr, /\[wecom\] wecom.disconnected/);
  assert.match(result.stderr, /\[wecom\] wecom.transport_error/);
  assert.doesNotMatch(result.stderr, /secret-value|wecom.heartbeat/);
});
