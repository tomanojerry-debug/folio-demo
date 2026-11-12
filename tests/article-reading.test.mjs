import test from 'node:test';
import assert from 'node:assert/strict';
import { createArticleReadingController, renderArticleReading, articleReadingResult, buildArticleReadingNote, mountArticleReading } from '../site/curator/article-reading.js';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const article = (collectionId = 'one', patch = {}) => ({ collectionId, title:'从真实原文开始', url:'https://example.com/article', documentVersionId:`v-${collectionId}`, sourceRevision:'revision-1', contentHash:`hash-${collectionId}`, coverage:'full', sourceKind:'body_text', complete:true, paragraphs:[{ id:'p1', text:'第一段讲述了观察如何帮助理解。', start:0, end:17 }, { id:'p2', text:'第二段提醒我们结合证据继续追问。', start:19, end:36 }], overview:{ text:'已有理解需要核对原文。', evidenceIds:['p1'], kind:'existing-understanding' }, quotes:[{ id:'q1', text:'观察如何帮助理解', evidenceIds:['p1'], kind:'source-excerpt' }], results:[], ...patch });
const result = (source, patch = {}) => ({ id:'result-1', mode:'overview', title:'阅读重点', documentVersionId:source.documentVersionId, contentHash:source.contentHash, paragraphs:[{ text:'阅读辅助重点。', evidenceIds:['p1'] }], quotes:[{ text:'结合证据继续追问', evidenceIds:['p2'] }], questions:[{ question:'观察与证据是什么关系？', answer:'原文提出观察有助理解，并提醒读者继续追问。', evidenceIds:['p1', 'p2'] }], ...patch });
function fixture(handler = async () => undefined) {
  const calls = [], changes = [];
  const controller = createArticleReadingController({ autoPoll:false, api:async (route, body) => {
    calls.push({ route, body:structuredClone(body) });
    const value = await handler(route, body);
    if (value !== undefined) return value;
    if (route === 'reading/article') return { article:article(body.collectionId), preferences:{ version:3, defaultMode:'overview', fontSize:16, readingWidth:'comfortable', customPrompt:'' } };
    if (route === 'knowledge/similar') return { anchor:{ collectionId:body.collectionId, documentVersionId:`v-${body.collectionId}`, chunks:[] }, items:[], mode:'full_text' };
    return {};
  }, onChange:state => changes.push(state) });
  return { controller, calls, changes };
}
const byRoute = (fixture, route) => fixture.calls.filter(call => call.route === route);

test('opening saved content is passive; original reading and mode changes never call the model', async () => {
  const f = fixture();
  await f.controller.open('one');
  f.controller.setMode('original');
  f.controller.setMode('plain');
  assert.deepEqual(byRoute(f, 'reading/article'), [{ route:'reading/article', body:{ collectionId:'one' } }]);
  assert.deepEqual(byRoute(f, 'knowledge/similar'), [{ route:'knowledge/similar', body:{ collectionId:'one', limit:4 } }]);
  assert.equal(byRoute(f, 'reading/generate').length, 0);
  assert.equal(f.controller.getState().mode, 'plain');
});

test('legacy custom defaults open the interpretation with the saved display preferences and no writes', async () => {
  const f = fixture(async (route, body) => route === 'reading/article' ? { article:article(body.collectionId), preferences:{ version:4, defaultMode:'custom', customPrompt:'先解释概念，再问我一个问题', fontSize:19, readingWidth:'wide' } } : undefined);
  await f.controller.open('one');
  assert.equal(f.controller.getState().mode, 'overview');
  assert.equal(byRoute(f, 'reading/generate').length, 0);
  assert.equal(byRoute(f, 'reading/preferences').length, 0);
  const html = renderArticleReading(f.controller.getState());
  assert.match(html, /--reading-font-size:19px;--reading-measure:100%/);
  assert.match(html, /<option value="overview" selected>解读/);
  assert.doesNotMatch(html, /我的方式|value="custom"|先解释概念/);
});

