import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mountPageTextReader, samePageReadTarget, createPageReadController } from '../site/curator/page-reader.js';

function environment() {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.open = false; this.removed = false; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    set innerHTML(_) { throw new Error('Reader must not interpret page HTML.'); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { this.focused = true; }
    remove() { this.removed = true; this.open = false; }
  }
  const body = new Element('body');
  const doc = { body, createElement: tag => new Element(tag) };
  return { doc, body, reader: mountPageTextReader(doc, doc) };
}

test('page preview keeps untrusted page text literal, identifies the source and closes without changing it', () => {
  const { reader, body } = environment();
  const source = { title: '公开文章 <script>', url: 'https://example.org/article', text: '<script>alert(1)</script>\n\n正常正文。', contentQuality: { status: 'ready' } };
  reader.show(source);
  const dialog = body.children[0];
  assert.equal(dialog.open, true);
  assert.equal(dialog.children.find(node => node.tagName === 'article').textContent, source.text);
  assert.equal(dialog.children.find(node => node.tagName === 'a').href, source.url);
  assert.match(dialog.children.find(node => node.className === 'page-text-summary').textContent, /已清洗正文.*2 段/);
  const close = dialog.children.find(node => node.tagName === 'header').children[1];
  close.listeners.click();
  assert.equal(dialog.open, false);
  assert.equal(source.text, '<script>alert(1)</script>\n\n正常正文。');
});

test('partial and selected text are labelled honestly, unsafe source URLs are not rendered as links', () => {
  const { reader, body } = environment();
  reader.show({ title: '部分', url: 'javascript:alert(1)', text: '一部分正文', contentQuality: { status: 'partial' } });
  const partial = body.children[0];
  assert.match(partial.children.find(node => node.className === 'page-text-summary').textContent, /部分正文/);
  assert.equal(partial.children.some(node => node.tagName === 'a'), false);
  reader.show({ title: '选区', url: 'https://user:secret@example.org/article', selection: '选中的段落。' });
  assert.equal(partial.removed, true);
  const selected = body.children[1];
  assert.match(selected.children.find(node => node.className === 'page-text-summary').textContent, /所选文字/);
  assert.equal(selected.children.some(node => node.tagName === 'a'), false);
  reader.destroy();
  assert.equal(selected.removed, true);
});

test('empty page data does not open a misleading reader', () => {
  const { reader, body } = environment();
  assert.throws(() => reader.show({ text: '   ' }), /没有可查看的正文/);
  assert.equal(body.children.length, 0);
});

test('an unavailable result cannot claim success even if it contains stale text, and a destroyed preview stays closed', () => {
  const { reader, body } = environment();
  assert.throws(() => reader.show({ text: '旧正文', readStatus: 'unavailable' }), /没有可查看的正文/);
  assert.throws(() => reader.show({ text: '旧正文', contentQuality: { status: 'unavailable' } }), /没有可查看的正文/);
  reader.destroy(); reader.show({ text: '晚到的正文' });
  assert.equal(body.children.length, 0);
});

test('an old close button cannot close a replacement preview, and hiding releases the current dialog', () => {
  const { reader, body } = environment();
  reader.show({ text: '第一篇' });
  const oldClose = body.children[0].children.find(node => node.tagName === 'header').children[1];
  reader.show({ text: '第二篇' });
  const current = body.children[1];
  oldClose.listeners.click();
  assert.equal(current.open, true);
  reader.hide();
  assert.equal(current.removed, true);
});

const page = (changes = {}) => ({ attachmentId: 'a', pageRevision: 'revision-a', appName: 'Google Chrome',
  browserWindowId: '12', browserTabId: '23', contextVersion: 10, title: '公开页面 A', url: 'https://example.org/a', ...changes });
function readingEnvironment() {
  let active = page();
  const requests = [], previews = [], evidence = [];
  const reader = createPageReadController({ getContext: () => active,
    fetchPage(context, requestId, signal) {
      return new Promise((resolve, reject) => requests.push({ context, requestId, signal, resolve, reject }));
    }, onRead: context => evidence.push(context), show: context => previews.push(context) });
  function finish(index, changes = {}) {
    const request = requests[index];
    request.resolve({ requestId: request.requestId, readable: true, context: { ...request.context, text: '已清洗正文。\n\n末尾小结。', readStatus: 'public_page', contentQuality: { status: 'ready' } }, ...changes });
  }
  return { reader, requests, previews, evidence, finish, get active() { return active; }, set active(value) { active = value; } };
}

