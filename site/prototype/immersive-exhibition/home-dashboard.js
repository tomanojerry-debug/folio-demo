import { taskProgressItems } from "../../curator/task-view.js";
import { recommendedCollections } from "./collection-recommendations.js";

const escape = (value = "") => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const text = value => typeof value === "string" ? value.trim() : "";
const time = value => Date.parse(value || "") || 0;
const newest = (a, b) => time(b.orderAt) - time(a.orderAt);
const needsReview = item => item.needsReview || item.sourceReviewPending || item.status === "needs_review";
const recommendationLimit = 5;
const imageSource = value => typeof value === "string" && /^(?:https?:\/\/|data:image\/(?:png|jpe?g|webp|gif);base64,|\/(?!\/)|\.\.?\/)/iu.test(value) ? value : "";

function savedOriginal(item) {
  const content = text(item.content);
  const url = text(item.url);
  if (!text(item.title) || !(content || url || item.knowledgeDocumentVersionId || imageSource(item.thumbnail))) return null;
  const preview = ["text", "note", "user_input"].includes(item.type) && content !== url ? content.slice(0, 200) : "";
  const summary = preview || "已保存原始内容";
  return { item, summary, original: true };
}

/** Home projects the saved library and current work. */
export function homeWorkspaceModel(s, galleryItems = []) {
  const collections = [...(s.collections || [])].sort((a, b) => time(b.addedAt || b.createdAt) - time(a.addedAt || a.createdAt));
  const jobs = taskProgressItems(s.workspaceJobs).sort((a, b) => time(b.job.createdAt) - time(a.job.createdAt));
  const outputs = [], working = [], extractions = [], originals = [];
  const latestCollectionJobs = new Map();
  for (const entry of jobs) if (entry.job.collectionId && !latestCollectionJobs.has(entry.job.collectionId)) latestCollectionJobs.set(entry.job.collectionId, entry);

  for (const item of collections) {
    const extraction = s.extractions?.find(entry => entry.collectionId === item.id) || item.extraction;
    if (extraction) extractions.push({ ...extraction, collectionId: item.id });
    const review = s.feedback?.[`understanding:${item.id}`];
    const current = latestCollectionJobs.get(item.id);
    const orderAt = current?.job.createdAt || item.addedAt || item.createdAt;
    const rewriting = review?.decision === "pending_rewrite" || (item.live && review?.decision === "confirmed_edited");
    const summary = text(review?.decision === "confirmed" || (!item.live && review?.decision === "confirmed_edited") ? review.acceptedSummary : "") || text(extraction?.summary);
    if (["queued", "processing"].includes(item.status) || ["queued", "running"].includes(current?.state)) {
      working.push({ key: `collection:${item.id}`, title: item.title, detail: current?.detail || (item.status === "queued" ? "已排队，等待开始整理。" : "正在整理收藏内容。"), orderAt });
      continue;
    }
    if (rewriting) continue;
    if (item.status !== "ready" || extraction?.status !== "qualified" || !summary) {
      const original = ["ready", "saved"].includes(item.status) && savedOriginal(item);
      if (original) originals.push(original);
      continue;
    }
    const completedAt = current?.state === "complete" ? current.job.updatedAt || "" : text(extraction.generatedAt);
    outputs.push({ key: `collection:${item.id}`, kind: "collection", item, title: item.title, summary, completedAt, orderAt: completedAt || item.updatedAt || orderAt, collectionId: item.id });
  }

  for (const item of galleryItems) {
    if (needsReview(item)) continue;
    const job = jobs.find(entry => entry.job.exhibitionId === item.id && entry.job.type === "curate");
    const orderAt = job?.job.updatedAt || item.generatedAt || item.createdAt;
    outputs.push({ key: `exhibition:${item.id ?? item.index}`, kind: "exhibition", item, title: item.title, summary: text(item.lead || item.subtitle || item.curatorial_note?.text), completedAt: orderAt || "", orderAt });
  }

  for (const { job, state, detail } of jobs) {
    if (job.collectionId && collections.some(item => item.id === job.collectionId)) continue;
    if (job.exhibitionId && galleryItems.some(item => item.id === job.exhibitionId)) continue;
    if (["queued", "running"].includes(state)) working.push({ key: `job:${job.id}`, title: job.type === "curate" ? "展览整理" : job.type === "chat" ? "与 Tag 的对话" : "收藏整理", detail, orderAt: job.updatedAt || job.createdAt });
  }
  outputs.sort(newest); working.sort(newest);
  const readable = new Map(outputs.filter(output => output.kind === "collection").map(output => [output.collectionId, output]));
  const available = collections.filter(item => readable.has(item.id));
  const recommendations = recommendedCollections(available, extractions, { feedback: s.feedback, limit: recommendationLimit })
    .map(recommendation => ({ ...recommendation, summary: readable.get(recommendation.item.id).summary }));
  const selected = new Set(recommendations.map(({ item }) => item.id));
  const fallback = [...available.map(item => readable.get(item.id)), ...originals]
    .filter(({ item }) => !selected.has(item.id))
    .slice(0, recommendationLimit - recommendations.length);
  for (const { item, summary, original } of fallback) {
    recommendations.push({ item, summary, original, tag: "最近收下", members: [item.id], evidence: [] });
  }
  return { collections, outputs, output: outputs[0] || null, recent: outputs.filter(output => output.kind === "exhibition").slice(0, recommendationLimit), recommendations, working };
}

