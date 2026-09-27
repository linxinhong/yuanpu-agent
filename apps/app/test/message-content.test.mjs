import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { marked } from 'marked';
import { register } from 'tsx/esm/api';

register();
const { MessageContent } = await import('../src/shared/message-content.tsx');
const { completeHtmlPreview, completePreviewFence, htmlPreviewDocument, safeImageSource } = await import('../src/shared/preview-content.ts');

test('assistant messages render Markdown structure without executing raw HTML', () => {
  const html = renderToStaticMarkup(createElement(MessageContent, {
    text: '最低测试环境：\n\n- **一个机器人**；\n- Secret 仅存 macOS Keychain；\n\n<script>alert(1)</script>',
  }));

  assert.match(html, /<ul>/);
  assert.match(html, /<strong>.*一个机器人.*<\/strong>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('html-preview waits for the closing fence and leaves surrounding Markdown intact', () => {
  const complete = '之前。\n\n```html-preview\n<svg><text>图示</text></svg>\n```\n\n之后。';
  const partial = '之前。\n\n```html-preview\n<svg><text>图示</text></svg>';
  const code = marked.lexer(complete).find((token) => token.type === 'code');
  const pending = marked.lexer(partial).find((token) => token.type === 'code');
  assert.equal(completeHtmlPreview(code), true);
  assert.equal(completeHtmlPreview(pending), false);
  const rendered = renderToStaticMarkup(createElement(MessageContent, { text: complete }));
  assert.match(rendered, /之前。/);
  assert.match(rendered, /图示预览/);
  assert.match(rendered, /sandbox=""/);
  assert.match(rendered, /之后。/);
  assert.match(renderToStaticMarkup(createElement(MessageContent, { text: partial })), /正在生成图示/);
});

test('preview document blocks scripts and network; image sources reject executable schemes', () => {
  const document = htmlPreviewDocument('<svg><rect width="10" height="10"/></svg>');
  assert.match(document, /script-src 'none'/);
  assert.match(document, /connect-src 'none'/);
  assert.match(document, /<svg>/);
  assert.deepEqual(safeImageSource('./assets/chart.png'), { kind: 'workspace', value: 'assets/chart.png' });
  assert.equal(safeImageSource('javascript:alert(1)'), null);
  assert.equal(safeImageSource('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(safeImageSource('../secret.png'), null);
});

test('mermaid graph waits for a complete fence before rendering', () => {
  const complete = '架构：\n\n```mermaid\ngraph TB\nA --> B\n```\n\n完成。';
  const partial = '```mermaid\ngraph TB\nA --> B';
  assert.equal(completePreviewFence(marked.lexer(complete).find((token) => token.type === 'code'), 'mermaid'), true);
  assert.equal(completePreviewFence(marked.lexer(partial).find((token) => token.type === 'code'), 'mermaid'), false);
  const rendered = renderToStaticMarkup(createElement(MessageContent, { text: complete }));
  assert.match(rendered, /正在生成图表/);
  assert.match(rendered, /完成。/);
  assert.match(renderToStaticMarkup(createElement(MessageContent, { text: partial })), /正在生成图表/);
});
