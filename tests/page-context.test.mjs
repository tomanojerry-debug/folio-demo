import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePageContext, samePageContext, collectionForPage, isPageCollectionCommand, isDirectLinkCapture, captureReplyDisposition, isFreshContextUpdate, sourceForMessage, pageReadEvidence, advanceContextVersion } from '../site/curator/page-context.js';
import { parseVideoCaptureCommand } from '../site/curator/video-capture-command.js';

test('page association keeps a declined prompt through URL enrichment, but changes across pages or attachments', () => {
  const window = normalizePageContext({ attachmentId: 'one', title: '窗口标题', appName: '浏览器' });
  const page = normalizePageContext({ attachmentId: 'one', title: '文章标题', appName: '浏览器', url: 'https://example.org/article' });
  assert.equal(samePageContext(window, page), true);
  assert.equal(samePageContext(page, { ...page, url: page.url + '#part' }), true);
  assert.equal(samePageContext(page, { ...page, url: 'https://example.org/other' }), false);
  assert.equal(samePageContext(page, { ...page, attachmentId: 'two' }), false);
  assert.equal(samePageContext(page, null), false);
  assert.equal(collectionForPage({ ...page, url: page.url + '#section' }, [{ id: 'saved', url: page.url }]).id, 'saved');
});

test('late capture A cannot replace active B and a failed read does not merge page revisions', () => {
  const a = normalizePageContext({ attachmentId: 'window', pageRevision: 'page-a', contextVersion: 10, url: 'https://example.org/a', title: 'A' });
  const unavailable = { ...a, url: '', contextStatus: 'unavailable', contextVersion: 11 };
  const b = { ...a, pageRevision: 'page-b', contextVersion: 12, url: 'https://example.org/b', title: 'B' };
  assert.equal(samePageContext(a, unavailable), true);
  assert.equal(samePageContext(unavailable, b), false);
  assert.equal(captureReplyDisposition(a, b, a), 'superseded');
  assert.equal(captureReplyDisposition(a, a, b), 'changed');
  assert.equal(isFreshContextUpdate(b, a), false);
  assert.equal(captureReplyDisposition(a, a, { ...a, contextVersion: 9 }), 'stale');
});

test('hash-routed documents stay distinct while ordinary paragraph anchors identify the same page', () => {
  const base = normalizePageContext({ attachmentId:'window', appName:'Google Chrome', url:'https://example.org/app', title:'App' });
  assert.equal(samePageContext(base,{...base,url:base.url+'#paragraph'}),true);
  assert.equal(samePageContext({...base,url:base.url+'#/article/a'},{...base,url:base.url+'#/article/b'}),false);
  assert.equal(samePageContext({...base,url:base.url+'#!/article/a'},{...base,url:base.url+'#!/article/b'}),false);
  assert.equal(collectionForPage({...base,url:base.url+'#/article/a'},[{id:'b',url:base.url+'#/article/b'}]),null);
});

test('detach preserves the source version high-water mark so stale empty or page replies cannot revive it', () => {
  const detached = advanceContextVersion(11, { contextVersion: 12 });
  assert.equal(detached.accepted, true);
  assert.equal(advanceContextVersion(detached.highWater, { contextVersion: 11, url: 'https://example.org/a' }).accepted, false);
  assert.equal(advanceContextVersion(12, { contextVersion: 11 }).accepted, false);
  assert.equal(advanceContextVersion(12, null).accepted, false);
  assert.equal(advanceContextVersion(12, { contextVersion: 13 }).accepted, true);
});

test('browser text keeps its real source and truncation evidence', () => {
  const context = normalizePageContext({ title: '页面', text: '字'.repeat(40010), contentSource: 'browser-accessibility', browserWindowId: 42, browserTabId: 99 });
  assert.equal(context.text.length, 40000);
  assert.equal(context.textTruncated, true);
  assert.equal(context.contentSource, 'browser-accessibility');
  assert.equal(context.browserWindowId, '42');
  assert.equal(context.browserTabId, '99');
});

test('cleaned public-page quality survives normalization without accepting unsafe resolved URLs', () => {
  const context = normalizePageContext({ title: '页面', url: 'https://example.org/article', resolvedUrl: 'https://example.org/canonical',
    text: '清洗后的正文', readStatus: 'public_page', contentQuality: { version: 1, status: 'ready', method: 'semantic-html', scope: 'main',
      characterCount: 7896, paragraphCount: 194, removedLines: 2, warnings: [], truncated: false, fallbackFrom: 'browser-accessibility', fallbackReason: 'TRUNCATED_BROWSER_TEXT' } });
  assert.equal(context.readStatus, 'public_page');
  assert.equal(context.resolvedUrl, 'https://example.org/canonical');
  assert.equal(context.contentQuality.characterCount, 7896);
  assert.equal(context.contentQuality.fallbackReason, 'TRUNCATED_BROWSER_TEXT');
  assert.equal(normalizePageContext({ title: '页面', resolvedUrl: 'https://user:secret@example.org' }).resolvedUrl, '');
});

