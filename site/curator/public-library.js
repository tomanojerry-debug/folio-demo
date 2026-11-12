// This adapter reads the approved library and keeps workspace edits in this browser.
const mapFields = ["feedback", "notes", "collectionCategories"];
const rowFields = ["exhibitionNotes", "exhibitionRecords", "studioNotes", "themes", "exhibitionProgress"];
const preferenceFields = ["defaultMode", "curationMode", "customPrompt", "fontSize", "readingWidth"];
const storageKey = "folio.public-library.v1";
const sampleKey = "folio.public-sample.v1";
const sampleCollectionId = "folio-first-collection";
const clone = value => structuredClone(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];

function savedData(storage, key = storageKey) {
  try { return JSON.parse(storage?.getItem(key) || "{}") || {}; }
  catch { return {}; }
}

function saveData(storage, value, key = storageKey) {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

export function savePublicSample(data, sampleText, storage) {
  const { collection, extraction } = data || {};
  if (!["qualified", "needs_confirmation"].includes(extraction?.status)
    || extraction.source !== "live_ai" || typeof extraction.summary !== "string"
    || typeof collection?.title !== "string" || typeof sampleText !== "string" || !sampleText) return false;

  const documentVersionId = "folio-first-collection:v1";
  const paragraph = { id: "p1", text: sampleText, start: 0, end: sampleText.length };
  const evidenceBundle = list(extraction.evidenceBundle).filter(item =>
    typeof item?.evidence_id === "string" && typeof item.text === "string" && item.text && sampleText.includes(item.text));
  const passage = (text, ids) => {
    const quote = evidenceBundle.find(item => list(ids).includes(item.evidence_id))?.text;
    return quote && typeof text === "string" && text.trim() ? {
      text,
      evidenceIds: [paragraph.id],
      evidence: [{ paragraphId: paragraph.id, quote, start: sampleText.indexOf(quote) }],
    } : null;
  };
  const answer = passage(extraction.summary, extraction.summaryEvidence);
  const findings = list(extraction.digest?.highlights).map(item => passage(item?.text, item?.evidence_ids)).filter(Boolean);
  const tags = list(extraction.tags).filter(value => typeof value === "string").slice(0, 5);
  const item = {
    id: sampleCollectionId, type: "user_input", title: collection.title, source: "示例文字",
    content: sampleText, summary: extraction.summary, addedAt: new Date().toISOString(),
    status: extraction.status === "qualified" ? "ready" : extraction.status,
    knowledgeDocumentVersionId: documentVersionId, understandingDocumentVersionId: documentVersionId,
    extraction: { collectionId: sampleCollectionId, source: "live_ai", status: extraction.status, summary: extraction.summary, tags },
  };
  const article = {
    collectionId: sampleCollectionId, title: item.title, documentVersionId,
    sourceKind: "body_text", sourceStatus: "available", coverage: "complete", complete: true,
    active: true, paragraphs: [paragraph], quotes: [], results: [], canGenerateUnderstanding: false,
    understanding: answer ? { answer, findings } : null,
  };
  return saveData(storage, { collection: item, article }, sampleKey);
}

function applyWorkspaceOperations(workspace, operations) {
  for (const operation of list(operations)) {
    const { field, key, value } = operation;
    if (typeof key !== "string" || !key) continue;
    if (mapFields.includes(field)) {
      if (operation.delete) delete workspace[field][key];
      else workspace[field] = { ...workspace[field], [key]: clone(value) };
    } else if (rowFields.includes(field)) {
      const rows = workspace[field].filter(item => item?.id !== key);
      workspace[field] = operation.delete || value?.id !== key ? rows : [...rows, clone(value)];
    }
  }
}

export function createPublicLibrary(payload, storage) {
  const { state, articles, preferences: defaults } = payload || {};
  if (state?.capabilities?.publicDemo !== true || !Array.isArray(state.collections)
    || !Array.isArray(state.exhibitions) || !object(articles) || !object(defaults)) {
    throw new Error("示例资料没有完整加载，请重新连接。");
  }

  const saved = savedData(storage);
  const workspace = Object.fromEntries([
    ...mapFields.map(field => [field, object(saved.workspace?.[field]) ? saved.workspace[field] : clone(state.workspace?.[field] || {})]),
    ...rowFields.map(field => [field, clone(list(saved.workspace?.[field] ?? state.workspace?.[field]))]),
  ]);
  let preferences = { ...defaults, ...(object(saved.preferences) ? saved.preferences : {}) };
  const publicSample = () => {
    const sample = savedData(storage, sampleKey);
    return sample.collection?.id === sampleCollectionId && sample.article?.collectionId === sampleCollectionId ? sample : null;
  };
  const currentState = () => {
    const sample = publicSample();
    const collections = sample ? [...state.collections, sample.collection] : state.collections;
    return clone({ ...state, collections, workspace });
  };
  const persist = () => saveData(storage, { workspace, preferences });

  async function api(route, body = {}) {
    if (route === "state") return currentState();
    if (route === "workspace") {
      applyWorkspaceOperations(workspace, body.ops);
      persist();
      return { state: currentState() };
    }
    if (route === "reading/preferences") {
      const changes = Object.fromEntries(preferenceFields.filter(field => Object.hasOwn(body, field)).map(field => [field, body[field]]));
      if (Object.keys(changes).length) {
        if (body.expectedVersion !== undefined && body.expectedVersion !== preferences.version) {
          throw new Error("阅读设置已经更新，请重新打开设置。");
        }
        preferences = { ...preferences, ...changes, version: preferences.version + 1 };
        persist();
      }
      return { preferences: clone(preferences) };
    }
    if (route === "reading/article") {
      const article = body.collectionId === sampleCollectionId
        ? publicSample()?.article
        : Object.hasOwn(articles, body.collectionId) && articles[body.collectionId];
      if (!article || (body.documentVersionId && body.documentVersionId !== article.documentVersionId)) {
        throw new Error("这条收藏的示例原文暂不可用。");
      }
      return { article: clone(article), preferences: clone(preferences) };
    }
    if (route === "knowledge/similar") {
      const topic = state.exhibitions.find(item => list(item.collectionIds).includes(body.collectionId));
      const related = list(topic?.collectionIds).filter(id => id !== body.collectionId).slice(0, 4);
      const items = related.flatMap(id => {
        const collection = state.collections.find(item => item.id === id);
        return collection ? [{ collectionId: id, title: collection.title, summary: collection.extraction?.summary || collection.summary || "", matchReasons: ["同一场示例展览中的来源"] }] : [];
      });
      return { items, ...(topic ? { curation: { status: "related", topicId: topic.id, title: topic.title } } : {}) };
    }
    if (route === "curation/reading" && !body.generate) return { available: false, result: null };
    throw new Error("此操作可在 Folio 客户端中使用。");
  }
  return { api };
}

export async function loadPublicLibrary(baseURL) {
  const response = await fetch(new URL("api/library", baseURL), { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("暂时无法打开在线展览，请重新连接。");
  let storage;
  try { storage = window.localStorage; } catch { /* In-memory reading is still available. */ }
  return createPublicLibrary(await response.json(), storage);
}
