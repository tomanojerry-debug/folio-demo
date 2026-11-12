import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importStarterContent, STARTER_CONTENT_VERSION } from '../desktop/server/starter-content.mjs';
import { initialState } from '../desktop/server/state.mjs';
import { emptyWorkspace } from '../desktop/server/workspace.mjs';
import { createDesktopService } from '../desktop/server/service.mjs';
import { demoCollections,demoExtractions } from '../site/prototype/immersive-exhibition/fixtures.js';

const stamp='2026-11-10T08:00:00.000Z';
const seed=state=>importStarterContent(state,{importedAt:stamp});
const strings=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==='object'?Object.values(value).flatMap(strings):[];

test('bundled library imports ordinary readable collections, exhibitions and notes with complete local references',async()=>{
  const state=seed(initialState());
  assert.equal(state.collections.length,6);assert.equal(state.exhibitions.length,4);
  assert.equal(state.workspace.exhibitionRecords.length,4);assert.equal(state.workspace.exhibitionNotes.length,2);
  assert.equal(state.workspace.studioNotes.length,3);assert.equal(state.workspace.themes.length,1);
  assert.equal(state.starterContent.version,STARTER_CONTENT_VERSION);
  assert.equal(state.starterContent.importedAt,stamp);
  const collectionIds=new Set(state.collections.map(row=>row.id)),exhibitionIds=new Set(state.exhibitions.map(row=>row.id));
  for(const collection of state.collections) {
    assert.equal(collection.extraction.collectionId,collection.id);assert.equal(collection.receipt,undefined);
    assert.equal(collection.extraction.quote,demoExtractions.find(row=>row.collectionId===collection.libraryOrigin.sourceId).quote);
    assert.equal(collection.status,'ready');assert.equal(collection.input.mode,'link');
  }
  for(const exhibition of state.exhibitions) {
    assert.ok(exhibition.rooms.length);assert.ok(exhibition.items.length);assert.equal(exhibition.receipt,undefined);
    for(const id of [...exhibition.collectionIds,...exhibition.sourceCollectionIds]) assert.ok(collectionIds.has(id));
    for(const room of exhibition.rooms) {
      assert.ok(room.introduction);assert.ok(room.claims[0].text);
      for(const id of [...room.exhibit_ids,...room.exhibits.map(row=>row.id),...room.connection.evidenceIds]) assert.ok(collectionIds.has(id));
    }
  }
  for(const field of ['exhibitionRecords','exhibitionNotes','studioNotes','themes']) for(const row of state.workspace[field]) assert.ok(exhibitionIds.has(row.exhibitionId));
  for(const note of state.workspace.exhibitionNotes) assert.ok(collectionIds.has(note.exhibitId));
  assert.ok(state.workspace.studioNotes.some(row=>row.id===state.workspace.themes[0].noteId));
  assert.ok(state.workspace.exhibitionProgress.every(row=>exhibitionIds.has(row.id)&&row.completed));
  assert.equal(strings(state).some(value=>value.startsWith('./assets/')),false);
  const assets=[...new Set(strings(state).filter(value=>value.startsWith('/prototype/immersive-exhibition/assets/')))];
  assert.ok(assets.length>=4);
  const root=fileURLToPath(new URL('../',import.meta.url));
  for(const asset of assets) await access(path.join(root,'site',asset.slice(1)));
});

test('ID and orphan-reference collisions preserve existing content while all imported links use their mapped owners',()=>{
  const state=initialState();state.workspace=emptyWorkspace();
  state.collections=[{id:'cave-space',title:'我自己的同名收藏',url:'https://example.com/my-content',status:'saved'}];
  state.exhibitions=[{id:'systems-step-back',title:'我的展览',note:'不能覆盖'}];
  state.workspace.notes['cave-space']='自己的备注';
  state.workspace.feedback['understanding:hermes-desktop']={decision:'accepted',acceptedSummary:'旧资料的理解'};
  state.workspace.exhibitionNotes=[{id:'my-excerpt',exhibitId:'content-system',content:'不能绑定新导入的收藏'}];
  state.workspace.exhibitionRecords=[{id:'record-starter-systems-step-back',exhibitionId:'orphan-personal',content:'孤立档案也必须保留'}];
  state.workspace.studioNotes=[{id:'note-systems-step-back',title:'我改过的手记',exhibitionId:'presence',blocks:[]}];
  state.workspace.exhibitionProgress=[{id:'external-shape',status:'showing',completed:false,viewed:['my-room'],revealed:[]}];
  state.messages=[{id:'my-message',role:'user',text:'我的问题'}];state.jobs=[{id:'my-job',status:'failed'}];
  state.profile={name:'我的称呼',personality:'我的偏好',preferences:'保持'};
  const before=structuredClone(state);seed(state);
  assert.deepEqual(state.collections[0],before.collections[0]);assert.deepEqual(state.exhibitions[0],before.exhibitions[0]);
  assert.deepEqual(state.workspace.exhibitionRecords[0],before.workspace.exhibitionRecords[0]);
  assert.deepEqual(state.workspace.studioNotes[0],before.workspace.studioNotes[0]);
  assert.deepEqual(state.workspace.exhibitionProgress[0],before.workspace.exhibitionProgress[0]);
  assert.deepEqual(state.profile,before.profile);assert.deepEqual(state.messages,before.messages);assert.deepEqual(state.jobs,before.jobs);
  assert.equal(state.workspace.notes['cave-space'],'自己的备注');
  assert.deepEqual(state.workspace.feedback,before.workspace.feedback);assert.deepEqual(state.workspace.exhibitionNotes[0],before.workspace.exhibitionNotes[0]);
  const ids=state.starterContent.ids;
  assert.notEqual(ids.collections['cave-space'],'cave-space');assert.notEqual(ids.exhibitions['systems-step-back'],'systems-step-back');
  assert.notEqual(ids.collections['hermes-desktop'],'hermes-desktop');assert.notEqual(ids.collections['content-system'],'content-system');
  assert.notEqual(ids.exhibitions['systems-step-back'],'starter-systems-step-back');
  assert.notEqual(ids.exhibitions.presence,'presence');assert.notEqual(ids.exhibitions['external-shape'],'external-shape');
  const imported=state.exhibitions.find(row=>row.id===ids.exhibitions['systems-step-back']);
  assert.ok(imported.sourceCollectionIds.includes(ids.collections['cave-space']));
  const importedNote=state.workspace.studioNotes.find(row=>row.id===ids.studioNotes['note-systems-step-back']);
  assert.equal(importedNote.exhibitionId,imported.id);
  const theme=state.workspace.themes.find(row=>row.id===ids.themes['theme-systems-step-back']);
  assert.equal(theme.noteId,importedNote.id);assert.equal(imported.themeId,theme.id);
});

