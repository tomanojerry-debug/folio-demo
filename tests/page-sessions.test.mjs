import test from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_SESSION_TTL_MS, normalizePageURL, pageIdentity, migratePageSessions, resolvePageSession,
  acceptPageSession, pageSource, updateSurfaceSession, publicSurfaceSessions, publicPageSession,
} from "../desktop/server/harness/page-sessions.mjs";

const start = Date.parse("2026-11-10T07:00:00.000Z");
const newState = () => migratePageSessions({ conversations: [], messages: [], jobs: [] });
const source = (name = "a", more = {}) => ({ url: `https://example.org/${name}`, title: `Page ${name.toUpperCase()}`,
  appName: "Safari", attachmentId: "attached-window", pageRevision: `revision-${name}`, browserWindowId: "10", browserTabId: "20",
  text: `This is the actual read content of page ${name.toUpperCase()}, retained with its page identity.`,
  contentSource: "browser-accessibility", readStatus: "attached_text", contentQuality: { version: 1, status: "ready" }, ...more });
const accept = (state, context, more = {}) => acceptPageSession(state, { context, at: start, ...more });

test("page detection is read-only and does not create a conversation or source snapshot", () => {
  const state = newState(), before = structuredClone(state);
  const result = resolvePageSession(state, source(), { at: start });
  assert.equal(result.status, "unread");
  assert.equal(result.conversationId, undefined);
  assert.deepEqual(state, before);
});

test("A to B to A restores the same independently owned page conversation and original source", () => {
  const state = newState();
  const a = accept(state, source("a"));
  state.messages.push({ id: "a-question", role: "user", conversationId: a.conversationId, text: "Why does the article mention light?" });
  const b = accept(state, source("b"), { at: start + 60000 });
  state.messages.push({ id: "b-question", role: "user", conversationId: b.conversationId, text: "Explain the different page." });
  const restored = resolvePageSession(state, source("a", { browserTabId: "99" }), { at: start + 120000 });
  assert.equal(restored.status, "active");
  assert.equal(restored.conversationId, a.conversationId);
  assert.notEqual(a.conversationId, b.conversationId);
  assert.equal(state.conversations.length, 2);
  assert.equal(pageSource(state, a.conversationId).text, source("a").text);
  assert.equal(pageSource(state, b.conversationId).text, source("b").text);
  assert.equal(state.messages.find(message => message.id === "a-question").conversationId, a.conversationId);
});

test("automatic page restoration expires at the exact fixed 24-hour boundary", () => {
  const state = newState(), a = accept(state, source());
  const before = resolvePageSession(state, source(), { at: start + PAGE_SESSION_TTL_MS - 1 });
  assert.equal(before.status, "active");
  assert.equal(before.conversationId, a.conversationId);
  const expired = resolvePageSession(state, source(), { at: start + PAGE_SESSION_TTL_MS });
  assert.equal(expired.status, "expired");
  assert.equal(expired.previousConversationId, a.conversationId);
  assert.equal(expired.conversationId, undefined);
  assert.equal(state.conversations.length, 1);
  assert.equal(state.messages.length, 1);
  assert.equal(pageSource(state, a.conversationId).text, source().text);
});

test("crossing local midnight does not expire a page session younger than 24 hours", () => {
  const state = newState(), late = Date.parse("2026-11-10T15:55:00Z"); // 23:55 Asia/Shanghai.
  const a = accept(state, source(), { at: late });
  const result = resolvePageSession(state, source(), { at: late + 10 * 60000 });
  assert.equal(result.status, "active");
  assert.equal(result.conversationId, a.conversationId);
  assert.equal(result.expiresAt, "2026-11-11T15:55:00.000Z");
});

