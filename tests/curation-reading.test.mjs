import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCurationStory } from '../site/curator/curation-story.js';
import { curationReadingExample as example } from '../site/curator/curation-reading-example.js';
import { updateReadingPreferences } from '../desktop/server/reading.mjs';

test('every public example reading entry resolves to an exact excerpt and its publisher', () => {
  const sources = new Map(example.sources.map(source => [source.id, source]));
  const evidence = new Map(example.evidence.map(row => [row.id, row]));
  const entries = [...example.overview, ...example.comparison.flatMap(group => group.entries), ...example.timeline, ...example.deepDive];
  const rendered = renderCurationStory(example, [], example);
  assert.equal(sources.size, 3);
  for (const mode of ['overview', 'compare', 'full']) assert.match(rendered, new RegExp(`id="folio-story-panel-${mode}"`));
  for (const entry of entries) {
    assert.ok(entry.evidenceIds.length, entry.title);
    for (const id of entry.evidenceIds) {
      const row = evidence.get(id);
      assert.ok(row?.quote && row.locator, id);
      assert.equal(row.url.split('#')[0], sources.get(row.sourceId).url);
      assert.equal(decodeURIComponent(row.url.split('#:~:text=')[1]), row.quote);
      assert.ok(rendered.includes(`data-curation-evidence="${id}"`), id);
    }
  }
});

test('curation preference is independent of single-article reading preferences', () => {
  const state = {};
  const first = updateReadingPreferences(state, { defaultMode:'original', curationMode:'compare' });
  const second = updateReadingPreferences(state, { expectedVersion:first.version, fontSize:20 });
  assert.equal(second.defaultMode, 'original');
  assert.equal(second.curationMode, 'compare');
  assert.equal(second.version, first.version + 1);
  assert.throws(() => updateReadingPreferences(state, { curationMode:'arbitrary' }), { code:'INVALID_REQUEST' });
});

test('local topic omits generated filler while keeping a concrete source explanation', () => {
  const topic = { id:'topic', kind:'local-topic', title:'撞击之后', curationReading:{
    topicKind:'event', sources:[], overview:[], comparison:[], timeline:[], deepDive:[],
  } };
  for (const reason of ['这些收藏聚焦同一件事，并提供了不同的资料。', '这些收藏回答同一个具体问题，并提供了不同的资料。']) {
    const html = renderCurationStory({ ...topic, subtitle:reason, curationReading:{ ...topic.curationReading, reason } });
    assert.ok(!html.includes(reason));
    assert.ok(!html.includes('为什么放在一起？'));
  }
  const reason = '一篇报告轨道测量，另一篇追踪撞击碎屑。';
  const html = renderCurationStory({ ...topic, subtitle:reason, curationReading:{ ...topic.curationReading, reason } });
  assert.equal(html.split(reason).length, 2);
});

test('personal story sidebars and citation controls use actual selected sources and exclude stale evidence', () => {
  const a = { id:'a', title:'已入选文章', understandingDocumentVersionId:'ver:a', extraction:{evidenceBundle:[{evidence_id:'ev-a', text:'已保存的证据'}]} };
  const show = { id:'story', collectionIds:['a'], items:[{id:'b',title:'仅召回未入选'}], rooms:[{title:'一章', exhibit_ids:['a'], claims:[{text:'已保存主张', evidence_ids:['ev-a']}]}] };
  const html = renderCurationStory(show, [a]);
  assert.match(html, /data-curation-evidence="ev-a"/u);
  assert.doesNotMatch(html, /仅召回未入选/u);
  assert.doesNotMatch(renderCurationStory({...show, sourceReviewPending:true}, [a]), /data-curation-evidence="ev-a"/u);
});
