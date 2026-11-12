// The desktop presentation uses the existing store and business actions.
// Only browsing preferences live here; content continues through the desktop adapter.
import { renderHomeDashboard } from "./home-dashboard.js?v=20261111-name-font";
import { closeGlassDialog } from "../../curator/glass-dialogs.js";
import { curationColor } from "../../curator/curation-theme.js";
import { collectionCardColorFromImage, coverColorPattern, neutralCoverColor } from "../../curator/collection-card-color.js";
import { collectionHeadline } from "../../curator/collection-headline.js";
import { layoutExhibitionRows } from "../../curator/exhibition-row-layout.js";
import { mountCompanionAvatar } from "../../curator/companion-avatar.js";
export { homeWorkspaceModel } from "./home-dashboard.js";

const escape = (value = "") => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const storyImage = value => typeof value === "string" && /^(?:https?:\/\/|data:image\/(?:png|jpeg|jpg|webp|gif);base64,|\/(?!\/)|\.\.?\/)/iu.test(value) ? value : "";
export const exhibitionStorySize = count => count >= 10 ? "large" : count >= 6 ? "medium" : "small";
const preferences = { query: "", filter: "all", theme: "", recent: false, sort: "newest", layout: "masonry", page: "inbox" };
const weekInMilliseconds = 7 * 24 * 60 * 60 * 1000;
let homeDraft = "";
let homeContextIds = [];
let chatPending = false;
let chatFeedback = "";
let chatComposing = false;
let chatCompositionEndedAt = -Infinity;
const workspaceChatAvailable = () => typeof window !== "undefined" && typeof window.__FORME_DESKTOP__?.openChat === "function";
const desktopChatNotice = "桌面伙伴对话可在 Folio 客户端中使用";
const pageLabels = { home: ["首页", "私人空间"], inbox: ["我的收藏", "留下喜欢"], gallery: ["个人展览", "收藏之间"], records: ["思考手记", "思考与摘录"] };
const paths = {
  home: '<path d="m3 10 7-6 7 6v7H5v-7M8 17v-5h4v5"/>',
  inbox: '<rect x="4" y="3" width="12" height="14" rx="2"/><path d="M7 7h6M7 10h6M7 13h3"/>',
  gallery: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="m3 12 4-4 4 4 2-2 4 4M13 7h.01"/>',
  records: '<path d="M4 3h9l3 3v11H4zM12 3v4h4M7 10h6M7 13h4"/>',
  search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  arrow: '<path d="M4 10h12m-5-5 5 5-5 5"/>',
  external: '<path d="M11 3h6v6m0-6L8 12M8 4H4v12h12v-4"/>',
  grid: '<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/>',
  list: '<path d="M7 5h10M7 10h10M7 15h10M3 5h.01M3 10h.01M3 15h.01"/>',
  sort: '<path d="M6 3v14m-3-3 3 3 3-3M11 5h6M11 9h4M11 13h2"/>',
  close: '<path d="m5 5 10 10M5 15 15 5"/>',
  check: '<path d="m4 10 4 4 8-9"/>',
  chat: '<path d="M4 4h12v9H9l-5 4zM7 8h6"/>',
  connections: '<circle cx="5" cy="5" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="15" r="2"/><path d="m7 5 6 1M6 7l2 6m6-5-4 5"/>',
  up: '<path d="M10 16V4m-5 5 5-5 5 5"/>',
  chevron: '<path d="m6 8 4 4 4-4"/>',
};
export const icon = (name) => `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.inbox}</svg>`;

export function collectionKind(item) {
  if (["image", "image_note"].includes(item.type)) return "image";
  if (["video", "video_note"].includes(item.type)) return "video";
  if (["user_input", "text", "note"].includes(item.type)) return "text";
  return "link";
}

export function matchesWorkspaceItem(item, { query = "", filter = "all", theme = "" } = {}) {
  const text = [item.title, item.summary, item.source, ...(item.tags || [])].join(" ").toLocaleLowerCase();
  return (!query.trim() || text.includes(query.trim().toLocaleLowerCase()))
    && (filter === "all" || item.kind === filter || item.status === filter)
    && (!theme || text.includes(theme.toLocaleLowerCase()));
}

