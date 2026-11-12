import test from 'node:test';
import assert from 'node:assert/strict';
import { exhibitionAspectRatio, layoutExhibitionRows } from '../site/curator/exhibition-row-layout.js';
import { renderWorkspace } from '../site/prototype/immersive-exhibition/light-workspace.js';

const entries = counts => counts.map((count, index) => ({ id:`exhibition-${index}`, count }));
const widthOf = (row, gap = 20) => row.items.reduce((sum, item) => sum + item.width, 0) + Math.max(0, row.items.length - 1) * gap;
const nearly = (actual, expected, tolerance = .05) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
function assertValid(rows, items, width, gap = 20) {
  assert.deepEqual(rows.flatMap(row => row.items.map(item => item.id)), items.map(item => item.id), 'Every exhibition appears once, preserving the caller’s filtered/sorted order');
  for (const row of rows) {
    assert.ok(Number.isFinite(row.height) && row.height > 0, 'A row has one finite shared height');
    assert.ok(row.items.length > 0);
    for (const item of row.items) assert.ok(Number.isFinite(item.width) && item.width > 0 && item.width <= width + .05);
    assert.ok(widthOf(row, gap) <= width + .05, `Row ${widthOf(row, gap)} must fit ${width}`);
  }
}

test('the reference count sequence produces aligned rows without reordering exhibitions', () => {
  const items = entries([43, 6, 117, 71, 5, 10, 7]);
  const rows = layoutExhibitionRows(items, { width:1600 });
  assertValid(rows, items, 1600);
  assert.deepEqual(rows.map(row => row.items.length), [3, 4]);
  nearly(widthOf(rows[0]), 1600);
  assert.ok(rows[0].height >= 300 && rows[0].height <= 325);
  const [first, middle, last] = rows[0].items;
  assert.ok(last.width > first.width && first.width > middle.width, 'More source content receives more width within the same aligned row');
});

test('source count increases the preferred width continuously within a bounded range', () => {
  const counts = [0, 1, 5, 6, 9, 10, 24, 43, 71, 117, 1000, Number.MAX_VALUE];
  const ratios = counts.map(exhibitionAspectRatio);
  assert.ok(ratios.every(ratio => Number.isFinite(ratio) && ratio > 0 && ratio <= 2.2));
  assert.ok(ratios.every((ratio, index) => index === 0 || ratio >= ratios[index - 1]));
  assert.ok(exhibitionAspectRatio(43) > exhibitionAspectRatio(6));
  assert.ok(exhibitionAspectRatio(117) > exhibitionAspectRatio(43));
});

test('completed rows use the available width including the configured gaps', () => {
  const items = entries([43, 6, 117, 71, 5, 10, 7, 43, 6, 117, 71, 5, 10, 7]);
  for (const gap of [0, 16, 20, 32]) {
    const rows = layoutExhibitionRows(items, { width:1600, gap });
    assertValid(rows, items, 1600, gap);
    assert.ok(rows.length > 1);
    for (const row of rows.slice(0, -1)) nearly(widthOf(row, gap), 1600);
  }
});

test('a sparse final row keeps a natural reading size instead of stretching one card across a desktop', () => {
  const items = entries([6]);
  const rows = layoutExhibitionRows(items, { width:1600 });
  assertValid(rows, items, 1600);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].items[0].width < 800, 'The final single card stays compact');
  assert.ok(rows[0].height <= 340);
});

test('narrow containers become single columns and preserve source-dependent height', () => {
  const items = entries([0, 6, 43, 117]);
  for (const width of [180, 280, 390]) {
    const rows = layoutExhibitionRows(items, { width });
    assertValid(rows, items, width);
    assert.ok(rows.every(row => row.items.length === 1));
    rows.forEach(row => nearly(row.items[0].width, width));
    assert.ok(rows.at(-1).height >= rows[0].height);
  }
});

test('resizing recomputes rows without losing identity or mutating the supplied order', () => {
  const items = entries([43, 6, 117, 71, 5, 10, 7]);
  const before = structuredClone(items);
  for (const width of [1600, 960, 640, 390, 640, 1600]) {
    const rows = layoutExhibitionRows(items, { width });
    assertValid(rows, items, width);
    assert.deepEqual(items, before);
  }
  assert.deepEqual(layoutExhibitionRows(items, { width:1600 }), layoutExhibitionRows(items, { width:1600 }));
});

