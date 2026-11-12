import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TOKENIZER_VERSION, searchTerms, searchUnits, indexText, matchExpression, canonicalSourceUrl } from "./tokenize.mjs";

const SCHEMA_VERSION = 3;
const CHUNKING_VERSION = "paragraph-600-v2";
const GRAPH_VERSION = "evidence-concepts-v1";
const MAX_SOURCE_CHARS = 2_000_000;
const now = () => new Date().toISOString();
const text = value => typeof value === "string" ? value : "";
const list = value => Array.isArray(value) ? value : [];
const hash = value => createHash("sha256").update(value).digest("hex");
const fault = (code, message) => Object.assign(new Error(message), { code });
const bounded = (value, fallback, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
function requiredId(value, label = "ID") {
  if (typeof value !== "string" || !value || value.length > 300 || value.includes("\0")) throw fault("KNOWLEDGE_INVALID_REQUEST", `${label} is invalid`);
  return value;
}
function spaceKey(space) {
  if (!space || typeof space.model !== "string" || !space.model || space.model.length > 200 || !Number.isSafeInteger(space.dimensions) || space.dimensions < 1 || space.dimensions > 4096) throw fault("KNOWLEDGE_INVALID_VECTOR", "Embedding space is invalid");
  return `${space.model}:${space.dimensions}`;
}
function vectorData(value, dimensions) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== dimensions || !Array.from(value).every(Number.isFinite)) throw fault("KNOWLEDGE_INVALID_VECTOR", "Embedding dimensions or values are invalid");
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) throw fault("KNOWLEDGE_INVALID_VECTOR", "Embedding must be nonzero and finite");
  return Float32Array.from(value, number => number / norm);
}
function fromBlob(blob) { return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)); }
function cosine(left, right) {
  if (left.length !== right.length) return -1;
  let result = 0;
  for (let index = 0; index < left.length; index++) result += left[index] * right[index];
  return Math.max(-1, Math.min(1, result));
}

