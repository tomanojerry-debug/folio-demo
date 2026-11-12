import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createKnowledgeManager } from '../desktop/server/knowledge/manager.mjs';
import { shouldSearchCollections } from '../desktop/server/harness/context.mjs';
import { evaluationCollections, knowledgeEvaluationDataset as mainDataset, knowledgeHoldoutDataset } from '../tests/fixtures/knowledge-eval.mjs';
import { freshKnowledgeChallenge } from '../tests/fixtures/knowledge-fresh-eval.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const groups = new Map(mainDataset.documents.map(document => [document.id, document.group]));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const rounded = value => Number(value.toFixed(4));
export const evaluationThresholds = Object.freeze({ recallAt5:0.85, ndcgAt5:0.8, noResultAccuracy:1, identityAccuracy:1, similarRecallAt5:0.8, evidenceAccuracy:1 });

async function runtimeIdentity(local) {
  const runtime = { node:process.version, platform:process.platform, architecture:process.arch };
  const implementation = {};
  for (const file of ['manager.mjs', 'worker.mjs', 'tokenize.mjs', ...(local ? ['local-embedding-worker.mjs', 'local-reranker-worker.mjs'] : [])]) implementation[file] = createHash('sha256').update(await readFile(new URL(`../desktop/server/knowledge/${file}`, import.meta.url))).digest('hex');
  implementation['harness/context.mjs'] = createHash('sha256').update(await readFile(new URL('../desktop/server/harness/context.mjs', import.meta.url))).digest('hex');
  runtime.implementationHashes = implementation;
  if (local) {
    const require = createRequire(import.meta.url);
    const transformerEntry = require.resolve('@huggingface/transformers');
    const packageVersion = async (entry, name) => {
      let directory = path.dirname(entry);
      for (let depth = 0; depth < 8; depth++) {
        try { const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); if (metadata.name === name) return metadata.version; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
      }
      return null;
    };
    runtime.transformers = await packageVersion(transformerEntry, '@huggingface/transformers');
    runtime.onnxruntime = await packageVersion(createRequire(transformerEntry).resolve('onnxruntime-node'), 'onnxruntime-node');
    runtime.ortResolution = 'resolved from @huggingface/transformers';
  }
  return runtime;
}

/** Duplicate copies cannot earn repeated relevance gain. Positions still count. */
export function rankingMetrics(actualIds, relevance, groupFor = id => groups.get(id) || id, k = 5) {
  const expected = Object.entries(relevance).filter(([, grade]) => grade > 0);
  const found = new Set(), seen = new Set();
  let dcg = 0;
  actualIds.slice(0, k).forEach((id, index) => {
    const group = groupFor(id), grade = seen.has(group) ? 0 : Number(relevance[group] || 0);
    seen.add(group);
    if (grade > 0) found.add(group);
    dcg += (2 ** grade - 1) / Math.log2(index + 2);
  });
  const ideal = expected.map(([, grade]) => grade).sort((a, b) => b - a).slice(0, k).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const returnedCount = actualIds.slice(0, k).length;
  return { recallAt5:expected.length ? found.size / expected.length : 0, ndcgAt5:ideal ? dcg / ideal : 0, hit:found.size > 0, returnedCount, labelledRelevantReturned:found.size, returnedPrecision:returnedCount ? found.size / returnedCount : null };
}

export function latencyMetrics(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : 0;
  return { count:sorted.length, p50Ms:rounded(percentile(0.5)), p95Ms:rounded(percentile(0.95)), maxMs:rounded(sorted.at(-1) || 0) };
}

function summarizeRows(rows) {
  const relevant = rows.filter(row => row.expectedGroups.length);
  const empty = rows.filter(row => !row.expectedGroups.length);
  const returnedCount = rows.reduce((sum, row) => sum + row.returnedCount, 0);
  const labelledRelevantReturned = rows.reduce((sum, row) => sum + row.labelledRelevantReturned, 0);
  return {
    count:rows.length, relevantCount:relevant.length,
    recallAt5:rounded(mean(relevant.map(row => row.recallAt5))),
    ndcgAt5:rounded(mean(relevant.map(row => row.ndcgAt5))),
    hitRateAt5:rounded(mean(relevant.map(row => row.hit ? 1 : 0))),
    noResultAccuracy:empty.length ? rounded(mean(empty.map(row => row.actualIds.length ? 0 : 1))) : null,
    returnedCount, labelledRelevantReturned,
    returnedPrecision:returnedCount ? rounded(labelledRelevantReturned / returnedCount) : null,
  };
}

