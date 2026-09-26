import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { resizePanel } = await import('../src/shared/panel-resize.ts');

test('a continuous drag stops at 70%, even after reversing or dragging further', () => {
  const limit = resizePanel(900, 700, false, false);
  assert.deepEqual(limit, { width: 700, maximized: false, stopped: true });
  assert.deepEqual(resizePanel(1000, 700, false, limit.stopped), limit);
  assert.deepEqual(resizePanel(500, 700, false, limit.stopped), limit);
});

test('a new gesture at the limit can maximize or shrink with a small outward dead zone', () => {
  assert.equal(resizePanel(708, 700, true, false).maximized, false);
  assert.equal(resizePanel(730, 700, true, false).maximized, true);
  assert.equal(resizePanel(500, 700, true, false).width, 500);
  assert.equal(resizePanel(10, 700, false, false).width, 260);
  assert.equal(resizePanel(10, 200, false, false).width, 200);
});
