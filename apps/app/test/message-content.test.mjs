import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { marked } from 'marked';
import { register } from 'tsx/esm/api';

register({ tsconfig: new URL('../tsconfig.json', import.meta.url).pathname });
const { MessageContent } = await import('../src/shared/message-content.tsx');
const { completeHtmlPreview, completePreviewFence, htmlPreviewDocument, safeImageSource, wrappedHtmlPreview } = await import('../src/shared/preview-content.ts');

test('assistant messages render Markdown structure without executing raw HTML', () => {
  const html = renderToStaticMarkup(createElement(MessageContent, {
    text: '最低测试环境：\n\n- **一个机器人**；\n- Secret 仅存 macOS Keychain；\n\n<script>alert(1)</script>',
  }));

  assert.match(html, /<ul>/);
  assert.match(html, /<strong>.*一个机器人.*<\/strong>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('local Markdown links and Mermaid source names open workspace previews', () => {
  const html = renderToStaticMarkup(createElement(MessageContent, {
    text: '[arch.png](arch.png) 和 `arch.mmd`，以及 [外部图片](https://example.com/arch.png)',
    onOpenFilePath: () => {},
  }));

  assert.match(html, /<button[^>]*class="message-file-link"[^>]*><span>arch\.png<\/span><\/button>/);
  assert.match(html, /<button[^>]*class="message-file-link"[^>]*>arch\.mmd<\/button>/);
  assert.match(html, /<span class="message-link"><span>外部图片<\/span><\/span>/);
  assert.doesNotMatch(html, /<button[^>]*>\s*<button/);
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

test('an html fence wrapping html-preview displays a card instead of source code', () => {
  const input = '说明\n\n```html\n<html-preview>\n<div>架构图</div>\n</html-preview>\n```\n\n结束';
  const token = marked.lexer(input).find((item) => item.type === 'code');
  assert.equal(wrappedHtmlPreview(token), '<div>架构图</div>');
  const rendered = renderToStaticMarkup(createElement(MessageContent, { text: input }));
  assert.match(rendered, /aria-label="图示预览"/);
  assert.match(rendered, /结束/);
  assert.doesNotMatch(rendered, /<pre><code>&lt;html-preview&gt;/);
  assert.equal(wrappedHtmlPreview(marked.lexer('```html\n<div>普通代码</div>\n```')[0]), undefined);
});