test('late source or recommendation responses cannot repaint another article or a closed reader', async () => {
  const old = deferred(), related = deferred();
  const f = fixture((route, body) => route === 'reading/article' && body.collectionId === 'old' ? old.promise : route === 'knowledge/similar' && body.collectionId === 'one' ? related.promise : undefined);
  const request = f.controller.open('old');
  await f.controller.open('one');
  await f.controller.open('two');
  old.resolve({ article:article('old') });
  related.resolve({ anchor:{ collectionId:'one' }, items:[{ collectionId:'stale' }] });
  await request;
  await Promise.resolve();
  assert.equal(f.controller.getState().article.collectionId, 'two');
  assert.equal(f.controller.getState().similarItems.length, 0);

  const closing = deferred();
  const closed = fixture(() => closing.promise);
  const load = closed.controller.open('one');
  closed.controller.close();
  const count = closed.changes.length;
  closing.resolve({ article:article() });
  await load;
  assert.equal(closed.changes.length, count);
});

test('generation is explicit, source-bound, and polls source-backed results rather than using a fixture', async () => {
  const source = article();
  let completed = false;
  const f = fixture(async route => {
    if (route === 'reading/generate') return { job:{ id:'job-1', status:'queued', readingMode:'plain' } };
    if (route === 'reading/article') return { article:{ ...source, results:completed ? [result(source, { mode:'plain', paragraphs:[{ text:'观察能帮助你理解。', evidenceIds:['p1'] }] })] : [] }, job:completed ? { id:'job-1', status:'complete', readingMode:'plain' } : null };
  });
  await f.controller.open('one');
  f.controller.setMode('plain');
  assert.match(renderArticleReading(f.controller.getState()), /data-variant="primary"[^>]+data-reading-mode="plain"[^>]*>生成通俗解读/);
  await f.controller.generate('plain');
  const sent = byRoute(f, 'reading/generate')[0].body;
  assert.equal(sent.collectionId, 'one');
  assert.equal(sent.documentVersionId, 'v-one');
  assert.equal(sent.mode, 'plain');
  assert.ok(sent.requestId);
  assert.equal(f.controller.getState().job.id, 'job-1');
  assert.match(renderArticleReading(f.controller.getState()), /正在整理阅读内容/);
  completed = true;
  await f.controller.refresh();
  assert.deepEqual(byRoute(f, 'reading/article').at(-1).body, { collectionId:'one', documentVersionId:'v-one' });
  assert.match(renderArticleReading(f.controller.getState()), /观察能帮助你理解/);
  assert.doesNotMatch(renderArticleReading(f.controller.getState()), /正在整理阅读内容/);
});

test('plain mode shows cited prior interpretation until a matching dedicated reading exists', async () => {
  const source = article();
  const quote = '观察如何帮助理解';
  const start = source.paragraphs[0].text.indexOf(quote);
  source.understanding = { answer:{ text:'观察是理解的起点。', evidenceIds:['p1'], evidence:[{ paragraphId:'p1', quote, start }] }, findings:[{ text:'没有依据的文字', evidenceIds:['unknown'] }] };
  source.results = [result(source, { mode:'plain', documentVersionId:'old', paragraphs:[{ text:'别的版本的通俗解读', evidenceIds:['p1'] }] })];
  const f = fixture(async route => route === 'reading/article' ? { article:source } : undefined);
  await f.controller.open('one');
  f.controller.setMode('plain');
  const state = f.controller.getState();
  const preview = renderArticleReading(state);
  assert.match(preview, /解读要点 · 来自已有的 AI 解读/);
  assert.match(preview, /观察是理解的起点/);
  assert.match(preview, new RegExp(`data-reading-evidence="p1" data-reading-quote="${quote}" data-reading-start="${start}"`));
  assert.doesNotMatch(preview, /没有依据的文字|别的版本的通俗解读/);
  assert.equal(byRoute(f, 'reading/generate').length, 0);
  const cached = result(source, { mode:'plain', paragraphs:[{ text:'多看看实际发生了什么，会更容易弄懂。', evidenceIds:['p1'] }] });
  const rendered = renderArticleReading({ ...state, article:{ ...source, results:[...source.results, cached] } });
  assert.match(rendered, /多看看实际发生了什么/);
  assert.match(rendered, /依据原文/);
  assert.doesNotMatch(rendered, /来自已有的 AI 解读|观察是理解的起点/);
});

