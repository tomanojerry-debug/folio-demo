import { createHash } from 'node:crypto';
import { setImmediate as yieldToDesktop } from 'node:timers/promises';
import { classifyCurationCandidates } from './curation-clusters.mjs';

const revision = 1;
const scanRevision = 5;
const maxSources = 6;
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity:'sentence' });
const sourceNavigationLabel = /^(?:paper|code|docs?|data(?: viewer)?|slides|twitter|discord|github|project page|abstract|正文|摘要|目录)$/iu;
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const indexedVersion = (version, id) => `${scanRevision}:${version}:${id}`;
const references = topic => topic.curationReading?.sources || [];
const editionVersion = topic => topic.curationVersion || 1;
const scopeId = (key, ids) => digest(JSON.stringify([key, [...ids].sort()]));
const topicKeys = topic => [topic.topicKey, ...(topic.curationTopicKeys || [])];
const sourceLabel = ({ id, title, publisher }) => ({ id, title, publisher });
const savedSources = exhibitions => exhibitions.filter(topic => topic.kind === 'local-topic').flatMap(references);

function sameTopicSources(left, right) {
  const a = references(left), b = references(right);
  return a.length === b.length && a.every(source => b.some(other => other.id === source.id && other.documentVersionId === source.documentVersionId));
}

function readingPointText(body, { quote, start, end }) {
  const flatten = value => value.replace(/\s+/gu, ' ');
  const plain = value => value.trim().replace(/\*\*([^*]+)\*\*/gu, '$1');
  const complete = value => {
    const sentence = plain(value);
    return /^[\p{Lu}\p{Lt}\p{Script=Han}\d“"‘'(]/u.test(sentence) && /[.!?。！？][”’"')]*$/u.test(sentence);
  };
  if (complete(quote)) return plain(flatten(quote));

  // Some articles use blank lines for visual line wraps. Recover the full
  // sentence for the reading point while keeping the exact anchor in the reader.
  let left = Math.max(0, start - 500);
  const label = [...body.slice(left, start).matchAll(/[^\n]+/gu)].findLast(line => sourceNavigationLabel.test(line[0].trim()));
  if (label) left += label.index + label[0].length;
  const window = flatten(body.slice(left, end + 500));
  const offset = flatten(body.slice(left, start)).length;
  const segment = sentenceSegmenter.segment(window).containing(offset);
  const candidate = segment?.segment.trim();
  if (candidate && candidate.length <= 420 && complete(candidate)
    && (left === 0 || label || segment.index > 0) && candidate.includes(flatten(quote))) return plain(candidate);
  return plain(flatten(quote));
}

function currentSource(item, source) {
  return item && !item.pendingPageCapture
    && (item.sourceRevision || 1) === source.sourceRevision
    && (!item.knowledgeDocumentVersionId || item.knowledgeDocumentVersionId === source.documentVersionId);
}

export function currentLocalTopic(topic, collections) {
  if (topic.kind !== 'local-topic') return true;
  if (topic.curationRevision !== revision || references(topic).length < 3) return false;
  return references(topic).every(source => currentSource(collections.get(source.id), source));
}

function prepareTopic(result, documents, createdAt, requestedIds) {
  const documentMap = new Map(documents.map(document => [document.collectionId, document]));
  const entries = [];
  for (const source of result.sources.slice(0, maxSources)) {
    const document = documentMap.get(source.collectionId);
    if (!document || source.documentVersionId !== document.documentVersionId) return null;
    const id = source.collectionId;
    const passages = source.evidence.slice(0, 3).flatMap(passage => {
      const { start, end, text } = passage;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
        || typeof text !== 'string' || !text.trim() || document.text.slice(start, end) !== text) return [];
      return [{ id:`ev-${digest(`${document.documentVersionId}:${start}:${end}`)}`, sourceId:id,
        documentVersionId:document.documentVersionId, quote:text, start, end, locator:passage.locator || '收藏原文' }];
    });
    if (!passages.length) return null;
    const publishedAt = typeof source.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(source.publishedAt) ? source.publishedAt : '';
    entries.push({ source:{ id, title:source.title || document.title, publisher:source.publisher || new URL(document.url).hostname,
      url:document.url, documentVersionId:document.documentVersionId, sourceRevision:document.sourceRevision, publishedAt },
    passages });
  }
  if (entries.length < 3) return null;
  entries.sort((a, b) => (a.source.publishedAt || '9999').localeCompare(b.source.publishedAt || '9999') || a.source.url.localeCompare(b.source.url));

  const sources = entries.map(entry => entry.source);
  const evidence = entries.flatMap(entry => entry.passages);
  const collectionIds = sources.map(source => source.id);
  const point = (source, passage, title = source.publisher) => ({
    title, text:readingPointText(documentMap.get(source.id).text, passage), evidenceIds:[passage.id],
  });
  const freshLead = entries.find(({ source }) => source.id === result.continuationSourceId);
  const overview = (freshLead ? [freshLead, ...entries.filter(entry => entry !== freshLead)] : entries)
    .slice(0, 3).map(({ source, passages }) => point(source, passages[0]));
  const comparison = entries.map(({ source, passages }) => point(source, passages[1] || passages[0], source.title));
  const timeline = entries.filter(({ source }) => source.publishedAt).map(({ source, passages }) => ({
    ...point(source, passages[0], source.title), date:source.publishedAt,
  }));
  const deepDive = entries.flatMap(({ source, passages }) => {
    const additional = timeline.length >= 2 && source.publishedAt ? passages.slice(1) : passages;
    return additional.map(passage => point(source, passage, source.title));
  });
  const topicKey = result.topic.key || `${result.topic.kind}:${result.topic.label.normalize('NFKC').toLowerCase()}`;
  const heading = result.topic.label;
  const curationScopeId = requestedIds && scopeId(topicKey, requestedIds);
  return {
    id:`local-topic-${curationScopeId || scopeId('automatic', collectionIds)}`, kind:'local-topic', curationRevision:revision, curationScanRevision:scanRevision, topicKey,
    curationTopic:result.topic,
    ...(requestedIds ? { curationScope:'selected', curationScopeId, curationRequestedIds:[...requestedIds].sort() } : {}),
    status:'preview', title:heading, createdAt, updatedAt:createdAt,
    collectionIds, sourceCollectionIds:collectionIds, rooms:[],
    curationReading:{ topicKind:result.topic.kind, sources, evidence,
      overview,
      comparison:[{ title:'各来源提供的证据', entries:comparison }],
      timeline:timeline.length >= 2 ? timeline : [], deepDive },
  };
}

