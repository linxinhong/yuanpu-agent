import assert from 'node:assert/strict';
import test from 'node:test';

import { isTrustedRendererUrl } from '../dist/renderer-security.cjs';

test('renderer trust is bound to the configured entry document', () => {
  const trusted = 'http://127.0.0.1:5173/';
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/#skills', trusted), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/other', trusted), false);
  assert.equal(isTrustedRendererUrl('https://example.com/', trusted), false);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174/', trusted), false);
});

test('packaged file trust rejects sibling files and remote origins', () => {
  const trusted = 'file:///Applications/YuanpuAgent/resources/app/index.html';
  assert.equal(isTrustedRendererUrl(`${trusted}#chat`, trusted), true);
  assert.equal(isTrustedRendererUrl('file:///Applications/YuanpuAgent/resources/app/other.html', trusted), false);
  assert.equal(isTrustedRendererUrl('https://example.com/index.html', trusted), false);
});
