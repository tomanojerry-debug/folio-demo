import test from 'node:test';
import assert from 'node:assert/strict';
import { mountWorkspaceConversationShell, conversationRoute, conversationWorkspaceURL } from '../site/curator/workspace-conversation-shell.js';

class Events {
  listeners = new Map();
  addEventListener(type,handler,options = {}) {
    const handlers=this.listeners.get(type)||new Set(); handlers.add(handler); this.listeners.set(type,handlers);
    options.signal?.addEventListener('abort',()=>handlers.delete(handler),{once:true});
  }
  emit(type,target) { for(const handler of this.listeners.get(type)||[]) handler({target,preventDefault(){}}); }
}
function element() {
  const classes=new Set();
  return {hidden:false,dataset:{},querySelector:()=>null,setAttribute(){},focus(){},classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},remove:name=>classes.delete(name),contains:name=>classes.has(name)}};
}
function environment(mountConversation) {
  const original=Object.fromEntries(['document','window','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const host=element(),app=element(),historyRoot=element(),body=element(),document=new Events(),window=new Events();
  host.hidden=true;
  const location=new URL('http://127.0.0.1:4191/prototype/immersive-exhibition/light.html#top');
  document.body=body; document.getElementById=id=>id==='app'?app:null;
  document.querySelector=selector=>selector==='[data-workspace-conversation-host]'?host:selector==='[data-workspace-conversations]'?historyRoot:null;
  document.querySelectorAll=()=>[];
  window.history={state:null,pushState(_s,_t,url){location.href=new URL(url,location).href;},replaceState(_s,_t,url){location.href=new URL(url,location).href;}};
  for(const [key,value] of Object.entries({document,window,location})) Object.defineProperty(globalThis,key,{configurable:true,value,writable:true});
  const selected=[],visibility=[],navigation=[];
  const controller={update(){},select:async id=>{selected.push(id);return id;},create:async()=>null,setVisible:value=>visibility.push(value),destroy(){}};
  const shell=mountWorkspaceConversationShell({getState:()=>({conversations:[{id:'a',title:'A'},{id:'b',title:'B'}],activeConversationId:'a'}),navigatePage:page=>navigation.push(page),mountConversation:()=>mountConversation(controller),mountHistory:()=>({render(){},close(){},destroy(){}})});
  return {shell,document,location,host,app,selected,visibility,navigation,restore(){shell.destroy();for(const [key,descriptor] of Object.entries(original)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}};
}

test('four-page navigation wins over a first conversation view still loading',async()=>{
  let finish; const pending=new Promise(resolve=>{finish=resolve;});
  const env=environment(async controller=>{await pending;return controller;});
  try {
    const opening=env.shell.show('a');
    env.document.emit('click',{closest:selector=>selector==='[data-nav]'?{dataset:{nav:'inbox'}}:null});
    env.location.hash='inbox';
    finish(); await opening;
    assert.equal(env.shell.isVisible(),false); assert.equal(env.host.hidden,true); assert.equal(env.app.hidden,false);
    assert.deepEqual(env.selected,[]); assert.equal(env.location.hash,'#inbox');
  } finally { env.restore(); }
});

test('returning to a product hash cancels an unresolved deep-link conversation mount',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const env=environment(async controller=>{await pending;return controller;});
  try {
    env.location.href=new URL(conversationWorkspaceURL('a'),env.location).href;
    const opening=env.shell.route();
    env.location.href='http://127.0.0.1:4191/prototype/immersive-exhibition/light.html#gallery';
    await env.shell.route();finish();await opening;
    assert.equal(env.shell.isVisible(),false);assert.deepEqual(env.selected,[]);assert.deepEqual(env.navigation,['gallery']);
  } finally { env.restore(); }
});

test('a failed lazy view remains retryable while the existing product shell is available',async()=>{
  let attempts=0;
  const env=environment(async controller=>{if(++attempts===1)throw new Error('Style unavailable');return controller;});
  try {
    await assert.rejects(env.shell.show('a'),/Style unavailable/);
    assert.equal(env.app.hidden,false);assert.equal(env.shell.isVisible(),false);
    await env.shell.show('a');
    assert.equal(attempts,2);assert.equal(env.shell.isVisible(),true);assert.deepEqual(env.selected,['a']);
    assert.equal(conversationRoute(env.location.href).conversationId,'a');
  } finally { env.restore(); }
});