const date = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(parsed);
};
function compareDates(a, b, sort = "newest") {
  const first = Date.parse(a), second = Date.parse(b);
  if (!Number.isFinite(first)) return Number.isFinite(second) ? 1 : 0;
  if (!Number.isFinite(second)) return -1;
  return sort === "oldest" ? first - second : second - first;
}
const heading = (page, count, action = "") => `<div class="ws-page-heading"><div class="ws-title-line"><h1>${pageLabels[page][0]}</h1>${Number.isFinite(count) ? `<span class="ws-heading-count">${count}</span>` : ""}</div>${action}</div>`;
const button = (text, action, { primary = false, glyph = "", attrs = "" } = {}) => `<button type="button" class="btn ws-button${primary ? " ws-button-primary" : ""}" data-variant="${primary ? "primary" : "outline"}" data-size="sm" ${action ? `data-action="${action}"` : ""} ${attrs}>${glyph ? icon(glyph) : ""}<span>${text}</span></button>`;
const countNote = (s) => (s.exhibitionRecords?.length || 0) + (s.exhibitionNotes?.length || 0) + (s.studioNotes?.length || 0);
const sortTimeLabels = { inbox: "收藏", gallery: "生成", records: "更新" };
const workspaceSort = () => preferences.recent ? "newest" : preferences.sort;
const sortLabel = (page, sort) => `${sort === "oldest" ? "最早" : "最近"}${sortTimeLabels[page]}`;
function searchBar(page, hint) {
  const sort = workspaceSort();
  const selected = sortLabel(page, sort);
  const options = ["newest", "oldest"].map(key => `<button type="button" role="menuitemradio" id="workspace-sort-${key}" aria-checked="${sort === key}" data-workspace-sort-value="${key}"${preferences.recent && key === "oldest" ? " disabled" : ""}>${icon("check")}<span>${sortLabel(page, key)}</span></button>`).join("");
  return `<div class="ws-browse-tools"><label class="ws-search" for="workspace-search">${icon("search")}<input class="input" type="search" id="workspace-search" aria-label="搜索${pageLabels[page][0]}" placeholder="${hint}" value="${escape(preferences.query)}" autocomplete="off"/><kbd aria-label="快捷搜索">⌘ K</kbd></label><div class="ws-browse-actions"><div class="dropdown-menu ws-sort-menu"><button type="button" id="workspace-sort-trigger" class="btn ws-button ws-sort-trigger" data-variant="ghost" data-size="sm" aria-label="排序方式：${selected}" aria-haspopup="menu" aria-controls="workspace-sort-options" aria-expanded="false">${icon("sort")}<span data-workspace-sort-label>${selected}</span>${icon("chevron")}</button><div data-popover aria-hidden="true" data-align="end" class="ws-menu-popover"><div role="menu" id="workspace-sort-options" aria-label="按${sortTimeLabels[page]}时间排序">${options}</div></div></div>${page === "inbox" ? `<div class="ws-view-switch" role="group" aria-label="收藏显示方式"><button type="button" class="btn ws-icon-button" data-variant="ghost" data-size="icon-sm" data-workspace-layout="masonry" aria-label="卡片视图" aria-pressed="${preferences.layout === "masonry"}" data-tooltip="卡片视图" data-side="bottom">${icon("grid")}</button><button type="button" class="btn ws-icon-button" data-variant="ghost" data-size="icon-sm" data-workspace-layout="list" aria-label="列表视图" aria-pressed="${preferences.layout === "list"}" data-tooltip="列表视图" data-side="bottom">${icon("list")}</button></div>` : ""}</div></div>`;
}
function filterBar(options) {
  const recentToggle = preferences.page === "inbox" || preferences.page === "gallery"
    ? `<button type="button" class="ws-filter ws-time-filter" data-workspace-action="toggle-recent" aria-pressed="${preferences.recent}">近 7 天</button>` : "";
  return `<div class="ws-filter-bar"><div class="ws-filters" role="group" aria-label="筛选内容">${options.map(([key, text]) => `<button type="button" data-workspace-filter="${key}" class="ws-filter${preferences.filter === key ? " is-active" : ""}" aria-pressed="${preferences.filter === key}">${text}</button>`).join("")}${recentToggle}</div><span class="ws-result-count" data-workspace-result role="status"></span></div>${preferences.theme ? `<div class="ws-applied-theme"><span>主题：${escape(preferences.theme)}</span><button type="button" data-workspace-action="clear-theme" aria-label="清除主题筛选">${icon("close")}</button></div>` : ""}`;
}
const noResults = () => `<div class="ws-no-results" data-workspace-empty hidden>${icon("search")}<h2>没有找到匹配内容</h2><p>试试其他关键词，或清除当前筛选。</p><button class="btn ws-button" data-variant="outline" data-size="sm" type="button" data-workspace-action="clear-filters">清除筛选</button></div>`;
function emptyState(title, copy, action) {
  return `<div class="ws-empty-state">${icon("inbox")}<h2>${title}</h2><p>${copy}</p>${action}</div>`;
}
function itemAttributes(item) {
  return `data-workspace-item data-title="${escape(item.title)}" data-summary="${escape(item.summary)}" data-source="${escape(item.source)}" data-kind="${escape(item.kind)}" data-status="${escape(item.status)}" data-tags="${escape((item.tags || []).join("|"))}" data-date="${escape(item.date)}"`;
}
function collectionCard(item, s, artwork, index = 0, recommendation) {
  const headline = item.live && ["article", "web", "link"].includes(item.type) ? collectionHeadline(item) : item.title;
  const ex = s.extractions.find(entry => entry.collectionId === item.id);
  const review = s.feedback?.[`understanding:${item.id}`];
  const tags = review?.acceptedTags || [...new Set([...(ex?.tags || []), ...(ex?.concepts || [])])];
  const image = storyImage(item.thumbnail) || storyImage(artwork[item.id]) || storyImage(item.image);
  const summary = recommendation?.summary ?? (ex?.summary || item.summary || "");
  const kind = collectionKind(item);
  const status = { ready: "已整理", processing: "整理中", queued: "等待整理", failed: "整理未完成", needs_input: "待补充", needs_confirmation: "待确认", saved: "已收藏" }[item.status] || "已收藏";
  const importantStatus = !["ready", "saved"].includes(item.status);

  const knownColor = image && image === item.thumbnail && coverColorPattern.test(item.coverColor) ? ` data-cover-color="${item.coverColor}"` : "";
  const related = recommendation ? ` data-tag="${escape(recommendation.tag)}" data-members="${escape(recommendation.members.join(","))}"` : "";
  return `<article class="ws-collection ws-story-collection${image ? "" : " ws-collection-text"}"${knownColor} ${itemAttributes({ ...item, summary, tags, kind, date: item.addedAt })}>
    <button type="button" class="ws-card-open" data-action="open-collection" data-collection-id="${escape(item.id)}"${related} aria-label="查看收藏：${escape(headline)}">
      ${image ? `<div class="ws-collection-media"><img src="${escape(image)}" alt="" decoding="async" referrerpolicy="no-referrer" loading="${index < 3 ? "eager" : "lazy"}"/>${kind === "video" ? '<span class="ws-video-mark" aria-hidden="true">▶</span>' : ""}</div>` : ""}
      <div class="ws-text-preview"${image ? " hidden" : ""}>${icon(kind === "text" ? "records" : "external")}<p>${escape(summary || headline)}</p></div>
      <div class="ws-collection-caption"><div class="ws-card-meta"><span>${escape(item.source || ({ image: "图片", video: "视频", text: "随手记", link: "网页" })[kind])}</span>${importantStatus ? `<span class="ws-item-status is-${escape(item.status)}">${escape(status)}</span>` : `<span>${date(item.addedAt)}</span>`}</div><h2>${escape(headline)}</h2>${summary ? `<p class="ws-card-summary">${escape(summary)}</p>` : ""}</div>
    </button>
  </article>`;
}
function exhibitionCard(item, index, s, artwork, featured = false) {
  const snapshots = item.items || [];
  const sourceIds = [...new Set([...(item.sourceCollectionIds || []), ...(item.collectionIds || []), ...(Array.isArray(item.rooms) ? item.rooms.flatMap(room => room.exhibit_ids || []) : []), ...(!item.live ? snapshots.map(source => source.id) : [])])];
  const sources = sourceIds.map(id => s.collections.find(source => source.id === id) || snapshots.find(source => source.id === id)).filter(Boolean);
  const cover = storyImage(item.image) || sources.map(source => storyImage(source.thumbnail)).find(Boolean) || "";
  const action = item.live ? `data-action="live-exhibition" data-exhibition-id="${escape(item.id)}"` : `data-action="gallery-all-open" data-index="${escape(item.index ?? index)}"`;
  const summary = item.lead || item.subtitle || "";
  const enterLabel = item.needsReview ? "打开待核对草稿" : featured && item.status === "showing" ? "继续看展" : "打开展览";
  const count = sources.length || (item.live ? 0 : s.collections.length);
  const accent = curationColor(item);
  const topic = item.kind === "local-topic";
  const detail = topic ? "自动专题" : `${Number(item.rooms) || item.rooms?.length || 0} 个章节${item.needsReview ? " · 待核对" : ""}`;
  const generatedAt = item.generatedAt || item.createdAt || "";
  const dateLabel = date(generatedAt);
  return `<article class="ws-exhibition ws-story-card${featured ? " is-featured" : ""}${cover ? "" : " is-text-only"}" style="--ws-story-color:${accent}" data-story-size="${exhibitionStorySize(count)}" data-story-count="${count}" data-exhibition-layout-id="${escape(item.id)}" ${itemAttributes({ ...item, summary, kind: "exhibition", date: generatedAt })}><button type="button" class="ws-exhibition-open" ${action} aria-label="查看展览：${escape(item.title)}"><div class="ws-exhibition-cover">${cover ? `<img src="${escape(cover)}" alt="" loading="lazy"/>` : `<span class="ws-story-card-mark" aria-hidden="true">${icon("gallery")}</span>`}</div><div class="ws-exhibition-body"><div class="ws-story-card-meta"><span>${count} 件收藏</span>${dateLabel ? `<time>${dateLabel}</time>` : ""}</div><h2>${escape(item.title)}</h2>${summary ? `<p class="ws-exhibition-description">${escape(summary)}</p>` : ""}<div class="ws-exhibition-footer"><span>${detail}</span><span class="ws-exhibition-enter">${topic ? "打开专题" : enterLabel}${icon("arrow")}</span></div></div></button></article>`;
}
function noteText(note) {
  return note.blocks ? note.blocks.map(b => b.text).join("\n") : [note.kind === "image" ? "" : note.content, note.comment].filter(Boolean).join("\n");
}
function noteImages(note) { return note.kind === "image" ? [note.content].filter(Boolean) : (note.images || []); }
function noteCard(note) {
  const isStudio = Boolean(note.blocks);
  const content = noteText(note);
  const images = noteImages(note);
  const kind = isStudio ? "studio" : note.exhibitId ? "excerpt" : "thought";
  const title = isStudio ? note.title : note.exhibitionTitle || "一条想法";
  return `<article class="ws-note" ${itemAttributes({ ...note, title, summary: content, kind, date: note.updatedAt || note.createdAt })}><button type="button" class="ws-note-open" data-workspace-note="${escape(note.id)}" data-note-kind="${kind}" aria-label="阅读手记：${escape(title)}"><div class="ws-note-top"><span>${({ studio: "个人手记", excerpt: "观展摘录", thought: "观展随笔" })[kind]}</span><time>${date(note.updatedAt || note.createdAt)}</time></div>${images[0] ? `<img class="ws-note-media" src="${escape(images[0])}" alt="保存于手记的图片" loading="lazy"/>` : ""}<h2>${escape(title)}</h2>${content || !images.length ? `<p>${escape(content || "这篇手记还没有正文。")}</p>` : ""}<footer><span>${note.status === "draft" ? "草稿" : escape(note.readingSource?.title || note.exhibitTitle || "")}</span>${icon("arrow")}</footer></button></article>`;
}

