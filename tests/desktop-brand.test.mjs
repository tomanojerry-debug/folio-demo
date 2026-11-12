import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialState, openState } from "../desktop/server/state.mjs";
import { acquireDataLock } from "../desktop/server/lock.mjs";
import { createDesktopService } from "../desktop/server/service.mjs";
import { buildConversationContext } from "../desktop/server/harness/context.mjs";

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "folio-brand-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function legacyState(name = "拾") {
  return {
    version: 1,
    profile: { name, personality: "保留我的判断", preferences: "自然光\n旧物", extra: { preferred: "建筑" } },
    collections: [{ id: "collection-one", title: "我的拾光笔记", content: "原始正文不能被改名替换。", receipt: { signature: "preserve-this", evidence: ["evidence-one"] } }],
    exhibitions: [{ id: "exhibition-one", title: "拾光展", collectionIds: ["collection-one"], notes: [{ text: "我写给自己的观展记录" }] }],
    messages: [{ id: "message-one", role: "assistant", text: "我是拾，这条历史消息应当原样保留。", pageSource: { url: "https://example.com/source", title: "原始来源" } }],
    jobs: [{ id: "job-one", status: "queued", snapshot: { profile: { name: "拾", preferences: "提交时的偏好" } }, attempts: [{ status: "failed", error: "保留历史" }] }],
    checkpoint: { collectionIds: ["collection-one"], preferences: "保留额外字段" },
  };
}

test("fresh desktop data uses Tag and saves its branding marker with private file permissions", async (t) => {
  assert.equal(initialState().profile.name, "Tag");
  const directory = await temporary(t);
  const store = await openState(directory);
  const saved = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
  assert.deepEqual(saved, store.read());
  assert.equal(saved.version, 1);
  assert.equal(saved.brandingVersion, 2);
  assert.deepEqual(saved.profile, { name: "Tag", personality: "安静敏锐", preferences: "" });
  for (const key of ["collections", "exhibitions", "messages", "jobs"]) assert.deepEqual(saved[key], []);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, "state.json"))).mode & 0o777, 0o600);
});

test("legacy default migration changes only the profile default and preserves every user-owned record", async (t) => {
  const directory = await temporary(t);
  const before = legacyState();
  await writeFile(path.join(directory, "state.json"), JSON.stringify(before));
  const store = await openState(directory);
  const expected = structuredClone(before);
  expected.profile.name = "Tag";
  expected.brandingVersion = 2;
  assert.deepEqual(store.read(), expected);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")), expected);
  assert.deepEqual((await readdir(directory)).sort(), ["state.json"], "atomic save leaves no temporary migration artifacts");
  assert.equal((await stat(path.join(directory, "state.json"))).mode & 0o777, 0o600);
});

test("the previous companion default migrates to Tag without rewriting history or task snapshots", async (t) => {
  for (const brandingVersion of [undefined, 1]) {
    const directory = await temporary(t);
    const before = { ...legacyState("阿序"), ...(brandingVersion === undefined ? {} : { brandingVersion }) };
    before.messages[0].text = "我是阿序，保留原来的历史内容。";
    before.jobs[0].snapshot.profile.name = "阿序";
    await writeFile(path.join(directory, "state.json"), JSON.stringify(before));
    const expected = { ...structuredClone(before), brandingVersion: 2 };
    expected.profile.name = "Tag";
    assert.deepEqual((await openState(directory)).read(), expected);
    assert.deepEqual((await openState(directory)).read(), expected, "the brand migration is idempotent");
  }
});

test("a former default chosen as a nickname after the first migration is retained", async (t) => {
  const directory = await temporary(t);
  const before = { ...legacyState("拾"), brandingVersion: 1 };
  await writeFile(path.join(directory, "state.json"), JSON.stringify(before));
  assert.deepEqual((await openState(directory)).read(), { ...before, brandingVersion: 2 });
});

test("only the generated legacy conversation title follows the new companion name", async (t) => {
  const directory = await temporary(t);
  const before = { ...legacyState("阿序"), brandingVersion: 1, conversations: [
    { id: "automatic", title: "此前与阿序的对话", titleSource: "legacy" },
    { id: "custom", title: "此前与阿序的对话", titleSource: "user" },
    { id: "other", title: "我给阿序起的标题", titleSource: "legacy" },
  ] };
  await writeFile(path.join(directory, "state.json"), JSON.stringify(before));
  const expected = { ...structuredClone(before), brandingVersion: 2 };
  expected.profile.name = "Tag";
  expected.conversations[0].title = "此前与 Tag 的对话";
  assert.deepEqual((await openState(directory)).read(), expected);
});

