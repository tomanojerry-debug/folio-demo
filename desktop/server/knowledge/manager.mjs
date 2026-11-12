import { createHash } from "node:crypto";
import { openKnowledge } from "./store.mjs";
import { createKnowledgeEmbedder } from "./embeddings.mjs";
import { searchTerms, canonicalSourceUrl } from "./tokenize.mjs";

const COOLDOWN_MS = 30000;
const MAX_QUERY_CACHE = 128;
const BATCH_SIZE = 16;
const closedError = () => Object.assign(new Error("Knowledge manager is closed."), { code: "KNOWLEDGE_CLOSED" });
const cancelledError = () => Object.assign(new Error("Knowledge request was cancelled."), { code: "KNOWLEDGE_ABORTED" });
const errorCode = error => typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : "EMBEDDING_UNAVAILABLE";
const requestLimit = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 20) : fallback;
const qualityThreshold = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
const RANK_CACHE_LIMIT = 128;

function distinctSources(items) {
  const seen = new Set();
  return items.filter(item => {
    const url = canonicalSourceUrl(item.url);
    const keys = [item.contentHash && `body:${item.contentHash}`, url && `url:${url}`].filter(Boolean);
    const duplicate = keys.some(key => seen.has(key));
    for (const key of keys) seen.add(key);
    return !duplicate;
  });
}

function modelFamily(space) {
  // Revisions are opaque hashes: an incidental "e5" in a MiniLM commit must
  // never select the query prefix or candidate profile of a different model.
  const repository = String(space?.model || "").replace(/^local:/u, "").split("@", 1)[0].split(":", 1)[0];
  if (/(?:^|\/)(?:multilingual-)?e5(?:-|$)/iu.test(repository)) return "e5";
  if (/minilm/iu.test(repository)) return "minilm";
  return null;
}

function candidateThreshold(space) {
  if (modelFamily(space) === "e5") return 0.70;
  if (modelFamily(space) === "minilm") return 0.15;
  return 0.55;
}

function exactLexicalMatch(query, item) {
  if (item.lexicalScore === null || item.lexicalScore === undefined) return null;
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase();
  const compact = value => normalize(value).replace(/[\p{P}\p{Z}\s]/gu, "");
  const title = compact(item.title), question = compact(query);
  if (title.length >= 2 && question.includes(title)) return "exact_title";
  const identifiers = normalize(query).match(/\b(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*[0-9])[a-z0-9][a-z0-9_-]{4,}\b/gu) || [];
  const haystack = ` ${normalize(`${item.title || ""}\n${(item.chunks || []).map(chunk => chunk.text).join("\n")}`)} `;
  if (identifiers.some(identifier => new RegExp(`(?:^|[^a-z0-9_-])${identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^a-z0-9_-])`, "u").test(haystack))) return "exact_identifier";
  return null;
}

// Chat messages do not affect the knowledge projection. The signature tracks
// exactly the persisted source/understanding inputs that reconciliation uses.
function knowledgeSignature(state) {
  const collections = (state.collections || []).map(item => Object.fromEntries([
    "id", "title", "url", "type", "content", "input", "extraction", "sourceRevision", "status", "knowledgeDocumentVersionId", "understandingDocumentVersionId",
  ].filter(key => item[key] !== undefined).map(key => [key, item[key]])));
  const jobs = (state.jobs || []).filter(job => job.harness?.checkpoints?.source?.value).map(job => ({
    id: job.id, collectionId: job.collectionId, retryRootId: job.retryRootId,
    targetSourceRevision: job.targetSourceRevision, source: job.harness.checkpoints.source.value,
  }));
  return createHash("sha256").update(JSON.stringify({ collections, jobs, feedback: state.workspace?.feedback || {} })).digest("hex");
}

/**
 * Serializes durable local changes independently of optional remote embedding
 * work. Every queued reconciliation reads current state at execution time.
 */