/** Runs solely on a disposable synthetic library. No .env or private state is read. */
export async function evaluateKnowledge({ local = false, dataset = mainDataset, cacheDirectory = path.join(projectRoot, '.data/knowledge-models'), onProgress = () => {} } = {}) {
  const started = performance.now(), startedAt = new Date().toISOString();
  const runtime = await runtimeIdentity(local);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forme-knowledge-eval-'));
  const current = { collections:evaluationCollections(dataset), jobs:[], workspace:{ feedback:{} } };
  const originals = new Map(dataset.documents.map(document => [document.id, document]));
  const groupFor = id => originals.get(id)?.group || id;
  let manager, localClient = null, localRanker = null, successfulEmbeddingCalls = 0, embeddedTexts = 0;
  let successfulRerankingCalls = 0, rerankedPairs = 0, rankingStatusBeforeClose = null;
  const observedScoreKinds = new Set();
  const notify = progress => onProgress({ ...progress, successfulEmbeddingCalls, embeddedTexts, successfulRerankingCalls, rerankedPairs });
  let evidenceTotal = 0, evidenceCorrect = 0;
  const gate = (name, passed, details) => ({ name, status:passed ? 'pass' : 'fail', details });
  const validateEvidence = (collectionId, chunks) => {
    const original = originals.get(collectionId);
    for (const chunk of chunks || []) {
      evidenceTotal++;
      if (original && typeof chunk?.chunkId === 'string' && chunk.chunkId && typeof chunk.locator === 'string' && chunk.locator && typeof chunk.text === 'string' && chunk.text && Number.isSafeInteger(chunk.start) && Number.isSafeInteger(chunk.end) && chunk.start >= 0 && chunk.end > chunk.start && original.body.slice(chunk.start, chunk.end) === chunk.text) evidenceCorrect++;
    }
  };
  try {
    if (local) {
      const [{ createLocalKnowledgeEmbedder }, { createLocalKnowledgeReranker }] = await Promise.all([
        import('../desktop/server/knowledge/local-embeddings.mjs'),
        import('../desktop/server/knowledge/local-reranker.mjs'),
      ]);
      // Evaluation reuses verified model assets; it never silently downloads or
      // falls back to a remote inference endpoint.
      localClient = createLocalKnowledgeEmbedder({ directory, cacheDirectory, localFilesOnly:true, onProgress:state => notify({ stage:'embedding_model', model:state.model, modelStatus:state.status }) });
      localRanker = createLocalKnowledgeReranker({ directory, cacheDirectory, localFilesOnly:true, onProgress:state => notify({ stage:'reranker_model', model:state.model, modelStatus:state.status }) });
    }
    const embedder = localClient ? {
      space:localClient.space,
      async embed(texts, options) {
        const vectors = await localClient.embed(texts, options);
        successfulEmbeddingCalls++; embeddedTexts += texts.length;
        return vectors;
      },
    } : null;
    const reranker = localRanker ? {
      model:localRanker.model,
      status:() => localRanker.status(),
      async rerank(query, items, options) {
        const rows = await localRanker.rerank(query, items, options);
        successfulRerankingCalls++; rerankedPairs += items.length;
        for (const row of rows) if (typeof row.scoreKind === 'string') observedScoreKinds.add(row.scoreKind);
        return rows;
      },
      close:() => localRanker.close(),
    } : null;
    const indexingStarted = performance.now();
    notify({ stage:'indexing' });
    manager = await createKnowledgeManager({ directory, config:local ? { embeddingBackend:'local', embeddingLocalCacheDirectory:cacheDirectory } : {}, getState:() => structuredClone(current), embedder, reranker });
    await manager.idle();
    const indexingMs = performance.now() - indexingStarted;
    const initialStatus = manager.status();
    notify({ stage:'indexing_ready', semanticStatus:initialStatus.semanticStatus });
    const queryLatencies = [], similarLatencies = [], rows = [], similarities = [];
    for (const query of dataset.queries) {
      const routeSkipped = query.category === 'assistant_identity' && !shouldSearchCollections(query.query);
      const began = performance.now();
      const response = routeSkipped ? { items:[], mode:'identity_route' } : await manager.search({ query:query.query, limit:5 });
      const elapsedMs = performance.now() - began;
      if (!routeSkipped) queryLatencies.push(elapsedMs);
      const actualIds = response.items.map(item => item.collectionId);
      const metrics = rankingMetrics(actualIds, query.relevant, groupFor);
      for (const item of response.items) validateEvidence(item.collectionId, item.chunks);
      rows.push({ id:query.id, category:query.category, expectedGroups:Object.keys(query.relevant), actualIds, ...metrics, mode:response.mode, routeSkipped, reranked:response.reranked === true, rerankingFallback:response.rerankingFallback === true, latencyMs:rounded(elapsedMs), signals:response.items.map(item => ({ collectionId:item.collectionId, score:item.score ?? null, semanticScore:item.semanticScore ?? null, rerankScore:item.rerankScore ?? null, rerankLogit:item.rerankLogit ?? null, rerankScoreKind:item.rerankScoreKind ?? null, qualitySource:item.qualitySource ?? null, matchedTermCount:item.matchedTerms?.length || 0, evidencePositions:(item.chunks || []).map(chunk => ({ chunkId:chunk.chunkId, locator:chunk.locator, start:chunk.start, end:chunk.end })) })) });
      notify({ stage:'queries', completed:rows.length, total:dataset.queries.length });
    }
    let excludesAnchor = true, excludesDuplicate = true, twoSidedEvidence = true;
    let scoredOriginalPairs = 0, locatedOriginalPairs = 0;
    for (const scenario of dataset.similarCases) {
      const began = performance.now();
      const response = await manager.findSimilar({ collectionId:scenario.anchor, limit:5 });
      similarLatencies.push(performance.now() - began);
      const anchor = originals.get(scenario.anchor);
      for (const item of response.items) {
        const other = originals.get(item.collectionId);
        excludesAnchor &&= item.collectionId !== scenario.anchor;
        excludesDuplicate &&= other?.group !== anchor.group && other?.body !== anchor.body;
        twoSidedEvidence &&= Boolean(item.chunks?.length && (item.anchorChunks?.length || response.anchor?.chunks?.length));
        if (typeof item.pairedSimilarity === 'number' && Number.isFinite(item.pairedSimilarity)) {
          scoredOriginalPairs++;
          const anchorEvidence = item.anchorChunks || response.anchor?.chunks || [];
          if (item.pairedScoreKind === 'cosine_similarity' && item.chunks?.some(chunk => chunk.chunkId === item.pairedChunkId) && anchorEvidence.some(chunk => chunk.chunkId === item.pairedAnchorChunkId)) locatedOriginalPairs++;
        }
        validateEvidence(item.collectionId, item.chunks);
        validateEvidence(scenario.anchor, item.anchorChunks || response.anchor?.chunks);
      }
      const actualIds = response.items.map(item => item.collectionId);
      similarities.push({ id:scenario.id, anchor:scenario.anchor, expectedGroups:Object.keys(scenario.relevant), actualIds, ...rankingMetrics(actualIds, scenario.relevant, groupFor), mode:response.mode, reranked:response.reranked === true, rerankingFallback:response.rerankingFallback === true, signals:response.items.map(item => ({ collectionId:item.collectionId, documentVersionId:item.documentVersionId ?? null, semanticScore:item.semanticScore ?? null, pairedSimilarity:item.pairedSimilarity ?? null, pairedChunkId:item.pairedChunkId ?? null, pairedAnchorChunkId:item.pairedAnchorChunkId ?? null, pairedScoreKind:item.pairedScoreKind ?? null, rerankScore:item.rerankScore ?? null, rerankLogit:item.rerankLogit ?? null, rerankScoreKind:item.rerankScoreKind ?? null, qualitySource:item.qualitySource ?? null, evidencePositions:(item.chunks || []).map(chunk => ({ chunkId:chunk.chunkId, locator:chunk.locator, start:chunk.start, end:chunk.end })), anchorEvidencePositions:(item.anchorChunks || response.anchor?.chunks || []).map(chunk => ({ chunkId:chunk.chunkId, locator:chunk.locator, start:chunk.start, end:chunk.end })) })) });
      notify({ stage:'similarity', completed:similarities.length, total:dataset.similarCases.length });
    }

    // Probe mutations after relevance scoring, so the labelled corpus stays fixed.
    const probe = dataset.mutationProbe;
    const previous = await manager.readDocument({ collectionId:probe.revisionId, limit:12000 });
    const nextBody = '修订版本独有标记 NEWTEXT82。该文已经改为记录茶叶发酵实验，旧版咖啡冲煮参数只在历史版本中保留。';
    const coffee = current.collections.find(item => item.id === probe.revisionId);
    coffee.input.content = nextBody; coffee.content = nextBody; coffee.sourceRevision = 2;
    await manager.captureSource({ collectionId:probe.revisionId, captureId:'evaluation-revision-2', sourceRevision:2, source:{ title:coffee.title, url:coffee.url, text:nextBody, capturedAt:'2026-12-01T00:00:00Z' } });
    await manager.idle();
    const updated = await manager.readDocument({ collectionId:probe.revisionId, limit:12000 });
    const archived = await manager.readDocument({ collectionId:probe.revisionId, documentVersionId:previous.documentVersionId, limit:12000 });
    const stale = await manager.search({ query:probe.staleQuery, collectionIds:[probe.revisionId], limit:5 });
    const fresh = await manager.search({ query:'NEWTEXT82', collectionIds:[probe.revisionId], limit:5 });
    const revisionSafe = updated.documentVersionId !== previous.documentVersionId && updated.text === nextBody && archived.text === originals.get(probe.revisionId).body && !stale.items.some(item => item.chunks?.some(chunk => probe.staleMarkers.some(marker => chunk.text.includes(marker)))) && fresh.items.some(item => item.collectionId === probe.revisionId);
    current.collections.find(item => item.id === probe.failureId).status = 'failed';
    await manager.sync();
    const sourceSurvivesFailure = (await manager.readDocument({ collectionId:probe.failureId, limit:40000 })).text === originals.get(probe.failureId).body;
    current.collections = current.collections.filter(item => item.id !== probe.deletionId);
    await manager.sync(); await manager.idle();
    const deleted = await manager.search({ query:probe.deletionQuery, limit:5 });
    let readDeleted = false;
    try { await manager.readDocument({ collectionId:probe.deletionId }); }
    catch (error) { readDeleted = error.code === 'NOT_FOUND'; }
    const deletionSafe = readDeleted && !deleted.items.some(item => item.collectionId === probe.deletionId);
    rankingStatusBeforeClose = localRanker ? manager.status()?.rerankingStatus || localRanker.status()?.status || null : null;
    await manager.close(); manager = null;
    manager = await createKnowledgeManager({ directory, config:{}, getState:() => structuredClone(current), embedder:null });
    const persisted = await manager.readDocument({ collectionId:probe.revisionId, documentVersionId:previous.documentVersionId, limit:12000 });
    const reopenSafe = persisted.text === originals.get(probe.revisionId).body;

    const retrieval = summarizeRows(rows);
    const byCategory = Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => [category, summarizeRows(rows.filter(row => row.category === category))]));
    const similarReturnedCount = similarities.reduce((sum, row) => sum + row.returnedCount, 0);
    const similarRelevantReturned = similarities.reduce((sum, row) => sum + row.labelledRelevantReturned, 0);
    const similar = { count:similarities.length, recallAt5:rounded(mean(similarities.map(row => row.recallAt5))), ndcgAt5:rounded(mean(similarities.map(row => row.ndcgAt5))), returnedCount:similarReturnedCount, labelledRelevantReturned:similarRelevantReturned, returnedPrecision:similarReturnedCount ? rounded(similarRelevantReturned / similarReturnedCount) : null, originalPairEvidence:{ scoredPairs:scoredOriginalPairs, locatedPairs:locatedOriginalPairs, allScoredPairsLocated:scoredOriginalPairs === locatedOriginalPairs } };
    const evidenceAccuracy = evidenceTotal ? evidenceCorrect / evidenceTotal : 0;
    const gates = [
      gate('relevant_recall_at_5', retrieval.recallAt5 >= evaluationThresholds.recallAt5, { actual:retrieval.recallAt5, minimum:evaluationThresholds.recallAt5 }),
      gate('relevant_ndcg_at_5', retrieval.ndcgAt5 >= evaluationThresholds.ndcgAt5, { actual:retrieval.ndcgAt5, minimum:evaluationThresholds.ndcgAt5 }),
      gate('unrelated_queries_return_no_results', byCategory.no_result.noResultAccuracy >= evaluationThresholds.noResultAccuracy, { actual:byCategory.no_result.noResultAccuracy }),
      gate('identity_questions_skip_library', byCategory.assistant_identity.noResultAccuracy >= evaluationThresholds.identityAccuracy && rows.filter(row => row.category === 'assistant_identity').every(row => row.routeSkipped), { actual:byCategory.assistant_identity.noResultAccuracy }),
      gate('similar_article_recall_at_5', similar.recallAt5 >= evaluationThresholds.similarRecallAt5, { actual:similar.recallAt5, minimum:evaluationThresholds.similarRecallAt5 }),
      gate('similar_excludes_anchor_and_duplicate', excludesAnchor && excludesDuplicate, { excludesAnchor, excludesDuplicate }),
      gate('two_sided_similarity_evidence', twoSidedEvidence && similarities.some(row => row.actualIds.length), { twoSidedEvidence }),
      gate('evidence_maps_to_original', evidenceAccuracy >= evaluationThresholds.evidenceAccuracy, { checked:evidenceTotal, correct:evidenceCorrect, accuracy:rounded(evidenceAccuracy) }),
      gate('source_revision_and_history', revisionSafe, {}),
      gate('source_survives_understanding_failure', sourceSurvivesFailure, {}),
      gate('deleted_sources_stay_unavailable', deletionSafe, {}),
      gate('originals_survive_reopen', reopenSafe, {}),
      ...(local ? [gate('actual_local_model_executed_and_ready', successfulEmbeddingCalls > 0 && initialStatus.semanticStatus === 'ready', { successfulEmbeddingCalls, semanticStatus:initialStatus.semanticStatus }), gate('actual_local_reranker_executed_and_ready', successfulRerankingCalls > 0 && rankingStatusBeforeClose === 'ready', { successfulRerankingCalls, rankingStatusBeforeClose })] : []),
    ];
    return {
      version:1, suite:'forme-knowledge-retrieval', dataset:dataset.name, datasetVersion:dataset.version,
      datasetHash:createHash('sha256').update(JSON.stringify({ documents:dataset.documents, queries:dataset.queries, similarCases:dataset.similarCases })).digest('hex'),
      labelLimitations:'Synthetic hand labels are incomplete judgements of possible relevance. Returned items outside the labelled source groups are conservatively counted as non-relevant; duplicate copies cannot earn a second gain. ReturnedPrecision uses the actual returned top-five count, so an empty result has no precision denominator and is assessed by recall/no-result gates instead.',
      fixtureMode:local ? 'synthetic-local-model' : 'synthetic-full-text-only',
      realModelCalls:successfulEmbeddingCalls > 0, remoteInference:false,
      runtime, model:localClient ? { ...localClient.space, successfulEmbeddingCalls, embeddedTexts } : null,
      reranker:localRanker ? { model:localRanker.model, successfulRerankingCalls, rerankedPairs, scoreKinds:[...observedScoreKinds], rankingStatusBeforeClose } : null,
      startedAt, completedAt:new Date().toISOString(), durationMs:rounded(performance.now() - started),
      scale:{ documents:dataset.documents.length, uniqueSourceGroups:new Set(dataset.documents.map(document => document.group)).size, sourceCharacters:dataset.documents.reduce((sum, document) => sum + document.body.length, 0), indexedChunks:(initialStatus.storeStats?.items || []).reduce((sum, item) => sum + (item.chunkCount || 0), 0), labelledQueries:dataset.queries.length, similarScenarios:dataset.similarCases.length },
      retrieval, byCategory, similar,
      latency:{ indexingMs:rounded(indexingMs), search:latencyMetrics(queryLatencies), similar:latencyMetrics(similarLatencies), cacheState:'first pass over distinct queries; source indexing completed before queries' },
      gates, status:gates.every(result => result.status === 'pass') ? 'passed' : 'needs_improvement',
      cases:rows, similarCases:similarities,
    };
  } finally {
    try { await manager?.close(); }
    finally { try { await Promise.allSettled([localClient?.close?.(), localRanker?.close?.()]); } finally { await rm(directory, { recursive:true, force:true }); } }
  }
}