function equivalentTopics(previous, next) {
  if (previous.kind !== 'local-topic') return false;
  if (topicKeys(previous).includes(next.topicKey)) return true;
  const a = previous.curationTopic, b = next.curationTopic;
  if (!a || a.kind !== b.kind) return previous.title === next.title && sameTopicSources(previous, next);
  const shared = a.terms.filter(term => b.terms.includes(term)).length;
  const overlap = previous.collectionIds.filter(id => next.collectionIds.includes(id)).length;
  if (overlap < 2) return false;
  if (a.kind === 'event') return a.family === b.family && a.eventDate && a.eventDate === b.eventDate && shared >= 1;
  return (a.family && a.family === b.family || a.intent && a.intent === b.intent)
    && shared >= 2 && shared / a.terms.length >= 2 / 3 && shared / b.terms.length >= 2 / 3;
}

function possibleBase(base, fresh, nearbyIds) {
  if (topicKeys(base).includes(fresh.topicKey) || base.collectionIds.some(id => nearbyIds.has(id))) return true;
  const a = base.curationTopic, b = fresh.curationTopic;
  if (!a || a.kind !== b.kind || !a.terms.some(term => b.terms.includes(term))) return false;
  return a.kind === 'event' ? a.family === b.family && a.eventDate === b.eventDate
    : (a.family && a.family === b.family) || (a.intent && a.intent === b.intent);
}

