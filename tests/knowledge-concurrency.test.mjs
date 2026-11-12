import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '../desktop/server/state.mjs';
import { createDesktopService } from '../desktop/server/service.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function fixture(collection, { harnessLimits } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forme-knowledge-concurrency-'));
  const state = initialState();
  state.collections = [collection];
  await writeFile(path.join(directory, 'state.json'), JSON.stringify(state));
  const started = deferred(), release = deferred(), calls = [];
  let querySignal;
  let service;
  try {
    service = await createDesktopService({
      directory, config: { zhipuApiKey: '', timeoutMs: 1000 },
      aiEnabled: true, autoCurate: false, knowledgeReranker: null,
      harnessLimits,
      knowledgeEmbedder: {
        space: { model: 'concurrency-test', dimensions: 3 },
        async embed(texts, options) {
          if (options.role === 'query') {
            querySignal = options.signal;
            started.resolve();
            // Deliberately ignore cancellation to verify that shutdown does not
            // depend on a provider cooperating or returning a late result.
            await release.promise;
          }
          return texts.map(() => [1, 0, 0]);
        },
      },
      async chat(_config, input) {
        calls.push(input);
        return { choices: [{ message: { content: '继续核对原文。' } }] };
      },
    });
  } catch (error) {
    release.resolve();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    service, started: started.promise, release: release.resolve, calls,
    querySignal: () => querySignal,
    async cleanup() {
      release.resolve();
      try { await service.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}

test('a correction added during retrieval suppresses old evidence before chat is sent', async () => {
  const marker = 'OLD_EVIDENCE_BLOCKED_DURING_QUERY';
  const body = `冻土观察需要连续温度记录。测试原文标记 ${marker}，用户希望先核对再讨论。`;
  const f = await fixture({
    id: 'permafrost', title: '冻土观察', sourceRevision: 1,
    type: 'user_input', status: 'ready', content: body, input: { mode: 'text', content: body },
    extraction: {
      status: 'qualified', revision: 1, summary: `旧理解 ${marker}`, concepts: ['冻土观察'],
      evidenceBundle: [{ evidence_id: 'e1', source_field: 'body_text', text: body, locator: '原文' }],
    },
  });
  try {
    await f.service.send({ text: '冻土观察具体讲了什么', intent: 'chat' });
    await within(f.started, 'The query did not reach the delayed embedding provider.');
    await f.service.workspace({ ops: [{
      field: 'feedback', key: 'understanding:permafrost',
      value: { decision: 'pending_rewrite', correctionPrompt: '先核对旧理解，不再引用旧证据。' },
    }] });
    f.release();
    await within(f.service.idle(), 'Chat did not complete after retrieval was released.');

    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(f.calls[0].messages), new RegExp(marker));
    const referenceMessage = f.calls[0].messages.find(message => message.content.startsWith('策展参考资料'));
    assert.ok(referenceMessage, 'The test must exercise collection context assembly.');
    const references = JSON.parse(referenceMessage.content.slice(referenceMessage.content.indexOf('\n') + 1));
    for (const reference of references.collections) {
      assert.equal(reference.understandingStatus, 'not_ready');
      assert.equal(reference.evidenceStatus, 'not_available');
    }
    assert.equal(f.service.state().workspace.feedback['understanding:permafrost'].decision, 'pending_rewrite');
    assert.equal((await f.service.knowledgeRead({ collectionId: 'permafrost' })).document.text, body,
      'Suppressing an old chat reference must preserve the saved original.');
  } finally { await f.cleanup(); }
});

test('closing during retrieval aborts the query and finishes before an uncooperative provider returns', async () => {
  const body = '自然光通过窗户进入室内，可以据此讨论采光与阅读环境。';
  const f = await fixture({
    id: 'light', title: '自然光', type: 'user_input', status: 'saved',
    content: body, input: { mode: 'text', content: body },
  });
  try {
    await f.service.send({ text: '自然光有什么作用', intent: 'chat' });
    await within(f.started, 'The query did not reach the delayed embedding provider.');
    assert.equal(f.querySignal().aborted, false);
    await within(f.service.close(), 'Shutdown waited for the uncooperative embedding provider.');
    assert.equal(f.querySignal().aborted, true);
    assert.equal(f.calls.length, 0, 'A canceled query must not proceed to a chat request.');
    // A provider returning after shutdown cannot resume the canceled chat.
    f.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0);
    await f.service.close();
  } finally { await f.cleanup(); }
});

test('the context deadline aborts retrieval, records HARNESS_TIMEOUT and never calls chat', async () => {
  const body = '自然光通过窗户进入房间，可以比较朝向、阅读位置和室内明暗。';
  const f = await fixture({
    id: 'light', title: '自然光', type: 'user_input', status: 'saved',
    content: body, input: { mode: 'text', content: body },
  }, { harnessLimits: { stepTimeoutMs: 30 } });
  try {
    await f.service.send({ text: '自然光的作用是什么', intent: 'chat' });
    await within(f.started, 'The query did not reach the delayed embedding provider.');
    await within(f.service.idle(), 'A timed-out context still waited for its embedding provider.');
    const job = f.service.state().jobs.find(item => item.type === 'chat');
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode, 'HARNESS_TIMEOUT');
    const contextStep = job.harness.steps.find(step => step.tool === 'search-library');
    assert.equal(contextStep.status, 'failed');
    assert.equal(contextStep.errorCode, 'HARNESS_TIMEOUT');
    assert.equal(f.querySignal().aborted, true);
    assert.equal(f.calls.length, 0);
    f.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0, 'Late embedding output cannot resume a timed-out chat.');
  } finally { await f.cleanup(); }
});
