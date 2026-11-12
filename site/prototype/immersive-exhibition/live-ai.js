import { requestResult, syncTaskState } from "./live-ai-request.js";
import { closeGlassDialog, frameGlassDialog } from "../../curator/glass-dialogs.js";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const stages = { queued: "等待采集", fetching_captions: "正在读取字幕", downloading_audio: "正在取得音频", reading_note: "正在读取笔记", transcribing: "正在转写音频", complete: "采集完成" };
export function mountLiveAI({ store, refresh, openCollection }) {
  let account = null, busy = false, progress = "正在连接 AI…", selectedExhibition = null;
  const dialog = document.createElement("dialog"); dialog.className = "forme-live-dialog";
  document.body.append(dialog);
  const real = () => store.getState().collections.filter((i) => i.live);
  const eligible = () => real().filter((i) => i.receipt && store.getState().extractions.find((e) => e.collectionId === i.id)?.status === "qualified" && !["pending_rewrite", "confirmed_edited"].includes(store.getState().feedback?.[`understanding:${i.id}`]?.decision));
  async function connect() {
    try {
      const response = await fetch("/api/forme?action=session", { credentials: "same-origin", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(); account = await response.json();
      progress = account.enabled ? "已登录展示账号，可直接使用 AI" : account.message || "AI 尚未连接";
    } catch { account = { enabled: false }; progress = "AI 服务暂时无法连接"; }
    draw();
  }
  async function request(action, body) {
    if (!account?.enabled) { await connect(); if (!account?.enabled) throw new Error(progress); }
    try {
      return await requestResult(action, body, account.csrf, { onPending: () => {
        progress = "原任务仍在处理，正在自动检查结果…"; draw();
      } });
    } catch (error) {
      if (error.status === 401) void connect();
      throw error;
    }
  }

  function updateTask(id, change) {
    store.update((draft) => { const task = draft.liveTasks?.find((t) => t.id === id); if (task) Object.assign(task, change); }); draw();
  }
  async function poll(task, job) {
    updateTask(task.id, { job });
    const end = Date.now() + 20 * 60000;
    while (Date.now() < end) {
      const data = await request("worker-status", { job });
      progress = stages[data.stage] || "正在处理视频"; draw();
      if (data.status === "complete") { progress = "正在理解文字稿"; draw(); return request("worker-result", { job, requestId: task.id }); }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error("采集时间较长，可以稍后继续查看此任务。");
  }
  async function processTask(task) {
    if (busy) return;
    busy = true; progress = task.input.mode === "image" ? "正在理解图片" : "正在读取并理解内容";
    store.update((draft) => {
      const saved = draft.liveTasks.find((t) => t.id === task.id);
      if (saved) syncTaskState(draft, saved, "processing", progress);
    }); refresh(); draw();
    try {
      let result = task.job ? await poll(task, task.job) : await request(task.action || "ingest", { ...task.input, requestId: task.id });
      if (result.job) result = await poll(task, result.job);
      if (!result.collection || !result.extraction) throw new Error("处理结果不完整，请重试。");
      store.update((draft) => {
        const index = draft.collections.findIndex((i) => i.id === (task.collectionId || task.id));
        const item = { ...draft.collections[index], ...result.collection, receipt: result.receipt, ...(task.input.image ? { thumbnail: task.input.image } : {}) };
        if (index < 0) draft.collections.push(item); else draft.collections[index] = item;
        if (draft.ui.collectionId === task.id) draft.ui.collectionId = item.id;
        draft.extractions = draft.extractions.filter((e) => e.collectionId !== task.id && e.collectionId !== item.id);
        draft.extractions.push(result.extraction);
        if (task.action === "revise") delete draft.feedback[`understanding:${item.id}`];
        const saved = draft.liveTasks.find((t) => t.id === task.id);
        if (saved) { saved.status = "complete"; saved.resultId = item.id; delete saved.input; delete saved.job; }
      });
      progress = "AI 理解已完成，可在收藏详情中查看"; refresh();
    } catch (error) {
      progress = error.message;
      store.update((draft) => {
        const saved = draft.liveTasks.find((t) => t.id === task.id);
        if (saved) syncTaskState(draft, saved, "failed", error.message);
      }); refresh();
    } finally { busy = false; draw(); }
  }
  function revise(collectionId, correction) {
    if (busy) { progress = "请等当前任务完成后再修改理解。"; show(); return false; }
    const collection = real().find((i) => i.id === collectionId);
    if (!collection?.receipt) { progress = "请先完成内容采集，再修改理解。"; show(); return false; }
    const task = { id: `revision-${crypto.randomUUID()}`, action: "revise", collectionId, input: { receipt: collection.receipt, correction }, title: `重新理解 · ${collection.title}`, status: "processing", createdAt: new Date().toISOString() };
    store.update((draft) => { draft.liveTasks ||= []; draft.liveTasks.push(task); });
    void processTask(task); return true;
  }
  function capture(input) {
    if (busy) { progress = "请等当前任务完成后再提交。"; show(); return false; }
    const task = { id: `pending-${crypto.randomUUID()}`, input, title: input.title || input.content?.slice(0, 52) || "图片收藏", status: "processing", createdAt: new Date().toISOString() };
    store.update((draft) => {
      draft.liveTasks ||= []; draft.liveTasks.push(task);
      draft.collections.push({ id: task.id, title: task.title, source: "真实 AI", type: input.mode === "image" ? "image_note" : input.mode === "link" ? "article" : "user_input", ...(input.image ? { thumbnail: input.image } : {}), status: "processing", live: true, addedAt: task.createdAt });
      draft.extractions.push({ collectionId: task.id, source: "live_ai", status: "processing", concepts: [], tags: [], hint: "正在处理，请在展示账号面板查看进度。", reliability: 0, digest: { status: "unavailable", highlights: [] }, breakdown: { status: "unavailable", sections: [] } });
    });
    void processTask(task); return true;
  }
  async function buildExhibition() {
    if (busy) return;
    const items = eligible().slice(-12);
    if (items.length < 6) { progress = "请先收集至少 6 条完成 AI 理解的真实内容。"; draw(); return; }
    busy = true;
    try {
      progress = "1 / 3 · 正在发现主题和连接"; draw();
      const theme = await request("themes", { receipts: items.map((i) => i.receipt), requestId: crypto.randomUUID() });
      if (!theme.receipt) { progress = theme.message; return; }
      progress = "2 / 3 · 正在策划展览"; draw();
      const candidate = await request("curate", { receipt: theme.receipt, requestId: crypto.randomUUID() });
      if (!candidate.receipt) { progress = candidate.message; return; }
      progress = "3 / 3 · 正在核对来源与叙事"; draw();
      const result = await request("evaluate", { receipt: candidate.receipt, requestId: crypto.randomUUID() });
      store.update((draft) => { draft.liveExhibitions ||= []; draft.liveExhibitions.push(result.exhibition); });
      selectedExhibition = result.exhibition; progress = result.message; refresh();
    } catch (error) { progress = error.message; }
    finally { busy = false; draw(); }
  }
  function exhibitionHTML(exhibition) {
    return `<section class="forme-live-exhibition"><button type="button" data-live="back">← 返回我的真实展览</button><p class="forme-live-kicker">${exhibition.status === "preview" ? "AI 展览预览" : "待核对的展览草稿"}</p><h1>${esc(exhibition.title)}</h1><p>${esc(exhibition.curatorial_note?.text)}</p>${exhibition.rooms.map((room, index) => `<section><small>展厅 ${String(index + 1).padStart(2, "0")}</small><h2>${esc(room.title)}</h2><p>${esc(room.introduction)}</p>${room.exhibit_ids.map((id) => { const item = exhibition.items.find((i) => i.id === id); return item ? `<button class="forme-live-source" data-live="collection" data-id="${esc(id)}"><b>${esc(item.title)}</b><span>${esc(item.summary)}</span><i>查看收藏 ↗</i></button>` : ""; }).join("")}${room.claims.map((claim) => `<p class="forme-live-claim"><small>${({ fact: "来源事实", extraction: "内容提取", hypothesis: "AI 推断", question: "开放问题" })[claim.statement_type] || "AI 推断"}</small>${esc(claim.text)}</p>`).join("")}</section>`).join("")}<section><h2>收藏之间的连接</h2>${exhibition.connection_claims.map((c) => `<p>${esc(c.text)}</p>`).join("")}</section><blockquote>${esc(exhibition.open_question)}</blockquote>${exhibition.status === "needs_review" ? `<div class="forme-live-warning"><p>这份草稿需要核对以下内容：</p><ul>${["grounding_findings", "fact_inference_findings", "overinterpretation_findings", "user_constraint_conflicts"].flatMap((key) => exhibition.evaluation[key] || []).map((f) => `<li>${esc(f.issue)}</li>`).join("") || "<li>部分连接或叙事的评分不足，建议补充来源材料。</li>"}</ul></div>` : ""}<p class="forme-live-muted">由你的 ${exhibition.sourceCollectionIds.length} 条真实收藏生成 · ${exhibition.traces.length} 次模型调用 · 保存于当前浏览器</p></section>`;
  }
  function draw() {
    const tasks = [...(store.getState().liveTasks || [])].reverse().slice(0, 12);
    const exhibitions = [...(store.getState().liveExhibitions || [])].reverse();
    dialog.innerHTML = `<header class="forme-live-head"><div><small>Folio</small><h2>展示账号</h2></div><button type="button" data-live="close" aria-label="关闭">×</button></header><p role="status" aria-live="polite" class="forme-live-status">${esc(progress)}</p>${selectedExhibition ? exhibitionHTML(selectedExhibition) : `<p class="forme-live-muted">已默认登录。文字、普通网页和图片可运行真实 AI；YouTube／小红书自动采集下一阶段开放。收藏和生成结果保存在当前浏览器。</p><div class="forme-live-actions"><button type="button" data-live="curate" ${busy || eligible().length < 6 ? "disabled" : ""}>用真实收藏生成展览 <span>${eligible().length} / 6</span></button><button type="button" data-live="reconnect" ${busy ? "disabled" : ""}>重新连接</button></div><h3>处理记录</h3>${tasks.length ? tasks.map((t) => `<article class="forme-live-task"><b>${esc(t.title)}</b><span>${t.status === "complete" ? "理解完成" : t.status === "processing" ? "处理中" : esc(t.error || "处理已中断，可以重试")}</span>${t.status === "complete" ? `<button data-live="collection" data-id="${esc(t.resultId)}">查看理解 ↗</button>` : t.status !== "processing" ? `<button data-live="retry" data-id="${esc(t.id)}" ${busy ? "disabled" : ""}>${t.job ? "继续查看" : "重试"}</button>` : ""}</article>`).join("") : "<p class=\"forme-live-muted\">通过页面的「收新」添加链接、文字或图片。</p>"}<h3>我的真实展览</h3>${exhibitions.length ? exhibitions.map((e) => `<button class="forme-live-source" data-live="exhibition" data-id="${esc(e.id)}"><b>${esc(e.title)}</b><span>${e.status === "preview" ? "打开展览预览" : "打开待核对草稿"} ↗</span></button>`).join("") : "<p class=\"forme-live-muted\">完成 6 条真实收藏后，在这里生成专属展览。</p>"}`}`;
    frameGlassDialog(dialog);
  }
  function show(exhibitionId) { selectedExhibition = typeof exhibitionId === "string" ? store.getState().liveExhibitions?.find((e) => e.id === exhibitionId) : null; draw(); if (!dialog.open) dialog.showModal(); }
  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("[data-live]"); if (!button) return;
    const action = button.dataset.live;
    if (action === "close") void closeGlassDialog(dialog);
    if (action === "reconnect") void connect();
    if (action === "curate") void buildExhibition();
    if (action === "retry") { const task = store.getState().liveTasks.find((t) => t.id === button.dataset.id); if (task) void processTask(task); }
    if (action === "collection") void closeGlassDialog(dialog).then(() => openCollection(button.dataset.id));
    if (action === "exhibition") { selectedExhibition = store.getState().liveExhibitions.find((e) => e.id === button.dataset.id); draw(); }
    if (action === "back") { selectedExhibition = null; draw(); }
  });
  store.update((draft) => {
    for (const task of draft.liveTasks || []) {
      if (task.status === "processing") syncTaskState(draft, task, "interrupted", "上次处理未取得结果，请打开处理记录重试。");
      else if (task.status !== "complete") {
        const message = task.error === "这项任务仍在处理，请稍后继续查看。"
          ? "上次处理未取得结果，请打开处理记录重试。" : task.error || "处理已中断，可以重试。";
        syncTaskState(draft, task, task.status, message);
      }
    }
  });
  void connect();
  return { capture, revise, show };
}
