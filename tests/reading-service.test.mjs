import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopService } from '../desktop/server/service.mjs';
import { validateReadingResult, loadReadingSource, readingMessages, readingParagraphs, READING_SOURCE_LIMIT, PLAIN_READING_PROMPT_VERSION } from '../desktop/server/reading.mjs';

const original = '自然光穿过百叶窗进入工作室，适量遮挡可以减少阅读时的眩光。\n\n作者写道：“我们需要保留光，也需要为眼睛留下休息的余地。”午后的强光需要另外处理。';
function model(_call, context) {
  const ids = [context.evidence_bundle[0].evidence_id], body = context.normalized_content.text;
  return { output: { status: 'candidate', summary: body, summary_evidence_ids: ids,
    digest: { status: 'compact', overview: body, evidence_ids: ids, highlights: [{ text: body, evidence_ids: ids }] },
    breakdown: { status: 'not_applicable', sections: [] }, concepts: [{ value: '自然光', evidence_ids: ids }], content_reliability_score: 0.95, uncertainties: [] }, trace: { model: 'injected-reading-fixture' } };
}
function reply(input, alter = value => value) {
  const data = JSON.parse(input.messages.find(item => item.role === 'user').content);
  const first = data.source.paragraphs[0], last = data.source.paragraphs.at(-1);
  return { choices: [{ message: { content: JSON.stringify(alter({ title: data.task.question || '光线与阅读',
    paragraphs: [{ text: data.task.mode === 'question' ? '原文认为适量遮挡能够减少眩光。' : `阅读方式：${data.task.mode}。适量遮挡可以减少眩光。`, evidenceIds: [first.id] }],
    quotes: [{ text: last.text.slice(0, 12), evidenceIds: [last.id] }],
    questions: [{ question: '为什么需要遮挡？', answer: '因为适量遮挡可以减少眩光。', evidenceIds: [first.id] }] })) } }], usage: { total_tokens: 100 } };
}
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forme-reading-'));
  const options = { directory, config: { zhipuApiKey: '', timeoutMs: 1000 }, aiEnabled: true, autoCurate: false, knowledgeEmbedder: null, knowledgeReranker: null, model, chat: async (_config, input) => reply(input), ...extra };
  let service = await createDesktopService(options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get service() { return service; }, async reopen() { await service.close(); service = await createDesktopService(options); return service; } };
}
async function capture(service) {
  const captured = await service.capture({ mode: 'text', title: '光线与阅读', content: original });
  await service.idle();
  return captured.collectionId;
}

test('real stored paragraphs, exact excerpts and all reading modes use one bounded named model call and persist results', async t => {
  const inputs = [];
  const f = await fixture(t, { chat: async (_config, input) => { inputs.push(input); return reply(input); } });
  const collectionId = await capture(f.service);
  const before = f.service.state();
  const initial = await f.service.readingArticle({ collectionId });
  assert.equal(initial.article.paragraphs.map(item => item.text).join('\n\n'), original);
  assert.equal(initial.article.complete, true);
  assert.equal(initial.article.quotes.length, 1);
  assert.ok(original.includes(initial.article.quotes[0].text));
  for (const mode of ['overview', 'plain', 'custom', 'question']) {
    const generated = await f.service.readingGenerate({ collectionId, requestId: `request-${mode}`, mode, ...(mode === 'custom' ? { prompt: '像一份建筑观察笔记，先讲空间，再讲限制。' } : {}), ...(mode === 'question' ? { question: '遮挡能解决什么？' } : {}) });
    await f.service.idle();
    const job = f.service.state().jobs.find(item => item.id === generated.job.id);
    assert.equal(job.status, 'complete', JSON.stringify(job));
    assert.deepEqual(job.harness.calls.map(item => item.callId), ['CALL-READING']);
    assert.equal(job.readingMode, mode);
    assert.ok(!('readingInput' in job));
  }
  assert.equal(inputs.length, 4);
  assert.ok(inputs.every(input => input.signal instanceof AbortSignal && input.responseFormat === 'json_object'));
  assert.match(inputs[2].messages[1].content, /建筑观察笔记/);
  const article = (await f.service.readingArticle({ collectionId })).article;
  assert.equal(article.results.length, 4);
  assert.ok(article.results.every(result => result.documentVersionId === article.documentVersionId && result.contentHash === article.contentHash
    && result.promptVersion === (result.mode === 'plain' ? PLAIN_READING_PROMPT_VERSION : 'reading-v1')));
  assert.deepEqual(f.service.state().collections, before.collections);
  assert.deepEqual(f.service.state().messages, before.messages);
  const after = await f.reopen();
  assert.equal((await after.readingArticle({ collectionId })).article.results.length, 4);
});