test("returning, rereading and reloading persisted state do not renew a session deadline", () => {
  const state = newState(), a = accept(state, source());
  const original = publicPageSession(state.conversations[0]);
  const refreshed = accept(state, source("a", { text: "Updated source content read at the user's explicit request.", pageRevision: "revision-a-2" }), { at: start + 23 * 3600000, reread: true });
  assert.equal(refreshed.created, false);
  assert.equal(refreshed.conversationId, a.conversationId);
  assert.equal(state.messages.length, 2);
  assert.equal(state.conversations[0].pageSession.expiresAt, original.expiresAt);
  assert.equal(state.conversations[0].pageSession.startedAt, original.startedAt);
  assert.equal(state.conversations[0].pageSession.readAt, new Date(start + 23 * 3600000).toISOString());
  const reloaded = migratePageSessions(JSON.parse(JSON.stringify(state)));
  assert.equal(resolvePageSession(reloaded, source(), { at: start + PAGE_SESSION_TTL_MS }).status, "expired");
});

test("an expired page receives a new identity only after another successful explicit read", () => {
  const state = newState(), old = accept(state, source());
  updateSurfaceSession(state, { surface: "companion", conversationId: old.conversationId, draft: { text: "Old unsent thought", scrollTop: 81 }, at: start });
  const expired = resolvePageSession(state, source(), { at: start + PAGE_SESSION_TTL_MS });
  assert.equal(expired.hasDraft, true);
  assert.equal(state.conversations.length, 1);
  const fresh = accept(state, source(), { at: start + PAGE_SESSION_TTL_MS + 1 });
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.conversationId, old.conversationId);
  assert.equal(state.conversations.length, 2);
  assert.equal(state.surfaceSessions.companion.drafts[old.conversationId].text, "Old unsent thought");
  assert.equal(state.surfaceSessions.companion.drafts[fresh.conversationId], undefined);
  assert.equal(resolvePageSession(state, source(), { at: start + PAGE_SESSION_TTL_MS + 2 }).conversationId, fresh.conversationId);
  assert.equal(pageSource(state, old.conversationId).text, source().text);
});

test("an explicit new discussion replaces only the automatic page mapping and keeps old history", () => {
  const state = newState(), old = accept(state, source());
  const fresh = accept(state, source(), { at: start + 5000, forceNew: true });
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.conversationId, old.conversationId);
  assert.equal(state.conversations.length, 2);
  assert.equal(state.messages.filter(message => message.kind === "page-read").length, 2);
  assert.equal(resolvePageSession(state, source(), { at: start + 6000 }).conversationId, fresh.conversationId);
  updateSurfaceSession(state, { surface: "workspace", conversationId: old.conversationId, at: start + 7000 });
  assert.equal(resolvePageSession(state, source(), { at: start + 8000 }).conversationId, fresh.conversationId);
});

test("replaying an accepted request never duplicates a source event or forced new conversation", () => {
  const state = newState();
  const first = accept(state, source(), { requestId: "request-1", fingerprint: "same-input", forceNew: true });
  const replayed = accept(state, source(), { at: start + PAGE_SESSION_TTL_MS, requestId: "request-1", fingerprint: "same-input", forceNew: true });
  assert.equal(replayed.conversationId, first.conversationId);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.created, false);
  assert.equal(state.messages.length, 1);
  assert.equal(state.conversations.length, 1);
});

test("an accepted request cannot be reused with a changed page or operation fingerprint", () => {
  const state = newState();
  accept(state, source(), { requestId: "request-1", fingerprint: "original-payload" });
  const before = structuredClone(state);
  assert.throws(() => accept(state, source("b"), { requestId: "request-1", fingerprint: "different-page" }), { code: "INVALID_REQUEST" });
  assert.throws(() => accept(state, source(), { requestId: "request-1", fingerprint: "different-operation", forceNew: true }), { code: "INVALID_REQUEST" });
  assert.deepEqual(state, before);
});

test("a failed, pending or unverified read never commits a page conversation or read event", () => {
  for (const context of [
    source("a", { readStatus: "unavailable", text: "" }),
    source("a", { contentQuality: { status: "unavailable" } }),
    source("a", { text: "", selection: "" }),
    source("a", { readStatus: "pending" }),
    source("a", { readStatus: undefined }),
    source("a", { contentQuality: undefined }),
  ]) {
    const state = newState(), before = structuredClone(state);
    assert.throws(() => accept(state, context, { requestId: "failed", fingerprint: "failed" }), { code: "PAGE_CONTENT_UNAVAILABLE" });
    assert.deepEqual(state, before);
  }
});

