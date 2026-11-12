import test from 'node:test';
import assert from 'node:assert/strict';
import { curationStoryKey, renderCurationStory, mountCurationStory } from '../site/curator/curation-story.js';
import { renderModelReading } from '../site/curator/curation-reading.js';
import { TOPIC_PRESET_MODES } from '../site/curator/curation-mode-definitions.js';
import { renderWorkspace } from '../site/prototype/immersive-exhibition/light-workspace.js';
import { createWorkspaceChatLauncher } from '../site/curator/workspace-chat-launch.js';
import { curationColor, CURATION_COLORS } from '../site/curator/curation-theme.js';
import { pickCollectionCardColor } from '../site/curator/collection-card-color.js';

// Synthetic source passages exercise citation validation; no model or personal library is contacted.
const collection = (id = 'collection-one', patch = {}) => ({ id, title:`收藏 ${id}`, summary:'保存的理解', source:'测试来源', thumbnail:'', sourceRevision:1, ...patch });
const exhibition = (patch = {}) => ({ id:'curation-one', title:'观察与理解：从材料开始', createdAt:'2026-11-10T12:00:00Z', collectionIds:['collection-one'], sourceCollectionIds:['collection-one'], rooms:[{ title:'如何观察', introduction:'这是已保存的章节介绍。', exhibit_ids:['collection-one'], claims:[] }], items:[], curatorial_note:{ text:'这是已保存的策展说明。' }, open_question:'观察之后，还需要哪些证据？', ...patch });
const article = (id = 'collection-one', patch = {}) => ({ collectionId:id, title:`原文 ${id}`, url:'https://example.org/source', documentVersionId:`version-${id}`, contentHash:`hash-${id}`, sourceRevision:1, sourceKind:'body_text', coverage:'complete', complete:true, paragraphs:[{ id:'p1', text:'原文写道：“观察需要结合证据。”这是一段来源文字。', start:0, end:29 }], quotes:[{ text:'“观察需要结合证据。”', evidenceIds:['p1'] }], results:[], ...patch });
const readingResult = (source, patch = {}) => ({ id:'result-one', mode:'overview', prompt:'', documentVersionId:source.documentVersionId, contentHash:source.contentHash, paragraphs:[{ text:'根据来源整理的辅助阅读。', evidenceIds:['p1'] }], quotes:[], questions:[{ question:'为什么要结合证据？', answer:'原文说观察需要结合证据。', evidenceIds:['p1'] }], ...patch });

function hostFixture({ model = false } = {}) {
  const nodes = new Map();
  for (const selector of ['[data-curation-feedback]', '[data-curation-excerpts]', '[data-curation-questions]']) nodes.set(selector, { innerHTML:'', textContent:'' });
  if (model) {
    for (const name of ['panel','result','generate','actions','status','heading','description','disclosure','form']) {
      nodes.set(`[data-curation-model-${name}]`, { innerHTML:'', textContent:'', setAttribute() {}, removeAttribute() {} });
    }
    nodes.set('[data-curation-action="reload-model-reading"]', {});
    nodes.set('[data-curation-action="default-mode"]', { textContent:'', setAttribute() {}, removeAttribute() {} });
  }
  const drawers = [];
  nodes.set('[data-curation-drawer-mount]', { append(element) { drawers.push(element); } });
  const listeners = new Map();
  const doc = {
    activeElement:null,
    createElement() {
      const panel = { focus() { doc.activeElement = this; } };
      return { className:'', innerHTML:'', querySelector:() => panel, querySelectorAll:() => [], remove() { this.removed = true; } };
    },
  };
  const originalFocus = { focusCount:0, focus() { this.focusCount++; doc.activeElement = this; } };
  doc.activeElement = originalFocus;
  const root = { ownerDocument:doc, isConnected:true, dataset:{ curationMode:'overview' }, matches:selector => selector === '.folio-curation-story', querySelector:selector => nodes.get(selector), querySelectorAll:() => [], contains:() => true, addEventListener:(name, callback) => listeners.set(name, callback), removeEventListener:(name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); } };
  const fire = (name, target) => listeners.get(name)?.({ target, preventDefault() {}, stopPropagation() {} });
  const click = async (action, data = {}, control = {}) => {
    control.dataset = { curationAction:action, ...data };
    await fire('click', { closest:() => control });
  };
  return { root, nodes, drawers, click, fire, originalFocus };
}

