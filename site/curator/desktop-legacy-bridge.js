import { renderTaskProgress } from './task-view.js';
import { closeGlassDialog, frameGlassDialog } from './glass-dialogs.js';
import { createWorkspaceChatLauncher } from './workspace-chat-launch.js';
import { mountWorkspaceConversationShell } from './workspace-conversation-shell.js';
import { mountKnowledgePanel } from './knowledge-panel.js';
import { mountArticleReading } from './article-reading.js';
import { curationStoryKey, renderCurationStory, mountCurationStory } from './curation-story.js';
import { curationColor } from './curation-theme.js';
import { mountReadingSettings } from './reading-settings.js';
import { icon } from '../prototype/immersive-exhibition/light-workspace.js';

const clone = (value) => structuredClone(value);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const errorMessage = (error) => typeof error?.message === "string" && /[\u3400-\u9fff]/u.test(error.message) ? error.message : "本机整理服务暂时没有响应，请稍后重试。";
const mapFields = ["feedback", "notes", "collectionCategories"];
const rowFields = ["exhibitionNotes", "exhibitionRecords", "studioNotes", "themes"];
const uiDefaults = { view: "inbox", roomIndex: 0, exhibitIndex: 0, recommendationIndex: 0, studioNoteId: null };
let returningToLogin = false;
function signIn() {
  if (returningToLogin) return;
  returningToLogin = true;
  location.replace("/login");
}

export function mapDesktopState(remote, previous = {}) {
  const workspace = remote.workspace || {};
  const collections = (remote.collections || []).map((item) => ({ ...item, live: true, addedAt: item.addedAt || item.createdAt }));
  const ids = new Map(collections.map((item) => [item.extraction?.collectionId || item.id, item.id]));
  // An explicit source refresh creates a new signed source ID. Historical
  // exhibitions retain their original IDs and their stable local collection map.
  for (const exhibition of remote.exhibitions || []) {
    const sources = exhibition.sourceCollectionIds || [], locals = exhibition.collectionIds || [];
    if (sources.length !== locals.length) continue;
    sources.forEach((sourceId, index) => { if (collections.some((item) => item.id === locals[index])) ids.set(sourceId, locals[index]); });
  }
  const localId = (value) => ids.get(value) || value;
  const extractions = collections.map((item) => ({
    ...(item.extraction || { summary: "", reliability: 0, concepts: [], tags: [], digest: { status: "unavailable", highlights: [] }, breakdown: { status: "unavailable", sections: [] } }),
    collectionId: item.id,
    status: item.status === "processing" ? "processing" : item.extraction?.status || "needs_input",
    hint: item.error || item.extraction?.hint || (item.status === "saved" ? "原始内容已保存在本机，连接整理服务后可以继续。" : item.status === "processing" ? "已收下，正在本机后台整理。" : ""),
  }));
  const liveExhibitions = (remote.exhibitions || []).map((exhibition) => ({
    ...exhibition,
    sourceCollectionIds: (exhibition.sourceCollectionIds || []).map(localId),
    rooms: (exhibition.rooms || []).map((room) => ({ ...room, exhibit_ids: (room.exhibit_ids || []).map(localId) })),
    items: (exhibition.items || []).map((item) => ({ ...item, id: localId(item.id) })),
  }));
  const progress = workspace.exhibitionProgress || [];
  const state = {
    version: 2, collections, extractions, liveExhibitions,
    workspaceJobs: clone(remote.jobs || []), desktopCapabilities: clone(remote.capabilities || {}),
    exhibitions: liveExhibitions.map((item) => ({ id: item.id, status: "ready", viewed: [], revealed: [], completed: false, recommendationDecision: null, ...progress.find((entry) => entry.id === item.id) })),
    liveTasks: (remote.jobs || []).filter((job) => job.collectionId).map((job) => ({ ...job, status: ["queued", "running"].includes(job.status) ? "processing" : job.status, resultId: job.status === "complete" ? job.collectionId : null, title: collections.find((item) => item.id === job.collectionId)?.title || "收藏处理" })),
    curationTask: { id: null, status: liveExhibitions.length ? "ready" : "waiting", gates: [], blockedBy: liveExhibitions.length ? null : "insufficient_qualified_content", exhibitionId: liveExhibitions.at(-1)?.id || null },
    ui: { ...uiDefaults, ...previous.ui },
  };
  for (const field of mapFields) state[field] = clone(workspace[field] || {});
  for (const field of rowFields) state[field] = clone(workspace[field] || []);
  return state;
}

