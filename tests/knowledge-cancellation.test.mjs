import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeManager } from '../desktop/server/knowledge/manager.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('A canceled knowledge operation remained pending.')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

const rows = pairs => pairs.map(pair => ({ id: pair.id, score: 0.9 }));
async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forme-knowledge-cancellation-'));
  const collections = [
    { id: 'light', title: '室内采光', body: '窗户让自然光进入房间，朝向影响室内明暗。' },
    { id: 'related', title: '窗户与日照', body: '自然光经过窗户进入建筑，可以结合日照时长研究采光。' },
  ].map(({ body, ...item }) => ({ ...item, status: 'saved', type: 'user_input', sourceRevision: 1, content: body, input: { mode: 'text', content: body } }));
  const manager = await createKnowledgeManager({
    directory, getState: () => ({ collections, jobs: [], workspace: { feedback: {} } }),
    embedder: { space: { model: 'local:cancel-MiniLM', dimensions: 3 }, embed: async texts => texts.map(() => [1, 0, 0]) },
    reranker: null, ...options,
  });
  await manager.idle();
  return { manager, async close() { try { await manager.close(); } finally { await rm(directory, { recursive: true, force: true }); } } };
}

test('already canceled searches and similarity requests never start inference', async () => {
  let queryCalls = 0, rankingCalls = 0;
  const f = await fixture({
    embedder: { space: { model: 'local:cancel-MiniLM', dimensions: 3 }, embed: async (texts, { role }) => { if (role === 'query') queryCalls++; return texts.map(() => [1, 0, 0]); } },
    reranker: { rerank: async (_query, pairs) => { rankingCalls++; return rows(pairs); } },
  });
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.manager.search({ query: 'sunbeam' }, { signal: controller.signal }), { code: 'KNOWLEDGE_ABORTED' });
    await assert.rejects(f.manager.findSimilar({ collectionId: 'light' }, { signal: controller.signal }), { code: 'KNOWLEDGE_ABORTED' });
    assert.equal(queryCalls, 0);
    assert.equal(rankingCalls, 0);
    assert.equal(f.manager.status().semanticStatus, 'ready');
  } finally { await f.close(); }
});

test('canceling one live query leaves an identical caller and the successful query cache intact', async () => {
  const started = deferred(), pending = [];
  let queryCalls = 0;
  const f = await fixture({ embedder: {
    space: { model: 'local:cancel-MiniLM', dimensions: 3 },
    async embed(texts, { role, signal }) {
      if (role === 'query') {
        queryCalls++;
        const gate = deferred(); pending.push({ gate, signal });
        if (pending.length === 2) started.resolve();
        await gate.promise;
      }
      return texts.map(() => [1, 0, 0]);
    },
  } });
  try {
    const controller = new AbortController();
    const first = f.manager.search({ query: 'sunbeam' }, { signal: controller.signal });
    const rejected = assert.rejects(first, { code: 'KNOWLEDGE_ABORTED' });
    const second = f.manager.search({ query: 'sunbeam' });
    await within(started.promise);
    controller.abort();
    await within(rejected);
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending[1].signal.aborted, false);
    pending[1].gate.resolve();
    assert.equal((await within(second)).items.length, 2);
    pending[0].gate.resolve();
    await within(f.manager.idle());
    await f.manager.search({ query: 'sunbeam' });
    assert.equal(queryCalls, 2, 'Only completed results are reused; canceling another caller preserves the successful LRU entry.');
    assert.equal(f.manager.status().semanticStatus, 'ready');
    assert.equal(f.manager.status().lastErrorCode, undefined);
  } finally { pending.forEach(item => item.gate.resolve()); await f.close(); }
});

test('request timeout cancels an uncooperative query without a failure cooldown or late cache write', async () => {
  const started = deferred(), release = deferred();
  let observedSignal, queryCalls = 0;
  const f = await fixture({ embedder: {
    space: { model: 'local:cancel-MiniLM', dimensions: 3 },
    async embed(texts, { role, signal }) {
      if (role === 'query' && ++queryCalls === 1) {
        observedSignal = signal; started.resolve(); await release.promise;
      }
      return texts.map(() => [1, 0, 0]);
    },
  } });
  try {
    const request = f.manager.search({ query: 'sunbeam' }, { signal: AbortSignal.timeout(50) });
    const rejected = assert.rejects(request, { code: 'KNOWLEDGE_ABORTED' });
    await within(started.promise);
    await within(rejected);
    assert.equal(observedSignal.aborted, true);
    await within(f.manager.idle());
    assert.equal(f.manager.status().semanticStatus, 'ready');
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.manager.search({ query: 'sunbeam' })).items.length, 2);
    assert.equal(queryCalls, 2, 'A canceled late result cannot populate the cache or impose a retry cooldown.');
  } finally { release.resolve(); await f.close(); }
});

test('reranker cancellation is independent for identical searches and never exposes fallback candidates', async () => {
  const started = deferred(), pending = [];
  const f = await fixture({ reranker: {
    async rerank(_query, pairs, { signal }) {
      const gate = deferred(); pending.push({ gate, signal });
      if (pending.length === 2) started.resolve();
      await gate.promise;
      return rows(pairs);
    },
  } });
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(f.manager.search({ query: 'sunbeam' }, { signal: controller.signal }), { code: 'KNOWLEDGE_ABORTED' });
    const second = f.manager.search({ query: 'sunbeam' });
    await within(started.promise);
    controller.abort();
    await within(rejected);
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending[1].signal.aborted, false);
    pending[1].gate.resolve();
    assert.equal((await within(second)).reranked, true);
    await within(f.manager.idle());
    assert.equal(f.manager.status().rerankingStatus, 'ready');
    assert.equal(f.manager.status().lastRerankingErrorCode, undefined);
  } finally { pending.forEach(item => item.gate.resolve()); await f.close(); }
});

test('canceling similarity aborts every reverse-direction ranking request', async () => {
  const started = deferred(), release = deferred(), signals = [];
  const f = await fixture({ reranker: {
    async rerank(query, pairs, { signal }) {
      if (query !== '室内采光') {
        signals.push(signal); started.resolve(); await release.promise;
      }
      return rows(pairs);
    },
  } });
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(f.manager.findSimilar({ collectionId: 'light' }, { signal: controller.signal }), { code: 'KNOWLEDGE_ABORTED' });
    await within(started.promise);
    controller.abort();
    await within(rejected);
    assert.ok(signals.length > 0 && signals.every(signal => signal.aborted));
    await within(f.manager.idle());
    assert.equal(f.manager.status().lastRerankingErrorCode, undefined);
  } finally { release.resolve(); await f.close(); }
});