function renderHome(s, galleryItems, artwork) {
  homeContextIds = homeContextIds.filter(id => s.collections.some(item => item.id === id));
  return renderHomeDashboard(s, galleryItems, {
    icon, draft: homeDraft, contextIds: homeContextIds, pending: chatPending, feedback: chatFeedback,
    chatAvailable: workspaceChatAvailable(),
    renderCollectionCard: (recommendation, index) => collectionCard(recommendation.item, s, artwork, index, recommendation),
    renderExhibitionCard: (item, index) => exhibitionCard(item, index, s, artwork),
  });
}

export function renderWorkspace({ state: s, galleryItems = [], artwork = {} }) {
  const page = s.ui.lightPage || "home";
  if (preferences.page !== page) { preferences.query = ""; preferences.filter = "all"; preferences.theme = ""; preferences.recent = false; preferences.page = page; }
  const collections = [...s.collections].sort((a, b) => compareDates(a.addedAt, b.addedAt));
  let content = "";
  if (page === "home") {
    content = renderHome(s, galleryItems, artwork);
  } else if (page === "inbox") {
    content = `${heading(page, collections.length, button(s.desktopCapabilities?.publicDemo ? "试用整理" : "收新", "toggle-capture", { primary: true, glyph: "plus", attrs: 'aria-haspopup="dialog"' }))}${searchBar(page, "搜索收藏、关键词或来源")}${filterBar([["all", "全部"], ["image", "图片"], ["video", "视频"], ["link", "网页"], ["text", "文字"]])}${collections.length ? `<div class="ws-collection-grid" data-workspace-grid data-layout="${preferences.layout}">${collections.map((c, i) => collectionCard(c, s, artwork, i)).join("")}</div>${noResults()}` : emptyState("还没有收藏", "添加网页、文字或图片，开始建立自己的收藏。", `${button("添加收藏", "toggle-capture", { primary: true, glyph: "plus" })}`)}`;
  } else if (page === "gallery") {
    const curating = (s.workspaceJobs || []).some(job => job.type === "curate" && ["queued", "running"].includes(job.status));
    const emptyDescription = s.desktopCapabilities?.autoCurate ? "收藏的文章达到成卡条件后，专题会自动出现在这里。"
      : s.desktopCapabilities?.aiEnabled === false ? "先逛逛自己的收藏。连接智能整理后，再把喜欢组织成展览。"
      : "从喜欢的收藏开始。至少 6 件完成理解的收藏，可以尝试整理成一场展览。";
    const galleryEmpty = curating
      ? emptyState("展览还在整理中", "有一场展览正在处理，完成后会出现在这里。", button("查看整理进度", "live-ai-panel", { glyph: "arrow" }))
      : emptyState("还没有个人展览", emptyDescription, `<a class="btn ws-button" href="#inbox" data-nav="inbox">逛逛我的收藏${icon("arrow")}</a>`);
    content = `${heading(page, galleryItems.length)}${searchBar(page, "搜索展览或主题")}${filterBar([["all", "全部"], ["showing", "正在展出"], ["unviewed", "尚未观看"], ["completed", "已看完"]])}${galleryItems.length ? `<div class="ws-exhibition-grid" data-workspace-grid data-layout="rows">${galleryItems.map((item, i) => exhibitionCard(item, i, s, artwork)).join("")}</div>${noResults()}` : galleryEmpty}`;
  } else {
    const notes = [...(s.studioNotes || []), ...(s.exhibitionRecords || []), ...(s.exhibitionNotes || [])].sort((a, b) => compareDates(a.updatedAt || a.createdAt, b.updatedAt || b.createdAt));
    content = `${heading(page, notes.length, button("写手记", "", { glyph: "plus", attrs: 'data-workspace-action="new-note"' }))}${searchBar(page, "搜索手记或摘录")}${filterBar([["all", "全部"], ["studio", "个人手记"], ["thought", "观展随笔"], ["excerpt", "观展摘录"]])}${notes.length ? `<div class="ws-notes-grid" data-workspace-grid>${notes.map(noteCard).join("")}</div>${noResults()}` : emptyState("还没有手记", "随时写下想法，或保存观展时的摘录。", button("写一篇手记", "", { primary: true, glyph: "plus", attrs: 'data-workspace-action="new-note"' }))}`;
  }
  return `<div class="home-scroll ws-workspace"><section class="ws-page" data-home-section="${page}" aria-label="${pageLabels[page][0]}">${content}</section></div>`;
}