test('idempotent requests are bound to source and payload; preferences change only on explicit save and survive restart', async t => {
  const f = await fixture(t);
  const collectionId = await capture(f.service);
  const request = { collectionId, requestId: 'same-request', mode: 'custom', prompt: '用短句说明。' };
  const first = await f.service.readingGenerate(request);
  const duplicate = await f.service.readingGenerate(request);
  assert.equal(duplicate.job.id, first.job.id);
  await f.service.idle();
  assert.equal((await f.service.readingGenerate(request)).job.id, first.job.id);
  await assert.rejects(f.service.readingGenerate({ ...request, prompt: '改成诗歌。' }), { code: 'REQUEST_CONFLICT' });
  const unchanged = (await f.service.readingPreferences()).preferences;
  assert.equal(unchanged.customPrompt, '');
  const saved = (await f.service.readingPreferences({ expectedVersion: unchanged.version, defaultMode: 'custom', customPrompt: '先讲背景，再解释术语。', fontSize: 20, readingWidth: 'wide' })).preferences;
  assert.equal(saved.version, unchanged.version + 1);
  await assert.rejects(f.service.readingPreferences({ expectedVersion: unchanged.version, fontSize: 18 }), { code: 'READING_PREFERENCES_CHANGED' });
  await assert.rejects(f.service.readingPreferences({ fontSize: 100 }), { code: 'INVALID_REQUEST' });
  assert.deepEqual((await f.reopen().then(service => service.readingPreferences())).preferences, saved);
  assert.deepEqual((await f.service.readingArticle({ collectionId })).preferences, saved);
});

test('invalid citations and fabricated quotes fail without changing the source or chat, and a retry can succeed', async t => {
  let bad = true;
  const f = await fixture(t, { chat: async (_config, input) => reply(input, result => bad ? { ...result, quotes: [{ text: '这句话并没有出现在原文中。', evidenceIds: ['p1'] }] } : result) });
  const collectionId = await capture(f.service), before = f.service.state();
  const { job } = await f.service.readingGenerate({ collectionId, requestId: 'invalid-output', mode: 'plain' });
  await f.service.idle();
  const failed = f.service.state().jobs.find(item => item.id === job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'READING_OUTPUT_INVALID');
  assert.deepEqual(f.service.state().collections, before.collections);
  assert.deepEqual(f.service.state().messages, before.messages);
  bad = false;
  const retry = await f.service.retryJob({ jobId: job.id });
  await f.service.idle();
  assert.equal(f.service.state().jobs.find(item => item.id === retry.job.id).status, 'complete');
  assert.equal((await f.service.readingArticle({ collectionId })).article.results.length, 1);
  const source = { paragraphs: [{ id: 'p1', text: original }] };
  assert.throws(() => validateReadingResult({ choices: [{ message: { content: JSON.stringify({ title: '标题', paragraphs: [{ text: '正文', evidenceIds: ['p999'] }], quotes: [], questions: [] }) } }] }, source), { code: 'READING_OUTPUT_INVALID' });
});

function understandingReply(input, alter = value => value) {
  const { source } = JSON.parse(input.messages[1].content);
  const entry = (text, evidence) => ({ text, evidenceIds:[evidence.id] });
  return { choices:[{ message:{ content:JSON.stringify(alter({
    lead:[entry('工作室可以调节百叶窗遮挡，减少自然光在阅读时产生的眩光。', source.evidence[0])],
    approach:[], findings:[entry('午后的强光需要另外处理。', source.evidence[1])], evidence:[], boundaries:[],
  })) } }] };
}

