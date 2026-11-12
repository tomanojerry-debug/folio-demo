import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeWorkspaceChatRequest, workspaceChatScope } from '../site/curator/chat-launch.js';
import { parseScopedCurationCommand } from '../site/curator/scoped-curation-command.js';
import { parseVideoCaptureCommand } from '../site/curator/video-capture-command.js';
import { parseWebSearchRequest } from '../site/curator/web-search-intent.js';
import { isDirectLinkCapture } from '../site/curator/page-context.js';
import { mapDesktopState, workspaceDiff } from '../site/curator/desktop-legacy-bridge.js';

test('workspace chat carries a bounded explicit draft and local identifiers only', () => {
  const request = normalizeWorkspaceChatRequest({ message: '  比较这两条  ', collectionIds: ['one', 'one', 'two'], submit: true, context: { text: '不得转发来源正文' }, token: '不得转发' }, 'request-one');
  assert.deepEqual(request, { requestId: 'request-one', expiresAt: request.expiresAt, message: '比较这两条', collectionIds: ['one', 'two'], submit: true });
  assert.ok(request.expiresAt > Date.now());
  assert.equal(normalizeWorkspaceChatRequest({ message: '  ', submit: true }, 'empty').submit, false);
  assert.equal(normalizeWorkspaceChatRequest({ message: '继续聊', submit: 'true' }, 'draft').submit, false);
  assert.throws(() => normalizeWorkspaceChatRequest({ collectionIds: Array(7).fill('one') }), /最多选择/);
  assert.throws(() => normalizeWorkspaceChatRequest({ collectionIds: [''] }), /最多选择/);
  assert.throws(() => normalizeWorkspaceChatRequest({ message: 'a'.repeat(60001) }), /太长/);
  assert.throws(() => normalizeWorkspaceChatRequest({ requestId: 'unsafe<script>' }), /请求已失效/);
  assert.throws(() => normalizeWorkspaceChatRequest({ expiresAt: Date.now() - 1 }), /过期/);
});

test('workspace scope resolves real titles and rejects missing collection or exhibition IDs', () => {
  const state = { collections: [{ id: 'one', title: '第一条' }, { id: 'two', title: '第二条' }], exhibitions: [{ id: 'show', title: '小展' }] };
  assert.equal(workspaceChatScope({ collectionIds: ['one'] }, state).title, '第一条');
  assert.equal(workspaceChatScope({ collectionIds: ['one', 'two'] }, state).title, '2 条收藏');
  assert.equal(workspaceChatScope({ collectionIds: [], exhibitionId: 'show' }, state).title, '小展');
  assert.equal(workspaceChatScope({ collectionIds: [] }, state).title, '我的收藏馆');
  assert.throws(() => workspaceChatScope({ collectionIds: ['unknown'] }, state), /收藏暂时不可用/);
  assert.throws(() => workspaceChatScope({ collectionIds: [], exhibitionId: 'missing' }, state), /展览暂时不可用/);
});

test('home task status and capability snapshots never become editable workspace fields', () => {
  const remote = { jobs: [{ id: 'job', status: 'failed' }], capabilities: { aiEnabled: true } };
  const before = mapDesktopState(remote);
  assert.deepEqual(before.workspaceJobs, remote.jobs);
  assert.deepEqual(before.desktopCapabilities, remote.capabilities);
  const after = structuredClone(before);
  after.workspaceJobs[0].status = 'complete'; after.desktopCapabilities.aiEnabled = false;
  assert.equal(remote.jobs[0].status, 'failed');
  assert.deepEqual(workspaceDiff(before, after), []);
});

