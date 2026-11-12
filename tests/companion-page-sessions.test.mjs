import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCompanionSessions, companionPageKey, companionSurface, companionHistory } from '../site/curator/companion-sessions.js';
import { normalizePageContext, samePageContext } from '../site/curator/page-context.js';
import { conversationMessages, conversationJobs } from '../site/curator/workspace-chat.js';
import { conversationActivity } from '../site/curator/chat-activity.js';
import { acceptPageSession, resolvePageSession, pageSource } from '../desktop/server/harness/page-sessions.mjs';

const page = name => ({ appName:'Google Chrome',attachmentId:'window-one',browserWindowId:'11',browserTabId:name,
  url:`https://example.org/${name}`,title:`Article ${name}`,pageRevision:name,contextVersion:1 });
const readable = context => ({...context,text:`${context.title} has real source content for discussion.`,readStatus:'attached_text',contentQuality:{status:'ready'}});
function harness() {
  const state={conversations:[],messages:[],jobs:[],profile:{},collections:[],exhibitions:[]};
  let selected='',guard=false,at=Date.parse('2026-11-10T07:00:00.000Z');
  const calls=[],selections=[],errors=[];
  const api=async(route,body)=>{
    calls.push({route,body});
    if(route==='pages/resolve')return resolvePageSession(state,body.context,{at});
    if(route==='pages/source')return {context:pageSource(state,body.conversationId)};
    if(route==='pages/open'){
      const context=readable(body.context);
      const accepted=acceptPageSession(state,{...body,context,fingerprint:JSON.stringify([body.context,body.forceNew]),at});
      return {...accepted,context,readable:true,conversation:state.conversations.find(c=>c.id===accepted.conversationId),state:structuredClone(state)};
    }
    throw new Error(`Unexpected API ${route}`);
  };
  const controller=createCompanionSessions({api,getConversationId:()=>selected,getGuard:()=>guard,onSelect:(id,options)=>{selected=id;selections.push({id,...options});},onError:error=>errors.push(error)});
  return {controller,state,calls,selections,errors,api,get selected(){return selected;},set guard(value){guard=value;},set at(value){at=value;}};
}

test('detecting B preserves A and its accepted source until the user explicitly reads B',async()=>{
  const h=harness();await h.controller.observe(page('a'));
  assert.equal(h.state.conversations.length,0);assert.equal(h.controller.view.status,'unread');
  const a=await h.controller.open();await h.controller.observe(page('b'));
  assert.equal(h.selected,a);assert.equal(h.controller.view.acceptedSource.url,page('a').url);
  assert.equal(h.controller.view.status,'unread');assert.equal(h.state.conversations.length,1);
  const b=await h.controller.open();assert.notEqual(b,a);assert.equal(h.state.conversations.length,2);
  await h.controller.observe(page('a'));
  assert.equal(h.selected,a);assert.equal(h.state.conversations.length,2);
  assert.equal(h.controller.view.acceptedSource.text,readable(page('a')).text);
});

test('keep old discussion prevents later navigation from replacing the source; reopening resets page following',async()=>{
  const h=harness();await h.controller.observe(page('a'));const a=await h.controller.open();
  await h.controller.observe(page('b'));h.controller.keep();await h.controller.observe(page('c'));
  assert.equal(h.selected,a);assert.equal(h.controller.view.followMode,'pinned');
  assert.equal(h.controller.view.acceptedSource.url,page('a').url);
  await h.controller.setVisible(false);await h.controller.setVisible(true);
  assert.equal(h.controller.view.followMode,'follow');assert.equal(h.controller.view.status,'unread');
  assert.equal(h.state.conversations.length,1);
});

