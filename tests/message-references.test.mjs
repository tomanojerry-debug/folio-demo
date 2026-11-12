import test from 'node:test';
import assert from 'node:assert/strict';
import { messageReferences } from '../site/curator/message-references.js';

const collections = [{ id: 'raycast', title: 'Quick AI | Raycast Manual' }, { id: 'mdn', title: '介绍 – JavaScript | MDN' }];

test('legacy retrieval candidates do not appear as citations to a model identity answer', () => {
  const result = messageReferences({ role: 'assistant', text: '我是 GLM 模型。', relatedCollectionIds: ['raycast', 'mdn'] }, collections);
  assert.deepEqual(result.collections, []);
  assert.equal(result.scopeNotice, '');
});

test('new explicit citations resolve only the cited collection in citation order', () => {
  const result = messageReferences({ role: 'assistant', referenceAttribution: 'explicit_citations', relatedCollectionIds: ['mdn', 'raycast'] }, collections);
  assert.deepEqual(result.collections, [collections[1], collections[0]]);
  assert.equal(result.scopeNotice, '');
});

test('unknown, deleted and repeated citations cannot produce empty or duplicate buttons', () => {
  const result = messageReferences({ role: 'assistant', referenceAttribution: 'explicit_citations', relatedCollectionIds: ['deleted', 'mdn', 'mdn', null, {}, 'missing'] }, collections);
  assert.deepEqual(result.collections, [collections[1]]);
  assert.deepEqual(messageReferences({ role: 'assistant', referenceAttribution: 'explicit_citations', relatedCollectionIds: ['deleted'] }, collections).collections, []);
});

test('a history-only context limit describes context without claiming a collection was used', () => {
  const result = messageReferences({ role: 'assistant', referenceAttribution: 'explicit_citations', relatedCollectionIds: [], contextTruncated: true }, collections);
  assert.deepEqual(result.collections, []);
  assert.equal(result.scopeNotice, '本轮上下文较长，部分内容未纳入。');
  assert.equal(messageReferences({ role: 'assistant', contextTruncated: true }, collections).scopeNotice, result.scopeNotice);
});

test('user messages and other roles never display source references or context notices', () => {
  for (const role of ['user', 'system', undefined]) {
    assert.deepEqual(messageReferences({ role, referenceAttribution: 'explicit_citations', relatedCollectionIds: ['raycast'], contextTruncated: true }, collections), { collections: [], scopeNotice: '' });
  }
});

test('missing reference data remains an empty view', () => {
  assert.deepEqual(messageReferences(null), { collections: [], scopeNotice: '' });
  assert.deepEqual(messageReferences({ role: 'assistant', referenceAttribution: 'explicit_citations', relatedCollectionIds: 'raycast' }, collections), { collections: [], scopeNotice: '' });
});