let lastWorkspacePage;
const reducedMotion = () => document.documentElement.dataset.reduceMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const layoutAnimations = new WeakMap();
function layoutSnapshot(root) {
  if (!root || reducedMotion()) return null;
  return new Map([...root.querySelectorAll("[data-workspace-item]")].filter(card => !card.hidden).map(card => [card, card.getBoundingClientRect()]));
}
function animateLayout(root, previous) {
  if (!root || !previous || reducedMotion() || previous.size > 80) return;
  const cards = [...root.querySelectorAll("[data-workspace-item]")].filter(card => !card.hidden);
  cards.forEach(card => layoutAnimations.get(card)?.cancel());
  for (const card of cards) {
    const before = previous.get(card), after = card.getBoundingClientRect();
    if (!before || !after.width || after.bottom < 0 || after.top > window.innerHeight) continue;
    const x = before.left - after.left, y = before.top - after.top;
    if (Math.abs(x) < .5 && Math.abs(y) < .5) continue;
    const animation = card.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.75,.25,1)" });
    layoutAnimations.set(card, animation);
  }
}
function isDialogBackdrop(event, dialog) {
  if (event.target !== dialog) return false;
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

export function syncShell(s, galleryItems = []) {
  mountCollectionLayout();
  sizeHomeComposer();
  const page = s.ui.lightPage || "home";
  const counts = { inbox: s.collections.length, gallery: galleryItems.length, records: countNote(s) };
  const nav = document.querySelector("[data-workspace-nav]");
  if (nav) {
    if (nav.children.length !== 4) nav.innerHTML = Object.entries(pageLabels).map(([key, [label]]) => `<a href="#${key === "records" ? "notes" : key === "home" ? "top" : key}" data-nav="${key}" aria-label="${label}">${icon(key)}<span>${label}</span>${key !== "home" ? `<b></b>` : ""}</a>`).join("");
    for (const link of nav.querySelectorAll("[data-nav]")) {
      const active = link.dataset.nav === page;
      link.classList.toggle("active", active);
      link.setAttribute("aria-current", active ? "page" : "false");
      const count = link.querySelector("b");
      if (count) count.textContent = counts[link.dataset.nav];
    }
  }
  if (lastWorkspacePage && lastWorkspacePage !== page && !reducedMotion()) {
    const surface = document.querySelector(".ws-page");
    surface?.animate([{ opacity: .45, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(.2,.75,.25,1)" });
  }
  lastWorkspacePage = page;
}

function syncSortMenu() {
  const sort = workspaceSort();
  const label = sortLabel(preferences.page, sort);
  for (const item of document.querySelectorAll("[data-workspace-sort-value]")) {
    item.setAttribute("aria-checked", String(item.dataset.workspaceSortValue === sort));
    item.disabled = preferences.recent && item.dataset.workspaceSortValue === "oldest";
  }
  document.querySelector("[data-workspace-sort-label]").textContent = label;
  document.getElementById("workspace-sort-trigger").setAttribute("aria-label", `排序方式：${label}`);
}

export function applyWorkspaceFilters({ animate = false } = {}) {
  const root = document.querySelector("[data-workspace-grid]");
  if (!root) return;
  const previous = animate ? layoutSnapshot(root) : null;
  const cards = [...root.querySelectorAll("[data-workspace-item]")];
  const { recent } = preferences;
  const now = recent ? Date.now() : 0;
  const cutoff = now - weekInMilliseconds;
  let visible = 0;
  for (const card of cards) {
    const time = recent ? Date.parse(card.dataset.date) : 0;
    const match = (!recent || (time >= cutoff && time <= now))
      && matchesWorkspaceItem({ ...card.dataset, tags: (card.dataset.tags || "").split("|") }, preferences);
    card.hidden = !match;
    if (match) visible += 1;
  }
  const sort = workspaceSort();
  const ordered = [...cards].sort((a, b) => compareDates(a.dataset.date, b.dataset.date, sort));
  ordered.forEach((card, index) => { if (root.children[index] !== card) root.insertBefore(card, root.children[index] || null); });
  const result = document.querySelector("[data-workspace-result]");
  if (result) result.textContent = recent || preferences.query || preferences.filter !== "all" || preferences.theme ? `${visible} 条结果` : "";
  const empty = document.querySelector("[data-workspace-empty]");
  if (empty) empty.hidden = visible !== 0;
  root.hidden = visible === 0;
  layoutWorkspaceCollections();
  animateLayout(root, previous);
}

let collectionLayoutRoot;
let homeCollectionRail;
let collectionLayoutObserver;
let collectionLayoutFrame = 0;
let collectionLayoutWidth = 0;
function scheduleCollectionLayout() {
  if (collectionLayoutFrame) return;
  collectionLayoutFrame = requestAnimationFrame(() => {
    collectionLayoutFrame = 0;
    layoutWorkspaceCollections();
  });
}

const remoteCoverColors = new Map();
function readRemoteCoverColor(image, collectionId) {
  const source = image.currentSrc || image.src;
  if (!/^https:\/\//iu.test(source)) return null;
  if (remoteCoverColors.has(source)) return remoteCoverColors.get(source);
  const request = (async () => {
    if (workspaceCallbacks?.collectionCoverColor && collectionId) {
      try {
        const color = await workspaceCallbacks.collectionCoverColor(collectionId);
        if (coverColorPattern.test(color)) return color;
      } catch { /* A direct image may still allow cross-origin pixel access. */ }
    }
    const sample = new Image();
    sample.crossOrigin = "anonymous";
    sample.referrerPolicy = "no-referrer";
    sample.src = source;
    try { await sample.decode(); return collectionCardColorFromImage(sample); }
    catch { return null; }
  })();
  if (remoteCoverColors.size >= 128) remoteCoverColors.delete(remoteCoverColors.keys().next().value);
  remoteCoverColors.set(source, request);
  return request;
}

function mountCollectionCovers(root, onImageSettled) {
  for (const image of root?.querySelectorAll('img') || []) {
    const card = image.closest('.ws-story-collection');
    const applyCoverColor = async () => {
      if (!card?.isConnected || !image.naturalWidth) return;
      const color = card.dataset.coverColor || collectionCardColorFromImage(image);
      card.style.setProperty('--ws-story-color', color || neutralCoverColor);
      if (color) return;
      const collectionId = card.querySelector('[data-collection-id]')?.dataset.collectionId;
      const remoteColor = await readRemoteCoverColor(image, collectionId);
      if (card.isConnected && coverColorPattern.test(remoteColor)) card.style.setProperty('--ws-story-color', remoteColor);
    };
    if (image.complete) applyCoverColor();
    else {
      image.addEventListener('load', () => {
        applyCoverColor();
        onImageSettled?.();
      }, { once: true });
      if (onImageSettled) image.addEventListener('error', onImageSettled, { once: true });
    }
  }
}

function mountCollectionLayout() {
  const rail = document.querySelector('[data-home-section="home"] [data-recommend-gallery="collections"]');
  if (rail !== homeCollectionRail) {
    homeCollectionRail = rail;
    mountCollectionCovers(rail);
  }
  const root = document.querySelector('.ws-collection-grid[data-workspace-grid], .ws-exhibition-grid[data-workspace-grid]');
  if (root !== collectionLayoutRoot) {
    collectionLayoutObserver?.disconnect();
    collectionLayoutRoot = root;
    collectionLayoutWidth = 0;
    if (root && typeof ResizeObserver !== "undefined") {
      collectionLayoutObserver = new ResizeObserver(entries => {
        if (entries.some(entry => entry.target !== root || Math.abs(entry.contentRect.width - collectionLayoutWidth) > .5)) scheduleCollectionLayout();
      });
      collectionLayoutObserver.observe(root);
      if (!root.matches('.ws-exhibition-grid')) root.querySelectorAll('.ws-card-open').forEach(card => collectionLayoutObserver.observe(card));
    }
    mountCollectionCovers(root, scheduleCollectionLayout);
  }
  layoutWorkspaceCollections();
}
const exhibitionLayoutSignatures = new WeakMap();
function layoutExhibitionGallery(root) {
  const styles = getComputedStyle(root);
  const horizontalInsets = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, property) => sum + (parseFloat(styles[property]) || 0), 0);
  // clientWidth rounds up at fractional widths, which can wrap the final card.
  const width = Math.floor((root.getBoundingClientRect().width - horizontalInsets) * 64) / 64;
  if (width <= 0) return;
  collectionLayoutWidth = width;
  const cards = [...root.querySelectorAll('.ws-exhibition')];
  const visible = cards.filter(card => !card.hidden);
  const gap = parseFloat(styles.columnGap) || 20;
  const signature = JSON.stringify([width, gap, visible.map(card => [card.dataset.exhibitionLayoutId, card.dataset.storyCount])]);
  // Nodes are never wrapped or replaced: sorting, focus and click actions stay intact.
  if (exhibitionLayoutSignatures.get(root) === signature) return;
  const byId = new Map();
  const input = visible.map((card, index) => {
    const id = String(index); byId.set(id, card);
    return { id, count:Number(card.dataset.storyCount || 0) };
  });
  for (const card of cards) card.style.removeProperty('grid-row-end');
  const rows = layoutExhibitionRows(input, { width, gap });
  for (const [index, row] of rows.entries()) for (const item of row.items) {
    const card = byId.get(item.id);
    card.style.setProperty('--exhibition-card-width', `${Math.floor(item.width * 64) / 64}px`);
    card.style.setProperty('--exhibition-card-height', `${row.height.toFixed(4)}px`);
    card.dataset.exhibitionRow = String(index);
  }
  exhibitionLayoutSignatures.set(root, signature);
}
function layoutWorkspaceCollections() {
  const root = collectionLayoutRoot;
  if (!root?.isConnected || root.hidden) return;
  if (root.matches('.ws-exhibition-grid')) { layoutExhibitionGallery(root); return; }
  const cards = [...root.querySelectorAll('.ws-collection, .ws-exhibition')];
  if (root.dataset.layout !== "masonry") {
    cards.forEach(card => card.style.removeProperty('grid-row-end'));
    return;
  }
  const styles = getComputedStyle(root);
  const gap = parseFloat(styles.getPropertyValue('--ws-card-gap')) || 24;
  collectionLayoutWidth = root.clientWidth;
  const row = parseFloat(styles.gridAutoRows) || 4;
  // The button retains its natural height when its parent spans grid rows.
  const spans = cards.map(card => card.hidden ? 1 : Math.max(1, Math.ceil((card.querySelector('.ws-card-open, .ws-exhibition-open').getBoundingClientRect().height + gap) / row)));
  cards.forEach((card, index) => {
    const span = `span ${spans[index]}`;
    if (card.style.gridRowEnd !== span) card.style.gridRowEnd = span;
  });
}

let noteDialog;
const noteDrafts = new Map();
const readingDraftIds = new Map();
let workspaceCallbacks;

export function createReadingNote(payload, { id, now = new Date().toISOString() } = {}) {
  if (!payload?.collectionId || !payload.documentVersionId || !payload.source?.text) throw new Error("引用缺少原文位置，请重新打开这条收藏。");
  const source = payload.source;
  const readingSource = {
    kind: source.kind === "question" ? "question" : "quote",
    collectionId: payload.collectionId, documentVersionId: payload.documentVersionId,
    title: payload.articleTitle || payload.sourceTitle || "收藏原文",
    url: payload.url || payload.sourceUrl || "", text: source.text,
    originalText: source.originalText || "", answer: source.answer || "",
    paragraphIds: [...(source.paragraphIds || [])], evidenceIds: [...(source.evidenceIds || source.paragraphIds || [])],
    paragraphs: (source.paragraphs || []).map(({ id, text, start, end }) => ({ id, text, start, end })),
    ...(source.sourceRevision !== undefined ? { sourceRevision: source.sourceRevision } : {}),
    ...(source.contentHash ? { contentHash: source.contentHash } : {}), generated: Boolean(source.generated), createdAt: now,
  };
  return {
    ...(id ? { id } : {}), ...(payload.exhibitionId ? { exhibitionId:payload.exhibitionId, exhibitionTitle:payload.exhibitionTitle || "" } : {}), title: payload.title || "读完之后的想法", status: "draft",
    createdAt: now, citations: [`${readingSource.title} · ${source.text}`], readingSource,
    blocks: [{ type: source.kind === "question" ? "question" : "essay", ai: false, text: "" }], body: "",
  };
}

export function openReadingNote(payload) {
  if (!workspaceCallbacks) throw new Error("手记编辑器还没有准备好，请稍后重试。");
  // Keep an unsaved draft tied to its exact source, including across reopening.
  const identity = JSON.stringify([payload.collectionId, payload.documentVersionId, payload.source?.kind, payload.source?.text]);
  const existing = workspaceCallbacks.state().studioNotes.find(note => {
    const source = note.readingSource;
    return source && JSON.stringify([source.collectionId, source.documentVersionId, source.kind, source.text]) === identity;
  });
  const draftId = existing?.id || readingDraftIds.get(identity) || `reading-note-${crypto.randomUUID()}`;
  readingDraftIds.set(identity, draftId);
  showNote(existing || createReadingNote(payload, { id: draftId }), existing ? "studio" : "new", workspaceCallbacks);
}

function readingReferenceMarkup(reference) {
  if (!reference) return "";
  let url = "";
  try { const parsed = new URL(reference.url); if (["https:", "http:"].includes(parsed.protocol)) url = parsed.href; } catch {}
  return `<section class="ws-note-reading-reference"><p class="ws-eyebrow">${reference.kind === "question" ? "阅读时的问题" : "原文摘录"}</p><blockquote>${escape(reference.originalText || reference.text)}</blockquote>${reference.kind === "question" && reference.answer ? `<p class="ws-note-reference-answer"><small>基于原文的回答</small>${escape(reference.answer)}</p>` : ""}<p class="ws-note-source">${url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(reference.title)} ↗</a>` : escape(reference.title)} · ${escape((reference.paragraphIds || []).join("、"))}</p></section>`;
}

function showNote(note, kind, callbacks) {
  const returnFocus = document.activeElement;
  const editable = kind === "studio" || kind === "new";
  const draftKey = note.id || "new";
  const stableNoteId = note.id || `note-${crypto.randomUUID()}`;
  const savedDraft = noteDrafts.get(draftKey);
  const recoveredDraft = editable && savedDraft?.version === (note.updatedAt || "") ? savedDraft : null;
  noteDialog?.remove();
  const dialog = document.createElement("dialog");
  noteDialog = dialog;
  dialog.className = "ws-note-dialog";
  dialog.setAttribute("aria-labelledby", editable ? "ws-note-dialog-title" : "ws-note-title");
  dialog.setAttribute("aria-describedby", "ws-note-description");
  const content = noteText(note);
  const blocks = recoveredDraft?.blocks.map(block => ({ ...block })) || (note.blocks?.length ? note.blocks.map(block => ({ ...block })) : [{ type: "essay", ai: false, text: "" }]);
  const blockMarkup = (block, i) => `<section class="ws-note-block"><label class="ws-note-block-label" for="ws-note-block-${i}"><span>段落 ${String(i + 1).padStart(2, "0")} · ${({ opinion: "个人观点", essay: "随笔", concept: "产品概念", question: "待探索问题" })[block.type] || "想法"}</span><small>${block.ai ? "策展人草稿 · 可改写" : "我的内容"}</small></label><textarea class="textarea" id="ws-note-block-${i}" data-workspace-note-block="${i}" placeholder="写下此刻仍在回响的部分…" rows="${blocks.length > 1 ? 4 : 9}">${escape(block.text)}</textarea></section>`;
  dialog.innerHTML = `<form data-workspace-note-form novalidate><header><div><span class="ws-eyebrow">${editable ? "个人手记" : "来自展览"}</span>${editable ? `<h2 id="ws-note-dialog-title">${kind === "new" ? "留一点自己的想法" : "继续写这篇手记"}</h2>` : ""}</div><button type="button" class="btn ws-icon-button" data-variant="ghost" data-size="icon-sm" data-workspace-close-note aria-label="关闭手记">${icon("close")}</button></header><div class="ws-note-editor-body"><p class="ws-dialog-description" id="ws-note-description">${editable ? "不必急着得出结论，先把此刻想到的留下。" : "你在看展时留下的片段，连同它的出处一起保存在这里。"}</p>${readingReferenceMarkup(note.readingSource)}${editable ? `<label class="sr-only" for="ws-note-title">手记标题</label><input class="input" id="ws-note-title" name="title" placeholder="给这篇手记起个名字" value="${escape(recoveredDraft?.title ?? note.title ?? "")}" maxlength="160" required/><div data-workspace-note-blocks>${blocks.map(blockMarkup).join("")}</div><button class="btn ws-button" data-variant="outline" data-size="sm" type="button" data-workspace-add-block>${icon("plus")}再写一段</button>` : `<h2 id="ws-note-title">${escape(note.exhibitionTitle || "一条想法")}</h2><div class="ws-note-reading">${noteImages(note).map(src => `<img src="${escape(src)}" alt="保存于手记的图片"/>`).join("")}${content.split("\n").filter(Boolean).map(p => `<p>${escape(p)}</p>`).join("")}</div>`}${note.exhibitionTitle ? `<p class="ws-note-source">源自展览 · ${escape(note.exhibitionTitle)}</p>` : ""}<p class="ws-note-error" role="alert" hidden></p></div><footer><span class="ws-note-status" data-note-status>${editable ? recoveredDraft ? "未保存的草稿已恢复" : "保存在当前空间" : date(note.updatedAt || note.createdAt)}</span>${editable ? '<div class="ws-note-save-actions"><span class="ws-note-save-hint">⌘ ↵ 保存</span><button class="btn ws-button ws-button-primary" data-size="sm" type="submit">保存手记</button></div>' : button("回顾展览", "open-recap-ticket", { glyph: "arrow", attrs: `data-exhibition="${escape(note.exhibitionId || "")}"` })}</footer></form>`;
  document.body.append(dialog);
  let saved = false;
  let saving = false;
  const readDraft = () => ({
    version: note.updatedAt || "",
    title: dialog.querySelector("#ws-note-title").value,
    blocks: [...dialog.querySelectorAll("[data-workspace-note-block]")].map((input, i) => ({ ...blocks[i], text: input.value, ai: input.value.trim() === blocks[i].text.trim() ? blocks[i].ai : false })),
  });
  const preserveDraft = () => {
    if (!editable || saved) return;
    const draft = readDraft();
    noteDrafts.set(draftKey, draft);
    const count = draft.blocks.reduce((sum, block) => sum + block.text.trim().length, 0);
    dialog.querySelector("[data-note-status]").textContent = `未保存 · ${count} 字`;
    dialog.querySelector(".ws-note-error").hidden = true;
    dialog.querySelectorAll('[aria-invalid="true"]').forEach(input => input.removeAttribute("aria-invalid"));
  };
  dialog.addEventListener("input", preserveDraft);
  dialog.addEventListener("click", event => {
    if (!dialog.open) return;
    if (saving) return;
    if (event.target.closest("[data-workspace-close-note]") || isDialogBackdrop(event, dialog)) void closeGlassDialog(dialog);
    const nextAction = event.target.closest("[data-action]");
    if (nextAction) {
      event.preventDefault(); event.stopPropagation();
      void closeGlassDialog(dialog).then(() => nextAction.click());
    }
    if (event.target.closest("[data-workspace-add-block]")) {
      const index = dialog.querySelectorAll("[data-workspace-note-block]").length;
      blocks.push({ type: "essay", ai: false, text: "" });
      dialog.querySelector("[data-workspace-note-blocks]").insertAdjacentHTML("beforeend", blockMarkup(blocks[index], index));
      preserveDraft();
      dialog.querySelector(`#ws-note-block-${index}`).focus();
    }
  });
  dialog.addEventListener("close", () => {
    if (!saved && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  dialog.addEventListener("keydown", event => {
    if (editable && (event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); event.stopPropagation(); dialog.querySelector("form").requestSubmit();
    }
  });
  dialog.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault(); event.stopPropagation();
    if (!editable || saving) return;
    const draft = readDraft();
    const title = draft.title.trim();
    const nextBlocks = draft.blocks.map(block => ({ ...block, text: block.text.trim() })).filter(block => block.text);
    const error = dialog.querySelector(".ws-note-error");
    if (!title || !nextBlocks.length) {
      error.hidden = false;
      error.textContent = !title ? "给这篇手记起个名字，再保存。" : "写下一段正文，再保存这篇手记。";
      const invalid = dialog.querySelector(!title ? "#ws-note-title" : "[data-workspace-note-block]");
      invalid.setAttribute("aria-invalid", "true"); invalid.focus();
      return;
    }
    saving = true;
    const submit = dialog.querySelector('[type="submit"]');
    const controls = [...dialog.querySelectorAll('input,textarea,button')].map(element => ({ element, disabled: element.disabled }));
    for (const { element } of controls) element.disabled = true;
    submit.disabled = true; submit.textContent = "正在保存…";
    const id = stableNoteId;
    try {
      await callbacks.saveNote({ ...note, id, title, blocks: nextBlocks, body: nextBlocks.map(block => block.text).join("\n\n"), status: "saved", updatedAt: new Date().toISOString() });
      saved = true; noteDrafts.delete(draftKey);
      dialog.querySelector("[data-note-status]").textContent = "手记已保存";
      await closeGlassDialog(dialog);
      callbacks.render();
      const savedCard = [...document.querySelectorAll("[data-workspace-note]")].find(button => button.dataset.workspaceNote === id);
      (savedCard || (returnFocus?.isConnected ? returnFocus : document.querySelector('[data-workspace-action="new-note"]')))?.focus({ preventScroll: true });
      const announcement = document.querySelector("[data-workspace-announcement]");
      if (announcement) announcement.textContent = "手记已保存。";
    } catch (failure) {
      error.hidden = false; error.textContent = failure.message || "暂时没有保存成功，内容已保留，可以重试。";
      preserveDraft(); error.hidden = false;
    } finally { saving = false; for (const { element, disabled } of controls) element.disabled = disabled; submit.textContent = "保存手记"; }
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!saving) void closeGlassDialog(dialog); });
  dialog.showModal();
  if (editable) dialog.querySelector("#ws-note-title").focus({ preventScroll: true });
}