test('passive metadata versions do not reject a same-tuple HTTP snapshot or rewrite active native context', async () => {
  const h = readingEnvironment();
  const original = h.active;
  const reading = h.reader.read(original);
  h.active = { ...original, contextVersion: 13, text: '新的原生片段' };
  h.finish(0);
  const result = await reading;
  assert.equal(h.previews.length, 1);
  assert.equal(result.contextVersion, 10, 'retain the real read snapshot version');
  assert.equal(h.active.contextVersion, 13);
  assert.equal(h.active.text, '新的原生片段');
  assert.equal(result.text.includes('末尾小结'), true);
  assert.equal(samePageReadTarget(result, h.active), true);
  assert.equal(samePageReadTarget(result, { ...h.active, url: h.active.url + '#summary' }), true);
});

test('every identity field is checked even when another window or tab has the same URL', async () => {
  for (const changes of [{ attachmentId: 'b' }, { pageRevision: 'revision-b' }, { browserWindowId: '99' },
    { browserTabId: '99' }, { browserTabId: '' }, { browserProfileId: 'different-profile' }, { appName: 'Safari' }, { url: 'https://example.org/b' }]) {
    const h = readingEnvironment();
    const reading = h.reader.read(h.active);
    h.active = { ...h.active, ...changes };
    h.finish(0);
    await assert.rejects(reading, /页面已经变化/);
    assert.equal(h.previews.length, 0);
    assert.equal(h.evidence.length, 0);
  }
  assert.equal(samePageReadTarget(null, page()), false);
  assert.equal(samePageReadTarget(page({ url: '' }), page({ url: '' })), false);
});

test('read targets preserve SPA hash routes and ignore only ordinary paragraph anchors', () => {
  const source=page({url:'https://example.org/app'});
  assert.equal(samePageReadTarget(source,{...source,url:source.url+'#paragraph'}),true);
  assert.equal(samePageReadTarget({...source,url:source.url+'#/a'},{...source,url:source.url+'#/b'}),false);
  assert.equal(samePageReadTarget({...source,url:source.url+'#!/a'},{...source,url:source.url+'#!/b'}),false);
});

test('a newer request cancels an old page and ignores its late success or failure', async () => {
  for (const fails of [false, true]) {
    const h = readingEnvironment();
    const first = h.reader.read(h.active);
    h.active = page({ pageRevision: 'revision-b', browserTabId: '24', contextVersion: 11, url: 'https://example.org/b' });
    const second = h.reader.read(h.active);
    assert.equal(h.requests[0].signal.aborted, true);
    h.finish(1);
    assert.equal((await second).url, h.active.url);
    if (fails) h.requests[0].reject(new Error('old network failure')); else h.finish(0);
    assert.equal(await first, null);
    assert.equal(h.previews.length, 1);
    assert.equal(h.previews[0].url, 'https://example.org/b');
  }
});

test('duplicate clicks share one pending request; detach, hide or destroy suppress even an unabortable fetch', async () => {
  for (const action of ['invalidate', 'destroy']) {
    const h = readingEnvironment();
    const first = h.reader.read(h.active);
    assert.equal(h.reader.read({ ...h.active, contextVersion: 11 }), first);
    assert.equal(h.requests.length, 1);
    h.reader[action]();
    assert.equal(h.requests[0].signal.aborted, true);
    h.finish(0);
    assert.equal(await first, null);
    assert.equal(h.previews.length, 0);
    if (action === 'destroy') assert.equal(await h.reader.read(h.active), null);
  }
});

test('readable=false, unavailable quality, empty text and mismatched response provenance stay out of the preview', async () => {
  const changes = [
    { readable: false },
    { context: page({ text: '旧文字', readStatus: 'unavailable' }) },
    { context: page({ text: '旧文字', contentQuality: { status: 'unavailable' } }) },
    { context: page({ text: '   ' }) },
    { requestId: 'another-request' },
    { context: page({ text: '正文', contextVersion: 9 }) },
    { context: page({ text: '正文', browserTabId: '99' }) },
  ];
  for (const change of changes) {
    const h = readingEnvironment();
    const reading = h.reader.read(h.active);
    h.finish(0, change);
    await assert.rejects(reading, /没有可读取|页面已经变化/);
    assert.equal(h.previews.length, 0);
    assert.equal(h.evidence.length, 0);
  }
});

