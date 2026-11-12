import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService } from '../desktop/server/service.mjs';

const reports = [
  ['agency', 'Agency confirms ORBITA impact at Mirabel', 'Oct 11, 2024\n\nOn 10 October 2024, the ORBITA team measured the impact at Mirabel. Its investigators confirmed that the impact changed the orbit of Mirabel by 32 minutes.\n\nThe agency tracked the spacecraft directly through radar.'],
  ['observatory', 'ORBITA impact at Mirabel observed by astronomers', '14 October 2024\n\nThe Observatory telescopes tracked debris around Mirabel after the ORBITA impact on 10 October 2024. Their imaging study showed a dust cloud continued growing for 7 days after impact.'],
  ['institute', 'ORBITA impact reshaped Mirabel', '19 Oct. 2024\n\nInstitute scientists simulated the impact of ORBITA on Mirabel, which took place on 10 October 2024. They used the simulations to compare the shape of Mirabel to observations and found that a crater could be 60 metres across.'],
];

async function save(service, [publisher, title, text], request, reread = false, originSurface) {
  const { context, conversationId } = await service.openPage({ requestId:`read-${request}`, reread, context:{
    title, text, url:`https://${publisher}.org/story`, attachmentId:publisher, pageRevision:request, contentSource:'browser-accessibility',
  } });
  const result = await service.send({ requestId:`save-${request}`, conversationId, context, intent:'collect-page', text:'收藏这个页面', originSurface });
  return result.message.collectionIds[0];
}

test('accepted local originals form a single durable topic and stale source versions withdraw it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-local-topic-'));
  const remote = [];
  const forbidden = () => { remote.push('unexpected external call'); throw new Error('Use saved originals only'); };
  const settings = { directory, aiEnabled:false, config:{ embeddingBackend:'disabled' }, knowledgeEmbedder:null, knowledgeReranker:null, model:forbidden, fetchPage:forbidden };
  let service = await createDesktopService({ ...settings, autoCurate:false });
  t.after(async () => { await service.close(); await rm(directory, { recursive:true, force:true }); });

  const first = await save(service, reports[0], 'first');
  const second = await save(service, reports[1], 'second');
  await service.close();
  service = await createDesktopService(settings);
  await service.idle();
  assert.deepEqual(service.state().exhibitions, []);
  assert.deepEqual((await service.curationRelated({ collectionId:first })).related.map(item => item.collectionId), [second]);

  const third = await save(service, reports[2], 'third');
  await service.idle();
  const [topic] = service.state().exhibitions;
  assert.equal(service.state().exhibitions.length, 1);
  assert.equal(topic.kind, 'local-topic');
  assert.deepEqual(new Set(topic.collectionIds), new Set([first, second, third]));
  assert.equal((await service.curationRelated({ collectionId:first })).topicId, topic.id);
  const citation = topic.curationReading.evidence.find(item => item.sourceId === third);
  assert.ok(citation);

  await save(service, [reports[2][0], 'Growing roses in cold weather', 'Botanists tracked roses during the winter. Their observations found that local gardeners could preserve moisture for 18 days by applying a layer of mulch.'], 'replace', true);
  await service.idle();
  assert.deepEqual(service.state().exhibitions, []);
  assert.equal((await service.curationRelated({ collectionId:first })).status, 'related');
  const old = await service.knowledgeRead({ collectionId:third, documentVersionId:citation.documentVersionId });
  assert.equal(old.document.text.slice(citation.start, citation.end), citation.quote);
  assert.equal(old.document.active, false);

  await save(service, reports[2], 'restore', true);
  await service.idle();
  assert.deepEqual(service.state().exhibitions.map(item => item.id), [topic.id]);
  assert.equal(service.state().exhibitions[0].curationVersion, 2);
  assert.equal(service.state().exhibitions[0].curationUpdate.kind, 'revalidated');
  assert.deepEqual(remote, []);
});