mkdirSync(workerData.directory, { recursive: true, mode: 0o700 });
chmodSync(workerData.directory, 0o700);
const filename = path.join(workerData.directory, "knowledge.sqlite");
const db = new DatabaseSync(filename);
chmodSync(filename, 0o600);
const version = db.prepare("PRAGMA user_version").get().user_version;
if (![0, 1, 2, SCHEMA_VERSION].includes(version)) throw fault("KNOWLEDGE_SCHEMA_UNSUPPORTED", "Knowledge database schema is unsupported; the existing file was preserved");
if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw fault("KNOWLEDGE_SCHEMA_UNSUPPORTED", "An unversioned database already exists; the existing file was preserved");
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  BEGIN IMMEDIATE;
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL,
    current_version TEXT, deleted INTEGER NOT NULL DEFAULT 0,
    metadata_status TEXT NOT NULL DEFAULT 'unknown', updated_at TEXT NOT NULL,
    index_fingerprint TEXT NOT NULL DEFAULT '', graph_blocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS documents (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    collection_id TEXT NOT NULL REFERENCES collections(id), capture_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL, content_hash TEXT NOT NULL, title TEXT NOT NULL,
    url TEXT NOT NULL, canonical_url TEXT NOT NULL, body TEXT NOT NULL,
    source_kind TEXT NOT NULL, coverage TEXT NOT NULL, captured_at TEXT NOT NULL,
    tokenizer_version TEXT NOT NULL, chunking_version TEXT NOT NULL DEFAULT 'legacy-1200-v1',
    UNIQUE(collection_id,capture_id,content_hash)
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES documents(id),
    position INTEGER NOT NULL, body TEXT NOT NULL, start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL, locator TEXT NOT NULL, evidence_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_version ON chunks(version_id,position);
  CREATE INDEX IF NOT EXISTS documents_collection ON documents(collection_id,sequence);
  CREATE TABLE IF NOT EXISTS understandings (
    version_id TEXT PRIMARY KEY REFERENCES documents(id), summary TEXT NOT NULL,
    concepts TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
    concept_evidence TEXT NOT NULL DEFAULT '[]', concept_grounding TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS embeddings (
    entity_id TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES documents(id),
    space TEXT NOT NULL, kind TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(entity_id,space)
  );
  CREATE INDEX IF NOT EXISTS embeddings_space ON embeddings(space,version_id);
  CREATE TABLE IF NOT EXISTS concept_nodes (
    id TEXT PRIMARY KEY, canonical_name TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
    normalization_version TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS concept_mentions (
    id TEXT PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES concept_nodes(id),
    version_id TEXT NOT NULL REFERENCES documents(id), chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL, mention_type TEXT NOT NULL, label TEXT NOT NULL,
    understanding_revision INTEGER NOT NULL, source_start INTEGER NOT NULL, source_end INTEGER NOT NULL,
    proof_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS concept_mentions_concept ON concept_mentions(concept_id,version_id);
  CREATE INDEX IF NOT EXISTS concept_mentions_version ON concept_mentions(version_id,understanding_revision);
  CREATE TABLE IF NOT EXISTS graph_state (
    version_id TEXT PRIMARY KEY REFERENCES documents(id), fingerprint TEXT NOT NULL,
    graph_version TEXT NOT NULL, built_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    entity_id UNINDEXED, collection_id UNINDEXED, version_id UNINDEXED, kind UNINDEXED,
    title, summary, concepts, body, tokenize='unicode61'
  );
`);
if (!db.prepare("PRAGMA table_info(documents)").all().some(column => column.name === "chunking_version")) db.exec("ALTER TABLE documents ADD COLUMN chunking_version TEXT NOT NULL DEFAULT 'legacy-1200-v1'");
if (!db.prepare("PRAGMA table_info(collections)").all().some(column => column.name === "graph_blocked")) db.exec("ALTER TABLE collections ADD COLUMN graph_blocked INTEGER NOT NULL DEFAULT 0");
for (const column of ["concept_evidence", "concept_grounding"]) if (!db.prepare("PRAGMA table_info(understandings)").all().some(entry => entry.name === column)) db.exec(`ALTER TABLE understandings ADD COLUMN ${column} TEXT NOT NULL DEFAULT '[]'`);
if (!db.prepare("PRAGMA table_info(concept_mentions)").all().some(column => column.name === "proof_order")) db.exec("ALTER TABLE concept_mentions ADD COLUMN proof_order INTEGER NOT NULL DEFAULT 0");
db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);

function transaction(operation) {
  db.exec("BEGIN IMMEDIATE");
  try { const value = operation(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const collectionRow = id => db.prepare("SELECT * FROM collections WHERE id=?").get(id);
const documentRow = id => db.prepare("SELECT * FROM documents WHERE id=?").get(id);
const currentDocument = id => db.prepare("SELECT d.* FROM documents d JOIN collections c ON c.current_version=d.id WHERE c.id=? AND c.deleted=0").get(id);
function descriptor(row) {
  if (!row) return null;
  return { collectionId: row.collection_id, documentVersionId: row.id, sourceRevision: row.source_revision, title: row.title, url: row.url, contentHash: row.content_hash, sourceKind: row.source_kind, coverage: row.coverage, capturedAt: row.captured_at, chunkingVersion: row.chunking_version, characterCount: row.body.length, chunkCount: Number(db.prepare("SELECT count(*) AS total FROM chunks WHERE version_id=?").get(row.id).total) };
}
function chunkView(row) {
  return { chunkId: row.id, text: row.body, locator: row.locator, start: row.start_offset, end: row.end_offset, evidence_id: row.evidence_id };
}
function allChunks(versionId) { return db.prepare("SELECT * FROM chunks WHERE version_id=? ORDER BY position").all(versionId); }
function understanding(row) {
  const value = db.prepare("SELECT * FROM understandings WHERE version_id=?").get(row.id);
  return value && value.status === "ready" ? { summary: value.summary, concepts: JSON.parse(value.concepts), conceptEvidence: JSON.parse(value.concept_evidence), understandingRevision: value.revision } : { summary: "", concepts: [], conceptEvidence: [], understandingRevision: null };
}
function ensureCollection(id, source = {}) {
  db.prepare("INSERT INTO collections(id,title,url,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING").run(id, text(source.title).slice(0, 400), text(source.url).slice(0, 4000), now());
}
function reindex(collectionId) {
  const collection = collectionRow(collectionId);
  if (!collection) return;
  if (collection.deleted) {
    db.prepare("DELETE FROM search_fts WHERE collection_id=?").run(collectionId);
    db.prepare("UPDATE collections SET index_fingerprint='' WHERE id=?").run(collectionId);
    return;
  }
  const row = currentDocument(collectionId);
  const info = row ? understanding(row) : { summary: "", concepts: [] };
  const fingerprint = hash(JSON.stringify([TOKENIZER_VERSION, row?.chunking_version, row?.id, row?.title || collection.title, info.summary, info.concepts]));
  if (collection.index_fingerprint === fingerprint) return;
  db.prepare("DELETE FROM search_fts WHERE collection_id=?").run(collectionId);
  const insert = db.prepare("INSERT INTO search_fts(entity_id,collection_id,version_id,kind,title,summary,concepts,body) VALUES(?,?,?,?,?,?,?,?)");
  if (!row) insert.run(`meta:${collectionId}`, collectionId, "", "metadata", indexText(collection.title), "", "", "");
  else {
    insert.run(`doc:${row.id}`, collectionId, row.id, "document", indexText(row.title), indexText(info.summary), indexText(info.concepts.join(" ")), "");
    for (const chunk of allChunks(row.id)) insert.run(chunk.id, collectionId, row.id, "chunk", "", "", "", indexText(chunk.body));
  }
  db.prepare("UPDATE collections SET index_fingerprint=? WHERE id=?").run(fingerprint, collectionId);
}
function makeChunks(body, evidence, versionId) {
  const valid = list(evidence).filter(entry => text(entry?.text));
  let cursor = 0;
  const mapped = valid.map(entry => {
    const start = body.indexOf(entry.text, cursor);
    if (start < 0) return null;
    cursor = start + entry.text.length;
    return { body: entry.text, start, end: cursor, locator: text(entry.locator), evidenceId: text(entry.evidence_id) };
  }).filter(Boolean);
  const pieces = [];
  const appendRange = (rangeStart, rangeEnd) => {
    for (let start = rangeStart; start < rangeEnd;) {
      let end = Math.min(start + 600, rangeEnd);
      if (end < rangeEnd) {
        const candidates = [...body.slice(start, end).matchAll(/[。！？.!?](?:\s|$)/gu)];
        const sentence = candidates.at(-1);
        const word = body.lastIndexOf(" ", end - 1) + 1;
        if (sentence && sentence.index + sentence[0].length >= 40) end = start + sentence.index + sentence[0].length;
        else if (word >= start + 100) end = word;
        if (/[\uD800-\uDBFF]/u.test(body[end - 1])) end--;
      }
      const parents = mapped.filter(entry => entry.start < end && entry.end > start);
      const locators = [...new Set(parents.map(entry => entry.locator).filter(Boolean))];
      pieces.push({ body: body.slice(start, end), start, end, locator: locators.length ? `${locators.join("；")} · 原文字符 ${start + 1}–${end}` : `原文字符 ${start + 1}–${end}`, evidenceId: parents.length === 1 ? parents[0].evidenceId : "" });
      start = end;
    }
  };
  // Independent short paragraphs must remain independent semantic units. In
  // particular a 70-character introduction must not disappear into 1,100
  // characters of an unrelated archive or boilerplate which follows it.
  let pendingStart = 0;
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== "\n") continue;
    const end = index + 1;
    if (body.slice(pendingStart, end).trim().length >= 20) { appendRange(pendingStart, end); pendingStart = end; }
  }
  if (pendingStart < body.length) appendRange(pendingStart, body.length);
  return pieces.map((piece, position) => ({ id: `chunk:${hash(`${versionId}:${piece.start}:${piece.end}`).slice(0, 32)}`, position, ...piece }));
}

function captureSource(args) {
  const collectionId = requiredId(args.collectionId, "Collection ID"), captureId = requiredId(args.captureId, "Capture ID");
  const source = args.source || {};
  if (typeof source.text !== "string" || !source.text.length || source.text.length > MAX_SOURCE_CHARS) throw fault("KNOWLEDGE_INVALID_SOURCE", "A bounded original source body is required");
  const sourceRevision = bounded(args.sourceRevision, 1, 1_000_000) || 1;
  const contentHash = hash(source.text);
  const capturedAt = Number.isFinite(Date.parse(source.capturedAt)) ? new Date(source.capturedAt).toISOString() : now();
  return transaction(() => {
    ensureCollection(collectionId, source);
    const collection = collectionRow(collectionId);
    if (collection.deleted) throw fault("KNOWLEDGE_DELETED", "This collection has been removed");
    const previous = collection.current_version && documentRow(collection.current_version);
    // AI understanding can get a new live ID while the actual source is
    // unchanged. Reuse its immutable source and cached vectors in that case.
    const reuseCurrent = previous && previous.content_hash === contentHash && previous.source_revision === sourceRevision;
    const versionId = reuseCurrent ? previous.id : `document:${hash(`${collectionId}\0${captureId}\0${contentHash}`).slice(0, 40)}`;
    let row = documentRow(versionId);
    const existed = Boolean(row);
    if (!row) {
      db.prepare("INSERT INTO documents(id,collection_id,capture_id,source_revision,content_hash,title,url,canonical_url,body,source_kind,coverage,captured_at,tokenizer_version,chunking_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(versionId, collectionId, captureId, sourceRevision, contentHash, text(source.title).slice(0, 400), text(source.url).slice(0, 4000), canonicalSourceUrl(source.url), source.text, text(source.sourceKind) || "body_text", ["complete", "partial", "reconstructed"].includes(source.coverage) ? source.coverage : "complete", capturedAt, TOKENIZER_VERSION, CHUNKING_VERSION);
      const insert = db.prepare("INSERT INTO chunks(id,version_id,position,body,start_offset,end_offset,locator,evidence_id) VALUES(?,?,?,?,?,?,?,?)");
      for (const chunk of makeChunks(source.text, source.evidence, versionId)) insert.run(chunk.id, versionId, chunk.position, chunk.body, chunk.start, chunk.end, chunk.locator, chunk.evidenceId);
      row = documentRow(versionId);
    }
    // Replaying an old capture cannot move the current pointer backwards.
    const activate = args.activate !== false && (!previous || previous.id === versionId || (!existed && (row.source_revision > previous.source_revision || (row.source_revision === previous.source_revision && row.captured_at >= previous.captured_at))));
    if (activate) {
      if (previous && previous.id !== versionId) invalidateGraph(collectionId);
      db.prepare("UPDATE collections SET current_version=?,title=?,url=?,updated_at=? WHERE id=?").run(versionId, row.title, row.url, now(), collectionId);
      reindex(collectionId);
    }
    return { ...descriptor(row), active: activate, reused: existed };
  });
}

function extractionText(extraction) {
  const evidence = list(extraction?.evidenceBundle).filter(entry => text(entry?.text));
  if (!evidence.length) return "";
  return evidence.map(entry => entry.text).join(evidence.every(entry => entry.source_field === "transcript") ? "\n" : "");
}

const GENERIC_CONCEPTS = new Set("知识 内容 来源 原文 文章 系统 工具 方法 信息 资料 材料 用户 使用者 作者 观点 过程 主题 关联 线索 概念 总结 摘要 介绍 说明 核对 保留 比较 理解 解释 学习 讨论 共同主题 关联线索 knowledge content source sources article articles system systems tool tools method methods information material materials user users author process topic topics concept concepts summary".split(" "));
const normalizeConcept = value => text(value).normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
function literalConceptIn(value, concept) {
  const haystack = normalizeConcept(value);
  if (/^[a-z0-9][a-z0-9 +#_.-]*$/u.test(concept)) {
    const escaped = concept.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(haystack);
  }
  return haystack.includes(concept);
}
function usefulConcept(value) {
  const name = normalizeConcept(value);
  if (name.length < 2 || name.length > 100 || /[\u0000-\u001f]/u.test(name) || GENERIC_CONCEPTS.has(name)) return false;
  const units = searchUnits(name, { limit: 20 });
  return units.length > 0 && units.some(unit => !GENERIC_CONCEPTS.has(unit));
}

function groundConcepts(row, extraction, conceptNames) {
  const currentChunks = allChunks(row.id), ranges = new Map(), ambiguous = new Set();
  let cursor = 0;
  for (const evidence of list(extraction.evidenceBundle)) {
    const id = text(evidence?.evidence_id), body = text(evidence?.text);
    if (!id || !body) continue;
    const start = row.body.indexOf(body, cursor);
    if (start < 0) continue;
    cursor = start + body.length;
    if (ranges.has(id)) { ambiguous.add(id); continue; }
    ranges.set(id, { evidenceId: id, start, end: cursor });
  }
  for (const id of ambiguous) ranges.delete(id);
  const names = new Map(conceptNames.filter(usefulConcept).map(value => [normalizeConcept(value), value]));
  const provided = new Set(), grounded = new Map();
  for (const entry of list(extraction.conceptEvidence)) {
    const name = normalizeConcept(entry?.value);
    if (!name) continue;
    provided.add(name);
    if (!names.has(name)) continue;
    const ids = [...new Set(list(entry.evidence_ids))];
    if (!ids.length || ids.some(id => typeof id !== "string" || !ranges.has(id))) continue;
    const evidence = ids.map(id => ranges.get(id));
    const literal = evidence.some(range => literalConceptIn(row.body.slice(range.start, range.end), name));
    grounded.set(name, { value: names.get(name), canonical: name, mentionType: literal ? "literal_mention" : "extracted_topic", evidence });
  }
  // Legacy labels are recoverable only as literal mentions in the original.
  // Abstract labels need their separately validated source evidence bindings.
  for (const [name, value] of names) {
    if (provided.has(name)) continue;
    const evidence = currentChunks.filter(chunk => literalConceptIn(chunk.body, name)).slice(0, 2).map(chunk => ({ evidenceId: chunk.evidence_id, start: chunk.start_offset, end: chunk.end_offset }));
    if (evidence.length) grounded.set(name, { value, canonical: name, mentionType: "literal_mention", evidence });
  }
  return [...grounded.values()];
}

function invalidateGraph(collectionId) {
  db.prepare("DELETE FROM concept_mentions WHERE version_id IN (SELECT id FROM documents WHERE collection_id=?)").run(collectionId);
  db.prepare("DELETE FROM graph_state WHERE version_id IN (SELECT id FROM documents WHERE collection_id=?)").run(collectionId);
}

function graphFingerprint(row, record) {
  return hash(JSON.stringify([GRAPH_VERSION, "ranked-evidence-v1", row.content_hash, row.chunking_version, record?.status, record?.revision, record?.concepts, record?.concept_evidence, record?.concept_grounding]));
}

function buildGraphRows(row, record) {
  invalidateGraph(row.collection_id);
  if (!record || record.status !== "ready" || collectionRow(row.collection_id)?.graph_blocked) return;
  let grounding = JSON.parse(record.concept_grounding);
  if (!grounding.length && JSON.parse(record.concept_evidence).length === 0) grounding = groundConcepts(row, {}, JSON.parse(record.concepts));
  const chunks = allChunks(row.id);
  const insertNode = db.prepare("INSERT INTO concept_nodes(id,canonical_name,display_name,normalization_version) VALUES(?,?,?,'nfkc-casefold-v1') ON CONFLICT(id) DO NOTHING");
  const insertMention = db.prepare("INSERT OR IGNORE INTO concept_mentions(id,concept_id,version_id,chunk_id,evidence_id,mention_type,label,understanding_revision,source_start,source_end,proof_order) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for (const concept of grounding) {
    if (!usefulConcept(concept.value)) continue;
    const conceptId = `concept:${hash(concept.canonical).slice(0, 32)}`;
    const units = searchUnits(concept.value);
    const candidates = chunks.flatMap(chunk => concept.evidence.filter(range => range.start < chunk.end_offset && range.end > chunk.start_offset).map(range => ({ chunk, range, weight: Number(literalConceptIn(chunk.body, concept.canonical)) * 100000 + searchTerms(chunk.body).filter(term => units.includes(term)).length * 1000 + Math.min(range.end, chunk.end_offset) - Math.max(range.start, chunk.start_offset) })))
      .sort((a, b) => b.weight - a.weight || a.chunk.position - b.chunk.position);
    const seenChunks = new Set();
    const selected = candidates.filter(candidate => !seenChunks.has(candidate.chunk.id) && seenChunks.add(candidate.chunk.id)).slice(0, 2);
    if (!selected.length) continue;
    insertNode.run(conceptId, concept.canonical, concept.value);
    for (const [order, { chunk, range }] of selected.entries()) {
      const id = `mention:${hash(`${conceptId}:${row.id}:${record.revision}:${chunk.id}:${range.evidenceId}`).slice(0, 40)}`;
      insertMention.run(id, conceptId, row.id, chunk.id, range.evidenceId, concept.mentionType, concept.value, record.revision, range.start, range.end, order);
    }
  }
  db.prepare("INSERT INTO graph_state(version_id,fingerprint,graph_version,built_at) VALUES(?,?,?,?) ON CONFLICT(version_id) DO UPDATE SET fingerprint=excluded.fingerprint,graph_version=excluded.graph_version,built_at=excluded.built_at").run(row.id, graphFingerprint(row, record), GRAPH_VERSION, now());
}

function ensureGraph(collectionId) {
  const row = currentDocument(collectionId), collection = collectionRow(collectionId);
  if (!row || collection.graph_blocked) return;
  const record = db.prepare("SELECT * FROM understandings WHERE version_id=?").get(row.id);
  if (!record || record.status !== "ready") return;
  const previous = db.prepare("SELECT fingerprint FROM graph_state WHERE version_id=?").get(row.id);
  if (previous?.fingerprint === graphFingerprint(row, record)) return;
  transaction(() => buildGraphRows(row, record));
}

function ensureCurrentGraphs() {
  for (const row of db.prepare("SELECT c.id FROM collections c JOIN understandings u ON u.version_id=c.current_version WHERE c.deleted=0 AND c.graph_blocked=0 AND u.status='ready'").all()) ensureGraph(row.id);
}

function attachUnderstanding(args) {
  const collectionId = requiredId(args.collectionId), current = currentDocument(collectionId);
  if (!current) return { attached: false };
  if (args.documentVersionId && current.id !== args.documentVersionId) return { attached: false, reason: "source_changed" };
  if (args.sourceRevision && current.source_revision !== args.sourceRevision) return { attached: false, reason: "source_changed" };
  const extraction = args.extraction || {};
  const evidenceBody = extractionText(extraction);
  if (evidenceBody && hash(evidenceBody) !== current.content_hash) return { attached: false, reason: "source_changed" };
  // A source revision without evidence cannot establish an old summary's origin.
  if (!args.documentVersionId && !evidenceBody) return { attached: false, reason: "no_evidence" };
  const status = extraction.status === "qualified" && args.blocked !== true && !collectionRow(collectionId).graph_blocked ? "ready" : "not_ready";
  const summary = status === "ready" ? text(extraction.summary).slice(0, 12000) : "";
  const concepts = JSON.stringify(status === "ready" ? list(extraction.concepts).map(value => typeof value === "string" ? value : text(value?.value)).filter(Boolean).slice(0, 50) : []);
  const conceptEvidence = JSON.stringify(status === "ready" ? list(extraction.conceptEvidence).slice(0, 50).map(entry => ({ value: text(entry?.value).slice(0, 100), evidence_ids: list(entry?.evidence_ids).filter(id => typeof id === "string").slice(0, 100) })) : []);
  const grounding = JSON.stringify(status === "ready" ? groundConcepts(current, extraction, JSON.parse(concepts)) : []);
  const revision = bounded(extraction.revision, 1, 1_000_000) || 1;
  const previous = db.prepare("SELECT * FROM understandings WHERE version_id=?").get(current.id);
  if (previous && previous.summary === summary && previous.concepts === concepts && previous.concept_evidence === conceptEvidence && previous.concept_grounding === grounding && previous.revision === revision && previous.status === status) return { attached: true, documentVersionId: current.id, status, reused: true };
  return transaction(() => {
    db.prepare("INSERT INTO understandings(version_id,summary,concepts,revision,status,concept_evidence,concept_grounding) VALUES(?,?,?,?,?,?,?) ON CONFLICT(version_id) DO UPDATE SET summary=excluded.summary,concepts=excluded.concepts,revision=excluded.revision,status=excluded.status,concept_evidence=excluded.concept_evidence,concept_grounding=excluded.concept_grounding")
      .run(current.id, summary, concepts, revision, status, conceptEvidence, grounding);
    reindex(collectionId);
    buildGraphRows(current, db.prepare("SELECT * FROM understandings WHERE version_id=?").get(current.id));
    return { attached: true, documentVersionId: current.id, status };
  });
}

function reconcile(args) {
  const collections = list(args.collections).filter(item => typeof item?.id === "string" && item.id);
  const active = new Set(collections.map(item => item.id));
  let backfilled = 0, unavailable = 0;
  transaction(() => {
    for (const stored of db.prepare("SELECT id FROM collections").all()) if (!active.has(stored.id)) {
      db.prepare("UPDATE collections SET deleted=1,index_fingerprint='',graph_blocked=1,updated_at=? WHERE id=?").run(now(), stored.id);
      db.prepare("DELETE FROM search_fts WHERE collection_id=?").run(stored.id);
      invalidateGraph(stored.id);
    }
    for (const item of collections) {
      ensureCollection(item.id, item);
      const blocked = ["pending_rewrite", "confirmed_edited"].includes(args.workspace?.feedback?.[`understanding:${item.id}`]?.decision) || item.status !== "ready";
      db.prepare("UPDATE collections SET deleted=0,metadata_status=?,graph_blocked=?,updated_at=? WHERE id=?").run(text(item.status) || "unknown", Number(blocked), now(), item.id);
      if (blocked) invalidateGraph(item.id);
      if (!currentDocument(item.id)) db.prepare("UPDATE collections SET title=?,url=? WHERE id=?").run(text(item.title).slice(0, 400), text(item.url).slice(0, 4000), item.id);
    }
  });
  for (const item of collections) {
    const restored = currentDocument(item.id);
    if (restored && restored.chunking_version !== CHUNKING_VERSION) rebuildChunking(restored);
    if (!currentDocument(item.id)) {
      const evidenceBody = extractionText(item.extraction);
      const plainBody = item.input?.mode === "text" ? text(item.input.content) : (!item.input && ["user_input", "text"].includes(item.type) && !/^https?:\/\//i.test(text(item.content)) ? text(item.content) : "");
      const body = evidenceBody || plainBody;
      if (body) {
        captureSource({ collectionId: item.id, captureId: `backfill:${item.sourceRevision || 1}`, sourceRevision: item.sourceRevision || 1, source: { title: item.title, url: item.url, text: body, evidence: item.extraction?.evidenceBundle, sourceKind: item.type === "image_note" ? "image_description" : item.type === "video" ? "transcript" : "body_text", coverage: evidenceBody ? "reconstructed" : "complete", capturedAt: item.updatedAt || item.addedAt || item.createdAt } });
        backfilled++;
      }
    }
    // Failed source checkpoints may contain a newer source than the accepted AI
    // understanding. Keep it independently and never replay older pointers.
    for (const job of list(args.jobs).filter(job => job.collectionId === item.id)) {
      const source = job.harness?.checkpoints?.source?.value;
      if (!text(source?.text)) continue;
      const captureId = job.retryRootId || job.id;
      if (!text(job.retryRootId || job.id)) continue;
      const sourceRevision = job.targetSourceRevision || item.sourceRevision || 1;
      const known = db.prepare("SELECT id FROM documents WHERE collection_id=? AND capture_id=? AND content_hash=?").get(item.id, captureId, hash(source.text));
      if (!known) { captureSource({ collectionId: item.id, captureId, sourceRevision, source: { ...source, title: source.title || item.title, url: source.url || item.url, capturedAt: job.createdAt } }); backfilled++; }
    }
    if (currentDocument(item.id)) attachUnderstanding({ collectionId: item.id, sourceRevision: item.sourceRevision || 1, extraction: item.extraction, blocked: ["pending_rewrite", "confirmed_edited"].includes(args.workspace?.feedback?.[`understanding:${item.id}`]?.decision) || item.status !== "ready" });
    else unavailable++;
    reindex(item.id);
  }
  return { backfilled, unavailable, collections: collections.length, tokenizerVersion: TOKENIZER_VERSION };
}

function readDocument(args) {
  const collectionId = requiredId(args.collectionId), collection = collectionRow(collectionId);
  if (!collection || collection.deleted) throw fault("NOT_FOUND", "没有找到这条收藏。");
  const row = args.documentVersionId ? documentRow(requiredId(args.documentVersionId)) : currentDocument(collectionId);
  if (!row) return { collectionId, documentVersionId: null, title: collection.title, url: collection.url, coverage: "unavailable", sourceKind: null, chunks: [], text: "", characterCount: 0, nextOffset: null, hasMore: false };
  if (row.collection_id !== collectionId) throw fault("NOT_FOUND", "没有找到这个原文版本。");
  const offset = bounded(args.offset, 0, row.body.length), limit = bounded(args.limit, 12000, 40000);
  const selectedIds = Array.isArray(args.chunkIds) ? new Set(args.chunkIds.slice(0, 12)) : null;
  let remaining = limit;
  const chunks = [];
  for (const chunk of allChunks(row.id)) {
    if (selectedIds ? !selectedIds.has(chunk.id) : chunk.end_offset <= offset || chunk.start_offset >= offset + limit) continue;
    if (!remaining) break;
    if (selectedIds && chunks.length) remaining--;
    if (!remaining) break;
    const start = selectedIds ? chunk.start_offset : Math.max(offset, chunk.start_offset);
    const end = Math.min(chunk.end_offset, start + remaining, selectedIds ? row.body.length : offset + limit);
    const value = row.body.slice(start, end);
    chunks.push({ ...chunkView(chunk), text: value, start, end, excerpt: start > chunk.start_offset || end < chunk.end_offset });
    remaining -= value.length;
  }
  return { ...descriptor(row), ...understanding(row), text: selectedIds ? chunks.map(chunk => chunk.text).join("\n") : row.body.slice(offset, offset + limit), chunks, offset, hasMore: !selectedIds && offset + limit < row.body.length, nextOffset: !selectedIds && offset + limit < row.body.length ? offset + limit : null, active: collection.current_version === row.id };
}

function embeddingWork(args) {
  const space = spaceKey(args.space), limit = bounded(args.limit, 32, 128);
  if (!limit) return [];
  const rows = db.prepare("SELECT d.* FROM documents d JOIN collections c ON c.current_version=d.id WHERE c.deleted=0 ORDER BY d.sequence").all();
  const result = [];
  const exists = db.prepare("SELECT 1 FROM embeddings WHERE entity_id=? AND space=?");
  for (const row of rows) {
    const docId = `doc:${row.id}`;
    if (!exists.get(docId, space)) {
      const size = row.body.length;
      const representative = size <= 2200 ? row.body : [row.body.slice(0, 700), row.body.slice(Math.max(0, Math.floor(size / 2) - 350), Math.floor(size / 2) + 350), row.body.slice(-700)].join("\n…\n");
      result.push({ id: docId, kind: "document", collectionId: row.collection_id, documentVersionId: row.id, text: `${row.title}\n${representative}`.slice(0, 2600) });
      if (result.length >= limit) break;
    }
    for (const chunk of allChunks(row.id)) {
      if (!exists.get(chunk.id, space)) result.push({ id: chunk.id, kind: "chunk", collectionId: row.collection_id, documentVersionId: row.id, text: `${row.title}\n${chunk.body}`.slice(0, 4400) });
      if (result.length >= limit) break;
    }
    if (result.length >= limit) break;
  }
  return result;
}

function writeEmbeddings(args) {
  const space = spaceKey(args.space), entries = list(args.items);
  if (entries.length > 128) throw fault("KNOWLEDGE_INVALID_VECTOR", "Too many embeddings in one write");
  const validated = entries.map(item => ({ ...item, id: requiredId(item.id), documentVersionId: requiredId(item.documentVersionId), vector: vectorData(item.vector, args.space.dimensions) }));
  return transaction(() => {
    let written = 0, skipped = 0;
    const insert = db.prepare("INSERT INTO embeddings(entity_id,version_id,space,kind,vector,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_id,space) DO UPDATE SET vector=excluded.vector,created_at=excluded.created_at");
    for (const item of validated) {
      const row = documentRow(item.documentVersionId), current = row && currentDocument(row.collection_id);
      const isDocument = item.id === `doc:${item.documentVersionId}`;
      const chunk = !isDocument && db.prepare("SELECT version_id FROM chunks WHERE id=?").get(item.id);
      if (!row || !current || current.id !== row.id || (!isDocument && chunk?.version_id !== row.id)) { skipped++; continue; }
      insert.run(item.id, row.id, space, isDocument ? "document" : "chunk", Buffer.from(item.vector.buffer), now());
      written++;
    }
    return { written, skipped };
  });
}

function activeDocumentMetadata(collectionIds) {
  const allowed = Array.isArray(collectionIds) ? collectionIds : null;
  const statement = db.prepare(`SELECT d.collection_id,d.content_hash,d.canonical_url FROM documents d JOIN collections c ON c.current_version=d.id WHERE c.deleted=0${allowed ? " AND d.collection_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY d.sequence`);
  return allowed ? statement.all(JSON.stringify(allowed)) : statement.all();
}
function lexicalCandidates(terms, collectionIds) {
  if (!terms.length) return [];
  const allowed = Array.isArray(collectionIds) ? [...new Set(collectionIds.filter(id => typeof id === "string"))] : null;
  if (allowed && !allowed.length) return [];
  // The per-source cap keeps many sections of a single long article from
  // occupying every candidate slot before source aggregation.
  const perSource = new Map(), candidates = [];
  // Apply the selected library before candidate truncation. Filtering in JS
  // after a global LIMIT lets many unrelated high-ranked titles crowd out an
  // otherwise valid passage inside the user's explicitly selected source.
  const statement = db.prepare(`SELECT *,bm25(search_fts,0,0,0,0,6,3,4,1) AS rank FROM search_fts WHERE search_fts MATCH ?${allowed ? " AND collection_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY rank LIMIT 400`);
  const rows = allowed ? statement.all(matchExpression(terms), JSON.stringify(allowed)) : statement.all(matchExpression(terms));
  for (const row of rows) {
    const count = perSource.get(row.collection_id) || 0;
    if (count >= 3) continue;
    perSource.set(row.collection_id, count + 1);
    candidates.push(row);
    if (candidates.length >= 40) break;
  }
  return candidates;
}
function vectorCandidates(vector, space, collectionIds, minSimilarity) {
  const allowed = Array.isArray(collectionIds) ? new Set(collectionIds) : null;
  const rows = db.prepare("SELECT e.*,d.collection_id FROM embeddings e JOIN documents d ON d.id=e.version_id JOIN collections c ON c.current_version=d.id WHERE e.space=? AND c.deleted=0").all(space);
  const all = rows.filter(row => !allowed || allowed.has(row.collection_id)).map(row => ({ ...row, similarity: cosine(vector, fromBlob(row.vector)) })).filter(row => row.similarity >= minSimilarity).sort((a, b) => b.similarity - a.similarity || a.entity_id.localeCompare(b.entity_id));
  const perSource = new Map(), candidates = [];
  for (const row of all) {
    const count = perSource.get(row.collection_id) || 0;
    if (count >= 3) continue;
    perSource.set(row.collection_id, count + 1);
    candidates.push(row);
    if (candidates.length >= 40) break;
  }
  return { candidates, available: rows.length > 0 };
}
function bestChunks(row, terms, preferred = []) {
  const order = new Map(preferred.map((id, index) => [id, preferred.length - index]));
  return allChunks(row.id).map(chunk => ({ chunk, weight: (order.get(chunk.id) || 0) * 100 + searchTerms(chunk.body, { limit: 100000 }).filter(term => terms.includes(term)).length }))
    .sort((a, b) => b.weight - a.weight || a.chunk.position - b.chunk.position).slice(0, 2).map(entry => chunkView(entry.chunk));
}
function resultFor(collectionId, entry, terms) {
  const row = currentDocument(collectionId);
  if (!row) {
    const meta = collectionRow(collectionId);
    return { collectionId, documentVersionId: null, title: meta.title, url: meta.url, sourceRevision: null, contentHash: null, coverage: "unavailable", chunks: [], matchedTerms: terms.filter(term => searchTerms(meta.title).includes(term)), matchReasons: ["标题匹配；尚未取得原文"], score: entry.score, lexicalScore: entry.lexicalScore, semanticScore: entry.semanticScore ?? null };
  }
  const info = understanding(row), sourceTerms = new Set(searchTerms(`${row.title}\n${info.summary}\n${info.concepts.join(" ")}\n${row.body}`, { limit: 100000 }));
  const matchedTerms = terms.filter(term => sourceTerms.has(term));
  return { ...descriptor(row), ...info, chunks: bestChunks(row, terms, entry.chunkIds), matchedTerms, matchReasons: [...(matchedTerms.length ? [`共同线索：${matchedTerms.slice(0, 5).join("、")}`] : []), ...(entry.semanticScore !== undefined ? ["语义内容相近"] : [])], score: entry.score, lexicalScore: entry.lexicalScore ?? null, semanticScore: entry.semanticScore ?? null };
}
function search(args) {
  const query = text(args.query).slice(0, 8000), terms = searchTerms(query, { limit: 32 }), units = searchUnits(query, { limit: 32 }), limit = bounded(args.limit, 6, 20);
  if (!limit) return { items: [], mode: "full_text" };
  const lexical = lexicalCandidates(terms, args.collectionIds), combined = new Map();
  const entryFor = id => {
    if (!combined.has(id)) combined.set(id, { score: 0, chunkIds: [] });
    return combined.get(id);
  };
  // RRF is applied once per document per route; more chunks do not multiply a
  // long document's vote. Chunk scores only select evidence inside the source.
  const seenLexical = new Set();
  lexical.forEach((row, index) => {
    const entry = entryFor(row.collection_id);
    if (!seenLexical.has(row.collection_id)) { entry.score += 1 / (60 + index + 1); entry.lexicalScore = -row.rank; seenLexical.add(row.collection_id); }
    if (row.kind === "chunk") entry.chunkIds.push(row.entity_id);
  });
  let semanticAvailable = false;
  if (args.vector !== undefined && args.space) {
    const space = spaceKey(args.space), vector = vectorData(args.vector, args.space.dimensions);
    const minimum = typeof args.minSimilarity === "number" && Number.isFinite(args.minSimilarity) ? Math.max(-1, Math.min(1, args.minSimilarity)) : 0.55;
    const semantic = vectorCandidates(vector, space, args.collectionIds, minimum);
    semanticAvailable = semantic.available;
    const seenSemantic = new Set();
    semantic.candidates.forEach((row, index) => {
      const entry = entryFor(row.collection_id);
      if (!seenSemantic.has(row.collection_id)) { entry.score += 1 / (60 + index + 1); entry.semanticScore = row.similarity; seenSemantic.add(row.collection_id); }
      if (row.kind === "chunk" && !entry.chunkIds.includes(row.entity_id)) entry.chunkIds.push(row.entity_id);
    });
  }
  const items = [...combined.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).map(([id, entry]) => resultFor(id, entry, terms)).filter(item => {
    if (item.semanticScore !== null) return true;
    const matched = new Set(item.matchedTerms), covered = units.filter(term => matched.has(term));
    // One generic verb in a multi-part question is retrieval noise. A short
    // exact query still needs only its one domain term. A long identifier can
    // independently be decisive when it appears exactly (e.g. LUX-742).
    const exactIdentifier = covered.some(term => /[a-z]/u.test(term) && /[0-9_-]/u.test(term) && term.length >= 5);
    return covered.length >= (units.length >= 3 ? 2 : 1) || exactIdentifier;
  }).slice(0, limit);
  return { items, mode: semanticAvailable ? "hybrid" : "full_text", queryTerms: terms };
}

const SIMILARITY_GENERIC_TERMS = new Set("系统 使用者 用户 作者 方法 建议 实验 记录 处理 观察 日常 活动 过程 结果 问题 条件 情况 工作 操作 文字 文本 阅读 环境 研究 一起 同时 没有 只是 其中 中的 部分 最佳 统一 适用 有效 重要 设置 完成 执行 提供 基于 实际 一般 author article articles method methods way ways effect effects affects affect process records record suggests suggestions recommends recommend users user text example examples steps general important different same alone only must includes include discusses discuss".split(" "));
function similarityUnits(value) { return searchUnits(value, { limit: 100000 }).filter(term => !SIMILARITY_GENERIC_TERMS.has(term)); }
function lexicalSimilarityEvidence(anchor, other) {
  const anchorInfo = understanding(anchor), otherInfo = understanding(other);
  const anchorBody = new Set(similarityUnits(anchor.body)), otherBody = new Set(similarityUnits(other.body));
  const allShared = [...anchorBody].filter(term => otherBody.has(term));
  const anchorEvidence = new Set(similarityUnits(bestChunks(anchor, allShared).map(chunk => chunk.text).join("\n")));
  const otherEvidence = new Set(similarityUnits(bestChunks(other, allShared).map(chunk => chunk.text).join("\n")));
  const shared = allShared.filter(term => anchorEvidence.has(term) && otherEvidence.has(term));
  if (!shared.length) return { passes: false, shared };
  const anchorHeads = new Set(similarityUnits(`${anchor.title}\n${anchorInfo.concepts.join(" ")}`).filter(term => anchorBody.has(term)));
  const otherHeads = new Set(similarityUnits(`${other.title}\n${otherInfo.concepts.join(" ")}`).filter(term => otherBody.has(term)));
  const anchorCoverage = shared.length / Math.max(1, anchorEvidence.size), otherCoverage = shared.length / Math.max(1, otherEvidence.size);
  const headed = shared.filter(term => anchorHeads.has(term));
  const strongHeading = headed.some(term => otherHeads.has(term) && (/^[\p{Script=Han}]{3,}$/u.test(term) || /^[a-z0-9_-]{6,}$/u.test(term)));
  const headingContext = headed.length > 0 && shared.length >= 2 && Math.min(anchorCoverage, otherCoverage) >= 0.1;
  const substantiveOverlap = shared.length >= 3 && Math.min(anchorCoverage, otherCoverage) >= 0.15;
  const conciseOverlap = shared.length >= 2 && Math.min(anchorCoverage, otherCoverage) >= 0.4;
  return { passes: strongHeading || headingContext || substantiveOverlap || conciseOverlap, shared, anchorCoverage, otherCoverage };
}

function findSimilar(args) {
  const collectionId = requiredId(args.collectionId), row = currentDocument(collectionId);
  if (!row) throw fault("KNOWLEDGE_SOURCE_UNAVAILABLE", "这条收藏还没有可供比较的原文。");
  const info = understanding(row), limit = bounded(args.limit, 5, 20);
  const titleTerms = searchTerms(`${row.title} ${info.concepts.join(" ")}`, { limit: 16 });
  const bodyTerms = searchTerms(`${info.summary}\n${row.body}`, { limit: 32 });
  const terms = [...new Set([...titleTerms, ...bodyTerms])].slice(0, 32);
  const allowed = activeDocumentMetadata(args.collectionIds).filter(other => other.collection_id !== collectionId && other.content_hash !== row.content_hash && (!row.canonical_url || other.canonical_url !== row.canonical_url)).map(other => other.collection_id);
  let queryVector = args.vector;
  if (queryVector === undefined && args.space) {
    const stored = db.prepare("SELECT vector FROM embeddings WHERE entity_id=? AND space=?").get(`doc:${row.id}`, spaceKey(args.space));
    if (stored) queryVector = Array.from(fromBlob(stored.vector));
  }
  const result = search({ query: [...terms, ...searchTerms(text(args.aspect), { limit: 8 })].join(" "), vector: queryVector, space: args.space, collectionIds: allowed, minSimilarity: args.minSimilarity, limit: Math.min(20, Math.max(limit * 3, limit)) });
  const pairingSpace = args.space ? spaceKey(args.space) : null;
  const anchorChunkMap = new Map(allChunks(row.id).map(chunk => [chunk.id, chunk]));
  const anchorVectors = pairingSpace ? db.prepare("SELECT e.entity_id,e.vector FROM embeddings e JOIN chunks ch ON ch.id=e.entity_id WHERE e.version_id=? AND ch.version_id=? AND e.space=? AND e.kind='chunk'").all(row.id, row.id, pairingSpace).map(entry => ({ chunk: anchorChunkMap.get(entry.entity_id), vector: fromBlob(entry.vector) })).filter(entry => entry.chunk) : [];
  function pairedEvidence(item, candidateChunks) {
    if (!pairingSpace || !anchorVectors.length || !candidateChunks.length) return null;
    const candidateMap = new Map(candidateChunks.slice(0, 2).map(chunk => [chunk.chunkId, chunk]));
    const candidates = db.prepare("SELECT entity_id,vector FROM embeddings WHERE version_id=? AND space=? AND kind='chunk' AND entity_id IN (SELECT value FROM json_each(?))").all(item.documentVersionId, pairingSpace, JSON.stringify([...candidateMap.keys()]));
    let best = null;
    // Only two candidate passages are compared with the anchor's own passages;
    // this is bounded source-pair evidence selection, not a library pair scan.
    for (const candidate of candidates) {
      const vector = fromBlob(candidate.vector);
      for (const anchor of anchorVectors) {
        const similarity = cosine(vector, anchor.vector);
        if (!best || similarity > best.similarity) best = { similarity, chunk: candidateMap.get(candidate.entity_id), anchorChunk: chunkView(anchor.chunk) };
      }
    }
    return best;
  }
  const items = result.items.map(item => ({ item, evidence: lexicalSimilarityEvidence(row, currentDocument(item.collectionId)) })).filter(({ item, evidence }) => item.semanticScore !== null || evidence.passes).slice(0, limit).map(({ item, evidence }) => {
    const matchedTerms = evidence.shared;
    // Keep the semantic route's preferred passages. Replacing them with lexical
    // overlap here would silently discard a genuine cross-language tail hit.
    let chunks = item.semanticScore !== null ? item.chunks : bestChunks(currentDocument(item.collectionId), matchedTerms);
    let anchorChunks = bestChunks(row, matchedTerms);
    const pair = pairedEvidence(item, chunks);
    if (pair) {
      chunks = [pair.chunk, ...chunks.filter(chunk => chunk.chunkId !== pair.chunk.chunkId)].slice(0, 2);
      anchorChunks = [pair.anchorChunk, ...anchorChunks.filter(chunk => chunk.chunkId !== pair.anchorChunk.chunkId)].slice(0, 2);
    }
    return { ...item, matchedTerms, matchReasons: [...(matchedTerms.length ? [`共同线索：${matchedTerms.slice(0, 5).join("、")}`] : []), ...(item.semanticScore !== null ? ["语义内容相近"] : [])], chunks, anchorChunks, pairedSimilarity: pair?.similarity ?? null, ...(pair ? { pairedChunkId: pair.chunk.chunkId, pairedAnchorChunkId: pair.anchorChunk.chunkId, pairedScoreKind: "cosine_similarity" } : {}), similarityType: item.semanticScore !== null ? "semantic" : "shared_terms" };
  });
  return { anchor: { ...descriptor(row), ...info, chunks: bestChunks(row, terms) }, items, mode: result.mode, aspect: text(args.aspect).slice(0, 100) || "content" };
}

function currentMentions(versionId) {
  return db.prepare("SELECT ch.*,m.concept_id,m.evidence_id AS mention_evidence_id,m.mention_type,m.label,m.understanding_revision,n.display_name,n.canonical_name FROM concept_mentions m JOIN chunks ch ON ch.id=m.chunk_id JOIN concept_nodes n ON n.id=m.concept_id JOIN documents d ON d.id=m.version_id JOIN collections c ON c.current_version=d.id JOIN understandings u ON u.version_id=d.id WHERE m.version_id=? AND c.deleted=0 AND c.graph_blocked=0 AND u.status='ready' AND u.revision=m.understanding_revision ORDER BY n.canonical_name,m.proof_order,ch.position").all(versionId);
}

function conceptViews(mentions) {
  const concepts = new Map();
  for (const mention of mentions) {
    const previous = concepts.get(mention.concept_id);
    concepts.set(mention.concept_id, { id: mention.concept_id, name: mention.display_name, mentionType: previous?.mentionType === "extracted_topic" || mention.mention_type === "extracted_topic" ? "extracted_topic" : "literal_mention" });
  }
  return [...concepts.values()];
}

function proofChunks(mentions, source) {
  const chunks = new Map();
  for (const mention of mentions) {
    const evidenceId = mention.mention_evidence_id || mention.evidence_id;
    const previous = chunks.get(mention.id);
    if (previous) {
      if (evidenceId && !previous.evidence_ids.includes(evidenceId)) previous.evidence_ids.push(evidenceId);
      if (!previous.conceptIds.includes(mention.concept_id)) previous.conceptIds.push(mention.concept_id);
      continue;
    }
    chunks.set(mention.id, { ...chunkView(mention), evidence_id: evidenceId, evidence_ids: evidenceId ? [evidenceId] : [], conceptIds: [mention.concept_id], documentVersionId: source.id, sourceRevision: source.source_revision, understandingRevision: mention.understanding_revision });
  }
  return [...chunks.values()].slice(0, 2);
}

function getConnections(args) {
  const collectionId = requiredId(args.collectionId), collection = collectionRow(collectionId);
  if (!collection || collection.deleted) throw fault("NOT_FOUND", "没有找到这条收藏。");
  const row = currentDocument(collectionId), limit = bounded(args.limit, 8, 20);
  const envelope = { mode: "evidence_graph", graphVersion: GRAPH_VERSION };
  if (!row) return { ...envelope, graphStatus: "source_unavailable", anchor: { collectionId, documentVersionId: null, title: collection.title, url: collection.url, coverage: "unavailable", understandingRevision: null, chunks: [], concepts: [] }, items: [] };
  ensureCurrentGraphs();
  const mentions = currentMentions(row.id), info = understanding(row);
  const anchor = { ...descriptor(row), ...info, concepts: conceptViews(mentions), chunks: proofChunks(mentions, row) };
  if (!anchor.chunks.length) anchor.chunks = allChunks(row.id).slice(0, 2).map(chunkView);
  if (collection.graph_blocked || info.understandingRevision === null) return { ...envelope, graphStatus: "understanding_pending", anchor: { ...anchor, concepts: [] }, items: [] };
  if (!limit || !mentions.length) return { ...envelope, graphStatus: "ready", anchor, items: [] };
  const ids = [...new Set(mentions.map(mention => mention.concept_id))];
  const total = Number(db.prepare("SELECT count(*) AS total FROM collections c JOIN understandings u ON u.version_id=c.current_version WHERE c.deleted=0 AND c.graph_blocked=0 AND u.status='ready'").get().total);
  const weights = new Map();
  const count = db.prepare("SELECT count(DISTINCT d.collection_id) AS total FROM concept_mentions m JOIN documents d ON d.id=m.version_id JOIN collections c ON c.current_version=d.id JOIN understandings u ON u.version_id=d.id WHERE m.concept_id=? AND c.deleted=0 AND c.graph_blocked=0 AND u.status='ready' AND u.revision=m.understanding_revision");
  for (const id of ids) {
    const frequency = Number(count.get(id).total);
    weights.set(id, Math.log(1 + (Math.max(total, frequency) - frequency + 0.5) / (frequency + 0.5)));
  }
  // Start from only the anchor's indexed concepts. This is not a whole-library
  // pairwise graph, and repeated mentions cannot multiply a document's vote.
  const candidates = new Map();
  for (const peer of db.prepare("SELECT DISTINCT d.id AS version_id,d.collection_id,m.concept_id FROM concept_mentions m JOIN documents d ON d.id=m.version_id JOIN collections c ON c.current_version=d.id JOIN understandings u ON u.version_id=d.id WHERE m.concept_id IN (SELECT value FROM json_each(?)) AND c.id<>? AND c.deleted=0 AND c.graph_blocked=0 AND u.status='ready' AND u.revision=m.understanding_revision").all(JSON.stringify(ids), collectionId)) {
    if (!candidates.has(peer.collection_id)) candidates.set(peer.collection_id, { versionId: peer.version_id, ids: new Set(), score: 0 });
    const candidate = candidates.get(peer.collection_id);
    if (!candidate.ids.has(peer.concept_id)) { candidate.ids.add(peer.concept_id); candidate.score += weights.get(peer.concept_id) || 0; }
  }
  const items = [];
  for (const [id, candidate] of [...candidates.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))) {
    const other = currentDocument(id);
    if (!other || other.id !== candidate.versionId || other.content_hash === row.content_hash || (row.canonical_url && other.canonical_url === row.canonical_url)) continue;
    const peers = currentMentions(other.id);
    const shared = [...candidate.ids].sort((a, b) => (weights.get(b) || 0) - (weights.get(a) || 0) || a.localeCompare(b)).slice(0, 2);
    const anchorProof = [], peerProof = [], concepts = [];
    for (const conceptId of shared) {
      const left = mentions.filter(mention => mention.concept_id === conceptId), right = peers.filter(mention => mention.concept_id === conceptId);
      if (!left.length || !right.length) continue;
      const mentionType = [...left, ...right].some(mention => mention.mention_type === "extracted_topic") ? "extracted_topic" : "literal_mention";
      concepts.push({ id: conceptId, name: left[0].display_name, mentionType });
      anchorProof.push(left[0]); peerProof.push(right[0]);
    }
    const anchorChunks = proofChunks(anchorProof, row), chunks = proofChunks(peerProof, other);
    if (!concepts.length || !anchorChunks.length || !chunks.length) continue;
    const literal = concepts.filter(concept => concept.mentionType === "literal_mention"), extracted = concepts.filter(concept => concept.mentionType === "extracted_topic");
    items.push({ ...descriptor(other), ...understanding(other), relationType: "shared_concept", concepts, anchorChunks, chunks, score: concepts.reduce((sum, concept) => sum + (weights.get(concept.id) || 0), 0),
      matchReasons: [...(literal.length ? [`共同提及：${literal.map(concept => concept.name).join("、")}`] : []), ...(extracted.length ? [`系统识别的共同主题：${extracted.map(concept => concept.name).join("、")}`] : [])] });
    if (items.length >= limit) break;
  }
  return { ...envelope, graphStatus: "ready", anchor, items };
}

function getConcepts(args) {
  ensureCurrentGraphs();
  const query = normalizeConcept(args.query), limit = bounded(args.limit, 30, 100);
  const rows = db.prepare("SELECT n.id,n.display_name AS name,n.canonical_name,count(DISTINCT d.collection_id) AS sourceCount,count(DISTINCT m.id) AS mentionCount FROM concept_nodes n JOIN concept_mentions m ON m.concept_id=n.id JOIN documents d ON d.id=m.version_id JOIN collections c ON c.current_version=d.id JOIN understandings u ON u.version_id=d.id WHERE c.deleted=0 AND c.graph_blocked=0 AND u.status='ready' AND u.revision=m.understanding_revision GROUP BY n.id ORDER BY sourceCount DESC,n.canonical_name").all();
  const items = rows.filter(row => !query || row.canonical_name.includes(query)).slice(0, limit).map(({ canonical_name, ...row }) => row);
  return { items, mode: "evidence_graph", graphVersion: GRAPH_VERSION };
}

function curationDocuments(args) {
  const eligible = `FROM documents d JOIN collections c ON c.current_version=d.id
    WHERE c.deleted=0 AND d.source_kind='body_text' AND d.coverage IN ('complete','partial')
    AND length(d.body)>=80 AND (d.url LIKE 'https://%' OR d.url LIKE 'http://%')`;
  const project = row => ({
    collectionId:row.collection_id, documentVersionId:row.id, sourceRevision:row.source_revision,
    title:row.title, url:row.url, canonicalUrl:row.canonical_url, coverage:row.coverage,
    text:row.body.slice(0, 40000), capturedAt:row.captured_at,
  });
  const find = db.prepare(`SELECT d.* ${eligible} AND d.collection_id=?`);
  if (Array.isArray(args.collectionIds)) {
    const ids = [...new Set(args.collectionIds)].slice(0, 12);
    return ids.map(id => find.get(requiredId(id))).filter(Boolean).map(project);
  }
  if (!args.collectionId) {
    return db.prepare(`SELECT d.collection_id AS collectionId,d.id AS documentVersionId ${eligible} ORDER BY d.sequence DESC`).all();
  }

  const anchor = find.get(requiredId(args.collectionId));
  if (!anchor) return [];
  const used = new Set(args.usedCollectionIds || []);
  let unusedIds;
  if (used.size) {
    const published = db.prepare("SELECT content_hash,canonical_url FROM documents WHERE collection_id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...used]));
    const usedHashes = new Set(published.map(row => row.content_hash));
    const usedUrls = new Set(published.map(row => row.canonical_url).filter(Boolean));
    const unused = db.prepare(`SELECT d.collection_id,d.content_hash,d.canonical_url ${eligible}`).all()
      .filter(row => !used.has(row.collection_id) && !usedHashes.has(row.content_hash) && !usedUrls.has(row.canonical_url));
    unusedIds = unused.map(row => row.collection_id);
    if (!unusedIds.includes(anchor.collection_id)) return [project(anchor)];
  }
  const recentQuery = db.prepare(`SELECT d.* ${eligible}${unusedIds ? " AND d.collection_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY d.sequence DESC LIMIT 22`);
  const recent = unusedIds ? recentQuery.all(JSON.stringify(unusedIds)) : recentQuery.all();
  const candidates = new Map([[anchor.collection_id, anchor]]);
  if (recent.length < 22) {
    for (const row of recent) candidates.set(row.collection_id, row);
  } else {
    const similar = findSimilar({ collectionId:anchor.collection_id, collectionIds:unusedIds, limit:20, space:args.space });
    const matches = search({ query:anchor.title, collectionIds:unusedIds, limit:16 }).items;
    for (const item of [...similar.items, ...matches]) {
      const row = find.get(item.collectionId);
      if (row) candidates.set(row.collection_id, row);
      if (candidates.size === 24) break;
    }
    for (const row of recent.slice(0, 4)) if (candidates.size < 24) candidates.set(row.collection_id, row);
  }
  if (used.size) {
    // Keep a small comparison pool for near-copy detection after searching
    // unused material on its own. Old exhibits cannot crowd out new articles.
    const previous = findSimilar({ collectionId:anchor.collection_id, collectionIds:[...used], limit:8, space:args.space }).items;
    for (const item of previous) {
      const row = find.get(item.collectionId);
      if (row) candidates.set(row.collection_id, row);
    }
  }
  return [...candidates.values()].map(project);
}

function status(args) {
  const filterId = args?.collectionId;
  const rows = filterId ? [collectionRow(requiredId(filterId))].filter(Boolean) : db.prepare("SELECT * FROM collections WHERE deleted=0 ORDER BY id").all();
  const space = args?.space ? spaceKey(args.space) : null;
  const items = rows.filter(row => !row.deleted).map(collection => {
    const row = currentDocument(collection.id);
    if (!row) return { collectionId: collection.id, documentVersionId: null, sourceStatus: "unavailable", fullTextStatus: "metadata_only", semanticStatus: space ? "pending_source" : "not_configured", characterCount: 0, chunkCount: 0, embeddedCount: 0 };
    const count = Number(db.prepare("SELECT count(*) AS total FROM chunks WHERE version_id=?").get(row.id).total);
    const embeddedCount = space ? Number(db.prepare("SELECT count(*) AS total FROM embeddings WHERE version_id=? AND space=?").get(row.id, space).total) : 0;
    return { collectionId: collection.id, documentVersionId: row.id, sourceRevision: row.source_revision, sourceStatus: row.coverage, fullTextStatus: "ready", semanticStatus: !space ? "not_configured" : embeddedCount >= count + 1 ? "ready" : embeddedCount ? "partial" : "pending", characterCount: row.body.length, chunkCount: count, embeddedCount };
  });
  return { schemaVersion: SCHEMA_VERSION, tokenizerVersion: TOKENIZER_VERSION, chunkingVersion: CHUNKING_VERSION, graphVersion: GRAPH_VERSION, vectorSearch: "exact_cosine_worker", totalCollections: items.length, documents: items.filter(item => item.documentVersionId).length, unavailable: items.filter(item => !item.documentVersionId).length, semanticReady: items.filter(item => item.semanticStatus === "ready").length, items };
}

// Rebuild derived units only. The original source ID/body and understanding
// stay intact; chunk embeddings from the prior boundaries must never be reused.
function rebuildChunking(row) {
  return transaction(() => {
    const prior = allChunks(row.id).map(chunk => ({ text: chunk.body, locator: chunk.locator, evidence_id: chunk.evidence_id }));
    db.prepare("DELETE FROM embeddings WHERE version_id=? AND kind='chunk'").run(row.id);
    db.prepare("DELETE FROM chunks WHERE version_id=?").run(row.id);
    const insert = db.prepare("INSERT INTO chunks(id,version_id,position,body,start_offset,end_offset,locator,evidence_id) VALUES(?,?,?,?,?,?,?,?)");
    for (const chunk of makeChunks(row.body, prior, row.id)) insert.run(chunk.id, row.id, chunk.position, chunk.body, chunk.start, chunk.end, chunk.locator, chunk.evidenceId);
    db.prepare("UPDATE documents SET chunking_version=? WHERE id=?").run(CHUNKING_VERSION, row.id);
    reindex(row.collection_id);
  });
}
for (const row of db.prepare("SELECT d.* FROM documents d JOIN collections c ON c.current_version=d.id WHERE c.deleted=0 AND d.chunking_version<>?").all(CHUNKING_VERSION)) rebuildChunking(row);

const methods = { captureSource, reconcile, attachUnderstanding, readDocument, embeddingWork, writeEmbeddings, search, findSimilar, getConnections, getConcepts, curationDocuments, status, flush: () => ({ flushed: true }), close: () => { db.close(); return { closed: true }; } };
parentPort.on("message", request => {
  try {
    const method = methods[request.method];
    if (!method) throw fault("KNOWLEDGE_INVALID_REQUEST", "Unsupported knowledge operation");
    parentPort.postMessage({ id: request.id, value: method(request.args || {}) });
  } catch (error) { parentPort.postMessage({ id: request.id, error: { code: error.code || "KNOWLEDGE_STORAGE_ERROR", message: error.message || "Knowledge storage failed" } }); }
});
parentPort.postMessage({ ready: true });