function showChatContext(callbacks, trigger) {
  if (document.querySelector(".ws-chat-context-dialog[open]")) return;
  const current = callbacks.state();
  const publicLinks = trigger.form?.hasAttribute("data-public-link-form");
  const collections = publicLinks ? current.collections.filter(item => sourceLinkKey(item.url)) : current.collections;
  const selectionType = publicLinks ? "radio" : "checkbox";
  const inputSelector = `input[type="${selectionType}"]`;
  const searchText = collections.map(item => {
    const extraction = current.extractions?.find(entry => entry.collectionId === item.id);
    const tags = current.feedback?.[`understanding:${item.id}`]?.acceptedTags || [...(extraction?.tags || []), ...(extraction?.concepts || []), ...(item.tags || [])];
    return [item.title, item.source, item.summary, extraction?.summary, ...tags].join(" ").toLocaleLowerCase();
  });
  const existingIds = new Set(collections.map(item => item.id));
  const previousLink = publicLinks && sourceLinkKey(homeDraft);
  const previousCollection = previousLink && collections.find(item => sourceLinkKey(item.url) === previousLink);
  const selected = new Set(publicLinks ? (previousCollection ? [previousCollection.id] : []) : homeContextIds.filter(id => existingIds.has(id)).slice(0, 6));
  const dialog = document.createElement("dialog");
  dialog.className = "ws-help ws-chat-context-dialog";
  dialog.setAttribute("aria-labelledby", "ws-chat-context-title");
  dialog.setAttribute("aria-describedby", "ws-chat-context-description");
  dialog.innerHTML = `<header><div><span class="ws-eyebrow">${publicLinks ? "示例收藏" : "这次对话的参考"}</span><h2 id="ws-chat-context-title">${publicLinks ? "选择一件收藏" : "带上几件收藏"}</h2></div><button type="button" class="btn ws-icon-button" data-variant="ghost" data-size="icon-sm" data-context-close aria-label="关闭收藏选择">${icon("close")}</button></header><p id="ws-chat-context-description">${publicLinks ? "选择一件收藏，把它的来源链接交给 Tag。" : "选择这次想一起看的内容，最多 6 件。"}</p>${collections.length ? `<label class="ws-search ws-chat-context-search" for="ws-chat-context-search">${icon("search")}<input class="input" id="ws-chat-context-search" type="search" aria-label="搜索引用收藏" placeholder="搜索标题、来源或线索" autocomplete="off"/></label>` : ""}<div class="ws-chat-context-list" role="${publicLinks ? "radiogroup" : "group"}" aria-label="选择参考收藏">${collections.map(item => `<label data-context-row><input type="${selectionType}" name="workspace-context" value="${escape(item.id)}"${selected.has(item.id) ? " checked" : ""}/><span><strong>${escape(item.title)}</strong><small>${escape(item.source || "我的收藏")}${date(item.addedAt) ? ` · ${date(item.addedAt)}` : ""}</small></span><i class="ws-context-check" aria-hidden="true">${icon("check")}</i></label>`).join("")}</div><div class="ws-chat-context-empty" data-context-empty${collections.length ? " hidden" : ""}>${icon(collections.length ? "search" : "inbox")}<h3>${collections.length ? "没有找到这件收藏" : "从一件喜欢的内容开始"}</h3><p>${collections.length ? "试试其他关键词，已选的收藏会为你保留。" : "先收下一篇文章、一张图片，或一段自己的想法。"}</p>${collections.length ? '<button type="button" class="ws-button" data-context-reset-search>清除搜索</button>' : '<button type="button" class="ws-button" data-context-capture>收一条新的</button>'}</div><p class="ws-context-limit" data-context-limit role="status" aria-live="polite"></p><footer class="ws-chat-context-footer"><span data-context-count aria-live="polite"></span><div><button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-context-close>取消</button><button type="button" class="btn ws-button ws-button-primary" data-size="sm" data-context-apply${collections.length ? "" : " disabled"}>带上这些收藏</button></div></footer>`;
  let applied = false;
  const update = () => {
    dialog.querySelector("[data-context-count]").textContent = `已选 ${selected.size} / ${publicLinks ? 1 : 6} 件`;
    dialog.querySelector("[data-context-limit]").textContent = selected.size >= 6 ? "已选满 6 件，取消一件后可以继续选择。" : "";
    dialog.querySelectorAll(inputSelector).forEach(input => {
      input.disabled = selected.size >= 6 && !input.checked;
      input.closest("label").dataset.selected = String(input.checked);
    });
    const apply = dialog.querySelector("[data-context-apply]");
    if (publicLinks) {
      apply.disabled = selected.size === 0;
      apply.textContent = "填入来源链接";
    } else {
      apply.textContent = selected.size ? `带上 ${selected.size} 件收藏` : homeContextIds.length ? "清除本次引用" : "暂不引用";
    }
  };
  const search = () => {
    const query = dialog.querySelector('input[type="search"]')?.value.trim().toLocaleLowerCase() || "";
    let visible = 0;
    dialog.querySelectorAll("[data-context-row]").forEach((row, index) => {
      row.hidden = !searchText[index].includes(query);
      if (!row.hidden) visible++;
    });
    dialog.querySelector("[data-context-empty]").hidden = visible > 0;
  };
  dialog.addEventListener("input", event => { if (event.target.matches('input[type="search"]')) search(); });
  dialog.addEventListener("change", event => {
    if (!event.target.matches(inputSelector)) return;
    if (publicLinks) selected.clear();
    if (event.target.checked && selected.size < 6) selected.add(event.target.value);
    else if (!event.target.checked) selected.delete(event.target.value);
    else event.target.checked = false;
    update();
  });
  dialog.addEventListener("click", event => {
    if (event.target.closest("[data-context-close]") || isDialogBackdrop(event, dialog)) void closeGlassDialog(dialog);
    if (event.target.closest("[data-context-reset-search]")) {
      dialog.querySelector('input[type="search"]').value = ""; search(); dialog.querySelector('input[type="search"]').focus();
    }
    if (event.target.closest("[data-context-capture]")) void closeGlassDialog(dialog).then(() => callbacks.capture());
    if (event.target.closest("[data-context-apply]") && !applied) {
      if (publicLinks) {
        const collection = collections.find(item => selected.has(item.id));
        if (!collection) return;
        applied = true;
        void closeGlassDialog(dialog).then(() => {
          const input = document.querySelector("[data-public-link-form] textarea");
          if (!input) return;
          input.value = homeDraft = collection.url;
          chatFeedback = "已填入来源链接，发送给 Tag 查看。";
          updateHomeChatControls();
          input.focus({ preventScroll: true });
        });
        return;
      }
      applied = true;
      homeContextIds = [...selected].filter(id => callbacks.state().collections.some(item => item.id === id)).slice(0, 6);
      void closeGlassDialog(dialog).then(() => {
        callbacks.render(); document.querySelector("#workspace-chat-input")?.focus({ preventScroll: true });
        const announcement = document.querySelector("[data-workspace-announcement]");
        if (announcement) announcement.textContent = homeContextIds.length ? `已带上 ${homeContextIds.length} 件收藏。` : "本次对话不引用收藏。";
      });
    }
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); void closeGlassDialog(dialog); });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (!applied && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, { once: true });
  document.body.append(dialog); update(); dialog.showModal();
  (dialog.querySelector('input[type="search"]') || dialog.querySelector("[data-context-capture]") || dialog.querySelector("[data-context-close]"))?.focus({ preventScroll: true });
}