test("page identity removes known tracking only and preserves meaningful queries and SPA routes", () => {
  assert.equal(normalizePageURL("https://example.org/article?id=5&utm_source=mail&fbclid=x#greeting"), "https://example.org/article?id=5");
  assert.equal(normalizePageURL("https://example.org/article?id=5#/section/3"), "https://example.org/article?id=5#/section/3");
  assert.equal(normalizePageURL("https://example.org/article#!/post/8"), "https://example.org/article#!/post/8");
  assert.notEqual(pageIdentity(source("a", { url: "https://example.org/article?id=5" })).key, pageIdentity(source("a", { url: "https://example.org/article?id=6" })).key);
  assert.notEqual(pageIdentity(source("a", { url: "https://example.org/article#/post/5" })).key, pageIdentity(source("a", { url: "https://example.org/article#/post/6" })).key);
  assert.equal(pageIdentity(source("a", { url: "https://example.org/article?id=5&utm_source=x#one" })).key,
    pageIdentity(source("a", { url: "https://example.org/article?id=5#two", browserTabId: "99", browserWindowId: "98" })).key);
});

test("the same URL in separate browser profile scopes does not reuse another profile's source", () => {
  const state = newState(), first = accept(state, source("a", { browserProfileId: "personal" }));
  const other = source("a", { browserProfileId: "work" });
  assert.equal(resolvePageSession(state, other, { at: start }).status, "unread");
  const second = accept(state, other);
  assert.notEqual(first.conversationId, second.conversationId);
  assert.equal(state.conversations.length, 2);
});

test("surface cursors, drafts and scroll positions are independent across windows and conversations", () => {
  const state = newState(), a = accept(state, source("a")), b = accept(state, source("b"));
  updateSurfaceSession(state, { surface: "companion", conversationId: a.conversationId, draft: { text: "Companion draft A", scrollTop: 123 }, followMode: "pinned", at: start });
  updateSurfaceSession(state, { surface: "workspace", conversationId: b.conversationId, draft: { text: "Workspace draft B", scrollTop: 456 }, at: start + 1 });
  updateSurfaceSession(state, { surface: "companion", conversationId: b.conversationId, draft: { text: "Companion draft B", scrollTop: 789 }, followMode: "follow", at: start + 2 });
  updateSurfaceSession(state, { surface: "companion", conversationId: a.conversationId, at: start + 3 });
  const sessions = publicSurfaceSessions(state);
  assert.equal(sessions.companion.conversationId, a.conversationId);
  assert.equal(sessions.workspace.conversationId, b.conversationId);
  assert.deepEqual([sessions.companion.drafts[a.conversationId].text, sessions.companion.drafts[a.conversationId].scrollTop], ["Companion draft A", 123]);
  assert.deepEqual([sessions.companion.drafts[b.conversationId].text, sessions.workspace.drafts[b.conversationId].text], ["Companion draft B", "Workspace draft B"]);
  sessions.companion.drafts[a.conversationId].text = "Caller changed the projection";
  assert.equal(state.surfaceSessions.companion.drafts[a.conversationId].text, "Companion draft A");
});

test("source and metadata projections cannot mutate persisted records", () => {
  const state = newState(), a = accept(state, source());
  const snapshot = pageSource(state, a.conversationId), metadata = publicPageSession(state.conversations[0]);
  snapshot.text = "Caller mutation";
  metadata.expiresAt = "wrong";
  assert.equal(pageSource(state, a.conversationId).text, source().text);
  assert.equal(resolvePageSession(state, source(), { at: start }).status, "active");
});

test("deleted conversations stop automatic page restoration while unrelated histories remain", () => {
  const state = newState(), a = accept(state, source("a")), b = accept(state, source("b"));
  state.conversations.find(conversation => conversation.id === a.conversationId).deletedAt = new Date(start + 1).toISOString();
  assert.equal(resolvePageSession(state, source("a"), { at: start + 2 }).status, "unread");
  assert.equal(resolvePageSession(state, source("b"), { at: start + 2 }).conversationId, b.conversationId);
  assert.throws(() => pageSource(state, a.conversationId), { code: "NOT_FOUND" });
});