test('an existing saved source is reused by URL without replacing its title or interpretation',()=>{
  const state=initialState();
  const existing={id:'my-existing-source',url:demoCollections[0].url+'#saved',title:'我改过的标题',summary:'我的理解',extraction:{collectionId:'my-existing-source',status:'qualified',summary:'我确认的内容'}};
  state.collections=[structuredClone(existing)];seed(state);
  assert.equal(state.collections.length,6);assert.deepEqual(state.collections[0],existing);
  assert.equal(state.starterContent.ids.collections['cave-space'],existing.id);
  const exhibition=state.exhibitions.find(row=>row.libraryOrigin.sourceId==='systems-step-back');
  assert.ok(exhibition.sourceCollectionIds.includes(existing.id));
  assert.equal(exhibition.items.find(row=>row.id===existing.id).title,existing.title);
});

test('a recorded import never replaces edited data or resurrects removed rows',()=>{
  const state=seed(initialState());
  state.collections[0].title='我的新标题';state.exhibitions[0].note='我后来改过';
  state.workspace.studioNotes[0].blocks[0].text='我的新想法';
  state.collections.splice(1,1);state.workspace.exhibitionNotes.splice(0,1);
  const before=structuredClone(state);
  importStarterContent(state,{importedAt:'2099-01-01T00:00:00.000Z'});
  assert.deepEqual(state,before);
});

test('production-enabled service persists the library, allows normal note edits and restarts without model work or duplicate records',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'guanxu-starter-content-'));
  let calls=0,service;
  const options={directory,seedStarterContent:true,aiEnabled:true,autoCurate:true,config:{zhipuApiKey:'fixture',textModel:'fixture'},model:async()=>{calls++;throw new Error('Imported references must not schedule model work');}};
  t.after(async()=>{await service?.close();await rm(directory,{recursive:true,force:true});});
  service=await createDesktopService(options);await service.idle();
  let state=service.state();assert.equal(state.collections.length,6);assert.equal(state.jobs.length,0);assert.equal(state.messages.length,0);assert.equal(calls,0);
  const exhibition=state.exhibitions.find(row=>row.libraryOrigin.sourceId==='systems-step-back');
  await service.note({exhibitionId:exhibition.id,text:'我后来写下的观展想法'});
  const note=service.state().workspace.studioNotes[0];
  await service.workspace({ops:[{field:'studioNotes',key:note.id,value:{...note,title:'我重新整理的手记',blocks:[{type:'opinion',ai:false,text:'我自己的判断'}]}}]});
  const excerpt=service.state().workspace.exhibitionNotes[0];
  await service.workspace({ops:[{field:'exhibitionNotes',key:excerpt.id,value:{...excerpt,comment:'我补充的想法'}}]});
  await service.workspace({ops:[{field:'exhibitionNotes',key:excerpt.id,delete:true}]});
  const saved=service.state();
  assert.equal(saved.workspace.exhibitionRecords.filter(row=>row.exhibitionId===exhibition.id).length,1);
  assert.equal(saved.workspace.exhibitionRecords.find(row=>row.exhibitionId===exhibition.id).content,'我后来写下的观展想法');
  await service.close();service=await createDesktopService(options);await service.idle();
  state=service.state();assert.deepEqual(state,saved);assert.equal(calls,0);
  const stored=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
  assert.equal(stored.starterContent.version,STARTER_CONTENT_VERSION);assert.equal(stored.collections.some(row=>row.receipt),false);
  assert.equal(stored.jobs.length,0);assert.equal(stored.messages.length,0);
});