// Exercise the actual DOM-bound receiver with only its surrounding UI mocked.
const mainSource = readFileSync(new URL('../site/curator/main.js', import.meta.url), 'utf8');
const receiverSource = mainSource.slice(mainSource.indexOf('function receiveWorkspaceChat('), mainSource.indexOf('\nfunction renderContext('));
const senderSource = mainSource.slice(mainSource.indexOf('async function sendMessage('), mainSource.indexOf('\nfunction openProfile('));
function chatHarness({ composing = false, readingPage = false, draft = '', realSender = false, context = null } = {}) {
  const input = { value: draft };
  const client = { state: { collections: [{ id: 'one', title: '收藏一' }] }, connected: true, busy: false, workspaceScope: null, context };
  const calls = [];
  const errors = [];
  const scope = { normalizeWorkspaceChatRequest, workspaceChatScope, workspaceRequests: new Map(), client, composing, readingPage,
    document: { hidden: true, body: {} },
    $: selector => selector === '#chat-input' ? input : {},
    openChat() {}, async refresh() {}, notify() {}, setError: (...args) => errors.push(args),
    renderContext() {}, updateComposer() {}, focusComposer() {}, renderMessages() {},
    requestAnimationFrame() { throw new Error('Explicit sends must not depend on an animation frame.'); },
    sendMessage() { calls.push(input.value); },
    isDirectLinkCapture, isPageCollectionCommand: () => false, parseScopedCurationCommand, parseVideoCaptureCommand, parseWebSearchRequest, native: () => Boolean(context),
    api: async (route, body) => { calls.push({ route, body }); throw new Error('暂时没有连上本机服务'); },
  };
  const receiver = vm.runInNewContext(`${receiverSource}\n${realSender ? senderSource : ''}\nreceiveWorkspaceChat`, scope);
  return { receiver, input, client, calls, errors };
}

test('explicit workspace submit sends once even when the chat document is hidden', async () => {
  const harness = chatHarness();
  const request = { requestId: 'hidden-submit', message: '聊聊这条', collectionIds: ['one'], submit: true };
  const result = await harness.receiver(request);
  assert.equal(result.accepted, true);
  assert.deepEqual(harness.calls, ['聊聊这条']);
  assert.equal((await harness.receiver(request)).accepted, true);
  assert.equal(harness.calls.length, 1);
});

test('composition, an active page read or an existing chat draft rejects transfer before replacing scope or input', async () => {
  for (const options of [{ composing: true }, { readingPage: true }, { draft: '原来的草稿' }]) {
    const harness = chatHarness(options);
    const result = await harness.receiver({ requestId: 'protected-draft', message: '新问题', collectionIds: ['one'], submit: true });
    assert.equal(result.accepted, false);
    assert.equal(harness.input.value, options.draft || '');
    assert.equal(harness.client.workspaceScope, null);
    assert.equal(harness.calls.length, 0);
  }
});

test('failed transferred send keeps the question and collection scope in the shared chat for retry', async () => {
  const harness = chatHarness({ realSender: true });
  const result = await harness.receiver({ requestId: 'failed-submit', message: '新问题', collectionIds: ['one'], submit: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.accepted, true);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].route, 'messages');
  assert.equal(harness.calls[0].body.intent, 'chat');
  assert.deepEqual(harness.calls[0].body.collectionIds, ['one']);
  assert.equal(harness.input.value, '新问题');
  assert.equal(harness.client.workspaceScope.collectionIds[0], 'one');
  assert.equal(harness.client.busy, false);
  assert.ok(harness.errors.some(args => args[0] === '暂时没有连上本机服务' && args[1] === true));
});

test('standalone video capture transferred to native chat does not read or attach its active page', async () => {
  const context = { url: 'https://example.org/unrelated' };
  const harness = chatHarness({ realSender: true, context });
  const message = 'https://example.org/demo 收藏这个视频的内容';
  const result = await harness.receiver({ requestId: 'video-submit', message, submit: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.accepted, true);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].route, 'messages');
  assert.equal(harness.calls[0].body.text, message);
  assert.equal(harness.calls[0].body.intent, undefined);
  assert.equal(harness.calls[0].body.context, undefined);
  assert.equal(harness.client.workspaceScope, null);
  assert.equal(harness.client.context, context);
});