test('collection understanding stays passive until requested and reopens with exact source evidence', async t => {
  let revision = 1;
  const calls = [];
  const url = 'https://example.com/reading-source';
  const f = await fixture(t, { fetchPage:async () => ({ url, type:'text/plain', text:`${original}\n\n第 ${revision} 版。` }),
    chat:async (_config, input) => {
      const mode = JSON.parse(input.messages[1].content).task.mode;
      calls.push(mode);
      return mode === 'understanding' ? understandingReply(input) : reply(input);
    } });
  const { collectionId } = await f.service.capture({ mode:'link', content:url, title:'收藏解读测试' });
  await f.service.idle();
  const { article } = await f.service.readingArticle({ collectionId });
  assert.equal(article.understanding, null);
  assert.equal(article.canGenerateUnderstanding, true);
  assert.deepEqual(calls, []);

  const regular = await f.service.readingGenerate({ collectionId, requestId:'ordinary-reading', mode:'plain' });
  await f.service.idle();
  const request = { collectionId, documentVersionId:article.documentVersionId, requestId:'editorial-reading', mode:'understanding' };
  const { job } = await f.service.readingGenerate(request);
  await f.service.idle();
  const passive = await f.service.readingArticle({ collectionId });
  assert.equal(passive.job.id, regular.job.id);
  assert.equal(passive.understandingJob.id, job.id);
  assert.equal(passive.understandingJob.status, 'complete');
  assert.deepEqual(passive.understandingJob.harness.calls.map(call => call.callId), ['CALL-READING']);
  assert.equal(passive.article.results.length, 1);
  assert.deepEqual(passive.article.understanding.approach, []);
  const { paragraphId, quote, start, end } = passive.article.understanding.answer.evidence[0];
  assert.equal(passive.article.paragraphs.find(paragraph => paragraph.id === paragraphId).text.includes(quote), true);
  assert.equal(original.slice(start, end), quote);
  assert.deepEqual((await f.service.readingArticle({ collectionId, mode:'understanding' })).job, passive.understandingJob);
  assert.equal((await f.service.readingGenerate(request)).job.id, job.id);
  assert.deepEqual((await f.reopen().then(service => service.readingArticle({ collectionId }))).article.understanding, passive.article.understanding);
  assert.deepEqual(calls, ['plain', 'understanding']);

  revision++;
  await f.service.refreshSource({ collectionId });
  await f.service.idle();
  assert.equal((await f.service.readingArticle({ collectionId })).article.understanding, null);
  const historical = await f.service.readingArticle({ collectionId, documentVersionId:article.documentVersionId });
  assert.deepEqual(historical.article.understanding, passive.article.understanding);
  assert.equal(historical.article.canGenerateUnderstanding, false);
});

test('collection understanding rejects invalid evidence IDs and returns the original when no answer is supportable', async t => {
  let insufficient = false;
  const f = await fixture(t, { chat:async (_config, input) => understandingReply(input, value => insufficient
    ? { lead:[], approach:[], findings:[], evidence:[], boundaries:[] }
    : { ...value, lead:[{ ...value.lead[0], evidenceIds:['e999'] }] }) });
  const collectionId = await capture(f.service);
  for (const [index, code] of ['READING_OUTPUT_INVALID','READING_INSUFFICIENT_SOURCE'].entries()) {
    insufficient = index > 0;
    await f.service.readingGenerate({ collectionId, requestId:`unsupported-${index}`, mode:'understanding' });
    await f.service.idle();
    const { article, job } = await f.service.readingArticle({ collectionId, mode:'understanding' });
    assert.equal(job.errorCode, code);
    assert.equal(article.understanding, null);
    assert.equal(article.paragraphs.map(item => item.text).join('\n\n'), original);
  }
});