test('uncertain submission retries reuse the request ID; failed jobs retry the original question with a new ID', async () => {
  let generation = 0;
  const f = fixture(async route => {
    if (route === 'reading/generate') {
      if (++generation === 1) throw new Error('Network request failed');
      return { job:{ id:'job-1', status:'running', readingMode:'question' } };
    }
    if (route === 'reading/article' && generation > 1) return { article:article(), job:{ id:'job-1', status:'failed', readingMode:'question', error:'模型暂时不可用' } };
  });
  await f.controller.open('one');
  f.controller.setDraft('questionDraft', '原文怎样描述观察？');
  await f.controller.generate('question');
  assert.match(f.controller.getState().generationError, /暂时没有完成/);
  await f.controller.retry();
  assert.deepEqual(byRoute(f, 'reading/generate')[1].body, byRoute(f, 'reading/generate')[0].body);
  await f.controller.refresh();
  f.controller.setDraft('questionDraft', '这是另一个尚未提交的问题');
  await f.controller.retry();
  const latest = byRoute(f, 'reading/generate')[2].body;
  assert.equal(latest.question, '原文怎样描述观察？');
  assert.notEqual(latest.requestId, byRoute(f, 'reading/generate')[1].body.requestId);
});

test('actual cancellation cannot be overwritten by an earlier in-flight poll', async () => {
  const poll = deferred();
  let articleCalls = 0;
  const f = fixture(async route => {
    if (route === 'reading/article' && ++articleCalls > 1) return poll.promise;
    if (route === 'reading/generate') return { job:{ id:'job-1', status:'running', readingMode:'overview' } };
    if (route === 'reading/cancel') return { job:{ id:'job-1', status:'failed', errorCode:'READING_CANCELLED' } };
  });
  await f.controller.open('one');
  await f.controller.generate('overview');
  const pending = f.controller.refresh();
  await f.controller.cancel();
  poll.resolve({ article:article(), job:{ id:'job-1', status:'running' } });
  await pending;
  assert.deepEqual(byRoute(f, 'reading/cancel')[0].body, { jobId:'job-1' });
  assert.equal(f.controller.getState().job.errorCode, 'READING_CANCELLED');
  assert.match(f.controller.getState().generationError, /已取消/);
});

test('the retired article mode does not change the active tab or start a generation', async () => {
  const f = fixture();
  await f.controller.open('one');
  f.controller.setMode('custom');
  assert.equal(f.controller.getState().mode, 'overview');
  await f.controller.generate('custom');
  assert.equal(byRoute(f, 'reading/generate').length, 0);
});

test('a failed preference update does not silently apply or start a reading request', async () => {
  const f = fixture(async route => { if (route === 'reading/preferences') throw new Error('偏好已在另一处更新，请重新打开。'); });
  await f.controller.open('one');
  await f.controller.savePreferences({ defaultMode:'plain' });
  assert.match(f.controller.getState().preferenceError, /另一处更新/);
  assert.equal(byRoute(f, 'reading/generate').length, 0);
  assert.equal(f.controller.getState().preferences.defaultMode, 'overview');
});

test('reading question drafts stay scoped to the collection and source version', async () => {
  let version = 'v-one';
  const f = fixture(async (route, body) => route === 'reading/article' && body.collectionId === 'one' ? { article:article('one', { documentVersionId:version }) } : undefined);
  await f.controller.open('one');
  f.controller.setDraft('questionDraft', '这篇里的问题');
  await f.controller.open('two');
  assert.equal(f.controller.getState().questionDraft, '');
  await f.controller.open('one');
  assert.equal(f.controller.getState().questionDraft, '这篇里的问题');
  version = 'v-one-new';
  await f.controller.open('one');
  assert.equal(f.controller.getState().questionDraft, '');
});

test('a source version or hash change cannot silently replace the text under generated evidence', async () => {
  let calls = 0;
  const f = fixture(async route => route === 'reading/article' ? { article:article('one', ++calls > 1 ? { documentVersionId:'different-version', contentHash:'different-hash', paragraphs:[{ id:'p1', text:'更新后的文本' }] } : {}) } : undefined);
  await f.controller.open('one');
  await f.controller.refresh();
  const state = f.controller.getState();
  assert.equal(state.article.documentVersionId, 'v-one');
  assert.equal(state.article.paragraphs[0].text, '第一段讲述了观察如何帮助理解。');
  assert.match(state.error, /版本已经变化/);
});

