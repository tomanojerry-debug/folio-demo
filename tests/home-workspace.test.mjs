import test from "node:test";
import assert from "node:assert/strict";
import { homeWorkspaceModel, renderWorkspace } from "../site/prototype/immersive-exhibition/light-workspace.js";
import { renderHomeDashboard } from "../site/prototype/immersive-exhibition/home-dashboard.js";

function workspace(overrides = {}) {
  return { collections: [], extractions: [], feedback: {}, workspaceJobs: [], studioNotes: [], exhibitionRecords: [], exhibitionNotes: [], exhibitions: [], ui: { lightPage: "home" }, ...overrides };
}
const collection = (id, more = {}) => ({ id, title: `收藏 ${id}`, source: "验收材料", status: "ready", type: "text", addedAt: "2026-11-09T06:00:00Z", ...more });
const extraction = (collectionId, more = {}) => ({ collectionId, status: "qualified", summary: `对 ${collectionId} 的真实理解。`, ...more });
const job = (id, more = {}) => ({ id, type: "ingest", status: "complete", result: "ready", createdAt: "2026-11-09T06:00:00Z", updatedAt: "2026-11-09T06:05:00Z", ...more });
const confirmed = (...ids) => Object.fromEntries(ids.map(id => [`understanding:${id}`, { decision: "confirmed" }]));
const count = (html, token) => html.split(token).length - 1;

test("empty home offers a light conversation entry and a first collection action", () => {
  const html = renderWorkspace({ state: workspace() });
  assert.match(html, /data-workspace-chat-form/);
  assert.match(html, /data-workspace-action="chat"[^>]*>继续对话/);
  assert.match(html, /placeholder="交给 Tag 一个问题，或一件想完成的事…"/);
  assert.match(html, /data-workspace-action="choose-chat-context"/);
  assert.match(html, /还没有可浏览的展览/);
  assert.match(html, /还没有可推荐的收藏/);
  assert.match(html, /推荐展览/);
  assert.match(html, /推荐收藏/);
  assert.doesNotMatch(html, /需要你|核对理解|all-needs/);
  assert.equal(count(html, 'data-action="toggle-capture"'), 1);
  assert.doesNotMatch(html, /data-recommend-gallery|ws-chat-prompts|ws-home-activity|ws-home-collections|ws-desk-recent-row/);
});

test("public home disables unavailable desktop chat while preserving the draft and collection actions", () => {
  const state = workspace({ collections: [collection("reference")], desktopCapabilities: { aiEnabled: true } });
  const html = renderHomeDashboard(state, [], { icon: () => "", draft: "想继续讨论的内容", contextIds: ["reference"] });
  assert.match(html, /桌面伙伴对话可在 Folio 客户端中使用/);
  for (const control of [
    /<textarea\b[^>]*\bid="workspace-chat-input"[^>]*>/,
    /<button\b[^>]*\bdata-workspace-action="choose-chat-context"[^>]*>/,
    /<button\b[^>]*\bdata-workspace-chat-send\b[^>]*>/,
    /<button\b[^>]*\bdata-workspace-action="chat"[^>]*>/,
  ]) {
    const tag = html.match(control)?.[0];
    assert.ok(tag, `expected control ${control}`);
    assert.match(tag, /\sdisabled(?:\s|=|>)/);
  }
  assert.match(html, /想继续讨论的内容<\/textarea>/);
  const capture = html.match(/<button\b[^>]*\bdata-action="toggle-capture"[^>]*>/)?.[0];
  assert.ok(capture);
  assert.doesNotMatch(capture, /\sdisabled(?:\s|=|>)/);
});

test("an available desktop chat keeps sending and history usable, with blank and pending drafts guarded", () => {
  const state = workspace({ collections: [collection("reference")], desktopCapabilities: { aiEnabled: true } });
  for (const sample of [false, true]) {
    const html = renderHomeDashboard(state, [], { icon: () => "", chatAvailable: true, draft: "一起看看这条收藏", sample });
    assert.doesNotMatch(html, /桌面伙伴对话可在 Folio 客户端中使用/);
    assert.doesNotMatch(html, /示例|sample=1/);
    for (const control of [
      /<textarea\b[^>]*\bid="workspace-chat-input"[^>]*>/,
      /<button\b[^>]*\bdata-workspace-action="choose-chat-context"[^>]*>/,
      /<button\b[^>]*\bdata-workspace-chat-send\b[^>]*>/,
      /<button\b[^>]*\bdata-workspace-action="chat"[^>]*>/,
    ]) {
      const tag = html.match(control)?.[0];
      assert.ok(tag, `expected control ${control}`);
      assert.doesNotMatch(tag, /\sdisabled(?:\s|=|>)/);
    }
  }
  for (const options of [{ draft: " \n " }, { draft: "正在提交", pending: true }]) {
    const html = renderHomeDashboard(state, [], { icon: () => "", chatAvailable: true, ...options });
    assert.match(html.match(/<button\b[^>]*\bdata-workspace-chat-send\b[^>]*>/)?.[0] || "", /\sdisabled(?:\s|=|>)/);
  }
});