export function workspaceDiff(before, after) {
  const ops = [];
  for (const field of mapFields) {
    const old = before[field] || {}, next = after[field] || {};
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (JSON.stringify(old[key]) === JSON.stringify(next[key])) continue;
      ops.push({ field, key, ...(Object.hasOwn(next, key) ? { value: clone(next[key]) } : { delete: true }) });
    }
  }
  for (const field of [...rowFields, "exhibitionProgress"]) {
    const source = field === "exhibitionProgress" ? "exhibitions" : field;
    const old = new Map((before[source] || []).map((item) => [item.id, item]));
    const next = new Map((after[source] || []).map((item) => [item.id, item]));
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      if (JSON.stringify(old.get(key)) === JSON.stringify(next.get(key))) continue;
      ops.push({ field, key, ...(next.has(key) ? { value: clone(next.get(key)) } : { delete: true }) });
    }
  }
  return ops;
}

export function productWorkspaceURL(value) {
  const url = new URL(value);
  url.searchParams.delete("sample");
  return url;
}

async function bootstrap() {
  document.documentElement.classList.toggle("is-native", Boolean(window.webkit?.messageHandlers?.forme));
  const productURL = productWorkspaceURL(location.href);
  if (productURL.href !== location.href) history.replaceState(history.state, "", productURL);
  let remote, current, store, refresh, openCollection, navigatePage, dialog, conversationShell, knowledgePanel, articleReading, curationStory, openReadingNote, readingSettings, selected = null;
  let readingContainer, readingCollectionId, readingSourceKey;
  let resolveShell;
  const shellReady = new Promise(resolve => { resolveShell = resolve; });
  let launchRequest = null, launchRevision = null;
  let suppressSave = false, writes = Promise.resolve(), failedOps = [], deferredRefresh = false;
  let lastWriteError;
  let syncing = false, syncAgain = false;
  let deferredDialog = false, drawnSelected = null, drawnStoryKey = null;
  const launchChat = createWorkspaceChatLauncher({
    api, storage: window.sessionStorage, flush: () => writes,
    navigate: async url => {
      await shellReady;
      const expected = launchRevision ?? conversationShell.getRevision();
      if (expected !== conversationShell.getRevision()) return;
      remote = await api('state');
      if (expected !== conversationShell.getRevision()) return;
      conversationShell.update(remote);
      await conversationShell.show(new URL(url,location.origin).searchParams.get('conversation'));
    },
  });
  function openChat(detail) {
    if (launchRequest) return launchRequest;
    launchRevision = conversationShell?.getRevision() ?? null;
    launchRequest = launchChat(detail).finally(() => { launchRequest=null; launchRevision=null; });
    return launchRequest;
  }
  window.addEventListener('forme:workspace-chat', async event => {
    const result = await openChat(event.detail);
    window.dispatchEvent(new CustomEvent('forme:workspace-chat-result', { detail: result }));
  });
  async function api(route, body, method = "POST") {
    const response = await fetch(`/api/desktop/${route}`, body === undefined ? { cache: "no-store" } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (response.status === 401 && data.code === "SIGN_IN_REQUIRED") signIn();
    if (!response.ok) throw new Error(data.error || "本机资料暂时无法保存，请重试。");
    return data;
  }
  function status(value, error = false, retry = () => queueWorkspace([])) {
    let node = document.getElementById("forme-desktop-save-status");
    if (!node) {
      node = document.createElement("div"); node.id = "forme-desktop-save-status"; node.setAttribute("role", "status");
      node.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:2147483600;padding:8px 14px;background:#24262bf2;color:#dce0e8;border:1px solid #ffffff1c;border-radius:8px;font:12px/1.5 var(--forme-font-ui,sans-serif);box-shadow:0 6px 24px #0004;max-width:90vw";
      document.body.append(node);
    }
    node.textContent = value; node.hidden = !value; node.style.color = error ? "#e2aaa8" : "#dce0e8";
    if (error) { const button = document.createElement("button"); button.textContent = "重试"; button.style.marginLeft = "10px"; button.onclick = retry; node.append(button); }
    document.documentElement.dataset.desktopSave = error ? "error" : value ? "pending" : "saved";
  }
  function queueWorkspace(ops) {
    if (!ops.length && !failedOps.length) return;
    status("正在保存到这台电脑…");
    writes = writes.then(async () => {
      const batch = [...failedOps, ...ops];
      try { remote = (await api("workspace", { ops: batch })).state; failedOps = []; lastWriteError = null; status(""); }
      catch (error) { failedOps = batch; lastWriteError = error; status(`尚未保存：${errorMessage(error)}`, true); }
    });
  }
  async function flushWorkspace() {
    await writes;
    if (failedOps.length) throw lastWriteError || new Error("手记尚未保存，请重试。");
  }
  function syncReading() {
    if (!articleReading || !store) return;
    const target = document.querySelector('[data-collection-reading]');
    const id = store.getState().ui.collectionId;
    if (!target || !id) {
      if (readingContainer) articleReading.close();
      readingContainer = null; readingCollectionId = null; readingSourceKey = null;
      return;
    }
    const collection = store.getState().collections.find(item => item.id === id);
    const sourceKey = JSON.stringify([id, collection?.sourceRevision || 1, collection?.knowledgeDocumentVersionId || '', collection?.understandingDocumentVersionId || '']);
    const sourceChanged = readingSourceKey !== undefined && readingSourceKey !== null && readingCollectionId === id && sourceKey !== readingSourceKey;
    if (readingContainer === target && readingCollectionId === id && !sourceChanged) return;
    readingContainer = target; readingCollectionId = id; readingSourceKey = sourceKey;
    void articleReading.open(id, { container: target, forceReload: sourceChanged });
  }
  function drafts() {
    return [...document.querySelectorAll("textarea,select,input:not([type=file]):not([type=radio]):not([type=checkbox])")].map((element, index) => ({ id: element.id, index, value: element.value, tag: element.tagName }));
  }
  function refreshSafely() {
    if (!refresh) return;
    if (document.activeElement?.matches("textarea,input,select,[contenteditable=true]")) { deferredRefresh = true; return; }
    const saved = drafts();
    refresh();
    const elements = [...document.querySelectorAll("textarea,select,input:not([type=file]):not([type=radio]):not([type=checkbox])")];
    for (const draft of saved) { const element = draft.id ? document.getElementById(draft.id) : elements[draft.index]; if (element?.tagName === draft.tag) element.value = draft.value; }
    deferredRefresh = false;
  }
  async function sync() {
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      await writes;
      remote = await api("state");
      conversationShell?.update(remote);
      const next = mapDesktopState(remote, current);
      if (failedOps.length) {
        for (const field of [...mapFields, ...rowFields]) next[field] = current[field];
        next.exhibitions = current.exhibitions;
      }
      const changed = JSON.stringify({ ...current, ui: null }) !== JSON.stringify({ ...next, ui: null });
      current = next;
      if (store) {
        suppressSave = true;
        store.update((draft) => { for (const [key, value] of Object.entries(next)) if (key !== "ui") draft[key] = clone(value); });
        suppressSave = false;
      }
      if (changed) { refreshSafely(); if (dialog?.open) draw(); }
    } catch (error) { status(errorMessage(error), true, () => { void sync(); }); }
    finally { syncing = false; if (syncAgain) { syncAgain = false; void sync(); } }
  }
  function draw() {
    if (!dialog) return;
    const exhibitions = current.liveExhibitions || [];
    const exhibition = exhibitions.find((item) => item.id === selected);
    const storyKey = exhibition ? curationStoryKey(exhibition, current.collections) : null;
    const sameSelection = drawnSelected === selected && dialog.open;
    if (sameSelection && curationStory && storyKey === drawnStoryKey) { deferredDialog = false; return; }
    if (sameSelection && dialog.contains(document.activeElement) && document.activeElement?.matches("textarea,input,select,[contenteditable=true],[data-curation-model-menu] button")) { deferredDialog = true; return; }
    const noteDraft = sameSelection ? dialog.querySelector("[data-desktop-exhibition-note]")?.value : undefined;
    const initialMode = sameSelection ? dialog.querySelector('.folio-curation-story')?.dataset.curationMode : undefined;
    curationStory?.destroy(); curationStory = null;
    dialog.classList.toggle('folio-curation-dialog', Boolean(exhibition));
    if (exhibition) {
      dialog.style.setProperty('--folio-exhibition-color', curationColor(exhibition));
      const close = `<button type="button" class="btn folio-story-close" data-variant="ghost" data-size="icon-sm" data-desktop="close" aria-label="关闭展览">${icon('close')}</button>`;
      dialog.innerHTML = `<div class="forme-live-body">${renderCurationStory(exhibition, current.collections)}</div>${close}`;
      dialog.setAttribute('aria-labelledby', 'folio-story-title');
      curationStory = mountCurationStory({ container:dialog, exhibition, collections:current.collections, initialMode, api,
        onCreateNote: payload => closeGlassDialog(dialog).then(() => openReadingNote?.(payload)),
        openChat: detail => closeGlassDialog(dialog).then(() => openChat(detail)),
        openCollection: id => { void closeGlassDialog(dialog).then(() => openCollection?.(id)); },
        openOriginal: (id, options) => { void closeGlassDialog(dialog).then(() => { openCollection?.(id); syncReading(); return articleReading?.openOriginal(id, { ...options, container:readingContainer }); }); },
      });
    } else {
      const jobs = remote?.jobs || [];
      const progressJobs = jobs.map((job) => ({ ...job, subject: current.collections.find((item) => item.id === job.collectionId)?.title || exhibitions.find((item) => item.id === job.exhibitionId)?.title }));
      const qualified = current.extractions.filter((item) => item.status === "qualified").length;
      const autoTopic = remote?.capabilities?.autoCurate ? "满足条件的本地收藏会自动整理成专题。" : "";
      const manualExhibition = remote?.capabilities?.aiEnabled ? "" : "整理完整展览需要配置智能服务。";
      dialog.style.removeProperty('--folio-exhibition-color');
      dialog.innerHTML = `<header class="forme-live-head"><div><small>Folio · 本机资料</small><h2>处理记录</h2></div><button type="button" data-desktop="close" aria-label="关闭">×</button></header>
        <p class="forme-live-muted">内容保存在这台电脑。${autoTopic}${manualExhibition}</p>
        <div class="forme-live-actions"><button data-desktop="curate" ${qualified < 6 || !remote?.capabilities?.aiEnabled ? "disabled" : ""}>整理完整展览 <span>${qualified} / 6</span></button><button data-desktop="refresh">刷新状态</button></div>
        ${renderTaskProgress(progressJobs, { limit: 16, completedLimit: 16 }) || "<p>通过「收新」添加网页、文字或图片。</p>"}
        <h3>我的真实展览</h3>${exhibitions.map((item) => `<button class="forme-live-source" data-desktop="exhibition" data-id="${esc(item.id)}"><b>${esc(item.title)}</b><span>${item.status === "needs_review" ? "待核对草稿" : "打开展览"} ↗</span></button>`).join("") || "<p>新的展览会在后台整理完成后出现在这里。</p>"}`;
      frameGlassDialog(dialog);
    }
    if (noteDraft !== undefined && dialog.querySelector("[data-desktop-exhibition-note]")) dialog.querySelector("[data-desktop-exhibition-note]").value = noteDraft;
    drawnSelected = selected; drawnStoryKey = storyKey; deferredDialog = false;
  }
  async function action(route, body) {
    try { await writes; const result = await api(route, body); await sync(); return result; }
    catch (error) { status(errorMessage(error), true, () => { void action(route, body); }); if (dialog && !dialog.open) { draw(); dialog.showModal(); } }
  }
  const liveAI = {
    async capture(input) { return await action("capture", input) || false; },
    async retry(collectionId) { if (!remote?.capabilities?.aiEnabled) return false; return await action("retry", { collectionId }) || false; },
    revise(collectionId, correction) { if (!remote?.capabilities?.aiEnabled || !current.collections.find((item) => item.id === collectionId)?.extraction) { status("请先连接整理服务，并完成原始内容的整理。", true); return false; } void action("revise", { collectionId, correction }); return true; },
    refreshSource(collectionId) { if (!remote?.capabilities?.aiEnabled) { status("请先连接智能整理服务。", true); return false; } void action("refresh-source", { collectionId }); return true; },
    show(exhibitionId) {
      selected = typeof exhibitionId === "string" ? exhibitionId : null;
      if (current.liveExhibitions.some(item => item.id === selected) && store) {
        store.update(draft => {
          const progress = draft.exhibitions.find(item => item.id === selected);
          if (progress && !progress.completed && progress.status !== "completed") progress.status = "showing";
        });
      }
      draw(); if (dialog && !dialog.open) dialog.showModal();
    },
  };
  remote = await api("state");
  current = mapDesktopState(remote);
  const logout = document.querySelector("[data-demo-logout]");
  if (remote.capabilities?.demoAccount && logout) {
    logout.hidden = false;
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      await writes;
      if (failedOps.length) { logout.disabled = false; return; }
      try {
        const response = await fetch("/api/desktop/session", { method:"DELETE" });
        if (!response.ok) throw new Error("暂时无法退出演示，请重试。");
        signIn();
      } catch (error) { status(errorMessage(error), true, () => logout.click()); logout.disabled = false; }
    });
  }
  const native = window.webkit?.messageHandlers?.forme;
  if (native) document.addEventListener("click", event => {
    const anchor = event.target.closest?.('.folio-curation-story a[target="_blank"][href], a.collection-briefing-external[href]');
    if (!anchor || !/^https?:$/u.test(anchor.protocol)) return;
    event.preventDefault();
    native.postMessage({ action:"openExternal", url:anchor.href });
  });
  readingSettings = mountReadingSettings({ api });
  const adapter = {
    load: () => clone(current),
    save(next) {
      if (!suppressSave) {
        queueWorkspace(workspaceDiff(current, next));
      }
      current = clone(next);
      return next;
    },
    clear() { status("私人收藏不会通过浏览器重置清除。", true); },
  };
  window.__FORME_DESKTOP__ = {
    initialState: clone(current), storage: adapter, liveAI, openChat, flushWorkspace,
    async collectionCoverColor(collectionId) { return (await api("collection-cover/color", { collectionId })).color; },
    onWorkspaceRender: () => { conversationShell?.syncVisibility(); knowledgePanel?.sync(); syncReading(); },
    mountLiveAI(config) {
      ({ store, refresh, openCollection, navigatePage, openReadingNote } = config);
      articleReading = mountArticleReading({ api, getState: () => store.getState(),
        openCollection: id => openCollection?.(id), openExhibition: id => liveAI.show(id),
        onCreateNote: payload => config.openReadingNote?.(payload) });
      knowledgePanel = mountKnowledgePanel({ api, getState:() => store.getState(), openCollection:id => openCollection?.(id),
        openReading: (id, options) => { syncReading(); void articleReading.openOriginal(id, { ...options, container:readingContainer }); } });
      const readingObserver = new MutationObserver(syncReading);
      readingObserver.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('pagehide', () => { readingObserver.disconnect(); articleReading?.destroy(); }, { once: true });
      dialog = document.createElement("dialog"); dialog.className = "forme-live-dialog"; document.body.append(dialog);
      dialog.addEventListener('close', () => {
        if (!dialog.open) { curationStory?.destroy(); curationStory = null; deferredDialog = false; }
      });
      dialog.addEventListener("click", (event) => {
        const retry = event.target.closest("[data-retry-job]");
        if (retry && !retry.disabled) {
          retry.disabled = true; retry.textContent = "正在继续…";
          void action("jobs/retry", { jobId: retry.dataset.retryJob }).finally(() => { retry.disabled = false; retry.textContent = "继续处理"; });
          return;
        }
        const button = event.target.closest("[data-desktop]"); if (!button) return;
        const command = button.dataset.desktop;
        if (command === "close") void closeGlassDialog(dialog);
        if (command === "back") { selected = null; void closeGlassDialog(dialog).then(() => navigatePage?.("gallery")); }
        if (command === "collection") void closeGlassDialog(dialog).then(() => openCollection(button.dataset.id));
        if (command === "exhibition") liveAI.show(button.dataset.id);
        if (command === "refresh") void sync();
        if (command === "curate") void action("curate", {});
        if (command === "retry") void action("retry", { collectionId: button.dataset.id });
        if (command === "save-exhibition-note") void action("notes", { exhibitionId: button.dataset.id, text: dialog.querySelector("[data-desktop-exhibition-note]")?.value || "" });
      });
      return liveAI;
    },
  };
  async function showCollection(id) {
    await sync();
    if (current.collections.some((item) => item.id === id)) {
      if (conversationShell?.isVisible()) conversationShell.leave('inbox');
      dialog?.close(); openCollection?.(id);
    }
  }
  window.formeNative = { ...(window.formeNative || {}), refresh: sync, async openExhibition(id) { await sync(); if (conversationShell?.isVisible()) conversationShell.leave('gallery'); liveAI.show(id); }, openCollection: showCollection };
  document.addEventListener("focusout", () => { setTimeout(() => { if (deferredRefresh) refreshSafely(); if (deferredDialog) draw(); }, 0); });
  window.addEventListener("focus", () => { if (failedOps.length) queueWorkspace([]); void sync(); });
  if (typeof EventSource !== "undefined") {
    const events = new EventSource("/api/desktop/events");
    events.addEventListener("open", () => { void sync(); });
    events.addEventListener("state", () => { void sync(); });
    events.addEventListener("signed-out", signIn);
    window.addEventListener("pagehide", () => events.close(), { once: true });
  }
  await import("/prototype/immersive-exhibition/app.js");
  await Promise.resolve().then(async () => {
    conversationShell = mountWorkspaceConversationShell({
      getState:() => remote,
      navigatePage:page => navigatePage?.(page),
      openCollection:id => openCollection?.(id),
      openExhibition:id => liveAI.show(id),
      onState:state => { remote=state; void sync(); },
      onError:message => status(message,true,() => { void sync(); }),
    });
    conversationShell.update(remote);
    resolveShell();
    await conversationShell.route().catch(error => {
      status(errorMessage(error),true,() => { void conversationShell.route().catch(retryError => status(errorMessage(retryError),true)); });
    });
  });
  window.addEventListener('pagehide',() => { conversationShell?.destroy(); knowledgePanel?.destroy(); readingSettings?.destroy(); curationStory?.destroy(); },{once:true});
  const exhibitionId = new URL(location.href).searchParams.get("exhibition");
  if (exhibitionId) liveAI.show(exhibitionId);
  const collectionId = new URL(location.href).searchParams.get("collection");
  if (collectionId) await showCollection(collectionId);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  bootstrap().catch((error) => {
    document.body.innerHTML = `<main style="padding:60px;max-width:720px;margin:auto;font:16px/1.8 -apple-system,sans-serif"><h1>本机资料暂时没有打开</h1><p>${esc(errorMessage(error))}</p><p>请重新打开应用，现有资料会保留。</p><button id="desktop-reload">重新连接</button></main>`;
    document.getElementById("desktop-reload").onclick = () => location.reload();
  });
}