test('a network error reaches the current reader and permits a later retry', async () => {
  const h = readingEnvironment();
  const first = h.reader.read(h.active);
  h.requests[0].reject(new Error('网络不可用'));
  await assert.rejects(first, /网络不可用/);
  const retry = h.reader.read(h.active);
  h.finish(1);
  assert.ok((await retry).text);
  assert.equal(h.previews.length, 1);
});

// Exercise the actual handler and native capture cancellation, not a second
// implementation of their async transitions. Browser rendering is covered above.
const main = readFileSync(new URL('../site/curator/main.js', import.meta.url), 'utf8');
const readHandler = main.slice(main.indexOf('async function readCurrentPage()'), main.indexOf("listen(embedded ? root : document, 'click'"));
const captureHandler = main.slice(main.indexOf("function captureContext(purpose = 'conversation'"), main.indexOf('async function collectCurrentPage('));
function handlerEnvironment() {
  const requests = [], previews = [], errors = [], bridges = [];
  const scope = { client: { context: page(), busy: false, visible: true }, readingPage: false, destroyed: false,
    currentPageRead: null, pageReadCapture: null, captureRequests: new Map(), AbortController, setTimeout, clearTimeout,
    native: () => true, bridge(action, payload) { bridges.push({ action, ...payload }); },
    samePageReadTarget, updateComposer() {}, renderContext() {}, setError(message) { if (message) errors.push(message); },
    pageTextReader: { show(context) { previews.push(context); } },
  };
  scope.pageReadController = createPageReadController({ getContext: () => scope.client.context,
    fetchPage(context, requestId, signal) { return new Promise(resolve => requests.push({ context, requestId, signal, resolve })); },
    onRead(context) { scope.currentPageRead = context; }, show: context => scope.pageTextReader.show(context) });
  const read = vm.runInNewContext(`${captureHandler}\n${readHandler}\nreadCurrentPage`, scope);
  return { scope, read, requests, previews, errors,
    finishCapture(context = scope.client.context) { scope.client.context = context; scope.captureRequests.get(bridges.at(-1).requestId).resolve(context); },
    finishRead(index = 0, changes = {}) { const request = requests[index]; request.resolve({ requestId: request.requestId, readable: true,
      context: { ...request.context, text: '经过清洗的正文。', readStatus: 'public_page', contentQuality: { status: 'ready' } }, ...changes }); },
  };
}

test('the real read handler deduplicates clicks, accepts metadata churn and reopens its independent snapshot', async () => {
  const h = handlerEnvironment();
  const reading = h.read();
  assert.equal(h.scope.readingPage, true);
  assert.equal(h.scope.client.busy, false, 'reading must not take ownership of conversation busy');
  await h.read();
  assert.equal(h.scope.captureRequests.size, 1);
  h.finishCapture();
  await Promise.resolve();
  assert.equal(h.scope.captureRequests.size, 0);
  assert.equal(h.requests.length, 1);
  h.scope.client.context = { ...h.scope.client.context, contextVersion: 12 };
  h.finishRead(); await reading;
  assert.equal(h.scope.readingPage, false);
  assert.equal(h.scope.currentPageRead.contextVersion, 10);
  assert.equal(h.scope.client.context.contextVersion, 12);
  assert.equal(h.previews.length, 1);
  await h.read();
  assert.equal(h.previews.length, 2);
  assert.equal(h.requests.length, 1);
  assert.equal(h.scope.captureRequests.size, 0);
  assert.deepEqual(h.errors, []);
});

test('hiding or destroying during the real native capture clears its timer and cannot open a late preview', async () => {
  for (const destroy of [false, true]) {
    const h = handlerEnvironment();
    const reading = h.read();
    h.scope.client.visible = false;
    h.scope.destroyed = destroy;
    h.scope.pageReadCapture.abort();
    h.scope.pageReadController.invalidate();
    await reading;
    assert.equal(h.scope.captureRequests.size, 0);
    assert.equal(h.scope.readingPage, false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.previews.length, 0);
    assert.deepEqual(h.errors, []);
  }
});

test('the real handler reports unreadable responses, releases its read state and leaves other busy state intact', async () => {
  const h = handlerEnvironment();
  const reading = h.read();
  h.finishCapture(); await Promise.resolve();
  h.scope.client.busy = true;
  h.finishRead(0, { readable: false }); await reading;
  assert.equal(h.previews.length, 0);
  assert.match(h.errors[0], /没有可读取的正文/);
  assert.equal(h.scope.readingPage, false);
  assert.equal(h.scope.client.busy, true);
});