test("an empty gallery reports no exhibition until an actual active curation job exists", () => {
  const backgroundJobs = [
    job("reading", { type: "ingest", status: "running" }),
    job("conversation", { type: "chat", status: "queued" }),
    job("old-failure", { type: "curate", status: "failed" }),
    job("waiting", { type: "curate", status: "complete", result: "waiting_for_content" }),
  ];
  for (const aiEnabled of [true, false]) {
    const html = renderWorkspace({ state: workspace({
      ui: { lightPage: "gallery" }, desktopCapabilities: { aiEnabled }, workspaceJobs: backgroundJobs,
    }) });
    assert.match(html, /还没有个人展览/);
    assert.match(html, /data-nav="inbox"/);
    assert.doesNotMatch(html, /浏览示例|sample=1/);
    assert.doesNotMatch(html, /展览还在整理中|有一场展览正在处理|查看整理进度/);
    if (!aiEnabled) assert.match(html, /连接智能整理后/);
  }
});

test("only queued or running curation jobs produce an in-progress exhibition empty state", () => {
  for (const status of ["queued", "running"]) {
    const html = renderWorkspace({ state: workspace({
      ui: { lightPage: "gallery" }, workspaceJobs: [job("curation", { type: "curate", status })],
    }) });
    assert.match(html, /展览还在整理中/);
    assert.match(html, /查看整理进度/);
    assert.doesNotMatch(html, /还没有个人展览/);
  }
});

test("newest actual completion wins over collection capture time and exhibition viewing state", () => {
  const state = workspace({
    collections: [collection("captured-first", { addedAt: "2026-11-01" }), collection("captured-last", { addedAt: "2026-11-09" })],
    extractions: [extraction("captured-first"), extraction("captured-last")],
    workspaceJobs: [
      job("first-job", { collectionId: "captured-first", createdAt: "2026-11-09T05:00:00Z", updatedAt: "2026-11-09T10:00:00Z" }),
      job("last-job", { collectionId: "captured-last", createdAt: "2026-11-09T06:00:00Z", updatedAt: "2026-11-09T07:00:00Z" }),
      job("exhibition-job", { type: "curate", result: "preview", exhibitionId: "opened", updatedAt: "2026-11-09T08:00:00Z" }),
    ],
  });
  const galleryItems = [{ id: "opened", title: "正在看的旧展览", status: "showing", live: true, generatedAt: "2026-11-08" }];
  const model = homeWorkspaceModel(state, galleryItems);
  assert.equal(model.output.key, "collection:captured-first");
  assert.equal(model.output.completedAt, "2026-11-09T10:00:00Z");
  assert.deepEqual(model.recent.map(item => item.key), ["exhibition:opened"]);
});

test("saved, incomplete, failed and rewriting collections are not finished output", () => {
  const state = workspace({
    collections: [collection("saved", { status: "saved" }), collection("partial", { status: "needs_confirmation" }), collection("missing", { status: "needs_input" }), collection("failed", { status: "failed" }), collection("rewrite"), collection("edited-live", { live: true }), collection("no-summary")],
    extractions: [extraction("saved"), extraction("partial", { status: "needs_confirmation" }), extraction("missing", { status: "needs_input" }), extraction("failed"), extraction("rewrite"), extraction("edited-live"), extraction("no-summary", { summary: "  " })],
    feedback: { "understanding:rewrite": { decision: "pending_rewrite" }, "understanding:edited-live": { decision: "confirmed_edited" } },
  });
  const model = homeWorkspaceModel(state);
  assert.equal(model.output, null);
  assert.deepEqual(model.outputs, []);
  assert.deepEqual(model.recommendations, []);
  assert.equal(Object.hasOwn(model, "needs"), false);
  assert.doesNotMatch(renderWorkspace({ state }), /需要你|核对理解|all-needs|查看处理记录/);
});