export async function createKnowledgeManager({ directory, config = {}, getState, onChange, embedder, reranker } = {}) {
  if (typeof getState !== "function") throw new TypeError("A current knowledge state reader is required.");
  if (reranker !== undefined && reranker !== null && typeof reranker.rerank !== "function") throw new TypeError("The knowledge reranker must provide a rerank function.");
  const client = embedder !== undefined ? embedder : config.embeddingBackend === "local"
    ? (await import("./local-embeddings.mjs")).createLocalKnowledgeEmbedder({ directory, cacheDirectory: config.embeddingLocalCacheDirectory })
    : config.embeddingBackend === "disabled" ? null : createKnowledgeEmbedder(config);
  if (client && (typeof client.embed !== "function" || typeof client.space?.model !== "string" || !client.space.model || !Number.isSafeInteger(client.space.dimensions) || client.space.dimensions < 1 || client.space.dimensions > 4096)) throw new TypeError("The knowledge embedder must provide a valid space and embed function.");
  const space = client ? Object.freeze({ model: client.space.model, dimensions: client.space.dimensions }) : null;
  const store = await openKnowledge({ directory });
  const controller = new AbortController();
  const queryCache = new Map(), queryRequests = new Set();
  const rankCache = new Map(), rankRequests = new Set(), operations = new Set();
  const rankingEnabled = Boolean(client && (reranker !== undefined ? reranker : config.embeddingBackend === "local"));
  let rankClient = reranker || null, rankClientPromise;
  let rankFailureCode = null, rankCooldownUntil = 0, rankState = rankingEnabled ? "not_loaded" : "unconfigured";
  let tail = Promise.resolve(), background = null, closing = false, closePromise;
  let lastSignature, storeStats = {}, cachedStatus, cachedStatusText;
  let failureCode = null, cooldownUntil = 0, indexRequested = false;

  function publish() {
    const pending = Number(storeStats.documents || 0) > Number(storeStats.semanticReady || 0);
    const semanticStatus = !client ? "unconfigured" : failureCode ? "unavailable" : background || pending ? "indexing" : "ready";
    const next = {
      semanticStatus, embeddingConfigured: Boolean(client), embeddingBackend: client ? space.model.startsWith("local:") ? "local" : "remote" : "disabled", space,
      storeStats,
      ...(failureCode ? { lastErrorCode: failureCode } : {}),
      rerankingStatus: rankState,
      ...(rankFailureCode ? { lastRerankingErrorCode: rankFailureCode } : {}),
    };
    const serialized = JSON.stringify(next);
    if (serialized === cachedStatusText) return;
    cachedStatus = structuredClone(next); cachedStatusText = serialized;
    try { onChange?.(); } catch {}
  }

  async function refreshStats() {
    storeStats = await store.status(space ? { space } : {});
    publish();
  }

  function enqueue(operation) {
    if (closing) return Promise.reject(closedError());
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }

  function track(operation) {
    if (closing) return Promise.reject(closedError());
    const request = Promise.resolve().then(operation);
    operations.add(request);
    request.then(() => operations.delete(request), () => operations.delete(request));
    return request;
  }

  async function reconcileCurrent() {
    const state = await getState();
    const signature = knowledgeSignature(state);
    if (signature === lastSignature) return { unchanged: true };
    const result = await store.reconcile(state);
    lastSignature = signature;
    await refreshStats();
    return { ...result, unchanged: false };
  }

  function providerFailed(error) {
    if (closing) return;
    failureCode = errorCode(error);
    cooldownUntil = Date.now() + COOLDOWN_MS;
    publish();
  }

  function providerSucceeded() {
    failureCode = null; cooldownUntil = 0;
    publish();
  }

  // The manager also races shutdown, so an injected or malfunctioning provider
  // that ignores AbortSignal cannot keep the desktop service alive indefinitely.
  function requireActive(signal) {
    if (controller.signal.aborted) throw closedError();
    if (signal?.aborted) throw cancelledError();
  }

  async function cancellable(operation, signal) {
    requireActive(signal);
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let onAbort;
    const cancellation = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.aborted ? closedError() : cancelledError());
      combined.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        requireActive(signal);
        return operation(combined);
      }), cancellation]);
    } finally { combined.removeEventListener("abort", onAbort); }
  }

  async function embedTexts(texts, role = "passage", signal) {
    return cancellable(activeSignal => client.embed(texts, { signal: activeSignal, role }), signal);
  }

  async function getRankClient() {
    if (rankClient) return rankClient;
    if (!rankingEnabled) return null;
    if (!rankClientPromise) rankClientPromise = (async () => {
      const { createLocalKnowledgeReranker } = await import("./local-reranker.mjs");
      const created = createLocalKnowledgeReranker({ directory, cacheDirectory: config.embeddingLocalCacheDirectory, onProgress() { publish(); } });
      if (closing) { await created.close(); throw closedError(); }
      rankClient = created;
      return created;
    })().catch(error => { rankClientPromise = null; throw error; });
    return rankClientPromise;
  }

  async function rankPairs(query, pairs, signal) {
    requireActive(signal);
    const key = createHash("sha256").update(JSON.stringify({ query, pairs })).digest("hex");
    if (rankCache.has(key)) {
      const cached = rankCache.get(key);
      rankCache.delete(key); rankCache.set(key, cached);
      return cached;
    }
    if (Date.now() < rankCooldownUntil) throw Object.assign(new Error("Reranking is temporarily unavailable."), { code: rankFailureCode || "RERANKING_UNAVAILABLE" });
    // Only completed results are shared. Each live request owns its inference
    // and cancellation, so timing out one caller cannot abort another caller.
    const request = (async () => {
      try {
        rankState = "ranking"; publish();
        const result = await cancellable(async activeSignal => {
          const active = await getRankClient();
          requireActive(signal);
          return active.rerank(query, pairs, { signal: activeSignal });
        }, signal);
        const known = new Set(pairs.map(pair => pair.id)), seen = new Set();
        let valid = Array.isArray(result) && result.length === pairs.length;
        if (valid) for (const item of result) {
          if (!known.has(item?.id) || seen.has(item.id) || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) { valid = false; break; }
          seen.add(item.id);
        }
        if (!valid) throw Object.assign(new Error("Reranking output is invalid."), { code: "RERANKING_OUTPUT_INVALID" });
        requireActive(signal);
        rankCache.set(key, result);
        if (rankCache.size > RANK_CACHE_LIMIT) rankCache.delete(rankCache.keys().next().value);
        rankState = "ready"; rankFailureCode = null; rankCooldownUntil = 0; publish();
        return result;
      } catch (error) {
        if (closing) throw closedError();
        if (signal?.aborted || error?.code === "KNOWLEDGE_ABORTED") {
          rankState = rankRequests.size > 1 ? "ranking" : rankClient ? "ready" : "not_loaded"; publish();
          throw cancelledError();
        }
        rankState = "unavailable"; rankFailureCode = errorCode(error); rankCooldownUntil = Date.now() + COOLDOWN_MS; publish();
        throw error;
      } finally {
        rankRequests.delete(request);
        if (rankRequests.size && rankState === "ready") { rankState = "ranking"; publish(); }
      }
    })();
    rankRequests.add(request);
    return request;
  }

  function passagePairs(items) {
    const pairs = [], sourceFor = new Map(), chunkFor = new Map();
    for (const item of items) for (const chunk of (item.chunks || []).slice(0, 2)) {
      if (!chunk.text) continue;
      const id = `pair:${createHash("sha256").update(`${item.collectionId}\0${item.documentVersionId}\0${chunk.chunkId}\0${chunk.text}`).digest("hex").slice(0, 40)}`;
      pairs.push({ id, text: `${item.title || ""}\n${chunk.text}` }); sourceFor.set(id, item.collectionId); chunkFor.set(id, chunk.chunkId);
    }
    return { pairs, sourceFor, chunkFor };
  }

  function preferChunk(chunks, chunkId) {
    return [...(chunks || [])].sort((a, b) => Number(b.chunkId === chunkId) - Number(a.chunkId === chunkId));
  }

  function preserveChunkOrder(chunks, preferred) {
    const positions = new Map((preferred || []).map((chunk, index) => [chunk.chunkId, index]));
    return [...(chunks || [])].sort((a, b) => (positions.get(a.chunkId) ?? Infinity) - (positions.get(b.chunkId) ?? Infinity) || a.start - b.start);
  }

  async function qualify(query, response, threshold, limit, signal) {
    requireActive(signal);
    const { pairs, sourceFor, chunkFor } = passagePairs(response.items);
    if (!pairs.length) return { ...response, items: response.items.filter(item => !item.chunks?.length && item.lexicalScore !== null).slice(0, limit), reranked: false };
    const scores = await rankPairs(query, pairs, signal), best = new Map();
    for (const score of scores) {
      const source = sourceFor.get(score.id);
      if (!best.has(source) || score.score > best.get(source).score) best.set(source, { ...score, chunkId: chunkFor.get(score.id) });
    }
    const items = distinctSources(response.items.filter(item => {
      if (!item.chunks?.length) return item.coverage === "unavailable" && item.lexicalScore !== null;
      if (exactLexicalMatch(query, item)) return true;
      const relevance = best.get(item.collectionId)?.score ?? -1;
      if (relevance < threshold) return false;
      // A weak QA match plus a weak dense match is insufficient. Keep strong
      // cross-language secondary sources; a query-wide relative score cutoff
      // would suppress them whenever one source answers much more directly.
      return relevance >= 0.1 || item.semanticScore === null || item.semanticScore === undefined || item.semanticScore >= 0.3;
    }).map(item => {
      const score = best.get(item.collectionId);
      return { ...item, chunks: preferChunk(item.chunks, score?.chunkId), qualitySource: exactLexicalMatch(query, item) || "reranked", ...(score ? { rerankScore: score.score, rerankChunkId: score.chunkId, ...(Number.isFinite(score.logit) ? { rerankLogit: score.logit } : {}), rerankScoreKind: score.scoreKind || "relevance_score" } : {}) };
    }).sort((a, b) => Number(b.qualitySource !== "reranked") - Number(a.qualitySource !== "reranked") || (b.rerankScore ?? 0) - (a.rerankScore ?? 0) || b.score - a.score || a.collectionId.localeCompare(b.collectionId))).slice(0, limit);
    return { ...response, items, reranked: true };
  }

  async function qualifySimilarity(topic, response, threshold, limit, signal) {
    requireActive(signal);
    const { pairs, sourceFor, chunkFor } = passagePairs(response.items);
    const { pairs: anchorPairs, chunkFor: anchorChunkFor } = passagePairs([response.anchor]);
    if (!pairs.length || !anchorPairs.length) return { ...response, items: [], reranked: false };
    const forward = await rankPairs(topic, pairs, signal), best = new Map(), forwardBest = new Map(), reverseBest = new Map();
    for (const score of forward) {
      const source = sourceFor.get(score.id);
      const value = { ...score, chunkId: chunkFor.get(score.id), direction: "anchor_title" };
      if (!forwardBest.has(source) || score.score > forwardBest.get(source).score) forwardBest.set(source, value);
      if (!best.has(source) || score.score > best.get(source).score) best.set(source, value);
    }
    // Passage-ranking is asymmetric. For related documents, compare each short
    // title to the other source's actual passages in both directions. A long
    // article used as a query saturates relevance models on generic overlap.
    await Promise.all(response.items.map(async item => {
      const reverse = await rankPairs(String(item.title || "").trim().slice(0, 300), anchorPairs, signal);
      for (const score of reverse) {
        const value = { ...score, chunkId: anchorChunkFor.get(score.id), direction: "candidate_title" };
        if (!reverseBest.has(item.collectionId) || score.score > reverseBest.get(item.collectionId).score) reverseBest.set(item.collectionId, value);
        if (!best.has(item.collectionId) || score.score > best.get(item.collectionId).score) best.set(item.collectionId, value);
      }
    }));
    const items = distinctSources(response.items.filter(item => Number.isFinite(item.pairedSimilarity)
      && (item.pairedSimilarity >= 0.45 || (item.pairedSimilarity >= 0.35 && (best.get(item.collectionId)?.score ?? -1) >= threshold))).map(item => {
      const score = best.get(item.collectionId);
      const chunkId = item.pairedChunkId || forwardBest.get(item.collectionId)?.chunkId;
      const anchorChunkId = item.pairedAnchorChunkId || reverseBest.get(item.collectionId)?.chunkId;
      return { ...item, chunks: preferChunk(item.chunks, chunkId), anchorChunks: preferChunk(item.anchorChunks || response.anchor.chunks, anchorChunkId), rerankScore: score.score,
        rerankChunkId:forwardBest.get(item.collectionId)?.chunkId, rerankAnchorChunkId:reverseBest.get(item.collectionId)?.chunkId,
        ...(Number.isFinite(score.logit) ? { rerankLogit: score.logit } : {}), rerankScoreKind: score.scoreKind || "relevance_score", rerankDirection: score.direction,
        qualitySource:item.pairedSimilarity >= 0.45 ? "source_pair_semantic" : "source_pair_with_title" };
    }).sort((a, b) => b.pairedSimilarity - a.pairedSimilarity || b.rerankScore - a.rerankScore || b.score - a.score || a.collectionId.localeCompare(b.collectionId))).slice(0, limit);
    return { ...response, items, reranked: true };
  }

  // Model inference runs outside the write queue. Read the current version and
  // understanding again afterwards so a delayed answer cannot revive a source
  // or expose the previous summary after correction.
  async function currentResults(response, signal) {
    return enqueue(async () => {
      requireActive(signal);
      await reconcileCurrent();
      const items = [];
      for (const item of response.items) {
        requireActive(signal);
        let current;
        try { current = await store.readDocument({ collectionId: item.collectionId, chunkIds: (item.chunks || []).map(chunk => chunk.chunkId), limit: 12000 }); }
        catch (error) { if (error.code === "NOT_FOUND") continue; throw error; }
        if (current.documentVersionId !== item.documentVersionId) continue;
        const available = new Set(searchTerms(`${current.title}\n${current.summary || ""}\n${(current.concepts || []).join(" ")}\n${(current.chunks || []).map(chunk => chunk.text).join("\n")}`, { limit: 100000 }));
        const matchedTerms = (item.matchedTerms || []).filter(term => available.has(term));
        items.push({ ...item, title: current.title, url: current.url, summary: current.summary || "", concepts: current.concepts || [], understandingRevision: current.understandingRevision || null, chunks: preserveChunkOrder(current.chunks, item.chunks), matchedTerms,
          matchReasons: [...(matchedTerms.length ? [`共同线索：${matchedTerms.slice(0, 5).join("、")}`] : []), ...(item.semanticScore !== null && item.semanticScore !== undefined ? ["语义内容相近"] : []), ...(item.rerankScore !== undefined ? ["经原文相关性重排"] : []), ...(current.coverage === "unavailable" ? ["标题匹配；尚未取得原文"] : [])] });
      }
      let anchor = response.anchor;
      if (anchor) {
        let current;
        try { current = await store.readDocument({ collectionId: anchor.collectionId, chunkIds: (anchor.chunks || []).map(chunk => chunk.chunkId), limit: 12000 }); }
        catch (error) {
          if (error.code === "NOT_FOUND") return { ...response, anchor: { collectionId: anchor.collectionId, documentVersionId: null, title: "", coverage: "unavailable", chunks: [] }, items: [], semanticStatus: api.status().semanticStatus, rerankingStatus: rankState };
          throw error;
        }
        if (current.documentVersionId !== anchor.documentVersionId) return { ...response, anchor: current, items: [] };
        anchor = { ...anchor, summary: current.summary || "", concepts: current.concepts || [], understandingRevision: current.understandingRevision || null, chunks: preserveChunkOrder(current.chunks, anchor.chunks) };
        for (const item of items) {
          if (!item.anchorChunks?.length) continue;
          const proof = await store.readDocument({ collectionId: anchor.collectionId, chunkIds: item.anchorChunks.map(chunk => chunk.chunkId), limit: 12000 });
          item.anchorChunks = preserveChunkOrder(proof.chunks, item.anchorChunks);
        }
      }
      requireActive(signal);
      return { ...response, ...(anchor ? { anchor } : {}), items:distinctSources(items), semanticStatus: api.status().semanticStatus, rerankingStatus: rankState };
    });
  }

  function scheduleIndex() {
    if (!client || closing) return;
    indexRequested = true;
    if (background || Date.now() < cooldownUntil) return;
    const work = (async () => {
      // Start after background is assigned, so status correctly reports work.
      await Promise.resolve();
      try {
        do {
          indexRequested = false;
          while (!closing) {
            const items = await enqueue(async () => {
              await reconcileCurrent();
              return store.embeddingWork({ space, limit: BATCH_SIZE });
            });
            if (!items.length || closing) break;
            const vectors = await embedTexts(items.map(item => item.text));
            if (!Array.isArray(vectors) || vectors.length !== items.length) throw Object.assign(new Error("Embedding result count is invalid."), { code: "EMBEDDING_OUTPUT_INVALID" });
            if (closing) break;
            await enqueue(async () => {
              // Deletions and new versions may have arrived during the request.
              // Reconcile them before accepting any delayed embedding result.
              await reconcileCurrent();
              await store.writeEmbeddings({ space, items: items.map((item, index) => ({ id: item.id, documentVersionId: item.documentVersionId, vector: vectors[index] })) });
              await refreshStats();
            });
            providerSucceeded();
          }
        } while (indexRequested && !closing);
      } catch (error) { providerFailed(error); }
      finally {
        background = null;
        publish();
        if (indexRequested && !closing && Date.now() >= cooldownUntil) scheduleIndex();
      }
    })();
    background = work;
    publish();
  }

  async function sync() {
    const result = await enqueue(reconcileCurrent);
    scheduleIndex();
    return result;
  }

  async function queryVector(query, signal) {
    requireActive(signal);
    if (!client || !query.trim()) return undefined;
    const key = `${space.model}:${space.dimensions}\0${query}`;
    if (queryCache.has(key)) {
      const vector = queryCache.get(key);
      queryCache.delete(key); queryCache.set(key, vector);
      return vector;
    }
    if (Date.now() < cooldownUntil) return undefined;
    const request = (async () => {
      try {
        const vectors = await embedTexts([query], "query", signal);
        const norm = Array.isArray(vectors?.[0]) ? Math.hypot(...vectors[0]) : 0;
        if (!Array.isArray(vectors) || vectors.length !== 1 || !Array.isArray(vectors[0]) || vectors[0].length !== space.dimensions || vectors[0].some(value => !Number.isFinite(value)) || !Number.isFinite(norm) || norm === 0) throw Object.assign(new Error("Query embedding is invalid."), { code: "EMBEDDING_OUTPUT_INVALID" });
        requireActive(signal);
        queryCache.set(key, vectors[0]);
        if (queryCache.size > MAX_QUERY_CACHE) queryCache.delete(queryCache.keys().next().value);
        providerSucceeded();
        scheduleIndex();
        return vectors[0];
      } catch (error) {
        if (closing) throw closedError();
        if (signal?.aborted || error?.code === "KNOWLEDGE_ABORTED") throw cancelledError();
        providerFailed(error);
        return undefined;
      } finally { queryRequests.delete(request); }
    })();
    queryRequests.add(request);
    return request;
  }

  async function mutate(method, args) {
    const result = await enqueue(async () => {
      await reconcileCurrent();
      const value = await store[method](args);
      await refreshStats();
      return value;
    });
    scheduleIndex();
    return result;
  }

  const api = {
    sync,
    captureSource: args => mutate("captureSource", args),
    attachUnderstanding: args => mutate("attachUnderstanding", args),
    async readDocument(args) {
      await sync();
      return enqueue(async () => { await reconcileCurrent(); return store.readDocument(args); });
    },
    curationDocuments({ collectionId, collectionIds, usedCollectionIds } = {}) {
      return enqueue(async () => {
        await reconcileCurrent();
        return store.curationDocuments({ collectionId, collectionIds, usedCollectionIds, ...(space ? { space } : {}) });
      });
    },
    getConcepts(args = {}) {
      return track(async () => {
        await sync();
        return enqueue(async () => { await reconcileCurrent(); return store.getConcepts(args); });
      });
    },
    getConnections(args = {}, { signal } = {}) {
      return track(async () => {
        requireActive(signal);
        await sync();
        const limit = requestLimit(args.limit, 8);
        const blocked = (state, id) => ["pending_rewrite", "confirmed_edited"].includes(state.workspace?.feedback?.[`understanding:${id}`]?.decision);
        const filterCurrent = async graph => {
          const latest = await getState();
          requireActive(signal);
          const visible = new Map((latest.collections || []).map(item => [item.id, item]));
          const anchorItem = visible.get(args.collectionId);
          if (!anchorItem || blocked(latest, args.collectionId)
            || (anchorItem.knowledgeDocumentVersionId && anchorItem.knowledgeDocumentVersionId !== graph.anchor.documentVersionId)
            || graph.anchor.sourceRevision < (anchorItem.sourceRevision || 1)) return { ...graph, anchor:{ ...graph.anchor, concepts:[], summary:"" }, items:[] };
          const items = distinctSources(graph.items.filter(item => {
            const current = visible.get(item.collectionId);
            if (!current || blocked(latest, item.collectionId) || item.sourceRevision < (current.sourceRevision || 1)
              || (current.knowledgeDocumentVersionId && current.knowledgeDocumentVersionId !== item.documentVersionId)) return false;
            if (item.relationType === "shared_concept" && (anchorItem.status !== "ready" || current.status !== "ready"
              || graph.anchor.understandingRevision !== (anchorItem.extraction?.revision || 1)
              || item.understandingRevision !== (current.extraction?.revision || 1))) return false;
            return true;
          })).slice(0, limit);
          return { ...graph, items };
        };
        const readGraph = () => enqueue(async () => {
          requireActive(signal);
          await reconcileCurrent();
          return filterCurrent(await store.getConnections({ collectionId:args.collectionId, limit }));
        });
        const first = await readGraph();
        if (!limit || !first.anchor.documentVersionId || first.items.length >= limit) return first;
        if (blocked(await getState(), args.collectionId)) return { ...first, items:[] };
        let similar;
        try { similar = await api.findSimilar({ collectionId:args.collectionId, limit }, { signal }); }
        catch (error) {
          requireActive(signal);
          if (!["KNOWLEDGE_SOURCE_UNAVAILABLE", "NOT_FOUND"].includes(error.code)) throw error;
          return readGraph();
        }
        return enqueue(async () => {
          requireActive(signal);
          await reconcileCurrent();
          const graph = await store.getConnections({ collectionId:args.collectionId, limit });
          const state = await getState();
          if (blocked(state, args.collectionId)) return { ...graph, items:[] };
          if (graph.anchor.documentVersionId !== similar.anchor.documentVersionId) return graph;
          const seen = new Set(graph.items.map(item => item.collectionId)), additions = [];
          for (const item of similar.items) {
            if (seen.has(item.collectionId) || blocked(state, item.collectionId) || !item.chunks?.length || !item.anchorChunks?.length) continue;
            let current;
            try { current = await store.readDocument({ collectionId:item.collectionId, chunkIds:item.chunks.map(chunk => chunk.chunkId), limit:12000 }); }
            catch (error) { if (error.code === "NOT_FOUND") continue; throw error; }
            if (current.documentVersionId !== item.documentVersionId) continue;
            additions.push({ ...item, summary:current.summary || "", understandingRevision:current.understandingRevision || null,
              chunks:preserveChunkOrder(current.chunks, item.chunks), relationType:"related_topic", concepts:[],
              matchReasons:["原文内容相近；这是相关性线索"] });
            seen.add(item.collectionId);
          }
          requireActive(signal);
          return filterCurrent({ ...graph, items:[...graph.items, ...additions], mode:additions.length ? "graph_and_similarity" : graph.mode });
        });
      });
    },
    search(args = {}, { signal } = {}) {
      return track(async () => {
        requireActive(signal);
        await sync();
        requireActive(signal);
        const query = typeof args.query === "string" ? args.query.trim().slice(0, 8000) : "";
        const limit = requestLimit(args.limit, 6);
        const vector = limit && Number(storeStats.documents || 0) > 0 ? await queryVector(query, signal) : undefined;
        const ranked = Boolean(rankingEnabled && vector && limit);
        const result = await enqueue(async () => {
          requireActive(signal);
          await reconcileCurrent();
          return store.search({ ...args, query, limit:limit ? Math.min(20, Math.max(12, limit * 3)) : 0, ...(vector ? { vector, space, ...(ranked ? { minSimilarity: candidateThreshold(space) } : {}) } : { vector: undefined, space: undefined }) });
        });
        if (!ranked) return currentResults({ ...result, items:distinctSources(result.items).slice(0, limit) }, signal);
        try { return currentResults(await qualify(query, result, qualityThreshold(config.rerankingMinScore, 0.01), limit, signal), signal); }
        catch (error) {
          if (closing) throw closedError();
          requireActive(signal);
          const fallback = await enqueue(async () => { await reconcileCurrent(); return store.search({ ...args, query, vector: undefined, space: undefined, limit }); });
          return currentResults({ ...fallback, reranked: false, rerankingFallback: true }, signal);
        }
      });
    },
    findSimilar(args = {}, { signal } = {}) {
      return track(async () => {
        requireActive(signal);
        await sync();
        requireActive(signal);
        const limit = requestLimit(args.limit, 5);
        if (!rankingEnabled || !limit) {
          const result = await enqueue(async () => { await reconcileCurrent(); return store.findSimilar({ ...args, limit, space: space || undefined }); });
          return currentResults(result, signal);
        }
        const anchor = await enqueue(async () => { await reconcileCurrent(); return store.readDocument({ collectionId: args.collectionId, limit: 1800 }); });
        if (!anchor.documentVersionId) throw Object.assign(new Error("这条收藏还没有可供比较的原文。"), { code: "KNOWLEDGE_SOURCE_UNAVAILABLE" });
        // A document is not a relevance question. Keep the query to its short
        // topic identity instead of concatenating declarations from its body.
        const topic = String(anchor.title || "").trim().slice(0, 300);
        const vector = modelFamily(space) === "e5" ? await queryVector(topic, signal) : undefined;
        const result = await enqueue(async () => {
          requireActive(signal);
          await reconcileCurrent();
          return store.findSimilar({ ...args, limit: Math.min(20, Math.max(12, limit * 3)), space: space || undefined, ...(vector ? { vector } : {}), minSimilarity: candidateThreshold(space) });
        });
        if (result.anchor.documentVersionId !== anchor.documentVersionId) return currentResults({ ...result, items: [] }, signal);
        if (result.mode === "full_text") return currentResults({ ...result, items:distinctSources(result.items).slice(0, limit) }, signal);
        try { return currentResults(await qualifySimilarity(topic, result, qualityThreshold(config.similarityRerankingMinScore, 0.05), limit, signal), signal); }
        catch (error) {
          if (closing) throw closedError();
          requireActive(signal);
          const fallback = await enqueue(async () => { await reconcileCurrent(); return store.findSimilar({ ...args, limit, vector: undefined, space: undefined }); });
          return currentResults({ ...fallback, reranked: false, rerankingFallback: true }, signal);
        }
      });
    },
    status() { return structuredClone(cachedStatus); },
    async idle() {
      for (;;) {
        const before = tail, indexing = background, requests = [...queryRequests.values(), ...rankRequests.values(), ...operations];
        await Promise.allSettled([before, ...(indexing ? [indexing] : []), ...requests]);
        if (before === tail && !background && !queryRequests.size && !rankRequests.size && !operations.size) return;
      }
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; indexRequested = false; controller.abort();
      closePromise = (async () => {
        await Promise.allSettled([tail, ...(background ? [background] : []), ...queryRequests.values(), ...rankRequests.values(), ...operations]);
        await tail;
        try { await store.flush(); }
        finally {
          try { await store.close(); }
          finally {
            const results = await Promise.allSettled([Promise.resolve().then(() => client?.close?.()), Promise.resolve().then(() => rankClient?.close?.())]);
            const failure = results.find(result => result.status === "rejected");
            if (failure) throw failure.reason;
          }
        }
      })();
      return closePromise;
    },
  };
  publish();
  try { await sync(); }
  catch (error) { await api.close(); throw error; }
  return api;
}
