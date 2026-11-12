import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurationModelReading } from '../desktop/server/curation-model-reading.mjs';
import { TOPIC_EDITORIAL_MODES, TOPIC_MODEL_MODES } from '../site/curator/curation-mode-definitions.js';

const report = 'The observatory measured a 32-minute change in the orbit after DART struck Dimorphos. The spacecraft flew to a binary asteroid system.\n\nThe team has not determined the exact shape of the resulting crater.';
const report2 = 'The researchers followed the dust cloud and observed debris for one month. Their telescopes independently tracked how the material dispersed.';
const article = (id, text, version = `version-${id}`) => ({ text, title:`Saved report ${id}`, url:`https://example.test/${id}`,
  documentVersionId:version, contentHash:`hash-${version}`, coverage:'complete', active:true, sourceRevision:1, characterCount:text.length });
const completion = entries => ({ model:'injected-reading-fixture', choices:[{ message:{ content:JSON.stringify({ entries }) } }] });
const slotResponses = payload => Object.fromEntries(payload.slots.map(({ id }, index) => [id, {
  text:index ? 'The other report tracked the dust cloud.' : 'The first report measured the orbit.',
  evidenceIds:[payload.source[index ? 1 : 0].excerpts[0].id],
}]).reverse());
const modelPayload = options => JSON.parse(options.messages[1].content);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const state = { collections:[{ id:'first', knowledgeDocumentVersionId:'version-first' }, { id:'second' }, { id:'unselected' }],
    exhibitions:[{ id:'show', title:'DART reports', collectionIds:['first','second'] }], reading:{} };
  const stored = new Map([['first',article('first',report)], ['second',article('second',report2)], ['unselected',article('unselected','User private data outside this exhibition')]]);
  const store = { read:() => structuredClone(state), async update(update) { update(state); } };
  const knowledge = { async readDocument({ collectionId, documentVersionId }) {
    const current = stored.get(collectionId);
    if (!current || documentVersionId && current.documentVersionId !== documentVersionId) throw Object.assign(new Error('Missing article'), { code:'NOT_FOUND' });
    return { ...current };
  } };
  const setup = { store, knowledge, config:{ textModel:'configured-reading-model', timeoutMs:3000 }, aiEnabled:true, ...options };
  const reading = createCurationModelReading(setup);
  t.after(() => reading.close());
  return { reading, state, stored, setup };
}