function exactTopicCard(topic, documents, createdAt, baseSourceIds) {
  const collectionIds = documents.map(doc => doc.collectionId);
  const continuation = baseSourceIds && {
    baseIds:new Set(baseSourceIds),
    matchesTopic:summary => equivalentTopics(topic, { topicKey:summary.key, title:summary.label, curationTopic:summary, collectionIds }),
  };
  let repeatsBase = false;
  for (const collectionId of collectionIds) {
    const result = classifyCurationCandidates({ anchorId:collectionId, documents, preferredTopicKeys:topicKeys(topic), includeAllSources:true, continuation });
    if (result.repeatsBase) repeatsBase = true;
    if (result.status !== 'ready' || result.sources.length !== documents.length) continue;
    const card = prepareTopic(result, documents, createdAt);
    if (card && equivalentTopics(topic, card)) return { card };
  }
  return { repeatsBase };
}

function annotations(topic) {
  const { note, noteUpdatedAt, sourceReviewPending, sourceReviewCollectionIds, sourceReviewPendingAt } = topic;
  return { note, noteUpdatedAt, sourceReviewPending, sourceReviewCollectionIds, sourceReviewPendingAt };
}

function revise(card, previous, kind) {
  const previousRefs = references(previous || {});
  const addedSources = references(card).filter(source => !previousRefs.some(prior => prior.id === source.id)).map(sourceLabel);
  return {
    ...card,
    ...(previous ? {
      id:previous.id, title:previous.title, createdAt:previous.createdAt, topicKey:previous.topicKey,
      curationTopicKeys:[...new Set([...topicKeys(previous), card.topicKey])].filter(key => key !== previous.topicKey),
      ...annotations(previous),
    } : {}),
    curationVersion:previous ? editionVersion(previous) + 1 : 1,
    curationUpdate:{ kind, addedSources, updatedAt:card.updatedAt },
  };
}

export function retireCurationUpdates(state) {
  delete state.localCurationUpdates;
  for (const topic of state.exhibitions) delete topic.curationPending;
  for (const item of state.collections) {
    delete item.curationCaptureOrigin;
    if (item.pendingPageCapture) delete item.pendingPageCapture.curationCaptureOrigin;
  }
  for (const message of state.messages) {
    if (message.curationUpdateOffer && !message.curationUpdateOffer.accepted) message.curationUpdateOffer.inactive = true;
  }
}

