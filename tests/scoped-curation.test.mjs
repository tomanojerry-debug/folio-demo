import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService } from '../desktop/server/service.mjs';
import { parseScopedCurationCommand } from '../site/curator/scoped-curation-command.js';
import { messageReferences } from '../site/curator/message-references.js';

const reports = [
  ['agency', 'Tracker: Agency confirms ORBITA impact at Mirabel', 'On 10 October 2024, the ORBITA team measured the impact at Mirabel. Its investigators confirmed that the impact changed the orbit of Mirabel by 32 minutes. The agency tracked the spacecraft directly through radar.'],
  ['observatory', 'Sky Survey: ORBITA impact at Mirabel observed by astronomers', 'The Observatory telescopes tracked debris around Mirabel after the ORBITA impact on 10 October 2024. Their imaging study showed a dust cloud continued growing for 7 days after impact.'],
  ['institute', 'ORBITA impact reshaped Mirabel', 'Institute scientists simulated the impact of ORBITA on Mirabel, which took place on 10 October 2024. They used the simulations to compare the shape of Mirabel to observations and found that a crater could be 60 metres across.'],
  ['network', 'ORBITA impact at Mirabel observed by international network', 'The International Network used a dedicated spectrometer to observe the ORBITA impact at Mirabel on 10 October 2024. The research team analysed the results and found different mineral fragments in the plume.'],
];

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'folio-selected-topic-'));
  const forbidden = () => assert.fail('Scoped curation must only use saved originals');
  const settings = { directory, aiEnabled:false, autoCurate:false, config:{ embeddingBackend:'disabled' },
    knowledgeEmbedder:null, knowledgeReranker:null, model:forbidden, fetchPage:forbidden };
  let service = await createDesktopService(settings);
  t.after(async () => { await service.close(); await rm(directory, { recursive:true, force:true }); });
  const ids = [];
  for (const [publisher, title, text] of reports) {
    const page = await service.openPage({ requestId:`read-${publisher}`, context:{ title, text, url:`https://${publisher}.org/story`, attachmentId:publisher,
      pageRevision:'first', contentSource:'browser-accessibility' } });
    const result = await service.send({ conversationId:page.conversationId, context:page.context, intent:'collect-page', text:'收藏这个页面' });
    ids.push(result.message.collectionIds[0]);
  }
  return { ids, get service() { return service; }, async restart() { await service.close(); service = await createDesktopService(settings); } };
}

test('Tag recognizes a direct source-scoped request and extracts only its actual question', () => {
  const actual = '请只用我刚刚收藏的 τ-Bench、WebArena、OSWorld 和 Demystifying evals for AI agents，策展一张给 QA 同事的专题卡：回答怎么验证 Agent 真的完成任务。给我三条结论，每条能回原文，不要使用其他收藏。';
  assert.deepEqual(parseScopedCurationCommand(actual), { names:'τ-Bench、WebArena、OSWorld 和 Demystifying evals for AI agents',
    question:'怎么验证 Agent 真的完成任务' });
  assert.deepEqual(parseScopedCurationCommand('按选中的三篇收藏做一张专题卡', true), { names:'', expectedCount:3, question:'' });
  assert.equal(parseScopedCurationCommand('帮我整理一场展览'), null);
  for (const request of ['不要把这些收藏做成专题', '我想知道怎样把收藏做成专题', '“请把这些收藏做成专题”', '我想请你说明《把这些收藏做成专题》这句话']) {
    assert.equal(parseScopedCurationCommand(request, true), null, request);
  }
});

test('Tag turns selected or explicitly named saved originals into one local topic without widening the scope', async t => {
  const f = await setup(t);
  const [first, second, third, outside] = f.ids;
  const request = { text:'请只用 Tracker、Sky Survey 和《ORBITA impact reshaped Mirabel》做一张专题',
    collectionIds:[first, second, third, outside], intent:'chat', requestId:'select-originals', originSurface:'companion',
    newConversation:{ clientDraftId:'selected-topic-draft' } };
  const accepted = await f.service.send(request);
  assert.deepEqual(accepted.state.messages.find(row => row.requestId === request.requestId).workspaceContext.collectionIds, [first, second, third]);
  assert.equal(accepted.state.jobs.at(-1).type, 'curate-selected');
  await f.service.idle();
  const state = f.service.state();
  const topic = state.exhibitions.find(item => item.id === state.jobs.at(-1).exhibitionId);
  assert.equal(topic?.kind, 'local-topic');
  assert.deepEqual(new Set(topic.collectionIds), new Set([first, second, third]));
  assert.ok(topic.curationReading.evidence.length >= 3);
  assert.equal(state.messages.at(-1).exhibitionId, topic.id);

  await f.restart();
  const replay = await f.service.send(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.exhibitionId, topic.id);
  await f.service.send({ text:'按选中的三篇收藏做一张专题卡', intent:'chat', collectionIds:[third, first, second] });
  await f.service.idle();
  assert.equal(f.service.state().exhibitions.length, 1);
  assert.equal(f.service.state().messages.at(-1).exhibitionId, topic.id);
});

test('Tag shows related saved items below the threshold and asks for clarification about an unknown or excluded source', async t => {
  const f = await setup(t);
  const [first, second] = f.ids;
  await f.service.send({ text:'用这两篇收藏做成专题', collectionIds:[first, second], intent:'chat' });
  await f.service.idle();
  const state = f.service.state();
  assert.deepEqual(state.exhibitions, []);
  assert.equal(state.jobs.at(-1).result, 'related_only');
  assert.equal(state.messages.at(-1).referenceAttribution, 'selected_curation');
  const related = messageReferences(state.messages.at(-1), state.collections).collections;
  assert.ok(related.length);
  assert.ok(related.every(item => [first, second].includes(item.id)));
  const attempts = [
    { text:'请只用 Tracker、Sky Survey 和不存在的标题做专题', expected:/完整标题/ },
    { text:'按选中的三篇收藏做专题', collectionIds:[first, second], expected:/找到了 2 条/ },
    { text:'用这些收藏做专题，但不要用 Tracker', collectionIds:[first, second], expected:/选好这次要用的收藏/ },
    { text:`只用${Array.from({ length:13 }, (_, index) => `《材料${index}》`).join('、')}做专题`, expected:/最多选 12 条/ },
  ];
  for (const { expected, ...request } of attempts) {
    const rejected = await f.service.send(request);
    assert.match(rejected.message.text, expected);
    assert.equal(rejected.state.jobs.length, state.jobs.length);
  }
});