function renderRecommendationSection({ kind, title, cards, empty, destination, link, icon }) {
  const headingId = `ws-desk-recommend-${kind}-title`;
  const content = cards.length
    ? `<div class="home-recommend-row recommend-gallery-shell">
      <button type="button" class="recommend-nav prev" data-action="recommend-prev" aria-label="向左浏览${title}">‹</button>
      <div class="recommend-gallery home-recommend-gallery" data-recommend-gallery="${kind}" tabindex="0" role="region" aria-label="${title}，可左右拖动、滑动或使用方向键浏览">${cards.join("")}</div>
      <button type="button" class="recommend-nav next" data-action="recommend-next" aria-label="向右浏览${title}">›</button>
    </div>`
    : `<div class="ws-desk-recommendation-empty"><p>${empty}</p><a href="#${destination}" data-nav="${destination}">${link}${icon("arrow")}</a></div>`;
  return `<section class="ws-desk-recommendations" aria-labelledby="${headingId}"><h2 class="ws-desk-section-label" id="${headingId}">${title}</h2>${content}</section>`;
}

function renderHomeComposer(s, { icon, draft, pending, feedback, contextIds, chatHint, chatAvailable }) {
  const selected = [...new Set(contextIds)].map(id => s.collections.find(item => item.id === id)).filter(Boolean).slice(0, 6);
  const references = selected.length ? `<div class="ws-desk-chat-references" aria-label="本次引用的收藏">${selected.map(item => `<span class="ws-desk-chat-reference" aria-label="${escape(item.title)}" data-tooltip="${escape(item.title)}">${icon("inbox")}<span>${escape(item.title)}</span></span>`).join("")}<button type="button" class="ws-desk-chat-clear" data-workspace-action="clear-chat-context" aria-label="清除本次收藏引用">${icon("close")}</button></div>` : "";
  return `<section class="ws-desk-chat" aria-label="和 Tag 对话"><form data-workspace-chat-form><label class="sr-only" for="workspace-chat-input">向 Tag 提问</label><div class="ws-desk-composer">${references}<textarea id="workspace-chat-input" class="textarea" name="message" rows="2" maxlength="12000" placeholder="交给 Tag 一个问题，或一件想完成的事…" aria-describedby="ws-chat-keyboard ws-chat-feedback"${chatAvailable ? "" : " disabled"}>${escape(draft)}</textarea><div class="ws-desk-chat-toolbar"><div class="ws-desk-chat-tools"><button type="button" class="ws-desk-context-button" data-workspace-action="choose-chat-context" aria-label="引用收藏${selected.length ? `，已选 ${selected.length} 件` : ""}"${chatAvailable && s.collections.length ? "" : " disabled"}>${icon("plus")}<span>引用收藏${selected.length ? ` · ${selected.length}` : ""}</span></button></div><button type="button" class="ws-desk-chat-history" data-workspace-action="chat"${chatAvailable ? "" : " disabled"}>继续对话${icon("chat")}</button><button type="submit" class="ws-desk-send" data-workspace-chat-send aria-label="发送给 Tag"${!chatAvailable || !draft.trim() || pending ? " disabled" : ""}>${pending ? '<span class="sr-only">正在打开对话</span>…' : icon("up")}</button></div></div><p id="ws-chat-keyboard" class="sr-only">${chatHint}</p></form><p id="ws-chat-feedback" class="ws-chat-feedback" data-workspace-chat-feedback role="status"${feedback ? "" : " hidden"}>${escape(feedback)}</p>${!chatAvailable || s.desktopCapabilities?.aiEnabled === false ? `<p class="ws-desk-chat-note">${chatHint}</p>` : ""}</section>`;
}

