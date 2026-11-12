import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeController, renderKnowledgeContent } from '../site/curator/knowledge-panel.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(api = async () => ({})) {
  const calls = [], changes = [];
  const controller = createKnowledgeController({ api:async (route, body) => { calls.push({ route, body }); return api(route, body); }, onChange:state => changes.push(state) });
  return { controller, calls, changes };
}

test('opening search is passive and preserves a local filter as an editable draft', () => {
  const f = fixture();
  f.controller.showSearch('注意力');
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.getState().query, '注意力');
  assert.equal(f.controller.getState().status, 'idle');
});

test('search sends only an explicit trimmed query and bounded results to the local route', async () => {
  const f = fixture(async () => ({ items:[{ collectionId:'one' }], mode:'full_text', semanticStatus:'unconfigured' }));
  await f.controller.search('  自然光  ');
  assert.deepEqual(f.calls, [{ route:'knowledge/search', body:{ query:'自然光', limit:5 } }]);
  assert.equal(f.controller.getState().query, '自然光');
  assert.equal(f.controller.getState().mode, 'full_text');
  assert.equal(f.controller.getState().semanticStatus, 'unconfigured');
  await f.controller.search(' ');
  await f.controller.search('字'.repeat(2001));
  assert.equal(f.calls.length, 1, 'Invalid query must not start a request');
  assert.equal(f.controller.getState().status, 'error');
});