const additions = [
  ['camera', 'Cameras track ORBITA impact at Mirabel', '20 October 2024\n\nResearchers tracked the ORBITA impact at Mirabel on 10 October 2024. Their imaging observations showed a plume remained visible for 14 days after impact.'],
  ['planetarium', 'ORBITA impact leaves Mirabel in a debris stream', '21 October 2024\n\nThe Planetarium team studied the ORBITA impact at Mirabel on 10 October 2024. The team measured the debris leaving Mirabel and found a stream extending for 19 kilometres after impact.'],
  ['laboratory', 'Laboratory compares ORBITA impact at Mirabel', '22 October 2024\n\nLaboratory researchers analyzed the ORBITA impact at Mirabel on 10 October 2024. They simulated ejecta motion and measured that dust grains left Mirabel for 8 hours after the impact.'],
  ['engineering', 'ORBITA impact at Mirabel scatters rock fragments', '23 October 2024\n\nEngineers directly tracked material from the ORBITA impact at Mirabel on 10 October 2024. Their experiment found that rock fragments weighed 27 kilograms in total.'],
];

test('each new same-topic trio combines with the original three in a separate exhibition across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-curation-groups-'));
  const settings = { directory, aiEnabled:false, config:{ embeddingBackend:'disabled' }, knowledgeEmbedder:null, knowledgeReranker:null };
  let service = await createDesktopService(settings);
  t.after(async () => { await service.close(); await rm(directory, { recursive:true, force:true }); });

  for (const report of reports) await save(service, report, report[0]);
  await service.idle();
  const [original] = service.state().exhibitions;
  await service.note({ exhibitionId:original.id, text:'留在第一场的手记' });
  const firstExhibition = service.state().exhibitions[0];
  const groups = [];
  for (let i = 0; i < 2; i++) {
    const added = await save(service, additions[i], 'group-' + i, false, 'companion');
    groups.push(added);
    await service.idle();
    assert.deepEqual(service.state().exhibitions, [firstExhibition]);
    assert.equal((await service.curationRelated({ collectionId:added })).status, 'related');
  }
  const mirrored = await save(service, ['mirror', reports[0][1], reports[0][2]], 'reprint', false, 'companion');
  await service.idle();
  assert.deepEqual(service.state().exhibitions, [firstExhibition], 'A reprint of an article in the first exhibition is not a third new source');

  await service.close();
  service = await createDesktopService(settings);
  await service.idle();
  assert.deepEqual(service.state().exhibitions, [firstExhibition]);

  groups.push(await save(service, additions[2], 'group-2', false, 'companion'));
  await service.idle();
  const [preserved, second] = service.state().exhibitions;
  assert.deepEqual(preserved, firstExhibition);
  assert.notEqual(second.id, preserved.id);
  assert.deepEqual(new Set(second.collectionIds), new Set([...original.collectionIds, ...groups]));
  assert.deepEqual(second.curationBase, { exhibitionId:original.id, collectionIds:original.collectionIds });
  assert.deepEqual(new Set(second.curationReading.evidence.map(entry => entry.sourceId)), new Set(second.collectionIds));
  assert.ok(second.curationReading.evidence.some(entry => groups.includes(entry.sourceId) && /14 days|19 kilometres|8 hours/u.test(entry.quote)));
  const [lead] = second.curationReading.overview;
  assert.ok(second.curationReading.evidence.some(entry => lead.evidenceIds.includes(entry.id) && groups.includes(entry.sourceId)));
  assert.equal(second.collectionIds.includes(mirrored), false);
  assert.equal((await service.curationRelated({ collectionId:groups[0] })).topicId, second.id);

  const laterReports = [additions[3],
    ['researchcenter', 'Researchers time ORBITA impact debris at Mirabel', '24 October 2024\n\nResearchers directly observed the ORBITA impact at Mirabel on 10 October 2024. Their team recorded 44 separate flashes from debris in the first night and measured their intervals.'],
    ['spacecenter', 'ORBITA impact at Mirabel observed by space center', '25 October 2024\n\nSpace Center researchers observed the ORBITA impact at Mirabel on 10 October 2024. They measured the brightness of the ejecta and found that the visible plume brightened by 6 percent.'],
  ];
  const nextIds = [];
  for (const [index, article] of laterReports.entries()) {
    nextIds.push(await save(service, article, 'later-' + index, false, 'companion'));
    await service.idle();
    assert.equal(service.state().exhibitions.length, index === 2 ? 3 : 2);
  }
  const exhibitions = service.state().exhibitions;
  assert.deepEqual(exhibitions.slice(0, 2), [preserved, second]);
  assert.deepEqual(new Set(exhibitions[2].collectionIds), new Set([...original.collectionIds, ...nextIds]));
  assert.deepEqual(exhibitions[2].curationBase, second.curationBase);
  assert.equal(service.state().messages.some(item => item.curationUpdateOffer), false);

  await service.close();
  service = await createDesktopService(settings);
  await service.idle();
  assert.deepEqual(service.state().exhibitions, exhibitions);
});

