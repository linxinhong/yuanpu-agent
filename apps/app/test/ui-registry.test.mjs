import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiRegistry } from '../src/ui-registry.ts';

test('contributions have stable order and reversible ownership', () => {
  const registry = createUiRegistry();
  const changes = [];
  const unsubscribe = registry.subscribe(() => changes.push(registry.getSnapshot().map((item) => item.id)));
  const removeSkills = registry.register({ id: 'skills', label: '技能', order: 20, render: () => null });
  const removeWork = registry.register({ id: 'work', label: '工作', order: 10, render: () => null });
  assert.deepEqual(registry.getSnapshot().map((item) => item.id), ['work', 'skills']);
  assert.throws(() => registry.register({ id: 'work', label: '重复', order: 0, render: () => null }), /Duplicate/);
  removeSkills();
  removeSkills();
  assert.deepEqual(registry.getSnapshot().map((item) => item.id), ['work']);
  removeWork();
  unsubscribe();
  assert.equal(changes.length, 4);
});