test('collection understanding sends bounded labeled evidence and resolves far-end references to literal offsets', () => {
  const body = Array.from({ length:80 }, (_, index) => `第 ${index + 1} 段具体说明何时调节百叶窗以及测量自然光的方法。${'重复测试句，用于模拟较长文章。'.repeat(15)}`).join('\n\n');
  const source = { title:'采光研究', paragraphs:readingParagraphs(body), documentVersionId:'fixture' };
  const messages = readingMessages(source, { mode:'understanding' });
  const { source:modelSource } = JSON.parse(messages[1].content);
  assert.ok(JSON.stringify(modelSource.evidence).length <= 4000);
  assert.ok(modelSource.evidence.length <= 20);
  assert.equal(modelSource.paragraphs, undefined);
  const cited = modelSource.evidence.at(-1);
  const response = { choices:[{ message:{ content:JSON.stringify({ lead:[{ text:'读者可以通过调节百叶窗控制工作室内的自然光。', evidenceIds:[cited.id, ...modelSource.evidence.slice(0,3).map(item=>item.id)] }],
    approach:[], findings:[{text:'没有有效出处的文字不会进入解读。',evidenceIds:['e999']},{text:'研究说明了百叶窗的位置。',evidenceIds:[cited.id]}], evidence:[], boundaries:[] }) } }] };
  const { understanding } = validateReadingResult(response, source, 'understanding');
  const evidence = understanding.answer.evidence[0];
  assert.ok(evidence.start > body.length * 0.9);
  assert.equal(evidence.quote, cited.text);
  assert.equal(body.slice(evidence.start, evidence.end), evidence.quote);
  assert.ok(understanding.answer.evidenceIds.includes(evidence.paragraphId));
  assert.equal(understanding.answer.evidence.length, 4);
  assert.deepEqual(understanding.findings.map(item=>item.text), ['研究说明了百叶窗的位置。']);
});

test('cancellation settles an uncooperative model and late output cannot save a result', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { chat: async (_config, input) => { started(); return new Promise(resolve => { release = () => resolve(reply(input)); }); } });
  const collectionId = await capture(f.service), before = f.service.state();
  const { job } = await f.service.readingGenerate({ collectionId, requestId: 'cancel-output', mode: 'overview' });
  await ready;
  assert.equal((await f.service.readingCancel({ jobId: job.id })).job.errorCode, 'READING_CANCELLED');
  await f.service.idle();
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.service.readingArticle({ collectionId })).article.results.length, 0);
  assert.equal(f.service.state().jobs.find(item => item.id === job.id).errorCode, 'READING_CANCELLED');
  assert.deepEqual(f.service.state().collections, before.collections);
  assert.deepEqual(f.service.state().messages, before.messages);
});

test('a model timeout fails the reading job with its single call recorded', async t => {
  const f = await fixture(t, { harnessLimits: { stepTimeoutMs: 30 }, chat: async () => new Promise(() => {}) });
  const collectionId = await capture(f.service);
  const { job } = await f.service.readingGenerate({ collectionId, requestId: 'timeout-output', mode: 'plain' });
  await f.service.idle();
  const failed = f.service.state().jobs.find(item => item.id === job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'HARNESS_TIMEOUT');
  assert.equal(failed.harness.calls.length, 1);
  assert.equal(failed.harness.calls[0].status, 'failed');
  assert.equal((await f.service.readingArticle({ collectionId })).article.results.length, 0);
});

test('reading works without AI; unavailable sources never receive invented body text', async t => {
  const f = await fixture(t, { aiEnabled: false });
  const collectionId = await capture(f.service);
  const article = (await f.service.readingArticle({ collectionId })).article;
  assert.equal(article.paragraphs.map(item => item.text).join('\n\n'), original);
  await assert.rejects(f.service.readingGenerate({ collectionId, requestId: 'disabled-output', mode: 'plain' }), { code: 'AI_DISABLED' });
  const missing = await f.service.capture({ mode: 'link', title: '只有链接', content: 'https://example.com/article' });
  await f.service.idle();
  const unavailable = (await f.service.readingArticle({ collectionId: missing.collectionId })).article;
  assert.equal(unavailable.sourceStatus, 'unavailable');
  assert.deepEqual(unavailable.paragraphs, []);
  assert.equal(unavailable.overview, null);
  await assert.rejects(f.service.readingGenerate({ collectionId: missing.collectionId, requestId: 'missing-output', mode: 'overview' }), { code: 'READING_SOURCE_UNAVAILABLE' });
});

