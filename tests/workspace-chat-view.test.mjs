import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveConversation, conversationMessages, conversationJobs, conversationGroups, createConversationDraftStore } from '../site/curator/workspace-chat.js';
import { parseScopedCurationCommand } from '../site/curator/scoped-curation-command.js';
import { messageWebSourcesText } from '../site/curator/message-web-sources.js';
import { parseWebSearchRequest } from '../site/curator/web-search-intent.js';

const state = () => ({
  activeConversationId:'two',
  conversations:[{id:'legacy',title:'旧对话',createdAt:'2026-11-01T01:00:00Z',updatedAt:'2026-11-01T01:00:00Z'},{id:'one',title:'光与空间',createdAt:'2026-11-09T03:00:00Z',updatedAt:'2026-11-09T04:00:00Z'},{id:'two',title:'写作方法',createdAt:'2026-11-10T03:00:00Z',updatedAt:'2026-11-10T04:00:00Z'}],
  messages:[{id:'m-legacy',role:'user',text:'旧资料'},{id:'m-one',conversationId:'one',role:'user',text:'窗边的自然光'},{id:'m-two',conversationId:'two',role:'assistant',text:'先把方法写下来。'}],
  jobs:[{id:'job-one',conversationId:'one',messageId:'m-one',status:'running'},{id:'job-two',messageId:'m-two',status:'failed'},{id:'global-job',status:'complete'}],
});

test('a page keeps its explicit conversation even when another window selects a different one', () => {
  const value = state();
  assert.equal(resolveConversation(value,'one'),'one');
  assert.equal(resolveConversation(value,'missing'),'two');
  assert.equal(resolveConversation({conversations:[]},'missing'),'');
});

test('messages and background jobs cannot cross the current conversation boundary', () => {
  const value=state();
  assert.deepEqual(conversationMessages(value,'one').map(item=>item.id),['m-one']);
  assert.deepEqual(conversationMessages(value,'two').map(item=>item.id),['m-two']);
  assert.deepEqual(conversationMessages(value,'legacy').map(item=>item.id),['m-legacy']);
  assert.deepEqual(conversationJobs(value,'one').map(item=>item.id),['job-one']);
  assert.deepEqual(conversationJobs(value,'two').map(item=>item.id),['job-two']);
  assert.deepEqual(conversationJobs(value,'legacy'),[]);
});

test('legacy servers without conversation metadata retain their single existing timeline', () => {
  const value=state(); delete value.conversations;
  assert.deepEqual(conversationMessages(value,''),value.messages);
  assert.deepEqual(conversationJobs(value,''),value.jobs);
});

test('history search finds actual message content and groups each conversation only once', () => {
  const value=state(), now=new Date(2026,10,10,15).getTime();
  const groups=conversationGroups(value,{now});
  assert.deepEqual(groups.flatMap(group=>group.conversations.map(item=>item.id)),['two','one','legacy']);
  assert.equal(groups[0].title,'今天');
  const search=conversationGroups(value,{query:'自然光',now});
  assert.deepEqual(search.flatMap(group=>group.conversations.map(item=>item.id)),['one']);
  assert.equal(search[0].conversations[0].working,true);
  assert.deepEqual(conversationGroups(value,{query:'不存在的内容',now}),[]);
});

test('draft text, source scope and reading position survive a reload independently', () => {
  const data=new Map();
  const storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  const first=createConversationDraftStore(storage);
  first.set('one',{text:'第一份未发送',scope:{collectionIds:['source-one']},scrollTop:421,scrolled:true});
  first.set('two',{text:'第二份未发送',scope:null,scrollTop:0,scrolled:false});
  first.flush();
  const reopened=createConversationDraftStore(storage);
  assert.equal(reopened.get('one').text,'第一份未发送');
  assert.deepEqual(reopened.get('one').scope,{collectionIds:['source-one']});
  assert.equal(reopened.get('one').scrollTop,421);
  assert.equal(reopened.get('two').text,'第二份未发送');
  assert.equal(reopened.get('two').scope,null);
  assert.equal(reopened.get('unknown'),null);
});

