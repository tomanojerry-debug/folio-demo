import { createHash, randomUUID } from "node:crypto";

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value : "";
const normalize = value => text(value).normalize("NFKC").trim().toLowerCase();
const stamp = value => typeof value === "function" ? value() : value || new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const MAX_PREFERENCES = 5000;
export const MEMORY_POLICY = Object.freeze({ version: 1, historyTurns: 20, historyChars: 24000, summaryChars: 3600, recallChars: 4000, recallLimit: 5, strategy: "extractive-v1", retrieval: "local-lexical-v1" });

function invalid(message) { return Object.assign(new Error(message), { code: "INVALID_REQUEST", statusCode: 400 }); }
function contentOf(value, maximum = 1000) {
  const content = text(value).trim();
  if (!content || content.length > maximum || content.includes("\u0000")) throw invalid(`记忆内容需为 1–${maximum} 字的文字。`);
  return content;
}
function active(state) { return list(state?.memory?.entries).filter(entry => entry.status === "active" && entry.scope === "user"); }
function projectPreferences(state) {
  state.profile ||= {};
  state.profile.preferences = active(state).map(entry => entry.content).join("\n");
}

/** One-time legacy migration. A tombstone is never reversed by re-importing profile text. */
export function migrateMemory(state, { now } = {}) {
  if (state.memory !== undefined) {
    if (state.memory?.version !== 1 || !Array.isArray(state.memory.entries) || !Array.isArray(state.memory.tombstones)) throw invalid("本机记忆格式不受支持，原资料已保留。");
    state.memory.revision = Number.isSafeInteger(state.memory.revision) ? state.memory.revision : 0;
    state.memory.revocationRevision = Number.isSafeInteger(state.memory.revocationRevision) ? state.memory.revocationRevision : 0;
    return state;
  }
  const createdAt = stamp(now);
  const preferences = [...new Set(text(state.profile?.preferences).split("\n").map(line => line.trim()).filter(Boolean))];
  state.memory = { version: 1, revision: 0, revocationRevision: 0, entries: [], tombstones: [] };
  for (const content of preferences) {
    state.memory.entries.push({ id: `memory-legacy-${hash(content).slice(0, 24)}`, scope: "user", kind: "preference", content,
      version: 1, status: "active", source: "legacy-profile", sourceConversationId: null, sourceMessageIds: [], createdAt, updatedAt: createdAt });
  }
  if (preferences.length) state.memory.revision = 1;
  projectPreferences(state);
  return state;
}

/** Only the application routes an explicit user action to this mutation. */
export function rememberPreference(state, { content: value, conversationId, sourceMessageId, now } = {}) {
  migrateMemory(state, { now });
  const content = contentOf(value, sourceMessageId ? 1000 : MAX_PREFERENCES), normalized = normalize(content);
  const existing = active(state).find(entry => normalize(entry.content) === normalized);
  if (existing) return clone(existing);
  if ([...active(state).map(entry => entry.content), content].join("\n").length > MAX_PREFERENCES) throw Object.assign(new Error("偏好内容已达 5000 字上限，请先移除旧偏好。"), { code: "MEMORY_FULL", statusCode: 409 });
  const previous = state.memory.entries.findLast(entry => normalize(entry.content) === normalized);
  const createdAt = stamp(now);
  const entry = { id: `memory-${randomUUID()}`, scope: "user", kind: "preference", content, version: (previous?.version || 0) + 1, status: "active",
    source: sourceMessageId ? "explicit-chat" : "profile-edit", sourceConversationId: conversationId || null, sourceMessageIds: sourceMessageId ? [sourceMessageId] : [],
    createdAt, updatedAt: createdAt, ...(previous ? { supersedes: previous.id } : {}) };
  state.memory.entries.push(entry); state.memory.revision += 1;
  projectPreferences(state);
  return clone(entry);
}

