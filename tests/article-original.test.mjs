import assert from 'node:assert/strict';
import test from 'node:test';
import { readingParagraphs } from '../desktop/server/reading.mjs';
import { renderArticleOriginal } from '../site/curator/article-original.js';

const pageTitle = 'Optimizing production with ERP data across the supply chain';
const introduction = 'A factory team reconciled order forecasts and current stock before changing its production schedule for the following week.';
const rows = [
  'Documentation', 'Search the docs', 'API Reference', 'Platform updates', 'Release notes',
  pageTitle, introduction, 'Challenge', 'Plant data and shipping data arrived at different times.',
  'Solution', 'The team reviewed both feeds together before rescheduling.',
  '←', 'PREVIOUSDrive revenue with integrated pricing', 'NEXTReduce number of containers shipped', '→'
];

function articleFor(body, overrides) {
  return {
    title: 'Use case examples • Optimize production with ERP data across the supply chain • Palantir',
    url: 'https://www.palantir.com/docs/foundry/use-case-examples/optimizing-production-with-erp-data-across-the-supply-chain',
    sourceKind: 'body_text',
    paragraphs: readingParagraphs(body.join('\n\n')),
    ...overrides
  };
}

test('original reader folds navigation and groups the article while preserving every paragraph in original order', () => {
  const article = articleFor(rows);
  const html = renderArticleOriginal(article);

  assert.match(html, /data-reading-details="original-header"><summary>原网页导航 <span>5 段/);
  assert.match(html, /data-reading-details="original-footer"><summary>原网页翻页链接 <span>4 段/);
  assert.match(html, /<h2[^>]+data-reading-paragraph="p6" data-reading-article-start[^>]*>.*Optimizing production/u);
  assert.match(html, /<section[^>]+aria-labelledby="forme-reading-paragraph-p8"><h3[^>]+>.*Challenge<\/h3><p[^>]+data-reading-paragraph="p9"/u);
  assert.deepEqual([...html.matchAll(/data-reading-paragraph="([^"]+)"/gu)].map(match => match[1]), article.paragraphs.map(row => row.id));
});

test('a citation into folded source opens the matching region and highlights its exact escaped text', () => {
  const article = articleFor([...rows.slice(0, 4), 'Feedback <help>', ...rows.slice(5)]);
  const header = renderArticleOriginal(article, { paragraphId: 'p5', start: 9, quote: '<help>' });
  const footer = renderArticleOriginal(article, { paragraphId: 'p14', start: 4, quote: 'Reduce' });
  const mismatched = renderArticleOriginal(article, { paragraphId: 'p5', start: 8, quote: '<help>' });

  assert.match(header, /data-reading-details="original-header" open/u);
  assert.match(header, /Feedback <mark class="forme-reading-source-mark">&lt;help&gt;<\/mark>/u);
  assert.match(footer, /data-reading-details="original-footer" open/u);
  assert.match(footer, /NEXT<mark class="forme-reading-source-mark">Reduce<\/mark>/u);
  assert.doesNotMatch(mismatched, /<mark/u);
});

test('uncertain titles, long leading prose, and nonweb captures stay in the original reading sequence', () => {
  const withoutStart = renderArticleOriginal(articleFor(['Documentation', 'Search', 'Products', 'Navigation', 'A different subject', introduction]));
  const leadingProse = renderArticleOriginal(articleFor(['Documentation', 'Search', introduction, 'Menu', pageTitle, introduction]));
  const unpairedFooter = renderArticleOriginal(articleFor(rows.slice(0, 11).concat('Previous page: more evidence')));
  const transcript = renderArticleOriginal(articleFor(rows, { sourceKind: 'video_transcript' }));
  const localText = renderArticleOriginal(articleFor(rows, { url: '' }));

  for (const html of [withoutStart, leadingProse, transcript, localText]) {
    assert.match(html, /data-reading-paragraph="p1" data-reading-article-start/u);
    assert.doesNotMatch(html, /data-reading-raw/u);
  }
  assert.match(unpairedFooter, /Previous page: more evidence/u);
  assert.doesNotMatch(unpairedFooter, /original-footer/u);
});
