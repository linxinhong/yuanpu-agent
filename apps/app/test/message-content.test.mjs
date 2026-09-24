import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { register } from 'tsx/esm/api';

register();
const { MessageContent } = await import('../src/shared/message-content.tsx');

test('assistant messages render Markdown structure without executing raw HTML', () => {
  const html = renderToStaticMarkup(createElement(MessageContent, {
    text: '最低测试环境：\n\n- **一个机器人**；\n- Secret 仅存 macOS Keychain；\n\n<script>alert(1)</script>',
  }));

  assert.match(html, /<ul>/);
  assert.match(html, /<strong>.*一个机器人.*<\/strong>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