export function renderHomeDashboard(s, galleryItems, {
  icon, renderCollectionCard, renderExhibitionCard, draft = "", pending = false, feedback = "", contextIds = [],
  chatAvailable = typeof window !== "undefined" && typeof window.__FORME_DESKTOP__?.openChat === "function",
} = {}) {
  const model = homeWorkspaceModel(s, galleryItems);
  const today = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
  const tag = '<span class="tag-name">Tag</span>';
  const title = model.output ? `${tag} 为你准备好了` : model.working.length ? `${tag} 正在为你整理` : `和 ${tag}，留下一点喜欢`;
  const capabilities = s.desktopCapabilities;
  const chatHint = !chatAvailable ? "桌面伙伴对话可在 Folio 客户端中使用"
    : capabilities?.demoAccount ? "当前是演示模式。智能对话请使用 Folio 的个人模式。"
    : capabilities?.aiEnabled === false ? "智能对话尚未配置；原始收藏仍会保留。"
    : "回车发送，Shift + 回车换行。";
  const work = model.working[0];
  const working = work ? `<div class="ws-desk-working"><span class="ws-desk-working-dot" aria-hidden="true"></span><div><strong>${model.working.length > 1 ? `正在处理 ${model.working.length} 件事` : "还在整理一件事"}</strong><p>${escape(work.title)}<br>${escape(work.detail)}</p><button type="button" class="ws-desk-working-action" data-action="live-ai-panel">查看进度${icon("arrow")}</button></div></div>` : "";
  const exhibitions = renderRecommendationSection({
    kind: "exhibitions", title: "推荐展览", destination: "gallery", link: "查看个人展览", empty: "还没有可浏览的展览。", icon,
    cards: model.recent.map(({ item }, index) => renderExhibitionCard(item, index)),
  });
  const recommendations = renderRecommendationSection({
    kind: "collections", title: "推荐收藏", destination: "inbox", link: "查看我的收藏", empty: "还没有可推荐的收藏。", icon,
    cards: model.recommendations.map((recommendation, index) => renderCollectionCard(recommendation, index)),
  });
  return `<header class="ws-desk-intro"><div><p class="ws-desk-date">${today}</p><h1>${title}</h1></div><button type="button" class="ws-button ws-desk-capture" data-action="toggle-capture">${icon("plus")}收新</button></header>${renderHomeComposer(s, { icon, draft, pending, feedback, contextIds, chatHint, chatAvailable })}${exhibitions}${recommendations}${working}<footer class="ws-desk-footer"><span>来自你的收藏</span><span>${icon("check")}你的收藏，始终属于你</span></footer>`;
}