test("a qualified understanding is readable without adding an approval obligation to home", () => {
  const state = workspace({ collections: [collection("one")], extractions: [extraction("one")] });
  const model = homeWorkspaceModel(state);
  assert.equal(model.output.key, "collection:one");
  assert.equal(Object.hasOwn(model, "needs"), false);
  const html = renderWorkspace({ state });
  assert.equal(model.recommendations[0].item.id, "one");
  assert.match(html, /aria-label="查看收藏：收藏 one"/);
  assert.doesNotMatch(html, /收藏理解|ws-desk-spotlight|ws-desk-grid|这条理解，准确吗？|核对理解|需要你|all-needs|已确认|质量合格/);
});

test("confirmation resolves a qualified review without promoting insufficient source evidence", () => {
  const state = workspace({
    collections: [collection("qualified"), collection("partial", { status: "needs_confirmation" })],
    extractions: [extraction("qualified"), extraction("partial", { status: "needs_confirmation" })],
    feedback: confirmed("qualified", "partial"),
  });
  const model = homeWorkspaceModel(state);
  assert.deepEqual(model.outputs.map(item => item.collectionId), ["qualified"]);
  assert.deepEqual(model.recommendations.map(item => item.item.id), ["qualified"]);
  assert.equal(Object.hasOwn(model, "needs"), false);
});

test("review drafts and changed-source exhibitions stay out of home output and approval prompts", () => {
  const galleryItems = [
    { id: "draft", title: "展览草稿", needsReview: true, live: true, generatedAt: "2026-11-09" },
    { id: "changed", title: "来源已变", sourceReviewPending: true, status: "showing", live: true, generatedAt: "2026-11-08" },
    { id: "native-review", title: "原始草稿状态", status: "needs_review", live: true },
  ];
  const model = homeWorkspaceModel(workspace(), galleryItems);
  assert.deepEqual(model.outputs, []);
  assert.deepEqual(model.recommendations, []);
  assert.equal(Object.hasOwn(model, "needs"), false);
  const html = renderWorkspace({ state: workspace(), galleryItems });
  assert.doesNotMatch(html, /data-exhibition-id="draft"|来源需要核对|打开待核对草稿|需要你|核对理解|all-needs|ws-desk-recent-row|为你准备好了/);
});

test("retry recovery removes old failures and waiting curation never creates a result", () => {
  const state = workspace({
    workspaceJobs: [
      job("old", { type: "curate", status: "failed", createdAt: "2026-11-08" }),
      job("retry", { type: "curate", retryOf: "old", result: "waiting_for_content", createdAt: "2026-11-09" }),
      job("chat-done", { type: "chat", result: undefined }),
    ],
  });
  const model = homeWorkspaceModel(state);
  assert.deepEqual(model.outputs, []);
  assert.deepEqual(model.recommendations, []);
  assert.equal(Object.hasOwn(model, "needs"), false);
  assert.deepEqual(model.working, []);
  assert.doesNotMatch(renderWorkspace({ state }), /这次处理还需要继续|ws-desk-recent-row|已整理展览/);
});

test("current work remains quiet while failures do not become homepage obligations", () => {
  const state = workspace({
    collections: [collection("busy", { status: "processing" }), collection("failed", { status: "failed" })],
    workspaceJobs: [
      job("working", { collectionId: "busy", status: "running", harness: { steps: [{ name: "understand", status: "running" }] } }),
      job("failure", { collectionId: "failed", status: "failed" }),
      job("chat-source", { type: "chat", result: "source_unavailable" }),
    ],
  });
  const model = homeWorkspaceModel(state);
  assert.equal(model.working.length, 1);
  assert.equal(model.working[0].detail, "正在理解收藏");
  assert.deepEqual(model.recommendations, []);
  assert.equal(Object.hasOwn(model, "needs"), false);
  assert.equal(model.outputs.length, 0);
  const html = renderWorkspace({ state });
  assert.match(html, /查看进度/);
  assert.doesNotMatch(html, /查看处理记录|需要你|核对理解|all-needs|data-retry-job=|ws-desk-recent-row/);
});

test("chat completions and user-authored notes never masquerade as agent output", () => {
  const state = workspace({
    workspaceJobs: [job("answer", { type: "chat", result: undefined })],
    studioNotes: [{ id: "note", title: "我的私人手记", blocks: [{ ai: false, text: "用户写的内容。" }] }],
    exhibitionRecords: [{ id: "record", exhibitionTitle: "用户观展记录", content: "自己的感想。" }],
  });
  const model = homeWorkspaceModel(state);
  assert.equal(model.output, null);
  assert.deepEqual(model.recent, []);
  assert.doesNotMatch(renderWorkspace({ state }), /我的私人手记|用户观展记录|已留下手记/);
});

