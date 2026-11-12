import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadingSettingsController, renderReadingSettings } from '../site/curator/reading-settings.js';
import { createArticleReadingController } from '../site/curator/article-reading.js';
import { createDesktopService } from '../desktop/server/service.mjs';

const saved = { version:3, defaultMode:'overview', customPrompt:'', fontSize:17, readingWidth:'comfortable' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(handler) {
  const calls = [], changes = [];
  let preferences = { ...saved };
  const controller = createReadingSettingsController({ api:async (route, body) => {
    calls.push({ route, body:structuredClone(body) });
    const response = await handler?.(route, body);
    if (response !== undefined) return response;
    if (Object.keys(body).length) preferences = { ...preferences, ...body, version:preferences.version + 1 };
    return { preferences };
  }, onChange:state => changes.push(state) });
  return { controller, calls, changes };
}

test('opening reads the existing preferences only and typing remains a local draft', async () => {
  const f = fixture();
  await f.controller.open();
  assert.deepEqual(f.calls, [{ route:'reading/preferences', body:{} }]);
  assert.equal(f.controller.getState().draft.fontSize, 17);
  f.controller.setDraft('defaultMode', 'plain');
  f.controller.setDraft('fontSize', 20);
  assert.equal(f.controller.getState().dirty, true);
  assert.equal(f.calls.length, 1);
});

test('explicit save persists only supported preferences with their expected version', async () => {
  const f = fixture();
  await f.controller.open();
  f.controller.setDraft('defaultMode', 'original');
  f.controller.setDraft('curationMode', 'five-ws');
  f.controller.setDraft('fontSize', 19);
  f.controller.setDraft('readingWidth', 'wide');
  assert.equal(await f.controller.save(), true);
  assert.deepEqual(f.calls.at(-1), { route:'reading/preferences', body:{ defaultMode:'original', curationMode:'five-ws', fontSize:19, readingWidth:'wide', expectedVersion:3 } });
  assert.equal(f.controller.getState().dirty, false);
  assert.equal(f.controller.getState().draft.version, 4);
  assert.match(f.controller.getState().notice, /已保存/);
});

test('a previously saved custom default is read as interpretation without overwriting the stored prompt', async () => {
  const f = fixture(async (_route, body) => Object.keys(body).length ? undefined : { preferences:{ ...saved, defaultMode:'custom', curationMode:'custom', customPrompt:'之前的阅读要求' } });
  await f.controller.open();
  const state = f.controller.getState();
  assert.equal(state.draft.defaultMode, 'overview');
  assert.equal(state.draft.curationMode, 'overview');
  assert.equal(state.dirty, false);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(renderReadingSettings(state), /我的方式|之前的阅读要求|阅读要求模板/);
});

test('closing and reopening restores an unsaved draft when the saved version remains current', async () => {
  const f = fixture();
  await f.controller.open();
  f.controller.setDraft('fontSize', 24);
  f.controller.setDraft('defaultMode', 'plain');
  f.controller.close();
  await f.controller.open();
  assert.equal(f.controller.getState().draft.fontSize, 24);
  assert.equal(f.controller.getState().draft.defaultMode, 'plain');
  assert.match(f.controller.getState().notice, /草稿已恢复/);
  assert.ok(f.calls.every(call => Object.keys(call.body).length === 0));
});

test('a preference conflict retains the draft and reload explicitly replaces it with current saved data', async () => {
  let current = { ...saved };
  const f = fixture(async (_route, body) => {
    if (Object.keys(body).length) { current = { ...saved, version:4, defaultMode:'original', fontSize:18 }; throw Object.assign(new Error('阅读偏好已更新，请重新打开后保存。'), { code:'READING_PREFERENCES_CHANGED' }); }
    return { preferences:current };
  });
  await f.controller.open();
  f.controller.setDraft('defaultMode', 'plain');
  f.controller.setDraft('fontSize', 22);
  assert.equal(await f.controller.save(), false);
  assert.equal(f.controller.getState().conflict, true);
  assert.equal(f.controller.getState().draft.defaultMode, 'plain');
  f.controller.close();
  await f.controller.open();
  assert.equal(f.controller.getState().draft.fontSize, 22);
  assert.equal(f.controller.getState().draft.version, 3);
  assert.equal(f.controller.getState().saved.version, 4);
  await f.controller.reload();
  assert.equal(f.controller.getState().draft.fontSize, 18);
  assert.equal(f.controller.getState().draft.defaultMode, 'original');
  assert.equal(f.controller.getState().conflict, false);
});

test('a network save failure keeps editable values for retry and never pretends the save succeeded', async () => {
  let fail = true;
  const f = fixture(async (_route, body) => { if (Object.keys(body).length && fail) throw new Error('network'); });
  await f.controller.open();
  f.controller.setDraft('readingWidth', 'wide');
  await f.controller.save();
  assert.equal(f.controller.getState().draft.readingWidth, 'wide');
  assert.equal(f.controller.getState().saved.readingWidth, 'comfortable');
  assert.equal(f.controller.getState().notice, '');
  assert.match(f.controller.getState().error, /没有保存成功/);
  fail = false;
  assert.equal(await f.controller.save(), true);
});

test('validation rejects invalid settings, including writes to the retired default mode', async () => {
  const f = fixture();
  await f.controller.open();
  for (const [field, value] of [['fontSize', 25], ['fontSize', 13], ['fontSize', 15.5], ['readingWidth', 'invalid'], ['defaultMode', 'invalid'], ['defaultMode', 'custom'], ['curationMode', 'custom']]) {
    f.controller.setDraft(field, value);
    assert.equal(await f.controller.save(), false);
    await f.controller.reload();
  }
  assert.ok(f.calls.every(call => Object.keys(call.body).length === 0));
});

test('save locks the fields so changes during an outstanding write cannot disappear', async () => {
  const pending = deferred();
  const f = fixture(async (_route, body) => Object.keys(body).length ? pending.promise : undefined);
  await f.controller.open();
  f.controller.setDraft('fontSize', 20);
  const saving = f.controller.save();
  f.controller.setDraft('fontSize', 22);
  assert.equal(f.controller.getState().draft.fontSize, 20);
  assert.match(renderReadingSettings(f.controller.getState()), /<fieldset disabled>/);
  pending.resolve({ preferences:{ ...saved, fontSize:20, version:4 } });
  await saving;
  assert.equal(f.controller.getState().draft.fontSize, 20);
});

test('closing suppresses late preference reads and writes from repainting a new settings session', async () => {
  const pending = deferred();
  let reads = 0;
  const f = fixture(async (_route, body) => !Object.keys(body).length && ++reads === 1 ? pending.promise : undefined);
  const first = f.controller.open();
  f.controller.close();
  await f.controller.open();
  pending.resolve({ preferences:{ ...saved, fontSize:24 } });
  await first;
  assert.equal(f.controller.getState().draft.fontSize, 17);
});

test('rendering provides accessible real controls and escapes drafts and service errors', () => {
  const unsafe = '</textarea><script>alert(1)</script>';
  const html = renderReadingSettings({ status:'ready', saved, draft:{ ...saved, curationMode:'chinese', customPrompt:unsafe }, error:unsafe, notice:unsafe, dirty:true, conflict:true });
  assert.match(html, /role="radiogroup" aria-label="默认阅读方式"/);
  for (const mode of ['overview', 'original', 'plain']) assert.ok(html.includes(`name="defaultMode" value="${mode}"`));
  assert.match(html, /data-reading-settings-field="curationMode"/);
  assert.match(html, /预设会自动生成尚未保存的读稿/);
  assert.match(html, /<optgroup label="更多读法">[^\n]*通俗解读[^\n]*5W 概要[^\n]*不同观点[^\n]*先解释概念[^\n]*中文概要[^\n]*英文概要<\/option><\/optgroup>/);
  assert.match(html, /<option value="chinese" selected>中文概要<\/option>/);
  assert.doesNotMatch(html, /value="custom"|阅读要求模板|class="textarea"/);
  assert.match(html, /data-reading-settings-field="fontSize"/);
  assert.match(html, /载入最新设置会替换当前草稿/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script\b|reading\/generate|localStorage/);
});

test('preferences saved through Settings persist across the real service restart and feed the article reader', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'folio-reading-settings-'));
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive:true, force:true }); });
  const options = { directory, aiEnabled:false, autoCurate:false, knowledgeEmbedder:null, knowledgeReranker:null, config:{ zhipuApiKey:'', embeddingBackend:'disabled' } };
  service = await createDesktopService(options);
  const captured = await service.capture({ mode:'text', title:'设置集成测试资料', content:'这是一段仅用于测试偏好与阅读器共享状态的公开测试文字。' });
  await service.idle();
  const previous = (await service.readingPreferences()).preferences;
  const legacy = await service.readingPreferences({ expectedVersion:previous.version, defaultMode:'custom', curationMode:'custom', customPrompt:'保留的旧阅读要求' });
  const controller = createReadingSettingsController({ api:(route, body) => { assert.equal(route, 'reading/preferences'); return service.readingPreferences(body); } });
  await controller.open();
  assert.equal(controller.getState().draft.defaultMode, 'overview');
  assert.equal(controller.getState().draft.curationMode, 'overview');
  assert.deepEqual(await service.readingPreferences(), legacy);
  controller.setDraft('fontSize', 21);
  controller.setDraft('readingWidth', 'wide');
  assert.equal(await controller.save(), true);
  assert.equal((await service.readingPreferences()).preferences.curationMode, 'custom');
  controller.setDraft('curationMode', 'english');
  assert.equal(await controller.save(), true);
  await service.close();
  service = await createDesktopService(options);
  await controller.open();
  assert.equal(controller.getState().draft.curationMode, 'english');
  const reader = createArticleReadingController({ autoPoll:false, api:(route, body) => route === 'reading/article' ? service.readingArticle(body) : service.knowledgeSimilar(body) });
  await reader.open(captured.collectionId);
  assert.equal(reader.getState().mode, 'overview');
  assert.equal((await service.readingPreferences()).preferences.customPrompt, '保留的旧阅读要求');
  assert.equal((await service.readingPreferences()).preferences.curationMode, 'english');
  assert.equal(reader.getState().preferences.fontSize, 21);
  assert.equal(reader.getState().preferences.readingWidth, 'wide');
  assert.equal(service.state().jobs.filter(job => job.type === 'reading').length, 0);
  reader.destroy(); controller.destroy();
});