test("legacy custom names are preserved exactly while the one-time migration is recorded", async (t) => {
  for (const name of ["小墨", "拾光", " 拾 ", ""]) {
    const directory = await temporary(t);
    const before = legacyState(name);
    await writeFile(path.join(directory, "state.json"), JSON.stringify(before));
    const store = await openState(directory);
    assert.deepEqual(store.read(), { ...before, brandingVersion: 2 });
    assert.equal((await openState(directory)).read().profile.name, name);
  }
});

test("reopening never migrates again after a person explicitly chooses either former default as a nickname", async (t) => {
  const directory = await temporary(t);
  await writeFile(path.join(directory, "state.json"), JSON.stringify(legacyState()));
  const store = await openState(directory);
  assert.equal(store.read().profile.name, "Tag");
  await store.update((draft) => {
    draft.profile.name = "拾";
    draft.profile.preferences += "\n保留此昵称";
    draft.messages.push({ id: "message-after-migration", role: "user", text: "我主动把昵称设回了拾。" });
  });
  const chosen = store.read();
  assert.deepEqual((await openState(directory)).read(), chosen);
  assert.deepEqual((await openState(directory)).read(), chosen);
  assert.equal(chosen.brandingVersion, 2);
  assert.equal(chosen.profile.name, "拾");
  await store.update(draft => { draft.profile.name = "阿序"; });
  assert.deepEqual((await openState(directory)).read(), store.read());
});

test("a newer branding marker is retained and never downgrades or renames saved data", async (t) => {
  const directory = await temporary(t);
  const before = { ...legacyState(), brandingVersion: 3 };
  await writeFile(path.join(directory, "state.json"), JSON.stringify(before));
  assert.deepEqual((await openState(directory)).read(), before);
});

test("Folio displays current product names for saved aliases and accepts Tag in settings", async (t) => {
  const directory = await temporary(t);
  const filename = path.join(directory, "state.json");
  const before = { ...initialState(), profile: { name: "阿序", personality: "安静敏锐", preferences: "" }, conversations: [
    { id: "automatic", title: "此前與觀序的對話", titleSource: "legacy" },
    { id: "custom", title: "此前與觀序的對話", titleSource: "manual" },
  ], messages: [{ id: "original", conversationId: "automatic", role: "assistant", text: "我是阿序。", createdAt: "2026-11-10T00:00:00.000Z" }] };
  await writeFile(filename, JSON.stringify(before));
  const service = await createDesktopService({ directory, config: { embeddingBackend: "disabled" }, aiEnabled: false });
  t.after(() => service.close());
  const shown = service.state();
  assert.equal(shown.profile.name, "Tag");
  assert.deepEqual(shown.conversations.map(item => item.title), ["此前与 Tag 的对话", before.conversations[1].title]);
  assert.equal(shown.messages[0].text, before.messages[0].text);
  const persisted = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persisted.profile.name, before.profile.name);
  assert.deepEqual(persisted.conversations.map(item => item.title), before.conversations.map(item => item.title));
  for (const name of [" 观序 ", "觀序", "阿序", "阿叙", "阿敘", "tAG", "ＴＡＧ"]) {
    assert.equal((await service.profile({ name })).state.profile.name, "Tag");
  }
  assert.equal((await service.profile({ name: "拾" })).state.profile.name, "拾");
});

test("chat describes Folio and Tag while treating historical names as history", () => {
  const snapshot = { name: "阿序", personality: "安静敏锐", preferences: "" };
  const state = { ...initialState(), messages: [{ id: "current", role: "user", text: "你叫什么名字？" }] };
  const { messages } = buildConversationContext({ state, messageId: "current", profile: snapshot });
  assert.match(messages[0].content, /Folio 的私人策展伙伴 Tag/);
  assert.match(messages[0].content, /历史称呼只作回顾，不是当前身份/);
  const reference = messages.find(item => item.content.startsWith("策展参考资料"));
  assert.equal(JSON.parse(reference.content.split("\n")[1]).profile.name, "Tag");
  assert.equal(snapshot.name, "阿序");
});

test("unsupported data remains byte-for-byte untouched instead of receiving a partial branding migration", async (t) => {
  const directory = await temporary(t);
  const invalid = JSON.stringify({ ...legacyState(), collections: null }, null, 4);
  await writeFile(path.join(directory, "state.json"), invalid);
  await assert.rejects(openState(directory), /本地资料格式不受支持/);
  assert.equal(await readFile(path.join(directory, "state.json"), "utf8"), invalid);
});

test("a live data lock keeps its stable error code and uses the current product name", async (t) => {
  const directory = await temporary(t);
  const lock = await acquireDataLock(directory);
  t.after(() => lock.release());
  await assert.rejects(acquireDataLock(directory), (error) => {
    assert.equal(error.code, "DATA_DIRECTORY_LOCKED");
    assert.match(error.message, /Folio/);
    assert.equal(error.message.includes("FORME"), false);
    return true;
  });
});