export function createLocalCuration({ store, knowledge, enabled, clock }) {
  const queued = new Set();
  let worker;
  let stopped = false;

  function enrich(documents, collections) {
    const current = new Map(collections.map(item => [item.id, item]));
    return documents.filter(doc => currentSource(current.get(doc.collectionId), doc)).map(doc => {
      const item = current.get(doc.collectionId);
      return { ...doc, publisher:item.publisher, publishedAt:item.publishedAt, byline:item.byline,
        originUrl:item.originUrl, attribution:item.attribution };
    });
  }

  async function inspect(collectionId) {
    const documents = await knowledge.curationDocuments({ collectionId });
    const current = enrich(documents, store.read().collections);
    return { documents:current, result:classifyCurationCandidates({ anchorId:collectionId, documents:current }) };
  }

  async function curateSelected({ collectionIds, question = '' }) {
    const ids = [...new Set(collectionIds)].slice(0, 12);
    const documents = enrich(await knowledge.curationDocuments({ collectionIds:ids }), store.read().collections);
    if (!documents.length) return { status:'related', reason:'source_unavailable', related:[] };
    const results = documents.map(({ collectionId }) => classifyCurationCandidates({ anchorId:collectionId, documents, question }));
    const related = [...new Map(results.flatMap(result => result.related).map(item => [item.collectionId, item])).values()];
    const qualified = results.filter(result => result.status === 'ready')
      .sort((a, b) => b.articleCount - a.articleCount || b.independentSourceCount - a.independentSourceCount);
    const result = qualified[0];
    if (!result) {
      const reason = ['no_new_information', 'insufficient_sources', 'insufficient_articles'].find(code => results.some(item => item.reason === code));
      return { status:'related', reason:reason || 'no_clear_topic', related };
    }
    const card = prepareTopic(result, documents, new Date(clock()).toISOString(), ids);
    if (!card) return { status:'related', reason:'source_changed', related:[] };
    let topic;
    await store.update(draft => {
      if (stopped) return;
      const collections = new Map(draft.collections.map(item => [item.id, item]));
      if (!currentLocalTopic(card, collections)) return;
      const requested = card.curationRequestedIds;
      const existing = draft.exhibitions.find(item => item.id === card.id || item.curationScope === 'selected'
        && item.curationRequestedIds?.length === requested.length && requested.every(id => item.curationRequestedIds.includes(id))
        && equivalentTopics(item, card));
      if (existing && sameTopicSources(existing, card) && currentLocalTopic(existing, collections)) {
        topic = existing;
        return;
      }
      const automatic = !existing && draft.exhibitions.find(item => item.curationScope !== 'selected' && equivalentTopics(item, card)
        && sameTopicSources(item, card) && currentLocalTopic(item, collections));
      if (automatic) {
        automatic.curationScope = 'selected';
        automatic.curationScopeId = card.curationScopeId;
        automatic.curationRequestedIds = requested;
        topic = automatic;
        return;
      }
      topic = revise(card, existing, existing ? 'revalidated' : 'created');
      if (existing) draft.exhibitions[draft.exhibitions.indexOf(existing)] = topic;
      else draft.exhibitions.push(topic);
    });
    return topic ? { status:'ready', topicId:topic.id, title:topic.title, related }
      : { status:'related', reason:'source_changed', related:[] };
  }

  async function revalidate(topic) {
    const documents = enrich(await knowledge.curationDocuments({ collectionIds:topic.collectionIds }), store.read().collections);
    if (documents.length !== topic.collectionIds.length) return;
    const createdAt = new Date(clock()).toISOString();
    const { card } = exactTopicCard(topic, documents, createdAt, topic.curationBase?.collectionIds);
    if (!card) return;
    if (topic.curationBase) card.curationBase = topic.curationBase;
    await store.update(draft => {
      const index = draft.exhibitions.findIndex(item => item.id === topic.id && item.curationScope !== 'selected');
      const previous = draft.exhibitions[index];
      const collections = new Map(draft.collections.map(item => [item.id, item]));
      if (!stopped && previous && editionVersion(previous) === editionVersion(topic)
        && !currentLocalTopic(previous, collections) && currentLocalTopic(card, collections)) {
        draft.exhibitions[index] = revise(card, previous, 'revalidated');
      }
    });
  }

  async function continueExhibition(fresh, documents, state) {
    const collections = new Map(state.collections.map(item => [item.id, item]));
    const found = new Map(documents.map(doc => [doc.collectionId, doc]));
    const freshDocuments = fresh.collectionIds.map(id => found.get(id));
    const nearbyIds = new Set(found.keys());
    const bases = state.exhibitions.filter(topic => topic.kind === 'local-topic' && references(topic).length === 3
      && currentLocalTopic(topic, collections) && possibleBase(topic, fresh, nearbyIds))
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
    let repeatsBase = false;
    for (const base of bases) {
      if (stopped) break;
      const baseDocuments = enrich(await knowledge.curationDocuments({ collectionIds:base.collectionIds }), store.read().collections);
      if (baseDocuments.length !== 3 || !references(base).every(source => baseDocuments.some(doc => doc.collectionId === source.id && doc.documentVersionId === source.documentVersionId))) continue;
      const { card, repeatsBase:repeats } = exactTopicCard(base, [...baseDocuments, ...freshDocuments], fresh.createdAt, base.collectionIds);
      if (card) {
        card.curationBase = { exhibitionId:base.id, collectionIds:[...base.collectionIds] };
        return { card, base };
      }
      if (repeats) repeatsBase = true;
    }
    return { card:repeatsBase ? null : fresh };
  }

  async function scan(collectionId) {
    const state = store.read();
    const usedSources = savedSources(state.exhibitions);
    const usedIds = new Set(usedSources.map(source => source.id));
    if (usedIds.has(collectionId)) {
      const collections = new Map(state.collections.map(item => [item.id, item]));
      for (const topic of state.exhibitions) {
        if (topic.kind === 'local-topic' && topic.curationScope !== 'selected' && topic.collectionIds.includes(collectionId)
          && !currentLocalTopic(topic, collections)) await revalidate(topic);
      }
      return;
    }
    const documents = enrich(await knowledge.curationDocuments({ collectionId, usedCollectionIds:[...usedIds] }), store.read().collections);
    const anchor = documents.find(doc => doc.collectionId === collectionId);
    if (!anchor || stopped) return;
    const result = classifyCurationCandidates({ anchorId:collectionId, documents, usedSources, automaticGroup:true });
    const fresh = result.status === 'ready' ? prepareTopic(result, documents, new Date(clock()).toISOString()) : null;
    const { card, base } = fresh ? await continueExhibition(fresh, documents, state) : {};
    let rescan = false;
    await store.update(draft => {
      if (stopped) return;
      const collections = new Map(draft.collections.map(item => [item.id, item]));
      if (!currentSource(collections.get(collectionId), anchor) || (card && !currentLocalTopic(card, collections))) return;
      const currentlyUsed = new Set(savedSources(draft.exhibitions).map(source => source.id));
      if (currentlyUsed.has(collectionId)) return;
      const savedBase = base && draft.exhibitions.find(topic => topic.id === base.id);
      if (card && ([...currentlyUsed].some(sourceId => !usedIds.has(sourceId))
        || (base && (!savedBase || !sameTopicSources(base, savedBase))))) {
        rescan = true;
        return;
      }
      draft.localCurationChecked ||= {};
      draft.localCurationChecked[collectionId] = indexedVersion(anchor.documentVersionId, collectionId);
      if (card) draft.exhibitions.push(revise(card, null, 'created'));
    });
    if (rescan) queue([collectionId]);
  }

  function queue(ids) {
    if (!enabled || stopped) return;
    for (const id of ids) queued.add(id);
    if (!queued.size || worker) return;
    worker = (async () => {
      while (!stopped && queued.size) {
        await yieldToDesktop();
        if (stopped) break;
        const id = queued.values().next().value;
        queued.delete(id);
        // The next startup can retry a scan if the database is interrupted.
        await scan(id).catch(() => {});
      }
    })().finally(() => { worker = null; });
  }

  return {
    curateSelected,
    queue(collectionId) {
      queue([collectionId]);
    },
    async backfill() {
      if (!enabled || stopped) return;
      const sources = await knowledge.curationDocuments();
      const state = store.read();
      const checked = state.localCurationChecked || {};
      const collections = new Map(state.collections.map(item => [item.id, item]));
      const used = new Set(savedSources(state.exhibitions).map(source => source.id));
      const stale = new Set(state.exhibitions.filter(topic => topic.kind === 'local-topic' && topic.curationScope !== 'selected' && !currentLocalTopic(topic, collections))
        .flatMap(topic => topic.collectionIds));
      queue(sources.filter(source => stale.has(source.collectionId)
        || (!used.has(source.collectionId) && checked[source.collectionId] !== indexedVersion(source.documentVersionId, source.collectionId))).map(source => source.collectionId));
    },
    async related(collectionId) {
      const { result, documents } = await inspect(collectionId);
      const state = store.read();
      const collections = new Map(state.collections.map(item => [item.id, item]));
      const topic = state.exhibitions.find(item => item.kind === 'local-topic' && item.collectionIds.includes(collectionId) && currentLocalTopic(item, collections));
      const currentVersions = new Set(documents.filter(doc => currentSource(collections.get(doc.collectionId), doc)).map(doc => doc.documentVersionId));
      return { status:topic ? 'ready' : 'related', reason:result.reason,
        ...(topic ? { topicId:topic.id, title:topic.title } : {}), related:result.related.filter(doc => currentVersions.has(doc.documentVersionId)) };
    },
    async idle() { while (worker) await worker; },
    stop() { stopped = true; queued.clear(); },
  };
}
