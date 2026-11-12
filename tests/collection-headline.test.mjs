import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionHeadline } from '../site/curator/collection-headline.js';

test('a captured article can display its title without the verified browser breadcrumb trail', () => {
  const title = 'Use case examples • Consumer products • Optimize production with ERP data across the supply chain • Palantir';
  const item = {
    title,
    url: 'https://www.palantir.com/docs/foundry/use-case-examples/optimizing-production-with-erp-data-across-the-supply-chain',
  };
  assert.equal(collectionHeadline(item), 'Optimize production with ERP data across the supply chain');
  assert.equal(item.title, title);
});

test('site labels can be removed while real subtitles and unknown site labels are retained', () => {
  assert.equal(collectionHeadline({ title:'Frontiers | Factory Ontologies: A Field Report', url:'https://www.frontiers.com/article' }), 'Factory Ontologies: A Field Report');
  assert.equal(collectionHeadline({ title:'A study of memory — what we measured — Example Research', url:'https://example.org/research/study-of-memory', publisher:'Example Research' }), 'A study of memory — what we measured');
  assert.equal(collectionHeadline({ title:'A study of memory | what we measured | Example Research', url:'https://example.org/research/study-of-memory', publisher:'Example Research' }), 'A study of memory | what we measured');
  assert.equal(collectionHeadline({ title:'Systems | A study of memory | A reply', url:'https://example.org/research/study-of-memory' }), 'Systems | A study of memory | A reply');
  assert.equal(collectionHeadline({ title:'Keeping AI readable | A literal title', url:'not a URL' }), 'Keeping AI readable | A literal title');
});

test('an expanded site acronym is removed when the article title also matches the URL', () => {
  const heading = 'Finance Domain ontology transformed into an Enterprise Data Model.';
  const title = `${heading} - Financial Industry Business Data Model`;
  assert.equal(collectionHeadline({ title, url:'https://fib-dm.com/finance-ontology-transform-data-model/' }), heading);
  assert.equal(collectionHeadline({ title, url:'https://fib-dm.com/archive/another-article/' }), title);
  assert.equal(collectionHeadline({ title, url:'https://enterprise.example/finance-ontology-transform-data-model/' }), title);
});