test('an unsupported native window stays visible without becoming a conversation source',async()=>{
  const h=harness();
  await h.controller.observe(page('a'));
  const old=await h.controller.open();
  const attached=normalizePageContext({attachmentId:'wechat-window',appName:'微信',title:'公众号文章',contextStatus:'unsupported'});
  await h.controller.observe({...page('blocked'),url:'https://127.0.0.1/'});
  assert.equal(h.controller.view.status,'error');
  assert.ok(h.controller.view.error);
  h.calls.length=0;
  await h.controller.observe(attached);
  assert.equal(h.controller.view.status,'window-only');
  assert.equal(h.controller.view.observedPage.appName,'微信');
  assert.equal(h.controller.view.resolution,null);
  assert.equal(h.controller.view.error,'');
  assert.equal(h.controller.view.acceptedSource.url,page('a').url);
  assert.equal(h.selected,old);
  assert.equal(await h.controller.open({capture:()=>assert.fail('Unsupported windows cannot be read')}),null);
  assert.deepEqual(h.calls,[]);

  h.controller.keep();
  await h.controller.setVisible(false);
  await h.controller.setVisible(true);
  await h.controller.select(old);
  assert.equal(h.controller.view.status,'window-only');
  assert.equal(h.controller.view.acceptedSource.url,page('a').url);
  await h.controller.newDraft();
  assert.equal(h.controller.view.status,'window-only');
  assert.equal(h.controller.view.acceptedSource,null);
  assert.equal(await h.controller.open(),null);
  assert.deepEqual(h.calls.map(call=>call.route),['pages/source']);
  assert.equal(h.state.conversations.length,1);
  await h.controller.observe(null);
  assert.equal(h.controller.view.status,'idle');
  assert.equal(h.controller.view.observedPage,null);
});

test('granting window recognition enriches the existing attachment without reading automatically', async () => {
  const h = harness();
  const window = normalizePageContext({ attachmentId: 'wechat-window', appName: '微信',
    title: '微信窗口', sourceType: 'wechat-window', contextStatus: 'needs_window_recognition' });
  await h.controller.observe(window);
  assert.equal(h.controller.view.status, 'window-only');
  assert.equal(await h.controller.open(), null);
  assert.deepEqual(h.calls, []);

  const article = normalizePageContext({ ...window, title: '公众号文章', sourceType: 'wechat-article',
    url: 'https://mp.weixin.qq.com/s/folio-fixture', contextStatus: 'ready' });
  await h.controller.observe(article);
  assert.equal(h.controller.view.status, 'unread');
  assert.equal(h.controller.view.observedPage.attachmentId, window.attachmentId);
  assert.deepEqual(h.calls.map(call => call.route), ['pages/resolve']);
  assert.equal(h.state.conversations.length, 0);
});

test('returning to known A during typing defers restoration until an explicit continue action',async()=>{
  const h=harness();await h.controller.observe(page('a'));const a=await h.controller.open();
  await h.controller.observe(page('b'));const b=await h.controller.open();h.guard=true;
  await h.controller.observe(page('a'));
  assert.equal(h.selected,b);assert.equal(h.controller.view.status,'resume');
  await h.controller.resume();assert.equal(h.selected,a);
});

test('24 hour page expiry prepares a new discussion and leaves original history available',async()=>{
  const h=harness();await h.controller.observe(page('a'));const old=await h.controller.open();
  h.at=Date.parse('2026-11-11T07:00:00.000Z');await h.controller.setVisible(false);await h.controller.setVisible(true);
  assert.equal(h.selected,'');assert.equal(h.controller.view.status,'expired');
  assert.equal(h.controller.view.resolution.previousConversationId,old);assert.equal(h.state.conversations.length,1);
  const current=await h.controller.open();assert.notEqual(current,old);assert.equal(h.state.conversations.length,2);
  await h.controller.select(old);assert.equal(h.selected,old);assert.equal(h.controller.view.followMode,'pinned');
});

test('new-page results cannot steal selection after a later page has been observed',async()=>{
  let selected='',resolveRead;
  const controller=createCompanionSessions({getConversationId:()=>selected,onSelect:id=>{selected=id;},api:async(route,body)=>{
    if(route==='pages/resolve')return {status:'unread'};
    if(route==='pages/open')return new Promise(resolve=>{resolveRead=()=>resolve({readable:true,conversationId:'old-a',context:readable(body.context)});});
  }});
  await controller.observe(page('a'));const pending=controller.open();await Promise.resolve();
  await controller.observe(page('b'));resolveRead();assert.equal(await pending,null);
  assert.equal(selected,'');assert.equal(controller.view.observedPage.url,page('b').url);
});

test('reopening an expired saved page clears its automatic selection even before a source snapshot loads',async()=>{
  let selected='old-a';const changes=[];
  const controller=createCompanionSessions({getConversationId:()=>selected,getGuard:()=>true,
    onSelect:(id,options)=>{selected=id;changes.push(options);},api:async()=>({status:'expired',previousConversationId:'old-a'})});
  await controller.observe(page('a'));
  assert.equal(selected,'');assert.equal(controller.view.status,'expired');
  assert.equal(changes[0].context,null);
});

