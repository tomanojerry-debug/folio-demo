import { createHash, randomUUID } from "node:crypto";
import { validURL } from "../../../server/safe-fetch.mjs";

export const PAGE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const fault = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const stamp = value => new Date(value ?? Date.now()).toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");

/** Strip known tracking parameters, never meaningful query values or SPA routes. */
export function normalizePageURL(raw) {
  const url = validURL(raw);
  for (const name of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(name) || /^(?:fbclid|gclid|msclkid)$/i.test(name)) url.searchParams.delete(name);
  }
  if (!/^#(?:\/|!)/.test(url.hash)) url.hash = "";
  return url.href;
}

export function pageIdentity(context = {}) {
  if (!context.url) throw fault("NEEDS_CONTEXT", "先关联要讨论的页面。");
  const url = normalizePageURL(context.url);
  const scope = typeof context.browserProfileId === "string" && context.browserProfileId
    ? `profile:${context.browserProfileId}` : `app:${context.appName || "browser"}`;
  return { key: hash(JSON.stringify([scope, url])), url, scope };
}

export function migratePageSessions(state) {
  for (const field of ["pageSessions", "surfaceSessions", "pageRequests"]) {
    if (state[field] === undefined) state[field] = {};
    if (!state[field] || typeof state[field] !== "object" || Array.isArray(state[field])) throw fault("INVALID_STATE", "页面会话资料格式不受支持；原资料已保留。");
  }
  return state;
}

/** Resolve metadata only. Detection never reads a page, selects a view or renews TTL. */
export function resolvePageSession(state, context, { at } = {}) {
  const identity = pageIdentity(context);
  const binding = state.pageSessions?.[identity.key];
  const conversation = binding && state.conversations.find(item => item.id === binding.conversationId && !item.deletedAt);
  const timestamp = Date.parse(stamp(at));
  const valid = conversation && Number.isFinite(Date.parse(binding.expiresAt)) && timestamp < Date.parse(binding.expiresAt);
  return {
    pageKey: identity.key, url: identity.url, status: valid ? "active" : conversation ? "expired" : "unread",
    ...(valid ? { conversationId: conversation.id } : conversation ? { previousConversationId: conversation.id } : {}),
    ...(conversation ? { startedAt: binding.startedAt, expiresAt: binding.expiresAt, readAt: conversation.pageSession?.readAt,
      title: conversation.title, hasDraft: Boolean(state.surfaceSessions?.companion?.drafts?.[conversation.id]?.text) } : {}),
  };
}

export function pageSource(state, conversationId) {
  const conversation = state.conversations.find(item => item.id === conversationId && !item.deletedAt);
  if (!conversation) throw fault("NOT_FOUND", "没有找到这段对话。", 404);
  if (!conversation.pageSource) throw fault("NOT_FOUND", "这段对话没有保存已读页面。", 404);
  return structuredClone(conversation.pageSource);
}