function sizeHomeComposer() {
  const input = document.getElementById("workspace-chat-input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(160, Math.max(parseFloat(getComputedStyle(input).minHeight) || 43, input.scrollHeight))}px`;
}

function updateHomeChatControls() {
  sizeHomeComposer();
  const available = workspaceChatAvailable();
  const input = document.querySelector("#workspace-chat-input");
  const composerEnabled = available || input?.form?.hasAttribute("data-public-link-form");
  if (input) input.disabled = !composerEnabled;
  const send = document.querySelector("[data-workspace-chat-send]");
  if (send) { send.disabled = !composerEnabled || chatPending || !homeDraft.trim(); send.innerHTML = chatPending ? '<span class="sr-only">正在打开对话</span>…' : icon("up"); }
  document.querySelectorAll('[data-workspace-chat-prompt], [data-workspace-action="chat"]').forEach(button => { button.disabled = !available || chatPending; });
  const feedback = document.querySelector("[data-workspace-chat-feedback]");
  if (feedback) { feedback.hidden = !chatFeedback; feedback.textContent = chatFeedback; }
}

async function requestWorkspaceChat(detail, { clearDraft = false, trigger } = {}) {
  if (!workspaceChatAvailable()) { chatFeedback = desktopChatNotice; updateHomeChatControls(); return; }
  if (chatPending) return;
  chatPending = true;
  chatFeedback = "";
  const submittedDraft = homeDraft;
  if (trigger) trigger.disabled = true;
  updateHomeChatControls();
  try {
    const openChat = window.__FORME_DESKTOP__?.openChat;
    const result = openChat ? await openChat(detail) : { accepted: false, error: "对话还没有准备好，请稍后再试。" };
    if (!result?.accepted) throw new Error(result?.error || "对话暂时没有打开，输入已保留，请重试。");
    if (clearDraft && homeDraft === submittedDraft) {
      homeDraft = "";
      const input = document.querySelector("#workspace-chat-input");
      if (input) input.value = "";
    }
    chatFeedback = detail.submit ? "已交给 Tag，可以在对话中继续。" : "已打开 Tag 的对话。";
  } catch (error) {
    chatFeedback = error.message || "对话暂时没有打开，输入已保留，请重试。";
  } finally {
    chatPending = false;
    if (trigger?.isConnected) trigger.disabled = false;
    updateHomeChatControls();
    const announcement = document.querySelector("[data-workspace-announcement]");
    if (announcement) announcement.textContent = chatFeedback;
  }
}

function bindBrandCompanion() {
  const brand = document.querySelector(".ws-brand");
  const companion = brand?.querySelector(".ws-brand-companion");
  if (!companion) return;
  let avatar = mountCompanionAvatar(companion);
  let expressionTimer;
  const clearExpression = () => { delete companion.dataset.companionExpression; };
  brand.addEventListener("click", () => {
    companion.dataset.companionExpression = "chevrons";
    clearTimeout(expressionTimer);
    expressionTimer = setTimeout(clearExpression, 400);
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(expressionTimer);
    clearExpression();
    avatar.destroy();
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) avatar = mountCompanionAvatar(companion);
  });
}