test('automatic topic citations check the saved version and exact span before opening the local original', async () => {
  const host = hostFixture();
  const quote = '测量显示偏移为三厘米。';
  const paragraph = `第二次观测时，${quote}后续仍在观测。`;
  const start = 70 + paragraph.indexOf(quote);
  const sourceId = 'document-one';
  const documentVersionId = 'original-v1';
  const sources = [{ id:sourceId, title:'观测报告', publisher:'观测站', documentVersionId }];
  const evidence = [{ id:'measurement', sourceId, documentVersionId, quote, start, end:start + quote.length }];
  const keyPoint = { title:'第二次观测', text:quote, evidenceIds:['measurement'] };
  const topic = exhibition({ kind:'local-topic', title:'同一次观测', collectionIds:[sourceId], rooms:[],
    curationReading:{ sources, evidence, overview:[keyPoint, { text:'未获支持的要点', evidenceIds:['missing'] }],
      comparison:[{ title:'观测数据', entries:[keyPoint] }], timeline:[{ ...keyPoint, date:'2025-01-03' }], deepDive:[keyPoint] },
  });
  const html = renderCurationStory(topic, []);
  assert.match(html, /folio-story-local-topic/u);
  assert.match(html, /data-curation-evidence="measurement"/u);
  assert.doesNotMatch(html, /公开阅读样例|未获支持的要点/u);
  for (const mode of ['overview', 'compare', 'full']) assert.match(html, new RegExp(`id="folio-story-panel-${mode}"`));

  const calls = [];
  const opened = [];
  let reportedVersion = documentVersionId;
  let reportedParagraph = paragraph;
  const instance = mountCurationStory({ container:host.root, exhibition:topic,
    api:async (route, body) => {
      calls.push({ route, body });
      const split = paragraph.indexOf(quote) + 5;
      return { article:{ title:'原始观测记录', collectionId:sourceId, documentVersionId:reportedVersion,
        paragraphs:[{ id:'p2', text:reportedParagraph.slice(0, split), start:70, end:70 + split },
          { id:'p3', text:reportedParagraph.slice(split), start:70 + split, end:70 + paragraph.length }] } };
    },
    openOriginal:(...args) => opened.push(args),
  });
  await host.click('evidence', { curationEvidence:'measurement' });
  assert.deepEqual(calls, [{ route:'reading/article', body:{ collectionId:sourceId, documentVersionId } }]);
  assert.match(host.drawers.at(-1).innerHTML, /测量显示偏移为三厘米/u);
  await host.click('open-local-evidence');
  assert.deepEqual(opened, [[sourceId, { documentVersionId, offset:start }]]);

  await host.click('close-drawer');
  reportedVersion = 'different-version';
  await host.click('evidence', { curationEvidence:'measurement' });
  reportedVersion = documentVersionId;
  reportedParagraph = paragraph.replace('三', '五');
  await host.click('evidence', { curationEvidence:'measurement' });
  assert.equal(host.drawers.length, 1);
  assert.match(host.nodes.get('[data-curation-feedback]').textContent, /无法定位到原文/u);
  instance.destroy();
});

test('the local topic menu selects, restores and saves a preset when generation is unavailable', async () => {
  const topic = exhibition({ kind:'local-topic', curationReading:{ sources:[], evidence:[], overview:[], comparison:[], timeline:[], deepDive:[] } });
  const html = renderCurationStory(topic, []);
  assert.match(html, /class="folio-curation-story folio-story-personal folio-story-local-topic"/u);
  assert.match(html, /class="dropdown-menu folio-story-model-picker"/u);
  assert.match(html, /aria-haspopup="menu" aria-controls="folio-story-mode-menu" aria-expanded="false"/u);
  assert.doesNotMatch(html, /<select/u);
  const options = [...html.matchAll(/role="menuitemradio"[^>]*data-curation-mode="([^"]+)">([^<]+)</gu)].map(([, id, label]) => [id, label]);
  assert.deepEqual(options, Object.entries(TOPIC_PRESET_MODES).map(([id, { label }]) => [id, label]));

  const host = hostFixture({ model:true });
  const label = { textContent:'' };
  const choices = options.map(([mode]) => ({ dataset:{ curationMode:mode }, setAttribute(name, value) { this[name] = value; } }));
  host.nodes.set('[data-curation-model-menu]', {
    querySelector:() => label, querySelectorAll:() => choices, addEventListener() {}, removeEventListener() {},
  });
  const defaultButton = host.nodes.get('[data-curation-action="default-mode"]');
  const requests = [];
  const instance = mountCurationStory({ container:host.root, exhibition:topic, api:async (route, body) => {
    requests.push([route, body]);
    return route === 'reading/preferences' ? { preferences:{ curationMode:'concepts' } } : { available:false, result:null };
  } });
  await new Promise(setImmediate);
  assert.equal(label.textContent, '先解释概念');
  assert.deepEqual(choices.filter(option => option['aria-checked'] === 'true').map(option => option.dataset.curationMode), ['concepts']);
  assert.equal(defaultButton.textContent, '已设为默认');
  assert.match(host.nodes.get('[data-curation-model-status]').textContent, /无法生成/u);

  await host.click('mode', { curationMode:'english' });
  assert.equal(label.textContent, '英文概要');
  assert.deepEqual(choices.filter(option => option['aria-checked'] === 'true').map(option => option.dataset.curationMode), ['english']);
  await host.click('default-mode', {}, defaultButton);
  assert.equal(defaultButton.textContent, '已设为默认');
  await host.click('mode', { curationMode:'overview' });
  assert.equal(label.textContent, '更多读法');
  assert.ok(choices.every(option => option['aria-checked'] === 'false'));
  assert.deepEqual(requests, [['reading/preferences', {}], ['curation/reading', { exhibitionId:topic.id, mode:'concepts' }],
    ['curation/reading', { exhibitionId:topic.id, mode:'english' }], ['reading/preferences', { curationMode:'english' }]]);
  instance.destroy();
});