test('corrupted or unavailable draft storage does not prevent conversation editing', () => {
  const store=createConversationDraftStore({getItem:()=>'{invalid',setItem:()=>{throw new Error('quota');}});
  store.set('one',{text:'仍在输入区里'});
  assert.doesNotThrow(()=>store.flush());
  assert.equal(store.get('one').text,'仍在输入区里');
});

const mainSource=readFileSync(new URL('../site/curator/main.js',import.meta.url),'utf8');
const copySource = mainSource.slice(mainSource.indexOf('const messageText ='), mainSource.indexOf('\nfunction messageNode('));
const copyButton = id => ({
  dataset: { tooltip: '复制' },
  isConnected: true,
  closest: selector => selector === '[data-message-id]' ? { dataset: { messageId: id } } : null,
});

function copyHarness(messages, writeText) {
  const notices = [], timers = new Map(), status = { textContent: '' };
  let nextTimer = 0;
  const copy = vm.runInNewContext(`${copySource}\ncopyMessage`, {
    client: { state: { messages } },
    copyFeedback: null,
    destroyed: false,
    text: value => typeof value === 'string' ? value : '',
    messageWebSourcesText,
    navigator: { clipboard: { writeText } },
    notify: value => notices.push(value),
    $: selector => selector === '#copy-status' ? status : null,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { copy, notices, status, timers };
}

test('copy preserves complete text and briefly marks the most recently copied message', async () => {
  const markdown = '第一段 **重点**\n\n- 列表\n\n```js\n  console.log(1);\n```';
  const legacy = '旧消息\n保留原始换行';
  const writes = [];
  const h = copyHarness([
    { id: 'reply', text: markdown, content: '旧字段', createdAt: '2026-11-12T00:00:00Z', collectionIds: ['source'] },
    { id: 'legacy', content: legacy },
    { id: 'empty', text: ' \n ' },
  ], async value => writes.push(value));
  const reply = copyButton('reply'), older = copyButton('legacy');
  const pending = h.copy(reply);
  assert.deepEqual(writes, [markdown], 'Clipboard write starts during the click');
  assert.equal(reply.dataset.copied, undefined);
  await pending;
  assert.deepEqual(reply.dataset, { tooltip: '已复制', copied: 'true' });
  assert.equal(h.status.textContent, '已复制消息。');
  await h.copy(older);
  await h.copy(copyButton('empty'));
  assert.deepEqual(writes, [markdown, legacy]);
  assert.deepEqual(h.notices, [], 'Successful copies only use inline feedback');
  assert.deepEqual(reply.dataset, { tooltip: '复制' });
  assert.deepEqual(older.dataset, { tooltip: '已复制', copied: 'true' });
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0]();
  assert.deepEqual(older.dataset, { tooltip: '复制' });
  assert.equal(h.status.textContent, '');
});

test('copy reports a rejected clipboard write without claiming success', async () => {
  const h = copyHarness([{ id: 'reply', text: '回复' }], async () => { throw new Error('Denied'); });
  const reply = copyButton('reply');
  await h.copy(reply);
  assert.deepEqual(h.notices, ['复制失败，请选中文字后手动复制。']);
  assert.deepEqual(reply.dataset, { tooltip: '复制' });
  assert.equal(h.status.textContent, '');
});

const senderSource=mainSource.slice(mainSource.indexOf('async function sendMessage('),mainSource.indexOf('\nfunction openProfile('));
function senderHarness() {
  let settle, reject;
  const response=new Promise((resolve,no)=>{settle=resolve;reject=no;});
  const input={value:'第一段对话的问题'}, drafts=new Map(),errors=[],requests=[];
  const client={conversationId:'one',busy:false,context:null,workspaceScope:null,sendingConversations:new Set(),sendErrors:new Map(),persistDraft(){drafts.set(this.conversationId,input.value);},clearSentDraft(id,message){if(drafts.get(id)?.trim()===message)drafts.set(id,'');}};
  const scope={client,composing:false,readingPage:false,document:{body:{}},$:selector=>selector==='#chat-input'?input:{},isDirectLinkCapture:()=>false,isPageCollectionCommand:()=>false,parseScopedCurationCommand,parseWebSearchRequest,native:()=>Boolean(client.context),setError:(...args)=>errors.push(args),updateComposer(){},renderMessages(){},renderContext(){},focusComposer(){},applyState(){},async refresh(){},notify(){},api(route,body){requests.push({route,body});return response;}};
  return {send:vm.runInNewContext(`${senderSource}\nsendMessage`,scope),input,client,drafts,errors,requests,settle,reject};
}

test('an explicit web query skips the current page and omits workspace references from its request', async () => {
  for (const attachedWorkspace of [false,true]) {
    const h = senderHarness();
    h.input.value = '帮我找找今天关于新 AI 模型发布的新闻';
    h.client.context = {url:'https://example.org/private-attachment',text:'Private source'};
    if (attachedWorkspace) {
      h.client.conversationId = '';
      h.client.workspaceScope = {collectionIds:['private-collection']};
      h.client.pageSessions = {view:{observedPage:h.client.context}};
    }
    const sending = h.send();
    try {
      assert.equal(h.requests.length,1);
      assert.equal(h.requests[0].body.text,h.input.value);
      assert.equal(h.requests[0].body.context,undefined);
      assert.equal(h.requests[0].body.collectionIds,undefined);
    } finally {
      h.settle({state:{},conversationId:'one'});
      await sending;
    }
  }
});

test('an accepted send clears only its original draft after the user switches conversations', async () => {
  const h=senderHarness(); const pending=h.send();
  assert.equal(h.requests[0].body.conversationId,'one');
  h.client.conversationId='two'; h.input.value='另一段对话的新草稿';
  h.client.sendingConversations.add('two');
  h.settle({state:{}}); await pending;
  assert.equal(h.input.value,'另一段对话的新草稿');
  assert.equal(h.drafts.get('one'),'');
  assert.equal(h.client.busy,true,'A second conversation still submitting must keep its own pending state');
  assert.equal(h.client.sendingConversations.has('one'),false);
});

test('a failed send keeps its original draft and does not attach its error to another conversation', async () => {
  const h=senderHarness(); const pending=h.send();
  h.client.conversationId='two'; h.input.value='第二段对话自己的内容';
  h.reject(new Error('暂时没有连接成功')); await pending;
  assert.equal(h.input.value,'第二段对话自己的内容');
  assert.equal(h.drafts.get('one'),'第一段对话的问题');
  assert.equal(h.client.sendErrors.get('one'),'暂时没有连接成功');
  assert.equal(h.errors.some(args=>args[0]==='暂时没有连接成功'),false);
});

test('a workspace exhibition opens the existing gallery directly with its encoded ID', () => {
  const source=mainSource.slice(mainSource.indexOf('function openExhibition('),mainSource.indexOf('\nasync function curate('));
  const location={href:''},opened=[];
  const scope={client:{},embedded:false,isChat:true,isWorkspaceChat:true,native:()=>false,location,bridge:(action,value)=>opened.push({action,value})};
  const open=vm.runInNewContext(`${source}\nopenExhibition`,scope);
  open('exhibition/a b',true);
  assert.equal(location.href,'/prototype/immersive-exhibition/light.html?exhibition=exhibition%2Fa%20b');
  location.href=''; scope.native=()=>true;
  open('exhibition-one');
  assert.equal(location.href,'');
  assert.equal(opened[0].action,'openStage');
  assert.equal(opened[0].value.exhibitionId,'exhibition-one');
});

const workspaceSource=readFileSync(new URL('../site/curator/workspace-chat.js',import.meta.url),'utf8');
function sidebarHarness() {
  const frames=new Map(), classes=new Set(), documentListeners=new Map();
  let nextFrame=0, drawerVisible=false, document;
  const element=name=>({name,isConnected:true,dataset:{},listeners:new Map(),addEventListener(type,listener){this.listeners.set(type,listener);},setAttribute(){},removeAttribute(){},getClientRects:()=>[{}],closest:()=>null,focus(){document.activeElement=this;}});
  const sidebar=element('sidebar'), panel=element('panel'), search=element('search'), container=element('list'), opener=element('opener'), close=element('close'), shade=element('shade'), create=element('create'), last=element('last');
  const drawerItems=[close,create,search,last];
  sidebar.querySelector=()=>create; sidebar.querySelectorAll=()=>drawerItems; sidebar.contains=target=>target===sidebar||drawerItems.includes(target);
  panel.contains=target=>target===opener;
  const body={classList:{contains:name=>classes.has(name),toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name);}}};
  document={body,activeElement:opener,getElementById:id=>({'chat-history':sidebar,'chat-panel':panel,'conversation-search':search,'conversation-list':container})[id],querySelectorAll:()=>[opener,close],querySelector:selector=>selector==='[data-chat-history-shade]'?shade:null,addEventListener(type,listener){documentListeners.set(type,listener);}};
  Object.defineProperty(panel,'inert',{set(value){this.isInert=value;if(value&&this.contains(document.activeElement))document.activeElement=body;},get(){return this.isInert;}});
  const source=workspaceSource.slice(workspaceSource.indexOf('export function mountConversationSidebar('),workspaceSource.indexOf('\nexport function openConversationReferences(')).replace('export function','function');
  const mount=vm.runInNewContext(`${source}\nmountConversationSidebar`,{document,matchMedia:()=>({matches:true,addEventListener(){}}),requestAnimationFrame:callback=>{const id=++nextFrame;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),getComputedStyle:target=>({visibility:target===sidebar||drawerItems.includes(target)?drawerVisible?'visible':'hidden':'visible'}),conversationGroups:()=>[]});
  const controller=mount({getState:()=>null,getActiveId:()=>'',onSelect(){},onNew(){}});
  return {document,panel,sidebar,search,opener,close,last,frames,controller,open:()=>opener.listeners.get('click')(),paint(){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback());},reveal(){drawerVisible=true;sidebar.listeners.get('transitionend')({target:sidebar});},key(key,shiftKey=false){const event={key,shiftKey,prevented:false,preventDefault(){this.prevented=true;}};documentListeners.get('keydown')(event);return event;}};
}