function sourceLinkKey(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.*|fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${url.host.replace(/^www\./iu, "")}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
  } catch { return ""; }
}

function openPublicLink(form, callbacks) {
  if (chatComposing) return;
  homeDraft = form.elements.namedItem("source").value;
  const key = sourceLinkKey(homeDraft);
  const collection = key && callbacks.state().collections.find(item => sourceLinkKey(item.url) === key);
  chatFeedback = collection ? "已找到对应收藏。"
    : key ? "示例库里没有这个链接。也可以用「引用收藏」选择。"
    : "请输入以 https:// 或 http:// 开头的示例收藏链接。";
  updateHomeChatControls();
  if (collection) callbacks.openCollection(collection.id);
}

export function bindWorkspace(callbacks) {
  workspaceCallbacks = callbacks;
  bindBrandCompanion();
  window.addEventListener("resize", scheduleCollectionLayout, { passive: true });
  document.fonts?.ready.then(scheduleCollectionLayout);
  document.addEventListener("error", event => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const cover = event.target.parentElement;
    if (cover?.classList.contains("ws-collection-media")) {
      cover.hidden = true;
      cover.nextElementSibling.hidden = false;
      const card = cover.closest(".ws-collection");
      card.classList.add("ws-collection-text");
      card.style.removeProperty("--ws-story-color");
      scheduleCollectionLayout();
    } else if (cover?.classList.contains("collection-glass__media")) {
      cover.hidden = true;
      cover.parentElement.classList.add("is-text-only");
    }
  }, true);
  const help = document.querySelector("[data-workspace-help]");
  let helpReturnFocus;
  help?.addEventListener("cancel", event => { event.preventDefault(); void closeGlassDialog(help); });
  help?.addEventListener("click", event => { if (isDialogBackdrop(event, help)) void closeGlassDialog(help); });
  help?.addEventListener("close", () => { if (helpReturnFocus?.isConnected) helpReturnFocus.focus({ preventScroll: true }); });
  document.addEventListener("compositionstart", event => { if (event.target.id === "workspace-chat-input") chatComposing = true; });
  document.addEventListener("compositionend", event => {
    if (event.target.id !== "workspace-chat-input") return;
    chatComposing = false;
    chatCompositionEndedAt = performance.now();
    homeDraft = event.target.value;
    updateHomeChatControls();
  });
  document.addEventListener("submit", event => {
    if (event.target.matches("[data-public-link-form]")) {
      event.preventDefault();
      openPublicLink(event.target, callbacks);
      return;
    }
    if (!event.target.matches("[data-workspace-chat-form]")) return;
    event.preventDefault(); event.stopPropagation();
    if (chatComposing || chatPending) return;
    homeDraft = event.target.querySelector("textarea").value;
    if (homeDraft.trim()) void requestWorkspaceChat({ message: homeDraft.trim(), collectionIds: homeContextIds, submit: true }, { clearDraft: true });
  });
  document.addEventListener("keydown", event => {
    if (event.target.id !== "workspace-chat-input" || event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.isComposing || event.keyCode === 229 || chatComposing) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || performance.now() - chatCompositionEndedAt < 80) return;
    event.target.form?.requestSubmit();
  }, true);
  document.addEventListener("input", event => {
    if (event.target.id === "workspace-chat-input") {
      homeDraft = event.target.value;
      chatFeedback = "";
      updateHomeChatControls(); return;
    }
    if (event.target.id !== "workspace-search") return;
    preferences.query = event.target.value;
    applyWorkspaceFilters();
  });
  document.addEventListener("click", event => {
    const target = event.target.closest("[data-workspace-action], [data-workspace-filter], [data-workspace-layout], [data-workspace-note], [data-workspace-sort-value], [data-workspace-chat-prompt], [data-workspace-chat-collection], [data-workspace-chat-exhibition]");
    if (!target) return;
    if (target.hasAttribute("data-workspace-chat-prompt")) {
      let collectionIds = [];
      try { collectionIds = JSON.parse(target.dataset.chatCollectionIds || "[]"); } catch {}
      void requestWorkspaceChat({ message: target.dataset.workspaceChatPrompt, collectionIds, submit: target.dataset.chatSubmit === "true" }, { trigger: target }); return;
    }
    if (target.dataset.workspaceChatCollection || target.dataset.workspaceChatExhibition) {
      void requestWorkspaceChat({ message: "", collectionIds: target.dataset.workspaceChatCollection ? [target.dataset.workspaceChatCollection] : [], exhibitionId: target.dataset.workspaceChatExhibition, submit: false }, { trigger: target }); return;
    }
    if (target.dataset.workspaceSortValue) {
      if (preferences.recent) return;
      preferences.sort = target.dataset.workspaceSortValue;
      syncSortMenu();
      applyWorkspaceFilters({ animate: true }); return;
    }
    if (target.dataset.workspaceFilter !== undefined) {
      preferences.filter = target.dataset.workspaceFilter;
      document.querySelectorAll("[data-workspace-filter]").forEach(b => { const selected = b === target; b.classList.toggle("is-active", selected); b.setAttribute("aria-pressed", selected); });
      applyWorkspaceFilters({ animate: true }); return;
    }
    if (target.dataset.workspaceLayout) {
      const root = document.querySelector("[data-workspace-grid]");
      const previous = layoutSnapshot(root);
      preferences.layout = target.dataset.workspaceLayout;
      document.querySelector("[data-workspace-grid]")?.setAttribute("data-layout", preferences.layout);
      document.querySelectorAll("[data-workspace-layout]").forEach(b => b.setAttribute("aria-pressed", b === target));
      layoutWorkspaceCollections();
      animateLayout(root, previous); return;
    }
    if (target.dataset.workspaceNote) {
      const s = callbacks.state();
      const note = [...s.studioNotes, ...s.exhibitionRecords, ...s.exhibitionNotes].find(n => n.id === target.dataset.workspaceNote);
      if (note) showNote(note, target.dataset.noteKind, callbacks); return;
    }
    const action = target.dataset.workspaceAction;
    if (action === "toggle-recent") {
      preferences.recent = !preferences.recent;
      target.setAttribute("aria-pressed", String(preferences.recent));
      syncSortMenu();
      applyWorkspaceFilters({ animate: true }); return;
    }
    if (action === "clear-chat-context") { homeContextIds = []; callbacks.render(); document.querySelector("#workspace-chat-input")?.focus(); return; }
    if (action === "choose-chat-context") { showChatContext(callbacks, target); return; }
    if (action === "public-continue-chat") {
      const openSampleConversation = window.__FORME_DESKTOP__?.openSampleConversation;
      if (openSampleConversation) openSampleConversation();
      else callbacks.capture();
      return;
    }
    if (action === "clear-filters") { preferences.query = ""; preferences.filter = "all"; preferences.theme = ""; preferences.recent = false; callbacks.render(); }
    if (action === "clear-theme") { preferences.theme = ""; callbacks.render(); }
    if (action === "new-note") showNote({ blocks: [] }, "new", callbacks);
    if (action === "help" && help && !help.open) { helpReturnFocus = target; help.showModal(); }
    if (action === "close-help") void closeGlassDialog(help);
    if (action === "chat") {
      void requestWorkspaceChat({ message: "", submit: false }, { trigger: target });
    }
  });
  document.addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Tab") {
      document.querySelectorAll('.dropdown-menu:has(>button[aria-expanded="true"])').forEach(menu => menu.close?.(false));
    }
    if (event.key === "Tab" && !document.querySelector("dialog[open]")) {
      const overlays = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
      const overlay = overlays.at(-1);
      if (overlay) {
        const focusable = [...overlay.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(element => element.getClientRects().length && !element.closest("[hidden]"));
        const first = focusable[0], last = focusable.at(-1);
        if (focusable.length && (!overlay.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last))) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (!document.querySelector("dialog[open], .capture-overlay, .collection-glass-overlay, .recap-ticket-overlay, .exhibit-detail-overlay")) callbacks.capture();
    }
  });
}

export function focusWorkspaceSearch() {
  const input = document.getElementById("workspace-search");
  input?.focus(); input?.select();
}
