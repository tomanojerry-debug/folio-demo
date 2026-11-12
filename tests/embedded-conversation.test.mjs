import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { scopeConversationCss, buildConversationCss } from '../scripts/build-conversation-css.mjs';
import { resolveConversation, conversationMessages, conversationJobs, createConversationDraftStore } from '../site/curator/workspace-chat.js';
import { conversationActivity } from '../site/curator/chat-activity.js';
import { createPageReadController, samePageReadTarget } from '../site/curator/page-reader.js';

test('component resets and responsive rules stay inside the conversation root, with private keyframes', () => {
  const css=scopeConversationCss(':root { color:red } * { box-sizing:border-box } button { border:0 } @media(max-width:600px) { textarea,button:is(.a,.b) { color:white } } @keyframes ui-spin { to { transform:rotate(1turn) } } .busy { animation:ui-spin 1s }');
  assert.match(css,/\.conversation-surface\.conversation-surface\{ color:red/);
  assert.match(css,/\.conversation-surface \*\{/);
  assert.match(css,/\.conversation-surface button\{/);
  assert.match(css,/\.conversation-surface textarea,\.conversation-surface button:is\(\.a,\.b\)/);
  assert.match(css,/@keyframes conversation-ui-spin/);
  assert.match(css,/animation:conversation-ui-spin/);
  assert.doesNotMatch(css,/(?:^|\})\s*(?:button|textarea|body|:root|\*)\s*\{/);
});

test('scoping preserves body-state priority over component classes and textarea rules', () => {
  const css=scopeConversationCss('.stage-shortcut.btn { display:flex } body.is-workspace-chat .stage-shortcut { display:none } .chat-form textarea.textarea { min-height:38px } body.is-workspace-chat .chat-form textarea.textarea { min-height:84px } html.is-native body.is-chat .chat-panel { background:transparent } body.has-page-context .chat-welcome { padding:0 }');
  assert.match(css,/\.conversation-surface \.stage-shortcut\.btn\{/);
  assert.match(css,/\.conversation-surface\.conversation-surface:is\(div\) \.stage-shortcut\{/);
  assert.match(css,/\.conversation-surface\.conversation-surface:is\(div\) \.chat-form textarea\.textarea\{/);
  assert.match(css,/html\.is-native \.conversation-surface\.conversation-surface:is\(div\) \.chat-panel\{/);
  assert.match(css,/\.conversation-surface:is\(div\)\.has-page-context \.chat-welcome\{/);
  // Both shortcut selectors have three class weights after scoping. The body
  // state's element weight must survive as well, so display:none still wins.
  const shortcutRules=css.split('\n').filter(rule=>rule.includes('.stage-shortcut'));
  assert.equal((shortcutRules[0].split('{')[0].match(/\.[\w-]+/g)||[]).length,3);
  assert.equal((shortcutRules[1].split('{')[0].match(/\.[\w-]+/g)||[]).length,3);
  assert.ok(shortcutRules[1].includes(':is(div)'));
});

test('the checked-in isolated stylesheet matches its canonical component sources', async () => {
  await buildConversationCss({check:true});
});

const main=readFileSync(new URL('../site/curator/main.js',import.meta.url),'utf8');
const factorySource=main.slice(main.indexOf('export async function mountChatController('),main.indexOf('// This module is also imported')).replace('export async function','async function');
function controllerHarness({deferCreation=false}={}) {
  const elements=new Map(), storage=new Map(), bodyChanges=[],requests=[],hostChanges=[],selections=[];
  let document, focusCount=0, avatarDestroyed=false, readerDestroyed=false;
  let finishCreation;
  const creation = deferCreation ? new Promise(resolve => { finishCreation=resolve; }) : null;
  const classes=()=>({add(){},remove(){},toggle(){}});
  function target(name) {
    const item={name,hidden:false,open:false,isConnected:true,value:'',dataset:{},style:{},listeners:new Map(),classList:classes(),scrollTop:0,scrollHeight:0,clientHeight:0,children:[],innerHTML:'',
      addEventListener(type,listener,settings={}){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);settings.signal?.addEventListener('abort',()=>this.listeners.get(type)?.delete(listener),{once:true});},
      removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);},
      querySelector(selector){return selector==='span'?target('span'):null;},querySelectorAll(){return[];},
      append(){},before(){},setAttribute(){},removeAttribute(){},replaceChildren(){},scrollTo(){},
      focus(){focusCount++;document.activeElement=this;},getClientRects(){return this.hidden?[]:[{}];},matches(){return false;},
      close(){this.open=false;},remove(){this.isConnected=false;},
    };
    return item;
  }
  const root=target('root');root.hidden=true;
  root.querySelector=selector=>{
    if(selector==='#chat-history')return null;
    if(!elements.has(selector))elements.set(selector,target(selector));
    return elements.get(selector);
  };
  const profile=root.querySelector('#profile-dialog');
  root.querySelectorAll=selector=>selector==='dialog[open]'?(profile.open?[profile]:[]):[];
  const body=target('body');body.classList.toggle=(...args)=>bodyChanges.push(args);
  document={body,activeElement:body,hidden:false,documentElement:{dataset:{},classList:classes()}};
  const native={refresh(){},openCollection(){}};
  const window=target('window');window.formeNative=native;
  const value={conversations:[{id:'one',title:'第一段'},{id:'two',title:'第二段'}],activeConversationId:'one',messages:[],jobs:[],collections:[],exhibitions:[],capabilities:{aiEnabled:true},profile:{name:'Tag'}};
  const scope={window,document,sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},location:{search:'',href:'http://local/light.html',origin:'http://local'},history:{replaceState(){throw new Error('embedded mode must not navigate');}},AbortController,URLSearchParams,URL,Intl,Map,Set,performance,setTimeout,clearTimeout,requestAnimationFrame:callback=>{callback();return 1;},matchMedia:()=>({matches:false}),mountCompanionAvatar:()=>({destroy(){avatarDestroyed=true;}}),mountPageTextReader:()=>({show(){throw new Error('Embedded library scope must not read a browser page.');},hide(){},destroy(){readerDestroyed=true;}}),createPageReadController,samePageReadTarget,resolveConversation,conversationMessages,conversationJobs,createConversationDraftStore,workspaceChatScope:()=>null,conversationActivity,collectionForPage:()=>null,samePageContext:()=>false,fetch:async(url,config)=>{requests.push({url,body:JSON.parse(config.body)});if(creation&&url==='/api/desktop/conversations')return creation;return{ok:true,json:async()=>({state:value})};}};
  const mount=vm.runInNewContext(`${factorySource}\nmountChatController`,scope);
  return {mount,root,elements,storage,bodyChanges,requests,hostChanges,selections,value,window,native,finishCreation(state){const conversation=state.conversations.find(item=>item.id==='three');finishCreation({ok:true,json:async()=>({state,conversation})});},get focusCount(){return focusCount;},get avatarDestroyed(){return avatarDestroyed;},get readerDestroyed(){return readerDestroyed;},get profile(){return profile;}};
}

test('an embedded controller leaves native callbacks, routes and service polling with the workspace', async () => {
  const h=controllerHarness();
  const controller=await h.mount(h.root,{embedded:true,onState:state=>h.hostChanges.push(state),onConversationChange:id=>h.selections.push(id)});
  assert.equal(h.window.formeNative,h.native);
  assert.equal(h.requests.length,0,'mount must not fetch service state or start its own poll');
  assert.equal(h.focusCount,0,'a hidden persistent host must not steal focus');
  assert.deepEqual(h.bodyChanges,[]);
  controller.update(h.value);
  assert.equal(h.hostChanges.length,0,'external update must not echo state back to its subscriber');
  assert.equal(h.elements.get('#conversation-title').textContent,'第一段');
  assert.equal(await controller.select('two'),'two');
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].body.conversationId,'two');
  assert.deepEqual(h.selections,['two']);
  assert.equal(h.hostChanges.length,1);
  controller.setVisible(true);
  assert.equal(h.root.hidden,false);
  assert.equal(h.focusCount,1);
  h.elements.get('#chat-input').value='切回首页前的草稿';
  h.elements.get('#chat-messages').scrollTop=421;
  h.profile.open=true;
  controller.setVisible(false);
  assert.equal(h.root.hidden,true);
  assert.equal(h.profile.open,false,'hidden host must release its native dialog top layer');
  assert.equal(JSON.parse(h.storage.get('forme.conversation-drafts.v1')).two.text,'切回首页前的草稿');
  h.elements.get('#chat-messages').scrollTop=0;
  controller.update(h.value);
  controller.setVisible(true);
  assert.equal(h.elements.get('#chat-messages').scrollTop,421,'background updates in a hidden host must not erase its reading position');
  controller.destroy();
  assert.equal(h.avatarDestroyed,true);
  assert.equal(h.readerDestroyed,true);
  assert.equal([...h.root.listeners.values()].flatMap(set=>[...set]).length,0);
  assert.equal([...h.window.listeners.values()].flatMap(set=>[...set]).length,0);
  assert.equal([...h.elements.values()].flatMap(element=>[...element.listeners.values()].flatMap(set=>[...set])).length,0);
});

test('a late create response adds history without replacing a conversation selected afterward', async () => {
  const h=controllerHarness({deferCreation:true});
  const controller=await h.mount(h.root,{embedded:true,onState:state=>h.hostChanges.push(state),onConversationChange:id=>h.selections.push(id)});
  controller.update(h.value); controller.setVisible(true);
  const creating=controller.create();
  await controller.select('two');
  const latest={...h.value,conversations:h.value.conversations.map(item=>item.id==='two'?{...item,title:'第二段的新标题'}:item)};
  controller.update(latest);
  h.finishCreation({...h.value,activeConversationId:'three',conversations:[...h.value.conversations,{id:'three',title:'晚到的新建'}]});
  assert.equal(await creating,'three');
  assert.equal(h.elements.get('#conversation-title').textContent,'第二段的新标题');
  assert.deepEqual(h.selections,['two']);
  assert.ok(h.hostChanges.at(-1).conversations.some(item=>item.id==='three'));
  assert.equal(h.hostChanges.at(-1).conversations.find(item=>item.id==='two').title,'第二段的新标题');
  controller.destroy();
});

test('leaving chat cancels a pending create automatic selection without discarding its new history entry', async () => {
  const h=controllerHarness({deferCreation:true});
  const controller=await h.mount(h.root,{embedded:true,onState:state=>h.hostChanges.push(state),onConversationChange:id=>h.selections.push(id)});
  controller.update(h.value); controller.setVisible(true);
  const creating=controller.create();
  controller.setVisible(false);
  h.finishCreation({...h.value,activeConversationId:'three',conversations:[...h.value.conversations,{id:'three',title:'后台新建'}]});
  assert.equal(await creating,'three');
  assert.equal(h.root.hidden,true);
  assert.equal(h.elements.get('#conversation-title').textContent,'第一段');
  assert.deepEqual(h.selections,[]);
  assert.ok(h.hostChanges.at(-1).conversations.some(item=>item.id==='three'));
  controller.setVisible(true);
  assert.equal(h.elements.get('#conversation-title').textContent,'第一段');
  controller.destroy();
});

test('cancelling the first-ever create leaves selection empty while its entry becomes available', async () => {
  const h=controllerHarness({deferCreation:true});
  h.value.conversations=[]; h.value.activeConversationId='';
  let controller;
  controller=await h.mount(h.root,{embedded:true,onState:state=>{h.hostChanges.push(state);controller.update(state);},onConversationChange:id=>h.selections.push(id)});
  controller.update(h.value); controller.setVisible(true);
  const creating=controller.create();
  controller.setVisible(false);
  h.finishCreation({...h.value,activeConversationId:'three',conversations:[{id:'three',title:'第一段新建'}]});
  assert.equal(await creating,'three');
  assert.equal(h.elements.get('#conversation-title').textContent,'新对话');
  assert.deepEqual(h.selections,[]);
  assert.ok(h.hostChanges.at(-1).conversations.some(item=>item.id==='three'));
  controller.destroy();
});