test('fresh source refresh intentionally leaves the old version behind and closing clears cached content', async () => {
  let version = 'v-one';
  const f = fixture(async (route, body) => route === 'reading/article' ? { article:article(body.collectionId, { documentVersionId:version, contentHash:`hash-${version}`, paragraphs:[{ id:'p1', text:`正文 ${version}`, start:0, end:9 }] }) } : undefined);
  await f.controller.open('one');
  f.controller.setMode('original');
  version = 'v-new';
  await f.controller.refresh({ currentSource:true });
  assert.equal(f.controller.getState().article.documentVersionId, 'v-new');
  assert.equal(f.controller.getState().mode, 'original');
  assert.deepEqual(byRoute(f, 'reading/article').at(-1).body, { collectionId:'one' });
  f.controller.close();
  assert.equal(f.controller.getState().article, null);
  version = 'v-reopened';
  await f.controller.open('one');
  assert.equal(f.controller.getState().article.documentVersionId, 'v-reopened');
});

test('mount reopens the same collection with fresh data and forceReload follows the current source', async () => {
  // Minimal host contract checks lifecycle integration without adding a second DOM implementation.
  const host = { classList:{ add() {}, remove() {} }, prepend(element) { element.parentNode = this; element.isConnected = true; } };
  const doc = { activeElement:null, querySelector:() => host, createElement:() => ({ parentNode:null, isConnected:false, innerHTML:'', setAttribute() {}, addEventListener() {}, contains:() => false, querySelectorAll:() => [], remove() { this.parentNode = null; this.isConnected = false; } }) };
  const calls = [];
  let version = 'v-one';
  const reader = mountArticleReading({ doc, api:async (route, body) => { calls.push({ route, body }); return route === 'reading/article' ? { article:article('one', { documentVersionId:version, contentHash:version }) } : { items:[] }; } });
  await reader.open('one');
  await reader.open('one');
  assert.equal(calls.filter(call => call.route === 'reading/article').length, 1, 'An unchanged live modal can reattach without fetching');
  reader.close();
  version = 'v-reopened';
  await reader.open('one');
  assert.equal(reader.controller.getState().article.documentVersionId, 'v-reopened');
  version = 'v-latest';
  await reader.open('one', { forceReload:true });
  assert.equal(reader.controller.getState().article.documentVersionId, 'v-latest');
  assert.deepEqual(calls.filter(call => call.route === 'reading/article').at(-1).body, { collectionId:'one' });
  reader.destroy();
});

test('rendering preserves every original paragraph, distinguishes source coverage, and excludes wrong-version output', () => {
  const source = article();
  source.paragraphs[1].text = '长正文。'.repeat(2000);
  source.results = [result(source, { documentVersionId:'old', paragraphs:[{ text:'不属于当前版本的生成文本。', evidenceIds:['p1'] }] })];
  const state = { status:'ready', mode:'original', article:source, preferences:{ fontSize:18 }, similarStatus:'ready', similarItems:[] };
  const html = renderArticleReading(state);
  assert.ok(html.includes(source.paragraphs[1].text));
  assert.match(html, /data-reading-paragraph="p1"/);
  assert.doesNotMatch(html, /不属于当前版本/);
  assert.equal(articleReadingResult({ ...state, mode:'overview' }), null);
  const partial = renderArticleReading({ ...state, article:{ ...source, coverage:'reconstructed', complete:false } });
  assert.match(partial, /保存的证据片段/);
  assert.match(partial, /部分片段，内容可能不完整/);
  const transcript = renderArticleReading({ ...state, article:{ ...source, sourceKind:'transcript' } });
  assert.match(transcript, /保存的转录文本/);
  const image = renderArticleReading({ ...state, article:{ ...source, sourceKind:'image_description' } });
  assert.match(image, /图片的 AI 描述/);
  assert.match(image, /请结合原图阅读/);
});

