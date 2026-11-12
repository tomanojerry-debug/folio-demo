import { initializeRefreshMode } from "./refresh-mode.js";
import { installGlassDialogs, closeGlassOverlay, glassReducedMotion } from "../../curator/glass-dialogs.js";
import { collectionHeadline } from "../../curator/collection-headline.js";
import { mountHomeRecommendationRails } from "../../curator/home-recommendation-scroll.js";
import { mountLiveAI } from "./live-ai.js?v=20261004-5";
import { exhibitInterpretation, exhibitionFixture, provenance } from "./fixtures.js?v=20260826-understanding-2";
import { collectionStatusFromExtraction } from "./extraction.js";
import { captureFeedbackMessage, collectionUnderstandingState } from "./live-ai-request.js";
import { createStorageAdapter, createStore } from "./store.js";
import { collectionDirections, renderRecommendationCard } from "./collection-recommendations.js";
import { applySerendipityDecision, buildSerendipityCandidates, serendipityDecision, shuffleCandidates } from "./serendipity.js";

// The lightweight presentation keeps the original routes and templates, but
// never downloads their optional visual engines.
const LIGHT_PRESENTATION = document.documentElement.dataset.presentation === "light";
if (LIGHT_PRESENTATION) installGlassDialogs();
const collectionNoteDrafts = new Map();
const DESKTOP_WORKSPACE = window.__FORME_DESKTOP__;
const PRIVATE_WORKSPACE = Boolean(DESKTOP_WORKSPACE);
const WORKSPACE_CHAT_AVAILABLE = typeof DESKTOP_WORKSPACE?.openChat === "function";
const lightWorkspace = LIGHT_PRESENTATION ? await import("./light-workspace.js?v=20261111-cover-colors") : null;
const inactiveVisual = () => () => {};
let mountGrainient = inactiveVisual, mountTextPressure = inactiveVisual;
let mountGalaxy = inactiveVisual, mountNoomoScene = inactiveVisual, mountInboxScene3D = inactiveVisual, mountElasticMesh = inactiveVisual;
if (!LIGHT_PRESENTATION) {
  const visuals = await Promise.all([
    import("./grainient.js"), import("./text-pressure.js"),
    import("./galaxy.js?v=20260805-1"), import("./noomo3d.js?v=20260807-11"),
    import("./inbox-scene3d.js?v=20260809-4"), import("./elastic-mesh.js?v=20260923-vendored-1"),
  ]);
  ({ mountGrainient } = visuals[0]); ({ mountTextPressure } = visuals[1]);
  ({ mountGalaxy } = visuals[2]); ({ mountNoomoScene } = visuals[3]); ({ mountInboxScene3D } = visuals[4]); ({ mountElasticMesh } = visuals[5]);
}

const app = document.querySelector("#app");
const store = createStore(DESKTOP_WORKSPACE?.storage || createStorageAdapter(window.localStorage));
const worldViews = ["inbox", "gallery", "records"];
const worldLabels = { inbox: "Inbox · 遗落之地", gallery: "Gallery · 相遇之馆", records: "思考手记" };
const scrollStorageKey = "personal-exhibition-curator-scroll-v1";
const scrollPositions = readScrollPositions();

function state() { return store.getState(); }
if (LIGHT_PRESENTATION) {
  const previousView = state().ui.view;
  const requestedPage = ({ "#top": "home", "#home": "home", "#inbox": "inbox", "#gallery": "gallery", "#notes": "records" })[location.hash];
  const defaultPage = ["gallery", "records"].includes(previousView) ? previousView : previousView === "collection" ? "inbox" : ["foyer", "room", "finale", "serendipity"].includes(previousView) ? "gallery" : "home";
  store.update((draft) => {
    if (requestedPage) draft.ui.lightPage = requestedPage;
    if (!["home", "inbox", "gallery", "records"].includes(draft.ui.lightPage)) draft.ui.lightPage = defaultPage;
    if (worldViews.includes(previousView)) draft.ui.view = "inbox";
  });
}
function exhibitionState() { return state().exhibitions.find((item) => item.id === exhibitionFixture.id); }
function currentRoom() { return exhibitionFixture.rooms[state().ui.roomIndex]; }
let isTransitioning = false;
// Let native restoration win on first entry; on reload restore before mounting
// the scene so its intro/resume decision uses the same position as the page.
const reloadScrollKey = "forme-page-scroll-v1";
const refreshMode = LIGHT_PRESENTATION ? { forced: false } : await initializeRefreshMode();
if (refreshMode.forced) {
  history.scrollRestoration = "manual";
  history.replaceState(history.state, "", location.pathname + location.search);
  store.update((draft) => { draft.ui = { ...draft.ui, view: "inbox", collectionId: null, collectionFrom: null }; });
  for (const key of Object.keys(scrollPositions)) delete scrollPositions[key];
  try { sessionStorage.removeItem(scrollStorageKey); sessionStorage.removeItem(reloadScrollKey); } catch {}
}
let pendingScrollTop = refreshMode.forced ? 0 : null;
try {
  const navigationType = performance.getEntriesByType("navigation")[0]?.type;
  const saved = JSON.parse(sessionStorage.getItem(reloadScrollKey) || "null");
  if (!refreshMode.forced && ["reload", "back_forward"].includes(navigationType) && saved?.view === state().ui.view && Number.isFinite(saved.top)) {
    pendingScrollTop = Math.max(0, saved.top);
    history.scrollRestoration = "manual";
  }
} catch { /* Native scroll restoration remains available without storage. */ }
window.addEventListener("pagehide", () => {
  const view = collectionLiveModal ? state().ui.collectionFrom : state().ui.view;
  try { sessionStorage.setItem(reloadScrollKey, JSON.stringify({ view, top: window.scrollY })); }
  catch { /* Storage may be disabled. */ }
});
let collectionUnderlaySnapshot = null;
let collectionLiveModal = false;
let collectionReturnElement = null;
let collectionOverlayMarkup = "";
let captureReturnElement = null;
let inboxGrainientCleanup = null;
let inboxTextPressureCleanup = null;
let inboxFormaTextPressureCleanup = null;
let galleryAllFormaTextPressureCleanup = null;
let notesAllFormaTextPressureCleanup = null;
let recommendGalleryCleanup = null;
let recommendGallery = null;
let focusedRecommendCard = null;
let inboxLayeredCleanup = null;
let inboxScene3DCleanup = null;
let collectionImmersiveCleanup = null;
let homeScrollCleanup = null;
let homeFloatCleanup = null;
let homeTransitionCleanup = null;
let homeMotionCleanup = null;
let homeRecordParallaxCleanup = null;
let homeRecordTimelineCleanup = null;
let galleryElasticCleanup = null;
let galaxyCleanup = null;
let noomoCleanup = null;
const WEBGL_OK = !LIGHT_PRESENTATION && (() => { try { return Boolean(document.createElement("canvas").getContext("webgl") || document.createElement("canvas").getContext("experimental-webgl")); } catch { return false; } })();
let pendingRecommendMove = 0;
let inboxInfiniteCleanup = null;
// Inbox 方案 C：搜索为主，capture 弱化为 ＋。筛选状态是会话级的（不持久化）；推荐否决像连接反馈一样持久化。
const inboxFilters = { query: "", explore: null, mode: "all", captureOpen: false, expanded: false, menuOpen: false, limit: 12, searchOpen: false };
// Gallery 方案 C：同样的搜索优先 + Explore/Recommended 面板；筛选状态会话级。
const galleryFilters = { query: "", explore: null, expanded: false, menuOpen: false };
// 主页「全部展览」是局部挂载的档案弹层；筛选不持久化，避免影响独立 Gallery 页面。
const galleryAll = { open: false, query: "", status: "all", sort: "generated", menuOpen: false, searchOpen: false };
// Serendipity 随机漫游：会话级顺序与连续滚动位置；决策持久化在 feedback（展览同时写回 recommendationDecision）。
const serendipity = { order: [], position: 0, target: 0, offset: 0, velocity: 0, raf: 0, simple: LIGHT_PRESENTATION || window.matchMedia("(prefers-reduced-motion: reduce)").matches };
let homeGalleryRound = 0;
let inboxAllReturnScrollTop = null;
let homeFoyerReturnScrollTop = null;
let recapTicketExhibitionId = null;
let recapTicketReturnContext = null;
let recapTicketReturnElement = null;
// Studio 思考之室：单卡杂志画板。io = IntersectionObserver 句柄（卡片浮现）；simple = 减弱动效降级；editing = 当前就地编辑的段落 {noteId, blockIndex}。
const studio = { io: null, simple: LIGHT_PRESENTATION || window.matchMedia("(prefers-reduced-motion: reduce)").matches, editing: null };
// 收新弹窗的草稿：当前模式（链接/文字/图片）与已粘贴的图片（压缩成小尺寸 data URL，避免撑爆 localStorage）。
let captureDraft = { mode: "link", link: "", text: "", image: null, imageName: "" };
let notesAllOpen = false;
let notesAllReturnScrollTop = null;
let notesAllReturnElement = null;
const notesAllFilters = { query: "", sort: "newest", month: "all", theme: "all", menuOpen: false, searchOpen: false };
const exhibitDetail = { id: null, selection: null, noteDraftId: null };
function resetCaptureDraft() { captureDraft = { mode: "link", link: "", text: "", image: null, imageName: "" }; }
function focusCapturePane() {
  const id = captureDraft.mode === "image" ? "capture-drop" : captureDraft.mode === "text" ? "capture-text" : "capture-input";
  document.getElementById(id)?.focus();
}
// 切换收新模式：原地换面板，不重渲染整个弹窗（避免像重新弹了一次）。
function switchCaptureMode(mode) {
  captureDraft.mode = mode;
  const modal = document.querySelector(".capture-modal");
  if (!modal) return;
  const body = modal.querySelector(".capture-body");
  if (body) {
    body.dataset.captureMode = mode;
    const hidden = body.querySelector('input[name="mode"]');
    if (hidden) hidden.value = mode;
  }
  modal.querySelectorAll(".capture-mode").forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  focusCapturePane();
}
function handleCaptureImageFile(file) {
  if (!file?.type?.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 720;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      captureDraft.image = canvas.toDataURL("image/jpeg", 0.82);
      captureDraft.imageName = file.name || "一张图片";
      const zone = document.querySelector("#capture-drop");
      if (zone) {
        zone.classList.add("has-image");
        zone.innerHTML = `<img src="${captureDraft.image}" alt="待收藏的图片预览"/>`;
      }
      const tip = document.querySelector(".capture-pane-image .capture-tip");
      if (tip) tip.textContent = `${captureDraft.imageName} · 点击可更换`;
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function readScrollPositions() {
  try { return JSON.parse(window.sessionStorage.getItem(scrollStorageKey)) ?? {}; }
  catch { return {}; }
}

function rememberScrollPosition(view) {
  if (!worldViews.includes(view)) return;
  scrollPositions[view] = Math.max(0, Math.round(window.scrollY));
  try { window.sessionStorage.setItem(scrollStorageKey, JSON.stringify(scrollPositions)); }
  catch { /* Scroll restoration remains available for this tab in memory. */ }
}

function renderWithTransition() {
  if (LIGHT_PRESENTATION) { render(); return; }
  if (isTransitioning) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    render();
    return;
  }
  isTransitioning = true;
  document.documentElement.classList.add("is-transitioning");
  app.classList.add("is-leaving");
  window.setTimeout(() => {
    render();
    app.classList.remove("is-leaving");
    window.requestAnimationFrame(() => {
      isTransitioning = false;
      document.documentElement.classList.remove("is-transitioning");
    });
  }, 260);
}

function navigate(view, updates = {}, { scrollTop } = {}) {
  const currentView = state().ui.view;
  rememberScrollPosition(currentView);
  if (view === "collection" && (currentView === "inbox" || collectionLiveModal)) {
    if (LIGHT_PRESENTATION && !collectionLiveModal) collectionReturnElement = document.activeElement;
    collectionLiveModal = true;
    pendingScrollTop = null;
    store.update((draft) => Object.assign(draft.ui, { view, ...updates }));
    document.body.classList.add("collection-open", "home-scroll-open");
    document.body.classList.remove("app-booting");
    setScene("inbox");
    const currentOverlay = document.querySelector(".collection-glass-overlay");
    collectionOverlayMarkup = collectionGlassDialogTemplate();
    if (currentOverlay) currentOverlay.outerHTML = collectionOverlayMarkup;
    else app.insertAdjacentHTML("afterend", collectionOverlayMarkup);
    mountCollectionRelatedScroll();
    bindSpecular();
    if (LIGHT_PRESENTATION) document.querySelector('.collection-glass-overlay [data-action="close-collection"]')?.focus({ preventScroll: true });
    return;
  }
  if (view === "collection" && currentView !== "collection") {
    collectionUnderlaySnapshot = {
      html: app.innerHTML,
      scrollTop: Math.max(0, Math.round(window.scrollY)),
      height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
    };
  }
  pendingScrollTop = Number.isFinite(scrollTop)
    ? Math.max(0, scrollTop)
    : view === "collection" ? 0 : worldViews.includes(view) ? (scrollPositions[view] ?? 0) : 0;
  store.update((draft) => Object.assign(draft.ui, { view, ...updates }));
  render();
}
function openFoyerOverHome() {
  if (document.querySelector(".home-foyer-overlay")) return;
  homeFoyerReturnScrollTop = Math.max(0, Math.round(window.scrollY));
  rememberScrollPosition("inbox");
  store.update((draft) => { draft.ui.view = "foyer"; });
  setScene("foyer");
  document.body.classList.add("home-foyer-open");
  app.insertAdjacentHTML("beforeend", `<div class="home-foyer-overlay">${foyerTemplate()}</div>`);
  updateNavigation();
  setFoyerQuickNoteExhibit(foyerQuickNoteExhibit?.id || "", foyerQuickNoteExhibit?.title || "");
  bindSpecular();
}

function closeFoyerOverHome() {
  const overlay = document.querySelector(".home-foyer-overlay");
  if (!overlay) return false;
  closeFoyerQuickNote();
  overlay.remove();
  document.body.classList.remove("home-foyer-open");
  store.update((draft) => { draft.ui.view = "inbox"; });
  setScene("home");
  updateNavigation();
  window.scrollTo({ top: homeFoyerReturnScrollTop ?? scrollPositions.inbox ?? 0, behavior: "instant" });
  homeFoyerReturnScrollTop = null;
  return true;
}
// 关闭沉浸式藏品详情：回到进入详情前的世界与滚动位置。
function closeCollection({ immediate = false } = {}) {
  const surface = document.querySelector(".collection-glass-overlay");
  if (LIGHT_PRESENTATION && surface && !immediate) {
    const id = state().ui.collectionId;
    void closeGlassOverlay(surface, () => { if (state().ui.view === "collection" && state().ui.collectionId === id) closeCollection({ immediate: true }); }); return;
  }
  const from = state().ui.collectionFrom;
  if (collectionLiveModal) {
    document.querySelector(".collection-glass-overlay")?.remove();
    document.body.classList.remove("collection-open");
    collectionLiveModal = false;
    store.update((draft) => { draft.ui.view = worldViews.includes(from) ? from : "inbox"; });
    updateNavigation();
    if (LIGHT_PRESENTATION && state().ui.lightPage === "home") {
      const collectionId = collectionReturnElement?.dataset.collectionId;
      const label = collectionReturnElement?.getAttribute("aria-label");
      pendingScrollTop = Math.max(0, Math.round(window.scrollY));
      render();
      const returnTarget = [...app.querySelectorAll("button[data-collection-id]")].find(button => button.dataset.collectionId === collectionId && button.getAttribute("aria-label") === label);
      (returnTarget || app.querySelector("#workspace-chat-input"))?.focus({ preventScroll: true });
      return;
    }
    if (LIGHT_PRESENTATION && collectionReturnElement?.isConnected) collectionReturnElement.focus({ preventScroll: true });
    return;
  }
  navigate(worldViews.includes(from) ? from : "inbox");
}
function refreshCollectionView() {
  if (!collectionLiveModal) { render(); return; }
  const overlay = document.querySelector(".collection-glass-overlay");
  if (overlay?.dataset.glassClosing) return;
  const nextMarkup = collectionGlassDialogTemplate();
  if (!overlay || nextMarkup === collectionOverlayMarkup) return;
  const scrollTop = overlay.querySelector(".collection-glass__content")?.scrollTop || 0;
  const reader = overlay.querySelector(".collection-glass--briefing");
  if (reader) {
    // Keep the mounted reader and its selected passage in place when a remote
    // update changes the collection controls or information around it.
    const before = document.createElement("template");
    const after = document.createElement("template");
    before.innerHTML = collectionOverlayMarkup;
    after.innerHTML = nextMarkup;
    if (after.content.querySelector(".collection-glass--briefing")) {
      for (const selector of [".collection-glass__nav", ".collection-briefing-header", ".collection-briefing-tools", ".collection-glass__note"]) {
        const oldSection = before.content.querySelector(selector);
        const nextSection = after.content.querySelector(selector);
        const section = reader.querySelector(selector);
        if (!section || !nextSection || oldSection?.outerHTML === nextSection.outerHTML) continue;
        const manage = nextSection.querySelector(".collection-briefing-manage");
        if (manage && section.querySelector(".collection-briefing-manage")?.open) manage.open = true;
        section.replaceWith(nextSection);
      }
    } else {
      overlay.outerHTML = nextMarkup;
    }
  } else {
    overlay.outerHTML = nextMarkup;
  }
  collectionOverlayMarkup = nextMarkup;
  const content = document.querySelector(".collection-glass__content");
  if (content) content.scrollTop = scrollTop;
  mountCollectionRelatedScroll();
  bindSpecular();
}
function setScene(scene) {
  document.body.dataset.scene = scene;
}
function escapeHtml(value = "") {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function scrollFloatHeading(lines) {
  let charIndex = 0;
  const visual = lines.map((line) => {
    const chars = [...line].map((char) => `<span class="home-scroll-float__char" data-float-char style="--char-index:${charIndex++}">${escapeHtml(char)}</span>`).join("");
    return `<span class="home-scroll-float__line">${chars}</span>`;
  }).join("");
  return `<h2 class="home-scroll-float" data-scroll-float aria-label="${escapeHtml(lines.join("，"))}"><span aria-hidden="true">${visual}</span></h2>`;
}

function pageSceneTemplate(view) {
  return `<section class="page-world-scene scene-${view}" aria-label="${worldLabels[view]}">
    <img src="./assets/scenes/${view}.png" alt="" />
    <p${view === "inbox" ? ' class="scene-label" data-text-pressure="1"' : ""}>${worldLabels[view]}</p>
  </section>`;
}

function updateNavigation() {
  if (LIGHT_PRESENTATION) { setHomeNavigation(state().ui.lightPage || "home"); return; }
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const view = state().ui.view;
    const active = link.dataset.nav === "inbox"
      ? (view === "inbox" && inboxView.mode === "all") || view === "collection"
      : link.dataset.nav === view || (link.dataset.nav === "gallery" && ["foyer", "room", "finale", "serendipity"].includes(view));
    link.classList.toggle("active", active);
    link.setAttribute("aria-current", active ? "page" : "false");
  });
}

function applyLightPage() {
  if (!LIGHT_PRESENTATION) return;
  const page = ["home", "inbox", "gallery", "records"].includes(state().ui.lightPage) ? state().ui.lightPage : "home";
  document.body.dataset.lightPage = page;
  document.querySelectorAll(".home-scroll>[data-home-section]").forEach((section) => {
    const active = section.dataset.homeSection === page;
    section.hidden = !active;
    section.setAttribute("aria-hidden", String(!active));
  });
  document.querySelector(".home-writing")?.setAttribute("aria-hidden", "false");
  setHomeNavigation(page);
}

function switchLightPage(page) {
  if (!["home", "inbox", "gallery", "records"].includes(page)) return;
  collectionLiveModal = false;
  collectionUnderlaySnapshot = null;
  document.querySelector(".collection-glass-overlay")?.remove();
  document.body.classList.remove("home-foyer-open", "recap-ticket-open", "gallery-all-open");
  inboxView.mode = "home";
  inboxFilters.captureOpen = false;
  galleryAll.open = false;
  notesAllOpen = false;
  recapTicketExhibitionId = null;
  recapTicketReturnContext = null;
  recapTicketReturnElement = null;
  exhibitDetail.id = null;
  pendingScrollTop = 0;
  store.update((draft) => Object.assign(draft.ui, { view: "inbox", lightPage: page, collectionId: null, collectionFrom: null }));
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${({ home: "top", records: "notes" })[page] || page}`);
  render();
}

function setHomeNavigation(section = "home") {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active = link.dataset.nav === section;
    link.classList.toggle("active", active);
    link.setAttribute("aria-current", active ? "location" : "false");
  });
}

function scrollToHomeSection(id) {
  if (LIGHT_PRESENTATION) { switchLightPage(({ top: "home", notes: "records" })[id] || id); return; }
  const section = document.getElementById(id);
  if (!section) return;
  // 章节自身保留大幅上留白；导航点击时多推进一点，让章节标记靠近固定顶栏。
  const lead = Math.max(32, Math.min(56, window.innerHeight * .05));
  const top = window.scrollY + section.getBoundingClientRect().top + lead;
  window.scrollTo({
    top,
    behavior: LIGHT_PRESENTATION || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

function mountHomeScrollSpy() {
  const home = document.querySelector(".home-scroll");
  if (!home) return;
  const sections = [...home.querySelectorAll("[data-home-section]")];
  if (LIGHT_PRESENTATION) {
    applyLightPage();
    return;
  }
  const directory = home.querySelector(".home-line-sidebar");
  const directoryLinks = [...(directory?.querySelectorAll("a") || [])];
  const directoryMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let raf = 0;
  let targetProgress = 0;
  let displayedProgress = 0;
  let scrollImpulse = 0;
  let previousScrollY = window.scrollY;
  let previousFrame = performance.now();

  const directoryTarget = () => {
    const hero = sections[0];
    const travel = Math.max(300, window.innerHeight * .78);
    const distance = Math.max(0, -(hero?.getBoundingClientRect().top || 0));
    return Math.max(0, Math.min(1, distance / travel));
  };

  const paintDirectory = (now = performance.now()) => {
    if (!directory) return false;
    const reduce = directoryMotion.matches;
    const elapsed = Math.min(48, Math.max(1, now - previousFrame));
    previousFrame = now;
    if (reduce) {
      displayedProgress = targetProgress >= .5 ? 1 : 0;
      scrollImpulse = 0;
    } else {
      const follow = 1 - Math.exp(-elapsed * .009);
      displayedProgress += (targetProgress - displayedProgress) * follow;
      scrollImpulse *= Math.exp(-elapsed * .008);
    }

    const linear = Math.max(0, Math.min(1, displayedProgress));
    const progress = linear * linear * (3 - 2 * linear);
    const arc = Math.sin(progress * Math.PI);
    const expandedHeight = Math.min(440, window.innerHeight - 150);
    const expandedWidth = Math.max(264, Math.min(320, window.innerWidth * .235));
    const compactWidth = 188;
    const compactHeight = 144;
    const startX = (window.innerWidth - expandedWidth) / 2;
    const startY = Math.max(82, (window.innerHeight - expandedHeight) / 2);
    const gutter = Math.max(22, Math.min(48, window.innerWidth * .032));
    const bottom = Math.max(24, Math.min(42, window.innerHeight * .04));
    const endX = gutter;
    const endY = window.innerHeight - compactHeight - bottom;
    const driftX = -arc * 22 - scrollImpulse * 3;
    const driftY = -arc * 30 + scrollImpulse * 10;
    const rotation = -arc * 1.45 + scrollImpulse * .5;
    const width = expandedWidth + (compactWidth - expandedWidth) * progress;
    const height = expandedHeight + (compactHeight - expandedHeight) * progress;
    const x = startX + (endX - startX) * progress + driftX;
    const y = startY + (endY - startY) * progress + driftY;
    const titleTargetY = Math.max(68, Math.min(94, window.innerHeight * .085));
    const introX = -26 * progress;
    const introY = (titleTargetY - y - 26) * progress - arc * 12;

    directory.style.setProperty("--directory-progress", progress.toFixed(4));
    directory.style.setProperty("--directory-x", `${x.toFixed(2)}px`);
    directory.style.setProperty("--directory-y", `${y.toFixed(2)}px`);
    directory.style.setProperty("--directory-width", `${width.toFixed(2)}px`);
    directory.style.setProperty("--directory-height", `${height.toFixed(2)}px`);
    directory.style.setProperty("--directory-rotation", `${rotation.toFixed(3)}deg`);
    directory.style.setProperty("--directory-intro-rotation", `${(-rotation * .5).toFixed(3)}deg`);
    directory.style.setProperty("--directory-intro-x", `${introX.toFixed(2)}px`);
    directory.style.setProperty("--directory-intro-y", `${introY.toFixed(2)}px`);
    directoryLinks.forEach((link, index) => {
      const rowCurve = arc * [-3, -11, -17, -8][index];
      const wake = scrollImpulse * [1.8, 1.1, .45, -.25][index];
      link.style.setProperty("--directory-row-drift", `${(rowCurve + wake).toFixed(2)}px`);
    });
    directory.classList.toggle("is-compact", targetProgress >= .98);
    return !reduce && (Math.abs(targetProgress - displayedProgress) > .0005 || Math.abs(scrollImpulse) > .01);
  };

  const updateSections = () => {
    const line = window.innerHeight * .35;
    const lead = Math.max(32, Math.min(56, window.innerHeight * .05));
    const revealBand = Math.max(32, Math.min(44, window.innerHeight * .05));
    const fadeRadius = Math.max(180, Math.min(320, window.innerHeight * .28));
    let current = "home";
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= line) current = section.dataset.homeSection;
      const heading = section.querySelector(".home-section-head");
      if (!heading) continue;
      const sectionPadding = Number.parseFloat(getComputedStyle(section).paddingTop) || 0;
      const anchorTop = sectionPadding - lead;
      const distance = Math.abs(heading.getBoundingClientRect().top - anchorTop);
      const linearVisibility = Math.max(0, Math.min(1, 1 - distance / fadeRadius));
      const visibility = linearVisibility * linearVisibility * (3 - 2 * linearVisibility);
      heading.style.setProperty("--section-head-visibility", visibility.toFixed(4));
      heading.classList.toggle("is-at-anchor", distance <= revealBand);
    }
    setHomeNavigation(current);
  };

  const frame = (now) => {
    raf = 0;
    updateSections();
    if (paintDirectory(now)) raf = requestAnimationFrame(frame);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const onScroll = () => {
    const nextScrollY = window.scrollY;
    const delta = nextScrollY - previousScrollY;
    previousScrollY = nextScrollY;
    scrollImpulse = Math.max(-1, Math.min(1, scrollImpulse * .35 + delta / 150));
    targetProgress = directoryTarget();
    schedule();
  };
  const onResize = () => {
    targetProgress = directoryTarget();
    displayedProgress = targetProgress;
    scrollImpulse = 0;
    schedule();
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  targetProgress = directoryTarget();
  displayedProgress = targetProgress;
  updateSections();
  paintDirectory();
  homeScrollCleanup = () => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    cancelAnimationFrame(raf);
    homeScrollCleanup = null;
  };
}

function mountHomeSectionMotion() {
  if (LIGHT_PRESENTATION) return;
  const home = document.querySelector(".home-scroll");
  if (!home) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const registrations = [
    {
      section: home.querySelector('[data-home-section="inbox"]'),
      items: [
        [".home-intro-grid", "cinematic", 40, 380],
        [".home-inbox-actions button:nth-child(1)", "right", 360, 280],
        [".home-inbox-actions button:nth-child(2)", "right", 470, 190],
        [".home-recommend-head", "rise", 590, 100],
        [".home-recommend-row", "content", 720, 0],
      ],
    },
    {
      section: home.querySelector('[data-home-section="gallery"]'),
      items: [
        [".home-section-action>p", "rise", 60, 260],
        [".home-gallery-shuffle", "right", 330, 130],
        [".home-gallery-grid", "content", 560, 0],
      ],
    },
    {
      section: home.querySelector('[data-home-section="records"]'),
      items: [
        [".home-notes-intro h2", "cinematic", 40, 360],
        [".home-notes-intro>div>p", "rise", 320, 240],
        [".home-notes-intro .home-corner-action", "right", 500, 120],
        [".home-notes-records,.home-notes-empty", "content", 680, 0],
      ],
    },
  ];
  const heroItems = [
    [home.querySelector(".home-hero-copy h1"), "cinematic", 60],
  ];
  const prepare = (element, kind, delay, exitDelay = 0) => {
    if (!element) return;
    element.classList.add("home-motion-reveal");
    element.dataset.motionKind = kind;
    element.style.setProperty("--motion-delay", `${reduce ? 0 : delay}ms`);
    element.style.setProperty("--motion-exit-delay", `${reduce ? 0 : exitDelay}ms`);
  };
  const reveal = (items) => items.forEach(([elementOrSelector, kind, delay]) => {
    const element = typeof elementOrSelector === "string" ? null : elementOrSelector;
    if (element) element.classList.add("is-motion-visible");
  });
  registrations.forEach(({ section, items }) => items.forEach(([selector, kind, delay, exitDelay]) => prepare(section?.querySelector(selector), kind, delay, exitDelay)));
  heroItems.forEach(([element, kind, delay]) => prepare(element, kind, delay));
  home.classList.add("home-motion-ready");

  if (reduce || !("IntersectionObserver" in window)) {
    home.querySelectorAll(".home-motion-reveal").forEach((element) => element.classList.add("is-motion-visible"));
    homeMotionCleanup = () => { homeMotionCleanup = null; };
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const registration = registrations.find(({ section }) => section === entry.target);
      registration?.items.forEach(([selector]) => entry.target.querySelector(selector)?.classList.toggle("is-motion-visible", entry.isIntersecting));
    });
  }, { threshold: .12, rootMargin: "0px 0px -38% 0px" });
  registrations.forEach(({ section }) => { if (section) observer.observe(section); });

  const revealHero = () => reveal(heroItems);
  revealHero();
  homeMotionCleanup = () => {
    observer.disconnect();
    homeMotionCleanup = null;
  };
}

function mountHomeRecordParallax() {
  if (LIGHT_PRESENTATION) return;
  const visual = document.querySelector("[data-home-record-parallax]");
  const copy = document.querySelector(".home-record-copy");
  const section = visual?.closest(".home-record-latest");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!visual || !copy || !section) return;
  let raf = 0;
  let nextX = 0;
  let nextY = 0;
  let boardOpacity = reduce ? 1 : 0;
  const paint = () => {
    raf = 0;
    copy.style.setProperty("--record-board-opacity", boardOpacity.toFixed(4));
    visual.style.setProperty("--record-cover-x", `${(nextX * 2.5).toFixed(2)}px`);
    visual.style.setProperty("--record-cover-y", `${(nextY * 2.5).toFixed(2)}px`);
    visual.style.setProperty("--record-glass-x", `${(-nextX * 7).toFixed(2)}px`);
    visual.style.setProperty("--record-glass-y", `${(-nextY * 7).toFixed(2)}px`);
    visual.style.setProperty("--record-corner-x", `${(-nextX * 4).toFixed(2)}px`);
    visual.style.setProperty("--record-corner-y", `${(-nextY * 4).toFixed(2)}px`);
    visual.style.setProperty("--record-shine-x", `${(50 + nextX * 28).toFixed(1)}%`);
    visual.style.setProperty("--record-shine-y", `${(50 + nextY * 22).toFixed(1)}%`);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  const updateBoardFocus = () => {
    if (reduce) { boardOpacity = 1; schedule(); return; }
    const rect = section.getBoundingClientRect();
    const focusY = window.innerHeight * .56;
    const centerY = rect.top + rect.height * .5;
    const range = Math.max(280, window.innerHeight * .72);
    const linear = Math.max(0, Math.min(1, 1 - Math.abs(centerY - focusY) / range));
    boardOpacity = linear * linear * (3 - 2 * linear);
    schedule();
  };
  const onMove = (event) => {
    if (event.pointerType === "touch") return;
    const rect = visual.getBoundingClientRect();
    nextX = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - .5) * 2));
    nextY = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - .5) * 2));
    visual.classList.remove("is-resetting");
    schedule();
  };
  const onLeave = () => {
    nextX = 0;
    nextY = 0;
    visual.classList.add("is-resetting");
    schedule();
  };
  if (!reduce && window.innerWidth >= 768) {
    visual.addEventListener("pointermove", onMove, { passive: true });
    visual.addEventListener("pointerleave", onLeave);
  }
  window.addEventListener("scroll", updateBoardFocus, { passive: true });
  window.addEventListener("resize", updateBoardFocus);
  updateBoardFocus();
  homeRecordParallaxCleanup = () => {
    visual.removeEventListener("pointermove", onMove);
    visual.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("scroll", updateBoardFocus);
    window.removeEventListener("resize", updateBoardFocus);
    if (raf) cancelAnimationFrame(raf);
    homeRecordParallaxCleanup = null;
  };
}

function mountHomeRecordTimeline() {
  if (LIGHT_PRESENTATION) return;
  const track = document.querySelector(".home-record-track");
  const timeline = document.querySelector("[data-home-record-timeline]");
  if (!track || !timeline) return;
  const fill = timeline.querySelector(".home-record-timeline__fill");
  const head = timeline.querySelector(".home-record-timeline__head");
  const nodes = [...timeline.querySelectorAll(".home-record-timeline__node")];
  const cards = [...track.querySelectorAll(".home-record-card")];
  if (!fill || !head || nodes.length !== cards.length || cards.length < 2) { timeline.remove(); return; }
  let marks = [];
  let cardScrolls = [];
  let raf = 0;
  const measure = () => {
    const trackLeft = track.getBoundingClientRect().left;
    const maxScroll = Math.max(1, track.scrollWidth - track.clientWidth);
    cardScrolls = cards.map((card) => card.getBoundingClientRect().left - trackLeft + track.scrollLeft);
    marks = cards.map((card, index) => ({ scroll: Math.min(cardScrolls[index], maxScroll), pct: Number.parseFloat(nodes[index].dataset.pct) || 0 }));
    marks.push({ scroll: maxScroll, pct: 100 });
  };
  const progressFromScroll = (scrollLeft) => {
    const first = marks[0];
    const last = marks[marks.length - 1];
    if (scrollLeft <= first.scroll) return first.pct;
    if (scrollLeft >= last.scroll) return last.pct;
    for (let i = 0; i < marks.length - 1; i++) {
      const a = marks[i];
      const b = marks[i + 1];
      if (scrollLeft >= a.scroll && scrollLeft < b.scroll) return a.pct + ((scrollLeft - a.scroll) / (b.scroll - a.scroll)) * (b.pct - a.pct);
    }
    return last.pct;
  };
  const scrollFromProgress = (pct) => {
    const first = marks[0];
    const last = marks[marks.length - 1];
    if (pct <= first.pct) return first.scroll;
    if (pct >= last.pct) return last.scroll;
    for (let i = 0; i < marks.length - 1; i++) {
      const a = marks[i];
      const b = marks[i + 1];
      if (pct >= a.pct && pct < b.pct) return a.scroll + ((pct - a.pct) / (b.pct - a.pct)) * (b.scroll - a.scroll);
    }
    return last.scroll;
  };
  const paint = () => {
    raf = 0;
    const scrollLeft = track.scrollLeft;
    const pct = progressFromScroll(scrollLeft);
    timeline.style.setProperty("--tl-progress", `${pct.toFixed(3)}%`);
    let activeIndex = 0;
    let bestDistance = Math.abs(scrollLeft - cardScrolls[0]);
    for (let i = 1; i < cardScrolls.length; i++) {
      const distance = Math.abs(scrollLeft - cardScrolls[i]);
      if (distance < bestDistance) { bestDistance = distance; activeIndex = i; }
    }
    nodes.forEach((node, index) => {
      node.classList.toggle("is-passed", (Number.parseFloat(node.dataset.pct) || 0) <= pct + .01);
      node.classList.toggle("is-active", index === activeIndex);
    });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  const onTrackScroll = () => schedule();
  const onResize = () => { measure(); schedule(); };
  const onNodeClick = (event) => {
    const index = Number(event.currentTarget.dataset.timelineIndex);
    if (Number.isInteger(index) && cardScrolls[index] !== undefined) track.scrollTo({ left: cardScrolls[index], behavior: "smooth" });
  };
  let dragging = false;
  const dragTo = (event) => {
    const rect = timeline.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100));
    track.scrollLeft = scrollFromProgress(pct);
  };
  const onPointerDown = (event) => {
    if (event.target.closest(".home-record-timeline__node")) return;
    dragging = true;
    try { timeline.setPointerCapture(event.pointerId); } catch {}
    dragTo(event);
  };
  const onPointerMove = (event) => {
    if (!dragging) return;
    event.preventDefault();
    dragTo(event);
  };
  const onPointerUp = () => { dragging = false; };
  measure();
  paint();
  track.addEventListener("scroll", onTrackScroll, { passive: true });
  window.addEventListener("resize", onResize);
  nodes.forEach((node) => node.addEventListener("click", onNodeClick));
  timeline.addEventListener("pointerdown", onPointerDown);
  timeline.addEventListener("pointermove", onPointerMove);
  timeline.addEventListener("pointerup", onPointerUp);
  timeline.addEventListener("pointercancel", onPointerUp);
  homeRecordTimelineCleanup = () => {
    track.removeEventListener("scroll", onTrackScroll);
    window.removeEventListener("resize", onResize);
    nodes.forEach((node) => node.removeEventListener("click", onNodeClick));
    timeline.removeEventListener("pointerdown", onPointerDown);
    timeline.removeEventListener("pointermove", onPointerMove);
    timeline.removeEventListener("pointerup", onPointerUp);
    timeline.removeEventListener("pointercancel", onPointerUp);
    if (raf) cancelAnimationFrame(raf);
    homeRecordTimelineCleanup = null;
  };
}

function mountHomeScrollFloat() {
  if (LIGHT_PRESENTATION) return;
  const heading = document.querySelector("[data-scroll-float]");
  if (!heading) return;
  const chars = [...heading.querySelectorAll("[data-float-char]")];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const easeOutBack = (value) => {
    const c1 = 1.35;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(value - 1, 3) + c1 * Math.pow(value - 1, 2);
  };
  const update = () => {
    raf = 0;
    if (reduce) {
      heading.style.setProperty("--float-progress", "1");
      chars.forEach((char) => char.style.setProperty("--char-progress", "1"));
      return;
    }
    const rect = heading.getBoundingClientRect();
    const start = window.innerHeight * .9;
    const end = window.innerHeight * .28;
    const progress = clamp((start - rect.top) / (start - end));
    const staggerSpan = Math.min(.48, Math.max(.18, chars.length * .022));
    const travel = 1 - staggerSpan;
    chars.forEach((char, index) => {
      const offset = chars.length > 1 ? (index / (chars.length - 1)) * staggerSpan : 0;
      const local = clamp((progress - offset) / travel);
      char.style.setProperty("--char-progress", easeOutBack(local).toFixed(4));
      char.style.setProperty("--char-opacity", local.toFixed(4));
    });
    heading.style.setProperty("--float-progress", progress.toFixed(4));
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  schedule();
  homeFloatCleanup = () => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    cancelAnimationFrame(raf);
    homeFloatCleanup = null;
  };
}

function mountHomeScrollVelocity() {
  if (LIGHT_PRESENTATION) return;
  const root = document.querySelector("[data-scroll-velocity]");
  const track = root?.querySelector("[data-scroll-velocity-track]");
  const group = track?.querySelector("[data-scroll-velocity-group]");
  if (!root || !track || !group) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) return;

  let previousY = window.scrollY;
  let targetVelocity = 0;
  let velocity = 0;
  let offset = 0;
  let lastTime = performance.now();
  let groupWidth = 0;
  root.style.opacity = "0";

  const syncGroups = () => {
    const item = group.querySelector("span");
    const duplicate = track.children[1];
    if (!item || !duplicate) return;
    const itemWidth = item.getBoundingClientRect().width;
    if (!itemWidth) return;
    while (group.getBoundingClientRect().width < root.clientWidth + itemWidth) {
      group.appendChild(item.cloneNode(true));
    }
    duplicate.replaceChildren(...[...group.children].map((child) => child.cloneNode(true)));
    groupWidth = group.getBoundingClientRect().width;
    offset %= groupWidth;
  };
  syncGroups();

  const onScroll = () => {
    const nextY = window.scrollY;
    targetVelocity = Math.max(-120, Math.min(120, nextY - previousY));
    previousY = nextY;
  };
  const onResize = () => { syncGroups(); };
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(root);
  document.fonts?.ready.then(() => { if (root.isConnected) syncGroups(); });

  const frame = (now) => {
    if (!root.isConnected) {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
      return;
    }
    const dt = Math.min(2, (now - lastTime) / 16.667);
    lastTime = now;
    velocity += (targetVelocity - velocity) * Math.min(1, .065 * dt);
    targetVelocity *= Math.pow(.88, dt);
    offset -= (1.45 + Math.abs(velocity) * .12) * dt;
    if (groupWidth > 0) offset = ((offset % groupWidth) + groupWidth) % groupWidth;
    track.style.transform = `translate3d(${-groupWidth + offset}px,0,0)`;
    const rect = root.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 1;
    const fadeIn = Math.max(0, Math.min(1, (viewportHeight * .92 - rect.top) / (viewportHeight * .22)));
    const fadeOut = Math.max(0, Math.min(1, (rect.bottom - viewportHeight * .08) / (viewportHeight * .2)));
    root.style.opacity = String(Math.min(fadeIn, fadeOut));
    requestAnimationFrame(frame);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  requestAnimationFrame(frame);
}

function mountHomeTransitionMotion() {
  if (LIGHT_PRESENTATION) return;
  const hero = document.querySelector('[data-home-section="home"]');
  const cue = document.querySelector("[data-home-scroll-cue]");
  const transition = document.querySelector("[data-home-transition-copy]");
  const stage = transition?.querySelector(".home-transition-stage");
  const artifactsWrap = transition?.querySelector(".home-transition-artifacts");
  const copy = transition?.querySelector("p");
  const artifacts = [...(transition?.querySelectorAll(".home-transition-artifact") || [])];
  const lines = [...(copy?.querySelectorAll("span") || [])];
  if (!hero || !cue || !transition || !stage || !copy) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const interaction = artifacts.map(() => ({ hover: 0, velocity: 0, color: 0, colorVelocity: 0 }));
  let hoveredArtifact = -1;
  let raf = 0;
  let settling = false;
  let smoothedProgress = 0;
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const transitionTimelineDelay = .5;
  let revealStart = .38;
  let revealMeasured = false;
  const updateRevealStart = () => {
    const travel = transition.offsetHeight - window.innerHeight;
    if (travel <= 0) return;
    const heroCopy = hero.querySelector(".home-hero-copy");
    const copyRect = heroCopy?.getBoundingClientRect();
    if (!copyRect || copyRect.height <= 0) return;
    const transitionTop = (transition.getBoundingClientRect().top || 0) + window.scrollY;
    const textBottom = (copyRect?.bottom ?? 0) + window.scrollY;
    revealStart = Math.min(.62, (textBottom - transitionTop) / travel + .01 + transitionTimelineDelay);
    revealMeasured = true;
  };
  updateRevealStart();
  window.addEventListener("resize", updateRevealStart);
  window.addEventListener("load", updateRevealStart);
  document.fonts?.ready?.then?.(updateRevealStart);
  const paint = () => {
    raf = 0;
    const viewport = Math.max(1, window.innerHeight);
    const heroRect = hero.getBoundingClientRect();
    const cueOpacity = clamp(1 + heroRect.top / (viewport * .34));
    cue.style.setProperty("--home-cue-opacity", cueOpacity.toFixed(4));
    cue.style.visibility = cueOpacity <= .01 ? "hidden" : "visible";

    const transitionRect = transition.getBoundingClientRect();
    const transitionTop = window.scrollY + transitionRect.top;
    const stickyTravel = Math.max(1, transition.offsetHeight - viewport);
    const currentProgress = Math.max(-.5, Math.min(1, (window.scrollY - transitionTop) / stickyTravel));
    if (!revealMeasured) updateRevealStart();
    const progressDifference = currentProgress - smoothedProgress;
    smoothedProgress = Math.abs(progressDifference) < .0005
      ? currentProgress
      : smoothedProgress + progressDifference * .11;
    const progress = smoothedProgress;
    const localProgress = (start, duration) => clamp((progress - start) / duration);
    const stageRect = stage.getBoundingClientRect();
    // Sticky positioning can oscillate by a fraction of a pixel around zero.
    // Rounding that value made the entire ring jump between 0 and -1px.
    const ringPinY = stageRect.top > -1 ? 0 : Math.min(0, -stageRect.top);
    artifactsWrap.style.setProperty("--home-ring-pin-y", `${ringPinY.toFixed(2)}px`);
    const viewportEdgeOpacity = clamp(1 + stageRect.top / (viewport * .42));
    const sectionFadeIn = localProgress(revealStart, .04);
    const sectionFadeOut = 1 - viewportEdgeOpacity;
    const opacity = Math.min(sectionFadeIn, 1 - sectionFadeOut);
    transition.style.setProperty("--home-transition-opacity", opacity.toFixed(4));
    transition.style.setProperty("--home-transition-y", `${((1 - opacity) * 24).toFixed(2)}px`);
    const artifactFadeIn = localProgress(revealStart, .04);
    const artifactFadeOut = 1 - viewportEdgeOpacity;
    const artifactOpacity = Math.min(artifactFadeIn, 1 - artifactFadeOut);
    transition.style.setProperty("--home-artifact-opacity", artifactOpacity.toFixed(4));
    // Retire the hero relief just before the first text-ring card arrives so
    // the fixed WebGL canvas cannot bleed into the following chapter.
    const cardExitProgress = localProgress(Math.max(0, revealStart - .075), .055);
    window.dispatchEvent(new CustomEvent("forme-card-timeline", { detail: { exitProgress: cardExitProgress } }));
    const ringArrived = localProgress((artifacts.length - 1) * .016 + revealStart, .14);
    const ringInteractive = reduce || (ringArrived >= 1 && artifactOpacity >= .999);
    if (!ringInteractive && hoveredArtifact !== -1) hoveredArtifact = -1;
    const lineProgress = [localProgress(.62, .08), localProgress(.72, .08), localProgress(.82, .08)];
    lines.forEach((line, index) => {
      const value = lineProgress[index] ?? 1;
      line.style.opacity = String(value);
      line.style.transform = `translateY(${((1 - value) * 24).toFixed(2)}px)`;
      line.style.filter = `blur(${((1 - value) * 7).toFixed(2)}px)`;
    });
    settling = Math.abs(currentProgress - smoothedProgress) > .0005;
    const radius = Math.min(stageRect.width * .19, viewport * .315);
    artifacts.forEach((artifact, index) => {
      const ringAngle = index / artifacts.length * Math.PI * 2 - Math.PI * .5;
      let projectedX = Math.cos(ringAngle) * radius;
      let projectedY = Math.sin(ringAngle) * radius;
      const targetHover = reduce || index !== hoveredArtifact ? 0 : 1;
      const indexDistance = hoveredArtifact < 0 ? artifacts.length : Math.min(
        Math.abs(index - hoveredArtifact),
        artifacts.length - Math.abs(index - hoveredArtifact),
      );
      const targetColor = reduce ? 0 : indexDistance === 0 ? 1 : indexDistance === 1 ? .62 : indexDistance === 2 ? .26 : 0;
      const state = interaction[index];
      state.velocity = (state.velocity + (targetHover - state.hover) * .16) * .66;
      state.hover += state.velocity;
      state.colorVelocity = (state.colorVelocity + (targetColor - state.color) * .12) * .7;
      state.color += state.colorVelocity;
      if (Math.abs(targetHover - state.hover) > .002 || Math.abs(state.velocity) > .002 || Math.abs(targetColor - state.color) > .002 || Math.abs(state.colorVelocity) > .002) settling = true;
      const radialAngle = Math.atan2(projectedY, projectedX) * 180 / Math.PI + 90;
      const cardScale = 1 + state.hover * .38;
      const translateZ = state.hover * 130;
      const arrive = localProgress(index * .016 + revealStart, .14);
      const cardOpacity = localProgress(index * .016 + revealStart, .03);
      const previousOpacity = interaction[index].lastOpacity ?? 0;
      const cappedOpacity = Math.max(0, Math.min(1, previousOpacity + Math.max(-.16, Math.min(.16, cardOpacity - previousOpacity))));
      interaction[index].lastOpacity = cappedOpacity;
      const arrivalScale = 1;
      artifact.style.zIndex = String(10 + Math.round(state.hover * 60));
      artifact.style.transform = `translate3d(calc(-50% + ${projectedX.toFixed(2)}px), calc(-50% + ${projectedY.toFixed(2)}px), ${translateZ.toFixed(2)}px) rotateZ(${radialAngle.toFixed(2)}deg) scale(${(cardScale * arrivalScale).toFixed(4)})`;
      artifact.style.opacity = cappedOpacity.toFixed(4);
      // Enabling hover card-by-card during the stagger lets an early card resize
      // under a stationary pointer and repeatedly cross its own hit boundary.
      artifact.style.pointerEvents = ringInteractive && arrive >= 1 ? "auto" : "none";
      artifact.style.setProperty("--artifact-color", Math.max(0, Math.min(1, state.color)).toFixed(4));
      artifact.style.filter = "";
    });
    if (settling) raf = requestAnimationFrame(paint);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  const hoverListeners = artifacts.map((artifact, index) => {
    const enter = () => { hoveredArtifact = index; schedule(); };
    const leave = () => { if (hoveredArtifact === index) hoveredArtifact = -1; schedule(); };
    artifact.addEventListener("pointerenter", enter);
    artifact.addEventListener("pointerleave", leave);
    return { artifact, enter, leave };
  });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  schedule();
  homeTransitionCleanup = () => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("resize", updateRevealStart);
    window.removeEventListener("load", updateRevealStart);
    hoverListeners.forEach(({ artifact, enter, leave }) => {
      artifact.removeEventListener("pointerenter", enter);
      artifact.removeEventListener("pointerleave", leave);
    });
    cancelAnimationFrame(raf);
    homeTransitionCleanup = null;
  };
}

function mountGalleryElasticHover() {
  if (LIGHT_PRESENTATION) return;
  const cards = [...document.querySelectorAll(".home-gallery-card")];
  if (!cards.length) return;
  const cleanups = cards.map((card) => mountElasticMesh(card.querySelector(".home-gallery-mesh"), {
    image: card.dataset.meshImage || "",
    color1: card.dataset.meshColor1 || "#18151a",
    color2: card.dataset.meshColor2 || "#080a0d",
    showGrid: false,
    gridOpacity: 0,
    resolution: 25,
    stiffness: .05,
    damping: .2,
    grabRadius: .6,
    pull: .48,
    wobble: 5,
    tilt: 0,
    shading: .65,
    borderRadius: 4,
  })).filter(Boolean);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  cards.filter((card) => card.classList.contains("home-gallery-ticket")).forEach((card) => {
    let pointerRaf = 0;
    const onPointerMove = (event) => {
      if (reduce) return;
      const rect = card.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const py = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      cancelAnimationFrame(pointerRaf);
      pointerRaf = requestAnimationFrame(() => {
        card.classList.add("is-pointer-active");
        card.style.setProperty("--ticket-rx", `${((.5 - py) * 3.2).toFixed(2)}deg`);
        card.style.setProperty("--ticket-ry", `${((px - .5) * 3.2).toFixed(2)}deg`);
        card.style.setProperty("--ticket-glow-x", `${(px * 100).toFixed(1)}%`);
        card.style.setProperty("--ticket-glow-y", `${(py * 100).toFixed(1)}%`);
      });
    };
    const onPointerLeave = () => {
      cancelAnimationFrame(pointerRaf);
      card.classList.remove("is-pointer-active");
      card.style.setProperty("--ticket-rx", "0deg");
      card.style.setProperty("--ticket-ry", "0deg");
      card.style.setProperty("--ticket-glow-x", "50%");
      card.style.setProperty("--ticket-glow-y", "50%");
    };
    card.addEventListener("pointermove", onPointerMove, { passive: true });
    card.addEventListener("pointerleave", onPointerLeave);
    cleanups.push(() => {
      card.removeEventListener("pointermove", onPointerMove);
      card.removeEventListener("pointerleave", onPointerLeave);
      cancelAnimationFrame(pointerRaf);
    });
  });
  galleryElasticCleanup = () => { cleanups.forEach((cleanup) => cleanup()); galleryElasticCleanup = null; };
}

function shuffleHomeGallery() {
  const grid = document.querySelector("[data-home-gallery-grid]");
  const button = document.querySelector('[data-action="shuffle-home-gallery"]');
  if (!grid || grid.classList.contains("is-shuffling")) return;
  if (button) button.disabled = true;
  grid.classList.add("is-shuffling");
  window.setTimeout(() => {
    if (galleryElasticCleanup) galleryElasticCleanup();
    homeGalleryRound += 1;
    grid.innerHTML = homeGalleryTickets().join("");
    mountGalleryElasticHover();
    grid.classList.remove("is-shuffling");
    grid.classList.add("is-arriving");
    window.setTimeout(() => {
      grid.classList.remove("is-arriving");
      if (button) button.disabled = false;
    }, 620);
  }, 360);
}

function layoutCollectionGrid() {
  const grid = document.querySelector(".inbox-all-modal .collection-grid") || document.querySelector(".inbox-page .collection-grid");
  if (!grid) return;
  const styles = getComputedStyle(grid);
  const row = parseFloat(styles.gridAutoRows);
  const gap = parseFloat(styles.rowGap);
  const cards = [...grid.querySelectorAll(".collection-card")];
  cards.forEach((card) => { card.style.gridRowEnd = "auto"; });
  // offsetHeight reflects the layout box; getBoundingClientRect is distorted by the arrive transform animation.
  const spans = cards.map((card) => Math.max(1, Math.ceil((card.offsetHeight + gap) / (row + gap))));
  cards.forEach((card, index) => { card.style.gridRowEnd = `span ${spans[index]}`; });
  grid.querySelectorAll("img").forEach((image) => {
    if (!image.complete) image.addEventListener("load", layoutCollectionGrid, { once: true });
  });
}

function typeLabel(type) {
  return { video: "视频", image: "图片", image_note: "图文", video_note: "视频笔记", user_input: "文字", text: "文字", article: "文章", web: "网页", link: "网页", pdf: "文档", audio: "音频" }[type] ?? (/[\u3400-\u9fff]/u.test(String(type || "")) ? type : "内容");
}
function exploreLabel(explore) {
  const dim = { concept: "线索", source: "来源", type: "类型", status: "状态" }[explore.dim] ?? explore.dim;
  return `${dim}：${explore.dim === "type" ? typeLabel(explore.value) : explore.value}`;
}
// ✦推荐逻辑：对全部藏品的 tags 做共现聚类，挑出出现在 ≥2 条收藏里的线索簇，按强度排序作为“正在浮现的方向”。纯计算、附依据、可否定。
function computeInboxInsights(collections, extractions, limit = 4) {
  return collectionDirections(collections, extractions, { feedback: state().feedback, limit });
}
function computeInboxInsight(collections, extractions) {
  return computeInboxInsights(collections, extractions, 1)[0] ?? null;
}
function renderExploreMenu(collections) {
  const sources = new Map(); const types = new Map();
  for (const item of collections) { sources.set(item.source, (sources.get(item.source) || 0) + 1); types.set(item.type, (types.get(item.type) || 0) + 1); }
  const group = (title, rows) => rows.length ? `<div class="explore-group"><p>${title}</p>${rows.join("")}</div>` : "";
  return group("来源", [...sources.entries()].map(([source, n]) => `<button data-action="explore" data-dim="source" data-value="${escapeHtml(source)}"><span>${escapeHtml(source)}</span><i>${n}</i></button>`))
    + group("类型", [...types.entries()].map(([type, n]) => `<button data-action="explore" data-dim="type" data-value="${escapeHtml(type)}"><span>${typeLabel(type)}</span><i>${n}</i></button>`))
}
function insightPanel(insight) {
  return `<section class="insight-card"><p class="eyebrow">✦ 系统注意到一个方向</p><p class="insight-line">你最近收的 ${insight.members.length} 条，似乎都在绕着「<b>${escapeHtml(insight.tag)}</b>」打转。</p><p class="insight-why">依据 · ${insight.evidence.map(escapeHtml).join(" · ")}</p><div class="insight-actions"><button class="insight-deny" data-action="insight-dismiss" data-tag="${escapeHtml(insight.tag)}">牵强，先不</button><button class="insight-keep" data-action="insight-keep" data-tag="${escapeHtml(insight.tag)}">有意思，继续观察 →</button></div></section>`;
}
// Recommended 弧面画廊：CSS 3D 圆柱面卡片，参考 CircularGallery 的弯曲排布 + 圆角图片 + 白色文字标签。
function directionCoverImage(d, collections) {
  const member = collections.find((item) => d.members.includes(item.id) && (homeTicketZineArtwork[item.id] || item.thumbnail));
  return member ? (homeTicketZineArtwork[member.id] || member.thumbnail || "") : "";
}
function directionAnchorCollection(d, collections) {
  return collections.find((item) => d.members.includes(item.id) && item.thumbnail) ?? collections.find((item) => d.members.includes(item.id));
}
const defaultCollectionCategories = ["工作", "生活", "运动"];
function collectionCategoryEditorMarkup(collectionId, current = "", compact = false) {
  return `<form class="collection-category-editor${compact ? " is-compact" : ""}" data-form="collection-category" data-collection-id="${escapeHtml(collectionId)}">
    <span>分类</span>
    <div>${defaultCollectionCategories.map((category) => `<button type="button" data-action="set-collection-category" data-category="${category}" class="${current === category ? "is-active" : ""}">${category}</button>`).join("")}</div>
    <label><input name="category" maxlength="12" value="${escapeHtml(defaultCollectionCategories.includes(current) ? "" : current)}" placeholder="自定义分类" /><button type="submit">保存</button></label>
  </form>`;
}
function recommendCircularCard(d, index, collections, extractions) {
  const item = directionAnchorCollection(d, collections);
  return renderRecommendationCard({ ...d, item }, { ...state(), collections, extractions }, { artwork: homeTicketZineArtwork, typeLabel: typeLabel(item?.type) });
}
function inboxItemMatch(item, query, explore) {
  const haystack = [item.dataset.title, item.dataset.tags, item.dataset.concepts, item.dataset.source, item.dataset.type].join(" ").toLowerCase();
  const matchQuery = !query || haystack.includes(query);
  let matchExplore = true;
  if (explore) {
    const value = explore.value.toLowerCase();
    if (explore.dim === "concept") matchExplore = (item.dataset.tags || "").split("|").includes(value);
    else if (explore.dim === "source") matchExplore = (item.dataset.source || "").toLowerCase() === value;
    else if (explore.dim === "type") matchExplore = item.dataset.type === explore.value;
    else if (explore.dim === "status") matchExplore = item.dataset.status === explore.value;
  }
  return matchQuery && matchExplore;
}
// 原地筛选（不触发整页重渲染），保留搜索框焦点与中文输入法合成状态。
function applyInboxFilters() {
  const grid = document.querySelector(".inbox-page .collection-grid");
  const query = inboxFilters.query.trim().toLowerCase();
  const explore = inboxFilters.explore;
  const filtering = Boolean(query || explore);
  const cards = grid ? [...grid.querySelectorAll(".collection-card")] : [];
  let shown = 0;
  cards.forEach((card, index) => {
    const visible = filtering ? inboxItemMatch(card, query, explore) : true;
    const beyondLimit = !filtering && index >= inboxFilters.limit;
    card.classList.toggle("is-hidden", !visible || beyondLimit);
    if (visible && !beyondLimit) shown += 1;
  });
  const empty = grid?.querySelector(".filter-empty");
  if (empty) empty.classList.toggle("is-on", filtering && shown === 0 && cards.length > 0);
  const loadMore = grid?.querySelector(".load-more");
  if (loadMore) loadMore.classList.toggle("is-hidden", filtering || inboxFilters.limit >= cards.length);
  const meta = document.querySelector(".inbox-page .discovery-meta");
  if (meta) meta.textContent = filtering ? (shown === 0 ? "没有匹配的收藏" : `${shown} / ${cards.length} 条匹配`) : "";
  // 可见卡片变化会改变瀑布流高度；下一帧等 display 状态生效后重新测量。
  requestAnimationFrame(layoutCollectionGrid);
}

function loadNextInboxPage() {
  const total = state().collections.length;
  if (inboxFilters.limit >= total) return;
  inboxFilters.limit = Math.min(inboxFilters.limit + 8, total);
  const sentinel = document.querySelector(".inbox-all-modal .load-more");
  if (sentinel) sentinel.textContent = inboxFilters.limit < total ? "继续滚动加载" : "已显示全部收藏";
  applyInboxFilters();
}

function mountInboxInfiniteLoad() {
  const modal = document.querySelector(".inbox-all-modal");
  const sentinel = modal?.querySelector(".load-more");
  if (!modal || !sentinel) return;
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadNextInboxPage();
  }, { root: modal, rootMargin: "0px 0px 320px 0px", threshold: 0 });
  observer.observe(sentinel);
  inboxInfiniteCleanup = () => {
    observer.disconnect();
    inboxInfiniteCleanup = null;
  };
}

// 主页状态：home（默认首页）/ all（收藏网格弹窗打开）。
const inboxView = { mode: "home" };

// 场景锚点表：固定坐标，卡片直立站在地面上，ty 是绕底边垂直轴的角度（不同朝向），
// tier 决定基准宽度；d 决定景深（0 前景锐利 / 1 中景 / 2 远景雾感）。
const SCENE_ANCHORS = {
  desktop: [
    { x: 18, y: 66, s: 1.22, ty: -20, d: 0, tier: "featured" },
    { x: 38, y: 60, s: 1.0, ty: -10, d: 1, tier: "standard" },
    { x: 58, y: 63, s: 1.0, ty: -2, d: 1, tier: "standard" },
    { x: 78, y: 67, s: 1.0, ty: 8, d: 1, tier: "standard" },
    { x: 22, y: 36, s: 0.66, ty: -14, d: 2, tier: "mini" },
    { x: 66, y: 32, s: 0.66, ty: 18, d: 2, tier: "mini" },
  ],
  tablet: [
    { x: 20, y: 66, s: 1.22, ty: -18, d: 0, tier: "featured" },
    { x: 40, y: 58, s: 1.0, ty: -8, d: 1, tier: "standard" },
    { x: 62, y: 61, s: 1.0, ty: 0, d: 1, tier: "standard" },
    { x: 80, y: 66, s: 1.0, ty: 10, d: 1, tier: "mini" },
    { x: 28, y: 36, s: 0.66, ty: -12, d: 2, tier: "mini" },
    { x: 72, y: 32, s: 0.66, ty: 20, d: 2, tier: "mini" },
  ],
  mobile: [
    { x: 26, y: 64, s: 1.22, ty: -14, d: 0, tier: "featured" },
    { x: 62, y: 54, s: 1.0, ty: 6, d: 1, tier: "standard" },
    { x: 80, y: 60, s: 1.0, ty: 14, d: 1, tier: "mini" },
    { x: 34, y: 38, s: 0.66, ty: -10, d: 2, tier: "mini" },
    { x: 72, y: 34, s: 0.66, ty: 18, d: 2, tier: "mini" },
  ],
};

function sceneAnchors() {
  const w = window.innerWidth;
  return [...(w < 640 ? SCENE_ANCHORS.mobile : w < 1100 ? SCENE_ANCHORS.tablet : SCENE_ANCHORS.desktop)];
}
// 在场样本：最近收的前 N 条 + 正在浮现方向成员（去重），N = 当前屏幕锚点数。
function sceneSample(collections, extractions) {
  const anchors = sceneAnchors();
  const sorted = [...collections].sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  const insight = collections.length >= 3 ? computeInboxInsight(collections, extractions) : null;
  const dismissed = insight ? state().feedback[`insight:${insight.tag}`]?.dismissed : true;
  const sample = [];
  const seen = new Set();
  for (const item of sorted) {
    if (sample.length >= anchors.length) break;
    sample.push(item);
    seen.add(item.id);
  }
  if (insight && !dismissed) {
    for (const id of insight.members) {
      if (sample.length >= anchors.length) break;
      if (seen.has(id)) continue;
      const item = collections.find((c) => c.id === id);
      if (item) { sample.push(item); seen.add(id); }
    }
  }
  return { sample, insight: insight && !dismissed ? insight : null, anchors };
}

// 镜面卡：静止时只反射环境（无内容）；hover 飞起并浮现基础信息；点击打开详情弹窗。
function sceneGlassCard(item, extraction, index, anchor, insight) {
  const tags = [...(extraction?.tags || []), ...(extraction?.concepts || [])];
  const inDirection = insight?.members.includes(item.id);
  const pos = `--slot-x:${anchor.x}%;--slot-y:${anchor.y}%;--slot-s:${anchor.s};--tilt-y:${anchor.ty ?? 0}deg;--delay:${(index * 0.09).toFixed(2)}s;`;
  return `<article class="scene-glass-card scene-glass-card--${anchor.tier} depth-${anchor.d}" data-action="open-collection" data-collection-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" data-source="${escapeHtml(item.source)}" data-type="${escapeHtml(item.type)}" data-status="${item.status}" data-tags="${tags.map((tag) => escapeHtml(tag)).join("|").toLowerCase()}" data-concepts="${(extraction?.concepts || []).map((concept) => escapeHtml(concept).toLowerCase()).join("|")}" ${inDirection && insight ? `data-tag="${escapeHtml(insight.tag)}" data-members="${escapeHtml(insight.members.join(","))}"` : ""} data-depth="${anchor.d}" style="${pos}" tabindex="0" role="button" aria-label="查看藏品：${escapeHtml(item.title)}">
    <div class="scene-glass-edge scene-glass-edge--top" aria-hidden="true"></div>
    <div class="scene-glass-edge scene-glass-edge--bottom" aria-hidden="true"></div>
    <div class="scene-glass-edge scene-glass-edge--left" aria-hidden="true"></div>
    <div class="scene-glass-edge scene-glass-edge--right" aria-hidden="true"></div>
    <div class="scene-glass-card__reveal" aria-hidden="true">${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="" />` : `<span class="scene-glass-card__fallback"></span>`}</div>
    <div class="scene-glass-card__scrim" aria-hidden="true"></div>
    <div class="scene-glass-card__body">
      <p class="scene-glass-card__meta">${escapeHtml(item.source)} · ${typeLabel(item.type)}${inDirection ? `<i class="scene-glass-card__spark" aria-label="正在浮现的方向">✦</i>` : ""}</p>
      <h3 class="scene-glass-card__title">${escapeHtml(item.title)}</h3>
    </div>
  </article>`;
}

function inboxSceneTemplate({ includeCapture = true } = {}) {
  return `<section class="inbox-scene" data-inbox-scene style="--scene-progress:0;--far-scale:1;--middle-scale:1;--near-scale:1">
    <div class="inbox-scene__stage">
      <div class="inbox-scene__layer inbox-scene__layer--far" aria-hidden="true">
        <img class="inbox-scene__fallback inbox-scene__fallback--4k" src="./assets/scenes/inbox-lake-poster.png" alt="" />
        <span class="inbox-scene__sunwash"></span>
      </div>
      <div class="inbox-scene__veil" aria-hidden="true"></div>
      <div class="inbox-scene__grain" aria-hidden="true"></div>
    </div>
    ${includeCapture ? captureOverlayTemplate() : ""}
  </section>`;
}

function inboxAllTemplate() {
  const { collections, extractions } = state();
  const sorted = [...collections].sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  const qualified = extractions.filter((item) => item.status === "qualified").length;
  const insight = collections.length >= 3 ? computeInboxInsight(collections, extractions) : null;
  const insightState = insight ? state().feedback[`insight:${insight.tag}`] : null;
  const recommended = inboxFilters.mode === "recommended";
  const highlightMembers = recommended && insight && !insightState?.dismissed;
  const searchOpen = inboxFilters.searchOpen || Boolean(inboxFilters.query) || Boolean(inboxFilters.explore) || recommended;
  const searching = searchOpen || inboxFilters.expanded || inboxFilters.captureOpen;
  const truncated = !searching && sorted.length > inboxFilters.limit;
  return `<section class="workspace-page inbox-page is-all${searching ? " is-searching" : ""}${inboxFilters.menuOpen ? " is-exploring" : ""}">
    <button class="back-scene" data-action="close-inbox-all"><span aria-hidden="true">←</span> 返回</button>
    <div class="inbox-discovery">
      <header class="forme-head">
        <button class="icon-btn" data-action="toggle-search" aria-expanded="${inboxFilters.searchOpen}" aria-label="搜索收藏"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.35-4.35"/></svg></button>
        <button class="forme-head-title" data-action="close-inbox-all" aria-label="Folio · 关闭收藏弹窗"><h1 data-text-pressure="1">Folio</h1><p>让喜欢，慢慢成形。</p></button>
        <div class="forme-head-actions">
          <button class="icon-btn" data-action="toggle-explore" aria-expanded="${inboxFilters.menuOpen}" aria-label="按类探索"><span aria-hidden="true">≡</span></button>
        </div>
      </header>
      ${searchOpen ? `<div class="discovery-bar"><span class="discovery-glyph" aria-hidden="true">⌕</span><label class="sr-only" for="inbox-search">在收藏里搜索</label><input id="inbox-search" class="discovery-search" type="search" autocomplete="off" placeholder="在收藏里搜索 · 关键词、概念、来源…" value="${escapeHtml(inboxFilters.query)}"/><span class="discovery-shortcut" aria-hidden="true"><kbd>⌘</kbd><kbd>K</kbd></span><button class="discovery-clear" data-action="toggle-search" aria-label="收起搜索"><span aria-hidden="true">✕</span></button></div>
      <p class="discovery-meta" aria-live="polite"></p>` : ""}
      ${inboxFilters.menuOpen ? `<div class="explore-panel explore-panel--categories" role="dialog" aria-label="按类探索">
        <section class="explore-col"><p class="eyebrow">按类探索</p>${renderExploreMenu(collections)}${inboxFilters.explore ? `<button class="active-filter panel-clear" data-action="clear-explore">${escapeHtml(exploreLabel(inboxFilters.explore))} <i aria-hidden="true">✕</i></button>` : ""}</section>
      </div>` : ""}
    </div>
    <div class="inbox-grainient" aria-hidden="true"></div>
    ${collections.length ? `<div class="inbox-results">
      ${recommended && insight && !insightState ? insightPanel(insight) : ""}
      ${recommended && insight && insightState?.kept ? `<p class="insight-quiet"><span>✦</span> 正在静静观察「<b>${escapeHtml(insight.tag)}</b>」这个方向。</p>` : ""}
      <div class="inbox-stats-row"><div class="inbox-stats" aria-live="polite">收藏数 <b>${collections.length}</b> <i aria-hidden="true">·</i> 已关联 <b>${qualified}</b></div><button class="capture-plus specular" data-action="toggle-capture" aria-expanded="${inboxFilters.captureOpen}"><span aria-hidden="true">＋</span><b>收新</b></button></div>
      <div class="collection-grid">${sorted.map((item, index) => collectionCard(item, extractions.find((entry) => entry.collectionId === item.id), index, { insight: highlightMembers && insight.members.includes(item.id) })).join("")}<p class="filter-empty">没有匹配的收藏。换个关键词，或<a data-action="clear-all">清除筛选</a>。</p>${truncated ? `<button class="load-more" data-action="load-more">继续滚动加载</button>` : ""}</div>
    </div>` : `<div class="empty-state"><span>还没有收藏</span><p>把灵感留在这里，连接会慢慢浮现。</p><div class="empty-actions"><button class="capture-plus" data-action="toggle-capture"><span aria-hidden="true">＋</span><b>添加一条</b></button></div></div>`}
    ${captureOverlayTemplate()}
  </section>`;
}

function galleryArchiveItems() {
  return [...(state().liveExhibitions || [])].reverse().map((item, index) => ({
    ...item, live: true, index, number: String(index + 1).padStart(3, "0"), title: item.title,
    lead: item.curatorial_note?.text || "", subtitle: item.subtitle || "", image: item.image || "",
    rooms: String(item.rooms?.length || 0), epigraph: [item.open_question || ""],
    status: state().exhibitionRecords.some(record => record.exhibitionId === item.id) || state().exhibitions.find(progress => progress.id === item.id)?.completed ? "completed" : state().exhibitions.find(progress => progress.id === item.id)?.status === "showing" ? "showing" : "unviewed",
    needsReview: item.status === "needs_review",
    generatedAt: item.generatedAt || item.createdAt || "", viewedAt: "",
  }));
}

function galleryArchiveStatusLabel(status) {
  return status === "showing" ? "正在展出" : status === "completed" ? "已看完" : "尚未观看";
}

function filteredGalleryArchiveItems() {
  const query = galleryAll.query.trim().toLowerCase();
  return galleryArchiveItems().filter((item) => {
    const matchesStatus = galleryAll.status === "all" || item.status === galleryAll.status;
    const matchesQuery = !query || [item.title, item.lead, item.subtitle, item.meta].join(" ").toLowerCase().includes(query);
    return matchesStatus && matchesQuery;
  }).sort((a, b) => {
    if (galleryAll.sort === "viewed") {
      const viewedDelta = String(b.viewedAt).localeCompare(String(a.viewedAt));
      if (viewedDelta) return viewedDelta;
    }
    return String(b.generatedAt).localeCompare(String(a.generatedAt));
  });
}

function galleryAllMenuTemplate() {
  const statusOptions = [["all", "全部"], ["showing", "正在展出"], ["unviewed", "尚未观看"], ["completed", "已看完"]];
  const sortOptions = [["generated", "最近生成"], ["viewed", "最近观看"]];
  return `<div class="explore-panel explore-panel--categories gallery-all-explore" role="dialog" aria-label="筛选与排序展览">
    <section><p>展览状态</p><div>${statusOptions.map(([value, label]) => `<button data-action="gallery-all-status" data-value="${value}" class="${galleryAll.status === value ? "is-active" : ""}" aria-pressed="${galleryAll.status === value}"><span>${label}</span></button>`).join("")}</div></section>
    <section><p>排序方式</p><div>${sortOptions.map(([value, label]) => `<button data-action="gallery-all-sort" data-value="${value}" class="${galleryAll.sort === value ? "is-active" : ""}" aria-pressed="${galleryAll.sort === value}"><span>${label}</span><i aria-hidden="true">${galleryAll.sort === value ? "↓" : ""}</i></button>`).join("")}</div></section>
  </div>`;
}

function galleryAllTemplate() {
  const allItems = galleryArchiveItems();
  const items = filteredGalleryArchiveItems();
  // 展览票直接复用观展记录弹窗票面（notesAllArchiveTemplate）的结构与皮肤。
  const artifacts = homeTicketArtifacts();
  const completed = allItems.filter((item) => item.status === "completed").length;
  return `<section class="workspace-page inbox-page is-all gallery-all-page${galleryAll.searchOpen || galleryAll.query ? " is-searching" : ""}${galleryAll.menuOpen ? " is-exploring" : ""}">
    <div class="inbox-discovery gallery-all-discovery">
      <header class="forme-head">
        <button class="icon-btn" data-action="gallery-all-focus-search" aria-expanded="${galleryAll.searchOpen}" aria-label="搜索展览"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.35-4.35"/></svg></button>
        <button class="forme-head-title" data-action="gallery-all-reset" aria-label="Folio · 重置全部展览"><h1 data-text-pressure="1">Folio</h1><p>让喜欢，慢慢成形。</p></button>
        <div class="forme-head-actions"><button class="icon-btn" data-action="gallery-all-menu" aria-expanded="${galleryAll.menuOpen}" aria-label="展览筛选与排序"><span aria-hidden="true">≡</span></button></div>
      </header>
      ${galleryAll.searchOpen || galleryAll.query ? `<div class="discovery-bar"><span class="discovery-glyph" aria-hidden="true">⌕</span><label class="sr-only" for="gallery-all-search">搜索展览</label><input id="gallery-all-search" class="discovery-search" type="search" autocomplete="off" placeholder="搜索展览 · 标题、命题、内容…" value="${escapeHtml(galleryAll.query)}"/><span class="discovery-shortcut" aria-hidden="true"><kbd>⌘</kbd><kbd>K</kbd></span><button class="discovery-clear" data-action="gallery-all-focus-search" aria-label="收起搜索"><span aria-hidden="true">✕</span></button></div>` : ""}
      ${galleryAll.menuOpen ? galleryAllMenuTemplate() : ""}
    </div>
    <div class="inbox-stats-row gallery-all-stats-row"><div class="inbox-stats gallery-all-stats" aria-live="polite">展览数 <b>${allItems.length}</b> <i aria-hidden="true">·</i> 已关联 <b>${completed}</b></div></div>
    <div class="gallery-archive-head"><p>全部展览</p><span>${galleryAll.sort === "viewed" ? "最近观看" : "最近生成"}</span></div>
    ${items.length ? `<div class="notes-all-grid">${items.map((item, index) => {
      const clipId = `gallery-ticket-clip-${index}`;
      const itemArtifacts = artifacts.filter(artifact => item.sourceCollectionIds?.includes(artifact.id));
      return `<article class="notes-all-ticket gallery-archive-item" style="--notes-ticket-clip:url(#${clipId})" data-status="${item.status}" role="link" tabindex="0" aria-label="进入展览：${escapeHtml(item.title)}" data-action="gallery-all-open" data-index="${item.index}">
        <svg class="notes-all-ticket__outline" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true"><defs><clipPath id="${clipId}" clipPathUnits="objectBoundingBox"><path transform="scale(.001 .0025)" d="M18 0 H602 C602 24 638 24 638 0 H982 Q982 18 1000 18 V382 Q982 382 982 400 H638 C638 376 602 376 602 400 H18 Q18 382 0 382 V18 Q18 18 18 0 Z"/></clipPath></defs><path d="M18 1 H602 C602 25 638 25 638 1 H982 Q982 18 999 18 V382 Q982 382 982 399 H638 C638 375 602 375 602 399 H18 Q18 382 1 382 V18 Q18 18 18 1 Z"/></svg>
        ${galleryArchiveCollageMarkup(itemArtifacts, item.index)}
        <div class="notes-all-ticket__info"><p class="gallery-archive-item__eyebrow"><span>私人展览 · ${item.number}</span><span class="gallery-ticket-status"><i aria-hidden="true"></i>${galleryArchiveStatusLabel(item.status)}</span></p><h3>${escapeHtml(item.title)}</h3><blockquote>“${escapeHtml((item.epigraph || []).join(""))}”</blockquote><div class="gallery-archive-item__facts"><span>${String(item.sourceCollectionIds?.length || 0).padStart(2, "0")} 件收藏</span><span>${escapeHtml(String(item.rooms))} 个章节</span></div><button type="button" data-action="gallery-all-open" data-index="${item.index}" aria-label="查看《${escapeHtml(item.title)}》完整票面">查看完整票面 <b>↗</b></button></div>
      </article>`;
    }).join("")}</div>` : `<div class="gallery-archive-empty"><span>○</span><h2>没有匹配的展览</h2><button data-action="gallery-all-reset">清除筛选</button></div>`}
  </section>`;
}

function galleryAllOverlayTemplate() {
  if (!galleryAll.open) return "";
  return `<div class="gallery-all-overlay" role="dialog" aria-modal="true" aria-label="全部展览"><div class="gallery-all-modal"><button class="inbox-all-close gallery-all-close" data-action="close-gallery-all" aria-label="关闭全部展览"><span aria-hidden="true">✕</span></button>${galleryAllTemplate()}</div></div>`;
}

function openGalleryAllOverlay() {
  if (LIGHT_PRESENTATION) { switchLightPage("gallery"); return; }
  if (document.querySelector(".gallery-all-overlay")) return;
  galleryAll.open = true;
  document.body.classList.add("gallery-all-open");
  app.insertAdjacentHTML("beforeend", galleryAllOverlayTemplate());
  requestAnimationFrame(() => {
    mountGalleryAllFormaTextPressure();
    bindSpecular();
  });
}

function closeGalleryAllOverlay() {
  galleryAll.open = false;
  galleryAll.menuOpen = false;
  if (galleryAllFormaTextPressureCleanup) { galleryAllFormaTextPressureCleanup(); galleryAllFormaTextPressureCleanup = null; }
  document.body.classList.remove("gallery-all-open");
  document.querySelector(".gallery-all-overlay")?.remove();
}

function refreshGalleryAllOverlay({ focusSearch = false } = {}) {
  const modal = document.querySelector(".gallery-all-modal");
  if (!modal) return;
  const scrollTop = modal.scrollTop;
  if (galleryAllFormaTextPressureCleanup) { galleryAllFormaTextPressureCleanup(); galleryAllFormaTextPressureCleanup = null; }
  modal.innerHTML = `<button class="inbox-all-close gallery-all-close" data-action="close-gallery-all" aria-label="关闭全部展览"><span aria-hidden="true">✕</span></button>${galleryAllTemplate()}`;
  modal.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    mountGalleryAllFormaTextPressure();
    bindSpecular();
    if (focusSearch) document.getElementById("gallery-all-search")?.focus();
  });
}

const homeTicketZineArtwork = {
  "cave-space": "./assets/demo/cave-space.png",
  "hermes-desktop": "./assets/demo/hermes-desktop.png",
  "cowork-setup": "./assets/demo/cowork-setup.png",
  "content-system": "./assets/demo/content-system.png",
  "local-agents": "./assets/demo/local-agents.png",
  "human-ai-trust": "./assets/demo/human-ai-trust.png",
};

function homeTicketArtifacts() {
  return state().collections.map(item => ({
    id: item.id, title: item.title, image: item.thumbnail || item.image || "", sourceImage: item.thumbnail || item.image || "",
    source: item.source, type: typeLabel(item.type), duration: "",
    summary: state().extractions.find(entry => entry.collectionId === item.id)?.summary || "", quote: "", label: typeLabel(item.type), url: item.url || "",
  }));
}

function homeGalleryTickets(showIndex = homeGalleryRound, exhibitionId = null) {
  const exhibitions = [...(state().liveExhibitions || [])].reverse();
  const exhibition = exhibitionId ? exhibitions.find(item => item.id === exhibitionId) : exhibitions[Math.max(0, Number(showIndex) || 0) % exhibitions.length];
  if (!exhibition && exhibitionId) return [`<p class="home-empty-copy">这场展览已不在当前空间中。</p>`];
  if (!exhibition) return [`<div class="home-empty-copy light-gallery-empty"><p>你的第一场展览，会从一次喜欢开始。</p><button class="capture-plus" data-action="live-ai-panel">看看收藏与整理进度 ↗</button></div>`];
  const number = String(exhibitions.indexOf(exhibition) + 1).padStart(3, "0");
  const count = exhibition.sourceCollectionIds?.length || exhibition.items?.length || 0;
  return [`<article class="home-gallery-card home-gallery-ticket is-featured is-overview light-private-ticket">
    <div class="home-ticket-stub" aria-hidden="true"><span class="home-ticket-stamp"><small>私人展览</small><strong>${number}</strong></span><span class="home-ticket-serial">私人展览 · ${escapeHtml((exhibition.createdAt || "").slice(0, 10))}</span><i class="home-ticket-barcode"></i></div>
    <div class="home-gallery-mesh light-ticket-monogram" aria-hidden="true">${escapeHtml([...exhibition.title][0] || "展")}</div>
    <div class="home-ticket-poster"><span>私人展览 · ${number}</span><h3>${escapeHtml(exhibition.title)}</h3><p>由 ${count} 件真实收藏共同形成</p></div>
    <div class="home-ticket-info"><span>${exhibition.status === "needs_review" ? "待核对草稿" : "私人展览预览"} · ${number}</span><h4>${escapeHtml(exhibition.title)}</h4><p>${escapeHtml(exhibition.curatorial_note?.text || "")}</p><div class="home-ticket-facts"><span><small>收藏来源</small><strong><b>${count}</b><em> 件收藏</em></strong></span><span><small>展览章节</small><strong><b>${exhibition.rooms?.length || 0}</b><em> 个章节</em></strong></span></div><button type="button" data-action="live-exhibition" data-exhibition-id="${escapeHtml(exhibition.id)}">打开这场展览 <b>↗</b></button></div>
  </article>`];
}

function openRecapTicket(exhibitionId) {
  if (document.querySelector(".recap-ticket-overlay")) return;
  recapTicketReturnElement = document.activeElement;
  recapTicketExhibitionId = exhibitionId || exhibitionFixture.id;
  recapTicketReturnContext = null;

  app.insertAdjacentHTML("beforeend", `<div class="recap-ticket-overlay is-notes-recap" role="dialog" aria-modal="true" aria-label="回顾展览票面"><button type="button" class="recap-ticket-close" data-action="close-recap-ticket" aria-label="关闭票面">×</button><div class="recap-ticket-stage">${homeGalleryTickets(0, recapTicketExhibitionId).join("")}</div></div>`);
  document.body.classList.add("recap-ticket-open");
  mountGalleryElasticHover();
  document.querySelector(".recap-ticket-close")?.focus();
}

function openGalleryPreviewTicket(showIndex) {
  if (document.querySelector(".recap-ticket-overlay")) return;
  recapTicketReturnElement = document.activeElement;
  recapTicketExhibitionId = `gallery-preview:${showIndex}`;
  recapTicketReturnContext = LIGHT_PRESENTATION ? "workspace" : "gallery-all";
  closeGalleryAllOverlay();
  app.insertAdjacentHTML("beforeend", `<div class="recap-ticket-overlay is-gallery-preview" role="dialog" aria-modal="true" aria-label="展览完整票面"><button type="button" class="recap-ticket-close" data-action="close-recap-ticket" aria-label="关闭票面并返回全部展览">×</button><div class="recap-ticket-stage">${homeGalleryTickets(showIndex).join("")}</div></div>`);
  document.body.classList.add("recap-ticket-open");
  mountGalleryElasticHover();
  document.querySelector(".recap-ticket-close")?.focus();
}

function closeRecapTicket({ restore = true, immediate = false } = {}) {
  const surface = document.querySelector(".recap-ticket-overlay");
  if (LIGHT_PRESENTATION && surface && !immediate) {
    const id = recapTicketExhibitionId;
    void closeGlassOverlay(surface, () => { if (recapTicketExhibitionId === id) closeRecapTicket({ restore, immediate: true }); }); return;
  }
  const restoreGalleryAll = restore && recapTicketReturnContext === "gallery-all";
  recapTicketExhibitionId = null;
  recapTicketReturnContext = null;
  document.body.classList.remove("recap-ticket-open");
  document.querySelector(".recap-ticket-overlay")?.remove();
  if (galleryElasticCleanup) galleryElasticCleanup();
  mountGalleryElasticHover();
  if (restoreGalleryAll) openGalleryAllOverlay();
  else if (restore && LIGHT_PRESENTATION && recapTicketReturnElement?.isConnected) recapTicketReturnElement.focus({ preventScroll: true });
  recapTicketReturnElement = null;
}

function homeRecordDate(record) {
  const value = new Date(record?.updatedAt || record?.createdAt || Date.now());
  if (Number.isNaN(value.getTime())) return "日期待补";
  return value.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).replaceAll("/", ".");
}

// 记录卡使用与 Gallery 一致的「艺术化 zine 图」：按原图文件名或藏品 id 找到对应的生成图。
function zineArtworkForSource(src) {
  if (!src) return "";
  const key = String(src).split("/").pop().replace(/\.[^.]+$/, "");
  return homeTicketZineArtwork[key] || "";
}

function homeRecordImage(record) {
  const source = Array.isArray(record?.images) && record.images[0] ? record.images[0] : "";
  if (PRIVATE_WORKSPACE) {
    const exhibition = state().liveExhibitions?.find(item => item.id === record.exhibitionId);
    const collection = state().collections.find(item => exhibition?.sourceCollectionIds?.includes(item.id) && (item.thumbnail || item.image));
    return source || collection?.thumbnail || collection?.image || `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="#dce3d3"/><text x="300" y="225" text-anchor="middle" font-family="serif" font-size="90" fill="#8c9b7d">Folio</text></svg>')}`;
  }
  return zineArtworkForSource(source)
    || homeTicketZineArtwork[record.exhibitionId]
    || (record.exhibitionId === exhibitionFixture.id ? homeTicketZineArtwork[exhibitionFixture.sourceCollectionIds[0]] : "")
    || source
    || homeTicketZineArtwork["cave-space"]
    || "./assets/demo/cave-space.png";
}

function exhibitionRecordGroups(records, notes = state().exhibitionNotes) {
  const groups = new Map();
  const ensure = (item) => {
    if (!groups.has(item.exhibitionId)) groups.set(item.exhibitionId, {
      exhibitionId: item.exhibitionId,
      exhibitionTitle: item.exhibitionTitle || "未命名展览",
      updatedAt: item.updatedAt || item.createdAt,
      thoughts: [],
    });
    return groups.get(item.exhibitionId);
  };
  records.forEach((record) => {
    const group = ensure(record);
    group.updatedAt = record.updatedAt || record.createdAt || group.updatedAt;
    group.thoughts.push({ id: record.id, type: "personal", label: "你写下的思考", content: record.content || "只留下了图片。", image: homeRecordImage(record), createdAt: record.updatedAt || record.createdAt });
  });
  notes.forEach((note) => {
    const group = ensure(note);
    const item = collectionById(note.exhibitId);
    const image = note.kind === "image" ? note.content : PRIVATE_WORKSPACE ? (note.image || item?.thumbnail || item?.image || homeRecordImage(note)) : (homeTicketZineArtwork[note.exhibitId] || note.image || item?.thumbnail || item?.image || "./assets/demo/cave-space.png");
    const content = note.kind === "image" ? (note.comment || "一张来自展廊的图片。") : [note.content, note.comment].filter(Boolean).join("\n");
    group.updatedAt = String(note.createdAt || "") > String(group.updatedAt || "") ? note.createdAt : group.updatedAt;
    group.thoughts.push({ id: note.id, type: "saved-note", kind: note.kind, label: `保存至 Note · ${note.exhibitTitle || "展览藏品"}`, content: content || "保存了一件仍想继续观看的藏品。", image, createdAt: note.createdAt });
  });
  return [...groups.values()]
    .map((group) => ({ ...group, thoughts: group.thoughts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function notesAllCollageMarkup(artifacts, offset = 0) {
  const images = artifacts.filter((item) => item.image);
  const rotated = images.length ? images.map((_, index) => images[(index + offset) % images.length]) : [];
  const representatives = rotated.slice(0, 6);
  const count = Math.min(6, Math.max(3, representatives.length));
  return `<div class="notes-all-ticket__collage is-count-${count}" aria-hidden="true">${representatives.map((item, index) => `<figure class="is-item-${index + 1}"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" /></figure>`).join("")}</div>`;
}

function galleryArchiveCollageMarkup(artifacts, exhibitionIndex = 0) {
  const { hero, evidence } = ticketOverviewImages(artifacts, exhibitionIndex);
  if (!hero) return `<div class="notes-all-ticket__collage gallery-archive-collage" aria-hidden="true"></div>`;
  return `<div class="notes-all-ticket__collage gallery-archive-collage" aria-hidden="true">
    <figure class="gallery-archive-collage__hero"><img src="${escapeHtml(hero.image)}" alt="" loading="lazy" /></figure>
    <div class="gallery-archive-collage__strip">${evidence.map((item) => `<figure><img src="${escapeHtml(item.image)}" alt="" loading="lazy" /></figure>`).join("")}</div>
  </div>`;
}

function ticketOverviewImages(artifacts, exhibitionIndex = 0) {
  const images = artifacts.filter((item) => item.image);
  if (!images.length) return { hero: null, evidence: [] };
  const preferredHeroIndexes = [0, 3, 4, 5];
  const heroIndex = (preferredHeroIndexes[exhibitionIndex] ?? exhibitionIndex) % images.length;
  return {
    hero: images[heroIndex],
    evidence: Array.from({ length: Math.min(4, Math.max(0, images.length - 1)) }, (_, index) => images[(heroIndex + index + 1) % images.length]),
  };
}

let notesAllRenderedColumns = 0;
function notesArchiveColumnCount() {
  const width = Math.min(1670, window.innerWidth - 68);
  return Math.max(2, Math.min(6, Math.floor((width + 18) / 278)));
}

function notesAllArchiveTemplate() {
  const records = [...state().exhibitionRecords].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const allThoughts = exhibitionRecordGroups(records).flatMap((group) => group.thoughts.map((thought) => ({ ...thought, exhibitionId: group.exhibitionId, exhibitionTitle: group.exhibitionTitle, updatedAt: thought.createdAt || group.updatedAt })));
  const query = notesAllFilters.query.trim().toLowerCase();
  const tagRules = [["责任", /责任|承担|兜底/], ["边界", /边界|退后|克制/], ["判断", /判断|选择|决定/], ["系统", /系统|自动|能力/], ["可见性", /可见|显形|感知/], ["方法", /方法|流程|执行/], ["灵感", /灵感|生长/], ["主体", /主体|自己|人/]];
  const monthKey = (thought) => { const date = new Date(thought.updatedAt); return Number.isNaN(date.getTime()) ? "日期待补" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; };
  const taggedThoughts = allThoughts.map((thought) => ({ ...thought, tags: tagRules.filter(([, pattern]) => pattern.test(thought.content || "")).map(([tag]) => tag).slice(0, 3) }));
  const allMonths = [...new Set(allThoughts.map(monthKey))].sort().reverse();
  const allThemes = [...new Set(taggedThoughts.flatMap((thought) => thought.tags))];
  const thoughts = taggedThoughts.filter((thought) => {
    return (notesAllFilters.month === "all" || monthKey(thought) === notesAllFilters.month)
      && (notesAllFilters.theme === "all" || thought.tags.includes(notesAllFilters.theme))
      && (!query || [thought.content, thought.exhibitionTitle, ...(thought.tags || [])].join(" ").toLowerCase().includes(query));
  }).sort((a, b) => {
    if (notesAllFilters.sort === "oldest") return String(a.updatedAt).localeCompare(String(b.updatedAt));
    if (notesAllFilters.sort === "title") return String(a.exhibitionTitle).localeCompare(String(b.exhibitionTitle), "zh-CN");
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  const columnCount = notesArchiveColumnCount();
  notesAllRenderedColumns = columnCount;
  const lanes = Array.from({ length: columnCount }, () => []);
  thoughts.forEach((thought, index) => lanes[index % lanes.length].push({ thought, index }));
  const sourceCount = new Set(allThoughts.map((thought) => thought.exhibitionId)).size;
  const thoughtDate = (thought) => { const date = new Date(thought.updatedAt); return Number.isNaN(date.getTime()) ? { day: "--", weekday: "" } : { day: String(date.getDate()).padStart(2, "0"), weekday: new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date) }; };
  return `<section class="notes-all-archive">
    <div class="inbox-discovery notes-all-discovery">
      <header class="forme-head">
        <button class="icon-btn" data-action="notes-all-focus-search" aria-expanded="${notesAllFilters.searchOpen}" aria-label="搜索手记"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.35-4.35"/></svg></button>
        <button class="forme-head-title" data-action="notes-all-reset" aria-label="Folio · 重置全部手记"><h1 data-text-pressure="1">Folio</h1><p>让喜欢，慢慢成形。</p></button>
        <div class="forme-head-actions"><button class="icon-btn" data-action="notes-all-menu" aria-expanded="${notesAllFilters.menuOpen}" aria-label="手记筛选与排序"><span aria-hidden="true">≡</span></button></div>
      </header>
      ${notesAllFilters.searchOpen || notesAllFilters.query ? `<div class="discovery-bar"><span class="discovery-glyph" aria-hidden="true">⌕</span><label class="sr-only" for="notes-all-search">搜索手记</label><input id="notes-all-search" class="discovery-search" type="search" autocomplete="off" placeholder="搜索想法、句子或主题…" value="${escapeHtml(notesAllFilters.query)}"/><span class="discovery-shortcut" aria-hidden="true"><kbd>⌘</kbd><kbd>K</kbd></span><button class="discovery-clear" data-action="notes-all-focus-search" aria-label="收起搜索"><span aria-hidden="true">✕</span></button></div>` : ""}
      ${notesAllFilters.menuOpen ? `<div class="explore-panel explore-panel--categories notes-all-explore" role="dialog" aria-label="筛选与排序手记">
        <section><p>记录日期</p><div>${[["all", "全部日期"], ...allMonths.map((month) => [month, `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`])].map(([value, label]) => `<button data-action="notes-all-month" data-value="${value}" class="${notesAllFilters.month === value ? "is-active" : ""}" aria-pressed="${notesAllFilters.month === value}"><span>${label}</span></button>`).join("")}</div></section>
        <section><p>笔记主题</p><div>${[["all", "全部主题"], ...allThemes.map((theme) => [theme, theme])].map(([value, label]) => `<button data-action="notes-all-theme" data-value="${value}" class="${notesAllFilters.theme === value ? "is-active" : ""}" aria-pressed="${notesAllFilters.theme === value}"><span>${label}</span></button>`).join("")}</div></section>
        <section><p>排列方式</p><div>${[["newest", "最近写下"], ["oldest", "最早写下"], ["title", "按来源"]].map(([value, label]) => `<button data-action="notes-all-sort" data-value="${value}" class="${notesAllFilters.sort === value ? "is-active" : ""}" aria-pressed="${notesAllFilters.sort === value}"><span>${label}</span><i aria-hidden="true">${notesAllFilters.sort === value ? "↓" : ""}</i></button>`).join("")}</div></section>
      </div>` : ""}
    </div>
    <div class="notes-all-stats-row"><div><button type="button" class="notes-all-back" data-action="close-notes-all">← 返回</button><span>手记数 <b>${String(allThoughts.length).padStart(2, "0")}</b><i aria-hidden="true">·</i> 来自 <b>${String(sourceCount).padStart(2, "0")}</b> 场展览${thoughts.length === allThoughts.length ? "" : ` <em>· 显示 ${thoughts.length} 条</em>`}</span></div><small>思考档案</small></div>
    <div class="notes-all-main">
      ${thoughts.length ? `<div class="thought-editorial-grid" style="--notes-columns:${columnCount}" aria-label="全部思考手记">${lanes.map((entries, laneIndex) => `<div class="thought-lane thought-lane--${laneIndex + 1}">${entries.map(({ thought, index }) => { const date = thoughtDate(thought); const month = monthKey(thought); const media = ["image", "video"].includes(thought.kind) && thought.image ? { kind: thought.kind, image: thought.image, label: thought.kind === "video" ? "视频笔记" : "图片笔记" } : null; return `<article class="thought-entry${index === 0 ? " is-lead" : ""}${media ? ` is-media is-${media.kind}` : ""}">${media ? `<figure class="thought-entry__media"><img src="${escapeHtml(media.image)}" alt="${escapeHtml(media.label)}" loading="lazy" />${media.kind === "video" ? `<span class="thought-entry__play" aria-hidden="true">▶</span>` : ""}<figcaption>${escapeHtml(media.label)}</figcaption></figure>` : ""}<div class="thought-entry__date"><span>手记 ${String(index + 1).padStart(2, "0")}</span><time datetime="${escapeHtml(String(thought.updatedAt).slice(0, 10))}">${month.replace("-", ".")}.${date.day} · ${date.weekday}</time></div><blockquote>${escapeHtml(thought.content || "一条仍在形成的想法。")}</blockquote><div class="thought-entry__tags">${(thought.tags || []).map((tag) => `<button type="button" data-action="notes-all-tag" data-value="${escapeHtml(tag)}" class="${notesAllFilters.query === tag ? "is-active" : ""}" aria-pressed="${notesAllFilters.query === tag}">#${escapeHtml(tag)}</button>`).join("")}</div><button class="thought-entry__source" type="button" data-action="notes-all-open-exhibition" data-exhibition-id="${escapeHtml(thought.exhibitionId || "")}">源自《${escapeHtml(thought.exhibitionTitle)}》 <span>↗</span></button></article>`; }).join("")}</div>`).join("")}</div>` : `<div class="notes-all-empty"><span>○</span><h3>没有匹配的想法</h3><p>换一个关键词，或清除当前筛选。</p><button type="button" data-action="notes-all-clear-search">清除筛选</button></div>`}
    </div>
  </section>`;
}

function refreshNotesAllArchive({ focusSearch = false } = {}) {
  const archive = document.querySelector(".notes-all-archive");
  if (!archive) return;
  const modal = archive.closest(".notes-all-modal");
  const scrollTop = modal?.scrollTop || 0;
  if (notesAllFormaTextPressureCleanup) { notesAllFormaTextPressureCleanup(); notesAllFormaTextPressureCleanup = null; }
  archive.outerHTML = notesAllArchiveTemplate();
  if (modal) modal.scrollTop = scrollTop;
  requestAnimationFrame(mountNotesAllFormaTextPressure);
  if (focusSearch) {
    const input = document.getElementById("notes-all-search");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function notesAllOverlayTemplate() {
  return `<div class="notes-all-overlay" role="dialog" aria-modal="true" aria-label="全部思考手记"><div class="notes-all-modal"><button class="notes-all-close" data-action="close-notes-all" aria-label="关闭全部思考手记">✕</button>${notesAllArchiveTemplate()}</div></div>`;
}

function openNotesAllOverlay(source = null) {
  if (document.querySelector(".notes-all-overlay")) return;
  notesAllReturnScrollTop = window.scrollY;
  notesAllReturnElement = source;
  notesAllOpen = true;
  notesAllFilters.query = "";
  notesAllFilters.sort = "newest";
  notesAllFilters.month = "all";
  notesAllFilters.theme = "all";
  notesAllFilters.menuOpen = false;
  notesAllFilters.searchOpen = false;
  document.body.classList.add("notes-all-open");
  app.insertAdjacentHTML("beforeend", notesAllOverlayTemplate());
  requestAnimationFrame(mountNotesAllFormaTextPressure);
}

function closeNotesAllOverlay() {
  const returnScrollTop = notesAllReturnScrollTop;
  const returnElement = notesAllReturnElement?.isConnected ? notesAllReturnElement : document.querySelector('[data-action="notes-all"]');
  notesAllOpen = false;
  notesAllFilters.menuOpen = false;
  if (notesAllFormaTextPressureCleanup) { notesAllFormaTextPressureCleanup(); notesAllFormaTextPressureCleanup = null; }
  notesAllReturnScrollTop = null;
  notesAllReturnElement = null;
  document.body.classList.remove("notes-all-open");
  document.querySelector(".notes-all-overlay")?.remove();
  if (returnScrollTop !== null) {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo({ top: returnScrollTop, behavior: "auto" });
    requestAnimationFrame(() => { document.documentElement.style.scrollBehavior = previousScrollBehavior; });
  }
  returnElement?.focus({ preventScroll: true });
}

function homeRecordTimelineMarkup(records) {
  if (records.length < 2) return "";
  const times = records.map((record) => {
    const value = new Date(record?.updatedAt || record?.createdAt || Date.now()).getTime();
    return Number.isNaN(value) ? Date.now() : value;
  });
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  const spread = newest - oldest;
  const nodes = records.map((record, index) => {
    // 最新在左、最旧在右，与卡片排列同向；时间间隔越大，节点间距越大。
    const pct = spread > 0 ? 2 + (96 * (newest - times[index])) / spread : 2 + (96 * index) / (records.length - 1);
    return `<button class="home-record-timeline__node" data-pct="${pct.toFixed(2)}" style="left:${pct.toFixed(2)}%" data-timeline-index="${index}" aria-label="跳到 ${homeRecordDate(record)} · ${escapeHtml(record.exhibitionTitle)}"><i aria-hidden="true"></i><time>${homeRecordDate(record)}</time></button>`;
  }).join("");
  return `<div class="home-record-timeline" data-home-record-timeline role="group" aria-label="此前记录时间线">
    <span class="home-record-timeline__rail" aria-hidden="true"></span>
    <span class="home-record-timeline__fill" aria-hidden="true"></span>
    <span class="home-record-timeline__head" aria-hidden="true"></span>
    ${nodes}
  </div>`;
}

function homeRecordsMarkup(records) {
  const groups = exhibitionRecordGroups(records).slice(0, 3);
  if (!groups.length) {
    return `<div class="home-notes-empty">
      <p>最近记录</p>
      <h3>还没有观展记录</h3>
      <blockquote>完整看完一场展览后，可以把仍在回响的部分留在这里。</blockquote>
      <button class="home-record-open" data-action="gallery">去个人展览看展 <b>→</b></button>
    </div>`;
  }

  return `<div class="home-notes-records home-record-editorial">
    <div class="home-record-editorial__track" aria-label="最近三条想法">
      ${groups.map((group, index) => {
        const thought = group.thoughts[0];
        return `<article class="home-record-editorial__item" data-record-group="${escapeHtml(group.exhibitionId)}" data-thought-index="0">
          <figure><img src="${escapeHtml(thought.image)}" alt="${escapeHtml(group.exhibitionTitle)}关联藏品" loading="${index ? "lazy" : "eager"}" /></figure>
          <div class="home-record-editorial__meta"><time>${homeRecordDate(group)}</time></div>
          <h3>${escapeHtml(group.exhibitionTitle)}</h3><p class="home-record-editorial__source">${escapeHtml(thought.label)}</p><blockquote>${escapeHtml(thought.content)}</blockquote>
          <footer class="${group.thoughts.length > 1 ? "" : "is-single"}">${group.thoughts.length > 1 ? `<button type="button" data-action="other-thought" data-exhibition="${escapeHtml(group.exhibitionId)}">别的思考 <span>1 / ${group.thoughts.length}</span> →</button>` : ""}<button class="home-record-liquid-button" type="button" data-action="open-recap-ticket" data-exhibition="${escapeHtml(group.exhibitionId)}"><span>回顾展览</span></button></footer>
        </article>`;
      }).join("")}
    </div>
  </div>`;
}

function showOtherThought(button) {
  const card = button.closest("[data-record-group]");
  const records = [...state().exhibitionRecords].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const group = exhibitionRecordGroups(records).find((entry) => entry.exhibitionId === button.dataset.exhibition);
  if (!card || !group || group.thoughts.length < 2) return;
  const index = (Number(card.dataset.thoughtIndex || 0) + 1) % group.thoughts.length;
  const thought = group.thoughts[index];
  card.dataset.thoughtIndex = String(index);
  const image = card.querySelector("figure img");
  if (image) { image.src = thought.image; image.alt = `${group.exhibitionTitle}关联藏品`; }
  const source = card.querySelector(".home-record-editorial__source");
  const quote = card.querySelector("blockquote");
  if (source) source.textContent = thought.label;
  if (quote) quote.textContent = thought.content;
  const counter = button.querySelector("span");
  if (counter) counter.textContent = `${index + 1} / ${group.thoughts.length}`;
  card.classList.remove("is-thought-changing");
  requestAnimationFrame(() => card.classList.add("is-thought-changing"));
}
function inboxTemplate() {
  if (LIGHT_PRESENTATION) return lightWorkspace.renderWorkspace({ state: state(), galleryItems: galleryArchiveItems(), artwork: homeTicketZineArtwork })
    + inboxAllOverlayTemplate() + galleryAllOverlayTemplate() + (notesAllOpen ? notesAllOverlayTemplate() : "") + captureOverlayTemplate();
  const { collections, extractions } = state();
  const directions = collections.length >= 3 ? computeInboxInsights(collections, extractions, 5) : [];
  const recommendationRow = directions.length
    ? directions.map((direction, index) => recommendCircularCard(direction, index, collections, extractions)).join("")
    : `<p class="home-empty-copy">收藏达到 3 条后，系统会在这里浮现正在形成的方向。</p>`;
  const galleryCards = homeGalleryTickets();
  const transitionConceptImages = [
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg?width=640",
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg?width=640",
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/Meisje_met_de_parel.jpg?width=640",
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg?width=640",
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/The_Great_Wave_off_Kanagawa.jpg?width=640",
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg?width=640",
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/Caspar_David_Friedrich_-_Wanderer_above_the_sea_of_fog.jpg?width=640",
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/Claude_Monet%2C_Impression%2C_soleil_levant.jpg?width=640",
    "https://images.unsplash.com/photo-1494232410401-ad00d5433cfa?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1524650359799-842906ca1c06?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1513364776144-60967b0f800f?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1577083552431-6e5fd01aa342?auto=format&fit=crop&w=640&q=82",
    "https://images.unsplash.com/photo-1561214115-f2f134cc4912?auto=format&fit=crop&w=640&q=82",
  ];
  const transitionItems = Array.from({ length: LIGHT_PRESENTATION ? 0 : 20 }, (_, index) => ({
    title: collections[index]?.title || "灵感收藏",
    thumbnail: transitionConceptImages[index % transitionConceptImages.length],
  }));
  const transitionArtifacts = transitionItems.map((item, index) => `<figure class="home-transition-artifact home-transition-artifact--${index + 1}" aria-hidden="true">
    ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="eager" />` : `<span>${escapeHtml([...item.title][0] || "藏")}</span>`}
  </figure>`).join("");
  const records = [...state().exhibitionRecords].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const recordsMarkup = homeRecordsMarkup(records);
  const currentState = state();
  const completedExhibitionIds = new Set([
    ...currentState.exhibitions.filter((item) => item.completed).map((item) => item.id),
    ...currentState.exhibitionRecords.map((item) => item.exhibitionId).filter((id) => id && id !== "scroll-final-note"),
  ]);
  const usedCollectionIds = new Set(
    (currentState.liveExhibitions || []).flatMap((item) => item.sourceCollectionIds || [])
  );
  if (completedExhibitionIds.has(exhibitionFixture.id)) exhibitionFixture.sourceCollectionIds.forEach((id) => usedCollectionIds.add(id));
  const waitingCollectionCount = currentState.collections.filter((item) => !usedCollectionIds.has(item.id)).length;
  const colophonDate = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .format(new Date())
    .toUpperCase();

  return `<div class="home-scroll">
    <nav class="home-line-sidebar" aria-label="页面章节">
      <div class="home-directory-intro" aria-hidden="true">
        <p class="home-directory-title">Your<br/>Personal<br/>Exhibition</p>
        <p class="home-directory-description">What you keep,<br/><em>takes shape.</em></p>
      </div>
      <div class="home-directory-links">
        <a href="#top" data-nav="home" aria-label="返回开场"><em>Home</em><i aria-hidden="true"></i><span aria-hidden="true">I</span></a>
        <a href="#inbox" data-nav="inbox" aria-label="前往 Inbox"><em>Inbox</em><i aria-hidden="true"></i><span aria-hidden="true">II</span></a>
        <a href="#gallery" data-nav="gallery" aria-label="前往个人展览"><em>Gallery</em><i aria-hidden="true"></i><span aria-hidden="true">III</span></a>
        <a href="#notes" data-nav="records" aria-label="前往 Notes"><em>Notes</em><i aria-hidden="true"></i><span aria-hidden="true">IV</span></a>
      </div>
    </nav>
    <section class="home-hero" id="top" data-home-section="home">
      <div class="home-hero-copy">
        <h1>WHAT YOU KEEP,<br/><em>TAKES SHAPE.</em></h1>
      </div>
      ${LIGHT_PRESENTATION ? `<button class="home-scroll-cue light-home-enter" data-action="inbox"><span>OPEN YOUR COLLECTION</span><i>↗</i></button>` : `<div class="home-scroll-cue" data-home-scroll-cue><span>SCROLL TO ENTER</span><i>↓</i></div>`}
    </section>

    ${LIGHT_PRESENTATION ? "" : `<section class="home-transition-copy" data-home-transition-copy aria-label="从首页进入收藏">
      <div class="home-transition-stage">
        <div class="home-transition-artifacts" aria-hidden="true">${transitionArtifacts}</div>
        <p><span>GATHERED.</span><span>CONNECTED.</span><span>DISTILLED.</span></p>
      </div>
    </section>`}

    <section class="home-section home-inbox" id="inbox" data-home-section="inbox">
      <div class="home-intro-grid">${scrollFloatHeading(["散落的收藏，在这里渐成脉络。"])}<div><div class="home-inbox-actions"><button class="capture-plus specular" data-action="inbox-all"><span aria-hidden="true">↗</span><b>查看全部</b></button><button class="capture-plus specular" data-action="toggle-capture" aria-expanded="${inboxFilters.captureOpen}"><span aria-hidden="true">＋</span><b>收新</b></button></div></div></div>
      <div class="home-recommend-head"><span class="shiny-text">RECOMMENDED</span></div>
      <div class="home-recommend-row recommend-gallery-shell">
        <button class="recommend-nav prev" data-action="recommend-prev" aria-label="向左浏览推荐"><span aria-hidden="true">‹</span></button>
        <div class="recommend-gallery home-recommend-gallery" data-recommend-gallery tabindex="0" role="region" aria-label="推荐内容，可左右拖动或使用方向键浏览">${recommendationRow}</div>
        <button class="recommend-nav next" data-action="recommend-next" aria-label="向右浏览推荐"><span aria-hidden="true">›</span></button>
      </div>
    </section>

    <section class="home-section home-gallery" id="gallery" data-home-section="gallery">
      <div class="home-gallery-intro">
        <h2>收藏之间，新的展览正在发生。</h2>
        <button type="button" class="capture-plus specular home-gallery-all" data-action="gallery-all"><span aria-hidden="true">↗</span><b>查看全部</b></button>
      </div>
      <div class="home-gallery-kicker">
        <div class="home-scroll-velocity" data-scroll-velocity aria-label="ON VIEW">
          <div class="home-scroll-velocity__track" data-scroll-velocity-track aria-hidden="true">
            <div class="home-scroll-velocity__group" data-scroll-velocity-group>${Array(6).fill("<span>ON VIEW</span>").join("")}</div>
            <div class="home-scroll-velocity__group">${Array(6).fill("<span>ON VIEW</span>").join("")}</div>
          </div>
        </div>
      </div>
      <div class="home-gallery-grid" data-home-gallery-grid aria-live="polite">${galleryCards.join("")}</div>
      ${state().liveExhibitions?.length > 1 ? `<div class="home-gallery-under-ticket"><button class="home-corner-action home-gallery-shuffle" data-action="shuffle-home-gallery"><span>更多展览</span></button></div>` : ""}
    </section>

    <section class="home-section home-notes" id="notes" data-home-section="records">
      <div class="home-notes-intro"><h2>观展结束后，你留下的思考</h2><button type="button" class="capture-plus specular home-notes-all" data-action="notes-all"><span aria-hidden="true">↗</span><b>查看全部</b></button></div>
      ${recordsMarkup}
      <div class="home-writing" data-home-writing aria-hidden="${LIGHT_PRESENTATION ? "false" : "true"}">
        <article class="home-colophon" data-home-colophon aria-label="你的 Folio 使用状态与产品理念">
          <header class="home-colophon__header">
            <h2>你的 Folio，<span>目前</span></h2>
          </header>
          <dl class="home-colophon__metrics">
            <div><dt>${String(currentState.collections.length).padStart(2, "0")}</dt><dd>份收藏</dd></div>
            <div><dt>${String(completedExhibitionIds.size).padStart(2, "0")}</dt><dd>场个人展览</dd></div>
            <div><dt>${String(records.length).padStart(2, "0")}</dt><dd>条想法</dd></div>
          </dl>
          ${waitingCollectionCount
            ? `<p class="home-colophon__waiting">还有 ${waitingCollectionCount} 份材料，等待下一次相遇。</p>`
            : ""}
          <div class="home-colophon__belief">
            <div class="home-colophon__belief-copy">
              <span>收藏不是终点，理解也不必一次完成。</span>
              <span>Folio 从你留下的材料中寻找联系，<br/>把散落的兴趣暂时组织成展览。</span>
            </div>
            <blockquote>让收藏被重新理解，<br/>也让理解沉淀为你的一部分。</blockquote>
          </div>
          <div class="home-colophon__stamp" aria-hidden="true"><span class="home-colophon__stamp-brand">Folio</span><b>存档</b><span class="home-colophon__stamp-caption">ARCHIVE</span></div>
          <footer><span>Folio · 私人展览 CURATOR</span><span>EXHIBITION NO. ${String(Math.max(1, completedExhibitionIds.size)).padStart(3, "0")} · ${colophonDate}</span></footer>
        </article>
      </div>
    </section>
  </div>
  ${inboxAllOverlayTemplate()}
  ${galleryAllOverlayTemplate()}
  ${notesAllOpen ? notesAllOverlayTemplate() : ""}
  ${captureOverlayTemplate()}`;
}

function captureOverlayTemplate() {
  if (!inboxFilters.captureOpen) return "";
  return `<div class="capture-overlay" role="dialog" aria-modal="true" aria-label="收一条新的">
    <div class="capture-modal">
      <header class="capture-head">
        <div><span class="capture-eyebrow">留住一次喜欢</span><h3>收一条新的</h3><p class="capture-description">把值得留下的先收好，慢慢看见它的意义。</p></div>
        <button class="btn capture-close" data-variant="ghost" data-size="icon-sm" data-action="close-capture" aria-label="关闭"><span aria-hidden="true">✕</span></button>
      </header>
      <div class="capture-modes" role="tablist" aria-label="收藏类型">
        ${[["link", "网页"], ["text", "文字"], ["image", "图片"]].map(([mode, label]) => `<button type="button" class="capture-mode${captureDraft.mode === mode ? " is-active" : ""}" data-action="capture-mode" data-mode="${mode}" role="tab" tabindex="${captureDraft.mode === mode ? 0 : -1}" aria-selected="${captureDraft.mode === mode}">${label}</button>`).join("")}
      </div>
      <form class="capture-body" data-form="capture" data-capture-mode="${captureDraft.mode}">
        <input type="hidden" name="mode" value="${captureDraft.mode}" />
        <div class="capture-pane capture-pane-link">
          <input class="input" id="capture-input" name="content" type="text" autocomplete="off" aria-label="粘贴网页链接" placeholder="粘贴公开文章或普通网页的链接…" value="${escapeHtml(captureDraft.link)}" />
          <p class="capture-tip">支持公开网页正文。视频平台／小红书自动采集暂未开放，可切换到文字粘贴正文或文字稿。</p>
        </div>
        <div class="capture-pane capture-pane-text">
          <textarea class="textarea" id="capture-text" name="content" rows="4" aria-label="输入文字" placeholder="写下或粘贴一段文字、一闪而过的想法…">${escapeHtml(captureDraft.text)}</textarea>
          <p class="capture-tip">粘贴正文、想法或视频文字稿（至少 20 个字符），策展人会整理摘要和要点。</p>
        </div>
        <div class="capture-pane capture-pane-image">
          <div class="capture-drop${captureDraft.image ? " has-image" : ""}" id="capture-drop" tabindex="0" role="button" aria-label="选择或粘贴图片">
            ${captureDraft.image ? `<img src="${captureDraft.image}" alt="待收藏的图片预览"/>` : '<span class="drop-glyph" aria-hidden="true">▣</span><p>拖入图片，或 <kbd>⌘V</kbd> 粘贴</p>'}
          </div>
          <input id="capture-file" type="file" accept="image/*" hidden />
          <p class="capture-tip">策展人会识别图片中可见的内容，整理成可核对的理解。</p>
        </div>
        <div class="capture-foot">
          <span>先收好，再慢慢理解。</span>
          <button type="submit" class="btn capture-submit" data-size="sm">收进来&nbsp;<span aria-hidden="true">↗</span></button>
        </div>
      </form>
    </div>
  </div>`;
}

function inboxAllOverlayTemplate() {
  if (inboxView.mode !== "all") return "";
  return `<div class="inbox-all-overlay" role="dialog" aria-modal="true" aria-label="我的收藏"><div class="inbox-all-modal"><button class="inbox-all-close" data-action="close-inbox-all" aria-label="关闭我的收藏"><span aria-hidden="true">✕</span></button>${inboxAllTemplate()}</div></div>`;
}

// 首页弹层采用局部挂载，避免全量 render() 重建背景 Canvas 并闪回第 0 帧。
function openInboxAllOverlay() {
  if (document.querySelector(".inbox-all-overlay")) return;
  inboxAllReturnScrollTop = window.scrollY;
  inboxView.mode = "all";
  document.body.classList.add("inbox-all-open");
  app.insertAdjacentHTML("beforeend", inboxAllOverlayTemplate());
  updateNavigation();
  requestAnimationFrame(() => {
    applyInboxFilters();
    layoutCollectionGrid();
    mountInboxInfiniteLoad();
    mountInboxGrainient();
    mountInboxFormaTextPressure();
    bindSpecular();
  });
}

function closeInboxAllOverlay() {
  const returnScrollTop = inboxAllReturnScrollTop;
  inboxAllReturnScrollTop = null;
  inboxView.mode = "home";
  document.body.classList.remove("inbox-all-open");
  if (inboxGrainientCleanup) { inboxGrainientCleanup(); inboxGrainientCleanup = null; }
  if (inboxInfiniteCleanup) inboxInfiniteCleanup();
  if (inboxFormaTextPressureCleanup) { inboxFormaTextPressureCleanup(); inboxFormaTextPressureCleanup = null; }
  document.querySelector(".inbox-all-overlay")?.remove();
  updateNavigation();
  if (returnScrollTop !== null) {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo({ top: returnScrollTop, behavior: "auto" });
    requestAnimationFrame(() => { document.documentElement.style.scrollBehavior = previousScrollBehavior; });
  }
}

function refreshInboxAllOverlay() {
  const modal = document.querySelector(".inbox-all-modal");
  if (!modal) return false;
  const scrollTop = modal.scrollTop;
  if (inboxGrainientCleanup) { inboxGrainientCleanup(); inboxGrainientCleanup = null; }
  if (inboxInfiniteCleanup) inboxInfiniteCleanup();
  if (inboxFormaTextPressureCleanup) { inboxFormaTextPressureCleanup(); inboxFormaTextPressureCleanup = null; }
  modal.innerHTML = `<button class="inbox-all-close" data-action="close-inbox-all" aria-label="关闭我的收藏"><span aria-hidden="true">✕</span></button>${inboxAllTemplate()}`;
  modal.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    applyInboxFilters();
    layoutCollectionGrid();
    mountInboxInfiniteLoad();
    mountInboxGrainient();
    mountInboxFormaTextPressure();
    bindSpecular();
  });
  return true;
}

function openCaptureOverlay(trigger = document.activeElement) {
  if (DESKTOP_WORKSPACE?.sampleURL) { location.assign(DESKTOP_WORKSPACE.sampleURL); return; }
  if (document.querySelector(".capture-overlay")) return;
  if (LIGHT_PRESENTATION) captureReturnElement = trigger;
  inboxFilters.captureOpen = true;
  inboxFilters.menuOpen = false;
  document.querySelectorAll('[data-action="toggle-capture"]').forEach((button) => button.setAttribute("aria-expanded", "true"));
  app.insertAdjacentHTML("beforeend", captureOverlayTemplate());
  requestAnimationFrame(() => {
    bindSpecular();
    focusCapturePane();
  });
}

function closeCaptureOverlay({ immediate = false } = {}) {
  const surface = document.querySelector(".capture-overlay");
  if (LIGHT_PRESENTATION && surface && !immediate) { void closeGlassOverlay(surface, () => closeCaptureOverlay({ immediate: true })); return; }
  inboxFilters.captureOpen = false;
  document.querySelector(".capture-overlay")?.remove();
  document.querySelectorAll('[data-action="toggle-capture"]').forEach((button) => button.setAttribute("aria-expanded", "false"));
  if (LIGHT_PRESENTATION) {
    const previous = captureReturnElement;
    requestAnimationFrame(() => {
      if (document.activeElement === document.body && !document.querySelector(".capture-overlay")) focusCaptureTrigger(previous);
    });
  }
}

function focusCaptureTrigger(previous) {
  const target = previous?.isConnected && previous !== document.body && previous.getClientRects().length
    ? previous : [...document.querySelectorAll('[data-action="toggle-capture"]')].find(button => button.getClientRects().length);
  target?.focus({ preventScroll:true });
}

let captureToastTimer;
function showCaptureToast(message) {
  let toast = document.querySelector(".forme-capture-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "forme-capture-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.append(toast);
  }
  toast.innerHTML = `<span aria-hidden="true">✓</span><span>${escapeHtml(message)}</span>`;
  clearTimeout(captureToastTimer);
  captureToastTimer = setTimeout(() => toast.remove(), 4500);
}

function collectionCard(item, extraction, index = 0, opts = {}) {
  const statusLabel = { ready: "可用", needs_input: "需补充", needs_confirmation: "需确认", processing: "理解中" }[item.status] ?? "处理中";
  const processing = item.status === "processing";
  const artwork = homeTicketZineArtwork[item.id] || item.thumbnail || "";
  const visual = artwork
    ? `<div class="collection-media${homeTicketZineArtwork[item.id] ? " is-zine" : ""}"><img src="${escapeHtml(artwork)}" alt="${escapeHtml(item.title)}" loading="lazy" /></div>`
    : "";
  const body = processing
    ? `<div class="collection-processing" role="status"><span class="forme-spinner" aria-hidden="true"></span><span>正在理解中<small>整理完成后会自动更新</small></span></div>`
    : extraction?.summary
    ? `<p>${escapeHtml(extraction.summary)}</p>${extraction.concepts?.length ? `<div class="concept-list">${extraction.concepts.map((concept) => `<span>${escapeHtml(concept)}</span>`).join("")}</div>` : ""}<details><summary>证据与可靠性</summary><p>${escapeHtml(extraction.evidence ?? "本地模拟器")} · ${Math.round(extraction.reliability * 100)}%${extraction.status === "needs_confirmation" ? " · 不进入自动策展" : ""}</p>${extraction.hint ? `<p class="extraction-hint">${escapeHtml(extraction.hint)}</p>` : ""}</details>`
    : `<p>${extraction?.hint ? escapeHtml(extraction.hint) : "本地模拟器不会根据单条未知输入生成完整主题；请补充更多上下文。"}</p>`;
  const tags = [...(extraction?.tags || []), ...(extraction?.concepts || [])];
  return `<article class="collection-card card-${index % 4} ${artwork ? "" : "is-text-only"} ${processing ? "is-processing" : ""} ${opts.insight ? "is-insight" : ""}" data-action="open-collection" data-collection-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" data-source="${escapeHtml(item.source)}" data-type="${escapeHtml(item.type)}" data-status="${item.status}" data-tags="${tags.map((tag) => escapeHtml(tag)).join("|").toLowerCase()}" data-concepts="${(extraction?.concepts || []).map((concept) => escapeHtml(concept).toLowerCase()).join("|")}">${visual}<div class="collection-card-body"><header><span>${item.source} · ${item.type}</span><b class="status-pill status-${item.status}">${statusLabel}</b></header>${opts.insight ? `<span class="insight-mark" aria-label="属于浮现方向">✦</span>` : ""}<h2>${escapeHtml(item.title)}</h2>${body}</div></article>`;
}

function reliabilityLevel(extraction) {
  const r = extraction?.reliability ?? 0;
  const dots = Math.max(0, Math.min(4, Math.round(r * 4)));
  if (!extraction || extraction.status === "needs_input" || dots <= 1) {
    return { label: "证据不足", cls: "none", dots: 0, impact: "不进入自动策展；等待你补充文字稿、摘录或上下文。", impactCls: "muted" };
  }
  if (dots >= 4) return { label: "证据充分", cls: "high", dots: 4, impact: "策展人的理解有多处原文支撑，已参与自动策展评估。", impactCls: "ok" };
  if (dots >= 3) return { label: "证据较充分", cls: "mid", dots: 3, impact: "证据基本完整，已参与自动策展评估（权重正常）。", impactCls: "ok" };
  return { label: "证据一般", cls: "low", dots: 2, impact: "部分内容缺失或识别有误差，参与策展但权重较低。", impactCls: "warn" };
}
function collectionModal() {
  const { collections, extractions } = state();
  const item = collections.find((entry) => entry.id === state().ui.collectionId);
  if (!item) return "";
  const extraction = extractions.find((entry) => entry.collectionId === item.id);
  const review = state().feedback[`understanding:${item.id}`] || {};
  const statusLabel = { ready: "可用", needs_input: "需补充", needs_confirmation: "需确认", processing: "处理中" }[item.status] ?? "处理中";
  const extractedTags = [...new Set([...(extraction?.tags || []), ...(extraction?.concepts || [])])];
  const tags = Array.isArray(review.acceptedTags) ? review.acceptedTags : extractedTags;
  const meta = provenance[item.id];
  const level = reliabilityLevel(extraction);
  const evidenceCount = (extraction?.evidence || "").split(/[·、]/).filter((s) => s.trim()).length;
  const directionTag = state().ui.collectionTag;
  const members = state().ui.collectionMembers || [];
  const directionBlock = directionTag && members.length
    ? `<div class="detail-direction"><p class="eyebrow">来自正在浮现的方向</p><h3>「${escapeHtml(directionTag)}」</h3><div class="detail-direction-members">${members.map((id) => { const member = collections.find((entry) => entry.id === id); return member ? `<button data-action="open-collection" data-collection-id="${escapeHtml(member.id)}">${escapeHtml(member.title)}</button>` : ""; }).join("")}</div></div>`
    : "";
  const related = extractions
    .filter((ex) => ex.collectionId !== item.id && ex.tags?.length)
    .map((ex) => {
      const other = collections.find((c) => c.id === ex.collectionId);
      if (!other) return null;
      const shared = (ex.tags || []).filter((t) => (extraction?.tags || []).includes(t)).length;
      return shared > 0 ? { other, shared } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 4);
  const relatedBlock = related.length
    ? `<p class="related-title">与你收藏的其他内容相连</p><div class="related-row">${related.map(({ other, shared }) => `<button class="related-card" data-action="open-collection" data-collection-id="${escapeHtml(other.id)}">${other.thumbnail ? `<img src="${other.thumbnail}" alt="" loading="lazy" />` : `<span class="related-glyph" aria-hidden="true">${other.type.includes("video") ? "▶" : "✎"}</span>`}<span><b>${escapeHtml(other.title)}</b><small>${shared} 条共同线索</small></span></button>`).join("")}</div>`
    : "";
  const exhibitionRooms = exhibitionFixture.rooms.filter((room) => room.exhibits.some((ex) => ex.id === item.id));
  const exhibitionBlock = exhibitionRooms.length
    ? `<p class="exhibition-ref"><span aria-hidden="true">◈</span> 已进入展览《${escapeHtml(exhibitionFixture.title)}》 · 环境 ${exhibitionRooms.map((room) => `${room.number} ${escapeHtml(room.title)}`).join(" / ")}</p>`
    : "";
  const note = state().notes?.[item.id] ?? "";
  const media = item.thumbnail
    ? `<img src="${item.thumbnail}" alt="${escapeHtml(item.title)}" />`
    : `<div class="generated-visual visual-1" aria-hidden="true"><i></i><i></i><span>${item.type.includes("video") ? "▶" : "✎"}</span></div>`;
  return `<div class="collection-modal">
    <button class="collection-modal-close" data-action="close-collection" aria-label="关闭"><span aria-hidden="true">✕</span></button>
    <div class="collection-modal-media">${media}</div>
    <div class="collection-modal-body">
      <header><span>${escapeHtml(item.source)} · ${typeLabel(item.type)}</span><b class="status-pill status-${escapeHtml(item.status)}">${statusLabel}</b></header>
      <h1>${escapeHtml(item.title)}</h1>
      <p class="detail-summary">${extraction?.summary ? escapeHtml(extraction.summary) : "系统还没有足够信息理解这条收藏。"}</p>
      ${extraction?.concepts?.length ? `<div class="concept-list">${extraction.concepts.map((concept) => `<span>${escapeHtml(concept)}</span>`).join("")}</div>` : ""}
      <section class="detail-section">
        <p class="eyebrow">来源与出处</p>
        <div class="source-rows">
          <div class="source-row"><span>媒体</span><b>${escapeHtml(meta?.duration ?? (item.type === "image_note" ? "图文" : "视频"))}</b></div>
          ${meta?.caption ? `<div class="source-row"><span>内容来源</span><b>${escapeHtml(meta.caption)}</b></div>` : ""}
          ${meta?.fetchedBy ? `<div class="source-row"><span>采集方式</span><b>${escapeHtml(meta.fetchedBy)}</b></div>` : ""}
        </div>
        ${item.url ? `<a class="source-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">查看原文 <span aria-hidden="true">↗</span></a>` : ""}
      </section>
      <section class="detail-section">
        <p class="eyebrow">内容理解 · 可靠性</p>
        <div class="reliability-head">
          <b class="reliability-label ${level.cls}">${level.label}</b>
          <div class="reliability-meter" data-level="${level.cls}" role="img" aria-label="可靠性：${level.label}">${Array.from({ length: 4 }, (_, i) => `<i class="${i < level.dots ? "on" : ""}"></i>`).join("")}</div>
        </div>
        <p class="reliability-reason">依据 · ${escapeHtml(meta?.caption ?? "本地模拟器")}${evidenceCount ? ` · ${evidenceCount} 处证据定位` : ""}${extraction?.evidence ? `（${escapeHtml(extraction.evidence)}）` : ""}</p>
        <p class="curation-impact ${level.impactCls}">${level.impact}</p>
        ${extraction?.quote ? `<blockquote class="detail-quote">“${escapeHtml(extraction.quote)}”<cite>${escapeHtml(extraction.quoteAt ?? "")}</cite></blockquote>` : ""}
        ${extraction?.hint ? `<p class="extraction-hint">${escapeHtml(extraction.hint)}</p>` : ""}
      </section>
      <section class="detail-section">
        <p class="eyebrow">关系网络</p>
        ${tags.length ? `<div class="detail-tags"><p class="related-title">线索标签</p><div class="concept-list">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div></div>` : ""}
        ${directionBlock}
        ${relatedBlock}
        ${exhibitionBlock}
      </section>
      <section class="detail-note">
        <p class="eyebrow">我的备注</p>
        <textarea data-note-text placeholder="写下一句关于这条收藏的想法…">${escapeHtml(note)}</textarea>
        <div class="note-actions">
          <button class="note-save" data-action="save-note">保存备注</button>
          <span class="note-status" data-note-status>${note ? "已保存" : ""}</span>
        </div>
      </section>
      <p class="detail-meta">收于 ${new Date(item.addedAt).toLocaleDateString("zh-CN")}${item.status === "needs_input" ? " · 等待补充上下文" : ""}</p>
    </div>
  </div>`;
}

function collectionImmersiveTemplate() {
  return collectionGlassDialogTemplate();
  /* Legacy cinematic detail markup is intentionally kept below for now so its
     data helpers remain easy to compare while the new dialog is validated. */
  const { collections, extractions } = state();
  const item = collections.find((entry) => entry.id === state().ui.collectionId);
  if (!item) return inboxTemplate();
  const extraction = extractions.find((entry) => entry.collectionId === item.id);
  const reviewKey = `understanding:${item.id}`;
  const review = state().feedback[reviewKey] || {};
  const reviewDecision = review.userSelected ? review.decision : null;
  const meta = provenance[item.id];
  const level = reliabilityLevel(extraction);
  const tags = [...new Set([...(extraction?.tags || []), ...(extraction?.concepts || [])])];
  const statusLabel = { ready: "可用", needs_input: "需补充", needs_confirmation: "需确认", processing: "处理中" }[item.status] ?? "处理中";
  const evidenceCount = (extraction?.evidence || "").split(/[·、]/).filter((part) => part.trim()).length;
  const note = state().notes?.[item.id] ?? "";
  const category = state().collectionCategories?.[item.id] || "";
  const directionTag = state().ui.collectionTag;
  const directionMembers = (state().ui.collectionMembers || [])
    .map((id) => collections.find((entry) => entry.id === id))
    .filter(Boolean);
  const related = extractions
    .filter((entry) => entry.collectionId !== item.id && entry.tags?.length)
    .map((entry) => {
      const other = collections.find((candidate) => candidate.id === entry.collectionId);
      if (!other) return null;
      const shared = (entry.tags || []).filter((tag) => (extraction?.tags || []).includes(tag)).length;
      return shared ? { other, shared } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 4);
  const ordered = [...collections].sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  const currentIndex = ordered.findIndex((entry) => entry.id === item.id);
  const nextItem = ordered.length > 1 ? ordered[(currentIndex + 1) % ordered.length] : null;
  const exhibitionRooms = exhibitionFixture.rooms.filter((room) => room.exhibits.some((exhibit) => exhibit.id === item.id));
  const sourceWord = String(item.source || "ARCHIVE").toUpperCase();
  const summary = extraction?.summary || "系统还没有足够信息理解这条收藏。";
  const image = item.thumbnail ? escapeHtml(item.thumbnail) : "";
  const visual = (className, eager = false) => image
    ? `<img class="${className}" src="${image}" alt="" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} />`
    : `<div class="${className} collection-immersive__generated" aria-hidden="true"><i></i><i></i><span>${item.type.includes("video") ? "▶" : "✎"}</span></div>`;
  const relatedBlock = related.length
    ? `<div class="collection-immersive__related-grid">${related.map(({ other, shared }) => `<button class="collection-immersive__related" data-action="open-collection" data-collection-id="${escapeHtml(other.id)}">${other.thumbnail ? `<img src="${escapeHtml(other.thumbnail)}" alt="" loading="lazy" />` : `<span aria-hidden="true">${other.type.includes("video") ? "▶" : "✎"}</span>`}<span><small>${shared} 条共同线索</small><b>${escapeHtml(other.title)}</b></span><i aria-hidden="true">↗</i></button>`).join("")}</div>`
    : `<p class="collection-immersive__quiet">还没有足够清晰的关联。新的收藏进入后，关系会在这里浮现。</p>`;
  const directionBlock = directionTag && directionMembers.length
    ? `<aside class="collection-immersive__direction"><p class="eyebrow">正在浮现的方向</p><h3>「${escapeHtml(directionTag)}」</h3><div>${directionMembers.map((member) => `<button data-action="open-collection" data-collection-id="${escapeHtml(member.id)}">${escapeHtml(member.title)}</button>`).join("")}</div></aside>`
    : "";

  return `<article class="collection-immersive" style="--detail-progress:0;--spot-x:50%;--spot-y:46%;--final-spot-x:50%;--final-spot-y:50%">
    <nav class="collection-immersive__nav" aria-label="藏品浏览">
      <button class="collection-immersive__back" data-action="close-collection"><span aria-hidden="true">←</span> 返回遗落之地</button>
      <span class="collection-immersive__index">收藏 ${String(Math.max(0, currentIndex) + 1).padStart(2, "0")} / ${String(ordered.length).padStart(2, "0")}</span>
    </nav>

    <section class="collection-immersive__sequence" aria-labelledby="collection-immersive-title">
      <div class="collection-immersive__hero">
        <div class="collection-immersive__grid" aria-hidden="true"></div>
        <div class="collection-immersive__base" aria-hidden="true">${visual("collection-immersive__image collection-immersive__image--base", true)}</div>
        <div class="collection-immersive__reveal" aria-hidden="true">${visual("collection-immersive__image collection-immersive__image--reveal", true)}</div>
        <div class="collection-immersive__hero-shade" aria-hidden="true"></div>

        <div class="collection-immersive__object" aria-hidden="true">
          <div class="collection-immersive__card-base">${visual("collection-immersive__card-image")}</div>
          <div class="collection-immersive__card-reveal">${visual("collection-immersive__card-image collection-immersive__card-image--reveal")}</div>
          <div class="collection-immersive__card-lines"><i></i><i></i><i></i><i></i></div>
          <span class="collection-immersive__card-source">${escapeHtml(sourceWord)}</span>
          <span class="collection-immersive__card-mark">Folio</span>
        </div>

        <div class="collection-immersive__hero-copy">
          <div class="collection-immersive__hero-main">
            <p class="collection-immersive__badge"><i aria-hidden="true"></i>${escapeHtml(item.source)} · ${typeLabel(item.type)} · ${statusLabel}</p>
            ${collectionCategoryEditorMarkup(item.id, category)}
            <h1 id="collection-immersive-title">${escapeHtml(item.title)}</h1>
            <div class="collection-immersive__hero-actions"><button data-action="detail-scroll">观看它如何浮现</button></div>
          </div>
          <div class="collection-immersive__hero-summary"><p>${escapeHtml(summary)}</p></div>
        </div>

        <div class="collection-immersive__final-copy">
          <div class="collection-immersive__final-heading"><p class="eyebrow">重新看见</p><h2>被照见，<br />才开始形成。</h2></div>
          <div class="collection-immersive__final-summary"><p>${escapeHtml(summary)}</p>${tags.length ? `<div>${tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}</div>
          <p class="collection-immersive__final-title">${escapeHtml(item.title)}</p>
          <button class="collection-immersive__more" data-action="detail-more" aria-expanded="false"><span aria-hidden="true">＋</span> 档案详情</button>
        </div>
        <div class="collection-immersive__scroll-cue" aria-hidden="true"><span></span><b>向下阅读</b></div>
      </div>
    </section>

    <section class="collection-immersive__finale" id="collection-archive" aria-labelledby="collection-archive-title">
      <header class="collection-immersive__archive-heading"><p class="eyebrow">收藏档案</p><h2 id="collection-archive-title">${escapeHtml(item.title)}</h2></header>
      <div class="collection-immersive__archive" data-detail-archive>
        <div class="collection-immersive__archive-column">
          <p class="eyebrow">来源与出处</p>
          <dl>
            <div><dt>媒体</dt><dd>${escapeHtml(meta?.duration ?? typeLabel(item.type))}</dd></div>
            ${meta?.caption ? `<div><dt>内容来源</dt><dd>${escapeHtml(meta.caption)}</dd></div>` : ""}
            ${meta?.fetchedBy ? `<div><dt>采集方式</dt><dd>${escapeHtml(meta.fetchedBy)}</dd></div>` : ""}
            <div><dt>收藏时间</dt><dd>${new Date(item.addedAt).toLocaleDateString("zh-CN")}</dd></div>
          </dl>
          <div class="collection-immersive__reliability">
            <span>内容理解 · 可靠性</span><b class="reliability-label ${level.cls}">${level.label}</b>
            <div class="reliability-meter" data-level="${level.cls}" role="img" aria-label="可靠性：${level.label}">${Array.from({ length: 4 }, (_, i) => `<i class="${i < level.dots ? "on" : ""}"></i>`).join("")}</div>
            <p>${escapeHtml(meta?.caption ?? "本地内容理解")}${evidenceCount ? ` · ${evidenceCount} 处证据定位` : ""}</p>
            <p class="curation-impact ${level.impactCls}">${level.impact}</p>
          </div>
          ${extraction?.quote ? `<blockquote class="detail-quote">“${escapeHtml(extraction.quote)}”<cite>${escapeHtml(extraction.quoteAt ?? "")}</cite></blockquote>` : ""}
          ${extraction?.evidence ? `<p class="collection-immersive__evidence-copy"><span>证据定位</span>${escapeHtml(extraction.evidence)}</p>` : ""}
          ${item.url ? `<a class="source-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">查看原文 <span aria-hidden="true">↗</span></a>` : ""}
        </div>
        <div class="collection-immersive__archive-column">
          <p class="eyebrow">关系网络</p>
          ${tags.length ? `<div class="concept-list">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
          ${directionBlock}
          ${relatedBlock}
          ${exhibitionRooms.length ? `<p class="exhibition-ref"><span aria-hidden="true">◈</span> 已进入展览《${escapeHtml(exhibitionFixture.title)}》 · ${exhibitionRooms.map((room) => `${room.number} ${escapeHtml(room.title)}`).join(" / ")}</p>` : ""}
        </div>
        <section class="detail-note collection-immersive__note">
          <p class="eyebrow">我的备注</p>
          <textarea data-note-text placeholder="写下一句关于这条收藏的想法…">${escapeHtml(note)}</textarea>
          <div class="note-actions"><button class="note-save" data-action="save-note">保存备注</button><span class="note-status" data-note-status>${note ? "已保存" : ""}</span></div>
        </section>
      </div>
      ${nextItem ? `<button class="collection-immersive__next" data-action="open-collection" data-collection-id="${escapeHtml(nextItem.id)}"><span>下一件收藏</span><b>${escapeHtml(nextItem.title)}</b><i aria-hidden="true">→</i></button>` : ""}
    </section>
  </article>`;
}

function collectionGlassFrame(item, ordered, body, briefing = false) {
  const currentIndex = Math.max(0, ordered.findIndex((entry) => entry.id === item.id));
  const previous = ordered.length > 1 ? ordered[(currentIndex - 1 + ordered.length) % ordered.length] : null;
  const next = ordered.length > 1 ? ordered[(currentIndex + 1) % ordered.length] : null;
  const frozenUnderlay = collectionLiveModal ? "" : collectionUnderlaySnapshot?.html
    ? `<div class="collection-glass-underlay__frame" style="height:${collectionUnderlaySnapshot.height}px;transform:translate3d(0,-${collectionUnderlaySnapshot.scrollTop}px,0)">${collectionUnderlaySnapshot.html}</div>`
    : inboxAllTemplate();
  const underlay = collectionLiveModal ? "" : `<div class="collection-glass-underlay" aria-hidden="true">${frozenUnderlay}</div>`;
  const navigation = `
    <button type="button" data-action="close-collection"><span aria-hidden="true">←</span> 返回我的收藏</button>
    <span>收藏 ${String(currentIndex + 1).padStart(2, "0")} / ${String(ordered.length).padStart(2, "0")}</span>
    <div>${previous ? `<button type="button" data-action="open-collection" data-collection-id="${escapeHtml(previous.id)}" aria-label="上一条">‹</button>` : ""}${next ? `<button type="button" data-action="open-collection" data-collection-id="${escapeHtml(next.id)}" aria-label="下一条">›</button>` : ""}</div>`;
  const nav = `<nav class="collection-glass__nav">${briefing ? `<div class="collection-briefing-nav">${navigation}</div>` : navigation}</nav>`;
  return `${underlay}<div class="collection-glass-overlay" role="dialog" aria-modal="true" aria-labelledby="collection-glass-title">
    <article class="collection-glass${briefing ? " collection-glass--briefing" : ""}">
      ${briefing ? "" : nav}
      <div class="collection-glass__content">${briefing ? nav : ""}${body}</div>
    </article>
  </div>`;
}

function collectionTagsMarkup(tags) {
  return `<div>${tags.map(tag => `<span class="collection-glass__tag"><span class="collection-glass__tag-label">${escapeHtml(tag)}</span><button type="button" class="collection-glass__tag-remove" data-action="remove-collection-tag" data-tag="${escapeHtml(tag)}" aria-label="删除标签：${escapeHtml(tag)}"><i aria-hidden="true">×</i></button></span>`).join("")}<button type="button" class="collection-glass__add-tag" data-action="add-collection-tag" aria-expanded="false"><span aria-hidden="true">＋</span>添加线索</button></div>`;
}

function collectionNoteMarkup(collectionId, note, title) {
  return `<section class="collection-glass__note"><div><h2>${title}</h2></div><div><textarea data-note-text aria-label="收藏想法" placeholder="写下一句想留给自己的话…">${escapeHtml(note)}</textarea><div class="note-actions"><button type="button" data-action="save-note">保存想法</button><span data-note-status role="status">${collectionNoteDrafts.has(collectionId) ? "未保存" : note ? "已保存" : ""}</span></div></div></section>`;
}

function folioCollectionDetail(item, ordered, tags, note, understandingState) {
  const cover = item.thumbnail || item.image || "";
  const headline = ["article", "web", "link"].includes(item.type) ? collectionHeadline(item) : item.title;
  const publishedAt = typeof item.publishedAt === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(item.publishedAt) ? item.publishedAt.slice(0, 10) : "";
  const date = new Date(publishedAt || item.addedAt || "");
  const dateLabel = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", {
    year:"numeric", month:"long", day:"numeric", ...(publishedAt ? { timeZone:"UTC" } : {}),
  }).format(date) : "";
  let external = null;
  try {
    const url = new URL(item.url);
    if (["http:", "https:"].includes(url.protocol)) external = url;
  } catch { /* A local text or image can have no external source. */ }
  const sourceName = item.publisher || (external && item.source === "网页" ? external.hostname : item.source) || typeLabel(item.type);
  const mediaSource = ["image", "image_note", "video", "video_note"].includes(item.type);
  const thumbnail = cover ? `<img class="collection-briefing-cover" src="${escapeHtml(cover)}" alt="${mediaSource && item.type.startsWith("image") ? "收藏的图片" : ""}" decoding="async" referrerpolicy="no-referrer" />` : "";
  const aiEnabled = state().desktopCapabilities?.aiEnabled;
  const canRefresh = external && typeof liveAI.refreshSource === "function";
  const canRetry = understandingState.canRetry && typeof liveAI.retry === "function";
  return collectionGlassFrame(item, ordered, `
    <header class="collection-briefing-header">
      <div class="collection-briefing-identity">
        <div class="collection-briefing-meta"><strong>${escapeHtml(sourceName)}</strong>${dateLabel ? `<time datetime="${escapeHtml(publishedAt || date.toISOString())}">${publishedAt ? "" : "收藏于 "}${escapeHtml(dateLabel)}</time>` : ""}${external ? `<a class="collection-briefing-external" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">打开原网页 <span aria-hidden="true">↗</span></a>` : ""}</div>
        <h1 id="collection-glass-title"${headline !== item.title ? ` title="${escapeHtml(item.title)}"` : ""}>${escapeHtml(headline)}</h1>
      </div>
      ${mediaSource ? thumbnail : ""}
    </header>
    <div class="collection-glass__reading collection-briefing-reader" data-collection-reading></div>
    <footer class="collection-briefing-tools">
      ${WORKSPACE_CHAT_AVAILABLE ? `<button type="button" class="ws-detail-chat" data-workspace-chat-collection="${escapeHtml(item.id)}">${lightWorkspace.icon("chat")}和 Tag 聊聊这条收藏${lightWorkspace.icon("arrow")}</button>` : ""}
      <details class="collection-briefing-manage"><summary>收藏管理</summary>
        <div class="collection-briefing-actions">
          <button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-action="live-ai-panel">查看处理记录</button>
          ${canRefresh ? `<button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-action="refresh-live-source" data-collection-id="${escapeHtml(item.id)}" ${understandingState.loading || aiEnabled === false ? "disabled" : ""}>重新读取原网页</button>` : ""}
          ${canRetry ? `<button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-action="retry-live-collection" data-collection-id="${escapeHtml(item.id)}">继续整理收藏</button>` : ""}
        </div>
        ${mediaSource ? "" : thumbnail}
        <section class="collection-glass__ideas"><h2>线索</h2>${collectionTagsMarkup(tags)}</section>
      </details>
    </footer>
    ${collectionNoteMarkup(item.id, note, "我的收藏笔记")}
  `, true);
}

function collectionGlassDialogTemplate() {
  const { collections, extractions } = state();
  const item = collections.find((entry) => entry.id === state().ui.collectionId);
  if (!item) return inboxTemplate();
  const extraction = extractions.find((entry) => entry.collectionId === item.id);
  const review = state().feedback[`understanding:${item.id}`] || {};
  const understandingState = collectionUnderstandingState(item, extraction, { aiEnabled: state().desktopCapabilities?.aiEnabled, acceptedSummary: review.acceptedSummary });
  const ordered = [...collections].sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  const extractedTags = [...new Set([...(extraction?.tags || []), ...(extraction?.concepts || [])])];
  const tags = Array.isArray(review.acceptedTags) ? review.acceptedTags : extractedTags;
  const note = collectionNoteDrafts.get(item.id) ?? state().notes?.[item.id] ?? "";
  if (PRIVATE_WORKSPACE && item.live) return folioCollectionDetail(item, ordered, tags, note, understandingState);
  const originalContent = String(item.content || "").trim();
  const originalSummary = extraction?.summary || "系统还没有足够信息理解这条收藏。你可以补充一句真正重要的内容。";
  const summary = review.acceptedSummary || originalSummary;
  const isVideoSource = item.type === "video" || item.type === "video_note";
  const timelineTopics = [...new Set([...(extraction?.concepts || []), ...(extraction?.tags || [])])];
  const timelineSeconds = (raw) => {
    const parts = raw.split(":").map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  };
  const normalizeTimelineTime = (seconds) => {
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const ranges = [...String(extraction?.evidence || "").matchAll(/(\d{1,2}:\d{2}(?::\d{2})?)\s*[–—-]\s*(\d{1,2}:\d{2}(?::\d{2})?)/g)].slice(0, 4);
  const segmentCopy = (index) => {
    const first = timelineTopics[index % Math.max(1, timelineTopics.length)] || "核心观点";
    const second = timelineTopics[(index + 1) % Math.max(1, timelineTopics.length)] || "具体方法";
    const templates = [
      `这一段从实际使用场景切入，说明「${first}」如何与「${second}」共同解决具体问题。`,
      `作者通过操作过程进一步解释「${first}」，并展示它在「${second}」中的实际作用。`,
      `内容在这里拆解了「${first}」的关键步骤，同时说明「${second}」如何被检查和调整。`,
      `这一部分结合具体案例总结「${first}」，强调实践中仍需保留对「${second}」的判断。`,
      `视频随后回到整体工作流程，说明「${first}」与「${second}」如何形成可持续的方法。`,
      `最后一段归纳前面的做法，并给出围绕「${first}」和「${second}」继续实践的建议。`,
    ];
    let text = templates[index % templates.length];
    if (text.length < 30) text += "并补充了能够直接应用到日常工作的具体说明。";
    return text.slice(0, 50);
  };
  const videoTimeline = ranges.map((range, index) => ({
    start: normalizeTimelineTime(timelineSeconds(range[1])),
    end: normalizeTimelineTime(timelineSeconds(range[2])),
    text: segmentCopy(index),
    topic: timelineTopics[index % Math.max(1, timelineTopics.length)] || "内容重点",
  }));
  const articlePoints = [...new Set([...(extraction?.concepts || []), ...(extraction?.tags || [])])].slice(0, 4).map((topic, index) => {
    const verbs = ["内容的核心观点围绕", "正文进一步讨论了", "图文材料具体呈现了", "这条收藏也连接到"];
    return `${verbs[index] || "内容涉及"}「${topic}」。`;
  });
  const digestHighlights = (extraction?.digest?.highlights || [])
    .map((entry) => typeof entry === "string" ? { text: entry, locator: null } : { text: entry?.text, locator: entry?.locator || null })
    .filter((entry) => entry.text)
    .slice(0, 3);
  const fallbackHighlightTemplates = [
    (topic, next) => `内容重点解释「${topic}」如何作用于${next ? `「${next}」` : "实际场景"}。`,
    (topic, next) => `「${topic}」${next ? `与「${next}」共同` : "能够"}让过程更容易被看见和检查。`,
    (topic) => `围绕「${topic}」的具体方法仍需保留人的判断与调整。`,
  ];
  const fallbackHighlights = timelineTopics.slice(0, 3).map((topic, index) => ({
    text: fallbackHighlightTemplates[index](topic, timelineTopics[index + 1]),
    locator: isVideoSource && videoTimeline[index] ? `${videoTimeline[index].start}–${videoTimeline[index].end}` : null,
  }));
  const highlights = digestHighlights.length ? digestHighlights : item.live ? [] : fallbackHighlights;
  const digestOverview = extraction?.digest?.overview || summary;
  const breakdownSections = Array.isArray(extraction?.breakdown?.sections) ? extraction.breakdown.sections : [];
  const contentBreakdown = breakdownSections.length
    ? breakdownSections.flatMap((section, sectionIndex) => (section.points || []).map((point, pointIndex) => ({
        index: `${String(sectionIndex + 1).padStart(2, "0")}.${pointIndex + 1}`,
        title: point.title || section.title,
        explanation: point.explanation || "",
        locator: point.locator || section.locator || null,
      })))
    : isVideoSource && videoTimeline.length ? videoTimeline.map((row, index) => ({
        index: String(index + 1).padStart(2, "0"),
        title: `${row.topic}构成这一阶段的核心`,
        explanation: row.text,
        locator: `${row.start}–${row.end}`,
      })) : (articlePoints.length ? articlePoints : [extraction?.quote || extraction?.evidence || "系统根据正文、图片和来源信息整理了这段理解。"]).map((point, index) => ({
        index: String(index + 1).padStart(2, "0"),
        title: point.replace(/[。！？]$/, ""),
        explanation: index === 0 ? summary : "这一信息点来自正文与收藏线索的综合整理。",
        locator: null,
      }));
  const explicitBreakdownStatus = extraction?.breakdown?.status;
  const legacyArticleBreakdown = ["web", "text", "image_note", "article", "pdf"].includes(item.type) && contentBreakdown.length >= 2;
  const breakdownAvailable = item.live && !breakdownSections.length ? false : explicitBreakdownStatus
    ? ["full", "compact"].includes(explicitBreakdownStatus)
    : (isVideoSource ? videoTimeline.length > 0 : legacyArticleBreakdown);
  const related = extractions
    .filter((entry) => entry.collectionId !== item.id)
    .map((entry) => {
      const other = collections.find((candidate) => candidate.id === entry.collectionId);
      if (!other) return null;
      const shared = (entry.tags || []).filter((tag) => tags.includes(tag));
      return shared.length ? { other, shared } : null;
    })
    .filter(Boolean).sort((a, b) => b.shared.length - a.shared.length);
  const zineImage = homeTicketZineArtwork[item.id] || "";
  const detailImage = zineImage || item.thumbnail || item.image || "";
  const collectedDate = item.addedAt ? new Date(item.addedAt) : null;
  const collectedDateLabel = collectedDate
    ? `${collectedDate.getFullYear()} / ${String(collectedDate.getMonth() + 1).padStart(2, "0")} / ${String(collectedDate.getDate()).padStart(2, "0")} 收藏`
    : "收藏日期未知";
  const media = detailImage
    ? `<img src="${escapeHtml(detailImage)}" alt="${escapeHtml(item.title)}" decoding="async" referrerpolicy="no-referrer" />`
    : "";
  return collectionGlassFrame(item, ordered, `
        <header class="collection-glass__hero${detailImage ? "" : " is-text-only"}">
          <div class="collection-glass__identity"><div class="collection-glass__meta"><strong>${escapeHtml(item.source)}</strong><span>${typeLabel(item.type)}</span><i aria-hidden="true"></i><time>${escapeHtml(collectedDateLabel)}</time></div><h1 id="collection-glass-title">${escapeHtml(item.title)}</h1>${item.url ? `<div class="collection-glass__source-action"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><i aria-hidden="true">↗</i><span>在 ${escapeHtml(item.source)} 中打开</span></a></div>` : ""}</div>
          ${detailImage ? `<div class="collection-glass__media${zineImage ? " is-zine" : ""}">${media}${item.type.includes("video") ? `<i aria-hidden="true">▶</i>` : ""}</div>` : ""}
        </header>
        ${LIGHT_PRESENTATION && WORKSPACE_CHAT_AVAILABLE ? `<button type="button" class="ws-detail-chat" data-workspace-chat-collection="${escapeHtml(item.id)}">${lightWorkspace.icon("chat")}和 Tag 聊聊这条收藏${lightWorkspace.icon("arrow")}</button>` : ""}
        ${item.live ? `<div class="forme-live-detail-status">${escapeHtml(understandingState.statusMessage)}<button data-action="live-ai-panel">查看处理记录</button>${PRIVATE_WORKSPACE && item.url && typeof liveAI.refreshSource === "function" ? `<button data-action="refresh-live-source" data-collection-id="${escapeHtml(item.id)}" title="保留旧版来源，重新读取并理解当前网页" ${understandingState.loading || state().desktopCapabilities?.aiEnabled === false ? "disabled" : ""}>重新读取原文</button>` : ""}</div>` : ""}
        ${!understandingState.hasUnderstanding ? `<section class="collection-glass__pending" role="status">${understandingState.loading ? '<span class="forme-spinner" aria-hidden="true"></span>' : ""}<h2>${escapeHtml(understandingState.title)}</h2><p>${escapeHtml(understandingState.description)}</p><div class="collection-glass__state-actions">${understandingState.canRetry && PRIVATE_WORKSPACE && typeof liveAI.retry === "function" ? `<button type="button" class="ws-button" data-action="retry-live-collection" data-collection-id="${escapeHtml(item.id)}">继续整理</button>` : ""}${understandingState.needsInput && LIGHT_PRESENTATION && WORKSPACE_CHAT_AVAILABLE && state().desktopCapabilities?.aiEnabled !== false ? `<button type="button" class="ws-button" data-workspace-chat-collection="${escapeHtml(item.id)}">带上这条收藏，补充说明</button>` : ""}</div></section>` : `
        <section class="collection-glass__understanding">
          <div class="collection-glass__reading ${isVideoSource ? "is-video" : "is-article"}"><h2>我从这条收藏里看到了什么</h2>
            ${breakdownAvailable ? `<div class="collection-glass__tabs" role="tablist" aria-label="内容理解方式">
              <button role="tab" id="understanding-summary-tab" aria-controls="understanding-summary-panel" aria-selected="true" data-action="understanding-tab" data-value="summary">精华速览</button>
              <button role="tab" id="understanding-breakdown-tab" aria-controls="understanding-breakdown-panel" aria-selected="false" data-action="understanding-tab" data-value="breakdown" tabindex="-1">全文拆解</button>
            </div>` : ""}
            <div class="collection-glass__tab-panel${breakdownAvailable ? "" : " is-static"}" id="understanding-summary-panel" role="tabpanel" ${breakdownAvailable ? `aria-labelledby="understanding-summary-tab" data-understanding-tab-panel="summary"` : ""}>
              <p class="collection-glass__summary">${escapeHtml(digestOverview)}</p>
              ${highlights.length ? `<ol class="collection-glass__highlights${isVideoSource ? " is-timestamped" : ""}">${highlights.map((highlight, index) => `<li>${isVideoSource && highlight.locator ? `<a class="collection-glass__highlight-time" ${item.url ? `href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"` : ""}>${escapeHtml(highlight.locator)}<i aria-hidden="true">▶</i></a>` : `<span>${String(index + 1).padStart(2, "0")}</span>`}<p>${escapeHtml(highlight.text)}</p></li>`).join("")}</ol>` : `<p class="collection-glass__timeline-empty">当前内容较短，一句核心理解已经包含主要信息。</p>`}
            </div>
            ${breakdownAvailable ? `<div class="collection-glass__tab-panel" id="understanding-breakdown-panel" role="tabpanel" aria-labelledby="understanding-breakdown-tab" data-understanding-tab-panel="breakdown" hidden><ol class="collection-glass__breakdown-list">${contentBreakdown.map((point) => `<li><span>${escapeHtml(point.index)}</span><div><b>${escapeHtml(point.title)}</b>${point.explanation ? `<p>${escapeHtml(point.explanation)}</p>` : ""}${point.locator ? `<small>${escapeHtml(point.locator)}</small>` : ""}</div></li>`).join("")}</ol></div>` : ""}
          </div>
        </section>
        `}
        ${item.live && originalContent ? `<details class="collection-glass__original"><summary>${item.url ? "原始链接" : "原始文字"}</summary><p>${escapeHtml(originalContent)}</p></details>` : ""}
        <div class="collection-glass__middle">
          <section class="collection-glass__ideas"><h2>这条收藏与哪些想法有关</h2><div>${tags.length ? tags.map((tag) => `<span class="collection-glass__tag"><span class="collection-glass__tag-label">${escapeHtml(tag)}</span><button type="button" class="collection-glass__tag-remove" data-action="remove-collection-tag" data-tag="${escapeHtml(tag)}" aria-label="删除标签：${escapeHtml(tag)}"><i aria-hidden="true">×</i></button></span>`).join("") : "<small>还没有形成清晰线索</small>"}<button type="button" class="collection-glass__add-tag" data-action="add-collection-tag" aria-expanded="false"><span aria-hidden="true">＋</span>添加线索</button></div></section>
        </div>
        <section class="collection-glass__note"><div><h2>我为什么收藏它？</h2></div><div><textarea data-note-text aria-label="收藏想法" placeholder="写下吸引你的地方、你不同意的观点，或者以后想继续研究的问题……">${escapeHtml(note)}</textarea><div class="note-actions"><button data-action="save-note">保存想法</button><span data-note-status role="status">${collectionNoteDrafts.has(item.id) ? "未保存" : note ? "已保存" : ""}</span></div></div></section>
        <section class="collection-glass__related"><h2>你收藏的这些内容也在讨论相似的问题</h2><div data-related-scroll>${related.length ? related.map(({ other, shared }) => `<button data-action="open-collection" data-collection-id="${escapeHtml(other.id)}">${other.thumbnail ? `<img src="${escapeHtml(other.thumbnail)}" alt="" />` : ""}<span><b>${escapeHtml(other.title)}</b><small>都在讨论：${shared.slice(0, 2).map(escapeHtml).join("、")}</small></span><i>↗</i></button>`).join("") : `<p>还没有发现明显相关的收藏。新的联系会在这里出现。</p>`}</div></section>
  `);
}

function collectionViewTemplate() {
  if (!state().collections.some((entry) => entry.id === state().ui.collectionId)) return inboxTemplate();
  if (LIGHT_PRESENTATION) return collectionGlassDialogTemplate();
  return collectionImmersiveTemplate();
}

function gateResultsTemplate(task) {
  return `<details class="gate-panel dev-diagnostics"><summary>开发诊断信息 · 发布守卫</summary><div class="gate-list">${task.gates.map((gate) => `<div class="gate-row ${gate.passed ? "passed" : "failed"}"><b>${gate.id}</b><span>${gate.title}</span><p>${gate.detail}</p><em>${gate.passed ? "通过" : "待完善"}</em></div>`).join("")}</div></details>`;
}

function galleryExploreLabel(explore) {
  if (explore.dim === "concept") return `线索：${explore.value}`;
  if (explore.dim === "status") return `状态：${explore.value === "ready" ? "已就绪" : "正在形成"}`;
  return `${explore.dim}：${explore.value}`;
}
function renderGalleryExploreMenu(collections, extractions, ready, insight) {
  const ids = new Set(collections.map((item) => item.id));
  const tagCounts = new Map();
  for (const ex of extractions) { if (!ids.has(ex.collectionId)) continue; for (const tag of ex.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1); }
  const group = (title, rows) => rows.length ? `<div class="explore-group"><p>${title}</p>${rows.join("")}</div>` : "";
  const statusRows = [
    ...(ready ? [["ready", "已就绪", 1]] : []),
    ...(insight ? [["forming", "正在形成", 2]] : []),
  ].map(([value, label, n]) => `<button data-action="explore" data-dim="status" data-value="${value}"><span>${label}</span><i>${n}</i></button>`);
  return group("线索 · 共现", [...tagCounts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([tag, n]) => `<button data-action="explore" data-dim="concept" data-value="${escapeHtml(tag)}"><span>${escapeHtml(tag)}</span><i>${n}</i></button>`))
    + group("状态", statusRows);
}
function galleryReadyCard() {
  return `<article class="gallery-card gallery-ready" data-title="${escapeHtml(exhibitionFixture.title)}" data-tags="${escapeHtml(exhibitionFixture.title)}|观看|视线|光线|日常" data-status="ready">
    <div class="gallery-card-cover"><img src="./assets/demo/cave-space.png" alt="从哪里开始看一张画" /><button class="open-exhibition" data-action="foyer" aria-label="打开这场展览">↗</button></div>
    <div class="gallery-card-body"><p class="eyebrow">示例展览</p><h2>${escapeHtml(exhibitionFixture.title)}</h2><p>${escapeHtml(exhibitionFixture.subtitle)}</p><span>3 个展厅 · 6 则观看笔记</span><div class="gallery-decision"><button class="orbit-choice" data-action="recommendation" data-value="forget"><b>不感兴趣</b><span>不感兴趣</span></button><button class="orbit-choice" data-action="recommendation" data-value="later"><b>稍后再看</b><span>稍后再看</span></button><button class="orbit-choice" data-action="recommendation" data-value="keep"><b>留在这里</b><span>保留方向</span></button></div></div>
  </article>`;
}
function galleryFormingCard(collections, insight, index) {
  const tag = insight?.tag ?? "一个方向正在成形";
  const members = insight?.members ?? [];
  const chips = members.map((id) => { const item = collections.find((entry) => entry.id === id); return item ? `<span>${escapeHtml(item.title)}</span>` : ""; }).join("");
  return `<article class="gallery-card gallery-forming" data-title="${escapeHtml(tag)}" data-tags="${escapeHtml(tag)}|正在形成" data-status="forming">
    <div class="gallery-card-cover forming"><span aria-hidden="true">✦</span></div>
    <div class="gallery-card-body"><p class="eyebrow">正在形成 · 0${index + 2}</p><h2>${escapeHtml(tag)}</h2><p>${members.length ? `${members.length} 条收藏正在共同指向这个方向，展览还在成形。` : "收藏再多一些，这场展览会自己浮出来。"}</p>${chips ? `<div class="recommend-members">${chips}</div>` : ""}<span class="forming-note">需要更多合格收藏</span></div>
  </article>`;
}
function liveGalleryTemplate() {
  const exhibitions = state().liveExhibitions || [];
  return `<section class="forme-live-gallery"><div><h3>由你的真实收藏生成</h3><button type="button" data-action="live-ai-panel">生成展览 ↗</button></div>${exhibitions.length ? exhibitions.slice().reverse().map((item) => `<button type="button" class="forme-live-gallery-card" data-action="live-exhibition" data-exhibition-id="${escapeHtml(item.id)}"><small>${item.status === "preview" ? "展览预览" : "待核对草稿"} · ${item.sourceCollectionIds.length} 件收藏</small><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.curatorial_note?.text || "")}</p><span>进入展览 ↗</span></button>`).join("") : `<p>收进真实内容，完成 内容理解后，在这里生成属于你的展览。</p>`}</section>`;
}
function galleryTemplate() {
  const { collections, extractions } = state();
  const ready = exhibitionState()?.status === "ready";
  const insight = collections.length >= 3 ? computeInboxInsight(collections, extractions) : null;
  const searching = galleryFilters.expanded || Boolean(galleryFilters.query) || Boolean(galleryFilters.explore);
  const candidates = ready
    ? [galleryReadyCard(), galleryFormingCard(collections, insight, 0), galleryFormingCard(collections, insight, 1)]
    : [galleryFormingCard(collections, insight, 0), galleryFormingCard(collections, insight, 1)];
  const recommendCol = ready
    ? `<div class="recommend-card"><h4>${escapeHtml(exhibitionFixture.title)}</h4><p>${escapeHtml(exhibitionFixture.subtitle)}</p><div class="recommend-actions"><button class="insight-keep" data-action="foyer"><span aria-hidden="true">↗</span> 打开这场展览</button></div></div>`
    : `<div class="recommend-empty"><p>通过四道门禁的展览会静默出现在这里。</p></div>`;
  return `<section class="workspace-page gallery-page${searching ? " is-searching" : ""}">
    <div class="inbox-discovery gallery-discovery">
      <div class="discovery-bar">
        <button class="discovery-menu" data-action="toggle-explore" aria-expanded="${galleryFilters.menuOpen}" aria-label="探索与推荐"><span aria-hidden="true">≡</span></button>
        <span class="discovery-glyph" aria-hidden="true">⌕</span>
        <label class="sr-only" for="gallery-search">搜索展览</label>
        <input id="gallery-search" class="discovery-search" type="search" autocomplete="off" placeholder="搜索展览 · 主题、展品、线索…" value="${escapeHtml(galleryFilters.query)}"/>
        <button class="serendipity-cta" data-action="serendipity" aria-label="随机漫游：滚动推着你走"><span aria-hidden="true">✦</span><b>随机漫游</b></button>
      </div>
      ${galleryFilters.menuOpen ? `<div class="explore-panel" role="dialog" aria-label="探索与推荐">
        <section class="explore-col"><p class="eyebrow">按类探索</p>${renderGalleryExploreMenu(collections, extractions, ready, insight)}${galleryFilters.explore ? `<button class="active-filter panel-clear" data-action="clear-explore">${escapeHtml(galleryExploreLabel(galleryFilters.explore))} <i aria-hidden="true">✕</i></button>` : ""}</section>
        <section class="recommend-col"><p class="eyebrow">为您推荐</p>${recommendCol}</section>
      </div>` : ""}
      <p class="discovery-meta" aria-live="polite"></p>
    </div>
    ${pageSceneTemplate("gallery")}
    <header class="gallery-hero"><p class="eyebrow">不期而遇的展览</p><h1>今天，你的收藏里浮现了什么？</h1><p>只有通过四项策展检查 的展览才会出现在这里。</p></header>
    ${liveGalleryTemplate()}
    <div class="gallery-results">
      ${ready ? `<div class="candidate-stream">${candidates.join("")}<p class="filter-empty">没有匹配的展览。换个关键词，或<a data-action="clear-all">清除筛选</a>。</p></div><p class="gallery-hint">选择只会调整策展推荐，不会删除任何收藏</p>` : `<div class="empty-gallery"><span>展览正在酝酿</span><p>还没有可以展出的内容。只有通过四项策展检查 的展览才会出现在这里。</p><button class="primary-action" data-action="inbox">返回我的收藏</button></div>`}
    </div>
  </section>`;
}
function applyGalleryFilters() {
  const stream = document.querySelector(".gallery-page .candidate-stream");
  if (!stream) return;
  const query = galleryFilters.query.trim().toLowerCase();
  const explore = galleryFilters.explore;
  const cards = [...stream.querySelectorAll(".gallery-card")];
  let shown = 0;
  for (const card of cards) {
    const haystack = [card.dataset.title, card.dataset.tags].join(" ").toLowerCase();
    const matchQuery = !query || haystack.includes(query);
    const matchExplore = !explore || (explore.dim === "concept" ? haystack.includes(explore.value.toLowerCase()) : card.dataset.status === explore.value);
    const visible = matchQuery && matchExplore;
    card.classList.toggle("is-hidden", !visible);
    if (visible) shown++;
  }
  const empty = stream.querySelector(".filter-empty");
  if (empty) empty.classList.toggle("is-on", Boolean(query || explore) && shown === 0 && cards.length > 0);
  const meta = document.querySelector(".gallery-page .discovery-meta");
  if (meta) meta.textContent = (query || explore) ? (shown === 0 ? "没有匹配的展览" : `${shown} / ${cards.length} 条匹配`) : "";
}

// ✦ Serendipity 随机漫游：候选池、洗牌、滚动驱动的玻璃 3D 卡片场景。
function serendipityCandidatesFromState() {
  const { collections, extractions } = state();
  const ready = exhibitionState()?.status === "ready";
  const directions = collections.length >= 3 ? computeInboxInsights(collections, extractions, 4) : [];
  const exhibition = { ...exhibitionFixture, cover: "./assets/demo/cave-space.png", meta: "3 个展厅 · 6 则观看笔记", tags: ["展览", "已就绪"] };
  return buildSerendipityCandidates({ ready, exhibition, directions, collections });
}
function ensureSerendipityOrder() {
  const pool = serendipityCandidatesFromState();
  const same = serendipity.order.length === pool.length && serendipity.order.every((candidate, i) => candidate.kind === pool[i].kind && candidate.id === pool[i].id);
  if (!same) {
    serendipity.order = shuffleCandidates(pool);
    serendipity.position = WEBGL_OK ? -1 : 0; // WebGL 漫游从 FORME 标题（槽位 -1）开始
    serendipity.target = WEBGL_OK ? -1 : 0;
    serendipity.offset = WEBGL_OK ? -1 : 0;
    serendipity.velocity = 0;
  }
  return serendipity.order;
}
function enterSerendipity() {
  serendipity.order = [];
  ensureSerendipityOrder();
  // 每次进入都从 FORME 标题（WebGL）或第一张近卡（降级路径）开始，不继承上次漫游位置
  serendipity.position = WEBGL_OK ? -1 : 0;
  serendipity.target = WEBGL_OK ? -1 : 0;
  serendipity.offset = WEBGL_OK ? -1 : 0;
  serendipity.velocity = 0;
  navigate("serendipity");
}
function serendipityDecisionLabel(decision) {
  return { forget: "已忽略", later: "稍后再看", keep: "保留方向" }[decision] ?? "";
}
function serendipityCover(candidate) {
  if (candidate.cover) return `<img src="${escapeHtml(candidate.cover)}" alt="" loading="lazy" />`;
  const glyph = [...candidate.title][0] ?? "✦";
  return `<div class="glass-cover-fallback" aria-hidden="true"><span>${escapeHtml(glyph)}</span></div>`;
}
function serendipityCard(candidate, index) {
  const persisted = serendipityDecision(state().feedback, candidate);
  const decision = persisted?.decision ?? (candidate.kind === "exhibition" ? exhibitionState()?.recommendationDecision : null);
  const stateLabel = decision ? serendipityDecisionLabel(decision) : "";
  const members = candidate.members.slice(0, 4).map((item) => item.thumbnail
    ? `<span class="glass-member" title="${escapeHtml(item.title)}"><img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" /></span>`
    : `<span class="glass-member glass-member-text" title="${escapeHtml(item.title)}">${escapeHtml([...item.title][0] ?? "✦")}</span>`).join("");
  const tags = candidate.tags.map((tag) => `<span class="glass-tag">${escapeHtml(tag)}</span>`).join("");
  const openButton = `<button class="glass-open" data-action="serendipity-open"><span aria-hidden="true">↗</span> 进入展览</button>`;
  return `<article class="glass-card${decision ? " is-decided" : ""}" data-index="${index}" data-kind="${candidate.kind}" data-id="${escapeHtml(candidate.id)}">
    <div class="glass-card-inner">
      <div class="glass-face glass-front">
        <div class="glass-cover">${serendipityCover(candidate)}</div>
        <div class="glass-body">
          <p class="eyebrow">${candidate.kind === "exhibition" ? "私人展览 · 随机漫游" : "正在形成 · 随机漫游"}</p>
          <h2>${escapeHtml(candidate.title)}</h2>
          <p class="glass-sub">${escapeHtml(candidate.subtitle)}</p>
          <div class="glass-tags">${tags}<span class="glass-decision-state${stateLabel ? " is-on" : ""}">${stateLabel}</span></div>
          ${candidate.members.length ? `<div class="glass-members"><p>来自你的收藏</p><div class="glass-member-row">${members}</div></div>` : ""}
          <div class="glass-actions">
            <button class="orbit-choice" data-action="serendipity-decision" data-value="forget"><b>不感兴趣</b><span>不感兴趣</span></button>
            <button class="orbit-choice" data-action="serendipity-decision" data-value="later"><b>稍后再看</b><span>稍后再看</span></button>
            <button class="orbit-choice" data-action="serendipity-decision" data-value="keep"><b>留在这里</b><span>保留方向</span></button>
          </div>
          ${openButton}
        </div>
      </div>
      <div class="glass-face glass-back" aria-hidden="true">${candidate.cover ? `<img src="${escapeHtml(candidate.cover)}" alt="" loading="lazy" />` : ""}</div>
      <div class="glass-edge glass-edge-top" aria-hidden="true"></div>
      <div class="glass-edge glass-edge-bottom" aria-hidden="true"></div>
      <div class="glass-edge glass-edge-left" aria-hidden="true"></div>
      <div class="glass-edge glass-edge-right" aria-hidden="true"></div>
    </div>
  </article>`;
}
function serendipityTemplate() {
  const candidates = ensureSerendipityOrder();
  const back = `<button class="serendipity-back" data-action="gallery"><span aria-hidden="true">←</span> 个人展览</button>`;
  if (!candidates.length) {
    return `<section class="serendipity-page serendipity-empty">
      <header class="serendipity-topbar">${back}</header>
      <div class="serendipity-empty-body">
        <p class="eyebrow">不期而遇</p>
        <h1>收藏还太少，<br/>还没有可以漫游的展览。</h1>
        <p>回到我的收藏 再收几条，方向浮现后这里会自动出现。</p>
        <button class="primary-action" data-action="inbox">返回我的收藏</button>
      </div>
    </section>`;
  }
  if (serendipity.simple) {
    return `<section class="serendipity-page is-simple">
      <header class="serendipity-topbar">${back}<div class="serendipity-progress"><span>${candidates.length ? "01" : "00"}</span> <i aria-hidden="true">/</i> <b>${String(candidates.length).padStart(2, "0")}</b></div></header>
      <div class="serendipity-simple-list">${candidates.map((candidate, index) => serendipityCard(candidate, index)).join("")}</div>
      <p class="serendipity-hint">上下滚动浏览 · 选择只会调整推荐，不会删除任何收藏</p>
    </section>`;
  }
  if (WEBGL_OK) {
    return `<section class="serendipity-page noomo-page">
      <header class="serendipity-topbar">${back}
        <div class="serendipity-progress" aria-live="polite"><span class="serendipity-progress-current">✦</span> <i aria-hidden="true">/</i> <b>${String(candidates.length).padStart(2, "0")}</b></div>
      </header>
      <div class="noomo-stage" data-noomo-stage>
      <div class="noomo-caption" data-noomo-caption data-index="0">
        <div class="noomo-main">
          <p class="eyebrow noomo-eyebrow"></p>
          <h2 class="noomo-title" data-noomo-title></h2>
          <p class="noomo-sub"></p>
        </div>
        <div class="noomo-meta">
          <div class="noomo-tags"></div>
          <div class="noomo-members" data-noomo-members><p>来自你的收藏</p><div class="noomo-member-row" data-noomo-member-row></div></div>
        </div>
        <div class="noomo-actions">
          <button class="noomo-ghost" data-action="serendipity-decision" data-value="forget"><b>不感兴趣</b><span>不感兴趣</span></button>
          <button class="noomo-ghost" data-action="serendipity-decision" data-value="later"><b>稍后再看</b><span>稍后再看</span></button>
          <button class="noomo-ghost" data-action="serendipity-decision" data-value="keep"><b>留在这里</b><span>保留方向</span></button>
          <button class="noomo-open" data-action="serendipity-open"><span aria-hidden="true">↗</span> 进入展览</button>
        </div>
      </div>
      </div>
      <p class="serendipity-hint">滚动 · 穿过 Folio 进入漫游</p>
    </section>`;
  }
  const dust = Array.from({ length: 20 }, (_, i) => {
    const rnd = (n) => { const s = Math.sin(i * 127.1 + n * 311.7) * 43758.5453; return s - Math.floor(s); };
    const x = Math.round((rnd(1) * 2 - 1) * 480);
    const y = Math.round((rnd(2) * 2 - 1) * 300);
    const z = 1 + Math.round(rnd(3) * 4);
    const size = Math.round((2 + rnd(4) * 10) * 10) / 10;
    const bokeh = i >= 14 ? " serendipity-bokeh" : "";
    return `<i class="serendipity-dust${bokeh}" data-x="${x}" data-y="${y}" data-z="${z}" style="width:${size}px;height:${size}px"></i>`;
  }).join("");
  return `<section class="serendipity-page">
    <header class="serendipity-topbar">${back}
      <div class="serendipity-progress" aria-live="polite"><span class="serendipity-progress-current">01</span> <i aria-hidden="true">/</i> <b>${String(candidates.length).padStart(2, "0")}</b></div>
    </header>
    <div class="serendipity-stage">
      <div class="serendipity-cards">${dust}${candidates.map((candidate, index) => serendipityCard(candidate, index)).join("")}</div>
      <div class="serendipity-next-preview" aria-hidden="true"><div class="serendipity-next-frame"><img src="" alt="" /></div><p class="serendipity-next-label">继续滚动 · 下一张</p></div>
    </div>
    <p class="serendipity-hint">滚动漫游 · 选择只会调整推荐，不会删除任何收藏</p>
  </section>`;
}
function advanceSerendipitySpring(stack, dt) {
  // 近临界阻尼 + 指数衰减（任意帧率数值稳定）：滚轮位置连续跟踪（手停卡停），
  // 不再量化到整数卡位，也没有欠阻尼的弹滑过冲
  const stiffness = 420;
  const damping = 42;
  stack.velocity += (stack.target - stack.position) * stiffness * dt;
  stack.velocity *= Math.exp(-damping * dt);
  stack.position += stack.velocity * dt;
  if (Math.abs(stack.target - stack.position) < 0.0012 && Math.abs(stack.velocity) < 0.001) {
    stack.position = stack.target;
    stack.velocity = 0;
  }
}
function serendipityClamp01(v) {
  return Math.max(0, Math.min(1, v));
}
// back.inOut(2)：字符升起时的回弹过冲。
function serendipityBackInOut(t) {
  const s = 2;
  const backIn = (u) => (s + 1) * u * u * u - s * u * u;
  const backOut = (u) => 1 + (s + 1) * Math.pow(u - 1, 3) + s * Math.pow(u - 1, 2);
  return t < 0.5 ? backIn(2 * t) / 2 : 0.5 + backOut(2 * t - 1) / 2;
}
function serendipitySmoothstep(t) {
  return t * t * (3 - 2 * t);
}
function serendipityCharSpans(text) {
  return [...(text || "")].map((ch) => `<span class="char">${escapeHtml(ch === " " ? "\u00A0" : ch)}</span>`).join("");
}
// Noomo 式字幕 scrub：距卡片 0.72 时开始逐字浮现，居中时全部到位；滚轮退回时整体倒放。
function updateNoomoCaption(stack = serendipity) {
  const caption = document.querySelector("[data-noomo-caption]");
  if (!caption) return;
  const index = Number(caption.dataset.index);
  if (!Number.isFinite(index) || index < 0) return;
  const d = Math.abs(stack.position - index);
  const p = serendipityClamp01((0.72 - d) / 0.72);
  const chars = caption.querySelectorAll(".noomo-title .char");
  const n = chars.length;
  // 逐字 stagger 自适应：短标题保持原节奏；长摘录压缩步长，保证整段都能浮现完。
  const step = n > 1 ? Math.min(0.05, 0.45 / (n - 1)) : 0;
  const spread = step * Math.max(0, n - 1);
  chars.forEach((ch, k) => {
    const cp = serendipityClamp01((p - step * k) / Math.max(0.0001, 1 - spread));
    const e = serendipityBackInOut(cp);
    ch.style.opacity = String(serendipityClamp01(e));
    ch.style.transform = `translateY(${((1 - e) * 120).toFixed(2)}%) scaleY(${(1 + (1 - e) * 1.3).toFixed(3)})`;
    ch.style.transformOrigin = "50% 0%";
  });
  const lines = [".noomo-eyebrow", ".noomo-sub", ".noomo-tags", ".noomo-members", ".noomo-actions"].map((sel) => caption.querySelector(sel));
  lines.forEach((el, k) => {
    if (!el) return;
    const lp = serendipityClamp01((p - 0.16 - k * 0.07) / 0.55);
    const le = serendipitySmoothstep(lp);
    el.style.opacity = String(le);
    el.style.transform = `translateY(${((1 - le) * 18).toFixed(2)}px)`;
  });
  caption.style.pointerEvents = p > 0.8 ? "" : "none";
}
function updateSerendipityCaption(index) {
  const caption = document.querySelector("[data-noomo-caption]");
  const candidate = serendipity.order[index];
  if (!caption || !candidate) return;
  caption.dataset.index = String(index);
  const persisted = serendipityDecision(state().feedback, candidate);
  const decision = persisted?.decision ?? (candidate.kind === "exhibition" ? exhibitionState()?.recommendationDecision : null);
  caption.querySelector(".noomo-eyebrow").textContent = candidate.kind === "exhibition" ? "私人展览 · 随机漫游" : "正在形成 · 随机漫游";
  caption.querySelector("[data-noomo-title]").innerHTML = serendipityCharSpans(candidate.title);
  caption.querySelector(".noomo-sub").textContent = candidate.subtitle;
  const stateLabel = decision ? `<span class="glass-decision-state is-on">${serendipityDecisionLabel(decision)}</span>` : "";
  caption.querySelector(".noomo-tags").innerHTML = candidate.tags.map((tag) => `<span class="noomo-tag">${escapeHtml(tag)}</span>`).join(" · ") + stateLabel;
  caption.querySelector("[data-noomo-member-row]").innerHTML = candidate.members.slice(0, 4).map((item) => item.thumbnail
    ? `<span class="glass-member" title="${escapeHtml(item.title)}"><img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" /></span>`
    : `<span class="glass-member glass-member-text">${escapeHtml([...item.title][0] ?? "✦")}</span>`).join("");
  caption.querySelector("[data-noomo-members]").style.display = candidate.members.length ? "" : "none";
  caption.querySelector(".noomo-open").style.display = "";
  updateNoomoCaption();
}
// 3D 镜头单帧推进：弹簧位移 + 相机倾斜 + 卡片 Z 轴纵深 + 星尘视差 + 背景视差。
function stepSerendipityStack(stack, els, now, dt) {
  advanceSerendipitySpring(stack, dt);
  if (els.camera) {
    const tilt = Math.max(-3, Math.min(3, stack.velocity * -0.08));
    els.camera.style.transform = `rotateY(${tilt.toFixed(2)}deg)`;
  }
  for (const card of els.cards) {
    const i = Number(card.dataset.index);
    const dist = i - stack.position;
    const d = Math.abs(dist);
    const opacity = Math.max(0, 1 - d * 0.24);
    const blur = Math.min(14, d * 4);
    const breathe = Math.sin(now / 2400 + i * 1.3) * 10;
    const spread = Math.min(300, (window.innerWidth || 1200) * 0.24);
    card.style.transform = `translate(-50%,-50%) translateX(${(dist * spread).toFixed(1)}px) translateY(${(d * 20).toFixed(1)}px) translateZ(${(d * -260 + breathe).toFixed(1)}px)`;
    card.style.zIndex = String(20 - Math.round(d));
    card.style.setProperty("--face-blur", `${blur.toFixed(2)}px`);
    card.style.setProperty("--face-opacity", opacity.toFixed(3));
    card.style.setProperty("--face-sat", (1 - Math.min(0.55, d * 0.22)).toFixed(3));
    const inner = card.querySelector(".glass-card-inner");
    if (inner) {
      const sway = Math.sin(now / 2000 + i * 0.9) * 4 * Math.exp(-d * 0.7);
      inner.style.transform = `rotateY(${(-dist * 20 + sway).toFixed(2)}deg)`;
    }
    card.setAttribute("aria-hidden", d > 0.5 ? "true" : "false");
    card.classList.toggle("is-active", d < 0.5);
  }
  for (const mote of els.dust) {
    const z = Number(mote.dataset.z);
    const x = Number(mote.dataset.x);
    const y = Number(mote.dataset.y);
    mote.style.transform = `translate(-50%,-50%) translate3d(${(x - stack.position * (46 + z * 0.6)).toFixed(1)}px, ${(y + Math.sin(now / 2200 + z * 1.7) * 7).toFixed(1)}px, ${(-z * 70 - 30).toFixed(1)}px)`;
  }
  if (els.sky) {
    els.sky.style.transform = `translate3d(0, ${(-stack.position * 12 + Math.sin(now / 3000) * 5).toFixed(1)}px, 0) scale(1.06)`;
  }
  if (els.progress) {
    const current = Math.min(els.cards.length, Math.max(1, Math.round(stack.position) + 1));
    els.progress.textContent = String(current).padStart(2, "0");
  }
  if (els.previewImg && els.previewLabel && els.order) {
    const next = els.order[Math.min(els.order.length - 1, Math.round(stack.position) + 1)];
    if (next?.cover && els.previewImg.src !== next.cover) els.previewImg.src = next.cover;
    if (next?.title) els.previewLabel.textContent = `继续滚动 · ${next.title}`;
  }
}
function mountSerendipity() {
  if (serendipity.simple || !serendipity.order.length) return;
  if (WEBGL_OK) {
    noomoCleanup = mountNoomoScene(document.querySelector("[data-noomo-stage]"), {
      candidates: serendipity.order,
      advance: (dt) => {
        advanceSerendipitySpring(serendipity, dt);
        updateNoomoCaption(serendipity);
        const progress = document.querySelector(".serendipity-progress-current");
        if (progress) {
          progress.textContent = serendipity.position < -0.55
            ? "✦"
            : String(Math.min(serendipity.order.length, Math.max(1, Math.round(serendipity.position) + 1))).padStart(2, "0");
        }
        const hint = document.querySelector(".noomo-page .serendipity-hint");
        if (hint) hint.textContent = serendipity.position < -0.55 ? "滚动 · 穿过 Folio 进入漫游" : "滚动漫游 · 选择只会调整推荐，不会删除任何收藏";
      },
      getState: () => ({ position: serendipity.position, velocity: serendipity.velocity }),
      onActive: (index) => updateSerendipityCaption(index),
      onProject: () => {
        // Noomo 式：info 固定在下部区域（CSS 锚定左下），不再跟随卡片投影移动
      },
    });
    updateSerendipityCaption(Math.max(0, Math.min(serendipity.order.length - 1, Math.round(serendipity.position))));
    return;
  }
  const els = {
    cards: [...document.querySelectorAll(".glass-card")],
    camera: document.querySelector(".serendipity-cards"),
    dust: [...document.querySelectorAll(".serendipity-dust")],
    sky: document.querySelector(".serendipity-sky"),
    progress: document.querySelector(".serendipity-progress-current"),
    previewImg: document.querySelector(".serendipity-next-frame img"),
    previewLabel: document.querySelector(".serendipity-next-label"),
    order: serendipity.order,
  };
  if (!els.cards.length) return;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    stepSerendipityStack(serendipity, els, now, dt);
    serendipity.raf = requestAnimationFrame(tick);
  };
  serendipity.raf = requestAnimationFrame(tick);
}
// SpecularButton 的轻量实现：玻璃底 + 跟随指针的高光描边（conic-gradient 边缘光）。
function bindSpecular() {
  if (LIGHT_PRESENTATION) return;
  document.querySelectorAll(".capture-plus.specular").forEach((btn) => {
    if (btn.dataset.specular === "1") return;
    btn.dataset.specular = "1";
    const update = (event) => {
      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right);
      const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
      const dist = Math.hypot(dx, dy);
      const angle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI + 90;
      const t = Math.max(0, 1 - dist / 280);
      btn.style.setProperty("--sb-angle", `${angle}deg`);
      btn.style.setProperty("--sb-glow", String(0.18 + 0.82 * t * t * (3 - 2 * t)));
    };
    btn.addEventListener("pointermove", update);
    btn.addEventListener("pointerleave", () => btn.style.setProperty("--sb-glow", "0.18"));
  });
}

// 五环节解读数据（这是什么 → 它说了什么 → 为什么值得看 → 它不能证明什么 → 接着看哪件）。
// 由 glm-5.3 按设计文档生成：docs/superpowers/specs/2026-08-21-exhibit-detail-content-pipeline-design.md
// 环节2 抽取 IR 为内部中间层，不进前端；这里落的是环节 1/3/4/5 的用户可见层。
function exhibitById(id) {
  return exhibitionFixture.rooms.flatMap((room) => room.exhibits).find((item) => item.id === id);
}
function collectionById(id) { return state().collections.find((item) => item.id === id); }
function exhibitionNoteMedia(item) {
  const image = item?.thumbnail || exhibitById(item?.id)?.image;
  if (!image) return "";
  return `<figure class="exhibit-article__media" data-note-image data-image-src="${escapeHtml(image)}"><span class="exhibit-article__figure-no">图一</span><img src="${escapeHtml(image)}" alt="${escapeHtml(item.title)}"/><figcaption><span>图像证据</span><b>${escapeHtml(provenance[item.id]?.caption || item.source)}</b></figcaption></figure>`;
}
function relatedHighlight(text, relation) {
  const safe = escapeHtml(text);
  const phrase = escapeHtml(relation.phrase);
  const target = collectionById(relation.target);
  if (!safe.includes(phrase)) return safe;
  const evidence = [relation.evidence, relation.backEvidence].filter(Boolean).map(escapeHtml).join(" ↔ ");
  const marker = `<span class="exhibit-relation" tabindex="0" data-related="${escapeHtml(relation.target)}">${phrase}<span class="exhibit-relation__popover" role="note"><small>关联藏品 · ${escapeHtml(relation.kind)}</small><strong>${escapeHtml(target?.title || relation.target)}</strong><span class="exhibit-relation__copy">${escapeHtml(relation.copy)}</span><em>双向证据：${evidence}</em><button type="button" data-action="switch-exhibit-detail" data-exhibit="${escapeHtml(relation.target)}">查看这件藏品 →</button></span></span>`;
  return safe.replace(phrase, marker);
}
// 环节3 的三段论断：copy 是事实层，claim 是观点层（规则②显式分开），每段挂 locator 角标。
function exhibitArgument(article) {
  const markers = ["Ⅰ", "Ⅱ", "Ⅲ"];
  return `<div class="exhibit-spread__analysis">${article.reading.argument.map((step, stepIndex) => `<p><span>${markers[stepIndex]}</span><em class="exhibit-arg__body">${escapeHtml(step.copy)}<b class="exhibit-arg__claim">${escapeHtml(step.claim)}</b><cite class="exhibit-cite">${escapeHtml(step.cites.join(" · "))}</cite></em></p>`).join("")}</div>`;
}
function exhibitFrames(article) {
  const frames = article.reading.figures;
  if (!frames?.length) return "";
  return `<div class="exhibit-spread__frames">${frames.map((frame) => `<figure data-note-image data-image-src="${escapeHtml(frame.src)}"><span>${escapeHtml(frame.time)}</span><img src="${escapeHtml(frame.src)}" alt="${escapeHtml(frame.caption)}"/><figcaption><b>${escapeHtml(frame.caption)}</b><small>原视频分镜抽帧</small></figcaption></figure>`).join("")}</div>`;
}
// 环节4 的限定：每条必须标注依据是原文自带还是模型推断——产品诚实底线的界面落点。
function exhibitLimits(article) {
  return `<ul class="exhibit-limits">${article.limits.items.map((limit) => `<li><span class="exhibit-limits__basis ${limit.basis === "原文自带" ? "is-source" : "is-inferred"}">${escapeHtml(limit.basis)}</span><div><small>${escapeHtml(limit.kind)}</small><p>${escapeHtml(limit.text)}<cite class="exhibit-cite">${escapeHtml(limit.cite)}</cite></p></div></li>`).join("")}</ul>`;
}
// 统一四章节结构（不再按媒介分叉）：这是什么 / 为什么值得看 / 它不能证明什么 / 接着看哪件。
function exhibitSpreadTemplate(item, article) {
  const media = exhibitionNoteMedia(item);
  return `<div class="exhibit-spread exhibit-spread--qa ${media ? "has-media" : "no-media"}">
    <section id="exhibit-chapter-01" data-exhibit-chapter="01" class="exhibit-article__chapter is-lead"><header><span>01</span><div><small>藏品简介</small><h1 id="exhibit-detail-title">${escapeHtml(item.title)}</h1><p class="exhibit-spread__oneliner">${escapeHtml(article.oneLiner)}</p></div></header><p class="exhibit-spread__overview">${escapeHtml(article.overview)}</p>${media}<div class="exhibit-spread__facts"><p>${escapeHtml(article.structure)}</p><dl><dt>类型</dt><dd>${escapeHtml(article.kind)}</dd>${article.facts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl></div></section>
    <section id="exhibit-chapter-02" data-exhibit-chapter="02" class="exhibit-article__chapter"><header><span>02</span><div><small>为什么值得看</small><h2>${escapeHtml(article.reading.subtitle)}</h2></div></header><p class="exhibit-spread__deck">${escapeHtml(article.reading.deck)}</p>${exhibitArgument(article)}${exhibitFrames(article)}</section>
    <section id="exhibit-chapter-03" data-exhibit-chapter="03" class="exhibit-article__chapter"><header><span>03</span><div><small>它不能证明什么</small><h2>${escapeHtml(article.limits.subtitle)}</h2></div></header>${exhibitLimits(article)}</section>
    <section id="exhibit-chapter-04" data-exhibit-chapter="04" class="exhibit-article__chapter exhibit-spread__relation"><header><span>04</span><div><small>接着看哪件</small><h2>${escapeHtml(article.next.subtitle)}</h2></div></header><blockquote>“${escapeHtml(article.next.takeaway)}”<cite>编辑提要 · 策展人解读</cite></blockquote><p>${relatedHighlight(article.next.copy, { ...article.next.relation, copy: article.next.copy })}</p></section>
  </div>`;
}
function exhibitDetailTemplate(id) {
  const item = collectionById(id);
  const article = exhibitInterpretation[id];
  if (!item || !article) return "";
  const index = exhibitionFixture.sourceCollectionIds.indexOf(id) + 1;
  const mediaClass = item.type === "video" || item.type === "video_note" ? "is-video" : item.thumbnail ? "is-image" : "is-text";
  const nav = [["01", "藏品简介"], ["02", article.reading.subtitle], ["03", article.limits.subtitle], ["04", article.next.subtitle]];
  const editorialContent = exhibitSpreadTemplate(item, article);
  return `<div class="exhibit-detail-overlay" role="dialog" aria-modal="true" aria-labelledby="exhibit-detail-title" data-exhibit-id="${escapeHtml(id)}">
    <div class="exhibit-detail-modal ${mediaClass}">
      <header class="exhibit-detail-bar"><span>展品 ${String(index).padStart(2, "0")} / 06</span><b data-current-chapter>01 / 藏品简介</b><button type="button" data-action="close-exhibit-detail">关闭 ×</button></header>
      <div class="exhibit-detail-scroll" data-exhibit-detail-scroll>
        <aside class="exhibit-detail-index">
          <div><small>${escapeHtml(typeLabel(item.type))}</small><p>${escapeHtml(item.source)}<br/>${escapeHtml(provenance[id]?.duration || "文字藏品")}</p></div>
          <nav aria-label="文章章节">${nav.map(([number, title], chapterIndex) => `<button type="button" class="${chapterIndex === 0 ? "is-active" : ""}" data-action="jump-exhibit-chapter" data-chapter="${number}"><span>${number}</span>${escapeHtml(title)}</button>`).join("")}</nav>
        </aside>
        <article class="exhibit-article" data-note-selectable>
          ${editorialContent}
          <footer><span>展品结束 · ${String(index).padStart(2, "0")}</span><button type="button" data-action="close-exhibit-detail">回到展廊 →</button></footer>
        </article>
      </div>
      <button class="exhibit-selection-save" type="button" data-action="save-selection-note">保存为手记</button>
      <div class="exhibit-image-menu" role="menu"><button type="button" data-action="save-image-note">保存图片为手记</button></div>
      <aside class="exhibit-note-drawer" aria-label="编辑手记" aria-hidden="true" inert data-note-drawer></aside>
    </div>
  </div>`;
}

function renderExhibitNoteDrawer(note) {
  const drawer = document.querySelector("[data-note-drawer]");
  if (!drawer || !note) return;
  drawer.innerHTML = `<header><span>手记 · 已保存</span><button type="button" data-action="close-note-drawer" aria-label="收起手记">×</button></header>${note.kind === "image" ? `<img src="${escapeHtml(note.content)}" alt="已保存的藏品图像"/>` : `<blockquote>${escapeHtml(note.content)}</blockquote>`}<p>${escapeHtml(note.exhibitTitle)} · ${escapeHtml(note.chapterTitle)}</p><label><span>补充你的想法</span><textarea data-exhibit-note-comment placeholder="为什么想留下这一段？">${escapeHtml(note.comment || "")}</textarea></label><small>来源与证据位置已自动保留</small>`;
  drawer.classList.add("is-open");
  drawer.removeAttribute("inert");
  drawer.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => { if (drawer.isConnected && drawer.classList.contains("is-open")) drawer.querySelector("textarea")?.focus({ preventScroll: true }); });
}
function closeExhibitNoteDrawer(drawer) {
  if (!drawer) return;
  const hadFocus = drawer.contains(document.activeElement);
  drawer.classList.remove("is-open");
  drawer.setAttribute("inert", "");
  drawer.setAttribute("aria-hidden", "true");
  if (hadFocus) document.querySelector('.exhibit-detail-bar [data-action="close-exhibit-detail"]')?.focus({ preventScroll: true });
}
function saveExhibitNote({ kind, content, image = null }) {
  const overlay = document.querySelector(".exhibit-detail-overlay");
  const chapter = overlay?.querySelector(".exhibit-article__chapter.is-current") || overlay?.querySelector(".exhibit-article__chapter");
  const item = collectionById(exhibitDetail.id);
  if (!overlay || !item || !content) return;
  const note = { id: `exhibit-note-${Date.now()}`, kind, content, image, exhibitId: item.id, exhibitTitle: item.title, exhibitionId: exhibitionFixture.id, exhibitionTitle: exhibitionFixture.title, chapter: chapter?.dataset.exhibitChapter || "01", chapterTitle: chapter?.querySelector("h2")?.textContent || "开篇", source: item.source, createdAt: new Date().toISOString(), comment: "" };
  store.update((draft) => { draft.exhibitionNotes.unshift(note); });
  exhibitDetail.noteDraftId = note.id;
  renderExhibitNoteDrawer(note);
}
function openExhibitDetail(id) {
  if (!exhibitInterpretation[id]) return;
  if (state().ui.view === "foyer") setFoyerQuickNoteExhibit(id);
  exhibitDetail.id = id;
  document.querySelector(".exhibit-detail-overlay")?.remove();
  app.insertAdjacentHTML("beforeend", exhibitDetailTemplate(id));
  document.body.classList.add("exhibit-detail-open");
  mountExhibitDetail();
}
function closeExhibitDetail({ immediate = false } = {}) {
  const surface = document.querySelector(".exhibit-detail-overlay");
  if (LIGHT_PRESENTATION && surface && !immediate) {
    const id = exhibitDetail.id;
    void closeGlassOverlay(surface, () => { if (exhibitDetail.id === id) closeExhibitDetail({ immediate: true }); }); return;
  }
  exhibitDetail.id = null;
  exhibitDetail.selection = null;
  document.body.classList.remove("exhibit-detail-open");
  document.querySelector(".exhibit-detail-overlay")?.remove();
}
function mountExhibitDetail() {
  const overlay = document.querySelector(".exhibit-detail-overlay");
  const scroll = overlay?.querySelector("[data-exhibit-detail-scroll]");
  if (!overlay || !scroll) return;
  const chapters = [...overlay.querySelectorAll("[data-exhibit-chapter]")];
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) { closeExhibitDetail(); return; }
    if (!event.target.closest(".exhibit-image-menu") && !event.target.closest("[data-note-image]")) overlay.querySelector(".exhibit-image-menu")?.classList.remove("is-visible");
  });
  const syncChapter = () => {
    const probe = scroll.scrollTop + scroll.clientHeight * .28;
    let active = chapters[0];
    chapters.forEach((chapter) => { if (chapter.offsetTop <= probe) active = chapter; chapter.classList.remove("is-current"); });
    active?.classList.add("is-current");
    const number = active?.dataset.exhibitChapter || "01";
    overlay.querySelectorAll(".exhibit-detail-index nav button").forEach((button) => button.classList.toggle("is-active", button.dataset.chapter === number));
    const label = overlay.querySelector("[data-current-chapter]");
    if (label && active) label.textContent = `${number} / ${active.querySelector("h2, h1")?.textContent || ""}`;
  };
  scroll.addEventListener("scroll", syncChapter, { passive: true });
  syncChapter();
  const selectable = overlay.querySelector("[data-note-selectable]");
  const selectionButton = overlay.querySelector(".exhibit-selection-save");
  selectable?.addEventListener("mouseup", () => {
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!text || !selectable.contains(selection.anchorNode) || text.length < 2) { selectionButton.classList.remove("is-visible"); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const modalRect = overlay.querySelector(".exhibit-detail-modal").getBoundingClientRect();
      exhibitDetail.selection = text;
      selectionButton.style.left = `${Math.max(12, Math.min(modalRect.width - 150, rect.left - modalRect.left + rect.width / 2 - 65))}px`;
      selectionButton.style.top = `${Math.max(54, rect.top - modalRect.top - 48)}px`;
      selectionButton.classList.add("is-visible");
    });
  });
  overlay.querySelectorAll("[data-note-image]").forEach((figure) => figure.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const menu = overlay.querySelector(".exhibit-image-menu");
    const modalRect = overlay.querySelector(".exhibit-detail-modal").getBoundingClientRect();
    menu.dataset.imageSrc = figure.dataset.imageSrc;
    menu.style.left = `${Math.min(modalRect.width - 190, event.clientX - modalRect.left)}px`;
    menu.style.top = `${Math.min(modalRect.height - 70, event.clientY - modalRect.top)}px`;
    menu.classList.add("is-visible");
  }));
}

// 展廊 / 藏品详情里的「随手记」输入框：文字 + 图片（选择文件 / 拖入 / ⌘V 粘贴）。
const quickNoteDrafts = new Map();
let foyerQuickNoteExhibit = null;
function quickNoteDraft(contextId) {
  if (!quickNoteDrafts.has(contextId)) quickNoteDrafts.set(contextId, { text: "", images: [] });
  return quickNoteDrafts.get(contextId);
}
function quickNoteMarkup(contextId, opts = {}) {
  const draft = quickNoteDraft(contextId);
  return `<form class="quick-note" data-form="quick-note" data-quick-note="${escapeHtml(contextId)}" data-quick-note-exhibit="${escapeHtml(opts.exhibitId || "")}" data-quick-note-source="${escapeHtml(opts.source || "展廊")}">
    <p class="quick-note__label"><span aria-hidden="true">✎</span>${opts.label || "在看展时，留一句"}</p>
    ${opts.exhibitChip ? `<div class="quick-note__exhibit" data-quick-note-exhibit><i aria-hidden="true"></i><span>记录关联 · 展廊整体</span></div>` : ""}
    <textarea name="content" rows="${opts.rows || 3}" placeholder="${opts.placeholder || "写下此刻的想法…"}">${escapeHtml(draft.text)}</textarea>
    <div class="quick-note__images" data-quick-note-images>${draft.images.map((src, index) => `<figure><img src="${src}" alt=""/><button type="button" data-action="quick-note-remove" data-context="${escapeHtml(contextId)}" data-index="${index}" aria-label="移除图片">×</button></figure>`).join("")}</div>
    <div class="quick-note__actions">
      <button type="button" class="quick-note__attach" data-action="quick-note-pick" data-context="${escapeHtml(contextId)}"><span aria-hidden="true">＋</span> 图片</button>
      <input type="file" accept="image/*" multiple hidden data-quick-note-file data-context="${escapeHtml(contextId)}" />
      <span class="quick-note__hint">拖入或 ⌘V 粘贴图片</span>
      <span class="quick-note__status" data-quick-note-status aria-live="polite"></span>
      <button type="submit" class="quick-note__submit">保存 <b>→</b></button>
    </div>
  </form>`;
}
// 展廊随笔的「当前展品」标记：记录会挂在最近点开的藏品上，可随时清除。
function setFoyerQuickNoteExhibit(id, title) {
  foyerQuickNoteExhibit = id ? { id, title: title || collectionById(id)?.title || id } : null;
  const form = document.querySelector('[data-quick-note="foyer"]');
  if (!form) return;
  form.dataset.quickNoteExhibit = foyerQuickNoteExhibit?.id || "";
  form.dataset.quickNoteExhibitTitle = foyerQuickNoteExhibit?.title || "";
  const chip = form.querySelector("[data-quick-note-exhibit]");
  if (!chip) return;
  if (foyerQuickNoteExhibit) {
    chip.innerHTML = `<i aria-hidden="true"></i><span>记录关联 · ${escapeHtml(foyerQuickNoteExhibit.title)}</span><button type="button" data-action="quick-note-clear-exhibit" aria-label="取消关联藏品">×</button>`;
    chip.classList.add("is-on");
  } else {
    chip.innerHTML = `<i aria-hidden="true"></i><span>记录关联 · 展廊整体</span>`;
    chip.classList.remove("is-on");
  }
}
function renderQuickNoteImages(contextId) {
  const form = document.querySelector(`[data-quick-note="${CSS.escape(contextId)}"]`);
  if (!form) return;
  const wrap = form.querySelector("[data-quick-note-images]");
  const draft = quickNoteDraft(contextId);
  if (wrap) wrap.innerHTML = draft.images.map((src, index) => `<figure><img src="${src}" alt=""/><button type="button" data-action="quick-note-remove" data-context="${escapeHtml(contextId)}" data-index="${index}" aria-label="移除图片">×</button></figure>`).join("");
  updateQuickNoteDockDraft(contextId);
}
function updateQuickNoteDockDraft(contextId) {
  if (contextId !== "foyer") return;
  const draft = quickNoteDraft(contextId);
  document.querySelector(".foyer-quick-note .quick-note-dock")?.classList.toggle("has-draft", Boolean(draft.text.trim() || draft.images.length));
}
function addQuickNoteImages(contextId, files) {
  const draft = quickNoteDraft(contextId);
  let added = 0;
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    added += 1;
    const reader = new FileReader();
    reader.onload = () => {
      if (draft.images.length >= 4) return;
      draft.images.push(reader.result);
      renderQuickNoteImages(contextId);
    };
    reader.readAsDataURL(file);
  }
  if (!added) return;
  const form = document.querySelector(`[data-quick-note="${CSS.escape(contextId)}"]`);
  const status = form?.querySelector("[data-quick-note-status]");
  if (status) status.textContent = `已添加 ${added} 张图片`;
}
function saveQuickNote(contextId, form) {
  const draft = quickNoteDraft(contextId);
  const text = draft.text.trim();
  const firstImage = draft.images[0] || "";
  const status = form.querySelector("[data-quick-note-status]");
  if (!text && !firstImage) {
    if (status) status.textContent = "先写下一点什么，或添加一张图片";
    return;
  }
  const exhibitId = form.dataset.quickNoteExhibit || "";
  const item = exhibitId ? collectionById(exhibitId) : null;
  const note = {
    id: `quick-note-${Date.now()}`,
    kind: !text && firstImage ? "image" : "text",
    content: !text && firstImage ? firstImage : text,
    image: firstImage,
    images: [...draft.images],
    comment: text,
    exhibitId,
    exhibitTitle: item?.title || "",
    exhibitionId: exhibitionFixture.id,
    exhibitionTitle: exhibitionFixture.title,
    chapter: "",
    chapterTitle: "展廊随笔",
    source: form.dataset.quickNoteSource || "展廊",
    createdAt: new Date().toISOString(),
  };
  store.update((d) => { d.exhibitionNotes.unshift(note); });
  draft.text = "";
  draft.images = [];
  const textarea = form.querySelector("textarea");
  if (textarea) textarea.value = "";
  renderQuickNoteImages(contextId);
  if (status) {
    status.textContent = "已保存到 Notes";
    window.setTimeout(() => { if (status.isConnected) status.textContent = ""; }, 2600);
  }
  if (contextId === "foyer") window.setTimeout(closeFoyerQuickNote, 720);
}

// 展廊随笔是可拖动、可收缩、可吸边的浮动工具窗。
let foyerQuickNoteOpen = false;
let foyerQuickNotePosition = null;
let foyerQuickNoteDockSide = "";
let foyerQuickNoteSuppressClick = false;

function clampFoyerQuickNotePosition(panel, x, y) {
  const margin = 14;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  return {
    x: Math.max(margin, Math.min(window.innerWidth - width - margin, x)),
    y: Math.max(margin, Math.min(window.innerHeight - height - margin, y)),
  };
}

function positionFoyerQuickNote(panel, position = foyerQuickNotePosition) {
  if (!panel || !position) return;
  panel.dataset.dockSide = foyerQuickNoteDockSide;
  const dockedX = foyerQuickNoteDockSide === "left"
    ? 10
    : foyerQuickNoteDockSide === "right" ? window.innerWidth - panel.offsetWidth - 10 : position.x;
  const next = clampFoyerQuickNotePosition(panel, dockedX, position.y);
  foyerQuickNotePosition = next;
  panel.style.left = `${next.x}px`;
  panel.style.top = `${next.y}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function initFoyerQuickNoteDrag(panel) {
  if (!panel || panel.dataset.dragReady === "true") return;
  panel.dataset.dragReady = "true";
  const launcher = panel.querySelector("[data-quick-note-launch]");
  launcher?.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    setFoyerQuickNoteOpen(true);
  });
  panel.querySelectorAll("[data-quick-note-drag]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      foyerQuickNoteDockSide = "";
      panel.dataset.dockSide = "";
      panel.classList.add("is-dragging");
      // The gallery is an iframe. Capture the pointer so movement continues
      // to reach this document after the cursor leaves the floating window.
      handle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => {
        if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 4) moved = true;
        const next = clampFoyerQuickNotePosition(panel, moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
        foyerQuickNotePosition = next;
        positionFoyerQuickNote(panel, next);
      };
      const end = (upEvent) => {
        if (handle.hasPointerCapture?.(upEvent.pointerId)) handle.releasePointerCapture(upEvent.pointerId);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        panel.classList.remove("is-dragging");
        if (moved) {
          foyerQuickNoteSuppressClick = true;
          window.setTimeout(() => { foyerQuickNoteSuppressClick = false; }, 0);
        }
        const finalRect = panel.getBoundingClientRect();
        const edgeDistance = Math.min(finalRect.left, window.innerWidth - finalRect.right);
        if (edgeDistance <= 72) {
          foyerQuickNoteDockSide = finalRect.left < window.innerWidth / 2 ? "left" : "right";
          const x = foyerQuickNoteDockSide === "left" ? 10 : window.innerWidth - panel.offsetWidth - 10;
          positionFoyerQuickNote(panel, { x, y: finalRect.top });
        }
        if (!moved && handle.matches("[data-quick-note-launch]")) setFoyerQuickNoteOpen(true);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });
  });
}

function setFoyerQuickNoteOpen(open) {
  foyerQuickNoteOpen = Boolean(open);
  const layer = document.querySelector("[data-foyer-note-layer]");
  const panel = layer?.querySelector(".foyer-quick-note");
  layer?.classList.toggle("is-open", foyerQuickNoteOpen);
  panel?.classList.toggle("is-open", foyerQuickNoteOpen);
  panel?.querySelector(".quick-note-dock")?.setAttribute("aria-expanded", String(foyerQuickNoteOpen));
  if (panel) {
    initFoyerQuickNoteDrag(panel);
    window.requestAnimationFrame(() => positionFoyerQuickNote(panel));
  }
  if (foyerQuickNoteOpen) window.setTimeout(() => panel?.querySelector("textarea")?.focus(), 220);
}
function closeFoyerQuickNote() { setFoyerQuickNoteOpen(false); }

function foyerTemplate() {
  const hasDraft = Boolean(quickNoteDraft("foyer").text.trim() || quickNoteDraft("foyer").images.length);
  window.setTimeout(() => {
    const panel = document.querySelector(".foyer-quick-note");
    initFoyerQuickNoteDrag(panel);
    positionFoyerQuickNote(panel);
  }, 0);
  return `<section class="foyer foyer-exhibition" aria-label="${LIGHT_PRESENTATION ? "展览展廊" : "3D 横向观展画廊"}">
    <button type="button" class="foyer-back" data-action="back-to-exhibition" aria-label="返回主页展览段"><span aria-hidden="true">←</span> 返回</button>
    ${LIGHT_PRESENTATION ? lightFoyerMarkup() : `<iframe
      class="foyer-exhibition__frame"
      src="./gallery3d/index.html?v=20260819-35"
      title="3D 横向观展画廊"
      allow="fullscreen"
      referrerpolicy="no-referrer"
    ></iframe>`}
    <div class="foyer-note-layer${foyerQuickNoteOpen ? " is-open" : ""}" data-foyer-note-layer>
      <button type="button" class="foyer-note-backdrop" data-action="quick-note-close" aria-label="收起展廊随笔"></button>
      <aside class="foyer-quick-note${foyerQuickNoteOpen ? " is-open" : ""}" data-dock-side="${foyerQuickNoteDockSide}" aria-label="展廊随笔输入">
        <div class="quick-note-dock${hasDraft ? " has-draft" : ""}" data-quick-note-launch data-quick-note-drag role="button" tabindex="0" aria-label="展开展廊随笔；可拖动" aria-expanded="${foyerQuickNoteOpen}">
          <span class="quick-note-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
          <strong>展廊随笔</strong><i class="quick-note-draft-dot" aria-hidden="true"></i><span class="quick-note-expand" aria-hidden="true">⌄</span>
        </div>
        <div class="quick-note-modal">
          <header class="quick-note-windowbar" data-quick-note-drag>
            <span class="quick-note-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
            <b>展廊随笔</b>
            <button type="button" data-action="quick-note-close" aria-label="收起展廊随笔">−</button>
          </header>
          ${quickNoteMarkup("foyer", { label: "展廊随笔", placeholder: "在看展时，写下此刻的想法…", exhibitChip: true })}
        </div>
      </aside>
    </div>
  </section>`;
}

function lightFoyerMarkup() {
  if (PRIVATE_WORKSPACE) return `<div class="light-exhibition-room"><header><p class="eyebrow">你的个人展览</p><h1>你的个人展览</h1><p>从留下的材料开始，慢慢看见它们之间的联系。</p></header>${liveGalleryTemplate()}</div>`;
  return `<div class="light-exhibition-room"><header><p class="eyebrow">私人展览 · 001</p><h1>${escapeHtml(exhibitionFixture.title)}</h1><p>${escapeHtml(exhibitionFixture.subtitle)}</p></header><div class="light-exhibition-chapters">${exhibitionFixture.rooms.map(room => `<section class="light-exhibition-chapter"><div class="light-chapter-heading"><span>${room.number}</span><div><h2>${escapeHtml(room.title)}</h2><p>${escapeHtml(room.prompt)}</p></div></div><div class="light-exhibition-cards">${room.exhibits.map(exhibit => `<button type="button" class="light-exhibit-card" data-action="switch-exhibit-detail" data-exhibit="${escapeHtml(exhibit.id)}">${exhibit.image ? `<img src="${escapeHtml(exhibit.image)}" alt="${escapeHtml(exhibit.title)}" loading="lazy">` : `<div class="light-exhibit-type" aria-hidden="true">${exhibit.media === "interface" ? "界" : "藏"}</div>`}<div><small>${escapeHtml(exhibit.platform)}</small><h3>${escapeHtml(exhibit.title)}</h3><p>${escapeHtml(exhibit.description)}</p><span>查看完整展品与解读 ↗</span></div></button>`).join("")}</div><div class="light-chapter-connection"><span>为什么放在一起</span><p>${escapeHtml(room.connection.hypothesis)}</p></div></section>`).join("")}</div><footer><p>看展时的想法，可以随时留在右下角的「展廊随笔」里。</p><button class="enter-button" data-action="finale">看完后，留一点思考 →</button></footer></div>`;
}
function mediaTemplate(exhibit) { return exhibit.image ? `<img src="${exhibit.image}" alt="${exhibit.title}" />` : `<div class="artifact-visual artifact-${exhibit.media}" aria-hidden="true"><i></i><i></i><i></i><span>${exhibit.id.slice(0, 2).toUpperCase()}</span></div>`; }
function exhibitTemplate(exhibit, index, room) {
  const viewed = exhibitionState()?.viewed ?? [];
  return `<article class="discovery-card ${viewed.includes(exhibit.id) ? "is-viewed" : ""}"><div class="discovery-media">${mediaTemplate(exhibit)}</div><div class="discovery-copy"><p class="exhibit-index">${String(index + 1).padStart(2, "0")} / 02 · ${exhibit.platform}</p><h2>${exhibit.title}</h2><p>${exhibit.description}</p><details class="evidence"><summary>查看证据定位</summary><b>${exhibit.evidence}</b></details></div><div class="card-actions">${index > 0 ? `<button class="quiet-action" data-action="previous-exhibit">← 上一件</button>` : `<span></span>`}<button class="keep-action" data-action="advance-exhibit" data-exhibit="${exhibit.id}">${index === room.exhibits.length - 1 ? "看看它们为何相遇" : "保留，继续漫游"} <b>→</b></button></div></article>`;
}
function connectionTemplate(room) {
  const progress = exhibitionState();
  const canReveal = room.exhibits.every((item) => progress.viewed.includes(item.id));
  const revealed = progress.revealed.includes(room.connection.id);
  if (!canReveal) return `<div class="connection-lock"><p>看完两件展品后，这里的策展连接才会显现。</p></div>`;
  if (!revealed) return `<button class="connection-trigger" data-action="reveal" data-connection="${room.connection.id}"><span>一条连接正在形成</span>为什么把它们放在一起？ <b>＋</b></button>`;
  const feedback = state().feedback[room.connection.id];
  return `<section class="connection-card ${feedback?.disputed ? "is-disputed" : ""}"><p class="connection-label">${room.connection.label}${feedback?.disputed ? " · 用户认为牵强" : ""}</p><div class="connection-sides"><p><span>A</span>${room.connection.sideA}</p><p><span>B</span>${room.connection.sideB}</p></div><div class="connection-line"><i></i><em>共同结构</em><i></i></div><blockquote>${room.connection.hypothesis}</blockquote><div class="feedback" aria-label="评价这条连接">${["有共鸣", "没想到", "有点牵强", "另一种联系"].map((label) => `<button class="${feedback?.value === label ? "selected" : ""}" data-action="feedback" data-connection="${room.connection.id}" data-value="${label}">${label}</button>`).join("")}</div>${feedback?.value === "另一种联系" ? `<form class="correction-form" data-form="correction" data-connection="${room.connection.id}"><label>你看到的联系</label><div><input name="correction" value="${escapeHtml(feedback.correction ?? "")}" placeholder="写下一句自己的解释"/><button type="submit">保存</button></div></form>` : ""}</section>`;
}
function roomTemplate() {
  const room = currentRoom(); const index = state().ui.roomIndex; const progress = exhibitionState();
  const bothViewed = room.exhibits.every((item) => progress.viewed.includes(item.id)); const connectionSeen = progress.revealed.includes(room.connection.id); const active = room.exhibits[state().ui.exhibitIndex];
  return `<section class="room serendipity-stage room-${room.id}"><header class="serendipity-header"><button class="room-label" data-action="foyer">${room.number} · ${room.title}</button><div class="journey-dots" aria-label="展览进度">${exhibitionFixture.rooms.map((_, i) => `<i class="${i === index ? "active" : ""}"></i>`).join("")}</div><p>${room.environment}</p></header>${!bothViewed ? `<div class="card-orbit">${exhibitTemplate(active, state().ui.exhibitIndex, room)}<div class="next-card-peek" aria-hidden="true"></div></div>` : connectionTemplate(room)}${connectionSeen && room.echo ? `<p class="echo">${room.echo}</p>` : ""}${connectionSeen ? `<div class="room-exit"><button class="enter-button" data-action="${index === 2 ? "finale" : "room"}" ${index < 2 ? `data-room="${index + 1}"` : ""}>${index === 2 ? "前往温室" : "进入下一环境"} <b>→</b></button></div>` : ""}</section>`;
}
function finaleTemplate() {
  const responses = Object.keys(state().feedback).length;
  return `<section class="finale scene-stage"><div class="greenhouse" aria-hidden="true"><i></i><i></i><i></i><i></i></div><p class="eyebrow">尾厅</p><h1>系统退后之后</h1><p class="finale-copy">这六件收藏没有给出统一答案。它们只形成一项仍可被你否定的假设：你可能正在关注如何设计一种有能力但不喧宾夺主、能自动行动但仍把解释权和最终判断留给人的系统。</p><blockquote>在你理想的 智能产品里，系统应该在哪些时刻主动退后，又应该在哪些时刻明确让你感到责任机制仍然在场？</blockquote><p class="response-count">你为 ${responses} 条连接留下了回应。</p><div class="finale-actions"><button class="quiet-action" data-action="gallery">返回个人展览</button></div></section>`;
}

function recordsTemplate() {
  const records = [...state().exhibitionRecords].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return `<section class="records-page workspace-page"><header class="records-hero"><p class="eyebrow">思考手记</p><h1>思考手记</h1><p>留住展览结束后，仍在心里回响的部分。</p></header>${records.length ? `<div class="records-grid">${records.map((record) => `<article class="record-card">${record.images?.[0] ? `<img src="${record.images[0]}" alt=""/>` : `<div class="record-card-placeholder" aria-hidden="true">✦</div>`}<div><p>${new Date(record.updatedAt).toLocaleDateString("zh-CN")}</p><h2>${escapeHtml(record.exhibitionTitle)}</h2><blockquote>${escapeHtml(record.content || "只留下了图片。")}</blockquote></div></article>`).join("")}</div>` : `<div class="records-empty"><span>○</span><h2>还没有留下想法</h2><p>完整看完一场展览后，可以在结束页写下仍在回响的部分。</p><button class="enter-button" data-action="gallery">去个人展览看展 <b>→</b></button></div>`}</section>`;
}

function studioBlockTypeLabel(type) {
  return { opinion: "个人观点", essay: "随笔片段", concept: "智能产品概念", question: "待探索问题" }[type] ?? type;
}
function noteSummary(note) {
  const first = note.blocks?.[0]?.text ?? "";
  return first.length > 66 ? `${first.slice(0, 66)}…` : first;
}
// 长卷单个论断场景（Noomo 式）：无框，文字直接浮在背景上，左右交替出现；
// kicker 小字（类型色点 + 来源）+ 正文大段；正文为阅读态 <p>（点击就地编辑）。
function studioBlockHtml(block, index, noteId) {
  const mine = !block.ai;
  const side = index % 2 === 0 ? "right" : "left";   // 视频节奏：右 → 左 → 右 → 左
  return `<div class="scene block ${mine ? "is-mine" : "is-ai"}" data-type="${block.type}" data-side="${side}" data-note="${escapeHtml(noteId)}" data-block="${index}">
    <p class="scene-kicker"><span class="scene-dot" aria-hidden="true"></span>${escapeHtml(studioBlockTypeLabel(block.type))}<span class="scene-sep"> · </span><span class="block__provenance">${mine ? "我的内容" : "策展人草稿 · 可改写"}</span></p>
    <p class="block__body" data-action="edit-block" data-note="${escapeHtml(noteId)}" data-block="${index}" role="button" tabindex="0">${studio.simple ? escapeHtml(block.text) : serendipityCharSpans(block.text)}</p>
  </div>`;
}
// 若该手记还没有长期主题，按其展览建一个"正在形成"的主题；返回是否新建。失焦自动保存与「保存手记」按钮两路共用，避免逻辑漂移。
function ensureThemeForNote(draft, note) {
  if (draft.themes.some((t) => t.noteId === note.id)) return false;
  draft.themes.push({ id: `theme-${note.exhibitionId}`, title: note.exhibitionTitle || "正在形成的主题", status: "forming", evidenceCount: 6, exhibitionId: note.exhibitionId, noteId: note.id });
  return true;
}
// 手记操作区：草稿态（保存手记 / 继续看展）与已保存态（继续编辑 + 已计入资产）。模板与就地保存后的 DOM 补丁共用。
function editorActionsHtml(note) {
  const id = escapeHtml(note.id);
  if (note.status === "saved") {
    return `<div class="editor-actions">
      <button class="btn btn--ghost" data-action="add-studio-block" data-note="${id}">＋ 新增一段</button>
      <button class="btn btn--ghost" data-action="save-studio-note" data-note="${id}">继续编辑</button>
      <span class="saved-stamp hint">已计入你的个人资产</span>
    </div>`;
  }
  return `<div class="editor-actions">
    <button class="btn btn--ghost" data-action="add-studio-block" data-note="${id}">＋ 新增一段</button>
    <button class="btn btn--primary" data-action="save-studio-note" data-note="${id}">保存手记 <b>→</b></button>
    <button class="btn btn--ghost" data-action="gallery">继续在个人展览看展</button>
    <span class="hint">保存前不会被记为你的个人资产</span>
  </div>`;
}
// 单张手记 = 一段滚动叙事（Noomo 式）：标题场景（居中）→ 论断场景（左右交替）→ 脚注/关联/操作（居中）。
function noteCardTemplate(note, noteIndex = 0) {
  const theme = state().themes.find((t) => t.noteId === note.id);
  const saved = note.status === "saved";
  const dateLabel = note.updatedAt ? note.updatedAt.slice(0, 10) : "";
  const exhibition = escapeHtml(note.exhibitionTitle || "");
  const citationCount = (note.citations || []).length;
  const blocks = (note.blocks || []).map((block, i) => studioBlockHtml(block, i, note.id)).join("");
  const footnotes = (note.citations || []).map((c, i) => `<li><b>${i + 1}</b><span>${escapeHtml(c)}</span><i> · ${escapeHtml(note.exhibitionTitle || "展览展品")}</i></li>`).join("");
  // 标题场景与正文一样在侧边滚动出现（第一份左侧，之后左右交替），避免被误读为页面大标题
  const titleSide = noteIndex % 2 === 0 ? "left" : "right";
  return `<article class="studio-note" id="note-${escapeHtml(note.id)}" data-note="${escapeHtml(note.id)}">
    <div class="scene scene--title" data-side="${titleSide}">
      <p class="eyebrow studio-note__status"><span class="dot" aria-hidden="true"></span>思考手记 · ${saved ? `已保存${dateLabel ? ` · ${dateLabel}` : ""}` : "草稿 · 未保存"} · ${exhibition}</p>
      <h1>${studio.simple ? escapeHtml(note.title) : serendipityCharSpans(note.title)}</h1>
      <div class="scene-rule" aria-hidden="true"></div>
      <p class="sub studio-note__sub">来自展览「${exhibition}」。这里是<em>你的创作空间</em>——写下你自己的总结与观点；策展人给出的只是可改写的候选，${saved ? "它已是你的个人资产。" : "保存后才会成为你的个人资产。"}</p>
      <div class="meta">
        <span>来源展览 <b>${exhibition}</b></span>
        <span>引用 <b>${citationCount} 条</b></span>
        <span class="studio-note__meta-status">${saved ? "已保存" : "草稿"}</span>
      </div>
    </div>
    ${!saved ? `<div class="scene co-canvas" data-side="center"><span class="pill">协作画布</span><span>策展人基于这场展览起草了候选块。<b>把它们改写成你自己的话</b>，或直接新增你的一段总结与观点。</span></div>` : ""}
    ${blocks}
    ${citationCount ? `<div class="scene footnotes" data-side="center"><p class="footnotes__title">引用依据</p><ol>${footnotes}</ol></div>` : ""}
    ${theme ? `<div class="scene garden-link" data-side="center"><span class="sprout" aria-hidden="true">↗</span><p>这篇手记已关联长期主题 <b>「${escapeHtml(theme.title)}」</b>，主题${theme.status === "forming" ? "正在形成" : "已确认"}。</p></div>` : ""}
    <div class="scene scene--end" data-side="center">${editorActionsHtml(note)}<p class="studio-note__hint">${saved ? "点击任意段落仍可继续修改" : "点击任意段落就地编辑 · 失焦自动保存"}</p></div>
  </article>`;
}
// Studio = Noomo 式滚动叙事：空态（空相框）或章节堆叠；中央发光物体 + 垂直光束固定浮层。
function studioTemplate() {
  const aura = `<div class="studio-aura" aria-hidden="true"><i class="studio-aura__beam"></i><i class="studio-aura__core"></i></div>`;
  const notes = state().studioNotes;
  if (!notes.length) {
    return `${pageSceneTemplate("studio")}<section class="studio-scroll studio-empty">${aura}
      <div class="studio-empty-body">
        <p class="eyebrow"><span class="dot" aria-hidden="true"></span>思考之室</p>
        <div class="frame" aria-hidden="true"></div>
        <h1 class="studio-empty-title">这里还没有<br/>个人手记。</h1>
        <p class="lede">完整看完一场展览后，由你明确选择是否留下记录。</p>
        <div class="actions">
          <button class="btn btn--primary" data-action="gallery">前往个人展览 <b>→</b></button>
        </div>
      </div>
    </section>`;
  }
  const cards = notes.map((note, i) => noteCardTemplate(note, i)).join("");
  return `${pageSceneTemplate("studio")}<section class="studio-scroll">${aura}${cards}</section>`;
}
// Studio 挂载：IntersectionObserver 让 .reveal 卡片进入视口时浮现。simple 时全部立显。
function mountStudioReveal() {
  const root = document.querySelector(".studio-scroll");
  if (!root) return;
  const reveals = root.querySelectorAll(".reveal");
  if (studio.simple || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-visible"));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      }
    }, { threshold: 0.15, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach((el) => io.observe(el));
    studio.io = io;
  }
  // create-note 后定位到指定手记卡（studioNoteId 仅作定位标记，用完即清）
  const focusId = state().ui.studioNoteId;
  if (focusId) {
    const el = root.querySelector(`#note-${CSS.escape(focusId)}`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: studio.simple ? "auto" : "smooth", block: "start" }));
    store.update((draft) => { draft.ui.studioNoteId = null; });
  }
}

// Studio 滚动焦点（Noomo 式场景叙事）：滚动位置驱动每个 .scene 的焦点 f∈[0,1]
// （场景中心距阅读线的归一化距离）。一屏一块：离开阅读线即模糊/淡出，
// 聚焦场景内标题逐字升起、副标/正文逐行浮现；回滚全部倒放。
// 逐字 scrub 与缓动直接复用 serendipity 的纯函数（serendipityClamp01/BackInOut/Smoothstep）。
// 简单模式（prefers-reduced-motion）退化为 mountStudioReveal 静态浮现。
let studioScrollScenes = [];
let studioScrollTicking = false;
function studioOnScroll() {
  if (studioScrollTicking) return;
  studioScrollTicking = true;
  requestAnimationFrame(() => { updateStudioFocus(); studioScrollTicking = false; });
}
function updateStudioFocus() {
  const vh = window.innerHeight || 1;
  const lineY = vh * 0.42;            // 阅读线（略高于视口中心）
  const fade = vh * 0.45;             // 场景中心离开阅读线约 0.45 屏外完全失焦（一屏一块）
  for (const scene of studioScrollScenes) {
    if (!scene.isConnected) continue;
    const r = scene.getBoundingClientRect();
    const center = r.top + r.height / 2;
    const dist = Math.abs(center - lineY);
    let f = serendipityClamp01(1 - dist / fade);
    // 场景内文字入场窗口对齐 ScrollFloat 的 scrollStart/scrollEnd：
    // start = center bottom+=50%（场景中心在视口底外 0.5 屏）→ end = bottom bottom-=40%（场景底在视口底上 0.4 屏）。
    // 窗口约 1.38 屏高；入场可见性与逐字级联同步亮起，回滚时倒放。
    const enterP = serendipityClamp01((vh * 1.02 - r.top) / (vh * 1.38));
    const fadeIn = serendipitySmoothstep(enterP / 0.6);
    f = Math.max(f, fadeIn);
    if (studio.editing && studio.editing.noteId === scene.dataset.note && scene.classList.contains("is-editing")) f = 1;
    scene.style.setProperty("--scene-focus", f.toFixed(3));
    scene.classList.toggle("is-focused", f > 0.55);
    scrubSceneText(scene, enterP);
  }
}
// 场景内文字 scrub，按 ScrollFloat 的纵向浮起（标题与论断正文共用同一套参数）：
// 每字从 opacity 0、yPercent 120、scaleY 2.3（transformOrigin 50% 0%）
// 升起为 opacity 1、yPercent 0、scaleY 1，缓动 back.inOut(2)、stagger 0.03，
// 随滚动 scrub（回滚即倒放）。不带动画 scaleX/translateX，避免文字左右晃。
// 副标/meta/kicker 按行级同曲线浮起。
function scrubSceneText(scene, p) {
  const editing = !!(studio.editing && studio.editing.noteId === scene.dataset.note && scene.classList.contains("is-editing"));
  const applyFloat = (root, stagger = 0.03) => {
    const chars = root.querySelectorAll(".char");
    const n = chars.length;
    if (!n) return false;
    const duration = 0.72;                  // 单字动画时长（相对滚动窗口）
    const total = duration + stagger * Math.max(0, n - 1);
    const q = serendipityClamp01(p / 0.8);  // 场景聚焦（阅读线）时全部落定
    const t = q * total;
    chars.forEach((ch, k) => {
      const cp = serendipityClamp01((t - stagger * k) / duration);
      const e = editing ? 1 : serendipityBackInOut(cp);
      ch.style.opacity = String(serendipityClamp01(e));
      ch.style.transform = `translateY(${((1 - e) * 120).toFixed(2)}%) scaleY(${(1 + (1 - e) * 1.3).toFixed(3)})`;
      ch.style.transformOrigin = "50% 0%";
    });
    return true;
  };
  const title = scene.querySelector("h1");
  if (title) applyFloat(title, 0.03);
  // 论断正文同样逐字浮起；编辑态 textarea 无 .char，保持全显
  const body = scene.querySelector(".block__body");
  const bodyFloated = body ? applyFloat(body, 0.03) : true;
  // 副标 / meta / kicker 行级浮起（同 back.inOut 曲线，位移更克制）
  const lines = [scene.querySelector(".studio-note__sub"), scene.querySelector(".meta"), scene.querySelector(".scene-kicker"), bodyFloated ? null : body];
  lines.forEach((el, k) => {
    if (!el) return;
    const le = editing ? 1 : serendipityBackInOut(serendipityClamp01((p - 0.05 - k * 0.07) / 0.5));
    el.style.opacity = String(le);
    el.style.transform = `translateY(${((1 - le) * 34).toFixed(2)}px)`;
  });
}
function refreshStudioFocus() {
  if (studioScrollScenes.length) updateStudioFocus();
}
function mountStudioScroll() {
  const root = document.querySelector(".studio-scroll");
  if (!root) return;
  studioScrollScenes = [...root.querySelectorAll(".scene")];
  if (studio.simple || !("IntersectionObserver" in window) || !studioScrollScenes.length) {
    mountStudioReveal();
    return;
  }
  updateStudioFocus();
  window.addEventListener("scroll", studioOnScroll, { passive: true });
  window.addEventListener("resize", studioOnScroll);
  studio.scrollCleanup = () => {
    window.removeEventListener("scroll", studioOnScroll);
    window.removeEventListener("resize", studioOnScroll);
    studio.scrollCleanup = null;
  };
  // create-note 后定位到指定手记卡（studioNoteId 仅作定位标记，用完即清）
  const focusId = state().ui.studioNoteId;
  if (focusId) {
    const el = root.querySelector(`#note-${CSS.escape(focusId)}`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
    store.update((draft) => { draft.ui.studioNoteId = null; });
  }
}

// 就地编辑：点击阅读态 <p> → 替换为 textarea；失焦/Cmd+Enter/Escape 提交 → 局部更新 DOM（不 re-render，避免滚动跳动）。
function beginBlockEdit(body) {
  if (studio.editing) return;
  const noteId = body.dataset.note;
  const blockIndex = Number(body.dataset.block);
  const block = body.closest(".block");
  if (!noteId || !block) return;
  const ta = document.createElement("textarea");
  ta.className = "block__body is-editing";
  ta.value = body.textContent;
  ta.rows = 3;
  ta.dataset.note = noteId;
  ta.dataset.block = String(blockIndex);
  body.replaceWith(ta);
  block.classList.add("is-editing");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  studio.editing = { noteId, blockIndex };
  refreshStudioFocus();
}

function commitBlockEdit(ta) {
  if (!studio.editing) return;
  const noteId = ta.dataset.note;
  const blockIndex = Number(ta.dataset.block);
  const val = (ta.value || "").trim();
  const block = ta.closest(".block");
  const newText = val || ta.value;
  let becameMine = false;
  let wasDraft = false;
  let insertGarden = false;
  let cancelledEmpty = false;
  store.update((draft) => {
    const note = draft.studioNotes.find((n) => n.id === noteId);
    if (!note) return;
    const blk = note.blocks?.[blockIndex];
    if (!blk) return;
    // 新增但未填写：当作取消，移除空块，不改变手记状态
    if (!val && !blk.text) {
      note.blocks.splice(blockIndex, 1);
      note.body = (note.blocks || []).map((b) => b.text).join("\n\n");
      cancelledEmpty = true;
      return;
    }
    if (val && val !== blk.text) {
      blk.text = val;
      if (blk.ai) { blk.ai = false; becameMine = true; }
    }
    wasDraft = note.status !== "saved";
    note.status = "saved";
    note.updatedAt = new Date().toISOString();
    note.body = (note.blocks || []).map((b) => b.text).join("\n\n");
    if (wasDraft && ensureThemeForNote(draft, note)) insertGarden = true;
  });
  if (cancelledEmpty) {
    if (block) block.remove();
    studio.editing = null;
    refreshStudioFocus();
    return;
  }
  const p = document.createElement("p");
  p.className = "block__body";
  p.dataset.action = "edit-block";
  p.dataset.note = noteId;
  p.dataset.block = String(blockIndex);
  p.setAttribute("role", "button");
  p.setAttribute("tabindex", "0");
  p.innerHTML = studio.simple ? escapeHtml(newText) : serendipityCharSpans(newText);
  ta.replaceWith(p);
  if (block) {
    block.classList.remove("is-editing");
    if (becameMine) {
      block.classList.remove("is-ai");
      block.classList.add("is-mine");
      const prov = block.querySelector(".block__provenance");
      if (prov) prov.textContent = "我写的";
    }
  }
  const card = document.querySelector(`.studio-note[data-note="${noteId}"]`);
  if (card && wasDraft) patchNoteSaved(card, noteId, { insertGarden });
  studio.editing = null;
  refreshStudioFocus();
}

// 保存后局部更新手记卡（草稿态 → 已保存态）：状态行、meta、协作画布、操作区、提示与长期主题关联条。
function patchNoteSaved(card, noteId, { insertGarden } = {}) {
  const note = state().studioNotes.find((n) => n.id === noteId);
  const date = (note?.updatedAt || new Date().toISOString()).slice(0, 10);
  const exhibition = escapeHtml(note?.exhibitionTitle || "");
  const status = card.querySelector(".studio-note__status");
  if (status) status.innerHTML = `<span class="dot" aria-hidden="true"></span>思考手记 · 已保存 · ${date} · ${exhibition}`;
  const metaStatus = card.querySelector(".studio-note__meta-status");
  if (metaStatus) metaStatus.textContent = "已保存";
  const sub = card.querySelector(".studio-note__sub");
  if (sub) sub.innerHTML = sub.innerHTML.replace("保存后才会成为你的个人资产。", "它已是你的个人资产。");
  card.querySelector(".co-canvas")?.remove();
  const actions = card.querySelector(".editor-actions");
  if (actions) actions.outerHTML = editorActionsHtml(note);
  const hint = card.querySelector(".studio-note__hint");
  if (hint) hint.textContent = "点击任意段落仍可继续修改";
  if (insertGarden) {
    const theme = state().themes.find((t) => t.noteId === noteId);
    const gardenHtml = `<div class="garden-link reveal is-visible"><span class="sprout" aria-hidden="true">↗</span><p>这篇手记已关联长期主题 <b>「${escapeHtml(theme?.title || "正在形成的主题")}」</b>，主题正在形成。</p></div>`;
    const anchor = card.querySelector(".editor-actions") ?? card.querySelector(".studio-note__hint");
    anchor?.insertAdjacentHTML("beforebegin", gardenHtml);
  }
}

function render() {
  const view = state().ui.view;
  document.body.classList.remove("modal-open");
  document.body.classList.toggle("collection-open", view === "collection");
  document.body.classList.toggle("serendipity-open", view === "serendipity" && !serendipity.simple);
  document.body.classList.toggle("home-scroll-open", view === "inbox" || (view === "collection" && state().ui.collectionFrom === "inbox"));
  document.body.classList.remove("inbox-scene-open");
  document.body.classList.toggle("inbox-all-open", view === "inbox" && inboxView.mode === "all");
  document.body.classList.toggle("notes-all-open", view === "inbox" && notesAllOpen);
  if (inboxGrainientCleanup) { inboxGrainientCleanup(); inboxGrainientCleanup = null; }
  if (inboxInfiniteCleanup) inboxInfiniteCleanup();
  if (inboxTextPressureCleanup) { inboxTextPressureCleanup(); inboxTextPressureCleanup = null; }
  if (inboxFormaTextPressureCleanup) { inboxFormaTextPressureCleanup(); inboxFormaTextPressureCleanup = null; }
  if (notesAllFormaTextPressureCleanup) { notesAllFormaTextPressureCleanup(); notesAllFormaTextPressureCleanup = null; }
  if (recommendGalleryCleanup) { recommendGalleryCleanup(); recommendGalleryCleanup = null; }
  focusedRecommendCard = null;
  if (inboxLayeredCleanup) { inboxLayeredCleanup(); inboxLayeredCleanup = null; }
  if (inboxScene3DCleanup) { inboxScene3DCleanup(); inboxScene3DCleanup = null; }
  if (collectionImmersiveCleanup) { collectionImmersiveCleanup(); collectionImmersiveCleanup = null; }
  if (homeScrollCleanup) homeScrollCleanup();
  if (homeFloatCleanup) homeFloatCleanup();
  if (homeTransitionCleanup) homeTransitionCleanup();
  if (homeMotionCleanup) homeMotionCleanup();
  if (homeRecordParallaxCleanup) homeRecordParallaxCleanup();
  if (homeRecordTimelineCleanup) homeRecordTimelineCleanup();
  if (galleryElasticCleanup) galleryElasticCleanup();
  if (serendipity.raf) { cancelAnimationFrame(serendipity.raf); serendipity.raf = 0; }
  if (studio.io) { studio.io.disconnect(); studio.io = null; }
  if (studio.scrollCleanup) { studio.scrollCleanup(); }
  if (galaxyCleanup) { galaxyCleanup(); galaxyCleanup = null; }
  if (noomoCleanup) { noomoCleanup(); noomoCleanup = null; }
  setScene(["foyer", "room", "finale"].includes(view) ? (view === "room" ? currentRoom().id : view) : view === "collection" ? "inbox" : view === "serendipity" ? "gallery" : view === "inbox" ? "home" : view);
  const templates = { inbox: inboxTemplate, gallery: galleryTemplate, records: recordsTemplate, serendipity: serendipityTemplate, foyer: foyerTemplate, room: roomTemplate, finale: finaleTemplate, collection: collectionViewTemplate };
  const restoreCaptureFocus = LIGHT_PRESENTATION && document.body.dataset.lightPage === (state().ui.lightPage || "home")
    && document.activeElement?.matches('[data-action="toggle-capture"]');
  app.innerHTML = templates[view]?.() ?? inboxTemplate();
  if (LIGHT_PRESENTATION) lightWorkspace.syncShell(state(), galleryArchiveItems());
  applyLightPage();
  if (restoreCaptureFocus && document.activeElement === document.body) focusCaptureTrigger();
  if (LIGHT_PRESENTATION) document.body.classList.remove("home-motion-ready");
  document.body.classList.remove("app-booting");
  updateNavigation();
  if (LIGHT_PRESENTATION) DESKTOP_WORKSPACE?.onWorkspaceRender?.();
  const brandStrong = document.querySelector(".brand strong");
  if (brandStrong) brandStrong.textContent = "Folio";
  requestAnimationFrame(() => {
    layoutCollectionGrid();
    if (LIGHT_PRESENTATION) lightWorkspace.applyWorkspaceFilters();
    if (pendingScrollTop !== null) {
      const previousScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo({ top: pendingScrollTop, behavior: "auto" });
      window.requestAnimationFrame(() => { document.documentElement.style.scrollBehavior = previousScrollBehavior; });
      pendingScrollTop = null;
    }
    if ((view === "inbox" || view === "collection") && inboxView.mode === "all") applyInboxFilters();
    if (view === "gallery") applyGalleryFilters();
    if (view === "serendipity") mountSerendipity();
    if (view === "inbox") mountHomeScrollSpy();
    if (view === "inbox") mountHomeScrollFloat();
    if (view === "inbox") mountHomeScrollVelocity();
    if (view === "inbox") mountHomeTransitionMotion();
    if (view === "inbox") mountHomeSectionMotion();
    if (view === "inbox") mountHomeRecordParallax();
    if (view === "inbox") mountHomeRecordTimeline();
    if (view === "inbox") mountGalleryElasticHover();
    if ((view === "inbox" || view === "collection") && inboxView.mode === "all") mountInboxGrainient();
    if (view === "collection") { mountCollectionImmersive(); mountCollectionRelatedScroll(); }
    if ((view === "inbox" || view === "collection") && inboxView.mode === "all") mountInboxFormaTextPressure();
    if (view === "inbox" && notesAllOpen) mountNotesAllFormaTextPressure();
    if (view === "inbox") mountRecommendGallery();
    if (view === "foyer") setFoyerQuickNoteExhibit(foyerQuickNoteExhibit?.id || "", foyerQuickNoteExhibit?.title || "");
    bindSpecular();
  });
}

function mountCollectionRelatedScroll() {
  const scroller = document.querySelector("[data-related-scroll]");
  if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
  scroller.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    scroller.scrollLeft += event.deltaY;
  }, { passive: false });
}

function mountCollectionImmersive() {
  if (LIGHT_PRESENTATION) return;
  const root = document.querySelector(".collection-immersive");
  if (!root) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hero = root.querySelector(".collection-immersive__hero");
  const sequence = root.querySelector(".collection-immersive__sequence");
  const cardObject = root.querySelector(".collection-immersive__object");
  const finale = root.querySelector(".collection-immersive__finale");
  let raf = 0;
  let pointerRaf = 0;
  let disposed = false;
  const raw = { heroX: 50, heroY: 46, finalX: 50, finalY: 50 };
  const smooth = { ...raw };
  window.scrollTo({ top: 0, behavior: "auto" });

  const updateScroll = () => {
    raf = 0;
    const sequenceTop = sequence?.offsetTop || 0;
    const sequenceRange = Math.max(1, (sequence?.offsetHeight || window.innerHeight) - window.innerHeight);
    const progress = Math.max(0, Math.min(1, (window.scrollY - sequenceTop) / sequenceRange));
    // The same card must visibly transform throughout the journey. A late start made
    // the first third read as a static hero and hid the intended scroll choreography.
    const transformStart = 0.04;
    const transformProgress = Math.max(0, Math.min(1, (progress - transformStart) / (1 - transformStart)));
    const eased = transformProgress * transformProgress * (3 - 2 * transformProgress);
    const intro = Math.max(0, Math.min(1, (progress - 0.12) / 0.27));
    const finalOpacity = Math.max(0, Math.min(1, (progress - 0.68) / 0.2));
    root.style.setProperty("--detail-progress", progress.toFixed(4));
    root.style.setProperty("--hero-opacity", (1 - intro).toFixed(4));
    root.style.setProperty("--hero-shift", `${(-30 * intro).toFixed(2)}px`);
    root.style.setProperty("--hero-scale", (1 + 0.08 * progress).toFixed(4));
    root.style.setProperty("--grid-opacity", (0.09 - 0.06 * intro).toFixed(4));
    root.style.setProperty("--cue-opacity", (1 - Math.min(1, progress * 4)).toFixed(4));
    root.style.setProperty("--card-rotate", `${(90 - 108 * eased).toFixed(2)}deg`);
    root.style.setProperty("--card-scale", (0.72 + 1.18 * eased).toFixed(4));
    root.style.setProperty("--card-x", `${(50 + 4 * eased).toFixed(2)}%`);
    root.style.setProperty("--card-y", `${(45 + 2 * eased).toFixed(2)}%`);
    root.style.setProperty("--card-glow", (0.22 + 0.78 * eased).toFixed(4));
    root.style.setProperty("--shine-x", `${(-90 + 170 * eased).toFixed(2)}%`);
    root.style.setProperty("--card-reveal", finalOpacity.toFixed(4));
    root.style.setProperty("--final-opacity", finalOpacity.toFixed(4));
    root.style.setProperty("--bg-reveal-opacity", (0.72 - 0.35 * progress).toFixed(4));
  };
  const onScroll = () => {
    if (!raf) raf = requestAnimationFrame(updateScroll);
  };
  const localPoint = (element, event) => {
    const rect = element?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return [50, 50];
    return [
      Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    ];
  };
  const onPointerMove = (event) => {
    [raw.heroX, raw.heroY] = localPoint(hero, event);
    [raw.finalX, raw.finalY] = localPoint(cardObject || finale, event);
  };
  const animatePointer = () => {
    if (disposed) return;
    smooth.heroX += (raw.heroX - smooth.heroX) * 0.1;
    smooth.heroY += (raw.heroY - smooth.heroY) * 0.1;
    smooth.finalX += (raw.finalX - smooth.finalX) * 0.1;
    smooth.finalY += (raw.finalY - smooth.finalY) * 0.1;
    root.style.setProperty("--spot-x", `${smooth.heroX.toFixed(2)}%`);
    root.style.setProperty("--spot-y", `${smooth.heroY.toFixed(2)}%`);
    root.style.setProperty("--final-spot-x", `${smooth.finalX.toFixed(2)}%`);
    root.style.setProperty("--final-spot-y", `${smooth.finalY.toFixed(2)}%`);
    pointerRaf = requestAnimationFrame(animatePointer);
  };
  root.querySelectorAll("img").forEach((image) => {
    const onError = () => image.parentElement?.classList.add("is-missing");
    image.addEventListener("error", onError, { once: true });
  });
  updateScroll();
  requestAnimationFrame(updateScroll);
  window.addEventListener("scroll", onScroll, { passive: true });
  if (!reduce) {
    root.addEventListener("pointermove", onPointerMove, { passive: true });
    pointerRaf = requestAnimationFrame(animatePointer);
  }
  collectionImmersiveCleanup = () => {
    disposed = true;
    window.removeEventListener("scroll", onScroll);
    root.removeEventListener("pointermove", onPointerMove);
    if (raf) cancelAnimationFrame(raf);
    if (pointerRaf) cancelAnimationFrame(pointerRaf);
  };
}
function mountInboxTextPressure() {
  if (LIGHT_PRESENTATION) return;
  const el = document.querySelector('.inbox-scene [data-text-pressure]');
  if (!el || el.dataset.textPressureMounted === "1") return;
  el.dataset.textPressureMounted = "1";
  const text = el.textContent.trim();
  inboxTextPressureCleanup = mountTextPressure(el, { text });
}

// Meng To WebGL lane C：桌面端把 CSS 卡升级为真实厚度的玻璃几何体；
// 小屏、减动效或 WebGL 失败时继续保留语义完整的 CSS 卡片回退。
function mountInboxWebGLCards() {
  if (LIGHT_PRESENTATION) return;
  const scene = document.querySelector(".inbox-scene");
  if (!scene?.querySelector(".scene-glass-card")) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!scene || !WEBGL_OK || reduce || window.innerWidth < 900) return;
  const { collections, extractions } = state();
  const { sample, insight, anchors } = sceneSample(collections, extractions);
  if (!sample.length) return;
  const cards = sample.map((item, index) => ({
    item,
    extraction: extractions.find((entry) => entry.collectionId === item.id),
    insight,
    anchor: anchors[index % anchors.length],
    index,
  }));
  const onScene3DFailed = () => {
    scene.classList.remove("is-webgl-scene");
  };
  scene.addEventListener("scene3d:failed", onScene3DFailed, { once: true });
  const instance = mountInboxScene3D({
    scene,
    cards,
    onOpen: (card) => {
      if (!card?.item) return;
      const inDirection = card.insight?.members?.includes(card.item.id);
      navigate("collection", {
        collectionId: card.item.id,
        collectionTag: inDirection && card.insight ? card.insight.tag : null,
        collectionMembers: inDirection && card.insight ? [...card.insight.members] : null,
        collectionFrom: state().ui.view,
      });
    },
  });
  if (!instance) {
    scene.removeEventListener("scene3d:failed", onScene3DFailed);
    return;
  }
  inboxScene3DCleanup = () => {
    scene.removeEventListener("scene3d:failed", onScene3DFailed);
    instance.dispose();
  };
}

function mountInboxLayeredScene() {
  if (LIGHT_PRESENTATION) return;
  const scene = document.querySelector(".inbox-scene");
  const stage = scene?.querySelector(".inbox-scene__stage");
  const cards = [...document.querySelectorAll(".scene-glass-card")];
  if (!scene || !stage) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let raf = 0;
  let scrollRaf = 0;
  let observer = null;
  const pointer = { x: 0, y: 0 };

  const updateScroll = () => {
    scrollRaf = 0;
    const range = Math.max(1, scene.offsetHeight - window.innerHeight);
    const progress = Math.max(0, Math.min(1, -scene.getBoundingClientRect().top / range));
    scene.style.setProperty("--scene-progress", progress.toFixed(4));
    scene.style.setProperty("--far-scale", (1 + progress * 0.06).toFixed(4));
    scene.style.setProperty("--middle-scale", (1 + progress * 0.15).toFixed(4));
    scene.style.setProperty("--near-scale", (1 + progress * 0.25).toFixed(4));
    scene.style.setProperty("--cards-scale", (1 + progress * 0.12).toFixed(4));
    scene.style.setProperty("--intro-opacity", Math.max(0, 1 - progress * 4.2).toFixed(4));
    scene.style.setProperty("--intro-shift", `${(-progress * 34).toFixed(2)}px`);
    scene.style.setProperty("--cue-opacity", Math.max(0, 1 - progress * 7).toFixed(4));
    scene.style.setProperty("--water-opacity", (0.7 - progress * 0.2).toFixed(4));
  };
  const onScroll = () => {
    if (!scrollRaf) scrollRaf = requestAnimationFrame(updateScroll);
  };
  const onMove = (e) => {
    const rect = stage.getBoundingClientRect();
    const dx = (e.clientX - (rect.left + rect.width / 2)) / rect.width;
    const dy = (e.clientY - (rect.top + rect.height / 2)) / rect.height;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const px = Math.max(-0.5, Math.min(0.5, dx));
      const py = Math.max(-0.5, Math.min(0.5, dy));
      scene.style.setProperty("--far-x", `${(-px * 4).toFixed(2)}px`);
      scene.style.setProperty("--far-y", `${(-py * 2).toFixed(2)}px`);
      scene.style.setProperty("--middle-x", `${(-px * 9).toFixed(2)}px`);
      scene.style.setProperty("--middle-y", `${(-py * 5).toFixed(2)}px`);
      scene.style.setProperty("--near-x", `${(-px * 16).toFixed(2)}px`);
      scene.style.setProperty("--near-y", `${(-py * 9).toFixed(2)}px`);
      cards.forEach((card) => {
        const depth = Number(card.dataset.depth || 1);
        const factor = (0.92 - depth * 0.26) * 14;
        card.style.setProperty("--px", `${(dx * factor).toFixed(2)}px`);
        card.style.setProperty("--py", `${(dy * factor * 0.55).toFixed(2)}px`);
      });
    });
  };

  updateScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  if (!reduce) stage.addEventListener("pointermove", onMove, { passive: true });
  inboxLayeredCleanup = () => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    stage.removeEventListener("pointermove", onMove);
    observer?.disconnect();
    cancelAnimationFrame(raf);
    cancelAnimationFrame(scrollRaf);
  };
}
function mountInboxFormaTextPressure() {
  if (LIGHT_PRESENTATION) return;
  const el = document.querySelector(".inbox-page .forme-head-title h1[data-text-pressure]");
  if (!el || el.dataset.textPressureMounted === "1") return;
  el.dataset.textPressureMounted = "1";
  const text = el.textContent.trim();
  inboxFormaTextPressureCleanup = mountTextPressure(el, { text, textColor: "rgba(255,250,241,.94)" });
}
function mountGalleryAllFormaTextPressure() {
  if (LIGHT_PRESENTATION) return;
  const el = document.querySelector(".gallery-all-modal .forme-head-title h1[data-text-pressure]");
  if (!el || el.dataset.textPressureMounted === "1") return;
  el.dataset.textPressureMounted = "1";
  const text = el.textContent.trim();
  galleryAllFormaTextPressureCleanup = mountTextPressure(el, { text, textColor: "rgba(255,250,241,.94)" });
}
function mountNotesAllFormaTextPressure() {
  if (LIGHT_PRESENTATION) return;
  const el = document.querySelector(".notes-all-modal .forme-head-title h1[data-text-pressure]");
  if (!el || el.dataset.textPressureMounted === "1") return;
  el.dataset.textPressureMounted = "1";
  notesAllFormaTextPressureCleanup = mountTextPressure(el, { text: el.textContent.trim(), textColor: "rgba(255,250,241,.94)" });
}
// 弧面画廊控制器：CSS 3D 圆柱面，拖动/滚轮/方向键平滑滚动，无缝循环。
function mountRecommendGallery() {
  if (LIGHT_PRESENTATION) {
    if (!recommendGalleryCleanup) recommendGalleryCleanup = mountHomeRecommendationRails(app);
    return;
  }
  const gallery = document.querySelector(".recommend-gallery");
  if (!gallery || gallery.dataset.mounted === "1") return;
  const cards = [...gallery.querySelectorAll(".circular-card")];
  if (!cards.length) return;
  gallery.dataset.mounted = "1";
  const isHomeGallery = gallery.classList.contains("home-recommend-gallery");
  if (isHomeGallery) gallery.dataset.cardCount = String(Math.min(5, cards.length));
  let step = 176;
  let range = cards.length * step;
  let cardPositions = [];
  const maxAngle = 32;
  let target = 0;
  let current = 0;
  let measuredWidth = 0;
  let down = false;
  let startX = 0;
  let startTarget = 0;
  let dragMoved = false;
  let dragEndAt = 0;
  let velocity = 0;
  let raf = 0;
  let hoveredCard = null;
  let hoverPointer = null;
  let previousFrameTime = performance.now();
  let galleryMoving = false;
  let previousCenterCard = null;
  const reduceHoverMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hoverSprings = new WeakMap(cards.map((card) => [card, {
    lift: 0, liftVelocity: 0,
    scale: 1, scaleVelocity: 0,
    tiltX: 0, tiltXVelocity: 0,
    tiltY: 0, tiltYVelocity: 0,
  }]));
  const renderCache = new WeakMap(cards.map((card) => [card, { transform: "", zIndex: "", opacity: "" }]));
  const springTo = (state, valueKey, velocityKey, targetValue, dt, stiffness, damping) => {
    if (reduceHoverMotion) {
      state[valueKey] = targetValue;
      state[velocityKey] = 0;
      return targetValue;
    }
    const acceleration = (targetValue - state[valueKey]) * stiffness - state[velocityKey] * damping;
    state[velocityKey] += acceleration * dt;
    state[valueKey] += state[velocityKey] * dt;
    return state[valueKey];
  };
  const springIsMoving = (state, liftTarget, scaleTarget, tiltXTarget, tiltYTarget) => Math.abs(state.lift - liftTarget) > .02
    || Math.abs(state.liftVelocity) > .02
    || Math.abs(state.scale - scaleTarget) > .0002
    || Math.abs(state.scaleVelocity) > .0002
    || Math.abs(state.tiltX - tiltXTarget) > .01
    || Math.abs(state.tiltXVelocity) > .01
    || Math.abs(state.tiltY - tiltYTarget) > .01
    || Math.abs(state.tiltYVelocity) > .01;
  const requestFrame = () => {
    if (raf) return;
    previousFrameTime = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const measureGallery = () => {
    const width = gallery.clientWidth || 1;
    if (Math.abs(width - measuredWidth) < 1) return;
    measuredWidth = width;
    const previousStep = step;
    if (isHomeGallery) {
      const usable = Math.max(1, width - 12);
      const visible = Math.min(cards.length, Math.max(1, Math.floor((usable + 16) / 256)));
      const cardWidth = Math.min(320, Math.max(220, (usable - (visible - 1) * 16) / visible), usable);
      const cardHeight = Math.round(Math.max(360, Math.min(430, cardWidth * 1.38)));
      gallery.style.setProperty("--recommend-card-width", `${cardWidth.toFixed(1)}px`);
      gallery.style.setProperty("--recommend-card-height", `${cardHeight}px`);
      step = cardWidth + 16;
    }
    range = cards.length * step;
    target = target / previousStep * step;
    current = current / previousStep * step;
    velocity = 0;
    cards.forEach((card, i) => { card.dataset.baseX = ((i - (cards.length - 1) / 2) * step).toFixed(1); });
    cardPositions = cards.map((card) => parseFloat(card.dataset.baseX));
    snapTarget();
    current = target;
    requestFrame();
  };
  function snapTarget(dir = 0) {
    // 在未回绕的坐标系里找离当前位置最近的一张卡（含循环重复位置）；距离相同时优先行进方向前方那张，保证连续朝同一方向滚动。
    let best = Infinity;
    for (const p of cardPositions) {
      const repeat = p + Math.round((target - p) / range) * range;
      const dist = Math.abs(repeat - target);
      const bestDist = Math.abs(best - target);
      if (dist < bestDist || (dir !== 0 && dist === bestDist && (dir > 0 ? repeat > best : repeat < best))) best = repeat;
    }
    target = best;
  }
  // 初始态：面板刚打开时让最近的一张卡停在正中，而不是停在两卡之间。
  measureGallery();
  const galleryResizeObserver = isHomeGallery ? new ResizeObserver(measureGallery) : null;
  galleryResizeObserver?.observe(gallery);
  snapTarget();
  current = target;
  function frame(now = performance.now()) {
    raf = 0;
    const dt = Math.min(0.032, Math.max(0.001, (now - previousFrameTime) / 1000));
    previousFrameTime = now;
    if (velocity !== 0) {
      // 惯性滚动：速度驱动位置，缓慢衰减，触控板连续小位移也能平滑滑行。
      current += velocity;
      velocity *= 0.9;
      if (Math.abs(velocity) < 0.5) { velocity = 0; target = current; }
    } else {
      current += (target - current) * 0.12;
      if (Math.abs(target - current) < 0.08) current = target;
    }
    let centerCard = null;
    let centerAbs = Infinity;
    // 每帧只读一次指针位置，避免 pointermove 高频触发 getBoundingClientRect 造成布局抖动。
    if (hoverPointer && !down) {
      const { card, x, y } = hoverPointer;
      const rect = card.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      const py = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
      card.style.setProperty("--holo-x", `${(px * 100).toFixed(1)}%`);
      card.style.setProperty("--holo-y", `${(py * 100).toFixed(1)}%`);
      card.style.setProperty("--holo-angle", `${(115 + (px - py) * 22).toFixed(1)}deg`);
      card.dataset.holoTiltX = String((.5 - py) * 2.2);
      card.dataset.holoTiltY = String((px - .5) * 2.2);
      hoverPointer = null;
    }
    const isScrolling = down || velocity !== 0 || Math.abs(target - current) >= 0.08;
    if (galleryMoving !== isScrolling) {
      galleryMoving = isScrolling;
      gallery.classList.toggle("is-moving", galleryMoving);
    }
    let hoverAnimationActive = false;
    cards.forEach((card) => {
      let x = parseFloat(card.dataset.baseX) - current;
      while (x > range / 2) x -= range;
      while (x < -range / 2) x += range;
      const nx = x / step;
      const ax = Math.abs(x);
      if (ax < centerAbs) { centerAbs = ax; centerCard = card; }
      // Home recommendations stay on a flat horizontal rail. Distance from
      // center changes only scale; the compact gallery keeps its 3D curve.
      const rotAmount = isHomeGallery ? 0 : nx * 24;
      const rot = Math.max(-maxAngle, Math.min(maxAngle, rotAmount));
      const z = isHomeGallery
        ? 0
        : -Math.min(240, (x * x) / 10000);
      const scale = 1 - Math.min(isHomeGallery ? 0.075 : 0.24, Math.abs(nx) * (isHomeGallery ? 0.034 : 0.12));
      const anchor = isHomeGallery ? "translate(-50%, -50%) " : "";
      const activeHover = !down && card === hoveredCard;
      const hoverSpring = hoverSprings.get(card);
      const targetTiltX = activeHover ? Number(card.dataset.holoTiltX || 0) : 0;
      const targetTiltY = activeHover ? Number(card.dataset.holoTiltY || 0) : 0;
      const targetLift = activeHover ? -11 : 0;
      const targetScale = activeHover ? 1.032 : 1;
      // Lift/scale are slightly under-damped for one soft settle; pointer tilt is
      // more heavily damped so tracking feels fluid instead of rubbery.
      const lift = springTo(hoverSpring, "lift", "liftVelocity", targetLift, dt, 360, 36);
      const hoverScale = springTo(hoverSpring, "scale", "scaleVelocity", targetScale, dt, 340, 35);
      const tiltX = springTo(hoverSpring, "tiltX", "tiltXVelocity", targetTiltX, dt, 320, 33);
      const tiltY = springTo(hoverSpring, "tiltY", "tiltYVelocity", targetTiltY, dt, 320, 33);
      if (springIsMoving(hoverSpring, targetLift, targetScale, targetTiltX, targetTiltY)) hoverAnimationActive = true;
      const transform = `${anchor}translateX(${x.toFixed(1)}px) translateY(${lift.toFixed(2)}px) translateZ(${z.toFixed(1)}px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${(rot + tiltY).toFixed(2)}deg) scale(${(scale * hoverScale).toFixed(3)})`;
      const zIndex = String(Math.round(100 - Math.abs(x) / 3));
      // Keep the focused recommendation crisp, then fade cards continuously as
      // they approach either side of the rail. A small floor keeps the outer
      // cards discoverable without competing with the center card.
      const opacity = isHomeGallery
        ? Math.max(0.34, 1 - Math.abs(nx) * 0.29)
        : Math.max(0.22, 1 - Math.abs(nx) * 0.34);
      const opacityValue = opacity.toFixed(3);
      const cache = renderCache.get(card);
      // Hover only changes one card. Avoid invalidating style/compositing for
      // every stationary sibling on every spring frame.
      if (cache.transform !== transform) { card.style.transform = transform; cache.transform = transform; }
      if (cache.zIndex !== zIndex) { card.style.zIndex = zIndex; cache.zIndex = zIndex; }
      if (cache.opacity !== opacityValue) { card.style.opacity = opacityValue; cache.opacity = opacityValue; }
    });
    if (centerCard !== previousCenterCard) {
      previousCenterCard?.classList.remove("is-center");
      centerCard?.classList.add("is-center");
      previousCenterCard = centerCard;
    }
    if (isScrolling || hoverAnimationActive || hoverPointer) requestFrame();
  }
  requestFrame();
  const onWheel = (event) => {
    if (down) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
    const dy = event.deltaY * unit;
    const dx = event.deltaX * unit;
    const horizontalGesture = Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 0.5;
    const shiftedWheel = event.shiftKey && Math.max(Math.abs(dx), Math.abs(dy)) > 0.5;
    // 只接管明确的横向意图：触控板双指左右滑，或 Shift + 鼠标滚轮。
    // 普通上下滚轮直接交还页面，避免用户经过画廊时被截停。
    if (!horizontalGesture && !shiftedWheel) return;
    event.preventDefault();
    const delta = horizontalGesture ? -dx : (Math.abs(dx) > 0.5 ? -dx : dy);
    if (Math.abs(delta) < 0.5) return;
    velocity += delta * 0.16;
    velocity = Math.max(-70, Math.min(70, velocity));
    target = current;
    requestFrame();
  };
  const onDown = (event) => { down = true; velocity = 0; dragMoved = false; startX = event.touches ? event.touches[0].clientX : event.clientX; startTarget = target; gallery.classList.add("is-dragging"); requestFrame(); };
  const onMove = (event) => { if (!down) return; const x = event.touches ? event.touches[0].clientX : event.clientX; if (Math.abs(x - startX) > 6) dragMoved = true; target = startTarget + (startX - x) * 0.9; requestFrame(); };
  const onUp = () => { down = false; gallery.classList.remove("is-dragging"); if (dragMoved) dragEndAt = Date.now() + 120; requestFrame(); };
  const onKey = (event) => {
    if (event.key === "ArrowRight") { event.preventDefault(); velocity = 0; target += step; snapTarget(1); requestFrame(); }
    if (event.key === "ArrowLeft") { event.preventDefault(); velocity = 0; target -= step; snapTarget(-1); requestFrame(); }
  };
  const onGalleryClick = (event) => { if (Date.now() < dragEndAt) { event.preventDefault(); event.stopPropagation(); } };
  const onCardOver = (event) => {
    const card = event.target.closest?.(".circular-card");
    if (hoveredCard && hoveredCard !== card) hoveredCard.classList.remove("is-holo-active");
    hoveredCard = card || null;
    hoveredCard?.classList.add("is-holo-active");
    requestFrame();
  };
  const onHoloMove = (event) => {
    const card = event.target.closest?.(".circular-card");
    if (!card || down) return;
    // 只记录最新指针位置，真正的变量更新放到 rAF 帧里统一执行。
    hoverPointer = { card, x: event.clientX, y: event.clientY };
    requestFrame();
  };
  const onGalleryLeave = () => {
    hoveredCard?.classList.remove("is-holo-active");
    if (hoveredCard) { hoveredCard.dataset.holoTiltX = "0"; hoveredCard.dataset.holoTiltY = "0"; }
    hoveredCard = null;
    hoverPointer = null;
    requestFrame();
  };
  gallery.addEventListener("wheel", onWheel, { passive: false });
  gallery.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  gallery.addEventListener("touchstart", onDown, { passive: true });
  gallery.addEventListener("touchmove", onMove, { passive: true });
  gallery.addEventListener("touchend", onUp);
  gallery.addEventListener("keydown", onKey);
  gallery.addEventListener("click", onGalleryClick);
  gallery.addEventListener("mouseover", onCardOver);
  gallery.addEventListener("pointermove", onHoloMove, { passive: true });
  gallery.addEventListener("mouseleave", onGalleryLeave);
  recommendGallery = { move(dir) { velocity = 0; target += dir * step; snapTarget(dir); requestFrame(); } };
  if (pendingRecommendMove) { recommendGallery.move(pendingRecommendMove); pendingRecommendMove = 0; }
  recommendGalleryCleanup = () => {
    galleryResizeObserver?.disconnect();
    cancelAnimationFrame(raf);
    gallery.removeEventListener("wheel", onWheel);
    gallery.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    gallery.removeEventListener("touchstart", onDown);
    gallery.removeEventListener("touchmove", onMove);
    gallery.removeEventListener("touchend", onUp);
    gallery.removeEventListener("keydown", onKey);
    gallery.removeEventListener("click", onGalleryClick);
    gallery.removeEventListener("mouseover", onCardOver);
    gallery.removeEventListener("pointermove", onHoloMove);
    gallery.removeEventListener("mouseleave", onGalleryLeave);
    recommendGallery = null;
    gallery.classList.remove("is-moving");
    delete gallery.dataset.mounted;
  };
}

function openRecommendFocus(card) {
  if (!card || focusedRecommendCard) return;
  const overlay = document.createElement("div");
  // Keep the focused clone inside the same styling scope as the carousel card.
  // Without this scope, only the focus overrides apply and the card's internal
  // grid collapses into normal flow, stacking every text row below the image.
  overlay.className = "recommend-focus-overlay home-recommend-row";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", `聚焦查看${card.dataset.tag || "推荐卡片"}`);
  const clone = card.cloneNode(true);
  clone.classList.add("recommend-focus-card", "is-holo-active");
  clone.classList.remove("is-center");
  clone.removeAttribute("data-action");
  clone.style.removeProperty("transform");
  clone.style.removeProperty("opacity");
  clone.style.removeProperty("z-index");
  const collectionId = card.dataset.collectionId || "";
  const collection = state().collections.find((item) => item.id === collectionId);
  const caption = clone.querySelector("figcaption");
  const category = state().collectionCategories?.[collectionId] || "未分类";
  clone.querySelector(".circular-card__identity")?.remove();
  const meta = document.createElement("div");
  meta.className = "recommend-focus-meta";
  meta.innerHTML = `<span>${escapeHtml(collection?.source || "未知来源")} · ${escapeHtml(typeLabel(collection?.type || "link"))}</span><button type="button" class="recommend-focus-category" data-category-label data-collection-id="${escapeHtml(collectionId)}" aria-label="修改分类：${escapeHtml(category)}">${escapeHtml(category)}</button>`;
  caption?.prepend(meta);
  const button = document.createElement("button");
  button.className = "recommend-focus-detail";
  button.type = "button";
  button.dataset.action = "open-focused-collection";
  button.textContent = "查看详情 ↗";
  const editor = document.createElement("div");
  editor.innerHTML = collectionCategoryEditorMarkup(collectionId, state().collectionCategories?.[collectionId] || "", true);
  const categoryEditor = editor.firstElementChild;
  categoryEditor.classList.add("is-hidden");
  meta.appendChild(categoryEditor);
  clone.appendChild(button);
  overlay.appendChild(clone);
  document.body.appendChild(overlay);
  // 分类编辑器默认收起，点击右侧分类标签后展开。
  const categoryLabel = meta.querySelector("[data-category-label]");
  const toggleCategoryEditor = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!categoryEditor) return;
    const showing = categoryEditor.classList.toggle("is-hidden") === false;
    categoryLabel?.setAttribute("aria-expanded", String(showing));
    if (showing) categoryEditor.querySelector('input[name="category"]')?.focus();
  };
  categoryLabel?.setAttribute("aria-expanded", "false");
  categoryLabel?.addEventListener("click", toggleCategoryEditor);
  requestAnimationFrame(() => overlay.classList.add("is-visible"));
  focusedRecommendCard = { overlay, source: card };
}

function closeRecommendFocus() {
  const overlay = focusedRecommendCard?.overlay;
  if (!overlay) return;
  overlay.classList.remove("is-visible");
  window.setTimeout(() => overlay.remove(), 360);
  focusedRecommendCard = null;
}

let focusHoverPointer = null;
let focusHoverRaf = 0;
document.addEventListener("pointermove", (event) => {
  if (LIGHT_PRESENTATION) return;
  const card = event.target.closest?.(".recommend-focus-card");
  if (!card) return;
  // 每帧只处理一次指针位置，避免高频 getBoundingClientRect 造成的布局抖动。
  focusHoverPointer = { card, x: event.clientX, y: event.clientY };
  if (!focusHoverRaf) {
    focusHoverRaf = requestAnimationFrame(() => {
      focusHoverRaf = 0;
      const hover = focusHoverPointer;
      if (!hover) return;
      const rect = hover.card.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (hover.x - rect.left) / rect.width));
      const py = Math.max(0, Math.min(1, (hover.y - rect.top) / rect.height));
      hover.card.style.setProperty("--holo-x", `${(px * 100).toFixed(1)}%`);
      hover.card.style.setProperty("--holo-y", `${(py * 100).toFixed(1)}%`);
      hover.card.style.setProperty("--holo-angle", `${(115 + (px - py) * 22).toFixed(1)}deg`);
      hover.card.style.setProperty("--focus-rx", `${((.5 - py) * 5).toFixed(2)}deg`);
      hover.card.style.setProperty("--focus-ry", `${((px - .5) * 5).toFixed(2)}deg`);
    });
  }
}, { passive: true });
function mountInboxGrainient() {
  if (LIGHT_PRESENTATION) return;
  const el = document.querySelector(".inbox-page .inbox-grainient");
  if (!el || el.dataset.grainient === "1") return;
  el.dataset.grainient = "1";
  inboxGrainientCleanup = mountGrainient(el, {
    color1: "#8FC4DE",
    color2: "#C25B48",
    color3: "#202C3E",
    timeSpeed: 0.22,
    warpStrength: 1.2,
    warpFrequency: 4,
    warpSpeed: 1.5,
    warpAmplitude: 60,
    blendSoftness: 0.06,
    rotationAmount: 320,
    noiseScale: 2.2,
    grainAmount: 0.08,
    grainScale: 2.5,
    grainAnimated: true,
    contrast: 1.35,
    gamma: 1.05,
    saturation: 0.85,
    zoom: 0.85,
    opacity: 0.2,
  });
}
window.addEventListener("resize", layoutCollectionGrid);
window.addEventListener("resize", () => {
  if (!notesAllOpen || !document.querySelector(".notes-all-overlay")) return;
  if (notesArchiveColumnCount() !== notesAllRenderedColumns) {
    refreshNotesAllArchive({ focusSearch: document.activeElement?.id === "notes-all-search" });
  }
}, { passive: true });

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.matches("[data-public-link-form]")) return;
  if (form.dataset.form === "collection-tag") {
    const tag = String(new FormData(form).get("tag") || "").trim();
    if (!tag) return;
    const collectionId = state().ui.collectionId;
    const extraction = state().extractions.find(entry => entry.collectionId === collectionId);
    const key = `understanding:${collectionId}`;
    const previous = state().feedback[key] || {};
    const tags = Array.isArray(previous.acceptedTags) ? previous.acceptedTags : [...new Set([...(extraction?.tags || []), ...(extraction?.concepts || [])])];
    if (tags.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
      form.querySelector('[data-tag-status]').textContent = "已有这条线索"; return;
    }
    store.update(draft => { draft.feedback[key] = { ...previous, acceptedTags: [...tags, tag], tagsReviewedAt: new Date().toISOString() }; });
    refreshCollectionView();
    document.querySelector('[data-action="add-collection-tag"]')?.focus({ preventScroll: true });
    return;
  }
  if (form.dataset.form === "collection-category") {
    const category = String(new FormData(form).get("category") || "").trim();
    if (category) setCollectionCategory(form.dataset.collectionId, category);
    return;
  }
  if (form.dataset.form === "quick-note") {
    saveQuickNote(form.dataset.quickNote, form);
    return;
  }
  if (form.dataset.form === "capture") {
    if (form.dataset.submitting === "true") return;
    const mode = new FormData(form).get("mode") || "link";
    const contentField = [...form.querySelectorAll('input[name="content"], textarea[name="content"]')].find((el) => el.offsetParent !== null);
    const content = mode === "image" ? "" : String(contentField?.value || "").trim();
    if (mode !== "image" && !content) return;
    if (mode === "image" && !captureDraft.image) return;
    const imageData = mode === "image" ? captureDraft.image : null;
    const imageName = mode === "image" ? captureDraft.imageName : "";
    form.dataset.submitting = "true";
    form.setAttribute("aria-busy", "true");
    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    let accepted;
    try { accepted = await liveAI.capture({ mode, content, image: imageData, title: imageName }); }
    finally { delete form.dataset.submitting; form.removeAttribute("aria-busy"); if (submitButton) submitButton.disabled = false; }
    if (!accepted) return;
    const captured = accepted.state?.collections?.find(item => item.id === accepted.collectionId) || state().collections.find(item => item.id === accepted.collectionId) || state().collections.at(-1);
    const receiptMessage = accepted.duplicate ? "这条链接已在收藏中"
      : captureFeedbackMessage({ mode, status: captured?.status, aiEnabled: accepted.state?.capabilities?.aiEnabled ?? state().desktopCapabilities?.aiEnabled });
    const finish = () => {
      resetCaptureDraft();
      closeCaptureOverlay({ immediate: true });
      if (!LIGHT_PRESENTATION) {
        Object.assign(inboxFilters, { query: "", explore: null, mode: "all", limit: 12 });
        if (!refreshInboxAllOverlay()) openInboxAllOverlay();
        document.querySelector(".inbox-all-modal")?.scrollTo({ top: 0, behavior: glassReducedMotion() ? "auto" : "smooth" });
      }
      showCaptureToast(receiptMessage);
    };
    if (LIGHT_PRESENTATION) void closeGlassOverlay(form.closest(".capture-overlay"), finish);
    else finish();
    return;
  }
  if (form.dataset.form === "correction") {
    const correction = new FormData(form).get("correction").trim();
    store.update((draft) => { draft.feedback[form.dataset.connection].correction = correction; });
  }
  if (form.dataset.form === "note") {
    const noteId = form.dataset.note || state().ui.studioNoteId;
    const formData = new FormData(form);
    store.update((draft) => {
      const note = draft.studioNotes.find((n) => n.id === noteId);
      if (!note) return;
      (note.blocks || []).forEach((block, i) => {
        const val = (formData.get(`block-${i}`) ?? "").trim();
        if (val && val !== block.text) { block.text = val; block.ai = false; }
      });
      note.body = (note.blocks || []).map((b) => b.text).join("\n\n");
      note.status = "saved";
      note.updatedAt = new Date().toISOString();
      if (!draft.themes.some((theme) => theme.noteId === note.id)) draft.themes.push({ id: `theme-${note.exhibitionId}`, title: note.exhibitionTitle || "正在形成的主题", status: "forming", evidenceCount: 6, exhibitionId: note.exhibitionId, noteId: note.id });
    });
  }
  renderWithTransition();
});

document.addEventListener("input", (event) => {
  if (event.target.id === "capture-input") captureDraft.link = event.target.value;
  if (event.target.id === "capture-text") captureDraft.text = event.target.value;
  if (event.target.matches?.('.collection-glass__note [data-note-text]')) {
    const id = state().ui.collectionId;
    if (event.target.value === (state().notes?.[id] || "")) collectionNoteDrafts.delete(id);
    else collectionNoteDrafts.set(id, event.target.value);
    const status = event.target.closest('.collection-glass__note').querySelector('[data-note-status]');
    if (status) status.textContent = collectionNoteDrafts.has(id) ? '未保存' : '已保存';
  }
  if (event.target.matches?.("[data-quick-note] textarea")) {
    const form = event.target.closest("[data-quick-note]");
    if (form) {
      quickNoteDraft(form.dataset.quickNote).text = event.target.value;
      updateQuickNoteDockDraft(form.dataset.quickNote);
    }
    return;
  }
  if (event.target.id === "inbox-search") {
    inboxFilters.query = event.target.value;
    applyInboxFilters();
  }
  if (event.target.id === "gallery-search") { galleryFilters.query = event.target.value; applyGalleryFilters(); }
  if (event.target.id === "gallery-all-search") {
    galleryAll.query = event.target.value;
    refreshGalleryAllOverlay({ focusSearch: true });
  }
  if (event.target.id === "notes-all-search") {
    notesAllFilters.query = event.target.value;
    notesAllFilters.menuOpen = false;
    refreshNotesAllArchive({ focusSearch: true });
  }
});

function setCollectionCategory(collectionId, category) {
  const value = String(category || "").trim().slice(0, 12);
  if (!collectionId || !value) return;
  store.update((draft) => { draft.collectionCategories[collectionId] = value; });
  document.querySelectorAll(`[data-category-label][data-collection-id="${CSS.escape(collectionId)}"]`).forEach((label) => {
    label.textContent = value;
    if (label.hasAttribute("aria-label")) label.setAttribute("aria-label", `修改分类：${value}`);
  });
  document.querySelectorAll(`[data-form="collection-category"][data-collection-id="${CSS.escape(collectionId)}"]`).forEach((form) => {
    form.querySelectorAll("[data-category]").forEach((button) => button.classList.toggle("is-active", button.dataset.category === value));
    const input = form.querySelector('input[name="category"]');
    if (input) input.value = defaultCollectionCategories.includes(value) ? "" : value;
  });
}

// 收新弹窗：点击遮罩关闭；图片支持粘贴、拖入、选择文件。
document.addEventListener("click", (event) => {
  if (event.target.classList?.contains("recommend-focus-overlay")) {
    closeRecommendFocus();
    return;
  }
  if (event.target.classList?.contains("inbox-all-overlay")) {
    closeInboxAllOverlay();
    return;
  }
  if (event.target.classList?.contains("notes-all-overlay")) {
    closeNotesAllOverlay();
    return;
  }
  if (event.target.classList?.contains("recap-ticket-overlay")) {
    closeRecapTicket();
    return;
  }
  if (inboxFilters.captureOpen && event.target.classList?.contains("capture-overlay")) {
    closeCaptureOverlay();
  }
  if (event.target.closest?.("#capture-drop")) {
    document.getElementById("capture-file")?.click();
  }
});
document.addEventListener("paste", (event) => {
  const file = [...(event.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (!file) return;
  const quickScope = event.target.closest?.("[data-quick-note]");
  if (quickScope) {
    event.preventDefault();
    addQuickNoteImages(quickScope.dataset.quickNote, [file]);
    return;
  }
  if (inboxFilters.captureOpen && captureDraft.mode === "image") {
    event.preventDefault();
    handleCaptureImageFile(file);
  }
});
document.addEventListener("dragover", (event) => {
  if (event.target.closest?.("[data-quick-note]")) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    return;
  }
  if (inboxFilters.captureOpen && captureDraft.mode === "image") event.preventDefault();
});
document.addEventListener("drop", (event) => {
  const quickScope = event.target.closest?.("[data-quick-note]");
  if (quickScope) {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) { event.preventDefault(); addQuickNoteImages(quickScope.dataset.quickNote, files); }
    return;
  }
  if (!inboxFilters.captureOpen || captureDraft.mode !== "image") return;
  const file = [...(event.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) { event.preventDefault(); handleCaptureImageFile(file); }
});
document.addEventListener("change", (event) => {
  if (event.target.matches?.("[data-quick-note-file]")) {
    addQuickNoteImages(event.target.dataset.context, [...(event.target.files || [])]);
    event.target.value = "";
    return;
  }
  if (event.target.id === "capture-file" && event.target.files?.[0]) handleCaptureImageFile(event.target.files[0]);
});
window.addEventListener("message", (event) => {
  const frame = document.querySelector(".foyer-exhibition__frame");
  // The 3D gallery can be served through a preview/proxy whose reported origin
  // differs from the shell even though it is the iframe we mounted. Trust the
  // concrete frame window instead, then validate the message shape and id.
  if (!frame || event.source !== frame.contentWindow) return;
  if (event.data?.type !== "forme:open-exhibit") return;
  const exhibitId = typeof event.data.exhibitId === "string" ? event.data.exhibitId : "";
  if (!exhibitInterpretation[exhibitId]) return;
  openExhibitDetail(exhibitId);
});

// 方案 C · 搜索优先：未点击时只留居中的搜索栏，点击/输入后展开结果视图。
document.addEventListener("focusin", (event) => {
  if (event.target.closest?.('[data-action="toggle-explore"]')) return;
  const scope = event.target.closest?.(".inbox-discovery, .gallery-discovery");
  if (!scope) return;
  const isGallery = scope.classList.contains("gallery-discovery");
  const filters = isGallery ? galleryFilters : inboxFilters;
  filters.expanded = true;
  const page = document.querySelector(isGallery ? ".gallery-page" : ".inbox-page");
  page?.classList.add("is-searching");
});
document.addEventListener("focusout", (event) => {
  if (event.relatedTarget?.closest?.(".inbox-discovery, .gallery-discovery, .capture-overlay")) return;
  if (event.relatedTarget?.closest?.("button, a, [data-action], [data-nav], .collection-card, details")) return;
  if (inboxFilters.query || inboxFilters.explore || inboxFilters.mode === "recommended" || inboxFilters.captureOpen) return;
  if (galleryFilters.query || galleryFilters.explore) return;
  inboxFilters.expanded = false;
  inboxFilters.searchOpen = false;
  galleryFilters.expanded = false;
  document.querySelector(".inbox-page")?.classList.remove("is-searching");
  document.querySelector(".gallery-page")?.classList.remove("is-searching");
});
document.addEventListener("focusout", (event) => {
  if (!event.target.matches?.("[data-exhibit-note-comment]")) return;
  const comment = event.target.value.trim();
  store.update((draft) => {
    const note = draft.exhibitionNotes.find((entry) => entry.id === exhibitDetail.noteDraftId);
    if (note) note.comment = comment;
  });
});
// Studio 就地编辑：段落 textarea 失焦即提交保存。
document.addEventListener("focusout", (event) => {
  if (event.target.classList?.contains("block__body") && event.target.classList.contains("is-editing")) {
    commitBlockEdit(event.target);
  }
});

// ⌘K 唤起搜索，Esc 先清空关键词、再收起搜索栏。
document.addEventListener("keydown", (event) => {
  if (event.target.closest?.('[data-chat-controller], [data-workspace-conversations]') || document.body.classList.contains('workspace-chat-open')) return;
  if (event.isComposing || event.keyCode === 229) return;
  if (event.target.matches?.('[role="tab"][data-action="capture-mode"]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const tabs = [...event.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(event.target) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].click();
    tabs[index].focus();
    return;
  }
  if (event.target.matches?.('.notes-all-ticket[data-action="notes-all-open-exhibition"], .notes-all-ticket[data-action="gallery-all-open"]') && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    event.target.click();
    return;
  }
  // Studio 就地编辑：阅读态段落上回车/空格进入编辑；编辑中 Cmd/Ctrl+Enter 或 Escape 提交退出。
  if (event.target.matches?.('[data-action="edit-block"]') && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault(); beginBlockEdit(event.target); return;
  }
  if (studio.editing && event.target.classList?.contains("block__body") && event.target.classList.contains("is-editing")) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); commitBlockEdit(event.target); return; }
    if (event.key === "Escape") { event.preventDefault(); commitBlockEdit(event.target); return; }
  }
  if (state().ui.view === "serendipity" && !serendipity.simple) {
    if (["ArrowDown", "ArrowRight"].includes(event.key)) { event.preventDefault(); const serendipityLast = serendipity.order.length - 1 + (WEBGL_OK ? 1 : 0); serendipity.target = Math.min(serendipityLast, serendipity.target + 1); serendipity.offset = serendipity.target; serendipity.velocity = 0; return; }
    if (["ArrowUp", "ArrowLeft"].includes(event.key)) { event.preventDefault(); const serendipityFirst = WEBGL_OK ? -1 : 0; serendipity.target = Math.max(serendipityFirst, serendipity.target - 1); serendipity.offset = serendipity.target; serendipity.velocity = 0; return; }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (LIGHT_PRESENTATION) {
      if (document.querySelector("dialog[open], .collection-glass-overlay, .capture-overlay, .recap-ticket-overlay, .exhibit-detail-overlay")) return;
      if (!document.getElementById("workspace-search")) switchLightPage(state().ui.lightPage === "home" ? "inbox" : state().ui.lightPage || "inbox");
      lightWorkspace.focusWorkspaceSearch();
      return;
    }
    const onInbox = state().ui.view === "inbox";
    inboxFilters.searchOpen = true;
    inboxFilters.expanded = true;
    if (onInbox && document.querySelector(".inbox-all-overlay")) refreshInboxAllOverlay();
    else if (onInbox) openInboxAllOverlay();
    else { inboxView.mode = "all"; navigate("inbox"); }
    window.setTimeout(() => document.getElementById("inbox-search")?.focus(), onInbox ? 0 : 320);
    return;
  }
  if (event.key === "Escape") {
    // A native dialog owns Escape while it is above the custom detail layer.
    if (document.querySelector("dialog[open]")) return;
    const tagEditor = document.querySelector(".collection-tag-form");
    if (tagEditor) { event.preventDefault(); tagEditor.remove(); const trigger = document.querySelector('[data-action="add-collection-tag"]'); trigger?.setAttribute('aria-expanded', 'false'); trigger?.focus(); return; }
    const drawer = document.querySelector(".exhibit-note-drawer.is-open");
    if (drawer) { event.preventDefault(); closeExhibitNoteDrawer(drawer); return; }
    const imageMenu = document.querySelector(".exhibit-image-menu.is-visible");
    if (imageMenu) { event.preventDefault(); imageMenu.classList.remove("is-visible"); return; }
    if (document.querySelector(".capture-overlay")) { closeCaptureOverlay(); return; }
    if (document.querySelector(".exhibit-detail-overlay")) { closeExhibitDetail(); return; }
    if (recapTicketExhibitionId) { closeRecapTicket(); return; }
    if (foyerQuickNoteOpen) { closeFoyerQuickNote(); return; }
    if (galleryAll.open) { closeGalleryAllOverlay(); return; }
    if (document.querySelector(".exhibit-detail-overlay")) { closeExhibitDetail(); return; }
    if (focusedRecommendCard) { closeRecommendFocus(); return; }
    if (state().ui.view === "serendipity") { navigate("gallery"); return; }
    if (state().ui.view === "collection") { closeCollection(); return; }
    if (notesAllOpen) { closeNotesAllOverlay(); return; }
    if (inboxFilters.captureOpen) {
      closeCaptureOverlay();
      return;
    }
    const inboxOverlay = document.querySelector(".inbox-all-overlay");
    if (inboxOverlay && inboxFilters.menuOpen) { inboxFilters.menuOpen = false; refreshInboxAllOverlay(); return; }
    const input = document.getElementById("inbox-search");
    if (inboxOverlay && document.activeElement !== input) { closeInboxAllOverlay(); return; }
    if (document.activeElement !== input) return;
    event.preventDefault();
    if (inboxFilters.query) {
      inboxFilters.query = "";
      applyInboxFilters();
    } else {
      inboxFilters.searchOpen = false;
      inboxFilters.expanded = false;
      inboxFilters.menuOpen = false;
      document.querySelector(".inbox-page")?.classList.remove("is-searching");
      if (inboxOverlay) refreshInboxAllOverlay();
      else render();
    }
  }
});

// Serendipity 漫游：滚轮驱动卡片在 3D 空间里拉近/推远（页面本身不滚动）。
document.addEventListener("wheel", (event) => {
  const view = state().ui.view;
  let mover = null;
  if (view === "serendipity" && !serendipity.simple && serendipity.order.length) {
    // WebGL 漫游多一个 FORME 标题槽；CSS 降级路径保持原卡位数量
    mover = { obj: serendipity, count: serendipity.order.length + (WEBGL_OK ? 1 : 0) };
  }
  if (!mover) return;
  event.preventDefault();
  const d = event.deltaMode === 1 ? event.deltaY * 3 : event.deltaY;
  const last = mover.count - 1;
  // 完全跟随滚轮：offset 连续累加（可停在任意半程位置），target 直接等于 offset
  const first = WEBGL_OK ? -1 : 0;
  mover.obj.offset = Math.max(first, Math.min(last, mover.obj.offset + d / 120));
  mover.obj.target = mover.obj.offset;
}, { passive: false });

// 点击搜索区外的空白处，收起 Inbox / Gallery 搜索栏并回到休息态（关键词与筛选一并清空）。
document.addEventListener("click", (event) => {
  if (!["inbox", "gallery"].includes(state().ui.view)) return;
  if (event.target.classList?.contains("inbox-all-overlay")) return;
  const refreshDiscovery = () => document.querySelector(".inbox-all-overlay") ? refreshInboxAllOverlay() : render();
  // 按钮/链接/可交互元素由各自 action 处理，不在这里触发重渲染
  if (event.target.closest?.("[data-action], [data-nav], button, a, details, .capture-form, .capture-overlay")) return;
  const inDiscovery = Boolean(event.target.closest?.(".inbox-discovery, .gallery-discovery"));
  const inSearchBar = Boolean(event.target.closest?.(".discovery-bar"));
  const inMagnifier = Boolean(event.target.closest?.('[data-action="toggle-search"]'));
  const inboxBarShown = Boolean(document.querySelector(".inbox-page .discovery-bar"));
  const inboxSearchOpen = inboxBarShown || inboxFilters.searchOpen || inboxFilters.expanded || Boolean(inboxFilters.query);
  const gallerySearchOpen = galleryFilters.expanded || Boolean(galleryFilters.query);
  const panelOpen = inboxFilters.menuOpen || galleryFilters.menuOpen || Boolean(inboxFilters.explore) || Boolean(galleryFilters.explore);
  if (!inboxSearchOpen && !gallerySearchOpen && !panelOpen) return;
  if (inSearchBar || inMagnifier) return;

  if (inDiscovery) {
    // 发现区内（Explore 面板等）：只收起搜索栏，保留面板和筛选
    if (inboxSearchOpen || gallerySearchOpen) {
      inboxFilters.searchOpen = false;
      inboxFilters.expanded = false;
      inboxFilters.query = "";
      galleryFilters.expanded = false;
      galleryFilters.query = "";
      document.querySelector(".inbox-page")?.classList.remove("is-searching");
      document.querySelector(".gallery-page")?.classList.remove("is-searching");
      refreshDiscovery();
    }
    return;
  }

  // 发现区外：完整复位（搜索 + 面板 + 筛选）
  inboxFilters.searchOpen = false;
  inboxFilters.expanded = false;
  inboxFilters.menuOpen = false;
  inboxFilters.query = "";
  inboxFilters.explore = null;
  inboxFilters.mode = "all";
  galleryFilters.expanded = false;
  galleryFilters.menuOpen = false;
  galleryFilters.query = "";
  galleryFilters.explore = null;
  document.querySelector(".inbox-page")?.classList.remove("is-searching");
  document.querySelector(".gallery-page")?.classList.remove("is-searching");
  refreshDiscovery();
});

// 点击搜索区以外关闭 Explore by / Recommended 延展面板。
document.addEventListener("click", (event) => {
  if (event.target.closest?.(".notes-all-discovery")) return;
  if (notesAllFilters.menuOpen) { notesAllFilters.menuOpen = false; refreshNotesAllArchive(); return; }
  if (event.target.classList?.contains("inbox-all-overlay")) return;
  if (event.target.closest?.(".inbox-discovery, .gallery-discovery")) return;
  if (inboxFilters.menuOpen) { inboxFilters.menuOpen = false; if (!refreshInboxAllOverlay()) render(); return; }
  if (galleryFilters.menuOpen) { galleryFilters.menuOpen = false; render(); }
});

document.addEventListener("click", (event) => {
  if (event.target.closest?.('[data-chat-controller], [data-workspace-conversations]')) return;
  if (event.target.closest(".home-ticket-poster a")) return;
  const target = event.target.closest("[data-action], [data-nav]"); if (!target) return;
  if (target.matches("a")) event.preventDefault();
  const action = target.dataset.action ?? target.dataset.nav;
  if (LIGHT_PRESENTATION && (target.dataset.nav || action === "inbox-home")) {
    switchLightPage(target.dataset.nav || "home");
    return;
  }
  if (action === "quick-note-pick") {
    const form = target.closest(".quick-note");
    form?.querySelector("[data-quick-note-file]")?.click();
    return;
  }
  if (action === "quick-note-open") {
    if (foyerQuickNoteSuppressClick) return;
    setFoyerQuickNoteOpen(true);
    return;
  }
  if (action === "quick-note-close") {
    closeFoyerQuickNote();
    return;
  }
  if (action === "quick-note-remove") {
    const context = target.dataset.context;
    const draft = quickNoteDraft(context);
    draft.images.splice(Number(target.dataset.index) || 0, 1);
    renderQuickNoteImages(context);
    return;
  }
  if (action === "quick-note-clear-exhibit") {
    setFoyerQuickNoteExhibit("", "");
    return;
  }
  if (action === "close-exhibit-detail") { closeExhibitDetail(); return; }
  if (action === "switch-exhibit-detail") { openExhibitDetail(target.dataset.exhibit); return; }
  if (action === "jump-exhibit-chapter") {
    document.getElementById(`exhibit-chapter-${target.dataset.chapter}`)?.scrollIntoView({ behavior: glassReducedMotion() ? "auto" : "smooth", block: "start" });
    return;
  }
  if (action === "save-selection-note") {
    saveExhibitNote({ kind: "text", content: exhibitDetail.selection });
    target.classList.remove("is-visible");
    window.getSelection()?.removeAllRanges();
    return;
  }
  if (action === "save-image-note") {
    const menu = target.closest(".exhibit-image-menu");
    saveExhibitNote({ kind: "image", content: menu?.dataset.imageSrc });
    menu?.classList.remove("is-visible");
    return;
  }
  if (action === "close-note-drawer") { closeExhibitNoteDrawer(target.closest(".exhibit-note-drawer")); return; }
  if (state().ui.view === "inbox" && inboxView.mode === "home" && ["home", "inbox", "gallery", "records"].includes(action)) {
    const id = action === "home" ? "top" : action === "records" ? "notes" : action;
    scrollToHomeSection(id);
    return;
  }
  if (action === "edit-block") { beginBlockEdit(target); return; }
  if (action === "set-collection-category") {
    const form = target.closest('[data-form="collection-category"]');
    setCollectionCategory(form?.dataset.collectionId, target.dataset.category);
    return;
  }
  if (action === "back-to-exhibition") {
    if (closeFoyerOverHome()) return;
    inboxView.mode = "home";
    navigate("inbox");
    return;
  }
  if (action === "inbox") {
    inboxView.mode = "home";
    return navigate("inbox");
  }
      if (["gallery", "records"].includes(action)) {
        return navigate(action);
      }
  if (action === "other-thought") { showOtherThought(target); return; }
  if (action === "open-recap-ticket") { openRecapTicket(target.dataset.exhibition); return; }
  if (action === "close-recap-ticket") { closeRecapTicket(); return; }
      if (action === "serendipity") { enterSerendipity(); return; }
  if (action === "shuffle-home-gallery") { shuffleHomeGallery(); return; }
  if (action === "serendipity-open") { navigate("foyer"); return; }
  if (action === "serendipity-decision") {
    const card = target.closest(".glass-card") || target.closest("[data-noomo-caption]");
    const candidate = serendipity.order[Number(card?.dataset.index)];
    if (!candidate) return;
    const decision = target.dataset.value;
    store.update((draft) => {
      draft.feedback = applySerendipityDecision(draft.feedback, candidate, decision);
      if (candidate.kind === "exhibition") {
        const entry = draft.exhibitions.find((item) => item.id === candidate.id);
        if (entry) entry.recommendationDecision = decision;
      }
    });
    card.classList.add("is-decided");
    const stateEl = card.querySelector(".glass-decision-state");
    if (stateEl) { stateEl.textContent = serendipityDecisionLabel(decision); stateEl.classList.add("is-on"); }
    return;
  }
  if (action === "open-collection") {
    if (event.target.closest("details")) return;
    if (!LIGHT_PRESENTATION && target.classList.contains("circular-card") && state().ui.view === "inbox") {
      openRecommendFocus(target);
      return;
    }
    navigate("collection", {
      collectionId: target.dataset.collectionId,
      collectionTag: target.dataset.tag || state().ui.collectionTag || null,
      collectionMembers: target.dataset.members ? target.dataset.members.split(",") : state().ui.collectionMembers || null,
      collectionFrom: state().ui.view === "collection" ? state().ui.collectionFrom : state().ui.view,
    });
    return;
  }
  if (action === "open-focused-collection") {
    const source = focusedRecommendCard?.source;
    if (!source) return;
    closeRecommendFocus();
    navigate("collection", {
      collectionId: source.dataset.collectionId,
      collectionTag: source.dataset.tag || null,
      collectionMembers: source.dataset.members ? source.dataset.members.split(",") : null,
      collectionFrom: "inbox",
    });
    return;
  }
  if (action === "detail-scroll") {
    const sequence = document.querySelector(".collection-immersive__sequence");
    if (sequence) window.scrollTo({ top: sequence.offsetTop + (sequence.offsetHeight - window.innerHeight) * 0.56, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return;
  }
  if (action === "detail-more") {
    const root = target.closest(".collection-immersive");
    const finale = root?.querySelector(".collection-immersive__finale");
    const expanded = root?.classList.toggle("is-archive-open") ?? false;
    target.setAttribute("aria-expanded", String(expanded));
    target.querySelector("span").textContent = expanded ? "−" : "＋";
    if (expanded) window.setTimeout(() => finale?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    return;
  }
  if (action === "understanding-tab") {
    const reading = target.closest(".collection-glass__reading");
    if (!reading) return;
    const value = target.dataset.value;
    const tabs = [...reading.querySelectorAll('[role="tab"][data-action="understanding-tab"]')];
    const panels = [...reading.querySelectorAll("[data-understanding-tab-panel]")];
    tabs.forEach((tab) => {
      const selected = tab.dataset.value === value;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.understandingTabPanel !== value; });
    return;
  }
  if (action === "add-collection-tag") {
    const section = target.closest(".collection-glass__ideas");
    const existing = section.querySelector(".collection-tag-form");
    if (existing) { existing.querySelector("input").focus(); return; }
    target.setAttribute("aria-expanded", "true");
    section.insertAdjacentHTML("beforeend", `<form class="collection-tag-form" data-form="collection-tag"><label class="sr-only" for="collection-tag-input">新的线索</label><input id="collection-tag-input" name="tag" maxlength="24" autocomplete="off" placeholder="写一个词，按回车添加" required/><button type="submit">添加</button><button type="button" data-action="cancel-collection-tag">取消</button><span role="status" data-tag-status></span></form>`);
    section.querySelector("input").focus();
    return;
  }
  if (action === "cancel-collection-tag") {
    target.closest(".collection-tag-form")?.remove();
    const trigger = document.querySelector('[data-action="add-collection-tag"]');
    trigger?.setAttribute("aria-expanded", "false"); trigger?.focus(); return;
  }
  if (action === "remove-collection-tag") {
    const collectionId = state().ui.collectionId;
    const extraction = state().extractions.find((entry) => entry.collectionId === collectionId);
    const key = `understanding:${collectionId}`;
    const sourceTags = [...new Set([...(extraction?.tags || []), ...(extraction?.concepts || [])])];
    store.update((draft) => {
      const previous = draft.feedback[key] || {};
      const acceptedTags = Array.isArray(previous.acceptedTags) ? previous.acceptedTags : sourceTags;
      draft.feedback[key] = { ...previous, acceptedTags: acceptedTags.filter((tag) => tag !== target.dataset.tag), tagsReviewedAt: new Date().toISOString() };
    });
    refreshCollectionView();
    return;
  }
  if (action === "close-collection") { closeCollection(); return; }
  if (action === "inbox-all") {
    if (state().ui.view === "inbox") openInboxAllOverlay();
    else { inboxView.mode = "all"; navigate("inbox"); }
    return;
  }
  if (action === "gallery-all") {
    openGalleryAllOverlay();
    return;
  }
  if (action === "close-gallery-all") { closeGalleryAllOverlay(); return; }
  if (action === "gallery-all-focus-search") {
    galleryAll.searchOpen = !galleryAll.searchOpen;
    if (!galleryAll.searchOpen) galleryAll.query = "";
    galleryAll.menuOpen = false;
    refreshGalleryAllOverlay({ focusSearch: galleryAll.searchOpen });
    return;
  }
  if (action === "gallery-all-menu") {
    galleryAll.menuOpen = !galleryAll.menuOpen;
    refreshGalleryAllOverlay();
    return;
  }
  if (action === "gallery-all-status") {
    galleryAll.status = target.dataset.value || "all";
    galleryAll.menuOpen = false;
    refreshGalleryAllOverlay();
    return;
  }
  if (action === "gallery-all-sort") {
    galleryAll.sort = target.dataset.value || "generated";
    galleryAll.menuOpen = false;
    refreshGalleryAllOverlay();
    return;
  }
  if (action === "gallery-all-reset") {
    galleryAll.query = "";
    galleryAll.status = "all";
    galleryAll.sort = "generated";
    galleryAll.menuOpen = false;
    galleryAll.searchOpen = false;
    refreshGalleryAllOverlay();
    return;
  }
  if (action === "gallery-all-open") {
    openGalleryPreviewTicket(Number(target.dataset.index) || 0);
    return;
  }
  if (action === "notes-all-focus-search") {
    notesAllFilters.searchOpen = !notesAllFilters.searchOpen;
    if (!notesAllFilters.searchOpen) notesAllFilters.query = "";
    notesAllFilters.menuOpen = false;
    refreshNotesAllArchive({ focusSearch: notesAllFilters.searchOpen });
    return;
  }
  if (action === "notes-all-menu") {
    notesAllFilters.menuOpen = !notesAllFilters.menuOpen;
    refreshNotesAllArchive();
    return;
  }
  if (action === "notes-all-month") {
    notesAllFilters.month = target.dataset.value || "all";
    notesAllFilters.menuOpen = false;
    refreshNotesAllArchive();
    return;
  }
  if (action === "notes-all-theme") {
    notesAllFilters.theme = target.dataset.value || "all";
    notesAllFilters.menuOpen = false;
    refreshNotesAllArchive();
    return;
  }
  if (action === "notes-all-sort") {
    notesAllFilters.sort = ["newest", "oldest", "title"].includes(target.dataset.value) ? target.dataset.value : "newest";
    notesAllFilters.menuOpen = false;
    refreshNotesAllArchive();
    return;
  }
  if (action === "notes-all-clear-search") {
    notesAllFilters.query = "";
    notesAllFilters.month = "all";
    notesAllFilters.theme = "all";
    notesAllFilters.searchOpen = true;
    refreshNotesAllArchive({ focusSearch: true });
    return;
  }
  if (action === "notes-all-tag") {
    notesAllFilters.query = target.dataset.value || "";
    notesAllFilters.searchOpen = true;
    notesAllFilters.menuOpen = false;
    refreshNotesAllArchive({ focusSearch: true });
    return;
  }
  if (action === "notes-all-reset") {
    notesAllFilters.query = "";
    notesAllFilters.month = "all";
    notesAllFilters.theme = "all";
    notesAllFilters.sort = "newest";
    notesAllFilters.menuOpen = false;
    notesAllFilters.searchOpen = false;
    refreshNotesAllArchive();
    return;
  }
  if (action === "notes-all-open-exhibition") {
    const exhibitionId = target.dataset.exhibitionId;
    if ((state().liveExhibitions || []).some(item => item.id === exhibitionId)) liveAI.show(exhibitionId);
    else if (exhibitionId) openRecapTicket(exhibitionId);
    return;
  }
  if (action === "close-inbox-all") {
    closeInboxAllOverlay();
    return;
  }
  if (action === "inbox-home") {
    if (state().ui.view === "inbox" && inboxView.mode === "all") {
      closeInboxAllOverlay();
      window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    if (state().ui.view === "inbox" && inboxView.mode === "home") {
      window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    inboxView.mode = "home";
    if (state().ui.view === "inbox") render();
    else navigate("inbox", {}, { scrollTop: 0 });
    return;
  }
  if (action === "notes-all") { openNotesAllOverlay(target); return; }
  if (action === "close-notes-all") { closeNotesAllOverlay(); return; }
  if (action === "save-note") {
    const noteText = target.closest(".detail-note,.collection-glass__note,.collection-immersive__note")?.querySelector("textarea")?.value.trim() ?? "";
    store.update((draft) => { draft.notes[state().ui.collectionId] = noteText; });
    collectionNoteDrafts.delete(state().ui.collectionId);
    const status = document.querySelector("[data-note-status]");
    if (status) { status.textContent = "已保存"; status.setAttribute("role", "status"); }
    return;
  }
  const inInboxOverlay = Boolean(target.closest(".inbox-all-overlay"));
  const refreshInboxInteraction = () => inInboxOverlay ? refreshInboxAllOverlay() : render();
  const isGallery = Boolean(target.closest(".gallery-page"));
  const filters = isGallery ? galleryFilters : inboxFilters;
  if (action === "toggle-explore") {
    const opening = !filters.menuOpen;
    if (opening && !isGallery && !inInboxOverlay) {
      const results = document.querySelector(".inbox-page .inbox-results");
      if (results) {
        results.classList.add("is-hiding-for-explore");
        window.setTimeout(() => { inboxFilters.menuOpen = true; render(); }, 170);
        return;
      }
    }
    filters.menuOpen = opening;
    refreshInboxInteraction();
    return;
  }
  if (action === "toggle-search") {
    if (inboxFilters.searchOpen) {
      inboxFilters.query = "";
      inboxFilters.explore = null;
      inboxFilters.mode = "all";
      inboxFilters.menuOpen = false;
      inboxFilters.expanded = false;
    }
    inboxFilters.searchOpen = !inboxFilters.searchOpen;
    refreshInboxInteraction();
    if (inboxFilters.searchOpen) setTimeout(() => document.getElementById("inbox-search")?.focus(), 0);
    return;
  }
  if (action === "live-ai-panel") { liveAI.show(); return; }
  if (action === "refresh-live-source" && PRIVATE_WORKSPACE) { liveAI.refreshSource?.(target.dataset.collectionId); return; }
  if (action === "retry-live-collection" && PRIVATE_WORKSPACE && typeof liveAI.retry === "function") {
    if (target.disabled) return;
    target.disabled = true;
    const label = target.textContent;
    target.textContent = "正在提交…";
    void liveAI.retry(target.dataset.collectionId).finally(() => { if (target.isConnected) { target.disabled = false; target.textContent = label; } });
    return;
  }
  if (action === "live-exhibition") { liveAI.show(target.dataset.exhibitionId); return; }
  if (action === "toggle-capture") {
    if (inboxFilters.captureOpen) closeCaptureOverlay();
    else openCaptureOverlay(target);
    return;
  }
  if (action === "capture-mode") { switchCaptureMode(target.dataset.mode); return; }
  if (action === "close-capture") { closeCaptureOverlay(); return; }
  if (action === "recommend-prev" || action === "recommend-next") {
    if (LIGHT_PRESENTATION) return;
    const dir = action === "recommend-next" ? 1 : -1;
    if (recommendGallery) recommendGallery.move(dir);
    else if (inboxFilters.menuOpen) pendingRecommendMove = dir;
    return;
  }
  if (action === "toggle-recommended") {
    inboxFilters.mode = inboxFilters.mode === "recommended" ? "all" : "recommended";
    inboxFilters.menuOpen = false;
    inboxFilters.query = "";
    inboxFilters.explore = null;
    inboxFilters.expanded = false;
    refreshInboxInteraction();
    return;
  }
  if (action === "load-more") { loadNextInboxPage(); return; }
  if (action === "explore") { filters.explore = { dim: target.dataset.dim, value: target.dataset.value }; filters.menuOpen = false; refreshInboxInteraction(); return; }
  if (action === "clear-explore") { filters.explore = null; filters.menuOpen = false; refreshInboxInteraction(); return; }
  if (action === "clear-all") { filters.query = ""; filters.explore = null; filters.menuOpen = false; inboxFilters.limit = 12; (isGallery ? document.getElementById("gallery-search") : document.getElementById("inbox-search"))?.blur(); refreshInboxInteraction(); return; }
  if (action === "insight-dismiss") { inboxFilters.menuOpen = false; store.update((draft) => { draft.feedback[`insight:${target.dataset.tag}`] = { dismissed: true, updatedAt: new Date().toISOString() }; }); refreshInboxInteraction(); return; }
  if (action === "insight-keep") { inboxFilters.menuOpen = false; store.update((draft) => { draft.feedback[`insight:${target.dataset.tag}`] = { kept: true, updatedAt: new Date().toISOString() }; }); refreshInboxInteraction(); return; }
  if (action === "foyer") {
    if (!exhibitionState()) return;
    if (state().ui.view === "inbox" && inboxView.mode === "home") openFoyerOverHome();
    else navigate("foyer");
    return;
  }
  if (action === "room") navigate("room", { roomIndex: Number(target.dataset.room), exhibitIndex: 0 });
  if (action === "previous-exhibit") store.update((draft) => { draft.ui.exhibitIndex = Math.max(0, draft.ui.exhibitIndex - 1); });
  if (action === "advance-exhibit") store.update((draft) => { const progress = draft.exhibitions.find((item) => item.id === exhibitionFixture.id); if (!progress.viewed.includes(target.dataset.exhibit)) progress.viewed.push(target.dataset.exhibit); if (draft.ui.exhibitIndex < currentRoom().exhibits.length - 1) draft.ui.exhibitIndex += 1; });
  if (action === "reveal") store.update((draft) => { const progress = draft.exhibitions.find((item) => item.id === exhibitionFixture.id); if (!progress.revealed.includes(target.dataset.connection)) progress.revealed.push(target.dataset.connection); });
  if (action === "feedback") store.update((draft) => { draft.feedback[target.dataset.connection] = { value: target.dataset.value, disputed: target.dataset.value === "有点牵强", correction: draft.feedback[target.dataset.connection]?.correction ?? "", updatedAt: new Date().toISOString() }; });
  if (action === "recommendation") store.update((draft) => { draft.exhibitions.find((item) => item.id === exhibitionFixture.id).recommendationDecision = target.dataset.value; });
  if (action === "finale") { store.update((draft) => { draft.exhibitions.find((item) => item.id === exhibitionFixture.id).completed = true; draft.ui.view = "finale"; }); }
  if (action === "reset" && window.confirm("这会清除当前浏览器中的收藏和模型整理结果，无法撤销。继续吗？")) { store.reset(); }
  renderWithTransition();
});

const liveAIOptions = {
  store,
  openReadingNote: payload => lightWorkspace.openReadingNote(payload),
  navigatePage: switchLightPage,
  refresh: () => {
    const inboxRefreshed = refreshInboxAllOverlay();
    if (collectionLiveModal) refreshCollectionView();
    else if (!inboxRefreshed) render();
  },
  openCollection: (id) => { navigate("collection", { collectionId: id, collectionFrom: "inbox" }); },
};
const liveAI = DESKTOP_WORKSPACE?.mountLiveAI?.(liveAIOptions) || DESKTOP_WORKSPACE?.liveAI || mountLiveAI(liveAIOptions);
if (LIGHT_PRESENTATION) lightWorkspace.bindWorkspace({
  state,
  render: () => collectionLiveModal ? refreshCollectionView() : render(),
  galleryItems: galleryArchiveItems,
  openCollection: liveAIOptions.openCollection,
  collectionCoverColor: DESKTOP_WORKSPACE?.collectionCoverColor,
  navigate: switchLightPage,
  capture: openCaptureOverlay,
  async saveNote(note) {
    store.update(draft => {
      const index = draft.studioNotes.findIndex(item => item.id === note.id);
      if (index === -1) draft.studioNotes.unshift(note);
      else draft.studioNotes[index] = note;
      if (note.exhibitionId) ensureThemeForNote(draft, note);
    });
    await DESKTOP_WORKSPACE?.flushWorkspace?.();
  },
});
render();
