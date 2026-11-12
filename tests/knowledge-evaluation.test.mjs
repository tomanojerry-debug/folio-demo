import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKnowledge, latencyMetrics, rankingMetrics } from '../scripts/eval-knowledge.mjs';
import { knowledgeEvaluationDataset as dataset, knowledgeHoldoutDataset, evaluationCollections } from './fixtures/knowledge-eval.mjs';
import { freshKnowledgeChallenge } from './fixtures/knowledge-fresh-eval.mjs';

test('the labelled benchmark retains 50 queries, cross-language hard cases, late evidence and duplicate sources', () => {
  assert.equal(dataset.documents.length, 12);
  assert.equal(dataset.queries.length, 50);
  assert.equal(new Set(dataset.queries.map(query => query.id)).size, 50);
  assert.equal(dataset.queries.filter(query => Object.keys(query.relevant).length).length, 40);
  assert.ok(dataset.queries.filter(query => query.category === 'cross_language').length >= 7);
  assert.equal(dataset.queries.filter(query => query.category === 'no_result').length, 5);
  assert.equal(dataset.queries.filter(query => query.category === 'assistant_identity').length, 5);
  const long = dataset.documents.find(document => document.id === 'daylight');
  assert.ok(long.body.length > 12000);
  assert.ok(long.body.indexOf('LUX-742') > 12000);
  assert.equal(dataset.documents.find(document => document.id === 'focus').body, dataset.documents.find(document => document.id === 'focus-mirror').body);
  assert.notEqual(dataset.documents.find(document => document.id === 'orbit-free').body, dataset.documents.find(document => document.id === 'orbit-pro').body);
  const groups = new Set(dataset.documents.map(document => document.group));
  for (const query of dataset.queries) for (const expected of Object.keys(query.relevant)) assert.ok(groups.has(expected), `${query.id}: ${expected}`);
  assert.equal(evaluationCollections().every(collection => collection.input.mode === 'text' && collection.input.content), true);
});

test('Recall and nDCG reward relevant ranking without counting duplicate copies as new evidence', () => {
  const relevance = { a:3, b:2 };
  assert.deepEqual(rankingMetrics(['a', 'b'], relevance, id => id), { recallAt5:1, ndcgAt5:1, hit:true, returnedCount:2, labelledRelevantReturned:2, returnedPrecision:1 });
  const duplicate = rankingMetrics(['copy-a', 'a', 'b'], relevance, id => id === 'copy-a' ? 'a' : id);
  assert.equal(duplicate.recallAt5, 1);
  assert.ok(duplicate.ndcgAt5 < 1);
  assert.equal(duplicate.returnedPrecision, 2 / 3);
  assert.equal(rankingMetrics(['a', 'a'], relevance, id => id).recallAt5, 0.5);
  assert.equal(rankingMetrics(['wrong', 'wrong2'], relevance, id => id).recallAt5, 0);
  assert.deepEqual(rankingMetrics([], {}, id => id), { recallAt5:0, ndcgAt5:0, hit:false, returnedCount:0, labelledRelevantReturned:0, returnedPrecision:null });
  assert.equal(rankingMetrics(['a'], relevance, id => id).returnedPrecision, 1, 'A correct one-item answer need not be padded to five');
  assert.equal(rankingMetrics(['unlabelled'], relevance, id => id).returnedPrecision, 0, 'Unlabelled potential relevance is conservatively treated as non-relevant');
});

test('the independent holdout remains separate from the fifty-query calibration corpus', () => {
  assert.equal(knowledgeHoldoutDataset.documents.length, 8);
  assert.equal(knowledgeHoldoutDataset.queries.length, 20);
  assert.equal(knowledgeHoldoutDataset.similarCases.length, 3);
  assert.equal(knowledgeHoldoutDataset.queries.filter(query => !Object.keys(query.relevant).length).length, 8);
  assert.ok(knowledgeHoldoutDataset.queries.filter(query => query.category === 'cross_language').length >= 6);
  const originalIds = new Set(dataset.documents.map(document => document.id));
  assert.equal(knowledgeHoldoutDataset.documents.some(document => originalIds.has(document.id)), false);
  assert.equal(dataset.queries.length, 50);
  assert.equal(evaluationCollections(knowledgeHoldoutDataset).length, 8);
});

test('latency summaries use observed nearest-rank percentiles and reject non-finite samples', () => {
  assert.deepEqual(latencyMetrics([5, 1, 4, 2, 3, Infinity, NaN]), { count:5, p50Ms:3, p95Ms:5, maxMs:5 });
  assert.deepEqual(latencyMetrics([]), { count:0, p50Ms:0, p95Ms:0, maxMs:0 });
});

test('the scored fresh challenge stays reproducible and separate from both previous corpora', () => {
  assert.equal(freshKnowledgeChallenge.documents.length, 6);
  assert.equal(freshKnowledgeChallenge.queries.length, 12);
  assert.equal(freshKnowledgeChallenge.similarCases.length, 3);
  assert.equal(freshKnowledgeChallenge.queries.filter(query => Object.keys(query.relevant).length).length, 8);
  const earlierIds = new Set([...dataset.documents, ...knowledgeHoldoutDataset.documents].map(document => document.id));
  assert.equal(freshKnowledgeChallenge.documents.some(document => earlierIds.has(document.id)), false);
  assert.equal(evaluationCollections(freshKnowledgeChallenge).length, 6);
});

test('default evaluation executes actual storage and FTS on disposable synthetic data without a model', async () => {
  const summary = await evaluateKnowledge();
  assert.equal(summary.dataset, dataset.name);
  assert.equal(summary.fixtureMode, 'synthetic-full-text-only');
  assert.equal(summary.realModelCalls, false);
  assert.equal(summary.remoteInference, false);
  assert.equal(summary.model, null);
  assert.equal(summary.reranker, null);
  assert.equal(summary.scale.documents, 12);
  assert.equal(summary.scale.labelledQueries, 50);
  assert.equal(summary.cases.length, 50);
  assert.equal(summary.similarCases.length, 5);
  assert.equal(summary.latency.search.count, 45);
  assert.ok(summary.retrieval.recallAt5 >= 0 && summary.retrieval.recallAt5 <= 1);
  assert.ok(summary.retrieval.ndcgAt5 >= 0 && summary.retrieval.ndcgAt5 <= 1);
  assert.ok(summary.byCategory.literal.recallAt5 >= 0.9, 'Literal retrieval remains a useful baseline');
  for (const name of ['identity_questions_skip_library', 'similar_excludes_anchor_and_duplicate', 'two_sided_similarity_evidence', 'evidence_maps_to_original', 'source_revision_and_history', 'source_survives_understanding_failure', 'deleted_sources_stay_unavailable', 'originals_survive_reopen']) assert.equal(summary.gates.find(gate => gate.name === name)?.status, 'pass', name);
  const report = JSON.stringify(summary);
  assert.equal(report.includes(dataset.documents[0].body), false, 'Artifact reports IDs, scores and metrics instead of complete sources');
  assert.equal(report.includes(dataset.documents.find(document => document.id === 'daylight').body), false);
});