export function forgetPreference(state, { memoryId, content: value, now } = {}) {
  migrateMemory(state, { now });
  const needle = normalize(value);
  if (!memoryId && !needle) throw invalid("请指定要忘记的记忆。");
  const targets = active(state).filter(entry => memoryId ? entry.id === memoryId : normalize(entry.content).includes(needle));
  const revokedAt = stamp(now);
  for (const entry of targets) {
    entry.status = "revoked"; entry.revokedAt = revokedAt; entry.updatedAt = revokedAt;
    state.memory.tombstones.push({ memoryId: entry.id, revokedVersion: entry.version, contentHash: hash(normalize(entry.content)), sourceMessageIds: [...entry.sourceMessageIds], revokedAt });
  }
  if (targets.length) { state.memory.revision += 1; state.memory.revocationRevision += 1; }
  projectPreferences(state);
  return { revokedIds: targets.map(entry => entry.id), revision: state.memory.revision, revocationRevision: state.memory.revocationRevision };
}

/** Settings edits use the same versioned store as explicit chat commands. */
export function replacePreferences(state, { content = "", conversationId, sourceMessageId, now } = {}) {
  if (typeof content !== "string" || content.length > MAX_PREFERENCES || content.includes("\u0000")) throw invalid("偏好内容过长或格式不正确。");
  migrateMemory(state, { now });
  const lines = [...new Set(content.split("\n").map(line => line.trim()).filter(Boolean))];
  const wanted = new Set(lines.map(normalize));
  for (const entry of [...active(state)]) if (!wanted.has(normalize(entry.content))) forgetPreference(state, { memoryId: entry.id, now });
  for (const line of lines) rememberPreference(state, { content: line, conversationId, sourceMessageId, now });
  projectPreferences(state);
  return publicMemories(state);
}

export function publicMemories(state, { includeRevoked = false } = {}) {
  return list(state?.memory?.entries).filter(entry => includeRevoked || entry.status === "active").map(entry => ({
    id: entry.id, content: entry.content, scope: entry.scope, kind: entry.kind, version: entry.version, status: entry.status,
    source: entry.source, sourceConversationId: entry.sourceConversationId, sourceMessageIds: [...list(entry.sourceMessageIds)], createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    ...(entry.revokedAt ? { revokedAt: entry.revokedAt } : {}),
  }));
}

export function snapshotMemory(state) {
  return { version: 1, revision: state?.memory?.revision || 0, revocationRevision: state?.memory?.revocationRevision || 0, entries: publicMemories(state) };
}

function blockedContent(state) {
  const live = new Set(active(state).map(entry => normalize(entry.content)));
  return list(state?.memory?.entries).filter(entry => entry.status === "revoked" && !live.has(normalize(entry.content))).map(entry => normalize(entry.content)).filter(Boolean);
}
function blockedIds(state) { return new Set(list(state?.memory?.tombstones).flatMap(entry => list(entry.sourceMessageIds))); }

/** Raw history stays intact; revoked preference sources are omitted from automatic context. */
export function memoryMessageAllowed(state, message) {
  if (message?.kind === "page-read" || message?.deletedAt || message?.status === "deleted") return false;
  const ids = blockedIds(state);
  if (ids.has(message?.id) || ids.has(message?.sourceMessageId)) return false;
  const value = normalize(message?.text || message?.content);
  return !blockedContent(state).some(content => value.includes(content));
}

/** Associate late assistant/tool events with their original user turn, not append order. */
export function conversationTurns(state, conversationId, { beforeMessageId } = {}) {
  const messages = list(state?.messages), positions = new Map(messages.map((item, index) => [item.id, { item, index }]));
  const jobs = new Map(list(state?.jobs).map(job => [job.id, job.messageId]));
  const toolSources = new Map();
  for (const item of messages) for (const call of list(item.tool_calls)) if (call?.id) toolSources.set(call.id, item.id);
  const boundary = beforeMessageId ? positions.get(beforeMessageId)?.index : messages.length;
  if (boundary === undefined) throw invalid("找不到当前对话消息。");
  function anchorOf(item, index, seen = new Set()) {
    if (seen.has(item.id)) return index;
    seen.add(item.id);
    const sourceId = item.sourceMessageId || jobs.get(item.jobId) || toolSources.get(item.tool_call_id);
    const source = positions.get(sourceId);
    return source && source.item.conversationId === item.conversationId ? anchorOf(source.item, source.index, seen) : index;
  }
  const ordered = messages.map((item, index) => ({ item, index, anchor: anchorOf(item, index) }))
    // A successful read starts/persists a page session, but is an audit action,
    // not a conversational user turn. Its acknowledgments/tools are audit too.
    .filter(({ item, anchor }) => item.conversationId === conversationId && item.kind !== "page-read" && messages[anchor]?.kind !== "page-read"
      && ["user", "assistant", "tool"].includes(item.role) && anchor < boundary)
    .sort((a, b) => a.anchor - b.anchor || a.index - b.index);
  const turns = [];
  for (const { item } of ordered) {
    if (item.role === "user") turns.push({ userMessageId: item.id, messages: [] });
    if (turns.length) turns.at(-1).messages.push(item);
  }
  return turns.map(turn => ({ ...turn, messages: turn.messages.filter(item => memoryMessageAllowed(state, item)) })).filter(turn => turn.messages.some(item => item.role === "user"));
}