test('matching server cleaning evidence wins over raw AX text, but older versions and another browser tab cannot override a new capture', () => {
  const active = { attachmentId: 'window', pageRevision: 'page', contextVersion: 10, url: 'https://example.org/a',
    browserWindowId: '12', browserTabId: '23', text: '原始浏览器片段', textTruncated: true };
  const cleaned = { ...active, text: '完整清洗正文', textTruncated: false, readStatus: 'public_page', contentQuality: { status: 'ready' } };
  assert.equal(pageReadEvidence(active, { messages: [{ context: cleaned }] }), cleaned);
  const raw = pageReadEvidence({ ...active, contextVersion: 11 }, { messages: [{ context: cleaned }] });
  assert.equal(raw.readStatus, 'attached_text');
  assert.equal(raw.textTruncated, true);
  assert.equal(raw.text, active.text);
  const anotherTab = { ...cleaned, browserTabId: '99' };
  assert.equal(pageReadEvidence(active, { messages: [{ context: anotherTab }] }).readStatus, 'attached_text');
  const otherPage = { ...cleaned, url: 'https://example.org/b' };
  assert.equal(pageReadEvidence(active, { messages: [{ context: otherPage }] }).readStatus, 'attached_text');
});

test('first unknown-URL collection requires confirmation after identifying the page', () => {
  const metadata = normalizePageContext({ attachmentId: 'window', pageRevision: 'page', contextVersion: 1, title: '浏览器窗口' });
  const ready = normalizePageContext({ ...metadata, contextVersion: 2, url: 'https://example.org/b', title: '确认后的实际页面', requiresConfirmation: true });
  assert.equal(captureReplyDisposition(metadata, metadata, ready, 'collect'), 'confirm');
  assert.equal(captureReplyDisposition(metadata, metadata, ready, 'connect'), 'accepted');
  assert.equal(captureReplyDisposition(ready, ready, { ...ready, contextVersion: 3, requiresConfirmation: false }, 'collect'), 'accepted');
});

test('URLs inside a question or refusal remain dialogue while direct link capture stays explicit', () => {
  for (const command of ['https://example.org/a', 'https://example.org/a\nhttps://example.org/b', '收藏 https://example.org/a', '帮我保存：https://example.org/a']) assert.equal(isDirectLinkCapture(command), true, command);
  for (const command of ['这页和 https://example.org/b 有什么区别？', '不要收藏 https://example.org/b', 'https://example.org/b 讲了什么？', '他说“收藏 https://example.org/b”是什么意思？']) assert.equal(isDirectLinkCapture(command), false, command);
});

test('explicit video collection preserves the URL and excludes questions, refusals and quotes', () => {
  const url = 'https://www.vastdata.com/resources/forms/demos/agent-knowledge-foundation-with-nvidia-auto-ontology?source=chat';
  for (const command of [`${url} 收藏这个视频的内容`, `${url} + 请帮我收藏这个视频的字幕。`, `保存这个视频的内容：${url}`, `收藏字幕 ${url}`]) {
    assert.equal(parseVideoCaptureCommand(command), url, command);
    assert.equal(isDirectLinkCapture(command), true, command);
  }
  for (const command of [`${url} 收藏这个视频的内容？`, `${url} 不要收藏这个视频的内容`, `他说“${url} 收藏这个视频的内容”`, '`' + url + ' 收藏这个视频的内容`', `${url} https://example.org/b 收藏这个视频的内容`, '收藏字幕 https://name:password@example.org']) {
    assert.equal(parseVideoCaptureCommand(command), '', command);
    assert.equal(isDirectLinkCapture(command), false, command);
  }
});

test('late page-A answers retain their source and do not count as evidence for page B', () => {
  const a = { attachmentId: 'window', pageRevision: 'a', url: 'https://example.org/a', title: 'A', readStatus: 'public_page' };
  const b = { ...a, pageRevision: 'b', url: 'https://example.org/b', title: 'B' };
  const user = { id: 'question-a', role: 'user', context: a };
  const answer = { id: 'answer-a', role: 'assistant', jobId: 'job-a' };
  const state = { messages: [user, answer], jobs: [{ id: 'job-a', messageId: user.id }] };
  assert.equal(sourceForMessage(answer, state).url, a.url);
  assert.equal(pageReadEvidence(a, state).readStatus, 'public_page');
  assert.equal(pageReadEvidence(b, state), null);
  assert.equal(sourceForMessage({ ...answer, pageSource: b }, state).title, 'B');
});

test('page collection detection excludes refusal, quotation and unrelated saved text', () => {
  for (const command of ['收藏这个页面', '帮我收藏这篇文章', '保存本页', '收藏这页', '收藏这条链接', '把这个页面收藏起来']) {
    assert.equal(isPageCollectionCommand(command), true, command);
  }
  for (const other of ['不要收藏这个页面', '先别收藏这个页面', '他说“收藏这个页面”是什么意思', '收藏：今天的想法', '这篇文章讲什么？']) assert.equal(isPageCollectionCommand(other), false, other);
  assert.equal(normalizePageContext({ url: 'https://user:secret@example.org' }), null);
  assert.equal(normalizePageContext({ url: 'javascript:alert(1)' }), null);
});