test('updated sources hide previous results, reject stale versions and bind idempotence to the new source', async t => {
  let revision = 1;
  const f = await fixture(t, { fetchPage: async () => ({ url: 'https://example.com/reading-source', type: 'text/plain', text: `${original}\n\n第 ${revision} 版记录保留了可供核对的边界与限制。` }) });
  const captured = await f.service.capture({ mode: 'link', content: 'https://example.com/reading-source', title: '来源版本测试' });
  await f.service.idle();
  const collectionId = captured.collectionId;
  const request = { collectionId, requestId: 'source-bound-request', mode: 'plain' };
  await f.service.readingGenerate(request);
  await f.service.idle();
  const old = (await f.service.readingArticle({ collectionId })).article;
  assert.equal(old.results.length, 1);
  revision++;
  await f.service.refreshSource({ collectionId });
  await f.service.idle();
  const current = (await f.service.readingArticle({ collectionId })).article;
  assert.notEqual(current.documentVersionId, old.documentVersionId);
  assert.notEqual(current.contentHash, old.contentHash);
  assert.deepEqual(current.results, []);
  await assert.rejects(f.service.readingGenerate({ ...request, requestId: 'stale-request', documentVersionId: old.documentVersionId }), { code: 'SOURCE_CHANGED' });
  await assert.rejects(f.service.readingGenerate(request), { code: 'REQUEST_CONFLICT' });
  assert.equal((await f.service.readingArticle({ collectionId, documentVersionId: old.documentVersionId })).article.results.length, 1);
  await f.service.readingGenerate({ ...request, requestId: 'current-request' });
  await f.service.idle();
  assert.equal((await f.service.readingArticle({ collectionId })).article.results.length, 1);
});

test('restart marks an interrupted reading job failed without marking its collection failed', async t => {
  const f = await fixture(t);
  const collectionId = await capture(f.service);
  const { job } = await f.service.readingGenerate({ collectionId, requestId: 'restart-request', mode: 'plain' });
  await f.service.idle();
  await f.service.close();
  const statePath = path.join(f.directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const stored = state.jobs.find(item => item.id === job.id);
  stored.status = 'running';
  delete stored.readingResultId;
  state.reading.results = [];
  stored.harness.steps.at(-1).status = 'running';
  stored.harness.calls[0].status = 'running';
  const before = structuredClone(state.collections);
  await writeFile(statePath, JSON.stringify(state));
  await f.reopen();
  const failed = f.service.state().jobs.find(item => item.id === job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'INTERRUPTED');
  assert.equal(failed.harness.calls[0].errorCode, 'INTERRUPTED');
  assert.deepEqual(f.service.state().collections, before.map(({ receipt, sourceResult, input, sourceHistory, ...item }) => item));
  assert.equal((await f.service.readingArticle({ collectionId })).article.results.length, 0);
});

test('many short lines cannot amplify source citation metadata and truncated coverage is explicit', async () => {
  const body = '字\n\n'.repeat(13000);
  const article = await loadReadingSource({ async readDocument(args) {
    assert.equal(args.limit, READING_SOURCE_LIMIT);
    return { documentVersionId: 'doc-version', text: body, coverage: 'complete', sourceKind: 'body_text', contentHash: 'fixture-hash', hasMore: true, characterCount: 100000, active: true };
  } }, { id: 'source-fixture', title: '短行正文' });
  assert.ok(article.paragraphs.length <= 160);
  assert.equal(article.paragraphs.map(item => item.text).join(''), body);
  assert.ok(article.paragraphs.every(item => body.slice(item.start, item.end) === item.text));
  assert.equal(article.complete, false);
  assert.equal(article.truncated, true);
  assert.equal(article.characterCount, 100000);
});

test('queued reading cancellation skips its call and shutdown settles the remaining uncooperative model', async t => {
  let calls = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { chat: async () => { calls++; started(); return new Promise(() => {}); } });
  const firstId = await capture(f.service), secondId = await capture(f.service);
  const active = await f.service.readingGenerate({ collectionId: firstId, requestId: 'shutdown-request', mode: 'plain' });
  await ready;
  const queued = await f.service.readingGenerate({ collectionId: secondId, requestId: 'queued-request', mode: 'plain' });
  assert.equal(queued.job.status, 'queued');
  await f.service.readingCancel({ jobId: queued.job.id });
  await f.service.close();
  assert.equal(calls, 1);
  assert.equal(f.service.state().jobs.find(item => item.id === active.job.id).errorCode, 'INTERRUPTED');
  assert.equal(f.service.state().jobs.find(item => item.id === queued.job.id).errorCode, 'READING_CANCELLED');
  assert.ok(f.service.state().collections.every(item => item.status === 'ready'));
});
