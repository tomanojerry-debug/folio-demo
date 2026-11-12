import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadingNote } from '../site/prototype/immersive-exhibition/light-workspace.js';
import { createDesktopService } from '../desktop/server/service.mjs';

const payload = { collectionId: 'public-source', documentVersionId: 'version-1', articleTitle: '公开测试文章', url: 'https://science.nasa.gov/', title: '地表温度与气温', source: { kind: 'question', text: '这两个温度有什么不同？', answer: '卫星测量的是地表温度。', paragraphIds: ['p2'] } };
test('a reading thought keeps generated source separate from personal prose and persists in the existing workspace', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-reading-note-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, aiEnabled: false, autoCurate: false, knowledgeEmbedder: null, knowledgeReranker: null, config: { zhipuApiKey: '', embeddingBackend: 'disabled' } };
  let service = await createDesktopService(options);
  t.after(() => service.close());
  const note = createReadingNote(payload, { id: 'reading-note-one', now: '2026-11-11T00:00:00.000Z' });
  assert.equal(note.body, '');
  assert.equal(note.blocks[0].text, '');
  assert.equal(note.blocks[0].ai, false);
  assert.ok(note.citations.every(value => typeof value === 'string'));
  note.blocks[0].text = '我想查一下树冠和地表之间的测量差异。';
  note.body = note.blocks[0].text;
  const before = service.state().collections;
  const patch = { ops: [{ field: 'studioNotes', key: note.id, value: note }] };
  await service.workspace(patch);
  await service.workspace(patch); // A lost response and retry must be the same upsert.
  assert.equal(service.state().workspace.studioNotes.length, 1);
  assert.deepEqual(service.state().collections, before);
  await service.close();
  service = await createDesktopService(options);
  const restored = service.state().workspace.studioNotes[0];
  assert.deepEqual(restored.readingSource, note.readingSource);
  assert.equal(restored.body, note.body);
  assert.deepEqual(restored.citations, note.citations);
  assert.equal(restored.readingSource.documentVersionId, 'version-1');
});

test('a reading thought requires an exact source identity', () => {
  assert.throws(() => createReadingNote({ ...payload, documentVersionId: '' }), /原文位置/);
  assert.throws(() => createReadingNote({ ...payload, source: { text: '' } }), /原文位置/);
});