test('the mobile history waits for visibility before focusing and remembers its opener before inert blurs it', () => {
  const h=sidebarHarness();
  h.open();
  assert.equal(h.panel.inert,true);
  assert.equal(h.document.activeElement,h.document.body,'making the main pane inert can blur its focused opener');
  h.paint();
  assert.equal(h.document.activeElement,h.document.body,'a hidden drawer must not receive focus');
  h.reveal();
  assert.equal(h.document.activeElement,h.search);
  assert.equal(h.key('Escape').prevented,true);
  assert.equal(h.panel.inert,false);
  assert.equal(h.document.activeElement,h.opener);
});

test('rapidly closing history cancels delayed focus, while Tab stays inside a visible drawer', () => {
  const h=sidebarHarness();
  h.open(); h.controller.close(); h.paint(); h.reveal();
  assert.equal(h.document.activeElement,h.opener,'a stale animation callback must not focus the closed drawer');
  h.open(); h.paint();
  assert.equal(h.document.activeElement,h.search);
  h.document.activeElement=h.last;
  assert.equal(h.key('Tab').prevented,true);
  assert.equal(h.document.activeElement,h.close);
  assert.equal(h.key('Tab',true).prevented,true);
  assert.equal(h.document.activeElement,h.last);
  h.document.activeElement=h.document.body;
  assert.equal(h.key('Tab').prevented,true);
  assert.equal(h.document.activeElement,h.close);
});