test("the full-width recommendation rail replaces the spotlight and does not repeat collection rows", () => {
  const ids = ["first", "second", "third", "fourth", "fifth", "sixth"];
  const state = workspace({
    collections: ids.map(id => collection(id)), extractions: ids.map(id => extraction(id)), feedback: confirmed(...ids),
    workspaceJobs: ids.map((id, index) => job(`job-${id}`, { collectionId: id, updatedAt: `2026-11-0${9 - index}T06:00:00Z` })),
  });
  const model = homeWorkspaceModel(state);
  assert.equal(model.output.collectionId, "first");
  assert.deepEqual(model.recommendations.map(item => item.item.id), ["first", "second", "third", "fourth", "fifth"]);
  assert.deepEqual(model.recent, []);
  const html = renderWorkspace({ state });
  assert.equal(count(html, '<article class="ws-collection ws-story-collection'), 5);
  assert.equal(count(html, 'aria-label="查看收藏：收藏 first"'), 1);
  assert.match(html, /<h2[^>]*>推荐收藏<\/h2>/);
  assert.match(html, /data-recommend-gallery="collections" tabindex="0" role="region" aria-label="推荐收藏，可左右拖动、滑动或使用方向键浏览"/);
  assert.match(html, /data-action="recommend-prev" aria-label="向左浏览推荐收藏"/);
  assert.match(html, /data-action="recommend-next" aria-label="向右浏览推荐收藏"/);
  assert.equal(count(html, '<button type="button" class="ws-card-open"'), 5);
  assert.doesNotMatch(html, /circular-card|ws-desk-spotlight|ws-desk-grid|<aside|收藏理解|ws-desk-recent-row|收藏 sixth/);
});

test("the old shared-tag recommendation opens actual collection details with its source group", () => {
  const state = workspace({
    collections: [collection("main", { addedAt: "2026-11-10" }), collection("one"), collection("two")],
    extractions: [extraction("main"), extraction("one", { tags: ["共同线索"] }), extraction("two", { tags: ["共同线索"] })],
  });
  const model = homeWorkspaceModel(state);
  assert.equal(model.output.collectionId, "main");
  assert.deepEqual(model.recommendations.map(({ item }) => item.id), ["one", "main", "two"]);
  assert.equal(model.recommendations[0].item.id, "one");
  assert.equal(model.recommendations[0].tag, "共同线索");
  assert.deepEqual(model.recommendations[0].members, ["one", "two"]);
  const html = renderWorkspace({ state });
  assert.match(html, /推荐收藏/);
  assert.match(html, /data-action="open-collection" data-collection-id="one" data-tag="共同线索" data-members="one,two"/);
  assert.match(html, /aria-label="查看收藏：收藏 one"/);
  assert.match(html, /data-collection-id="main" data-tag="最近收下" data-members="main"/);
  assert.doesNotMatch(html, /需要你|核对理解|all-needs/);
});

test("two unrelated private items still use real recent collection cards without an invented shared theme", () => {
  const state = workspace({
    collections: [collection("one"), collection("two")],
    extractions: [extraction("one", { tags: ["工具"] }), extraction("two", { tags: ["语言"] })],
  });
  const model = homeWorkspaceModel(state);
  assert.deepEqual(model.recommendations.map(item => item.item.id), ["one", "two"]);
  assert.ok(model.recommendations.every(item => item.tag === "最近收下" && item.evidence.length === 0));
  assert.deepEqual(model.recommendations.map(item => item.members), [["one"], ["two"]]);
  const html = renderWorkspace({ state });
  assert.equal(count(html, '<article class="ws-collection ws-story-collection'), 2);
  assert.match(html, /data-collection-id="one" data-tag="最近收下" data-members="one"/);
  assert.match(html, /data-collection-id="two" data-tag="最近收下" data-members="two"/);
  assert.doesNotMatch(html, /收藏达到|还差.*条|先添加.*条|外部推荐|共同线索|需要你|核对理解|all-needs/);
});