/** Commit only successful reads, in the same store transaction as their first event. */
export function acceptPageSession(state, { context, requestId, fingerprint, forceNew = false, reread = false, at } = {}) {
  migratePageSessions(state);
  if (!context || !["attached_text", "selection_only", "public_page"].includes(context.readStatus) || !["ready", "partial"].includes(context.contentQuality?.status)
      || !(context.text?.trim() || context.selection?.trim())) throw fault("PAGE_CONTENT_UNAVAILABLE", "没有读到可用于对话的正文。", 422);
  const identity = pageIdentity(context);
  const accepted = requestId && state.pageRequests[requestId];
  if (accepted) {
    if (accepted.fingerprint !== fingerprint) throw fault("INVALID_REQUEST", "同一读取请求不能替换为另一个页面或操作。");
    const conversation = state.conversations.find(item => item.id === accepted.conversationId);
    if (!conversation) throw fault("NOT_FOUND", "原页面会话已经不存在。", 404);
    return { conversationId: conversation.id, replayed: true, created: false };
  }
  const resolved = resolvePageSession(state, context, { at });
  let conversation = !forceNew && resolved.status === "active" && state.conversations.find(item => item.id === resolved.conversationId);
  const created = !conversation;
  const readAt = stamp(at);
  if (created) {
    conversation = { id: `conversation-${randomUUID()}`, title: (context.title || new URL(identity.url).hostname).slice(0, 80),
      titleSource: "page", originSurface: "companion", createdAt: readAt, updatedAt: readAt };
    state.conversations.push(conversation);
    conversation.pageSession = { pageKey: identity.key, url: identity.url, scope: identity.scope,
      startedAt: readAt, expiresAt: new Date(Date.parse(readAt) + PAGE_SESSION_TTL_MS).toISOString(), readAt };
    state.pageSessions[identity.key] = { conversationId: conversation.id, startedAt: readAt, expiresAt: conversation.pageSession.expiresAt };
  }
  let sourceMessageId;
  if (created || reread) {
    const snapshot = structuredClone(context);
    snapshot.snapshotId = `page-${hash(JSON.stringify([identity.url, snapshot.text || "", snapshot.selection || ""])).slice(0, 32)}`;
    snapshot.readAt = readAt;
    conversation.pageSource = snapshot;
    conversation.pageSession.readAt = readAt;
    conversation.pageSession.sourceId = snapshot.snapshotId;
    const event = { id: `message-${randomUUID()}`, role: "user", kind: "page-read", originSurface: "companion",
      text: `${reread && !created ? "重新读取" : "读取"}《${conversation.title}》`, conversationId: conversation.id, createdAt: readAt,
      context: structuredClone(snapshot), ...(requestId ? { requestId } : {}) };
    state.messages.push(event);
    sourceMessageId = event.id;
    conversation.updatedAt = readAt;
  }
  if (!sourceMessageId) sourceMessageId = state.messages.findLast(item => item.conversationId === conversation.id && item.kind === "page-read" && item.context?.snapshotId === conversation.pageSession.sourceId)?.id;
  if (requestId) state.pageRequests[requestId] = { conversationId: conversation.id, fingerprint, acceptedAt: readAt, sourceMessageId,
    sourceId: conversation.pageSession.sourceId };
  return { conversationId: conversation.id, replayed: false, created };
}

const SURFACES = new Set(["companion", "workspace"]);
export function updateSurfaceSession(state, { surface, conversationId, draft, followMode, at } = {}) {
  migratePageSessions(state);
  if (!SURFACES.has(surface)) throw fault("INVALID_REQUEST", "对话入口不受支持。");
  if (conversationId !== null && (typeof conversationId !== "string" || !state.conversations.some(item => item.id === conversationId && !item.deletedAt))) throw fault("NOT_FOUND", "没有找到这段对话。", 404);
  const previous = state.surfaceSessions[surface] || {};
  const result = { ...previous, conversationId, updatedAt: stamp(at) };
  if (followMode !== undefined) {
    if (!["follow", "pinned"].includes(followMode)) throw fault("INVALID_REQUEST", "页面跟随方式不受支持。");
    result.followMode = followMode;
  }
  if (draft !== undefined) {
    if (!draft || typeof draft !== "object" || typeof draft.text !== "string" || draft.text.length > 60000) throw fault("INVALID_REQUEST", "草稿格式不正确。");
    result.drafts = { ...previous.drafts, [conversationId || "new"]: { text: draft.text,
      ...(Number.isFinite(draft.scrollTop) ? { scrollTop: Math.max(0, draft.scrollTop) } : {}), updatedAt: stamp(at) } };
  }
  state.surfaceSessions[surface] = result;
  return result;
}

export function publicSurfaceSessions(state) {
  return structuredClone(state.surfaceSessions || {});
}

export function publicPageSession(conversation) {
  return conversation.pageSession ? structuredClone(conversation.pageSession) : undefined;
}