test('quote cards require exact source text; questions and notes carry immutable real source provenance', () => {
  const source = article();
  source.results = [result(source, { quotes:[{ text:'这句话原文没有说过', evidenceIds:['p1'] }, { text:'结合证据继续追问', evidenceIds:['p2'] }] })];
  const state = { status:'ready', mode:'overview', article:source, preferences:{}, similarStatus:'ready', similarItems:[] };
  const html = renderArticleReading(state);
  assert.doesNotMatch(html, /这句话原文没有说过/);
  assert.match(html, /结合证据继续追问/);
  assert.match(html, /带着问题读/);
  const quote = buildArticleReadingNote(state, 'quote', 0);
  assert.equal(quote.articleTitle, source.title);
  assert.equal(quote.url, source.url);
  assert.equal(quote.documentVersionId, source.documentVersionId);
  assert.deepEqual(quote.source.paragraphIds, ['p1']);
  assert.equal(quote.source.paragraphs[0].text, source.paragraphs[0].text);
  assert.equal(quote.source.contentHash, source.contentHash);
  const question = buildArticleReadingNote(state, 'question', 0);
  assert.equal(question.source.generated, true);
  assert.equal(question.blocks.find(block => block.ai).text, source.results[0].questions[0].answer);
  assert.equal(question.blocks.at(-1).text, '');
  quote.source.paragraphs[0].text = 'local mutation';
  assert.notEqual(source.paragraphs[0].text, 'local mutation');
  assert.equal(buildArticleReadingNote(state, 'quote', 900), null);
});

test('recommendations display actual paired excerpts and reasons, with honest empty and failure states', () => {
  const state = { status:'ready', mode:'overview', article:article(), preferences:{}, similarStatus:'ready', similarMode:'full_text', similarAnchor:{ chunks:[{ text:'起点的实际原文' }] }, similarItems:[{ collectionId:'two', title:'另一条收藏', matchReasons:['共享观察主题'], chunks:[{ text:'另一篇的实际原文' }] }] };
  const html = renderArticleReading(state);
  for (const text of ['接着读什么', '来自你的收藏', '共享观察主题', '起点的实际原文', '另一篇的实际原文', '对照原文', 'data-reading-action="collection"', '关键词相近']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /观点一致|互相支持|相似度\s*\d+%/);
  assert.match(renderArticleReading({ ...state, similarItems:[] }), /暂未找到相似收藏/);
  assert.match(renderArticleReading({ ...state, similarStatus:'error', similarError:'查询暂时不可用' }), /查询暂时不可用/);
});

test('unavailable source does not offer invented reading or model requests', async () => {
  const f = fixture(async route => route === 'reading/article' ? { article:article('one', { paragraphs:[], overview:null, quotes:[], coverage:'unavailable', sourceStatus:'unavailable' }) } : undefined);
  await f.controller.open('one');
  await f.controller.generate('plain');
  assert.equal(byRoute(f, 'reading/generate').length, 0);
  f.controller.setMode('original');
  const html = renderArticleReading(f.controller.getState());
  assert.match(html, /暂时没有可阅读的原文/);
  assert.match(html, /暂未找到相似收藏/);
  assert.doesNotMatch(html, /第一段讲述|完整原文/);
});

test('all article, generated, recommendation, question and error text is escaped; rendering adds no app shell', () => {
  const unsafe = '\"><img src=x onerror=alert(1)><script>alert(1)</script>';
  const source = article('one', { paragraphs:[{ id:'p1', text:unsafe }], title:unsafe, overview:{ text:unsafe, evidenceIds:['p1'] }, quotes:[{ text:unsafe, evidenceIds:['p1'] }] });
  source.results = [result(source, { paragraphs:[{ text:unsafe, evidenceIds:['p1'] }], questions:[{ question:unsafe, answer:unsafe, evidenceIds:['p1'] }] })];
  const html = renderArticleReading({ status:'ready', mode:'overview', article:source, questionDraft:unsafe, preferences:{}, generationError:unsafe, similarStatus:'ready', similarItems:[{ collectionId:unsafe, title:unsafe, matchReasons:[unsafe], chunks:[{ text:unsafe }] }] });
  assert.doesNotMatch(html, /<(?:img|script)\b|onerror="|<aside|<dialog|<h1/);
  assert.match(html, /&lt;img/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-selected="true"/);
});