test('topic read is passive, concurrent identical explicit requests share one call, and citations open exact selected text', async t => {
  let calls = 0;
  const reached = deferred(), respond = deferred();
  const { reading, setup } = fixture(t, { chat:async (_, options) => {
    calls++;
    reached.resolve(options);
    return respond.promise;
  } });
  const query = { exhibitionId:'show', mode:'plain' };
  assert.deepEqual(await reading.read(query), { available:true, result:null });
  assert.equal(calls, 0);
  const first = reading.read({ ...query, generate:true });
  const second = reading.read({ ...query, generate:true });
  const sent = await reached.promise;
  const payload = modelPayload(sent);
  respond.resolve(completion(slotResponses(payload)));
  const [left, right] = await Promise.all([first, second]);
  assert.equal(sent.responseFormat, 'json_object');
  assert.deepEqual(payload.source.map(item => item.title), ['Saved report first', 'Saved report second']);
  assert.ok(payload.source[0].excerpts.some(item => item.quote.includes('32-minute')));
  assert.doesNotMatch(sent.messages[1].content, /private data|https:\/\/example\.test|version-first/);
  assert.deepEqual(left, right);
  assert.equal(left.result.title, 'DART reports');
  assert.deepEqual(left.result.entries.map(({ slot, label }) => [slot, label]), [
    ['event', '发生了什么'], ['evidence', '怎么知道'], ['unknown', '还有什么不确定'],
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(left.result.sources.map(item => item.id), ['first', 'second']);
  for (const entry of left.result.evidence) {
    const original = entry.sourceId === 'first' ? report : report2;
    assert.equal(entry.quote, original.slice(entry.start, entry.end));
    assert.equal(entry.documentVersionId, `version-${entry.sourceId}`);
  }
  const reopened = createCurationModelReading(setup);
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.read(query), left);
  assert.equal(calls, 1);
});

test('5W preserves every row and rejects unfamiliar slots or uncited text', async t => {
  let bad = 'extra';
  let calls = 0;
  const { reading } = fixture(t, { chat:(_, options) => {
    calls++;
    const entries = slotResponses(modelPayload(options));
    entries.where = { status:'missing', evidenceIds:[] };
    if (bad === 'extra') entries.extra = entries.who;
    if (bad === 'omitted') delete entries.why;
    if (bad === 'missing') entries.where.text = 'An unsupported place';
    if (bad === 'ids') entries.who.evidenceIds = ['invented-id'];
    return completion(entries);
  } });
  const request = { exhibitionId:'show', mode:'five-ws', generate:true };
  for (const scenario of ['extra', 'omitted', 'missing', 'ids']) {
    bad = scenario;
    await assert.rejects(reading.read(request), { code:'READING_OUTPUT_INVALID' });
    assert.equal((await reading.read({ ...request, generate:false })).result, null);
  }
  bad = '';
  const { result } = await reading.read(request);
  assert.equal(calls, 9);
  assert.deepEqual(result.entries.map(entry => entry.label), ['谁', '发生了什么', '何时', '何地', '为什么']);
  assert.deepEqual(result.entries[3], { slot:'where', label:'何地', text:'所给原文未说明。', evidenceIds:[], status:'missing' });
});

test('one invalid response can recover without changing the source payload or slot order', async t => {
  const requests = [];
  const { reading } = fixture(t, { chat:(_, options) => {
    const payload = modelPayload(options);
    requests.push(payload);
    if (requests.length === 1) return completion({});
    const entries = slotResponses(payload);
    entries.context = { status:'missing', evidenceIds:[] };
    return completion(entries);
  } });
  const { result } = await reading.read({ exhibitionId:'show', mode:'english', generate:true });
  assert.deepEqual(requests, [requests[0], requests[0]]);
  assert.deepEqual(result.entries.map(entry => entry.label), ['Key takeaway', 'Key evidence', 'Context and limits']);
  assert.equal(result.entries[2].text, 'Not stated in the supplied sources.');
});

test('a perspectives slot with nine real citations retries and accepts eight', async t => {
  const requests = [];
  const { reading, stored } = fixture(t, { chat:(_, options) => {
    const payload = modelPayload(options);
    requests.push(options.messages[0].content);
    const availableIds = payload.source.flatMap(source => source.excerpts.map(excerpt => excerpt.id));
    assert.ok(availableIds.length >= 9);
    const entries = slotResponses(payload);
    entries.differences.evidenceIds = availableIds.slice(0, requests.length === 1 ? 9 : 8);
    return completion(entries);
  } });
  const passages = Array.from({ length:6 }, (_, index) => `Original report paragraph ${index + 1}.`).join('\n\n');
  stored.set('first', article('first', passages));
  stored.set('second', article('second', passages));
  const { result } = await reading.read({ exhibitionId:'show', mode:'perspectives', generate:true });
  assert.equal(requests.length, 2);
  assert.match(requests[0], /1 至 8 个/);
  assert.match(requests[1], /上一次输出的格式无效/);
  assert.match(requests[1], /1 至 8 个/);
  assert.equal(result.entries.find(entry => entry.slot === 'differences').evidenceIds.length, 8);
});

test('custom reading restores the latest prompt and distinguishes earlier prompts', async t => {
  let calls = 0;
  const { reading } = fixture(t, { chat:(_, options) => {
    calls++;
    const input = modelPayload(options);
    return completion({ result:{ text:input.readingPreference, evidenceIds:[input.source[0].excerpts[0].id] } });
  } });
  const query = { exhibitionId:'show', mode:'custom' };
  await assert.rejects(reading.read({ ...query, generate:true }), { code:'INVALID_REQUEST' });
  const older = await reading.read({ ...query, prompt:'先说明测量结果', generate:true });
  const recent = await reading.read({ ...query, prompt:'只解释限制', generate:true });
  assert.equal(recent.result.prompt, '只解释限制');
  assert.deepEqual(await reading.read(query), recent);
  assert.deepEqual(await reading.read({ ...query, prompt:'先说明测量结果' }), older);
  assert.equal(calls, 2);
});

test('a document version change during generation prevents saving a late model result', async t => {
  const reached = deferred(), respond = deferred();
  const { reading, stored, state } = fixture(t, { chat:(_, options) => { reached.resolve(modelPayload(options)); return respond.promise; } });
  const query = { exhibitionId:'show', mode:'chinese' };
  const pending = reading.read({ ...query, generate:true });
  const payload = await reached.promise;
  stored.set('second', article('second', 'Replacement original text.', 'new-version'));
  respond.resolve(completion(slotResponses(payload)));
  await assert.rejects(pending, { code:'SOURCE_CHANGED' });
  assert.equal(state.reading.curationResults, undefined);
  assert.deepEqual(await reading.read(query), { available:true, result:null });
});

test('shutdown aborts a topic generation even when the provider does not settle', async t => {
  const reached = deferred();
  const { reading } = fixture(t, { chat:(_, options) => { reached.resolve(options.signal); return new Promise(() => {}); } });
  const pending = reading.read({ exhibitionId:'show', mode:'concepts', generate:true });
  const settled = assert.rejects(pending, { code:'SERVICE_STOPPING' });
  const signal = await reached.promise;
  await reading.close();
  assert.equal(signal.aborted, true);
  await settled;
});

test('three editorial modes keep distinct cited drafts and never call the model on read-only requests', async t => {
  const requests = [];
  const { reading, setup, state } = fixture(t, { chat:(_, options) => {
    const payload = modelPayload(options);
    requests.push({ payload, instructions:options.messages[0].content });
    const entries = slotResponses(payload);
    const ids = payload.source.map(source => source.excerpts[0].id);
    if (payload.mode === 'compare') {
      entries.common = { status:'missing', evidenceIds:[] };
      entries.contributions.evidenceIds = ids;
    }
    if (payload.mode === 'overview') entries.limit = { status:'missing', evidenceIds:[] };
    return completion(entries);
  } });
  const modes = Object.keys(TOPIC_EDITORIAL_MODES);
  for (const mode of modes) {
    const query = { exhibitionId:'show', mode };
    assert.equal(Object.hasOwn(TOPIC_MODEL_MODES, mode), false, 'main readings are not duplicate picker options');
    assert.deepEqual(await reading.read(query), { available:true, result:null });
    const reply = await reading.read({ ...query, generate:true });
    assert.deepEqual(reply.result.entries.map(({ slot, label }) => [slot, label]), TOPIC_EDITORIAL_MODES[mode].slots.map(({ id, label }) => [id, label]));
    assert.deepEqual(await reading.read(query), reply);
    for (const ref of reply.result.evidence) assert.equal(ref.quote, (ref.sourceId === 'first' ? report : report2).slice(ref.start, ref.end));
  }
  assert.deepEqual(requests.map(({ payload }) => payload.mode), modes);
  assert.match(requests[0].instructions, /第一屏/);
  assert.match(requests[1].instructions, /场景/);
  assert.match(requests[2].instructions, /时间或因果/);
  assert.ok(state.reading.curationResults.every(item => item.exhibitionId === 'show' && item.sourceSignature));
  const reopened = createCurationModelReading({ ...setup, aiEnabled:false });
  t.after(() => reopened.close());
  for (const mode of modes) {
    const cached = await reopened.read({ exhibitionId:'show', mode });
    assert.equal(cached.available, false);
    assert.ok(cached.result);
  }
  assert.equal(requests.length, 3);
});

test('editorial drafts reject a missing answer and a source comparison supported by only one article', async t => {
  const { reading, state } = fixture(t, { chat:(_, options) => {
    const payload = modelPayload(options);
    const entries = slotResponses(payload);
    if (payload.mode === 'overview') entries.answer = { status:'missing', evidenceIds:[] };
    if (payload.mode === 'compare') {
      entries.common = { status:'missing', evidenceIds:[] };
      entries.contributions.evidenceIds = payload.source[0].excerpts.map(({ id }) => id);
    }
    return completion(entries);
  } });
  for (const mode of ['overview', 'compare']) {
    await assert.rejects(reading.read({ exhibitionId:'show', mode, generate:true }), { code:'READING_OUTPUT_INVALID' });
    assert.deepEqual(await reading.read({ exhibitionId:'show', mode }), { available:true, result:null });
  }
  assert.equal(state.reading.curationResults, undefined);
});

test('overview corrects abstract leads, overlong answers, inline citation IDs and examples spanning sources', async t => {
  const requests = [];
  let scenario;
  const { reading, state } = fixture(t, { chat:(_, options) => {
    const payload = modelPayload(options);
    const entries = slotResponses(payload);
    requests.push({ instructions:options.messages[0].content, payload });
    if (requests.length % 2 === 0) return completion(entries);
    if (scenario === 'abstract') entries.answer.text = '主要靠「轨道观测评估」：使用望远镜核对变化。';
    if (scenario === 'length') entries.answer.text = '观察轨道。'.repeat(25);
    if (scenario === 'inline') entries.answer.text = '用望远镜核对轨道变化（E1）。';
    if (scenario === 'example') entries.example.evidenceIds = payload.source.map(source => source.excerpts[0].id);
    return completion(entries);
  } });
  const expected = { abstract:/answer 用抽象方法开头/, length:/answer 的正文超过 90 字/, inline:/编号只放进 evidenceIds/, example:/example 只写一份来源/ };
  for (const [kind, instruction] of Object.entries(expected)) {
    scenario = kind;
    const { result } = await reading.read({ exhibitionId:'show', mode:'overview', generate:true });
    const [first, second] = requests.slice(-2);
    assert.deepEqual(first.payload, second.payload);
    assert.match(second.instructions, instruction);
    assert.equal(result.entries[0].text, 'The first report measured the orbit.');
    state.reading.curationResults = [];
  }
  assert.equal(requests.length, 8);
});

test('single-source exhibitions cannot trigger source-comparison drafting', async t => {
  const { reading, state } = fixture(t, { chat:() => { assert.fail('insufficient sources must not call the model'); } });
  state.exhibitions[0].collectionIds = ['first'];
  assert.deepEqual(await reading.read({ exhibitionId:'show', mode:'compare' }), { available:false, result:null });
  await assert.rejects(reading.read({ exhibitionId:'show', mode:'compare', generate:true }), { code:'READING_SOURCE_UNAVAILABLE' });
});

test('applying a new source leaves the old reading stored and invalidates the current draft for that card', async t => {
  let calls = 0;
  const { reading, stored, state } = fixture(t, { chat:(_, options) => {
    calls++;
    return completion(slotResponses(modelPayload(options)));
  } });
  const query = { exhibitionId:'show', mode:'overview' };
  const { result:old } = await reading.read({ ...query, generate:true });
  stored.set('third', article('third', 'The later team made a second independent observation of the changed orbit.'));
  state.collections.push({ id:'third', knowledgeDocumentVersionId:'version-third' });
  state.exhibitions[0].collectionIds.push('third');
  assert.deepEqual(await reading.read(query), { available:true, result:null });
  assert.equal(calls, 1);
  const { result:current } = await reading.read({ ...query, generate:true });
  assert.deepEqual(old.sources.map(item => item.id), ['first','second']);
  assert.deepEqual(current.sources.map(item => item.id), ['first','second','third']);
  assert.equal(state.reading.curationResults.length, 2);
  assert.notEqual(state.reading.curationResults[0].sourceSignature, state.reading.curationResults[1].sourceSignature);
  assert.equal(calls, 2);
});