test('selecting an uncached preset generates automatically and keeps exact local citations', async () => {
  const saved = exhibition();
  const html = renderCurationStory(saved, [collection()]);
  assert.match(html, /class="folio-curation-story folio-story-personal"/u);
  assert.match(html, /class="dropdown-menu folio-story-model-picker"/u);
  const options = [...html.matchAll(/role="menuitemradio"[^>]*data-curation-mode="([^"]+)">([^<]+)</gu)].map(([, id, label]) => [id, label]);
  assert.deepEqual(options, [
    ['plain', '通俗解读'], ['five-ws', '5W 概要'], ['perspectives', '不同观点'],
    ['concepts', '先解释概念'], ['chinese', '中文概要'], ['english', '英文概要'],
  ]);
  assert.doesNotMatch(html, /自定义读法|和 Tag 讨论读法|data-curation-model-prompt|data-curation-action="custom"/u);
  const host = hostFixture({ model:true });
  const source = article();
  const quote = '观察需要结合证据';
  const start = source.paragraphs[0].text.indexOf(quote);
  const output = host.nodes.get('[data-curation-model-result]');
  const generate = host.nodes.get('[data-curation-model-generate]');
  const requests = [], opened = [];
  const result = {
    title:'Observation',
    entries:TOPIC_PRESET_MODES.english.slots.map(({ id, label }, index) => index
      ? { slot:id, label, text:'Model supplied placeholder.', status:'missing', evidenceIds:[] }
      : { slot:id, label, text:'<script>Observation</script>', evidenceIds:['exact'] }),
    evidence:[{ id:'exact', sourceId:source.collectionId, documentVersionId:source.documentVersionId, quote, start, end:start + quote.length }],
    sources:[{ id:source.collectionId, title:source.title, publisher:'测试来源', documentVersionId:source.documentVersionId }],
  };
  const instance = mountCurationStory({ container:host.root, exhibition:saved, collections:[collection()],
    api:async (route, body) => {
      if (route === 'reading/article') return { article:source };
      if (route === 'reading/preferences') return { preferences:{ curationMode:'overview' } };
      requests.push(body);
      return { available:true, result:body.generate ? result : null };
    },
    openOriginal:(...args) => opened.push(args),
  });
  await host.click('mode', { curationMode:'english' });
  await new Promise(setImmediate);
  assert.deepEqual(requests, [
    { exhibitionId:saved.id, mode:'english' },
    { exhibitionId:saved.id, mode:'english', generate:true },
  ]);
  assert.equal(generate.hidden, true);
  assert.match(output.innerHTML, /<h3 lang="en">Key takeaway<\/h3>/u);
  assert.match(output.innerHTML, /<p lang="en">&lt;script&gt;Observation&lt;\/script&gt;<\/p>/u);
  assert.match(output.innerHTML, /Not specified in the provided sources\./u);
  assert.doesNotMatch(output.innerHTML, /Model supplied placeholder|<script>/u);
  await host.click('evidence', { curationEvidence:'exact' }, { closest:() => output });
  assert.match(host.drawers.at(-1).innerHTML, /观察需要结合证据/u);
  await host.click('open-local-evidence');
  assert.deepEqual(opened, [[source.collectionId, { documentVersionId:source.documentVersionId, offset:start }]]);
  instance.destroy();
});

test('a retired custom default falls back to overview without fetching the old result or writing preferences', async () => {
  const host = hostFixture({ model:true });
  const saved = exhibition();
  const requests = [];
  const instance = mountCurationStory({ container:host.root, exhibition:saved, initialMode:'custom',
    api:async (route, body) => {
      requests.push({ route, body });
      if (route === 'reading/preferences') return { preferences:{ curationMode:'custom', customPrompt:'按证据强弱整理' } };
      return { available:false };
    },
  });
  await new Promise(setImmediate);
  assert.equal(host.root.dataset.curationMode, 'overview');
  assert.equal(host.nodes.get('[data-curation-model-panel]').hidden, true);
  await host.click('mode', { curationMode:'custom' });
  await host.fire('submit', host.nodes.get('[data-curation-model-form]'));
  assert.deepEqual(requests, [{ route:'reading/preferences', body:{} }]);
  instance.destroy();
});

test('background collections do not invalidate the open story snapshot, while its sources and note do', () => {
  const saved = exhibition();
  const member = collection();
  const unrelated = collection('background-collection');
  const key = curationStoryKey(saved, [member, unrelated]);
  assert.equal(curationStoryKey(structuredClone(saved), [member, { ...unrelated, status:'processing' }]), key);
  assert.notEqual(curationStoryKey(saved, [{ ...member, knowledgeDocumentVersionId:'new-source' }, unrelated]), key);
  assert.notEqual(curationStoryKey({ ...saved, note:'写给自己的手记' }, [member, unrelated]), key);
});