export async function writeEvaluationSummary(summary, outputFile = path.join(projectRoot, '.data/knowledge-eval/summary.json')) {
  await mkdir(path.dirname(outputFile), { recursive:true, mode:0o700 });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode:0o600 });
  await rename(temporary, outputFile);
  return outputFile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--local', '--holdout', '--fresh'].includes(arg)) || (args.includes('--holdout') && args.includes('--fresh'))) throw new Error('Usage: node scripts/eval-knowledge.mjs [--local] [--holdout | --fresh]');
  const dataset = args.includes('--fresh') ? freshKnowledgeChallenge : args.includes('--holdout') ? knowledgeHoldoutDataset : mainDataset;
  const prefix = args.includes('--fresh') ? 'fresh-' : args.includes('--holdout') ? 'holdout-' : '';
  const latestFile = path.join(projectRoot, '.data/knowledge-eval', `${prefix}summary.json`);
  const modeFile = path.join(projectRoot, '.data/knowledge-eval', `${prefix}${args.includes('--local') ? 'local' : 'full-text'}-summary.json`);
  const run = { version:1, suite:'forme-knowledge-retrieval', runId:randomUUID(), dataset:dataset.name, fixtureMode:args.includes('--local') ? 'synthetic-local-model' : 'synthetic-full-text-only', realModelCalls:args.includes('--local') ? null : false, remoteInference:false, status:'running', startedAt:new Date().toISOString() };
  let progressWrites = Promise.resolve();
  try {
    await writeEvaluationSummary(run, latestFile);
    await writeEvaluationSummary(run, modeFile);
    const result = await evaluateKnowledge({ local:args.includes('--local'), dataset, onProgress:progress => {
      const update = { ...run, progress };
      progressWrites = progressWrites.then(async () => { await writeEvaluationSummary(update, latestFile); await writeEvaluationSummary(update, modeFile); });
    } });
    const summary = { ...result, runId:run.runId };
    await progressWrites;
    const file = await writeEvaluationSummary(summary, latestFile);
    await writeEvaluationSummary(summary, modeFile);
    await writeEvaluationSummary(summary, path.join(projectRoot, '.data/knowledge-eval/history', `${run.runId}.json`));
    process.stdout.write(`${JSON.stringify({ status:summary.status, dataset:summary.dataset, fixtureMode:summary.fixtureMode, realModelCalls:summary.realModelCalls, model:summary.model, reranker:summary.reranker, retrieval:summary.retrieval, similar:summary.similar, latency:summary.latency, failedGates:summary.gates.filter(gate => gate.status === 'fail').map(gate => gate.name), summary:file }, null, 2)}\n`);
    process.exitCode = summary.status === 'passed' ? 0 : 1;
  } catch (error) {
    const summary = { ...run, status:'error', errorCode:typeof error?.code === 'string' ? error.code : 'EVALUATION_FAILED', completedAt:new Date().toISOString() };
    await progressWrites.catch(() => {});
    await writeEvaluationSummary(summary, latestFile);
    await writeEvaluationSummary(summary, modeFile);
    await writeEvaluationSummary(summary, path.join(projectRoot, '.data/knowledge-eval/history', `${run.runId}.json`));
    process.stderr.write(`Knowledge evaluation failed: ${summary.errorCode}\n`);
    process.exitCode = 1;
  }
}