test('an uncertain read retry retains request identity and the original captured payload',async()=>{
  const requests=[];let attempt=0,selected='';
  const controller=createCompanionSessions({getConversationId:()=>selected,onSelect:id=>{selected=id;},api:async(route,body)=>{
    if(route==='pages/resolve')return {status:'unread'};
    requests.push(body);if(attempt++===0)throw new Error('response lost');
    return {readable:true,conversationId:'saved',context:readable(body.context)};
  }});
  await controller.observe(page('a'));assert.equal(await controller.open(),null);
  await controller.observe({...page('a'),contextVersion:9});await controller.open();
  assert.equal(requests[0].requestId,requests[1].requestId);assert.deepEqual(requests[0].context,requests[1].context);
  assert.equal(selected,'saved');
});

test('an unreadable page can retry with newly captured content and a new request',async()=>{
  const requests=[];
  let selected='';
  const controller=createCompanionSessions({getConversationId:()=>selected,onSelect:id=>{selected=id;},api:async(route,body)=>{
    if(route==='pages/resolve')return {status:'unread'};
    requests.push(body);
    return body.context.text ? {readable:true,conversationId:'saved',context:readable(body.context)} : {readable:false};
  }});
  await controller.observe(page('a'));
  assert.equal(await controller.open(),null);
  assert.equal(await controller.open({capture:expected=>({...expected,text:'fresh content'})}),'saved');
  assert.equal(requests[1].context.text,'fresh content');
  assert.notEqual(requests[0].requestId,requests[1].requestId);
});

test('a newer page read can start while an unabortable previous read is still running',async()=>{
  let selected='';const pending=[];
  const controller=createCompanionSessions({getConversationId:()=>selected,onSelect:id=>{selected=id;},api:async(route,body)=>{
    if(route==='pages/resolve')return {status:'unread'};
    return new Promise(resolve=>pending.push({body,resolve}));
  }});
  await controller.observe(page('a'));const first=controller.open();await Promise.resolve();
  await controller.observe(page('b'));const second=controller.open();await Promise.resolve();
  assert.equal(pending.length,2);
  pending[1].resolve({readable:true,conversationId:'b',context:readable(page('b'))});
  assert.equal(await second,'b');
  pending[0].resolve({readable:true,conversationId:'a',context:readable(page('a'))});
  assert.equal(await first,null);assert.equal(selected,'b');
});

test('an aborted attached read cannot select an old tab with the same page URL',async()=>{
  let selected='';
  const pending=[];
  const controller=createCompanionSessions({getConversationId:()=>selected,onSelect:id=>{selected=id;},api:async(route,body,{signal}={})=>{
    if(route==='pages/resolve')return {status:'unread'};
    return new Promise(resolve=>pending.push({body,signal,resolve}));
  }});
  const firstPage=page('a'), nextPage={...firstPage,browserTabId:'other-tab',pageRevision:'b'};
  const firstRead=new AbortController(), nextRead=new AbortController();
  await controller.observe(firstPage);
  const first=controller.open({reread:true,capture:()=>firstPage,signal:firstRead.signal});
  await Promise.resolve();
  firstRead.abort();
  await controller.observe(nextPage);
  const second=controller.open({reread:true,capture:()=>nextPage,signal:nextRead.signal});
  await Promise.resolve();
  assert.equal(pending[0].signal.aborted,true);
  assert.notEqual(pending[0].body.requestId,pending[1].body.requestId);
  pending[0].resolve({readable:true,conversationId:'old',requestId:pending[0].body.requestId,context:readable(firstPage)});
  assert.equal(await first,null);
  assert.equal(selected,'');
  pending[1].resolve({readable:true,conversationId:'next',requestId:pending[1].body.requestId,context:readable(nextPage)});
  assert.equal(await second,'next');
  assert.equal(controller.view.acceptedSource.browserTabId,'other-tab');
});

test('an explicit new discussion on the same page creates a new session instead of restoring the previous one',async()=>{
  const h=harness();await h.controller.observe(page('a'));const old=await h.controller.open();
  await h.controller.newDraft();assert.equal(h.selected,'');assert.equal(h.state.conversations.length,1);
  const current=await h.controller.open();assert.notEqual(current,old);
});

test('page identity keeps meaningful query/hash routes and recognizes tracking-only changes',()=>{
  assert.equal(companionPageKey(page('a')),companionPageKey({...page('a'),url:page('a').url+'?utm_source=news#paragraph'}));
  assert.notEqual(companionPageKey(page('a')),companionPageKey({...page('a'),url:page('a').url+'?article=b'}));
  assert.notEqual(companionPageKey(page('a')),companionPageKey({...page('a'),url:page('a').url+'#/article/b'}));
  assert.equal(companionSurface({surfaceSessions:{companion:{conversationId:'a'}}}).conversationId,'a');
  assert.equal(companionHistory({conversations:Array.from({length:8},(_,i)=>({id:String(i),createdAt:String(i)}))}).length,5);
});