test('a remounted reading keeps its validated text visible through the passive version check', async () => {
  const saved = exhibition();
  const item = collection('collection-one', { knowledgeDocumentVersionId:'version-one' });
  const quote = '已经核对的出处。';
  const result = {
    title:'Observation',
    entries:TOPIC_PRESET_MODES.english.slots.map(({ id, label }, index) => index
      ? { slot:id, label, status:'missing', evidenceIds:[] } : { slot:id, label, text:'Keep the saved reading visible.', evidenceIds:['exact'] }),
    evidence:[{ id:'exact', sourceId:item.id, documentVersionId:item.knowledgeDocumentVersionId, quote, start:0, end:quote.length }],
    sources:[{ id:item.id, title:item.title, documentVersionId:item.knowledgeDocumentVersionId }],
  };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const requests = [];
  const api = async (route, body) => {
    if (route === 'reading/preferences') return { preferences:{} };
    if (route === 'reading/article') return { article:article() };
    requests.push(body);
    return requests.length === 1 ? { available:true, result } : pending;
  };
  const original = hostFixture({ model:true });
  const first = mountCurationStory({ container:original.root, exhibition:saved, collections:[item], initialMode:'english', api });
  await new Promise(setImmediate);
  assert.match(original.nodes.get('[data-curation-model-result]').innerHTML, /Keep the saved reading visible/u);
  first.destroy();

  const reopened = hostFixture({ model:true });
  const output = reopened.nodes.get('[data-curation-model-result]');
  let html = '', writes = 0;
  Object.defineProperty(output, 'innerHTML', { get:() => html, set(value) { html = value; writes++; } });
  const second = mountCurationStory({ container:reopened.root, exhibition:saved, collections:[item], initialMode:'english', api });
  assert.match(output.innerHTML, /Keep the saved reading visible/u);
  assert.equal(reopened.nodes.get('[data-curation-model-status]').textContent, '');
  assert.equal(writes, 1);

  const changed = hostFixture({ model:true });
  const third = mountCurationStory({ container:changed.root, exhibition:saved, collections:[{ ...item, knowledgeDocumentVersionId:'version-two' }], initialMode:'english', api });
  assert.equal(changed.nodes.get('[data-curation-model-result]').innerHTML, '');
  third.destroy();
  release({ available:true, result:structuredClone(result) });
  await new Promise(setImmediate);
  assert.equal(writes, 1, 'An identical recheck preserves the live reading controls');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(body => !body.generate));
  second.destroy();
});

