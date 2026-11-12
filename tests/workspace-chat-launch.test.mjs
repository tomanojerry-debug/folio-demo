import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceChatLauncher } from '../site/curator/workspace-chat-launch.js';

function fixture({ state = {}, send, navigate } = {}) {
  const calls = [], routes = [], saved = new Map();
  let creations = 0;
  const current = { collections: [{ id: 'source-one', title: '光与空间' }], exhibitions: [], conversations: [], ...state };
  const launch = createWorkspaceChatLauncher({
    api: async (route, body) => {
      calls.push({ route, body });
      if (route === 'state') return current;
      if (route === 'conversations') return { conversation: { id: `conversation-${++creations}` } };
      if (route === 'messages' && send) return send(body);
      return { state: current };
    },
    navigate: url => { routes.push(url); return navigate?.(url); },
    storage: { setItem: (key, value) => saved.set(key, value) },
  });
  return { launch, calls, routes, saved };
}

test('home submit is saved with explicit conversation and references before entering its page', async () => {
  let saved = false;
  const f = fixture({ send: async () => { saved = true; }, navigate: () => assert.equal(saved, true) });
  const result = await f.launch({ message: '比较光与材料的关系', collectionIds: ['source-one'], submit: true });
  assert.equal(result.accepted, true);
  assert.deepEqual(f.calls.map(call => call.route), ['state', 'conversations', 'messages']);
  assert.equal(f.calls[2].body.conversationId, 'conversation-1');
  assert.equal(f.calls[2].body.intent, 'chat');
  assert.deepEqual(f.calls[2].body.collectionIds, ['source-one']);
  assert.ok(f.calls[2].body.requestId);
  assert.deepEqual(f.routes, ['/prototype/immersive-exhibition/light.html?conversation=conversation-1#chat']);
  assert.deepEqual(JSON.parse(f.saved.get('forme.workspace-chat.scope:conversation-1')), { collectionIds: ['source-one'] });
  assert.equal(f.routes[0].includes('比较'), false, 'Questions must not enter URLs or browser history');
});

test('home submits a standalone video capture and preserves an explicitly selected discussion scope', async () => {
  const message = 'https://example.org/demo 收藏这个视频的内容';
  const capture = fixture();
  assert.equal((await capture.launch({ message, submit: true })).accepted, true);
  const captureBody = capture.calls.find(call => call.route === 'messages').body;
  assert.equal(captureBody.text, message);
  assert.equal(captureBody.intent, undefined);
  assert.equal(captureBody.collectionIds, undefined);

  const scoped = fixture();
  assert.equal((await scoped.launch({ message, collectionIds: ['source-one'], submit: true })).accepted, true);
  const scopedBody = scoped.calls.find(call => call.route === 'messages').body;
  assert.equal(scopedBody.intent, 'chat');
  assert.deepEqual(scopedBody.collectionIds, ['source-one']);
});

test('continue opens the existing active conversation without sending a message', async () => {
  const f = fixture({ state: { conversations: [{ id: 'old', updatedAt: '2026-11-09' }, { id: 'current', updatedAt: '2026-11-10' }], activeConversationId: 'old' } });
  assert.equal((await f.launch({})).conversationId, 'old');
  assert.deepEqual(f.calls.map(call => call.route), ['state', 'conversations/select']);
  assert.equal(f.routes[0], '/prototype/immersive-exhibition/light.html?conversation=old#chat');
});

test('a failed first send preserves retry identity and never navigates or creates a second conversation', async () => {
  let attempts = 0;
  const f = fixture({ send: async () => { if (++attempts === 1) throw new Error('本机服务暂时没有响应'); } });
  const draft = { message: '保留这次输入', submit: true };
  assert.equal((await f.launch(draft)).accepted, false);
  assert.equal(f.routes.length, 0);
  assert.equal((await f.launch(draft)).accepted, true);
  const sends = f.calls.filter(call => call.route === 'messages');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].body.requestId, sends[1].body.requestId);
  assert.equal(sends[0].body.conversationId, sends[1].body.conversationId);
  assert.equal(f.calls.filter(call => call.route === 'conversations').length, 1);
});

test('repeated clicks share one pending launch', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const f = fixture({ send: () => response });
  const first = f.launch({ message: '只发送一次', submit: true });
  const second = f.launch({ message: '只发送一次', submit: true });
  assert.strictEqual(first, second);
  finish({}); await first;
  assert.equal(f.calls.filter(call => call.route === 'messages').length, 1);
  assert.equal(f.routes.length, 1);
});

test('a prepared draft and explicit references stay in session storage without being submitted', async () => {
  const f = fixture();
  await f.launch({ message: '先想一想这个问题', collectionIds: ['source-one'], submit: false });
  assert.equal(f.saved.get('forme.workspace-chat.draft:conversation-1'), '先想一想这个问题');
  assert.equal(f.calls.some(call => call.route === 'messages'), false);
});

test('invalid references and sample-only entry do not create conversations or navigate', async () => {
  const f = fixture();
  assert.equal((await f.launch({ message: '问题', collectionIds: ['missing'], submit: true })).accepted, false);
  assert.deepEqual(f.calls.map(call => call.route), ['state']);
  const sample = createWorkspaceChatLauncher({ sample: true, api: () => { throw new Error('Sample must not call a private API'); }, navigate: () => { throw new Error('Sample must not navigate to private chat'); } });
  assert.equal((await sample({ message: '问题', submit: true })).accepted, false);
});

test('the launcher waits for the shared view and can retry a failed mount without sending twice', async () => {
  let mounts = 0;
  const f = fixture({ navigate:async () => { if (++mounts === 1) throw new Error('视图尚未准备好'); } });
  const request = {message:'已保存的问题仍只发一次',submit:true};
  assert.equal((await f.launch(request)).accepted,false);
  assert.equal((await f.launch(request)).accepted,true);
  assert.equal(f.calls.filter(call => call.route === 'messages').length,1);
  assert.equal(f.calls.filter(call => call.route === 'conversations').length,1);
});