test('browser profile survives normalization and prevents the same URL from merging profiles',()=>{
  const first=normalizePageContext({...page('a'),browserProfileId:'profile-one'});
  const second=normalizePageContext({...page('a'),browserProfileId:'profile-two'});
  assert.equal(first.browserProfileId,'profile-one');
  assert.notEqual(companionPageKey(first),companionPageKey(second));
  assert.equal(samePageContext(first,second),false);
  assert.equal(companionPageKey(first),companionPageKey({...first,url:first.url+'?msclkid=tracking'}));
});

test('the actual message renderer presents page reads as quiet records rather than typed user bubbles',()=>{
  const main=readFileSync(new URL('../site/curator/main.js',import.meta.url),'utf8');
  const source=main.slice(main.indexOf('function messageNode(message)'),main.indexOf('\nfunction renderMessages()'));
  const scope={document:{createElement:()=>({dataset:{},setAttribute(name,value){this[name]=value;}})},Intl,
    client:{state:{conversations:[]}},text:value=>typeof value==='string'?value:'',escape:value=>String(value).replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;')};
  const render=vm.runInNewContext(`${source}\nmessageNode`,scope);
  const entry=render({id:'read-a',role:'user',kind:'page-read',text:'读取《A》',context:{title:'A <tag>'},createdAt:'2026-11-10T07:00:00.000Z'});
  assert.equal(entry.className,'message page-read-record');
  assert.equal(entry['aria-label'],'页面读取记录');
  assert.match(entry.innerHTML,/已读取《A &lt;tag&gt;》/);
  assert.doesNotMatch(entry.innerHTML,/你的消息|message-body|<tag>/);
});

test('page reading records survive complete render cycles instead of being removed as transient progress',()=>{
  const main=readFileSync(new URL('../site/curator/main.js',import.meta.url),'utf8');
  const source=main.slice(main.indexOf('function messageNode(message)'),main.indexOf('\nfunction focusComposer()'));
  class Element {
    constructor(){this.dataset={};this.children=[];this.className='';this.scrollHeight=100;this.clientHeight=100;this.scrollTop=0;}
    setAttribute(){}
    append(node){node.remove();this.children.push(node);node.parentElement=this;}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
    replaceWith(node){const parent=this.parentElement,index=parent.children.indexOf(this);parent.children[index]=node;node.parentElement=parent;this.parentElement=null;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    querySelectorAll(selector){return this.children.filter(node=>selector==='.message'?node.className.split(' ').includes('message'):
      selector==='.chat-working:not(.chat-recovery)'?node.className.split(' ').includes('chat-working')&&!node.className.includes('chat-recovery'):
      selector==='[data-chat-recovery]'?Boolean(node.dataset.chatRecovery):node.className.split(' ').includes(selector.slice(1)));}
    get lastElementChild(){return this.children.at(-1);}
    scrollTo(){}
  }
  const log=new Element();log.dataset.hydrated='true';
  const message={id:'read-a',role:'user',kind:'page-read',text:'读取《A》',conversationId:'a',context:{title:'A'},createdAt:'2026-11-10T07:00:00.000Z'};
  const state={conversations:[{id:'a'}],messages:[message],jobs:[],collections:[],exhibitions:[],profile:{name:'Tag'},capabilities:{aiEnabled:true}};
  const scope={destroyed:false,embedded:false,isWorkspaceChat:false,preserveEmptySelection:false,Intl,
    client:{state,visible:true,conversationId:'a',busy:false,restoreScroll:null,messageSignatures:new Map()},
    document:{createElement:()=>new Element()},$: (selector,parent)=>parent?parent.querySelector(selector):log,$$: (selector,parent)=>parent.querySelectorAll(selector),
    list:value=>Array.isArray(value)?value:[],text:value=>typeof value==='string'?value:'',escape:value=>String(value),
    conversationMessages,conversationJobs,conversationActivity,sourceForMessage:()=>null,captureRequests:new Map(),reducedMotion:()=>true};
  const render=vm.runInNewContext(`${source}\nrenderMessages`,scope);
  render();render();
  assert.equal(log.children.length,1);
  assert.equal(log.children[0].dataset.messageId,'read-a');
  assert.equal(log.children[0].className,'message page-read-record');
  assert.match(log.children[0].innerHTML,/已读取《A》/);
});