function excerpt(value, maximum = 240) { return text(value).replace(/\s+/gu, " ").trim().slice(0, maximum); }
function workingSummary(state, conversationId, { beforeMessageId, historyTurns = MEMORY_POLICY.historyTurns } = {}) {
  const allTurns = conversationTurns(state, conversationId, { beforeMessageId });
  const old = allTurns.slice(0, Math.max(0, allTurns.length - historyTurns));
  if (!old.length) return null;
  const users = old.flatMap(turn => turn.messages.filter(item => item.role === "user"));
  const decisions = users.filter(item => /(?:决定|确定|确认|采用|就按|保持|必须|不要|记住|以后|约定|我更|我喜欢|我希望|只要|一定|不需要|we (?:decided|agreed)|must|always|never)/iu.test(item.text || ""));
  const questions = users.filter(item => /[?？]|(?:怎么|如何|是否|待办|还没|未完成|下一步)/u.test(item.text || ""));
  const picked = [...new Map([users[0], ...decisions.slice(-10), ...questions.slice(-4), ...users.slice(-3)].filter(Boolean).map(item => [item.id, item])).values()];
  const fragments = picked.map(item => ({ sourceMessageIds: [item.id], text: excerpt(item.text, 260), kind: decisions.includes(item) ? "user-stated-constraint" : "user-stated-context" }));
  const summary = fragments.map(item => `[${item.sourceMessageIds[0]}] ${item.text}`).join("\n").slice(0, MEMORY_POLICY.summaryChars);
  const sourceMessageIds = fragments.map(item => item.sourceMessageIds[0]);
  const coverage = old.flatMap(turn => turn.messages.map(item => item.id));
  return { strategy: MEMORY_POLICY.strategy, fingerprint: hash(JSON.stringify({ coverage, summary, revoked: state?.memory?.revocationRevision || 0 })),
    coveredThroughMessageId: coverage.at(-1), coveredMessageCount: coverage.length, sourceMessageIds,
    goal: users[0] ? { text: excerpt(users[0].text), sourceMessageIds: [users[0].id] } : null,
    decisions: decisions.slice(-10).map(item => ({ text: excerpt(item.text), sourceMessageIds: [item.id], status: "user-stated" })),
    openQuestions: questions.slice(-4).map(item => ({ text: excerpt(item.text), sourceMessageIds: [item.id], status: "historical-question-not-verified-open" })),
    summary, excerpts: fragments };
}

