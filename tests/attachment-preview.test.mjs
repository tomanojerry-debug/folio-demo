import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttachmentPreview } from '../site/curator/attachment-preview.js';

const page = (changes = {}) => ({
  attachmentId: 'first', pageRevision: 'a', browserWindowId: '12', browserTabId: '23',
  appName: 'Chrome', title: '当前测试文章', url: 'https://example.org/a', contextStatus: 'ready', ...changes,
});
const body = context => ({ ...context, text: '可查看的文章正文。', readStatus: 'public_page', contentQuality: { status: 'ready' } });

function fixture() {
  const captures = [], reads = [], changes = [];
  const record = list => (context, signal) => new Promise((resolve, reject) => list.push({ context, signal, resolve, reject }));
  const preview = createAttachmentPreview({ capture: record(captures), read: record(reads), onChange: view => changes.push(view) });
  return { preview, captures, reads, changes };
}

test('identification and decline are passive; an explicit read is deduplicated and proves the receipt', async () => {
  const { preview, captures, reads, changes } = fixture();
  for (const bad of [page({ contextStatus: 'reading' }), page({ url: '' }), page({ url: 'https://user:secret@example.org/a' }), page({ pageRevision: '' }), page({title:''}), page({title:'Chrome'})]) {
    preview.observe(bad);
    assert.equal(preview.view.status, 'idle');
  }
  preview.observe(page({ autoRead: true }));
  assert.deepEqual(preview.view, { status: 'identified', source: null, error: '' });
  preview.decline();
  preview.observe(page({ contextVersion: 2 }));
  assert.equal(preview.view.status, 'declined');
  assert.equal(captures.length + reads.length, 0);

  const request = preview.read();
  assert.equal(preview.view.status, 'reading');
  assert.equal(preview.read(), request);
  preview.observe(page({ contextVersion: 3 }));
  captures[0].resolve(page({ contextVersion: 4 }));
  await Promise.resolve();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].signal, captures[0].signal);
  const proof = body(reads[0].context);
  reads[0].resolve(proof);
  assert.equal(await request, proof);
  assert.deepEqual(preview.view, { status: 'ready', source: proof, error: '' });
  assert.equal(await preview.read(), proof);
  assert.deepEqual(changes.map(value => value.status), ['identified', 'declined', 'reading', 'ready']);
  assert.equal(captures.length, 1);
});

test('switching revisions cancels capture and prompts again after declining the previous revision', async () => {
  const { preview, captures, reads } = fixture();
  preview.observe(page());
  preview.decline();
  preview.observe(page({ pageRevision: 'b', url: 'https://example.org/b' }));
  assert.equal(preview.view.status, 'identified');
  const old = preview.read();
  preview.observe(page({ pageRevision: 'c', url: 'https://example.org/c' }));
  assert.equal(captures[0].signal.aborted, true);
  captures[0].resolve(captures[0].context);
  assert.equal(await old, null);
  assert.equal(reads.length, 0);
  assert.equal(preview.view.status, 'identified');
  assert.equal(captures.length, 1);
});

test('detachment invalidates in-flight reads and retired attachments cannot replace a new receipt', async () => {
  const { preview, captures, reads } = fixture();
  preview.observe(page());
  const old = preview.read();
  captures[0].resolve(captures[0].context);
  await Promise.resolve();
  preview.observe(null);
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(preview.view.status, 'idle');

  preview.observe(page({ attachmentId: 'new' }));
  const current = preview.read();
  captures[1].resolve(captures[1].context);
  await Promise.resolve();
  const proof = body(reads[1].context);
  reads[1].resolve(proof);
  assert.equal(await current, proof);
  preview.observe(page());
  reads[0].resolve(body(reads[0].context));
  assert.equal(await old, null);
  assert.equal(preview.view.source, proof);
  preview.destroy();
  assert.equal(preview.view.status, 'idle');
  assert.equal(await preview.read(), null);
});

test('raw metadata and a mismatched reply cannot become a receipt; failure waits for explicit retry', async () => {
  const { preview, captures, reads } = fixture();
  preview.observe(page());
  const first = preview.read();
  captures[0].resolve(captures[0].context);
  await Promise.resolve();
  reads[0].resolve(reads[0].context);
  assert.equal(await first, null);
  assert.equal(preview.view.status, 'error');
  assert.equal(preview.view.source, null);
  preview.observe(page({ contextVersion: 4 }));
  assert.equal(captures.length, 1);

  const retry = preview.read();
  captures[1].resolve(captures[1].context);
  await Promise.resolve();
  reads[1].resolve(body(page({ browserTabId: 'another-tab' })));
  assert.equal(await retry, null);
  assert.equal(preview.view.status, 'error');
  preview.decline();
  assert.equal(preview.view.status, 'declined');
});