test('filtered and sorted input remains authoritative rather than being packed by source count', () => {
  const items = [{ id:'newest-small', count:2 }, { id:'middle-large', count:117 }, { id:'oldest-medium', count:6 }, { id:'last-large', count:71 }];
  const filtered = items.filter(item => item.id !== 'middle-large');
  const rows = layoutExhibitionRows(filtered, { width:1200 });
  assertValid(rows, filtered, 1200);
  assert.ok(!rows.flatMap(row => row.items).some(item => item.id === 'middle-large'));
  const reversed = layoutExhibitionRows([...filtered].reverse(), { width:1200 });
  assertValid(reversed, [...filtered].reverse(), 1200);
});

test('zero, invalid and very large source counts never create invalid geometry', () => {
  const counts = [0, -1, NaN, Infinity, null, undefined, 'not-a-number', Number.MAX_VALUE];
  for (const count of counts) {
    const ratio = exhibitionAspectRatio(count);
    assert.ok(Number.isFinite(ratio) && ratio > 0 && ratio <= 2.2);
  }
  nearly(exhibitionAspectRatio(-1), exhibitionAspectRatio(0));
  const items = entries(counts);
  assertValid(layoutExhibitionRows(items, { width:1200 }), items, 1200);
});

test('empty data or unavailable container width produces no phantom rows', () => {
  assert.deepEqual(layoutExhibitionRows([], { width:1200 }), []);
  for (const width of [0, -1, NaN, Infinity]) assert.deepEqual(layoutExhibitionRows(entries([6]), { width }), []);
});

test('varied count distributions remain finite and fit at desktop, tablet and mobile widths', () => {
  // Deterministic synthetic content counts exercise geometry without saved user data.
  for (let length = 1; length <= 40; length++) {
    const items = entries(Array.from({ length }, (_, index) => (index * 37 + length * 13) % 180));
    for (const width of [320, 620, 980, 1600]) assertValid(layoutExhibitionRows(items, { width }), items, width);
  }
});

test('gallery rendering supplies distinct available source counts while collections retain their existing layout', () => {
  const collections = Array.from({ length:12 }, (_, index) => ({ id:`source-${index}`, title:`收藏 ${index}`, summary:'', type:'text', status:'saved' }));
  const state = { ui:{ lightPage:'gallery' }, collections, extractions:[], feedback:{}, workspaceJobs:[], exhibitions:[] };
  const galleryItems = [
    { id:'one-real-source', title:'一件真实来源', live:true, sourceCollectionIds:['source-0', 'source-0', 'unavailable'], items:[], rooms:[] },
    { id:'twelve-real-sources', title:'十二件真实来源', live:true, sourceCollectionIds:[...collections.map(item => item.id), 'source-0'], items:[], rooms:[] },
    { id:'saved-snapshot', title:'保留的来源快照', live:true, sourceCollectionIds:['snapshot', 'unavailable'], items:[{ id:'snapshot', title:'实际保存的快照' }], rooms:[] },
  ];
  const gallery = renderWorkspace({ state, galleryItems });
  assert.match(gallery, /class="ws-exhibition-grid"[^>]*data-layout="rows"/);
  const counts = new Map([...gallery.matchAll(/<article\b[^>]*>/g)].map(([tag]) => [tag.match(/data-exhibition-layout-id="([^"]+)"/)?.[1], Number(tag.match(/data-story-count="(\d+)"/)?.[1])]));
  assert.equal(counts.get('one-real-source'), 1);
  assert.equal(counts.get('twelve-real-sources'), 12);
  assert.equal(counts.get('saved-snapshot'), 1);
  const inbox = renderWorkspace({ state:{ ...state, ui:{ lightPage:'inbox' } } });
  assert.match(inbox, /class="ws-collection-grid"[^>]*data-layout="masonry"/);
  assert.doesNotMatch(inbox, /data-layout="rows"|data-story-count|data-exhibition-layout-id|--exhibition-card-width/);
});