test('similar reporting only makes a combined exhibition with new evidence about the same event', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-curation-six-gate-'));
  const service = await createDesktopService({ directory, aiEnabled:false, config:{ embeddingBackend:'disabled' },
    knowledgeEmbedder:null, knowledgeReranker:null });
  t.after(async () => { await service.close(); await rm(directory, { recursive:true, force:true }); });

  for (const report of reports) await save(service, report, report[0]);
  await service.idle();
  const [initial] = service.state().exhibitions;
  const repeats = [
    ['orbital', 'Orbital researchers report the ORBITA impact at Mirabel', 'The orbital team measured the change in the orbit of Mirabel after the ORBITA impact on 10 October 2024. The researchers confirmed a shift of 32 minutes.'],
    ['dust', 'ORBITA impact at Mirabel leaves growing dust cloud', 'Astronomers observed the ORBITA impact at Mirabel on 10 October 2024. Their telescopes tracked the dust cloud and found that it grew for 7 days.'],
    ['crater', 'Researchers simulate the ORBITA impact at Mirabel', 'After the ORBITA impact at Mirabel on 10 October 2024, researchers simulated its shape. Their findings showed the crater could be 60 metres across.'],
  ];
  for (const report of repeats) await save(service, report, report[0]);
  await service.idle();
  assert.deepEqual(service.state().exhibitions, [initial]);

  const separate = [];
  for (const [publisher, title, text] of additions.slice(0, 3)) {
    separate.push(await save(service, [publisher, title, text.replaceAll('2024', '2025')], publisher));
  }
  await service.idle();
  const [unchanged, differentEvent] = service.state().exhibitions;
  assert.deepEqual(unchanged, initial);
  assert.equal(service.state().exhibitions.length, 2);
  assert.deepEqual(new Set(differentEvent.collectionIds), new Set(separate));
  assert.equal(differentEvent.curationBase, undefined);
});

test('Tag and Folio captures share the new-exhibition threshold once usable originals are saved', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-curation-link-group-'));
  const urlFor = ([publisher]) => `https://${publisher}.org/story`;
  const service = await createDesktopService({
    directory, aiEnabled:true, config:{ embeddingBackend:'disabled', textModel:'fixture', timeoutMs:1000 },
    knowledgeEmbedder:null, knowledgeReranker:null,
    fetchPage:async url => {
      const found = additions.find(article => urlFor(article) === url);
      if (!found) throw new Error('No readable original');
      return { url, type:'text/plain', title:found[1], text:found[2] };
    },
    model:() => { throw new Error('Understanding is unavailable'); },
  });
  t.after(async () => { await service.close(); await rm(directory, { recursive:true, force:true }); });

  for (const report of reports) await save(service, report, report[0]);
  await service.idle();
  const [initial] = service.state().exhibitions;
  const saved = await service.capture({ mode:'link', content:urlFor(additions[0]), title:additions[0][1], originSurface:'workspace' });
  const sent = await service.send({ text:urlFor(additions[1]), originSurface:'companion' });
  await service.send({ text:'https://unavailable.org/story', originSurface:'companion' });
  await service.idle();
  assert.deepEqual(service.state().exhibitions, [initial]);

  const third = await save(service, additions[2], 'tag-snapshot', false, 'companion');
  await service.idle();
  const [previous, created] = service.state().exhibitions;
  assert.deepEqual(previous, initial);
  assert.deepEqual(new Set(created.collectionIds), new Set([...initial.collectionIds, saved.collectionId, ...sent.message.collectionIds, third]));
  assert.equal(service.state().messages.some(item => item.curationUpdateOffer), false);
});

