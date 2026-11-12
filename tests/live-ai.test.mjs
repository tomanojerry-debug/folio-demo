import test from 'node:test';
import assert from 'node:assert/strict';
import { requestResult, syncTaskState } from '../site/prototype/immersive-exhibition/live-ai-request.js';

const response = (status, data) => ({ status, ok: status === 200, json: async () => data });

test('pending request automatically retrieves original result using the same ID and body', async () => {
  const calls = [];
  let clock = 0;
  const result = await requestResult('ingest', { requestId: 'pending-original', content: 'source' }, 'csrf', {
    now: () => clock, sleep: async (ms) => { clock += ms; },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body });
      return calls.length < 3 ? response(409, { error: 'REQUEST_RUNNING' }) : response(200, { collection: { id: 'original' } });
    },
  });
  assert.equal(result.collection.id, 'original');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], calls[2]);
});

test('pending recovery is bounded and ends with an actionable message', async () => {
  let clock = 0;
  await assert.rejects(requestResult('ingest', {}, 'csrf', {
    now: () => clock, sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => response(409, { error: 'REQUEST_RUNNING' }),
  }), /点击重试/);
  assert.equal(clock, 240000);
});

test('other conflicts and expired sessions are not silently retried', async () => {
  for (const status of [409, 401]) {
    let calls = 0;
    await assert.rejects(requestResult('ingest', {}, 'csrf', {
      fetchImpl: async () => { calls++; return response(status, { error: 'INVALID_REQUEST', message: 'invalid' }); },
    }), (error) => error.status === status);
    assert.equal(calls, 1);
  }
});

test('browser timeout becomes a readable recovery message', async () => {
  await assert.rejects(requestResult('ingest', {}, 'csrf', {
    fetchImpl: async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); },
  }), /点击重试/);
});

test('interruption, retry, and failure keep collection and extraction in sync', () => {
  const task = { id: 'pending-1', status: 'processing' };
  const draft = { collections: [{ id: task.id, status: 'processing' }], extractions: [{ collectionId: task.id, status: 'processing', hint: '旧提示' }] };
  syncTaskState(draft, task, 'interrupted', '请重试');
  assert.equal(draft.collections[0].status, 'needs_input');
  assert.equal(draft.extractions[0].status, 'interrupted');
  assert.equal(draft.extractions[0].hint, '请重试');
  syncTaskState(draft, task, 'processing', '正在理解');
  assert.equal(task.error, null);
  assert.equal(draft.collections[0].status, 'processing');
  assert.equal(draft.extractions[0].hint, '正在理解');
  syncTaskState(draft, task, 'failed', '服务不可用');
  assert.equal(draft.extractions[0].status, 'failed');
  assert.equal(draft.collections[0].status, 'needs_input');
});

test('failed revision preserves previous understanding', () => {
  const draft = { collections: [{ id: 'original', status: 'ready' }], extractions: [{ collectionId: 'original', status: 'qualified', summary: '已有理解' }] };
  const before = structuredClone(draft);
  const task = { id: 'revision', collectionId: 'original', action: 'revise' };
  syncTaskState(draft, task, 'failed', '重试');
  assert.deepEqual(draft, before);
  assert.equal(task.status, 'failed');
});