/** This baseline extracts quotations; it never pretends a model inferred task completion. */
export function refreshConversationMemory(state, conversationId, { beforeMessageId, now } = {}) {
  migrateMemory(state, { now });
  const conversation = list(state.conversations).find(item => item.id === conversationId);
  if (!conversation) return null;
  const summary = workingSummary(state, conversationId, { beforeMessageId });
  if (!summary) { delete conversation.workingMemory; return null; }
  if (conversation.workingMemory?.fingerprint === summary.fingerprint) return clone(conversation.workingMemory);
  conversation.workingMemory = { ...summary, version: (conversation.workingMemory?.version || 0) + 1, updatedAt: stamp(now) };
  return clone(conversation.workingMemory);
}

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const STOP = new Set("之前 以前 上次 昨天 前天 最近 我们 你们 他们 我的 你的 那个 这个 什么 怎么 如何 是否 讨论 对话 聊天 记得 回顾 帮我 请问 告诉 内容 有没有 还有 一下 当时 a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them there these they this those to us was we were what when where which who why will with would you your about previous earlier last chat conversation remember recall discuss discussed decided decision decisions".split(" "));
function terms(value) {
  const result = new Set();
  for (const part of segmenter.segment(normalize(value).slice(0, 6000))) {
    if (!part.isWordLike || part.segment.length < 2 || STOP.has(part.segment)) continue;
    result.add(part.segment);
    if (/^[\p{Script=Han}]{4,}$/u.test(part.segment)) for (let i = 0; i < part.segment.length - 1; i++) if (!STOP.has(part.segment.slice(i, i + 2))) result.add(part.segment.slice(i, i + 2));
  }
  return [...result].slice(0, 40);
}
export function shouldRecallConversations(query) {
  const value = text(query);
  if (/(?:不要|不用|无需|别).{0,10}(?:回顾|回忆|查找|找|搜索|以前|过去|之前)|\b(?:don't|do not)\b.{0,20}\b(?:recall|remember|search|past)\b/iu.test(value)) return false;
  return /(?:上次|之前|以前|昨天|前天|我们.{0,6}(?:聊过|讨论过|说过|决定过)|回顾.{0,6}(?:聊天|对话|讨论)|过去.{0,6}(?:聊天|对话|讨论))|\b(?:previous|earlier|last)\s+(?:chat|conversation|discussion)|\b(?:we|you|i)\s+(?:discussed|decided|agreed)|\brecall\b/iu.test(value);
}
function textScore(value, tokens) {
  const normalized = normalize(value), words = new Set(normalized.match(/[a-z0-9_-]+/gu) || []);
  return tokens.reduce((score, term) => score + ((/^[a-z0-9_-]+$/u.test(term) ? words.has(term) : normalized.includes(term)) ? 1 : 0), 0);
}

/** Search original conversational turns. No embeddings are fabricated or sent remotely. */
export function recallConversations(state, { query, conversationId, beforeMessageId, limit = MEMORY_POLICY.recallLimit } = {}) {
  if (!shouldRecallConversations(query)) return [];
  const tokens = terms(query);
  const messages = list(state?.messages), boundary = beforeMessageId ? messages.findIndex(item => item.id === beforeMessageId) : messages.length;
  if (boundary < 0) return [];
  const sourceState = { ...state, messages: messages.slice(0, boundary) };
  const candidates = [];
  for (const conversation of list(state?.conversations)) {
    if (conversation.id === conversationId || conversation.deletedAt || conversation.status === "deleted") continue;
    for (const turn of conversationTurns(sourceState, conversation.id)) {
      const user = turn.messages.find(item => item.role === "user");
      if (!user) continue;
      const userText = text(user.text), titleScore = tokens.length ? textScore(conversation.title, tokens) : 0;
      const userScore = tokens.length ? textScore(userText, tokens) : 0;
      // A title hit alone is too weak to establish a past decision. Require text evidence.
      if (tokens.length && !userScore) continue;
      const score = tokens.length ? userScore * 3 + Math.min(titleScore, 2) : 1;
      const date = Date.parse(user.createdAt || conversation.updatedAt || conversation.createdAt) || 0;
      candidates.push({ id: `recall-${hash(`${conversation.id}:${user.id}`).slice(0, 24)}`, conversationId: conversation.id, title: text(conversation.title).slice(0, 160),
        sourceMessageIds: turn.messages.map(item => item.id), createdAt: user.createdAt || conversation.createdAt || null, score, date,
        entries: turn.messages.filter(item => ["user", "assistant"].includes(item.role)).map(item => ({ messageId: item.id, role: item.role, text: excerpt(item.text, item.role === "user" ? 380 : 280) })),
        excerpt: excerpt(userText, 380), attribution: "historical-conversation", retrieval: MEMORY_POLICY.retrieval });
    }
  }
  const ranked = candidates.sort((a, b) => b.score - a.score || b.date - a.date);
  const selected = [], perConversation = new Map();
  for (const { date, ...entry } of ranked) {
    if ((perConversation.get(entry.conversationId) || 0) >= 2) continue;
    selected.push(entry); perConversation.set(entry.conversationId, (perConversation.get(entry.conversationId) || 0) + 1);
    if (selected.length >= Math.min(5, Math.max(0, limit))) break;
  }
  return limit > 0 ? selected : [];
}

function validPreferences(state, profile, memorySnapshot) {
  const current = active(state), currentById = new Map(current.map(entry => [entry.id, entry]));
  const source = memorySnapshot?.version === 1 ? list(memorySnapshot.entries).filter(entry => currentById.get(entry.id)?.version === entry.version) : current;
  const permitted = profile === undefined ? null : new Set(text(profile.preferences).split("\n").map(normalize).filter(Boolean));
  return source.filter(entry => !permitted || permitted.has(normalize(entry.content)));
}

export function buildMemoryContext({ state, messageId, profile, memorySnapshot, memoryRecalls, limits = {} } = {}) {
  const current = list(state?.messages).find(item => item.id === messageId);
  if (!current || current.role !== "user") throw invalid("需要当前用户消息来构建记忆。");
  const preferences = validPreferences(state, profile, memorySnapshot);
  const derived = workingSummary(state, current.conversationId, { beforeMessageId: messageId, historyTurns: limits.historyTurns ?? MEMORY_POLICY.historyTurns });
  const persisted = list(state?.conversations).find(item => item.id === current.conversationId)?.workingMemory;
  const workingMemory = derived ? { ...derived, version: persisted?.fingerprint === derived.fingerprint ? persisted.version : 0 } : null;
  const recalls = Array.isArray(memoryRecalls) ? validateMemoryRecalls(state, messageId, memoryRecalls) : recallConversations(state, { query: current.text, conversationId: current.conversationId, beforeMessageId: messageId, limit: limits.recallLimit ?? MEMORY_POLICY.recallLimit });
  return { preferences: preferences.map(clone), workingMemory, recalls,
    manifest: { version: 1, revision: state?.memory?.revision || 0, revocationRevision: state?.memory?.revocationRevision || 0,
      entryVersions: preferences.map(entry => ({ id: entry.id, version: entry.version })),
      summary: workingMemory ? { version: workingMemory.version, strategy: workingMemory.strategy, fingerprint: workingMemory.fingerprint, coveredThroughMessageId: workingMemory.coveredThroughMessageId, sourceMessageIds: workingMemory.sourceMessageIds } : null,
      recalls: recalls.map(entry => ({ id: entry.id, conversationId: entry.conversationId, sourceMessageIds: entry.sourceMessageIds, createdAt: entry.createdAt, score: entry.score })), retrieval: recalls.some(entry => entry.retrieval === "hybrid-vector-lexical-v1") ? "hybrid-vector-lexical-v1" : MEMORY_POLICY.retrieval } };
}

/** A retriever may rank IDs, but prompt bodies are reconstructed from current authorized state. */
export function validateMemoryRecalls(state, messageId, recalls) {
  const messages = list(state?.messages), boundary = messages.findIndex(item => item.id === messageId), current = messages[boundary];
  if (boundary < 0 || !shouldRecallConversations(current?.text)) return [];
  const positions = new Map(messages.slice(0, boundary).map(item => [item.id, item]));
  const conversations = new Map(list(state?.conversations).filter(item => !item.deletedAt && item.status !== "deleted").map(item => [item.id, item]));
  const seen = new Set(), safe = [];
  for (const candidate of list(recalls).slice(0, 20)) {
    const conversation = conversations.get(candidate?.conversationId);
    if (!conversation || conversation.id === current.conversationId || !list(candidate?.sourceMessageIds).length) continue;
    const source = candidate.sourceMessageIds.map(id => positions.get(id));
    if (source.some(item => !item || item.conversationId !== conversation.id || !memoryMessageAllowed(state, item))) continue;
    const user = source.find(item => item.role === "user");
    if (!user || seen.has(user.id)) continue;
    seen.add(user.id);
    safe.push({ id: `recall-${hash(`${conversation.id}:${user.id}`).slice(0, 24)}`, conversationId: conversation.id, title: text(conversation.title).slice(0, 160),
      sourceMessageIds: source.map(item => item.id), createdAt: user.createdAt || conversation.createdAt || null,
      score: Number.isFinite(candidate.score) ? candidate.score : 0,
      entries: source.filter(item => ["user", "assistant"].includes(item.role)).map(item => ({ messageId: item.id, role: item.role, text: excerpt(item.text, item.role === "user" ? 380 : 280) })),
      excerpt: excerpt(user.text, 380), attribution: "historical-conversation", retrieval: candidate.retrieval === "hybrid-vector-lexical-v1" ? candidate.retrieval : MEMORY_POLICY.retrieval });
    if (safe.length >= MEMORY_POLICY.recallLimit) break;
  }
  return safe;
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) throw invalid("Embedding vectors have incompatible dimensions.");
  let product = 0, a = 0, b = 0;
  for (let index = 0; index < left.length; index++) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) throw invalid("Embedding vector is not finite.");
    product += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2;
  }
  if (!a || !b) throw invalid("Embedding vectors must be nonzero.");
  return Math.max(-1, Math.min(1, product / Math.sqrt(a * b)));
}