test('the next exhibition leaves a Tag-selected source group and its generated reading intact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-curation-scope-'));
  let modelReads = 0;
  const settings = {
    directory, aiEnabled:true, config:{ embeddingBackend:'disabled', textModel:'injected-reading-test', timeoutMs:3000 },
    knowledgeEmbedder:null, knowledgeReranker:null, model:() => { throw new Error('Unneeded presentation model'); },
    chat:(_config, options) => {
      modelReads++;
      const { slots, source } = JSON.parse(options.messages[1].content);
      const entries = Object.fromEntries(slots.map(({ id }) => [id, { text:'证据支持这项阅读结论。', evidenceIds:[source[0].excerpts[0].id] }]));
      return { model:'injected-reading-test', choices:[{ message:{ content:JSON.stringify({ entries }) } }] };
    },
  };
  let service = await createDesktopService({ ...settings, autoCurate:false });
  t.after(async () => { await service.close(); await rm(directory, { recursive:true, force:true }); });
  const ids = [];
  for (const report of reports) ids.push(await save(service, report, report[0]));
  await service.send({ text:'按选中的三篇收藏做一张专题卡', intent:'chat', collectionIds:ids });
  await service.idle();
  const [pinned] = service.state().exhibitions;
  assert.equal(pinned.curationScope, 'selected');
  const mode = { exhibitionId:pinned.id, mode:'plain' };
  const reading = await service.curationReading({ ...mode, generate:true });
  assert.equal(modelReads, 1);

  await service.close();
  service = await createDesktopService(settings);
  await service.idle();
  assert.deepEqual(service.state().exhibitions, [pinned]);
  const next = [];
  for (const [index, article] of additions.slice(0, 3).entries()) {
    next.push(await save(service, article, 'next-' + index, false, 'companion'));
    await service.idle();
    assert.deepEqual(await service.curationReading(mode), reading);
    assert.equal(service.state().exhibitions.length, index === 2 ? 2 : 1);
  }
  const [manual, automatic] = service.state().exhibitions;
  assert.deepEqual(manual, pinned);
  assert.deepEqual(new Set(automatic.collectionIds), new Set([...pinned.collectionIds, ...next]));
  assert.notEqual(automatic.id, manual.id);
});

test('retired invitations keep their conversation history and their articles can form a new exhibition', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-curation-legacy-invite-'));
  const settings = { directory, aiEnabled:false, config:{ embeddingBackend:'disabled' }, knowledgeEmbedder:null, knowledgeReranker:null };
  let service = await createDesktopService(settings);
  t.after(async () => { await service.close(); await rm(directory, { recursive:true, force:true }); });
  for (const report of reports) await save(service, report, report[0]);
  await service.idle();
  const [initial] = service.state().exhibitions;
  const previousAdditions = [];
  for (const [index, article] of additions.slice(0, 2).entries()) {
    previousAdditions.push(await save(service, article, 'legacy-' + index));
  }
  await service.idle();
  await service.close();

  const file = join(directory, 'state.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const updateId = 'old-proposal';
  const conversationId = 'old-invitation';
  const createdAt = '2026-11-12T01:00:00.000Z';
  stored.exhibitions[0].curationPending = { id:updateId, version:2, sourceIds:previousAdditions };
  stored.localCurationUpdates = { [initial.id]:{ id:updateId, expectedVersion:1 } };
  stored.conversations.push({ id:conversationId, title:'专题更新', originSurface:'companion', createdAt, updatedAt:createdAt });
  stored.messages.push({ id:'old-prompt', conversationId, role:'assistant', text:'要把这些资料加入专题吗？', createdAt,
    curationUpdateOffer:{ exhibitionId:initial.id, updateId, expectedVersion:1 } });
  await writeFile(file, JSON.stringify(stored));

  service = await createDesktopService(settings);
  await service.idle();
  const history = service.state().messages.find(message => message.id === 'old-prompt');
  assert.equal(history.text, '要把这些资料加入专题吗？');
  assert.equal(history.conversationId, conversationId);
  assert.deepEqual(service.state().exhibitions, [initial]);

  const third = await save(service, additions[2], 'after-upgrade', false, 'companion');
  await service.idle();
  const [unchanged, next] = service.state().exhibitions;
  assert.deepEqual(unchanged, initial);
  assert.deepEqual(new Set(next.collectionIds), new Set([...initial.collectionIds, ...previousAdditions, third]));
  assert.deepEqual(service.state().messages.filter(message => message.curationUpdateOffer).map(message => message.id), ['old-prompt']);
});
