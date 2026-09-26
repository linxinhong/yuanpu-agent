import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { folderPath, isFolderDescendant, reorderedSiblingIds, reorderedVisibleSiblingIds, visibleWorkTree } = await import('../src/modules/work-tree-model.ts');

const folders = [
  { id: 'a', name: '研发', parentId: null, sortOrder: 1 },
  { id: 'b', name: '模型', parentId: 'a', sortOrder: 0 },
  { id: 'c', name: '归档整理', parentId: null, sortOrder: 0 },
];
const conversations = [
  { id: 'one', title: '测试', folderId: 'b', sortOrder: 0, archived: false },
  { id: 'two', title: '旧测试', folderId: 'b', sortOrder: 1, archived: true },
  { id: 'default', title: '', folderId: null, sortOrder: -1, archived: true },
];

test('tree keeps stable IDs while showing arbitrary folder nesting and active/archive views', () => {
  assert.deepEqual(visibleWorkTree(folders, conversations, new Set(['a', 'b']), false)
    .map((node) => [node.kind, node.item.id, node.depth]), [
      ['folder', 'c', 0], ['folder', 'a', 0], ['folder', 'b', 1], ['conversation', 'one', 2],
    ]);
  assert.deepEqual(visibleWorkTree(folders, conversations, new Set(['a', 'b']), true)
    .filter((node) => node.kind === 'conversation').map((node) => node.item.id), ['two']);
  assert.deepEqual(folderPath(folders, 'b').map((folder) => folder.name), ['研发', '模型']);
});

test('move target rejects own descendants and sibling sort only swaps a valid neighbor', () => {
  assert.equal(isFolderDescendant(folders, 'b', 'a'), true);
  assert.equal(isFolderDescendant(folders, 'a', 'b'), false);
  assert.equal(isFolderDescendant(folders, 'a', 'a'), true);
  assert.deepEqual(reorderedSiblingIds(['a', 'c'], 'c', -1), ['c', 'a']);
  assert.equal(reorderedSiblingIds(['a', 'c'], 'c', 1), undefined);
  assert.deepEqual(reorderedVisibleSiblingIds(['A', 'X', 'B'], ['A', 'B'], 'B', -1), ['B', 'X', 'A']);
  assert.deepEqual(reorderedVisibleSiblingIds(['A', 'X', 'B'], ['X'], 'X', -1), undefined);
});
