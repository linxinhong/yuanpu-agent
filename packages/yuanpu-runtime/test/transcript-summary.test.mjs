import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { summarizeTranscript } = await import('../src/pi/transcript-summary.ts');
const { browserScreenshotPath, withBrowserScreenshots } = await import('../src/pi/browser-screenshot-attachment.ts');
const entry = (id, role, seconds, fields) => ({ id, type: 'message', timestamp: `2026-09-25T12:00:${seconds}.000Z`, message: { role, ...fields } });

test('history restores per-turn execution summaries without renderer cache or private tool payloads', () => {
  const messages = summarizeTranscript([
    entry('u1', 'user', '00', { content: 'check' }),
    entry('thinking', 'assistant', '01', { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'toolCall', name: 'search', arguments: { secret: 'PRIVATE_ARGUMENT' } }], stopReason: 'toolUse' }),
    entry('tool', 'toolResult', '02', { content: [{ type: 'text', text: 'PRIVATE_RESULT' }], toolName: 'search', isError: false }),
    entry('a1', 'assistant', '05', { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }),
    entry('u2', 'user', '10', { content: 'next' }),
    entry('a2', 'assistant', '12', { content: [{ type: 'text', text: 'stopped' }], stopReason: 'aborted' }),
  ]);
  assert.equal(messages.length, 4);
  assert.equal(messages[1].run.source, 'transcript');
  assert.equal(messages[1].run.status, 'succeeded');
  assert.equal(messages[1].run.createdAt, '2026-09-25T12:00:00.000Z');
  assert.equal(messages[1].run.updatedAt, '2026-09-25T12:00:05.000Z');
  assert.deepEqual(messages[1].run.tools, [{ name: 'search', status: 'completed' }]);
  assert.equal(messages[3].run.status, 'cancelled');
  assert.deepEqual(messages[3].run.tools, []);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_/);
});

test('unknown historical outcomes do not invent success or duration', () => {
  assert.equal(summarizeTranscript([entry('a', 'assistant', '00', { content: 'legacy reply' })])[0].run, undefined);
});

test('a saved browser screenshot is shown in the completed reply after restoring history', () => {
  const details = { sourceInstanceId: 'builtin.host.browser',
    capability: 'ypcap:YnVpbHRpbi5ob3N0LmJyb3dzZXI:YnJvd3Nlcl9zY3JlZW5zaG90',
    structuredContent: { screenshot: { relativePath: 'images/browser-2026-09-27.png' } } };
  const messages = summarizeTranscript([
    entry('u', 'user', '00', { content: '截图给我' }),
    entry('tool', 'toolResult', '01', { toolName: 'execute_capability', details,
      content: [{ type: 'text', text: 'private tool output' }], isError: false }),
    entry('reply', 'assistant', '02', { content: '已经截图。', stopReason: 'stop' }),
  ]);
  assert.equal(messages[1].text, '已经截图。\n\n![浏览器截图](images/browser-2026-09-27.png)');
  assert.doesNotMatch(JSON.stringify(messages), /private tool output/);
  assert.equal(browserScreenshotPath({ ...details, sourceInstanceId: 'other' }), undefined);
  assert.equal(browserScreenshotPath({ ...details, structuredContent: { screenshot: { relativePath: '../secret.png' } } }), undefined);
  assert.equal(withBrowserScreenshots(messages[1].text, ['images/browser-2026-09-27.png']), messages[1].text);
  assert.match(withBrowserScreenshots('已保存到 images/browser-2026-09-27.png', ['images/browser-2026-09-27.png']),
    /!\[浏览器截图\]\(images\/browser-2026-09-27\.png\)/);
});