/**
 * Optional semantic adapter, sharing the knowledge provider supplied by the app.
 * It only runs for a recall request; bounded in-memory vectors are disposable.
 * Raw messages remain the durable source of truth and are revalidated at use.
 */
export function createMemoryRetriever({ embedder = null, maxCandidates = 128, maxDocumentChars = 1000, maxCacheEntries = 512, minSimilarity = 0.68, timeoutMs = 15000 } = {}) {
  if (embedder && (typeof embedder.embed !== "function" || !embedder.space?.model || !Number.isSafeInteger(embedder.space.dimensions) || embedder.space.dimensions < 1 || embedder.space.dimensions > 4096)) throw new TypeError("A memory embedder must provide embed() and a valid space.");
  for (const [name, value, maximum] of [["maxCandidates", maxCandidates, 512], ["maxDocumentChars", maxDocumentChars, 4000], ["maxCacheEntries", maxCacheEntries, 4096], ["timeoutMs", timeoutMs, 60000]]) if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`Invalid memory retriever limit: ${name}`);
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) throw new TypeError("minSimilarity must be between zero and one.");
  const cache = new Map();
  let cacheRevocationRevision;

  async function retrieve({ state, messageId, signal } = {}) {
    signal?.throwIfAborted();
    const messages = list(state?.messages), boundary = messages.findIndex(item => item.id === messageId), current = messages[boundary];
    if (!current || !shouldRecallConversations(current.text)) return { recalls: [], retrieval: "not-requested", semanticStatus: "not-requested", candidateCount: 0 };
    const lexical = recallConversations(state, { query: current.text, conversationId: current.conversationId, beforeMessageId: messageId });
    if (!embedder) return { recalls: lexical, retrieval: MEMORY_POLICY.retrieval, semanticStatus: "disabled", candidateCount: lexical.length };
    const revocationRevision = state?.memory?.revocationRevision || 0;
    if (cacheRevocationRevision !== revocationRevision) { cache.clear(); cacheRevocationRevision = revocationRevision; }
    const tokens = terms(current.text), candidates = [];
    const sourceState = { ...state, messages: messages.slice(0, boundary) };
    for (const conversation of list(state?.conversations)) {
      if (conversation.id === current.conversationId || conversation.deletedAt || conversation.status === "deleted") continue;
      for (const turn of conversationTurns(sourceState, conversation.id)) {
        const user = turn.messages.find(item => item.role === "user");
        if (!user) continue;
        const body = `${conversation.title}\n${turn.messages.filter(item => ["user", "assistant"].includes(item.role)).map(item => `${item.role}: ${item.text || ""}`).join("\n")}`.slice(0, maxDocumentChars);
        const lexicalScore = textScore(user.text, tokens);
        const key = `${embedder.space.model}:${embedder.space.dimensions}:${hash(body)}`;
        candidates.push({ conversationId: conversation.id, sourceMessageIds: turn.messages.map(item => item.id), body, key, lexicalScore, date: Date.parse(user.createdAt || conversation.updatedAt || conversation.createdAt) || 0 });
      }
    }
    candidates.sort((a, b) => b.lexicalScore - a.lexicalScore || b.date - a.date);
    const bounded = candidates.slice(0, maxCandidates);
    if (!bounded.length) return { recalls: [], retrieval: "hybrid-vector-lexical-v1", semanticStatus: "ready", candidateCount: 0, truncatedCandidates: false };
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("Memory semantic retrieval timed out."), { code: "MEMORY_RETRIEVAL_TIMEOUT" })); }, timeoutMs); });
    try {
      const work = (async () => {
        const [queryVector] = await embedder.embed([text(current.text).slice(0, 4000)], { signal: combined, role: "query" });
        combined.throwIfAborted();
        if (!Array.isArray(queryVector) || queryVector.length !== embedder.space.dimensions) throw invalid("Memory query vector is invalid.");
        const resolved = new Map(bounded.filter(item => cache.has(item.key)).map(item => [item.key, cache.get(item.key)]));
        const missing = [...new Map(bounded.filter(item => !cache.has(item.key)).map(item => [item.key, item])).values()];
        for (let start = 0; start < missing.length; start += 32) {
          const batch = missing.slice(start, start + 32), vectors = await embedder.embed(batch.map(item => item.body), { signal: combined, role: "document" });
          combined.throwIfAborted();
          if (!Array.isArray(vectors) || vectors.length !== batch.length) throw invalid("Memory document vectors are invalid.");
          for (let index = 0; index < batch.length; index++) {
            if (vectors[index]?.length !== embedder.space.dimensions) throw invalid("Memory document vector has invalid dimensions.");
            cosine(queryVector, vectors[index]);
            resolved.set(batch[index].key, vectors[index]);
            cache.set(batch[index].key, vectors[index]);
            while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
          }
        }
        const ranked = bounded.map(item => ({ ...item, similarity: cosine(queryVector, resolved.get(item.key)) }))
          .filter(item => item.lexicalScore > 0 || item.similarity >= minSimilarity)
          .map(item => ({ ...item, score: Math.max(0, item.similarity) * 0.7 + Math.min(1, item.lexicalScore / Math.max(1, tokens.length)) * 0.3, retrieval: "hybrid-vector-lexical-v1" }))
          .sort((a, b) => b.score - a.score || b.date - a.date);
        const selected = [], perConversation = new Map();
        for (const item of ranked) {
          if ((perConversation.get(item.conversationId) || 0) >= 2) continue;
          selected.push(item); perConversation.set(item.conversationId, (perConversation.get(item.conversationId) || 0) + 1);
          if (selected.length >= MEMORY_POLICY.recallLimit) break;
        }
        return validateMemoryRecalls(state, messageId, selected);
      })();
      const recalls = await Promise.race([work, timeout]);
      return { recalls, retrieval: "hybrid-vector-lexical-v1", semanticStatus: "ready", candidateCount: bounded.length, truncatedCandidates: candidates.length > bounded.length };
    } catch (error) {
      signal?.throwIfAborted();
      return { recalls: lexical, retrieval: MEMORY_POLICY.retrieval, semanticStatus: "fallback", candidateCount: bounded.length, truncatedCandidates: candidates.length > bounded.length,
        errorCode: error?.code === "MEMORY_RETRIEVAL_TIMEOUT" ? error.code : "MEMORY_EMBEDDING_UNAVAILABLE" };
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({ retrieve, clear: () => cache.clear(), policy: Object.freeze({ maxCandidates, maxDocumentChars, maxCacheEntries, minSimilarity, timeoutMs, persistence: "rebuildable-cache" }) });
}

/** Revocation wins over a queued snapshot and over an answer still in flight. */
export function isMemoryContextCurrent(state, manifest) {
  const memory = manifest?.memory || manifest;
  if (!memory || memory.version !== 1) return true;
  if ((state?.memory?.revocationRevision || 0) !== (memory.revocationRevision || 0)) return false;
  const entries = new Map(active(state).map(entry => [entry.id, entry]));
  return list(memory.entryVersions).every(entry => entries.get(entry.id)?.version === entry.version);
}