test('similar searches pass the anchor ID and never modify a collection', async () => {
  const f = fixture(async () => ({ anchor:{ title:'起点', chunks:[] }, items:[], mode:'hybrid' }));
  await f.controller.similar('  source-one ');
  assert.deepEqual(f.calls, [{ route:'knowledge/similar', body:{ collectionId:'source-one', limit:5 } }]);
  assert.equal(f.controller.getState().anchor.title, '起点');
  await f.controller.similar(null);
  await f.controller.read({ id:'source-one' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.getState().status, 'error');
});

test('late search and closed-panel responses cannot overwrite a newer visible result', async () => {
  const pending = deferred();
  const f = fixture(async route => route === 'knowledge/search' ? pending.promise : { document:{ collectionId:'one', documentVersionId:'v1', chunks:[{ text:'当前原文' }] } });
  const old = f.controller.search('旧问题');
  await f.controller.read('one');
  pending.resolve({ items:[{ collectionId:'old' }] });
  await old;
  assert.equal(f.controller.getState().view, 'read');
  assert.equal(f.controller.getState().document.chunks[0].text, '当前原文');

  const closing = deferred();
  const closed = fixture(() => closing.promise);
  const request = closed.controller.search('已关闭的问题');
  const changeCount = closed.changes.length;
  closed.controller.cancel();
  closing.resolve({ items:[{ collectionId:'late' }] });
  await request;
  assert.equal(closed.changes.length, changeCount);
});

test('reading more follows character offsets and preserves continued chunks with the same ID', async () => {
  const f = fixture(async (_route, body) => ({ document:{ collectionId:'one', documentVersionId:'v1', chunks:[{ chunkId:'c1', text:body.offset ? '后半段' : '前半段' }], hasMore:!body.offset, nextOffset:body.offset ? undefined : 4000 } }));
  await f.controller.read('one');
  await f.controller.more();
  assert.deepEqual(f.calls, [{ route:'knowledge/read', body:{ collectionId:'one' } }, { route:'knowledge/read', body:{ collectionId:'one', offset:4000, documentVersionId:'v1' } }]);
  assert.deepEqual(f.controller.getState().document.chunks.map(chunk => chunk.text), ['前半段', '后半段']);
  await f.controller.more();
  assert.equal(f.calls.length, 2);
});

test('a changed source version cannot be silently appended to the version being read', async () => {
  const f = fixture(async (_route, body) => ({ document:{ collectionId:'one', documentVersionId:body.offset ? 'v2' : 'v1', chunks:[{ text:body.offset ? '更新的正文' : '原版正文' }], hasMore:true, nextOffset:body.offset ? 8000 : 4000 } }));
  await f.controller.read('one');
  await f.controller.more();
  const state = f.controller.getState();
  assert.equal(state.status, 'page_error');
  assert.deepEqual(state.document.chunks.map(chunk => chunk.text), ['原版正文']);
  assert.match(state.error, /原文已经更新/);
});

test('malformed pagination and wrong-source responses produce readable errors', async () => {
  const f = fixture(async () => ({ document:{ collectionId:'one', chunks:[], hasMore:true, nextOffset:0 } }));
  await f.controller.read('one');
  assert.equal(f.controller.getState().status, 'error');
  assert.match(f.controller.getState().error, /后续原文/);
  const wrong = fixture(async () => ({ document:{ collectionId:'other', chunks:[] } }));
  await wrong.controller.read('one');
  assert.equal(wrong.controller.getState().document, null);
  assert.match(wrong.controller.getState().error, /原文暂时不可用/);
});

test('service failures retain friendly Chinese errors and can be retried explicitly', async () => {
  let calls = 0;
  const f = fixture(async () => { if (calls++ === 0) throw new Error('Network fetch failed'); return { items:[] }; });
  await f.controller.search('建筑');
  assert.match(f.controller.getState().error, /暂时无法加载/);
  await f.controller.search('建筑');
  assert.equal(f.controller.getState().status, 'ready');
});

test('similar results render evidence from both sources without inventing agreement', () => {
  const html = renderKnowledgeContent({ view:'similar', status:'ready', mode:'full_text', anchor:{ title:'光线与空间', chunks:[{ text:'起点原文', locator:'第 2 节' }] }, items:[{ collectionId:'two', title:'空间的感受', matchReasons:['讨论相近的问题'], chunks:[{ text:'候选原文', locator:'第 4 段' }] }] });
  for (const value of ['光线与空间', '起点原文', '第 2 节', '候选原文', '第 4 段', '对照原文', '按关键词搜索', 'data-knowledge-action="collection"', 'data-knowledge-action="read"']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /观点一致|互相支持|向量|数据库|讨论相近的问题/);
  assert.match(html, /<details class="forme-knowledge-comparison">/);
});

test('all source data, titles, IDs, reasons, locators and errors are escaped', () => {
  const unsafe = '\"><img src=x onerror=alert(1)><script>alert(1)</script>';
  const html = renderKnowledgeContent({ view:'similar', status:'ready', anchor:{ title:unsafe, chunks:[{ text:unsafe, locator:unsafe }] }, items:[{ collectionId:unsafe, title:unsafe, matchReasons:[unsafe], chunks:[{ text:unsafe, locator:unsafe }] }] });
  assert.doesNotMatch(html, /<(?:img|script)\b|data-knowledge-id=""\s*>/);
  assert.match(html, /&lt;img/);
  const error = renderKnowledgeContent({ status:'error', error:unsafe });
  assert.doesNotMatch(error, /<img/);
  assert.match(error, /role="alert"/);
});

test('reader distinguishes image descriptions, partial source coverage and pagination', () => {
  const reconstructed = renderKnowledgeContent({ view:'read', status:'ready', document:{ title:'旧收藏', coverage:'reconstructed', chunks:[{ locator:'旧证据', text:'有依据的片段。' }] } });
  assert.match(reconstructed, /部分片段，内容可能不完整/);
  const html = renderKnowledgeContent({ view:'read', status:'ready', document:{ title:'图片', sourceKind:'image_description', coverage:'partial', chunks:[{ locator:'图片描述', text:'画面中的内容。' }], hasMore:true } });
  assert.match(html, /图片的 AI 描述/);
  assert.match(html, /请结合原图阅读/);
  assert.match(html, /部分原文/);
  assert.match(html, /继续阅读/);
  const original = renderKnowledgeContent({ view:'read', status:'ready', document:{ title:'文章', sourceKind:'body_text', chunks:[{ text:'真实正文' }] } });
  assert.match(original, /class="forme-knowledge-reading-text">真实正文/);
  assert.doesNotMatch(original, /图片的 AI 描述|继续阅读/);
  const unavailable = renderKnowledgeContent({ view:'read', status:'ready', document:{ collectionId:'one', documentVersionId:null, title:'还没读到的网页', coverage:'unavailable', chunks:[], text:'' } });
  assert.match(unavailable, /暂时没有可阅读的原文/);
  assert.doesNotMatch(unavailable, /保存在本机的原文/);
});

test('empty and pending states do not imply that missing results prove nothing was saved', () => {
  assert.match(renderKnowledgeContent({ view:'search', status:'ready', items:[] }), /暂时没有找到相关收藏/);
  assert.match(renderKnowledgeContent({ view:'similar', status:'ready', items:[] }), /暂未找到相似收藏/);
  assert.match(renderKnowledgeContent({ status:'loading' }), /role="status"/);
  assert.doesNotMatch(renderKnowledgeContent({ view:'search', status:'ready', items:[] }), /收藏库没有|你没有收藏/);
});

test('search previews stay short and retain a match near the end while the reader preserves all text', () => {
  const body = '普通背景。'.repeat(200) + '北极冻土观测需要连续温度记录。';
  const chunk = { chunkId:'one', locator:'原文片段', text:body };
  const preview = renderKnowledgeContent({ view:'search', status:'ready', mode:'full_text', items:[{ collectionId:'one', title:'观察', chunks:[chunk], matchedTerms:['北极冻土'] }] });
  assert.match(preview, /北极冻土/);
  assert.match(preview, /节选/);
  assert.ok(preview.length < 1400, 'A long excerpt must not push the next result many screens away');
  const reader = renderKnowledgeContent({ view:'read', status:'ready', document:{ title:'观察', chunks:[chunk] } });
  assert.ok(reader.includes(body), 'Reading the source keeps every returned source character');
});

test('a matched passage opens at its saved version and offset, then returns to the same results', async () => {
  const hit = { collectionId:'one', documentVersionId:'version-one', title:'长文', chunks:[{ start:12000, text:'长文末尾的命中证据。' }] };
  const f = fixture(async (route, body) => route.endsWith('/search') ? { items:[hit], mode:'full_text' } : { document:{ collectionId:'one', documentVersionId:'version-one', offset:body.offset, chunks:hit.chunks, active:false } });
  await f.controller.search('命中证据');
  const resultHTML = renderKnowledgeContent(f.controller.getState());
  assert.match(resultHTML, /data-knowledge-offset="12000"/);
  assert.match(resultHTML, /data-knowledge-version="version-one"/);
  await f.controller.read('one', { offset:12000, documentVersionId:'version-one' });
  assert.deepEqual(f.calls.at(-1), { route:'knowledge/read', body:{ collectionId:'one', offset:12000, documentVersionId:'version-one' } });
  const readHTML = renderKnowledgeContent(f.controller.getState());
  assert.match(readHTML, /从头阅读/);
  assert.match(readHTML, /历史版本/);
  assert.match(readHTML, /返回搜索结果/);
  f.controller.back();
  assert.equal(f.controller.getState().view, 'search');
  assert.equal(f.controller.getState().query, '命中证据');
  assert.deepEqual(f.controller.getState().items, [hit]);
  assert.equal(f.calls.length, 2, 'Back restores the reviewed result snapshot without another query');
});

const connectionFixture = (collectionId = 'anchor') => ({
  mode:'evidence_graph', graphVersion:'evidence-concepts-v1',
  anchor:{ collectionId, title:`起点-${collectionId}`, documentVersionId:`version-${collectionId}`, chunks:[{ chunkId:'a1', start:1200, end:1210, text:'起点文章讨论注意力分配。', locator:'起点第 3 段' }] },
  items:[
    { collectionId:'attention', title:'注意力与通知', documentVersionId:'version-attention', relationType:'shared_concept', concepts:[{ id:'concept-attention', name:'注意力', mentionType:'literal_mention' }],
      anchorChunks:[{ chunkId:'a2', start:2400, text:'起点文章的对应注意力证据。', locator:'起点第 7 段' }],
      chunks:[{ chunkId:'b1', start:4800, text:'关联文章说明通知如何影响注意力。', locator:'关联第 9 段' }], matchReasons:['共同提及：注意力'] },
    { collectionId:'coffee', title:'咖啡与风味', documentVersionId:'version-coffee', relationType:'shared_concept', concepts:[{ id:'concept-coffee', name:'咖啡', mentionType:'extracted_topic' }],
      anchorChunks:[{ chunkId:'a3', start:3600, text:'起点关于咖啡的独立原文依据。' }], chunks:[{ chunkId:'c1', start:7200, text:'咖啡风味的原文依据。' }], matchReasons:['系统识别的共同主题：咖啡'] },
    { collectionId:'focus', title:'保持专注', documentVersionId:'version-focus', relationType:'related_topic', concepts:[],
      anchorChunks:[{ chunkId:'a4', start:6000, text:'起点关于专注的原文依据。' }], chunks:[{ chunkId:'d1', start:8400, text:'专注工作的原文依据。' }], matchReasons:['原文讨论相近的问题'] },
  ],
});

test('connections are requested explicitly with the source identity and bounded results', async () => {
  const f = fixture(async () => connectionFixture());
  assert.equal(f.calls.length, 0);
  await f.controller.connections(' anchor ');
  assert.deepEqual(f.calls, [{ route:'knowledge/connections', body:{ collectionId:'anchor', limit:8 } }]);
  assert.equal(f.controller.getState().view, 'connections');
  assert.equal(f.controller.getState().anchor.collectionId, 'anchor');
  assert.equal(f.controller.getState().items.length, 3);
  await f.controller.connections(null);
  assert.equal(f.calls.length, 1);
  assert.match(f.controller.getState().error, /有效收藏/);
});

test('connections require the requested anchor and ignore late or canceled graph responses', async () => {
  const invalid = fixture(async () => connectionFixture('other'));
  await invalid.controller.connections('anchor');
  assert.equal(invalid.controller.getState().status, 'error');
  assert.equal(invalid.controller.getState().anchor, null);
  const pending = deferred();
  const f = fixture(async (_route, body) => body.collectionId === 'old' ? pending.promise : connectionFixture(body.collectionId));
  const old = f.controller.connections('old');
  await f.controller.connections('new');
  pending.resolve(connectionFixture('old')); await old;
  assert.equal(f.controller.getState().anchor.collectionId, 'new');
  const closedReply = deferred(), closed = fixture(() => closedReply.promise);
  const request = closed.controller.connections('anchor');
  const changes = closed.changes.length; closed.controller.cancel();
  closedReply.resolve(connectionFixture()); await request;
  assert.equal(closed.changes.length, changes);
});

test('concept selection filters the graph and evidence locally without another API request', async () => {
  const f = fixture(async () => connectionFixture());
  await f.controller.connections('anchor');
  f.controller.filterConcept('concept-attention');
  const filtered = renderKnowledgeContent(f.controller.getState());
  assert.match(filtered, /注意力与通知/);
  assert.doesNotMatch(filtered, /咖啡与风味|保持专注/);
  assert.match(filtered, /data-knowledge-concept="concept-attention" aria-pressed="true"/);
  assert.match(filtered, /1 篇关联收藏/);
  assert.equal(f.calls.length, 1);
  f.controller.filterConcept('unknown');
  assert.equal(f.controller.getState().conceptFilter, 'concept-attention');
  f.controller.filterConcept('concept-attention');
  assert.match(renderKnowledgeContent(f.controller.getState()), /3 篇关联收藏/);
});

test('a recursive graph and evidence reader return through the same exploration path', async () => {
  const f = fixture(async (route, body) => route.endsWith('/search') ? { items:[{ collectionId:'anchor', title:'检索起点' }] }
    : route.endsWith('/connections') ? connectionFixture(body.collectionId)
      : { document:{ collectionId:body.collectionId, documentVersionId:body.documentVersionId, offset:body.offset, chunks:[{ text:'精确位置的原文。' }] } });
  await f.controller.search('注意力');
  await f.controller.connections('anchor');
  f.controller.filterConcept('concept-attention');
  await f.controller.connections('attention');
  await f.controller.read('attention', { offset:4800, documentVersionId:'version-attention' });
  assert.match(renderKnowledgeContent(f.controller.getState()), /返回关联图/);
  f.controller.back();
  assert.equal(f.controller.getState().anchor.collectionId, 'attention');
  f.controller.back();
  assert.equal(f.controller.getState().anchor.collectionId, 'anchor');
  assert.equal(f.controller.getState().conceptFilter, 'concept-attention');
  f.controller.back();
  assert.equal(f.controller.getState().view, 'search');
  assert.equal(f.controller.getState().query, '注意力');
  assert.equal(f.controller.getState().canGoBack, false);
  assert.equal(f.calls.length, 4, 'Back navigation restores snapshots without new queries.');
  await f.controller.connections('anchor');
  await f.controller.connections('attention', { resetHistory:true });
  assert.equal(f.controller.getState().canGoBack, false, 'An outside detail entry starts a new exploration path.');
});

test('connection evidence retains each side’s exact saved version and passage offset', () => {
  const graph = connectionFixture();
  const html = renderKnowledgeContent({ view:'connections', status:'ready', ...graph });
  for (const value of ['<svg', '关联依据与双方原文', '共同主题 · 注意力', '相关主题 · 咖啡', '内容相近', '起点第 7 段', '关联第 9 段', '起点文章的对应注意力证据', '关联文章说明通知如何影响注意力', '对照原文', '查看关联']) assert.ok(html.includes(value), value);
  assert.match(html, /data-knowledge-id="anchor" data-knowledge-offset="2400" data-knowledge-version="version-anchor"/);
  assert.match(html, /data-knowledge-id="attention" data-knowledge-offset="4800" data-knowledge-version="version-attention"/);
  assert.doesNotMatch(html, /观点一致|互相支持|因果关系|向量|数据库/);
});

test('connection data is escaped in SVG titles, accessible names, filters and evidence', () => {
  const unsafe = '\"><img src=x onerror=alert(1)><script>alert(1)</script>';
  const graph = connectionFixture();
  graph.anchor.title = unsafe;
  graph.items[0] = { ...graph.items[0], collectionId:unsafe, title:unsafe, documentVersionId:unsafe,
    concepts:[{ id:unsafe, name:unsafe }], matchReasons:[unsafe], anchorChunks:[{ text:unsafe, locator:unsafe }], chunks:[{ text:unsafe, locator:unsafe }] };
  const html = renderKnowledgeContent({ view:'connections', status:'ready', ...graph });
  assert.doesNotMatch(html, /<(?:img|script)\b|onerror="alert/);
  assert.match(html, /&lt;img/);
  assert.match(html, /aria-label="关联依据与双方原文"/);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-pressed="false"/);
});

test('connection failures can be retried or navigated back without losing the previous result', async () => {
  let attempts = 0;
  const f = fixture(async route => {
    if (route.endsWith('/search')) return { items:[{ collectionId:'anchor' }] };
    if (attempts++ === 0) throw new Error('temporary failure');
    return connectionFixture();
  });
  await f.controller.search('注意力');
  await f.controller.connections('anchor');
  const error = renderKnowledgeContent(f.controller.getState());
  assert.match(error, /重新尝试/);
  assert.match(error, /返回搜索结果/);
  await f.controller.retry();
  assert.equal(f.controller.getState().status, 'ready');
  f.controller.back();
  assert.equal(f.controller.getState().view, 'search');
  assert.equal(f.calls.length, 3);
  const empty = renderKnowledgeContent({ view:'connections', status:'ready', anchor:{ title:'尚待探索' }, items:[] });
  assert.match(empty, /暂未找到关联收藏/);
  assert.doesNotMatch(empty, /<svg|没有关联|没有收藏/);
});

test('full-text search has a brief basis label without exposing internal index states', () => {
  for (const semanticStatus of ['loading', 'indexing', 'pending', 'ready', 'unconfigured', 'unavailable', undefined]) {
    const html = renderKnowledgeContent({ view:'search', status:'ready', mode:'full_text', semanticStatus, items:[] });
    assert.match(html, /按关键词搜索/);
    assert.doesNotMatch(html, /语义索引|重排|准备中|数据库/);
  }
});

test('the reader preserves continuous source text while technical locators remain internal', () => {
  const body = '第一段讨论向量数据库。\n\n第二段保留作者自己的措辞。';
  const html = renderKnowledgeContent({ view:'read', status:'ready', document:{ title:'原文', text:body,
    chunks:[{ text:body, locator:'保存的原文 · 原文字符 1–28' }] } });
  assert.ok(html.includes(body));
  assert.doesNotMatch(html, /原文字符|保存的原文 ·/);
  const pair = renderKnowledgeContent({ view:'similar', status:'ready', anchor:{ collectionId:'a', title:'起点', chunks:[{ text:'全局起点不是实际配对片段' }] },
    items:[{ collectionId:'b', title:'图片', sourceKind:'image_description', chunks:[{ text:'图中的真实描述', locator:'原文字符 300–400', start:299 }], anchorChunks:[{ text:'实际配对起点片段', locator:'第 2 节' }] }] });
  assert.match(pair, /图片的 AI 描述/);
  assert.match(pair, /实际配对起点片段/);
  assert.doesNotMatch(pair, /全局起点不是实际配对片段|原文字符/);
  assert.match(pair, /data-knowledge-offset="299"/);
});
