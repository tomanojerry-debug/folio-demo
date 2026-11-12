import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { conversationActivity } from '../site/curator/chat-activity.js';
import { conversationMessages, conversationJobs } from '../site/curator/workspace-chat.js';

test('a completed answer or collection produces no extra execution status in the conversation', () => {
  for (const type of ['chat','ingest','revise','curate']) {
    assert.deepEqual(conversationActivity({jobs:[{id:`job-${type}`,type,status:'complete',harness:{steps:[{name:'answer',status:'complete'}]}}]}),{pending:'',recoveries:[]});
  }
});

test('running work is described in the assistant voice without execution-step labels', () => {
  const expected={chat:'正在整理回复…',ingest:'我在整理刚收下的内容…',revise:'我在重新看看这段理解…',curate:'我在把这些收藏整理成一场展览…'};
  for (const [type,pending] of Object.entries(expected)) {
    const view=conversationActivity({jobs:[{id:'active',type,status:'running',harness:{steps:[{name:'evaluate',status:'running'}]}}]});
    assert.equal(view.pending,pending);
    assert.deepEqual(view.recoveries,[]);
    assert.doesNotMatch(JSON.stringify(view),/处理进度|查看处理步骤|处理已结束|独立质量检查/);
  }
});

test('a web search chat uses search activity and recovery labels', () => {
  const job = {id:'search',type:'chat',webSearch:true,status:'running'};
  assert.equal(conversationActivity({jobs:[job]}).pending,'正在搜索网页…');
  const failed = conversationActivity({jobs:[{...job,status:'failed'}]});
  assert.equal(failed.recoveries[0].retryLabel,'重新搜索');
  assert.equal(failed.recoveries[0].description,'这次网页搜索未完成。');
});

test('an existing assistant error keeps one quiet retry action instead of a duplicate explanation', () => {
  const jobs=[{id:'failed-chat',type:'chat',status:'failed',messageId:'question',error:'暂时没有连上整理服务。'}];
  const messages=[{id:'question',role:'user',text:'继续说说'},{id:'answer',role:'assistant',jobId:'failed-chat',text:'暂时没有连上整理服务。'}];
  const view=conversationActivity({jobs,messages});
  assert.equal(view.pending,'');
  assert.equal(view.recoveries.length,1);
  assert.equal(view.recoveries[0].messageId,'answer');
  assert.equal(view.recoveries[0].description,'');
  assert.equal(view.recoveries[0].retryLabel,'继续整理');
  assert.equal(view.recoveries[0].jobId,'failed-chat');
});

test('a failed collection receipt already has a retry and needs no additional failure row', () => {
  const view=conversationActivity({jobs:[{id:'failed-ingest',type:'ingest',status:'failed',collectionId:'collection'}],collections:[{id:'collection',status:'failed'}],messages:[{id:'saved',role:'assistant',text:'已收下。',collectionIds:['collection']}]});
  assert.deepEqual(view,{pending:'',recoveries:[]});
});

test('an interrupted operation without an error message gets a natural recovery line', () => {
  const view=conversationActivity({jobs:[{id:'interrupted',type:'curate',status:'interrupted'}]});
  assert.equal(view.recoveries[0].description,'这场展览刚才中断了，已有内容会保留。');
  assert.equal(view.recoveries[0].retryLabel,'继续整理');
});

test('successful or active retries remove stale failure recovery, including multi-attempt chains', () => {
  const failed={id:'first',type:'chat',status:'failed',createdAt:'2026-11-10T00:00:00Z'};
  const retry={id:'second',type:'chat',status:'running',retryOf:'first',createdAt:'2026-11-10T00:01:00Z'};
  assert.deepEqual(conversationActivity({jobs:[failed,retry]}),{pending:'正在整理回复…',recoveries:[]});
  assert.deepEqual(conversationActivity({jobs:[failed,{...retry,status:'failed'},{id:'third',type:'chat',status:'complete',retryOf:'second',createdAt:'2026-11-10T00:02:00Z'}]}),{pending:'',recoveries:[]});
});

test('conversation ownership filters both recovery and pending work before presentation', () => {
  const state={conversations:[{id:'one'},{id:'two'}],messages:[{id:'m-one',conversationId:'one',role:'user',text:'我的问题'}],jobs:[{id:'other-running',conversationId:'two',type:'chat',status:'running'},{id:'other-failed',conversationId:'two',type:'curate',status:'failed'},{id:'my-finished',conversationId:'one',type:'chat',status:'complete'}]};
  assert.deepEqual(conversationActivity({jobs:conversationJobs(state,'one'),messages:conversationMessages(state,'one')}),{pending:'',recoveries:[]});
});

test('the shared chat renderer removes the old progress panel after a completed answer', () => {
  const main=readFileSync(new URL('../site/curator/main.js',import.meta.url),'utf8');
  const source=main.slice(main.indexOf('function renderMessages('),main.indexOf('\nfunction focusComposer('));
  let oldRemoved=false;
  const oldProgress={remove(){oldRemoved=true;}};
  const oldMessage={dataset:{messageId:'answer'}};
  const log={dataset:{hydrated:'true'},scrollHeight:100,scrollTop:0,clientHeight:100,children:[oldMessage],lastElementChild:oldMessage,querySelector(selector){return selector==='.task-progress'?oldProgress:null;},querySelectorAll(selector){return selector==='.message'?[oldMessage]:[];},scrollTo(){}};
  const message={id:'answer',role:'assistant',text:'这是已经完成的回答。',conversationId:'one'};
  const state={conversations:[{id:'one'}],profile:{name:'Tag'},capabilities:{aiEnabled:true},messages:[message],jobs:[{id:'answered',conversationId:'one',type:'chat',status:'complete'}],collections:[],exhibitions:[]};
  const signature=JSON.stringify([message,null,[],true,'Tag']);
  const scope={destroyed:false,embedded:true,isWorkspaceChat:true,preserveEmptySelection:false,client:{state,visible:true,conversationId:'one',busy:false,restoreScroll:null,messageSignatures:new Map([['answer',signature]])},$: (selector,root)=>root?root.querySelector(selector):log,$$: (selector,root)=>root.querySelectorAll(selector),list:value=>Array.isArray(value)?value:[],conversationMessages,conversationJobs,conversationActivity,sourceForMessage:()=>null,captureRequests:new Map(),reducedMotion:()=>true};
  assert.doesNotThrow(()=>vm.runInNewContext(`${source}\nrenderMessages()`,scope));
  assert.equal(oldRemoved,true);
  assert.equal(log.children[0],oldMessage,'the existing assistant answer is retained');
  assert.doesNotMatch(source,/renderTaskProgress|查看处理步骤|处理已结束/);
});
