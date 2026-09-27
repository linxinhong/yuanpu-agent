import assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from 'tsx/esm/api';

register();

const { createBrowserMemoryStore, initialBrowserState, normalizeAddressInput } = await import('../src/viewer/browser/browser-state.ts');

test('normalizeAddressInput accepts urls, adds https to domains and rejects junk', () => {
  assert.equal(normalizeAddressInput('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(normalizeAddressInput('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173/');
  assert.equal(normalizeAddressInput('example.com'), 'https://example.com');
  assert.equal(normalizeAddressInput('example.com/path'), 'https://example.com/path');
  assert.equal(normalizeAddressInput('about:blank'), 'about:blank');
  assert.equal(normalizeAddressInput('  https://spaces.example  '), 'https://spaces.example');
  assert.equal(normalizeAddressInput('not a url'), undefined);
  assert.equal(normalizeAddressInput(''), undefined);
  assert.equal(normalizeAddressInput('ftp://example.com'), undefined);
});

test('initialBrowserState starts empty and not ready', () => {
  assert.deepEqual(initialBrowserState(), {
    url: '', title: '', canGoBack: false, canGoForward: false, isLoading: false, errorMessage: '', isReady: false,
  });
});

test('browser memory store keeps one url per scope and evicts beyond 50', () => {
  const store = createBrowserMemoryStore();
  store.remember('work:a', 'https://a.example/1');
  store.remember('work:a', 'https://a.example/2');
  store.remember('work:b', 'https://b.example/1');
  assert.equal(store.recall('work:a'), 'https://a.example/2');
  assert.equal(store.recall('work:b'), 'https://b.example/1');
  store.remember('work:a', 'about:blank');
  assert.equal(store.recall('work:a'), 'https://a.example/2', 'about:blank is not remembered');
  for (let index = 0; index < 60; index += 1) store.remember(`work:cap-${index}`, `https://cap.example/${index}`);
  assert.equal(store.recall('work:a'), undefined, 'oldest entries are evicted');
});