test('fixed reading sections keep their place when evidence is missing and reject malformed results', () => {
  const quote = '观测数据。';
  const documentVersionId = 'version-1';
  for (const [mode, { slots }] of Object.entries(TOPIC_PRESET_MODES)) {
    const result = {
      title:'同一个展览', truncated:true,
      entries:slots.map(({ id, label }, index) => index
        ? { slot:id, label, status:'missing', evidenceIds:[] }
        : { slot:id, label, text:'根据原文整理的内容。', evidenceIds:['e1'] }).reverse(),
      evidence:[{ id:'e1', sourceId:'collection-one', documentVersionId, quote, start:0, end:quote.length }],
      sources:[{ id:'collection-one', title:'原文', documentVersionId }],
    };
    const html = renderModelReading(result, mode);
    assert.deepEqual([...html.matchAll(/data-curation-model-slot="([^"]+)"/gu)].map(match => match[1]), slots.map(slot => slot.id), mode);
    assert.equal([...html.matchAll(/class="folio-story-model-missing"/gu)].length, slots.length - 1, mode);
    assert.match(html, /data-curation-evidence="e1"/u, mode);
    assert.equal(renderModelReading({ ...result, evidence:[] }, mode), '', mode);
    assert.equal(renderModelReading({ ...result, entries:result.entries.slice(1) }, mode), '', mode);
  }
});

test('opening a saved preset generates automatically, remounts join it and a failure can be retried', async () => {
  const host = hostFixture({ model:true });
  const saved = exhibition();
  const requests = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const api = async (route, body) => {
    if (route === 'reading/preferences') return { preferences:{ curationMode:'five-ws' } };
    requests.push(body);
    return body.generate ? pending : { available:true, result:null };
  };
  mountCurationStory({ container:host.root, exhibition:saved, api });
  await new Promise(setImmediate);
  assert.deepEqual(requests, [
    { exhibitionId:saved.id, mode:'five-ws' },
    { exhibitionId:saved.id, mode:'five-ws', generate:true },
  ]);
  assert.equal(host.root.dataset.curationMode, 'five-ws');
  const remounted = mountCurationStory({ container:host.root, exhibition:saved, initialMode:'five-ws', api });
  const generate = host.nodes.get('[data-curation-model-generate]');
  assert.equal(generate.disabled, true);
  assert.equal(requests.length, 2);
  finish({ available:true, result:null });
  await new Promise(setImmediate);
  assert.equal(generate.disabled, false);
  assert.equal(generate.hidden, false);
  assert.equal(generate.textContent, '重新生成');
  assert.equal(requests.length, 2, 'A failed generation waits for an explicit retry');
  await host.fire('submit', host.nodes.get('[data-curation-model-form]'));
  assert.deepEqual(requests.slice(2), [
    { exhibitionId:saved.id, mode:'five-ws' },
    { exhibitionId:saved.id, mode:'five-ws', generate:true },
  ]);
  remounted.destroy();
});

test('a late cache miss for a previous preset cannot start generation', async () => {
  const host = hostFixture({ model:true });
  const saved = exhibition();
  const requests = [];
  let resolveFirstRead;
  const firstRead = new Promise(resolve => { resolveFirstRead = resolve; });
  const instance = mountCurationStory({ container:host.root, exhibition:saved, api:async (route, body) => {
    if (route === 'reading/preferences') return { preferences:{ curationMode:'overview' } };
    requests.push(body);
    return body.mode === 'plain' ? firstRead : { available:false, result:null };
  } });
  await host.click('mode', { curationMode:'plain' });
  await host.click('mode', { curationMode:'english' });
  resolveFirstRead({ available:true, result:null });
  await new Promise(setImmediate);
  assert.equal(host.root.dataset.curationMode, 'english');
  assert.deepEqual(requests, [
    { exhibitionId:saved.id, mode:'plain' },
    { exhibitionId:saved.id, mode:'english' },
  ]);
  instance.destroy();
});

test('the primary overview still waits for explicit generation', async () => {
  const host = hostFixture({ model:true });
  const saved = exhibition({ kind:'local-topic', curationReading:{ sources:[], evidence:[] } });
  const slot = { append() {} };
  host.nodes.set('[data-curation-panel="overview"]', {
    querySelector:selector => selector === '[data-curation-editorial-slot]' ? slot : null,
  });
  const requests = [];
  const instance = mountCurationStory({ container:host.root, exhibition:saved, api:async (route, body) => {
    if (route === 'reading/preferences') return { preferences:{ curationMode:'overview' } };
    requests.push(body);
    return { available:true, result:null };
  } });
  await new Promise(setImmediate);
  assert.deepEqual(requests, [{ exhibitionId:saved.id, mode:'overview' }]);
  assert.equal(host.nodes.get('[data-curation-model-generate]').disabled, false);
  await host.fire('submit', host.nodes.get('[data-curation-model-form]'));
  assert.deepEqual(requests.at(-1), { exhibitionId:saved.id, mode:'overview', generate:true });
  instance.destroy();
});

test('curation renders stored exhibition content and counts unique available sources instead of unresolved IDs', () => {
  const saved = exhibition({ collectionIds:['collection-one', 'collection-one', 'missing'], sourceCollectionIds:['collection-one', 'missing'], items:[{ id:'snapshot-only', title:'真实保存的快照' }], rooms:[{ title:'章节', introduction:'保留的介绍', exhibit_ids:['collection-one', 'snapshot-only', 'missing'], claims:[{ text:'策展人保存的假设', statement_type:'hypothesis', evidence_ids:['known-evidence'] }] }] });
  const html = renderCurationStory(saved, [collection('collection-one', { extraction:{ evidenceBundle:[{ evidence_id:'known-evidence' }] } })]);
  assert.match(html, /2 条相关收藏/);
  assert.doesNotMatch(html, /3 条相关收藏|4 条相关收藏|NASA|Particle/);
  for (const expected of ['真实保存的快照', '保留的介绍', '策展人保存的假设', '策展假设', 'data-desktop="collection" data-id="collection-one"']) assert.ok(html.includes(expected), expected);
  assert.equal((html.match(/data-desktop-exhibition-note/g) || []).length, 1);
});

test('empty and no-image exhibitions display honest content states without invented collage images', () => {
  const html = renderCurationStory(exhibition({ collectionIds:['missing'], sourceCollectionIds:['missing'], rooms:[], curatorial_note:null, open_question:'' }), []);
  assert.match(html, /0 条相关收藏/);
  assert.match(html, /is-without-media/);
  assert.match(html, /还没有保存策展说明/);
  assert.match(html, /暂时没有可用的收藏来源/);
  assert.doesNotMatch(html, /class="folio-story-collage"|class="folio-story-photo|<img\b/);
});

test('single-image collage offers the actual image and drawer action without duplicating source images', () => {
  const html = renderCurationStory(exhibition(), [collection('collection-one', { thumbnail:'/assets/one.jpg' })]);
  assert.equal((html.match(/class="folio-story-photo /g) || []).length, 1);
  assert.match(html, /data-curation-action="media" data-curation-item="collection-one"/);
  assert.match(html, /查看全部图片/);
  assert.doesNotMatch(html, /photo-2/);
});

test('overview chapter links retain original room positions when earlier rooms are empty', () => {
  const html = renderCurationStory(exhibition({ rooms:[{ title:'空章节', exhibit_ids:[], claims:[] }, { title:'有内容的章节', introduction:'真实保存的正文', exhibit_ids:[], claims:[] }] }));
  assert.match(html, /data-curation-action="room" data-curation-room="1">有内容的章节/);
  assert.match(html, /data-curation-room-panel="1"/);
});

test('long and hostile titles remain complete readable text; saved strings never become active markup', () => {
  const title = '一个很长的策展标题'.repeat(45) + '\"><img src=x onerror=alert(1)>';
  const html = renderCurationStory(exhibition({ title, curatorial_note:{ text:'</p><script>alert(1)</script>' }, note:'</textarea><script>alert(2)</script>', rooms:[{ title:'<svg onload=alert(3)>', introduction:'<img src=x onerror=alert(4)>', claims:[] }] }), [collection('collection-one', { title:'<iframe src=x>', summary:'<b>原样文字</b>' })]);
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)[1].replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.equal(heading, title);
  assert.doesNotMatch(html, /<(?:img|script|iframe)\b|<svg\s+onload/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;\/textarea&gt;/);
});

test('unsafe source images cannot become remote executable or file URLs', () => {
  for (const thumbnail of ['javascript:alert(1)', 'file:///private/secret.png', 'data:image/svg+xml,<svg onload=alert(1)>', '//tracking.example/image.png']) {
    const html = renderCurationStory(exhibition(), [collection('collection-one', { thumbnail })]);
    assert.doesNotMatch(html, /<img\b/);
    assert.match(html, /is-without-media/);
  }
  for (const thumbnail of ['/assets/source.jpg', 'https://example.org/source.jpg', 'data:image/png;base64,aGVsbG8=']) {
    assert.match(renderCurationStory(exhibition(), [collection('collection-one', { thumbnail })]), /<img\b/);
  }
});

test('saved quotes and questions use validated source versions and preserve exact source identity in notes', async () => {
  const host = hostFixture(), source = article();
  source.results = [readingResult(source, { quotes:[{ text:'原文没有说过的话', evidenceIds:['p1'] }] }), readingResult(source, { id:'old', documentVersionId:'other-version', questions:[{ question:'旧版问题不可显示', answer:'旧版回答', evidenceIds:['p1'] }] })];
  const notes = [], calls = [];
  const instance = mountCurationStory({ container:host.root, exhibition:exhibition(), collections:[collection()], api:async (route, body) => { calls.push({ route, body }); return { article:source }; }, onCreateNote:note => notes.push(note) });
  await instance.refreshSources();
  const quotes = host.nodes.get('[data-curation-excerpts]').innerHTML;
  const questions = host.nodes.get('[data-curation-questions]').innerHTML;
  assert.match(quotes, /“观察需要结合证据。”/);
  assert.doesNotMatch(quotes, /原文没有说过的话/);
  assert.match(questions, /为什么要结合证据/);
  assert.doesNotMatch(questions, /旧版问题不可显示/);
  await host.click('note', { curationKind:'quote', curationIndex:'0' });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].collectionId, source.collectionId);
  assert.equal(notes[0].documentVersionId, source.documentVersionId);
  assert.equal(notes[0].source.contentHash, source.contentHash);
  assert.deepEqual(notes[0].source.paragraphs[0], source.paragraphs[0]);
  assert.equal(notes[0].exhibitionId, 'curation-one');
  assert.ok(calls.every(call => call.route === 'reading/article'), 'Opening a curation reads saved output without a generation request');
  instance.destroy();
});

test('source context drawers exclude unsafe source links while preserving literal evidence', async () => {
  const host = hostFixture();
  const instance = mountCurationStory({ container:host.root, exhibition:exhibition(), collections:[collection()], api:async () => ({ article:article('collection-one', { url:'javascript:alert(1)' }) }) });
  await instance.refreshSources();
  await host.click('source', { curationKind:'quote', curationIndex:'0' });
  const drawer = host.drawers.at(-1).innerHTML;
  assert.match(drawer, /原文写道/);
  assert.match(drawer, /段落 p1/);
  assert.doesNotMatch(drawer, /href="javascript:|访问原始来源/);
  await host.click('quotes');
  assert.doesNotMatch(host.drawers.at(-1).innerHTML, /localhost|href="javascript:/);
  instance.destroy();
});

test('drawer navigation preserves the original trigger focus and no-media state remains explicit', async () => {
  const host = hostFixture();
  const instance = mountCurationStory({ container:host.root, exhibition:exhibition(), collections:[collection()], api:async () => ({ article:article() }) });
  await instance.refreshSources();
  host.root.ownerDocument.activeElement = null;
  await host.click('collections', {}, host.originalFocus);
  await host.click('media');
  assert.match(host.drawers.at(-1).innerHTML, /暂时没有保存图片/);
  await host.click('quotes');
  await host.click('close-drawer');
  assert.equal(host.originalFocus.focusCount, 1);
  assert.equal(host.root.ownerDocument.activeElement, host.originalFocus);
  instance.destroy();
});

test('a title keyword with no matching collection clearly labels the all-sources fallback', async () => {
  const host = hostFixture();
  const instance = mountCurationStory({ container:host.root, exhibition:exhibition(), collections:[collection()], api:async () => ({ article:article() }) });
  await instance.refreshSources();
  await host.click('theme', { curationTheme:'尚未出现在收藏里的词' });
  const html = host.drawers.at(-1).innerHTML;
  assert.match(html, /暂未匹配到/);
  assert.match(html, /本展全部收藏/);
  assert.match(html, /data-desktop="collection" data-id="collection-one"/);
  instance.destroy();
});

test('media drawer image clicks retain the selected item and use the connected collection reader', async () => {
  const host = hostFixture(), opened = [];
  const instance = mountCurationStory({ container:host.root, exhibition:exhibition(), collections:[collection('collection-one', { thumbnail:'/assets/one.jpg' })], api:async () => ({ article:article() }), openCollection:id => opened.push(id) });
  await instance.refreshSources();
  await host.click('media', { curationItem:'collection-one' });
  assert.match(host.drawers.at(-1).innerHTML, /data-curation-media-id="collection-one"/);
  assert.match(host.drawers.at(-1).innerHTML, /src="\/assets\/one.jpg"/);
  await host.click('open-collection', { curationItem:'collection-one' });
  assert.deepEqual(opened, ['collection-one']);
  assert.equal(host.drawers.at(-1).removed, true);
  instance.destroy();
});

test('Tag launch carries the real exhibition scope and an editable exhibition question without submitting it', async () => {
  const host = hostFixture(), calls = [], navigations = [], stored = new Map();
  const liveState = { collections:[collection()], exhibitions:[exhibition()], conversations:[] };
  const launcher = createWorkspaceChatLauncher({ api:async (route, body) => { calls.push({ route, body }); if (route === 'state') return liveState; if (route === 'conversations') return { conversation:{ id:'scope-conversation' } }; return {}; }, navigate:async url => navigations.push(url), storage:{ setItem:(key, value) => stored.set(key, value) } });
  const instance = mountCurationStory({ container:host.root, exhibition:exhibition(), collections:[collection()], api:async () => ({ article:article() }), openChat:launcher });
  await instance.refreshSources();
  await host.click('ask-open');
  assert.equal(navigations.length, 1);
  assert.ok(navigations[0].includes('conversation=scope-conversation'));
  assert.equal(calls.filter(call => call.route === 'messages').length, 0);
  assert.deepEqual(JSON.parse(stored.get('forme.workspace-chat.scope:scope-conversation')), { collectionIds:[], exhibitionId:'curation-one' });
  assert.equal(stored.get('forme.workspace-chat.draft:scope-conversation'), liveState.exhibitions[0].open_question);
  instance.destroy();
});

test('failed Tag launch reports a retryable outcome instead of rejecting an event handler', async () => {
  const host = hostFixture();
  const instance = mountCurationStory({ container:host.root, exhibition:exhibition(), collections:[collection()], api:async () => ({ article:article() }), openChat:async () => { throw new Error('offline'); } });
  await instance.refreshSources();
  await assert.doesNotReject(host.click('ask'));
  assert.match(host.nodes.get('[data-curation-feedback]').textContent, /重试|没有打开|暂时/);
  instance.destroy();
});

test('cached source data is isolated by API identity and stale loads cannot repaint a destroyed story', async () => {
  const a = hostFixture(), b = hostFixture();
  const first = mountCurationStory({ container:a.root, exhibition:exhibition(), collections:[collection()], api:async () => ({ article:article() }) });
  await first.refreshSources();
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const second = mountCurationStory({ container:b.root, exhibition:exhibition(), collections:[collection()], api:async () => pending });
  assert.equal(b.nodes.get('[data-curation-excerpts]').innerHTML, '', 'The same IDs in a different API session must not inherit cached source text');
  second.destroy();
  resolve({ article:article('collection-one', { paragraphs:[{ id:'p1', text:'另一个会话的原文', start:0, end:9 }], quotes:[{ text:'另一个会话', evidenceIds:['p1'] }] }) });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(b.nodes.get('[data-curation-excerpts]').innerHTML, '');
  first.destroy();
});

test('actual gallery cards count unique available sources and omit unsafe cover URLs', () => {
  const state = { ui:{ lightPage:'gallery' }, collections:[collection()], extractions:[], feedback:{}, workspaceJobs:[], exhibitions:[] };
  const galleryItems = [{ id:'curation-one', title:'真实展览', live:true, sourceCollectionIds:['collection-one', 'collection-one', 'missing'], items:[], rooms:[], image:'javascript:alert(1)' }];
  const html = renderWorkspace({ state, galleryItems });
  assert.match(html, /1 件收藏/);
  assert.doesNotMatch(html, /3 件收藏|src="javascript:/);
  assert.match(html, /data-action="live-exhibition" data-exhibition-id="curation-one"/);
});

test('actual exhibition card size follows distinct available content at every size boundary', () => {
  for (const [count, expected] of [[0, 'small'], [1, 'small'], [5, 'small'], [6, 'medium'], [9, 'medium'], [10, 'large'], [24, 'large']]) {
    const collections = Array.from({ length:count }, (_, index) => collection(`source-${index}`));
    const availableIds = collections.map(item => item.id);
    const state = { ui:{ lightPage:'gallery' }, collections, extractions:[], feedback:{}, workspaceJobs:[], exhibitions:[] };
    const galleryItems = [{ id:`curation-${count}`, title:`${count}件实际内容`, live:true, sourceCollectionIds:[...availableIds, ...availableIds, 'not-available'], items:[], rooms:[] }];
    const html = renderWorkspace({ state, galleryItems });
    assert.ok(html.includes(`${count} 件收藏`), `Count ${count}: only available distinct contents contribute`);
    assert.ok(html.includes(`data-story-size="${expected}"`), `Count ${count}: expected ${expected} card`);
  }
});

test('gallery card and detail share each permitted exhibition theme color', () => {
  const state = { ui:{ lightPage:'gallery' }, collections:[collection()], extractions:[], feedback:{}, workspaceJobs:[], exhibitions:[] };
  for (const themeColor of CURATION_COLORS) {
    const saved = exhibition({ themeColor, live:true });
    const card = renderWorkspace({ state, galleryItems:[saved] });
    const detail = renderCurationStory(saved, state.collections);
    assert.equal(curationColor(saved), themeColor);
    assert.ok(card.includes(`--ws-story-color:${themeColor}`));
    assert.ok(detail.includes(`--folio-exhibition-color:${themeColor}`));
  }
  const saved = exhibition();
  assert.ok(renderWorkspace({ state, galleryItems:[{ ...saved, live:true }] }).includes(`--ws-story-color:${curationColor(saved)}`));
  assert.ok(renderCurationStory(saved, state.collections).includes(`--folio-exhibition-color:${curationColor(saved)}`));
});

test('actual collection cards keep their source media and collection action without invented image dimensions', () => {
  const collections = [collection('portrait', { title:'纵向原图', thumbnail:'/assets/portrait.jpg', type:'image', width:600, height:900 }), collection('landscape', { title:'横向原图', thumbnail:'/assets/landscape.jpg', type:'image', width:1200, height:600 }), collection('text', { title:'没有配图的文字', thumbnail:'', type:'text' }), collection('unsafe', { title:'不安全的缩略图', thumbnail:'javascript:alert(1)', type:'image' })];
  const state = { ui:{ lightPage:'inbox' }, collections, extractions:[], feedback:{}, workspaceJobs:[], exhibitions:[] };
  const html = renderWorkspace({ state });
  for (const item of collections) assert.ok(html.includes(`data-collection-id="${item.id}"`), item.id);
  assert.match(html, /src="\/assets\/portrait.jpg"/);
  assert.match(html, /src="\/assets\/landscape.jpg"/);
  assert.match(html, /没有配图的文字/);
  assert.doesNotMatch(html, /style="[^\"]*height:\s*\d+px|https?:\/\/[^\"]*unsplash|src="javascript:/);
});

test('collection cover hues select fixed swatches, including separate sky blue and deep blue', () => {
  const cases = [
    [[205,48,52], '#8b3c46'], [[230,122,42], '#8d4e34'], [[229,187,34], '#78591f'],
    [[55,178,61], '#426338'], [[44,165,133], '#28655d'], [[39,172,224], '#30647b'],
    [[54,77,208], '#394d87'], [[112,105,205], '#654b87'],
  ];
  for (const [rgb, swatch] of cases) assert.equal(pickCollectionCardColor(new Uint8ClampedArray([...rgb,255]), 1), swatch);
});

test('collection cover sampling favors the lower edge and preserves accents in pale diagrams', () => {
  const block = (rgba, size) => Array.from({ length: size }, () => rgba).flat();
  const purple = block([112, 80, 240, 255], 128);
  const gold = block([240, 195, 80, 255], 128);
  assert.equal(pickCollectionCardColor(new Uint8ClampedArray([...purple, ...gold]), 16), '#78591f');
  assert.equal(pickCollectionCardColor(new Uint8ClampedArray([...gold, ...purple]), 16), '#654b87');
  const gray = block([178, 175, 175, 255], 254);
  assert.equal(pickCollectionCardColor(new Uint8ClampedArray([...gray, 255, 0, 0, 255, 0, 0, 255, 10]), 16), '#8b3c46');
  assert.equal(pickCollectionCardColor(new Uint8ClampedArray(gray), 2), '#635441');
  assert.equal(pickCollectionCardColor(new Uint8ClampedArray([240, 20, 80, 10]), 1), null);
});