test("recommended exhibition cards retain their actual destinations and show real covers", () => {
  const state = workspace({ liveExhibitions: [{ id: "live", rooms: [{ title: "来自真实资料的章名" }] }] });
  const galleryItems = [{ id: "live", title: "真实展览", live: true, status: "showing", rooms: "1", sourceCollectionIds: ["one", "two"], image: "/assets/actual-exhibition-cover.png", generatedAt: "2026-11-09" }];
  const model = homeWorkspaceModel(state, galleryItems);
  assert.deepEqual(model.recent.map(item => item.key), ["exhibition:live"]);
  const html = renderWorkspace({ state, galleryItems });
  assert.match(html, /data-action="live-exhibition" data-exhibition-id="live"/);
  assert.match(html, /aria-label="查看展览：真实展览"/);
  assert.match(html, /data-recommend-gallery="exhibitions"/);
  assert.match(html, /src="\/assets\/actual-exhibition-cover\.png"/);
  const gallery = renderWorkspace({ state: { ...state, ui: { lightPage: "gallery" } }, galleryItems });
  const article = html.match(/<article class="ws-exhibition ws-story-card"[\s\S]*?<\/article>/)?.[0];
  assert.ok(article);
  assert.ok(gallery.includes(article), "首页与个人展览使用同一张展览卡片");
  assert.doesNotMatch(html, /circular-card|来自真实资料的章名|ws-desk-spotlight|ws-desk-grid|ws-desk-chapters/);
  const sample = renderWorkspace({ state: workspace(), galleryItems: [{ title: "独立示例展览", index: 2, rooms: 2 }] });
  assert.match(sample, /data-action="gallery-all-open" data-index="2"/);
});

test("unknown exhibition completion dates are omitted rather than invented", () => {
  const state = workspace();
  const galleryItems = [{ id: "undated", title: "日期未知的展览", live: true }];
  const model = homeWorkspaceModel(state, galleryItems);
  assert.equal(model.recent[0].completedAt, "");
  const html = renderWorkspace({ state, galleryItems });
  assert.match(html, /推荐展览/);
  assert.doesNotMatch(html, /<time|20 分钟前|昨天|刚刚完成/);
});

test("an original saved without AI appears on home without being counted as a completed output", () => {
  const state = workspace({
    collections: [
      collection("original", { status: "saved", content: "这是用户保存的原始文字。" }),
      collection("empty", { status: "saved" }),
      collection("processing", { status: "processing", content: "仍在处理的内容。" }),
    ],
  });
  const model = homeWorkspaceModel(state);
  assert.equal(model.output, null);
  assert.deepEqual(model.recommendations.map(({ item }) => item.id), ["original"]);
  const html = renderWorkspace({ state });
  assert.match(html, /data-collection-id="original" data-tag="最近收下"/);
  assert.match(html, /class="ws-collection ws-story-collection ws-collection-text"/);
  assert.match(html, /这是用户保存的原始文字。/);
  assert.doesNotMatch(html, /data-collection-id="(?:empty|processing)"|为你准备好了/);
});

test("composer shows only bounded, existing collection references and preserves the draft", () => {
  const state = workspace({ collections: Array.from({ length: 8 }, (_, i) => collection(`c${i}`)) });
  const html = renderHomeDashboard(state, [], { icon: () => "", draft: "把这几条收藏连起来看看", contextIds: ["missing", "c0", "c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"] });
  assert.match(html, /把这几条收藏连起来看看<\/textarea>/);
  assert.equal(count(html, 'class="ws-desk-chat-reference"'), 6);
  assert.match(html, /清除本次收藏引用/);
  assert.doesNotMatch(html, /aria-label="missing"|aria-label="收藏 c7"/);
});

test("external recommendation, exhibition, draft and feedback text is escaped", () => {
  const attack = '<img src=x onerror="bad()">&';
  const state = workspace({
    collections: [collection('one" injected="yes', { title: attack }), collection("partner"), collection("source", { title: attack, status: "needs_input" })],
    extractions: [extraction('one" injected="yes', { summary: '<script>bad()</script>', tags: [attack] }), extraction("partner", { tags: [attack] })],
    liveExhibitions: [{ id: 'live" injected="yes', rooms: [{ title: attack }] }],
  });
  const galleryItems = [{ id: 'live" injected="yes', title: attack, live: true, lead: attack, generatedAt: "2026-11-09T09:00:00Z", rooms: 1 }];
  const html = renderWorkspace({ state, galleryItems });
  assert.doesNotMatch(html, /<script[\s>]|<img src=x/);
  assert.doesNotMatch(html, /data-collection-id="one" injected=|data-exhibition-id="live" injected=/);
  assert.match(html, /aria-label="查看收藏：&lt;img/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;&amp;/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  const composer = renderHomeDashboard(workspace(), [], { icon: () => "", draft: '</textarea><script>draft()</script>', feedback: attack });
  assert.doesNotMatch(composer, /<script[\s>]|<img src=x/);
  assert.match(composer, /&lt;\/textarea&gt;&lt;script&gt;draft\(\)&lt;\/script&gt;/);
});
