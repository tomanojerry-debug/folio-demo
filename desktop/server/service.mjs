import { randomUUID, createHash } from "node:crypto";
import { ingest, revise, discover, curate, evaluate, evidenceFor, platform, model as pipelineModel } from "../../server/pipeline.mjs";
import { createTextCompletion } from "../../server/ai/zhipu-client.mjs";
import { loadConfig } from "../../server/ai/config.mjs";
import { validURL, safeFetch } from "../../server/safe-fetch.mjs";
import { messages as pipelineErrors } from "../../server/errors.mjs";
import { openState, ensureSigningSecret, migrateConversations, currentCompanionName, currentConversationTitle } from "./state.mjs";
import { applyWorkspacePatch, emptyWorkspace } from "./workspace.mjs";
import { createHarness, publicHarness } from "./harness/runtime.mjs";
import { buildConversationContext, retrieveCollections, shouldSearchCollections } from "./harness/context.mjs";
import { parseCollectionCitations } from "./harness/citations.mjs";
import { createKnowledgeManager } from "./knowledge/manager.mjs";
import { createKnowledgeEmbedder } from "./knowledge/embeddings.mjs";
import { knowledgeReferences, protectKnowledgeReferences, similarityAnchor, connectionAnchor } from "./knowledge/context.mjs";
import { verify } from "../../server/receipts.mjs";
import { executeCall } from "../../server/ai/ai-service.mjs";
import { importStarterContent, removeStarterContent } from "./starter-content.mjs";
import { demoReadingsByExhibition, importDemoLibrary } from "./demo-library.mjs";
import { coverColorPattern } from "../../site/curator/collection-card-color.js";
import { pageContentFromResponse } from "./page-content.mjs";
import { createCollectionCovers, previewTitle, youtubePreview } from "./collection-covers.mjs";
import { readYouTubeCaptions } from "./video-source.mjs";
import { createSkillRegistry } from "./harness/skills.mjs";
import { migrateMemory, rememberPreference, forgetPreference, replacePreferences, publicMemories, refreshConversationMemory, snapshotMemory, isMemoryContextCurrent, createMemoryRetriever, MEMORY_POLICY } from "./harness/memory.mjs";
import { migratePageSessions, resolvePageSession, acceptPageSession, pageSource as storedPageSource, updateSurfaceSession, publicSurfaceSessions, publicPageSession, pageIdentity, normalizePageURL } from "./harness/page-sessions.mjs";
import { migrateReading, updateReadingPreferences, loadReadingSource, readingFingerprint, readingMessages, validateReadingResult, abortableReading, readingPromptVersion, understandingSourceAvailable } from "./reading.mjs";
import { createLocalCuration, currentLocalTopic, retireCurationUpdates } from "./local-curation.mjs";
import { createCurationModelReading } from "./curation-model-reading.mjs";
import { createWebSearchProvider } from "./web-search-provider.mjs";
import { parseWebSearchRequest, providerQuery, selectWebSources, validateWebSearchQuery, webSearchReply } from "./web-search.mjs";
import { parseScopedCurationCommand } from "../../site/curator/scoped-curation-command.js";
import { parseVideoCaptureCommand } from "../../site/curator/video-capture-command.js";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID()}`;
const issue = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
function text(value, name, max, optional = false) {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim()) || /\u0000/.test(value)) throw issue("INVALID_REQUEST", `${name}格式不正确或内容过长。`);
  return value.trim();
}
const desktopErrorMessages = {
  MODEL_NOT_CONFIGURED: "智能服务尚未配置，请联系维护者。",
  SERVICE_NOT_CONFIGURED: "智能服务尚未启用。",
  MODEL_OUTPUT_INVALID: "整理结果未通过结构或来源校验，请重试。",
  MODEL_TIMEOUT: "智能服务响应超时，原始内容和已完成步骤已保留，可以继续处理。",
  INSUFFICIENT_ITEMS: "请先添加至少 6 条已完成智能整理的真实收藏。",
  UNSAFE_URL: "请使用可公开访问的网页链接。",
  YOUTUBE_NOT_READY: "当前采集服务暂时无法访问这个视频平台，请先粘贴视频文字稿。",
  YOUTUBE_EMBED_NOT_FOUND: "这个网页里没有找到可读取的 YouTube 视频。原链接已保留。",
  YOUTUBE_MULTIPLE_EMBEDS: "这个网页里有多段 YouTube 视频。原链接已保留，发具体视频的链接就可以读取那一段的字幕。",
  YOUTUBE_CAPTIONS_UNAVAILABLE: "暂时没有读到可用的 YouTube 字幕。原链接已保留，可以稍后重试。",
  HARNESS_TIMEOUT: "这一步等待超时，已完成的步骤和原始内容已保留，可以继续处理。",
  HARNESS_BUDGET_EXCEEDED: "本次整理已达到调用上限，已完成的步骤已保留，可以稍后继续。",
  TOOL_NOT_ALLOWED: "本次任务无法执行这个操作，原始内容已保留。",
};
const errorText = (error) => desktopErrorMessages[error.code] || pipelineErrors[error.code] || (error.code === "AI_DISABLED" ? "已保存原始内容。智能功能尚未配置，连接整理服务后可以重试。" : "这次处理没有完成，原始收藏已保留，可以重试。");
const chatErrorText = (error) => desktopErrorMessages[error.code] || ({ CONTEXT_INPUT_TOO_LARGE: "这次问题太长，请缩短文字，或把资料分段引用后再发。原始输入已保留。", MEMORY_CHANGED: "你刚刚更改了记忆，这次回答已停止。可以按最新记忆重新生成。", MODEL_NOT_CONFIGURED: "智能服务尚未配置，暂时无法继续对话。", SERVICE_NOT_CONFIGURED: "智能服务尚未启用，暂时无法继续对话。", MODEL_RATE_LIMITED: "智能服务目前繁忙，请稍后再发一次。", MODEL_OUTPUT_INVALID: "智能服务没有返回可阅读内容，请重试。" })[error.code] || "智能对话暂时没有连接成功，请检查服务连接后重试。这次对话没有新增收藏。";
const webSearchUnavailable = "联网搜索尚未连接，需要启用支持联网搜索的智谱 Coding Plan。";
const webSearchErrorText = error => ({
  WEB_SEARCH_UNAVAILABLE: webSearchUnavailable,
  WEB_SEARCH_AUTH: "联网搜索未通过服务授权，请检查套餐权限和配置后重试。",
  WEB_SEARCH_RATE_LIMITED: "联网搜索暂时达到服务限额，可以稍后重试。",
  HARNESS_TIMEOUT: "联网搜索超时，可以重试。",
  WEB_SEARCH_TIMEOUT: "联网搜索超时，可以重试。",
  INTERRUPTED: "联网搜索因 Folio 退出而中断，可以重试。",
})[error?.code] || "这次没能取得搜索结果，可以重试。";
const eligible = (state) => state.collections.filter((item) => item.status === "ready" && item.receipt && item.extraction?.status === "qualified" && !["pending_rewrite", "confirmed_edited"].includes(state.workspace?.feedback?.[`understanding:${item.id}`]?.decision));
const message = (role, value, more = {}) => ({ id: id("message"), role, text: value, createdAt: now(), ...more });
const readingModes = ["overview", "plain", "custom", "question", "understanding"];

function conversationFor(draft, requestedId) {
  const conversationId = requestedId === undefined ? draft.activeConversationId : text(requestedId, "对话编号", 150);
  const conversation = draft.conversations.find(item => item.id === conversationId);
  if (!conversation) throw issue("NOT_FOUND", "没有找到这段对话，请从对话记录重新打开。", 404);
  return conversation;
}

function appendMessage(draft, entry, requestedId) {
  const source = entry.sourceMessageId && draft.messages.find(item => item.id === entry.sourceMessageId);
  const job = entry.jobId && draft.jobs.find(item => item.id === entry.jobId);
  const conversation = conversationFor(draft, requestedId ?? entry.conversationId ?? source?.conversationId ?? job?.conversationId);
  entry.conversationId = conversation.id;
  draft.messages.push(entry);
  conversation.updatedAt = entry.createdAt;
  if (entry.role === "user" && conversation.titleSource === "automatic" && conversation.title === "新的对话") conversation.title = entry.text.replace(/\s+/gu, " ").slice(0, 32);
  if (draft.memory) refreshConversationMemory(draft, conversation.id);
  return entry;
}

function appendJob(draft, job, requestedId) {
  job.conversationId = conversationFor(draft, requestedId ?? job.conversationId).id;
  draft.jobs.push(job);
  return job;
}

function publicConversations(state) {
  return state.conversations.map(conversation => {
    const messages = state.messages.filter(entry => entry.conversationId === conversation.id);
    const latest = messages.at(-1);
    return { id: conversation.id, title: currentConversationTitle(conversation), createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
      ...(conversation.originSurface ? { originSurface: conversation.originSurface } : {}), ...(conversation.pageSession ? { pageSession: publicPageSession(conversation) } : {}),
      messageCount: messages.length, lastMessageAt: latest?.createdAt || null, lastMessagePreview: typeof latest?.text === "string" ? latest.text.replace(/\s+/gu, " ").slice(0, 100) : "" };
  });
}

function workspaceRequest(body, limit = 6) {
  if (body.collectionIds !== undefined && (!Array.isArray(body.collectionIds) || body.collectionIds.length > limit)) throw issue("INVALID_REQUEST", `一次最多选择 ${limit} 条收藏。`);
  return { ...(body.collectionIds === undefined ? {} : { collectionIds: [...new Set(body.collectionIds.map(value => text(value, "收藏编号", 150)))] }),
    ...(body.exhibitionId === undefined ? {} : { exhibitionId: text(body.exhibitionId, "展览编号", 150) }) };
}

function workspaceSelection(selection, state, preserveScope = false) {
  if (selection.collectionIds === undefined && selection.exhibitionId === undefined) return null;
  const ids = [...(selection.collectionIds || [])];
  if (ids.some((id) => !state.collections.some((item) => item.id === id))) throw issue("NOT_FOUND", "没有找到本轮选择的收藏，请刷新后再试。", 404);
  let exhibition;
  if (selection.exhibitionId !== undefined) {
    const exhibitionId = selection.exhibitionId;
    exhibition = state.exhibitions.find((item) => item.id === exhibitionId);
    if (exhibition?.kind === "local-topic" && !currentLocalTopic(exhibition, new Map(state.collections.map(item => [item.id, item])))) exhibition = undefined;
    if (!exhibition) throw issue("NOT_FOUND", "没有找到本轮选择的展览，请刷新后再试。", 404);
    // Older exhibitions keep pipeline source IDs; resolve them against the
    // private library rather than trusting client-supplied titles or bodies.
    const sources = exhibition.collectionIds?.length ? exhibition.collectionIds : exhibition.sourceCollectionIds || [];
    for (const source of (preserveScope ? sources : sources.slice(0, 12))) {
      const item = state.collections.find((entry) => entry.id === source || entry.extraction?.collectionId === source);
      if (item && !ids.includes(item.id)) ids.push(item.id);
    }
  }
  if (!ids.length && !exhibition) return null;
  if (!ids.length) throw issue("INVALID_REQUEST", "这场展览的来源收藏暂时无法找到，请重新选择收藏。");
  return { collectionIds: preserveScope ? ids : ids.slice(0, 12), ...(exhibition ? { exhibitionId: exhibition.id } : {}) };
}

function isCurationCommand(value) {
  const command = value.replace(/[。！!？?]+$/u, "").trim();
  return /^(?:请(?:帮我)?|帮我|给我|麻烦你)?\s*(?:整理|生成|策划|做)(?:一下)?(?:一场|一个|一份)?(?:完整的?|个人的?)?(?:展览|小展)$/u.test(command)
    || /^(?:请(?:帮我)?|帮我|给我|麻烦你)?\s*(?:把|将)(?:我的?|最近的?|这些|已有的?|已保存的?)*(?:收藏|内容)(?:整理|做|生成|变)(?:成|为)(?:一场|一个|一份)?(?:展览|小展)$/u.test(command);
}

const curationTitleKey = value => typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase()
  .replace(/[\u2010-\u2015−]/gu, "-").replace(/τ/gu, "tau").replace(/\s+/gu, " ").trim() : "";

function curationNameMatches(value, collections) {
  const title = curationTitleKey(value);
  if (!title) return [];
  if (/^https?:\/\//iu.test(value)) {
    const key = sourceURLKey(value);
    return key ? collections.filter(item => sourceURLKey(item.url) === key
      || (item.input?.mode === "link" && sourceURLKey(item.input.content) === key)) : [];
  }
  const exact = collections.filter(item => curationTitleKey(item.title) === title);
  if (exact.length) return exact;
  if (title.length < 3) return [];
  return collections.filter(item => {
    const candidate = curationTitleKey(item.title);
    return [":", " ", "(", " -"].some(separator => candidate.startsWith(title + separator));
  });
}

function curationNames(value, collections) {
  if (curationNameMatches(value, collections).length) return [value];
  const quoted = [];
  const tokenized = value.replace(/《([^》]+)》|「([^」]+)」|『([^』]+)』|“([^”]+)”|"([^"]+)"/gu, (_match, ...captures) => {
    const placeholder = `\u0001${quoted.length}\u0001`;
    quoted.push(captures.slice(0, 5).find(Boolean));
    return `、${placeholder}、`;
  });
  const conjunction = /\s*(?:以及|和|与|\band\b)\s*/iu;
  return tokenized.split(/[、，,\n]+/u).map(part => part.trim()).filter(Boolean).flatMap(part => {
    const known = part.replace(/^\u0001(\d+)\u0001$/u, (_match, index) => quoted[index]);
    if (known !== part || curationNameMatches(known, collections).length) return [known];
    return part.split(conjunction).map(name => name.trim()).filter(Boolean);
  });
}

function scopedCurationSelection(command, selected, collections) {
  if (!command.names) return { ids: selected?.collectionIds || [] };
  const allowed = selected ? collections.filter(item => selected.collectionIds.includes(item.id)) : collections;
  const names = curationNames(command.names, allowed);
  if (names.length > 12) return { ids: [], tooMany: true };
  const ids = [];
  const unresolved = [];
  for (const name of names) {
    const matches = curationNameMatches(name, allowed);
    if (matches.length === 1) ids.push(matches[0].id);
    else unresolved.push(name);
  }
  return { ids: [...new Set(ids)], unresolved };
}

function curationSelectionPrompt(command, selection) {
  if (command.needsSelection) return "请用「引用收藏」选好这次要用的收藏，或发要使用的完整标题。";
  if (selection.tooMany || selection.ids.length > 12) return "一次最多选 12 条收藏。请缩小这次的范围。";
  if (selection.unresolved?.length) {
    const names = selection.unresolved.slice(0, 3).map(name => `《${name.slice(0, 120)}》`).join("、");
    return `这些收藏标题没有唯一匹配（${names}）。请发完整标题或链接，也可以在主窗口用「引用收藏」选择。`;
  }
  if (command.expectedCount !== undefined && command.expectedCount !== selection.ids.length) {
    return `本轮找到了 ${selection.ids.length} 条收藏。请选好你要用的 ${command.expectedCount} 条后再发。`;
  }
  return selection.ids.length ? "" : "请发要用的收藏标题或链接，也可以在主窗口用「引用收藏」选择。";
}

function curationRelatedReply(reason, count) {
  const cause = {
    source_unavailable: "选中的收藏缺少可核对的原文。",
    insufficient_articles: "去重后还没有三篇可用的原文。",
    insufficient_sources: "还缺少第二个独立来源。",
    no_new_information: "这些原文提供的信息有重叠，暂时没有足够的新信息。",
    no_clear_topic: "还没找到这些原文共同回答的具体问题。",
    source_changed: "选中的收藏原文刚刚更新，请再试一次。",
  }[reason] || "这些收藏暂时不足以组成专题。";
  return cause + (count ? "可以先查看下面的相关收藏。" : "");
}

function captureFrom(value, context) {
  const matches = [...value.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((match) => match[0].replace(/[，。！？、；：)）\]】]+$/u, ""));
  if (matches.length) {
    const surrounding = value.replace(/https?:\/\/[^\s<>"']+/gi, " ").trim();
    const bareLinks = !surrounding.replace(/[\s，。！？、；：,;:!?.()（）\[\]【】]+/gu, "");
    const explicitCapture = /^(?:请帮我|帮我|请|麻烦你)?\s*(?:收藏|收下|收起来|存下|保存|记下|收进)(?:一下)?[\s:：，,]*(?:(?:这|那)(?:篇文章|篇|个页面|个网页|条链接|个链接)|以下链接|这些链接|链接)?[\s:：，,]*(?:吧|谢谢)?[。！!]?$/u.test(surrounding);
    // A pasted link keeps the original quick-capture behavior. A question,
    // refusal or quotation that happens to contain a URL is only conversation.
    if (!bareLinks && !explicitCapture) return [];
    return [...new Set(matches)].slice(0, 8).map((raw) => ({ mode: "link", content: validURL(raw).href, title: "" }));
  }
  const pageObject = "(?:(?:这|那)(?:页|个网页|个页面|个链接|条链接|篇文章)|当前(?:的)?(?:页面|网页|文章|链接)|本页|此页|它)";
  const pageReference = new RegExp(`^(?:${pageObject}|(?:这|那)(?:篇|个|条内容|段话|段|条|些))(?:吧|一下)?[。！!]?$`, "u");
  const trailingPageCommand = new RegExp(`^(?:请帮我|帮我|请|麻烦你)?\\s*(?:把|将)${pageObject}(?:收藏|保存|收起来|存下)(?:起来|下来)?(?:吧|一下)?[。！!]?$`, "u");
  const command = /^(?:请帮我|帮我|请|麻烦你)?\s*(?:收藏|收下|收起来|存下|保存|记下|收进)(?=$|[\s:：，,这那当本它把一])/u;
  if (trailingPageCommand.test(value)) {
    if (!context?.url) throw issue("NEEDS_CONTEXT", "我还没有拿到当前页面。请贴上要收藏的链接或正文。");
    return [{ mode: "link", content: context.url, title: context.title || "" }];
  }
  if (!command.test(value)) return [];
  const suffix = value.replace(command, "").trim();
  if (pageReference.test(suffix.replace(/^一下/u, "")) || (!suffix && context?.url)) {
    if (!context?.url) throw issue("NEEDS_CONTEXT", "我还没有拿到当前页面。请贴上要收藏的链接或正文。");
    return [{ mode: "link", content: context.url, title: context.title || "" }];
  }
  // A longer statement about collecting a page is conversation, not permission.
  if (new RegExp(`^${pageObject}`, "u").test(suffix.replace(/^一下/u, ""))) return [];
  const content = suffix.replace(/^(?:一下|这段话|这段|这个|这条|这些|把)?[\s:：，,]*/u, "").trim();
  if (!content) throw issue("NEEDS_INPUT", "把要收藏的链接或正文一起发给我。");
  return [{ mode: "text", content, title: content.slice(0, 60) }];
}

function pageContext(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw issue("INVALID_REQUEST", "页面上下文格式不正确。");
  const context = { title: text(value.title, "页面标题", 300, true) };
  if (value.url) context.url = validURL(text(value.url, "页面链接", 4000)).href;
  for (const [key, label, max] of [["appName", "应用名称", 120], ["browserProfileId", "浏览器身份", 150], ["attachmentId", "页面关联编号", 150], ["pageRevision", "页面版本", 150], ["text", "页面正文", 40000], ["selection", "选中文字", 12000]]) {
    if (value[key] !== undefined) context[key] = text(value[key], label, max, true);
  }
  if ((context.text || context.selection) && value.contentSource === "browser-accessibility") context.contentSource = "browser-accessibility";
  if (context.text && value.textTruncated === true) context.textTruncated = true;
  if (typeof value.snapshotId === "string" && /^page-[a-f0-9]{32}$/u.test(value.snapshotId)) context.snapshotId = value.snapshotId;
  for (const key of ["browserWindowId", "browserTabId"]) {
    if (typeof value[key] === "string" || Number.isSafeInteger(value[key])) context[key] = String(value[key]).slice(0, 150);
  }
  if (Number.isSafeInteger(value.contextVersion) && value.contextVersion >= 0) context.contextVersion = value.contextVersion;
  return context;
}

function acceptedPageCapture(context) {
  if (!context?.snapshotId || !["attached_text", "selection_only", "public_page"].includes(context.readStatus)
    || !["ready", "partial"].includes(context.contentQuality?.status)) return null;
  const body = context.readStatus === "selection_only" ? context.selection : context.text;
  if (typeof body !== "string" || !body.trim()) return null;
  const coverage = context.readStatus === "selection_only" || context.textTruncated || context.contentQuality.truncated || context.contentQuality.status === "partial" ? "partial" : "complete";
  return { title: context.documentTitle || context.title, url: context.resolvedUrl || context.url, text: body,
    sourceKind: "body_text", coverage, capturedAt: context.readAt };
}

function pageCaptureFingerprint(source) {
  return createHash("sha256").update(JSON.stringify([source.text, source.coverage, normalizePageURL(source.url)])).digest("hex");
}

function pageSaveReply(userMessage, collectionId, coverage, aiEnabled = true) {
  const value = coverage === "complete" ? "已把这一版正文保存到这台电脑的知识库。"
    : coverage === "partial" ? "已把读到的节选保存到这台电脑的知识库。"
    : `已保存网页链接；本机知识库里还没有正文。${aiEnabled ? "" : "智能功能尚未配置。"}`;
  return message("assistant", value, { sourceMessageId: userMessage.id, collectionIds: [collectionId] });
}

function linkSaveReply(count, aiEnabled) {
  const saved = count === 1 ? "链接已收藏。" : `已收藏 ${count} 条链接。`;
  return saved + (aiEnabled ? "正文会在后台读取。" : "也可以发「收藏：」加正文，直接保存文字。");
}

const pageUnavailable = (context) => `这页的正文暂时没能读到${context.title ? `（《${context.title}》）` : ""}，我目前只有${context.url ? "页面链接和标题" : "窗口信息"}，还不能据此解释页面内容。你可以粘贴正文或选中的段落，再一起讨论。页面仍然关联着，这次对话没有新增收藏。`;
const pageSource = (source) => source?.context ? {
  sourceMessageId: source.id,
  pageSource: Object.fromEntries(["attachmentId", "pageRevision", "contextVersion", "browserWindowId", "browserTabId", "url", "title", "resolvedUrl", "readStatus", "contentSource", "textTruncated", "contentQuality"].filter((key) => source.context[key] !== undefined).map((key) => [key, source.context[key]])),
} : { ...(source?.id ? { sourceMessageId: source.id } : {}) };
const sourceURLKey = (raw) => { try { return normalizePageURL(raw); } catch { return ""; } };
function initialCollection(input) {
  const url = input.mode === "link" ? input.content : "";
  const video = url && youtubePreview(url);
  const isVideo = video || input.videoCaptions;
  return {
    title: input.title || (isVideo ? "YouTube 视频" : input.content.slice(0, 80)) || "图片收藏", url,
    source: isVideo ? "YouTube" : url ? new URL(url).hostname === "mp.weixin.qq.com" ? "微信公众号" : "网页" : input.mode === "image" ? "我的图片" : "我的文字",
    type: isVideo ? "video" : url ? "article" : input.mode === "image" ? "image_note" : "user_input",
    ...(input.image || video ? { thumbnail: input.image || video.thumbnail } : {}),
  };
}

// Task diagnostics are a projection, never a serialized execution payload.
function publicJob(job) {
  const keys = ["id", "type", "status", "conversationId", "automatic", "eligibleCount", "collectionId", "messageId", "exhibitionId", "createdAt", "updatedAt", "startedAt", "error", "errorCode", "result", "retryOf", "retryRootId", "attempt", "sourceRefresh", "readingMode", "documentVersionId", "readingResultId"];
  const manifest = job.contextManifest;
  const contextManifest = manifest ? {
    itemIds: (manifest.itemIds || []).filter((value) => typeof value === "string").slice(0, 6),
    historyMessageIds: (manifest.historyMessageIds || []).filter((value) => typeof value === "string").slice(-120),
    pageIdentity: manifest.pageIdentity ? Object.fromEntries(["attachmentId", "pageRevision", "url"].filter((key) => typeof manifest.pageIdentity[key] === "string").map((key) => [key, manifest.pageIdentity[key]])) : null,
    characterCount: Number.isFinite(manifest.characterCount) ? manifest.characterCount : 0,
    truncated: Boolean(manifest.truncated),
    profileProvenance: { source: manifest.profileProvenance?.source === "task_snapshot" ? "task_snapshot" : "state" },
    ...(manifest.memory ? { memory: {
      version: 1, revision: manifest.memory.revision, revocationRevision: manifest.memory.revocationRevision,
      recentTurnCount: manifest.memory.recentTurnCount, retrieval: manifest.memory.retrieval, semanticStatus: manifest.memory.semanticStatus,
      entryVersions: (manifest.memory.entryVersions || []).slice(0, 100).map(entry => ({ id: entry.id, version: entry.version })),
      recalls: (manifest.memory.recalls || []).slice(0, 5).map(entry => ({ conversationId: entry.conversationId, sourceMessageIds: (entry.sourceMessageIds || []).slice(0, 30) })),
      summary: manifest.memory.summary ? { version: manifest.memory.summary.version, strategy: manifest.memory.summary.strategy,
        coveredThroughMessageId: manifest.memory.summary.coveredThroughMessageId, sourceMessageIds: (manifest.memory.summary.sourceMessageIds || []).slice(0, 30) } : null,
    } } : {}),
  } : undefined;
  return { ...Object.fromEntries(keys.filter((key) => job[key] !== undefined).map((key) => [key, job[key]])), ...(job.webSearch ? { webSearch: true } : {}), ...(job.harness ? { harness: publicHarness(job.harness) } : {}), ...(contextManifest ? { contextManifest } : {}) };
}

function resumeHarness(previous) {
  if (!previous.harness) return undefined;
  const checkpoints = structuredClone(previous.harness.checkpoints || {});
  // Short-lived theme/candidate receipts cannot be trusted after expiry or a
  // signing-key change. Clear dependent stages together, then recalculate.
  const signed = [["understand", "collection"], ["revise", "collection"], ["discover", "theme"], ["compose", "exhibition-candidate"], ["evaluate", "exhibition"]];
  for (const [name, purpose] of signed) {
    const value = checkpoints[name]?.value;
    if (!value || (["discover", "compose"].includes(name) && value.status === "waiting_for_content")) continue;
    try { verify(value.receipt, purpose); }
    catch {
      delete checkpoints[name];
      if (name === "discover") { delete checkpoints.compose; delete checkpoints.evaluate; }
      if (name === "compose") delete checkpoints.evaluate;
    }
  }
  return { version: 1, runId: id("run"), jobType: previous.type, createdAt: now(), updatedAt: now(), steps: [], calls: [], checkpoints, limits: previous.harness.limits };
}

export async function createDesktopService({ directory, config = loadConfig({ ...process.env, NODE_ENV: process.env.NODE_ENV === "test" ? "test" : "development" }), model = pipelineModel, chat = createTextCompletion, fetchPage = safeFetch, readVideoCaptions = readYouTubeCaptions, searchWeb = createWebSearchProvider(config), aiEnabled = Boolean(config.zhipuApiKey), autoCurate = true, seedStarterContent = false, demoLibrary = null, harnessLimits, knowledgeEmbedder, knowledgeReranker, onEvent, onChange, clock = Date.now } = {}) {
  const store = await openState(directory, { onChange });
  await store.update(migrateConversations);
  await store.update(draft => { migrateMemory(draft); migratePageSessions(draft); migrateReading(draft); retireCurationUpdates(draft); });
  if (seedStarterContent) await store.update(importStarterContent);
  else if (store.read().starterContent) await store.update(removeStarterContent);
  if (demoLibrary) await store.update(draft => importDemoLibrary(draft, demoLibrary));
  const demoCoverColors = new Map((demoLibrary || []).flatMap(edition => edition.articles
    .filter(article => coverColorPattern.test(article.coverColor))
    .map(article => [article.imagePath || article.imageUrl, article.coverColor])));
  const demoReadings = demoReadingsByExhibition(demoLibrary || []);
  await ensureSigningSecret(directory);
  // One provider/worker serves both indexes. Memory never invents credentials or
  // creates another model download path; disabled/unavailable models fall back.
  const sharedEmbedder = knowledgeEmbedder !== undefined ? knowledgeEmbedder : config.embeddingBackend === "local"
    ? (await import("./knowledge/local-embeddings.mjs")).createLocalKnowledgeEmbedder({ directory, cacheDirectory: config.embeddingLocalCacheDirectory })
    : config.embeddingBackend === "disabled" ? null : createKnowledgeEmbedder(config);
  const knowledge = await createKnowledgeManager({ directory, config, getState: () => store.read(), embedder: sharedEmbedder, reranker: knowledgeReranker, onChange });
  const localCuration = createLocalCuration({ store, knowledge, enabled:autoCurate, clock });
  const curationModelReading = createCurationModelReading({ store, knowledge, chat, config, aiEnabled, clock });
  const memoryRetriever = createMemoryRetriever({ embedder: sharedEmbedder });
  const pending = new Set();
  const pageReads = new Set();
  const pageOpenRequests = new Map();
  const pageSaves = new Map();
  const publicPreviews = new Map();
  const readingControllers = new Map();
  const webSearchStop = new AbortController();
  const skills = createSkillRegistry({ fetchPage, searchWeb });
  const covers = createCollectionCovers(directory, fetchPage);
  let work = Promise.resolve();
  let selectedCurationWork = Promise.resolve();
  let stopping = false;
  let closePromise;

  async function readLinkSource(input, signal) {
    const page = await fetchPage(input.content, 0, { signal });
    // Keep the complete bounded body for provenance. Only conversational page
    // reads are clipped, and the understanding limit is still checked below.
    const extracted = pageContentFromResponse(page, { title: input.title || "", url: input.content }, { limit: 2_000_000, includePreview: true });
    const preview = extracted.preview;
    const thumbnail = preview?.images.length ? await covers.acquire(preview.images, preview.baseURL, signal) : "";
    const title = previewTitle(preview?.title) || extracted.documentTitle || "";
    const presentation = { title, thumbnail };
    if (extracted.readStatus === "unavailable") throw Object.assign(issue(extracted.readError || "FETCH_FAILED", "没有读到可用的页面正文。"), { presentation });
    return { title: title || extracted.title, text: extracted.text, url: extracted.resolvedUrl || input.content, type: "text/plain",
      coverage: extracted.contentQuality.status === "partial" ? "partial" : "complete", contentQuality: extracted.contentQuality, presentation };
  }

  async function applyPresentation(collectionId, input, presentation, { video, manual = false } = {}) {
    if (!presentation || (!video && !presentation.title && !presentation.thumbnail)) return;
    await store.update(draft => {
      const item = draft.collections.find(entry => entry.id === collectionId);
      if (!item || item.input?.content !== input.content) return;
      if (!input.title && presentation.title) item.title = presentation.title;
      if (presentation.thumbnail && (manual || (!item.manualThumbnail && (!item.thumbnail || presentation.thumbnail.startsWith("/api/desktop/covers/"))))) {
        item.thumbnail = presentation.thumbnail;
        if (manual) item.manualThumbnail = true;
      }
      if (video) { item.source = "YouTube"; item.type = "video"; }
    });
  }

  function scheduleSavedPresentation(collectionId, input) {
    if (input.mode !== "link" || stopping) return;
    work = work.then(async () => {
      if (stopping) return;
      const controller = new AbortController();
      pageReads.add(controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(16000)]);
      try {
        const video = youtubePreview(input.content);
        if (!video && platform(input.content) !== "generic") return;
        const presentation = video ? await covers.video(video, signal) : await readLinkSource(input, signal).then(source => source.presentation, error => error.presentation);
        if (!signal.aborted) await applyPresentation(collectionId, input, presentation, { video });
      } finally { pageReads.delete(controller); }
    }).catch(() => {});
  }

  function liveReferenceState(base) {
    const live = store.read();
    return { ...base, collections:live.collections, workspace:live.workspace, memory:live.memory };
  }

  async function preserveSource(collection, source, job, signal) {
    if (signal?.aborted) throw signal.reason || issue("HARNESS_TIMEOUT", "读取来源已中断。");
    const rootJob = job && (store.read().jobs.find(entry => entry.id === job.retryRootId) || job);
    const document = await knowledge.captureSource({
      collectionId: collection.id,
      captureId: rootJob?.id || `input:${collection.id}`,
      sourceRevision: job?.targetSourceRevision || collection.sourceRevision || 1,
      source: { ...source, capturedAt: rootJob?.createdAt || collection.addedAt || collection.createdAt },
    });
    if (signal?.aborted) throw signal.reason || issue("HARNESS_TIMEOUT", "读取来源已中断。");
    if (document.active !== false) await store.update(draft => {
      const item = draft.collections.find(entry => entry.id === collection.id);
      if (item) {
        item.knowledgeDocumentVersionId = document.documentVersionId;
        if (item.sourceSaveStatus) item.sourceSaveStatus = document.coverage;
        if (job?.sourceRefresh) { delete item.savedPageSnapshotId; delete item.savedPageFingerprint; }
      }
    });
    if (document.active !== false && source.sourceKind === "body_text" && source.url) localCuration.queue(collection.id);
    return document;
  }

  async function preserveTextInputs(ids) {
    for (const collectionId of ids) {
      const item = store.read().collections.find(entry => entry.id === collectionId);
      if (item?.input?.mode === "text" && item.input.content) await preserveSource(item, { title: item.title, url: item.url, text: item.input.content, sourceKind: "body_text" });
    }
    await knowledge.sync();
  }

  // The JSON store journals the requested version before SQLite work begins.
  // A process exit between the stores leaves a replayable local operation;
  // neither its internal pointer nor its success message is public meanwhile.
  function persistAcceptedPage(collectionId) {
    const before = store.read();
    const current = before.collections.find(item => item.id === collectionId);
    const pendingCapture = current?.pendingPageCapture;
    if (!pendingCapture) return Promise.resolve();
    if (pageSaves.has(pendingCapture.id)) return pageSaves.get(pendingCapture.id);
    const operation = (async () => {
      const userMessage = before.messages.find(item => item.id === pendingCapture.messageIds[0]);
      const source = acceptedPageCapture(userMessage?.context);
      if (!source || pageCaptureFingerprint(source) !== pendingCapture.fingerprint) throw issue("PAGE_SAVE_FAILED", "这次读取的正文还没有保存，请重新读取后收藏。", 409);
      const previousDocument = await knowledge.readDocument({ collectionId, limit: 1 });
      const sameDocument = previousDocument.contentHash === createHash("sha256").update(source.text).digest("hex") && previousDocument.coverage === source.coverage && sourceURLKey(previousDocument.url) === sourceURLKey(source.url);
      const previousRevision = Math.max(current.sourceRevision || 1, previousDocument.sourceRevision || 1);
      const sourceRevision = previousDocument.documentVersionId && !sameDocument ? previousRevision + 1 : previousRevision;
      const document = await knowledge.captureSource({ collectionId, captureId: pendingCapture.id, sourceRevision, source });
      if (!document.active) throw issue("SOURCE_CHANGED", "原文版本已变化，请重新打开页面后再收藏。", 409);
      await store.update(draft => {
        const item = draft.collections.find(entry => entry.id === collectionId);
        if (!item || item.pendingPageCapture?.id !== pendingCapture.id) return;
        const changed = item.knowledgeDocumentVersionId !== document.documentVersionId;
        if (changed && item.receipt) {
          const fields = ["input", "receipt", "extraction", "sourceResult", "title", "url", "source", "type", "content", "summary", "status", "thumbnail"];
          item.sourceHistory = [...(item.sourceHistory || []), { ...Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, structuredClone(item[key])])), sourceRevision: item.sourceRevision || 1, createdAt: now() }].slice(-3);
          const previousSourceIds = new Set([collectionId, item.extraction?.collectionId, item.sourceResult?.id].filter(Boolean));
          for (const exhibition of draft.exhibitions) {
            if (![...(exhibition.collectionIds || []), ...(exhibition.sourceCollectionIds || [])].some(sourceId => previousSourceIds.has(sourceId))) continue;
            exhibition.sourceReviewPending = true;
            exhibition.sourceReviewCollectionIds = [...new Set([...(exhibition.sourceReviewCollectionIds || []), collectionId])];
            exhibition.sourceReviewPendingAt ||= now();
          }
        }
        if (changed) {
          for (const key of ["receipt", "extraction", "sourceResult", "summary", "understandingDocumentVersionId"]) delete item[key];
          Object.assign(item, { status: "saved", error: null });
        }
        Object.assign(item, { title: source.title || item.title, url: source.url, sourceRevision: document.sourceRevision,
          knowledgeDocumentVersionId: document.documentVersionId, sourceSaveStatus: document.coverage,
          savedPageSnapshotId: userMessage.context.snapshotId, savedPageFingerprint: pendingCapture.fingerprint, updatedAt: now() });
        const messageIds = new Set(item.pendingPageCapture.messageIds);
        delete item.pendingPageCapture;
        for (const entry of draft.messages.filter(entry => messageIds.has(entry.id))) {
          appendMessage(draft, pageSaveReply(entry, collectionId, document.coverage), entry.conversationId);
        }
      });
      localCuration.queue(collectionId);
    })().finally(() => pageSaves.delete(pendingCapture.id));
    pageSaves.set(pendingCapture.id, operation);
    return operation;
  }

  async function referencesForMessage(source, state, signal) {
    if (!state.collections.length) return { collectionReferences: [] };
    await knowledge.sync();
    signal?.throwIfAborted();
    const connectedId = connectionAnchor(source, state);
    if (connectedId) {
      try {
        const connections = await knowledge.getConnections({ collectionId:connectedId, limit:5 }, { signal });
        const anchorChunks = [...new Map(connections.items.flatMap(item => item.anchorChunks || []).map(chunk => [chunk.chunkId, chunk])).values()];
        const anchor = { ...connections.anchor, ...(anchorChunks.length ? { chunks:anchorChunks } : {}) };
        const hits = [anchor, ...connections.items.map(item => ({ ...item, connectionTo:connectedId, sharedConcepts:item.concepts,
          connectionAnchorDocumentVersionId:anchor.documentVersionId, connectionAnchorSourceRevision:anchor.sourceRevision,
          connectionAnchorUnderstandingRevision:anchor.understandingRevision }))];
        return { collectionReferences:knowledgeReferences(hits, state), expandCollectionScope:true };
      } catch (error) {
        if (!["KNOWLEDGE_SOURCE_UNAVAILABLE", "NOT_FOUND"].includes(error.code)) throw error;
      }
    }
    const anchorId = similarityAnchor(source, state);
    if (anchorId) {
      try {
        const similar = await knowledge.findSimilar({ collectionId: anchorId, limit: 5 }, { signal });
        return { collectionReferences: knowledgeReferences([similar.anchor, ...similar.items.map(item => ({ ...item, similarityTo: anchorId }))], state), expandCollectionScope: true };
      } catch (error) {
        if (!["KNOWLEDGE_SOURCE_UNAVAILABLE", "NOT_FOUND"].includes(error.code)) throw error;
      }
    }
    const ids = source.workspaceContext?.collectionIds;
    if (ids) {
      const found = await knowledge.search({ query: source.text, collectionIds: ids, limit: 6 }, { signal });
      const hits = new Map(found.items.map(item => [item.collectionId, item]));
      for (const collectionId of ids.slice(0, 6)) if (!hits.has(collectionId)) {
        signal?.throwIfAborted();
        try { hits.set(collectionId, await knowledge.readDocument({ collectionId, limit: 2400 })); }
        catch (error) {
          if (!["NOT_FOUND", "KNOWLEDGE_SOURCE_UNAVAILABLE"].includes(error.code)) throw error;
          hits.set(collectionId, { collectionId, documentVersionId: null, chunks: [] });
        }
      }
      return { collectionReferences: knowledgeReferences(ids.map(id => hits.get(id)).filter(Boolean), state) };
    }
    if (!shouldSearchCollections(source.text)) return { collectionReferences: [] };
    const found = await knowledge.search({ query: source.text, limit: 6 }, { signal });
    if (found.items.length) return { collectionReferences: knowledgeReferences(found.items, state) };
    // Preserve the explicit recent-library fallback. A failed topic search must
    // not silently become a list of whatever was saved most recently.
    return { collectionReferences: /(?:最近|近期).*?(?:收藏(?!馆|品)|收下的)/u.test(source.text) ? retrieveCollections(source.text, state.collections) : [] };
  }

  async function readPageContext(context, signal, { action = "chat-with-page", requestId } = {}) {
    const authorization = skills.authorize({ action, context, requestId });
    return skills.execute("read-page", { context, authorization }, { signal });
  }

  async function readPageWithTimeout(body) {
    if (stopping) throw issue("SERVICE_STOPPING", "本地服务正在退出，请稍后重试。", 503);
    const context = pageContext(body?.context ?? body);
    if (!context || (!context.url && !context.text && !context.selection)) throw issue("NEEDS_CONTEXT", "先关联页面或提供要读取的公开链接。");
    const requestId = body?.requestId === undefined ? undefined : text(body.requestId, "请求编号", 100);
    const controller = new AbortController();
    pageReads.add(controller);
    const timer = setTimeout(() => controller.abort(issue("PAGE_READ_TIMEOUT", "页面读取超时，可以稍后重试。", 408)), 20000);
    let onAbort;
    const cancellation = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason || issue("PAGE_READ_ABORTED", "页面读取已中断。", 499));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([readPageContext(context, controller.signal, { action: "read-page", requestId }), cancellation]);
      let previewId;
      if (body.retainPublicPreview === true && context.url && !context.text && !context.selection && result.readStatus === "public_page") {
        const snapshot = { ...result, snapshotId: `page-${randomUUID().replaceAll("-", "")}`, readAt: now() };
        if (acceptedPageCapture(snapshot)) {
          previewId = snapshot.snapshotId;
          publicPreviews.set(previewId, { snapshot, expiresAt: Date.now() + 30 * 60_000 });
          if (publicPreviews.size > 32) publicPreviews.delete(publicPreviews.keys().next().value);
        }
      }
      return { context: result, readable: result.readStatus !== "unavailable", ...(requestId ? { requestId } : {}), ...(previewId ? { previewId } : {}) };
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      const code = controller.signal.reason?.code || "PAGE_READ_ABORTED";
      return { context: { ...context, text: "", selection: "", readStatus: "unavailable", readError: code,
        contentQuality: { version: 1, status: "unavailable", characterCount: 0, paragraphCount: 0, warnings: [code] } },
        readable: false, ...(requestId ? { requestId } : {}) };
    } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); pageReads.delete(controller); }
  }

  function pageResponse(result, requestId) {
    const stored = store.read();
    const state = publicState();
    const sourceMessageId = stored.pageRequests[requestId]?.sourceMessageId;
    const original = sourceMessageId && stored.messages.find(item => item.id === sourceMessageId && item.conversationId === result.conversationId)?.context;
    return { ...result, requestId, readable: true, state, conversation: state.conversations.find(item => item.id === result.conversationId),
      context: original ? structuredClone(original) : storedPageSource(stored, result.conversationId) };
  }

  function publicState() {
    const state = store.read();
    const collections = new Map(state.collections.map(item => [item.id, item]));
    return {
      profile: { ...state.profile, name: currentCompanionName(state.profile.name) },
      collections: state.collections.map(({ receipt, sourceResult, input, sourceHistory, manualThumbnail, pendingPageCapture, savedPageFingerprint, ...item }) => {
        const coverColor = demoCoverColors.get(item.thumbnail);
        return { ...item, ...(coverColor ? { coverColor } : {}), ...(input?.videoCaptions ? { videoCaptions: true } : {}) };
      }),
      exhibitions: state.exhibitions.filter(item => currentLocalTopic(item, collections)).map(item => {
        const { receipt, curationEvidenceFeatures, curationTopic, curationTopicKeys, curationScopeId, curationRequestedIds, ...publicItem } = item;
        const editorialReadings = demoReadings.get(item.id);
        return { ...publicItem, ...(editorialReadings ? { editorialReadings:structuredClone(editorialReadings) } : {}), ...(item.sourceReviewPending ? { status:"needs_review" } : {}) };
      }),
      messages: state.messages.map(({ requestFingerprint, ...entry }) => entry),
      jobs: state.jobs.map(publicJob),
      conversations: publicConversations(state),
      activeConversationId: state.activeConversationId,
      surfaceSessions: publicSurfaceSessions(state),
      memories: publicMemories(state),
      workspace: { ...emptyWorkspace(), ...state.workspace },
      capabilities: { aiEnabled, webSearch: Boolean(searchWeb), autoCurate: Boolean(autoCurate), localOnly: true, ...(demoLibrary ? { demoAccount:true } : {}), knowledge: knowledge.status(),
        harness: { version: 2, memory: true, pageSessions: true, historyTurns: 20, pageSessionHours: 24,
          skills: skills.describe().map(({ id, version, description, capabilities }) => ({ id, version, description, capabilities })) } },
    };
  }

  function queueCuration(draft, conversationId) {
    const items = eligible(draft);
    const active = draft.jobs.some((job) => job.type === "curate" && ["queued", "running"].includes(job.status));
    if (items.length < 6) throw issue("INSUFFICIENT_ITEMS", `完整展览需要至少 6 条通过来源校验的收藏，目前有 ${items.length} 条。单条收藏可以随时保存和阅读。`, 409);
    if (!aiEnabled) throw issue("AI_DISABLED", "智能功能尚未配置。", 503);
    if (active) throw issue("JOB_RUNNING", "已有一场展览正在整理。", 409);
    const selected = items.slice(-12);
    const job = { id: id("job"), type: "curate", status: "queued", automatic:false, eligibleCount: items.length, collectionIds: selected.map((item) => item.id), profileSnapshot: structuredClone(draft.profile), receipts: selected.map((item) => item.receipt), createdAt: now(), updatedAt: now() };
    appendJob(draft, job, conversationId);
    appendMessage(draft, message("assistant", "开始从你的收藏中寻找主题并整理完整展览。完成后会出现在收藏馆。", { jobId: job.id }));
    return job;
  }

  function queueRetry(draft, previous) {
    if (!previous || previous.status !== "failed") throw issue("JOB_NOT_RETRYABLE", "这项任务不需要重试。", 409);
    const root = previous.retryRootId || previous.id;
    const latest = draft.jobs.findLast((entry) => entry.id === root || entry.retryRootId === root);
    // Two clicks or a retried HTTP request share the same descendant attempt.
    if (latest && latest.id !== previous.id) return latest;
    previous = latest || previous;
    if (previous.type === "curate") {
      const available = new Set(eligible(draft).map((item) => item.receipt));
      if (previous.receipts?.some((receipt) => !available.has(receipt))) throw issue("SOURCE_CHANGED", "这批收藏已修订或待核对，请使用最新收藏重新整理展览。", 409);
    }
    if (previous.collectionId) {
      const item = draft.collections.find((entry) => entry.id === previous.collectionId);
      if (item?.pendingPageCapture) throw issue("PAGE_SAVE_PENDING", "这条收藏正在保存原文，请稍后重试。", 409);
      if (item?.savedPageSnapshotId && previous.type === "ingest" && !previous.sourceRefresh && previous.savedPageDocumentVersionId !== item.knowledgeDocumentVersionId) {
        throw issue("SOURCE_CHANGED", "这条收藏已经保存了新的正文，请从当前收藏重新整理。", 409);
      }
      const changed = draft.jobs.some((entry, index) => index > draft.jobs.indexOf(previous) && ["ingest", "revise"].includes(entry.type) && entry.collectionId === previous.collectionId && entry.status === "complete" && (entry.retryRootId || entry.id) !== root);
      if (changed || (previous.type === "revise" && previous.baseReceipt && previous.baseReceipt !== item?.receipt)) throw issue("SOURCE_CHANGED", "这条收藏已有新的理解，请基于最新内容重新提交修改。", 409);
      if (previous.type === "reading" && (!item || (item.sourceRevision || 1) !== previous.readingInput?.sourceRevision)) throw issue("SOURCE_CHANGED", "原文版本已变化，请基于当前原文重新生成。", 409);
    }
    const keys = ["type", "conversationId", "collectionId", "messageId", "correction", "baseReceipt", "receipts", "collectionIds", "curationQuestion", "profileSnapshot", "memorySnapshot", "eligibleCount", "automatic", "sourceRefresh", "sourceInput", "baseSourceRevision", "targetSourceRevision", "readingInput", "readingMode", "documentVersionId", "savedPageDocumentVersionId", "savedVideoDocumentVersionId", "webSearch"];
    const job = {
      ...Object.fromEntries(keys.filter((key) => previous[key] !== undefined).map((key) => [key, structuredClone(previous[key])])),
      id: id("job"), status: "queued", retryOf: previous.id, retryRootId: root, attempt: (previous.attempt || 1) + 1,
      createdAt: now(), updatedAt: now(),
      ...(previous.harness ? { harness: resumeHarness(previous) } : {}),
    };
    if (job.collectionId) {
      const item = draft.collections.find((entry) => entry.id === job.collectionId);
      if (!item) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
      if (draft.jobs.some((entry) => entry.collectionId === job.collectionId && ["queued", "running"].includes(entry.status))) throw issue("JOB_RUNNING", "这条收藏仍在处理中。", 409);
      if (job.type !== "reading") Object.assign(item, { status: "processing", error: null, updatedAt: now() });
    }
    if (job.type === "curate" && draft.jobs.some((entry) => entry.type === "curate" && ["queued", "running"].includes(entry.status))) throw issue("JOB_RUNNING", "已有一场展览正在整理。", 409);
    appendJob(draft, job);
    if (previous.harness) previous.harness.checkpoints = {};
    if (job.type !== "reading" && !job.webSearch) appendMessage(draft, message("assistant", "我会接着已完成的步骤继续处理。", { jobId: job.id, ...(job.collectionId ? { collectionIds: [job.collectionId] } : {}) }));
    return job;
  }

  async function finish(jobId, mutation) {
    await store.update((draft) => {
      const job = draft.jobs.find((item) => item.id === jobId);
      mutation(draft, job);
      job.updatedAt = now();
      // Finished outputs live in the library; only failed attempts need private
      // stage payloads. Keep at most 20 failed attempts' checkpoints locally.
      if (job.status === "complete" && job.harness) job.harness.checkpoints = {};
      const failed = draft.jobs.filter((entry) => entry.status === "failed" && entry.harness);
      for (const old of failed.slice(0, -20)) old.harness.checkpoints = {};
    });
    if (!stopping) await knowledge.sync();
  }

  async function execute(jobId) {
    if (stopping) return;
    const current = store.read().jobs.find((item) => item.id === jobId);
    if (!current || current.status !== "queued") return;
    await finish(jobId, (_draft, job) => { job.status = "running"; job.startedAt = now(); });
    if (stopping) return;
    try {
      if (current.type === "curate-selected") {
        const result = await localCuration.curateSelected({ collectionIds: current.collectionIds, question: current.curationQuestion });
        if (stopping) return;
        const relatedIds = [...new Set((result.related || []).map(item => item.collectionId))]
          .filter(collectionId => current.collectionIds.includes(collectionId));
        await finish(jobId, (draft, job) => {
          const topic = result.status === "ready" && draft.exhibitions.find(item => item.id === result.topicId);
          const ready = topic && currentLocalTopic(topic, new Map(draft.collections.map(item => [item.id, item])));
          job.status = "complete";
          job.result = ready ? "topic_ready" : "related_only";
          if (ready) job.exhibitionId = result.topicId;
          const reason = result.status === "ready" ? "source_changed" : result.reason;
          const output = ready ? `已把你指定的收藏整理成《${result.title}》。` : curationRelatedReply(reason, relatedIds.length);
          appendMessage(draft, message("assistant", output, { sourceMessageId: job.messageId, jobId, referenceAttribution: "selected_curation",
            ...(ready ? { exhibitionId: result.topicId } : { relatedCollectionIds: relatedIds }) }));
        });
        return;
      }
      const collection = current.collectionId && store.read().collections.find(item => item.id === current.collectionId);
      const captureVideo = current.type === "ingest" && (current.sourceRefresh ? current.sourceInput : collection?.input)?.videoCaptions === true;
      if (!aiEnabled && !captureVideo && !current.webSearch) throw issue("AI_DISABLED", "智能功能尚未配置。", 503);
      if (current.harness) await store.update((draft) => {
        const job = draft.jobs.find((entry) => entry.id === jobId);
        job.harness.checkpoints = resumeHarness(job).checkpoints;
      });
      const harness = await createHarness({ store, jobId, limits: harnessLimits });
      const checkedModel = (callId, context) => harness.invoke(callId, (signal) => model === pipelineModel || model.supportsAbortSignal === true
        ? model(callId, context, { signal }) : model(callId, context));
      if (current.type === "ingest" || current.type === "revise") {
        if (!collection) throw issue("NOT_FOUND", "收藏不存在。", 404);
        const input = current.sourceRefresh ? current.sourceInput : collection.input;
        const savedVideoRefresh = captureVideo && current.savedVideoDocumentVersionId
          && current.savedVideoDocumentVersionId === collection.knowledgeDocumentVersionId && collection.sourceRevision === current.targetSourceRevision;
        if (current.sourceRefresh && (input?.mode !== "link" || ((collection.sourceRevision || 1) !== current.baseSourceRevision && !savedVideoRefresh))) throw issue("SOURCE_CHANGED", "这条收藏的原文版本已变化，请基于当前内容重新读取。", 409);
        // A successful read is retained even if understanding fails afterwards.
        let capturedDocument;
        let parsedVideo;
        if (captureVideo) {
          if (stopping) throw issue("INTERRUPTED", "本机服务正在退出，字幕读取已中断。", 503);
          const controller = new AbortController();
          pageReads.add(controller);
          try {
            parsedVideo = await harness.step("source", async (signal) => {
              const readSignal = AbortSignal.any([signal, controller.signal]);
              const video = await readVideoCaptions(input.content, { fetchPage, signal: readSignal });
              readSignal.throwIfAborted();
              const text = video.segments.map(segment => segment.text).join("\n");
              return { ...video, text, sourceKind: "transcript", evidence: evidenceFor(text, collection.id, video.segments) };
            }, { checkpoint: true, tool: "read-video-captions" });
          } finally { pageReads.delete(controller); }
          if (stopping) throw issue("INTERRUPTED", "本机服务正在退出，字幕读取已中断。", 503);
          capturedDocument = await preserveSource(collection, parsedVideo, current);
          if (!capturedDocument.active) throw issue("SOURCE_CHANGED", "原文版本已变化，请基于当前内容重新整理。", 409);
          const video = youtubePreview(parsedVideo.url);
          const transcriptOnly = !aiEnabled || parsedVideo.text.length < 20 || parsedVideo.text.length > 60000;
          const record = (draft, job) => {
            const item = draft.collections.find(entry => entry.id === collection.id);
            Object.assign(item, { title: parsedVideo.title, url: parsedVideo.url, source: "YouTube", sourceRevision: capturedDocument.sourceRevision,
              ...(video && !item.manualThumbnail ? { thumbnail: video.thumbnail } : {}), updatedAt: now() });
            if (current.sourceRefresh) job.savedVideoDocumentVersionId = capturedDocument.documentVersionId;
            if (transcriptOnly) {
              item.status = "saved";
              job.status = "complete"; job.result = "transcript_saved";
              appendMessage(draft, message("assistant", "已将带时间戳的 YouTube 字幕保存到 Folio。", { collectionIds: [item.id], jobId }));
            }
          };
          if (transcriptOnly) {
            await finish(jobId, record);
            return;
          }
          await store.update(draft => record(draft, draft.jobs.find(job => job.id === jobId)));
        } else if (current.type === "ingest" && input.mode === "link") {
          const video = youtubePreview(input.content);
          if (current.savedPageDocumentVersionId) {
            const source = await harness.step("source", async () => {
              const document = await knowledge.readDocument({ collectionId: collection.id, documentVersionId: current.savedPageDocumentVersionId, limit: 40000 });
              if (!document.active || document.hasMore || !document.text) throw issue("SOURCE_CHANGED", "原文版本已变化，请基于当前内容重新整理。", 409);
              return { title: document.title, url: document.url, text: document.text, type: "text/plain", coverage: document.coverage };
            }, { checkpoint: true, tool: "read-source" });
            capturedDocument = await knowledge.readDocument({ collectionId: collection.id, documentVersionId: current.savedPageDocumentVersionId, limit: 1 });
            if (!capturedDocument.active || !source.text) throw issue("SOURCE_CHANGED", "原文版本已变化，请基于当前内容重新整理。", 409);
          } else if (video) {
            const presentation = await harness.step("source", signal => covers.video(video, signal), { checkpoint: true, tool: "read-video-preview" });
            await applyPresentation(collection.id, input, presentation, { video });
          } else if (platform(input.content) === "generic") {
            let acquired;
            try {
              acquired = await harness.step("source", signal => readLinkSource(input, signal), { checkpoint: true, tool: "read-source" });
            } catch (error) {
              await applyPresentation(collection.id, input, error.presentation);
              throw error;
            }
            await applyPresentation(collection.id, input, acquired.presentation);
            // Old checkpoints retain their original body. Backfill a cover by
            // reading presentation metadata separately without replacing it.
            if (!acquired.presentation && !collection.thumbnail) scheduleSavedPresentation(collection.id, input);
            capturedDocument = await preserveSource(collection, { ...acquired, sourceKind: "body_text" }, current);
            if (acquired.text.length > 60000) throw issue("CONTENT_TOO_LONG", "页面正文过长，请选取需要收藏的段落。");
          }
        }
        const result = current.type === "revise"
          ? await harness.step("revise", () => revise(current.baseReceipt || collection.receipt, current.correction, checkedModel), { checkpoint: true, tool: "revise" })
          : await harness.step("understand", (signal) => ingest(parsedVideo ? { ...parsedVideo, mode: "parsed" } : input, {
            model: checkedModel,
            trustedWorker: Boolean(parsedVideo),
            fetch: () => Promise.resolve(harness.snapshot().checkpoints.source.value),
            vision: (visionConfig, payload) => harness.invoke("CALL-VISION01", () => executeCall(visionConfig, payload, { signal })),
            onSource: parsedVideo ? undefined : async source => { capturedDocument = await preserveSource(collection, source, current, signal); },
          }), { checkpoint: true, tool: "understand" });
        if (!capturedDocument) capturedDocument = await knowledge.readDocument({ collectionId: collection.id, limit: 1 });
        const attached = await knowledge.attachUnderstanding({ collectionId: collection.id, documentVersionId: capturedDocument.documentVersionId, sourceRevision: current.targetSourceRevision || collection.sourceRevision || 1, extraction: result.extraction });
        await finish(jobId, (draft, job) => {
          const item = draft.collections.find((entry) => entry.id === current.collectionId);
          Object.assign(item, {
            title: result.collection.title, url: result.collection.url || item.url,
            source: result.collection.source, type: result.collection.type,
            status: result.collection.status, summary: result.extraction.summary,
            extraction: result.extraction, receipt: result.receipt,
            sourceResult: result.collection, updatedAt: now(), error: null,
            sourceRevision: current.sourceRefresh ? current.targetSourceRevision : (item.sourceRevision || 1),
            ...(item.sourceSaveStatus && capturedDocument.documentVersionId ? { sourceSaveStatus: capturedDocument.coverage } : {}),
            ...(attached.attached ? { understandingDocumentVersionId: attached.documentVersionId } : {}),
          });
          job.status = "complete";
          job.result = item.status;
          if (current.type === "revise" && draft.workspace?.feedback) delete draft.workspace.feedback[`understanding:${item.id}`];
          const resultText = item.status === "ready" ? `《${item.title}》整理好了。${item.summary}` : `《${item.title}》已整理，但还需要补充或核对内容。${result.extraction.hint || "你可以先查看原文。"}`;
          appendMessage(draft, message("assistant", (parsedVideo ? "已将带时间戳的 YouTube 字幕保存到 Folio。" : "") + resultText, { collectionIds: [item.id], jobId }));
        });
        if (current.sourceRefresh) localCuration.queue(current.collectionId);
      } else if (current.type === "reading") {
        const controller = new AbortController();
        readingControllers.set(jobId, controller);
        try {
          const input = current.readingInput;
          const collection = store.read().collections.find(item => item.id === current.collectionId);
          if (!collection) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
          const source = await harness.step("source", () => loadReadingSource(knowledge, collection, input.documentVersionId), { checkpoint: true, tool: "read-stored-source" });
          const assertCurrent = async () => {
            if (controller.signal.aborted) throw controller.signal.reason;
            const liveState = store.read();
            if (liveState.jobs.find(item => item.id === jobId)?.status !== "running") throw issue("READING_CANCELLED", "已停止这次阅读生成。", 409);
            if (input.mode === "understanding" && liveState.collections.find(item => item.id === collection.id)?.pendingPageCapture) throw issue("SOURCE_CHANGED", "原文正在更新，请保存完成后重新生成。", 409);
            const live = await knowledge.readDocument({ collectionId: collection.id, limit: 1 });
            if (live.documentVersionId !== input.documentVersionId || live.contentHash !== input.contentHash || source.documentVersionId !== input.documentVersionId || source.contentHash !== input.contentHash) throw issue("SOURCE_CHANGED", "原文已更新，请基于当前原文重新生成。", 409);
            if (!source.paragraphs.length) throw issue("READING_SOURCE_UNAVAILABLE", "这条收藏暂时没有可供阅读的原文，请先重新读取来源。", 409);
          };
          await assertCurrent();
          const result = await harness.step("reading", async () => {
            const temperature = ["understanding", "plain"].includes(input.mode) ? 0.2 : 0.35;
            const response = await harness.invoke("CALL-READING", signal => abortableReading(combinedSignal => chat(config, { messages: readingMessages(source, input), temperature, responseFormat: "json_object", signal: combinedSignal }), [signal, controller.signal]));
            return validateReadingResult(response, source, input.mode);
          }, { checkpoint: true, tool: "reading" });
          await assertCurrent();
          await finish(jobId, (draft, job) => {
            if (controller.signal.aborted || job.status !== "running") throw issue("READING_CANCELLED", "已停止这次阅读生成。", 409);
            const liveCollection = draft.collections.find(item => item.id === collection.id);
            if (!liveCollection || (liveCollection.sourceRevision || 1) !== input.sourceRevision
              || (input.mode === "understanding" && liveCollection.pendingPageCapture)) throw issue("SOURCE_CHANGED", "原文已更新，请基于当前原文重新生成。", 409);
            const saved = { id: id("reading"), ...result, collectionId: collection.id, documentVersionId: input.documentVersionId, contentHash: input.contentHash, sourceRevision: input.sourceRevision, mode: input.mode, prompt: input.prompt || "", question: input.question || "", promptVersion: readingPromptVersion(input.mode), createdAt: now() };
            draft.reading.results.push(saved);
            // Keep a bounded private cache; old document results never appear on
            // the current source and can be regenerated when explicitly needed.
            draft.reading.results = draft.reading.results.slice(-250);
            job.status = "complete"; job.result = "reading_ready"; job.readingResultId = saved.id;
          });
        } finally { readingControllers.delete(jobId); }
      } else if (current.type === "chat" && current.webSearch) {
        if (!searchWeb) throw issue("WEB_SEARCH_UNAVAILABLE", webSearchUnavailable, 503);
        const { request, requestedAt } = current.webSearch;
        const { query, recency } = providerQuery(request, requestedAt, clock());
        const { candidates, skill } = await harness.step("search", signal => {
          const authorization = skills.authorize({ action: "search-web", query, recency, requestId: jobId });
          return skills.execute("web-search", { query, recency, authorization }, {
            signal: AbortSignal.any([signal, webSearchStop.signal]),
          });
        }, { tool: "search-web", timeoutMs: 18000 });
        webSearchStop.signal.throwIfAborted();
        const sources = selectWebSources(candidates, request, requestedAt, { allowUndated: recency === "oneDay" });
        await finish(jobId, (draft, job) => {
          webSearchStop.signal.throwIfAborted();
          job.status = "complete";
          job.result = sources.length ? "web_search_ready" : "web_search_empty";
          appendMessage(draft, message("assistant", webSearchReply(request, sources), {
            sourceMessageId: job.messageId, jobId, webSources: sources, webSearchSkill: skill,
          }));
        });
      } else if (current.type === "chat") {
        const state = store.read();
        const messageIndex = state.messages.findIndex((item) => item.id === current.messageId);
        const source = state.messages[messageIndex];
        const context = source?.context ? await harness.step("context", (signal) => readPageContext(source.context, signal), { checkpoint: true, tool: "read-page" }) : undefined;
        if (context) {
          source.context = context;
          await store.update((draft) => { const entry = draft.messages.find((item) => item.id === source.id); if (entry) entry.context = context; });
          if (context.readStatus === "unavailable") {
            await finish(jobId, (draft, job) => { job.status = "complete"; job.result = "source_unavailable"; appendMessage(draft, message("assistant", pageUnavailable(context), { jobId, ...pageSource(source) })); });
            return;
          }
        }
        const contextState = { ...state, collections: state.collections.map((item) => ["pending_rewrite", "confirmed_edited"].includes(state.workspace?.feedback?.[`understanding:${item.id}`]?.decision) ? { ...item, status: "needs_confirmation" } : item) };
        const retrieved = await harness.step("context", (signal) => referencesForMessage(source, contextState, signal), { tool: "search-library" });
        const recalled = await harness.step("context", (signal) => memoryRetriever.retrieve({ state: liveReferenceState(contextState), messageId: current.messageId, signal }), { tool: "search-memory" });
        if (stopping) throw issue("INTERRUPTED", "本机服务正在退出，这次对话已中断，可以稍后继续。", 503);
        let assembled = buildConversationContext({ state: liveReferenceState(contextState), messageId: current.messageId, context, profile: current.profileSnapshot || state.profile,
          memorySnapshot: current.memorySnapshot,
          memoryRecalls: recalled.recalls,
          ...retrieved, collectionReferences:protectKnowledgeReferences(retrieved.collectionReferences, liveReferenceState(contextState)) });
        await store.update((draft) => { draft.jobs.find((entry) => entry.id === jobId).contextManifest = assembled.manifest; });
        const reply = await harness.step("answer", async () => {
          const result = await harness.invoke("CALL-CHAT", (signal) => {
            if (stopping) throw issue("INTERRUPTED", "本机服务正在退出，这次对话已中断。", 503);
            const live = liveReferenceState(contextState);
            assembled = buildConversationContext({ state:live, messageId:current.messageId, context, profile:current.profileSnapshot || state.profile,
              memorySnapshot: current.memorySnapshot,
              memoryRecalls: recalled.recalls,
              ...retrieved, collectionReferences:protectKnowledgeReferences(retrieved.collectionReferences, live) });
            if (assembled.manifest.memory) Object.assign(assembled.manifest.memory, { retrieval: recalled.retrieval, semanticStatus: recalled.semanticStatus });
            return chat(config, { messages: assembled.messages, temperature: 0.65, responseFormat: "text", signal });
          });
          const value = result?.choices?.[0]?.message?.content;
          if (typeof value !== "string" || !parseCollectionCitations(value, assembled.manifest.itemIds).text) throw issue("MODEL_OUTPUT_INVALID", "智能服务没有返回可阅读内容。", 502);
          return value.trim();
        }, { checkpoint: true, tool: "chat" });
        const cited = parseCollectionCitations(reply, assembled.manifest.itemIds);
        if (!cited.text) throw issue("MODEL_OUTPUT_INVALID", "智能服务没有返回可阅读内容。", 502);
        await finish(jobId, (draft, job) => {
          if (!isMemoryContextCurrent(draft, assembled.manifest)) throw issue("MEMORY_CHANGED", "记忆已变更，需要重新生成。", 409);
          job.status = "complete"; job.contextManifest = assembled.manifest;
          appendMessage(draft, message("assistant", cited.text, { jobId, relatedCollectionIds: cited.relatedCollectionIds, referenceAttribution: "explicit_citations", contextTruncated: assembled.manifest.truncated,
            ...(assembled.manifest.memory?.recalls?.length ? { memoryReferences: assembled.manifest.memory.recalls } : {}), ...pageSource(source) }));
        });
      } else if (current.type === "curate") {
        const snapshot = current.profileSnapshot || store.read().profile;
        const profile = { ...snapshot, name: currentCompanionName(snapshot.name) };
        const constraints = [
          ...(profile.preferences || "").split("\n").filter(Boolean),
          ...(profile.personality ? [`策展人的交流与叙事风格：${profile.personality}`] : []),
        ];
        const curatorModel = (callId, context) => checkedModel(callId, {
          ...context,
          personal_curator: profile,
          ...(callId === "CALL-PEVAL"
            ? { explicit_user_constraints: [...(context.explicit_user_constraints || []), ...constraints] }
            : { explicit_feedback_constraints: [...(context.explicit_feedback_constraints || []), ...constraints] }),
        });
        const discovery = await harness.step("discover", () => discover(current.receipts, curatorModel), { checkpoint: true, tool: "discover" });
        if (discovery.status !== "candidate") {
          await finish(jobId, (draft, job) => { job.status = "complete"; job.result = "waiting_for_content"; appendMessage(draft, message("assistant", discovery.message, { jobId })); });
          return;
        }
        const candidate = await harness.step("compose", () => curate(discovery.receipt, curatorModel, { recoveryPlan: Boolean(current.retryOf) }), { checkpoint: true, tool: "compose" });
        if (candidate.status !== "candidate") {
          await finish(jobId, (draft, job) => { job.status = "complete"; job.result = "waiting_for_content"; appendMessage(draft, message("assistant", candidate.message, { jobId })); });
          return;
        }
        const result = await harness.step("evaluate", () => evaluate(candidate.receipt, curatorModel), { checkpoint: true, tool: "evaluate" });
        await finish(jobId, (draft, job) => {
          const mapping = new Map(draft.collections.filter((item) => item.sourceResult).map((item) => [item.sourceResult.id, item.id]));
          if (!draft.exhibitions.some((entry) => entry.id === result.exhibition.id)) draft.exhibitions.push({ ...result.exhibition, receipt: result.receipt, collectionIds: result.exhibition.sourceCollectionIds.map((sourceId) => mapping.get(sourceId)).filter(Boolean) });
          job.status = "complete"; job.result = result.exhibition.status; job.exhibitionId = result.exhibition.id;
          appendMessage(draft, message("assistant", result.message, { exhibitionId: result.exhibition.id, jobId }));
        });
        // Native completion feedback follows durable success; a display callback
        // cannot turn a saved exhibition into a failed processing job.
        try { await onEvent?.({ type: "exhibition-ready", exhibitionId: result.exhibition.id }); } catch {}
      }
    } catch (error) {
      if (stopping && current.type === "curate-selected") return;
      await finish(jobId, (draft, job) => {
        job.status = "failed"; job.error = current.webSearch ? webSearchErrorText(error) : current.type === "chat" ? chatErrorText(error) : current.type === "reading" ? ({ READING_CANCELLED: "已停止这次阅读生成。", READING_OUTPUT_INVALID: "阅读结果未通过来源校验，请重试。", READING_INSUFFICIENT_SOURCE: "已保存的内容不足以写出有依据的解读。你可以先看原文。", READING_SOURCE_UNAVAILABLE: "暂时没有可供阅读的原文，请先重新读取来源。", SOURCE_CHANGED: "原文已更新，请基于当前原文重新生成。", INTERRUPTED: "阅读生成已中断，可以重新生成。" }[error.code] || errorText(error)) : errorText(error); job.errorCode = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "PROCESSING_FAILED";
        if (job.collectionId && current.type !== "reading") {
          const item = draft.collections.find((entry) => entry.id === job.collectionId);
          if (item) {
            if (job.harness?.steps.some(step => step.tool === "read-video-captions" && step.status === "complete") && item.sourceSaveStatus === "complete") job.error = "YouTube 字幕已保存到 Folio。后续处理可以重试。";
            Object.assign(item, { status: error.code === "AI_DISABLED" ? "saved" : "failed", error: job.error, updatedAt: now() });
          }
        }
        if (current.type !== "reading") appendMessage(draft, message("assistant", job.error, { jobId, ...(current.webSearch ? { sourceMessageId: job.messageId } : current.type === "chat" ? pageSource(draft.messages.find((item) => item.id === current.messageId)) : {}), ...(job.collectionId ? { collectionIds: [job.collectionId] } : {}) }));
      });
    }
  }

  function schedule(jobId) {
    if (stopping || pending.has(jobId)) return;
    pending.add(jobId);
    const run = queue => queue.then(() => execute(jobId)).catch(() => {}).finally(() => pending.delete(jobId));
    if (store.read().jobs.find(job => job.id === jobId)?.type === "curate-selected") selectedCurationWork = run(selectedCurationWork);
    else work = run(work);
  }

  // A running network call cannot be resumed safely after process termination.
  // Keep its source and show a retry action instead of silently duplicating it.
  await store.update((draft) => {
    for (const job of draft.jobs) {
      if (job.type === "curate" && job.automatic && job.status === "queued") {
        Object.assign(job, { status:"failed", errorCode:"AUTOMATIC_CURATION_REPLACED", error:"自动策展已按本地专题条件重新检查。可以手动继续整理这场完整展览。", updatedAt:now() });
        continue;
      }
      if (job.status !== "running") continue;
      if (job.type === "curate-selected") {
        // The selected inputs are persisted and writing the same topic is idempotent.
        Object.assign(job, { status:"queued", updatedAt:now() });
        continue;
      }
      job.status = "failed"; job.errorCode = "INTERRUPTED";
      job.error = "上次处理因本地服务退出而中断，原始内容已保留，可以重试。";
      job.updatedAt = now();
      for (const entry of [...(job.harness?.steps || []), ...(job.harness?.calls || [])]) {
        if (entry.status === "running") Object.assign(entry, { status: "failed", errorCode: "INTERRUPTED", finishedAt: now() });
      }
      const item = draft.collections.find((entry) => entry.id === job.collectionId);
      if (item && job.type !== "reading") Object.assign(item, { status: "failed", error: job.error, updatedAt: now() });
    }
  });
  await knowledge.sync();
  await Promise.allSettled(store.read().collections.filter(item => item.pendingPageCapture).map(item => persistAcceptedPage(item.id)));
  await localCuration.backfill().catch(() => {});
  for (const job of store.read().jobs) if (job.status === "queued") schedule(job.id);

  return {
    state: publicState,
    curationReading: body => curationModelReading.read(body),
    async acceptCurationUpdate(body) {
      const exhibitionId = text(body?.exhibitionId, "专题编号", 150);
      text(body?.updateId, "更新编号", 150);
      const expectedVersion = body?.expectedVersion;
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw issue("INVALID_REQUEST", "请选择当前专题的待加入资料。");
      if (!store.read().exhibitions.some(topic => topic.kind === "local-topic" && topic.id === exhibitionId)) throw issue("NOT_FOUND", "找不到这个专题。", 404);
      throw issue("CURATION_UPDATE_CHANGED", "这条资料加入提议已失效。", 409);
    },
    readCover: covers.read,
    async collectionCoverColor(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      const item = store.read().collections.find(entry => entry.id === collectionId);
      if (!item || !/^https:\/\//iu.test(item.thumbnail || "")) return { color: null };
      const controller = new AbortController();
      pageReads.add(controller);
      try { return { color: demoCoverColors.get(item.thumbnail) || await covers.color(item.thumbnail, controller.signal) }; }
      finally { pageReads.delete(controller); }
    },
    async setCollectionCover(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      const url = validURL(text(body?.coverUrl, "封面地址", 4000));
      if (url.protocol !== "https:") throw issue("UNSAFE_URL", "封面需要可公开访问的 HTTPS 图片链接。");
      const item = store.read().collections.find(entry => entry.id === collectionId);
      if (!item || item.input?.mode !== "link") throw issue("NOT_FOUND", "找不到这条网页收藏。", 404);
      const controller = new AbortController();
      pageReads.add(controller);
      try {
        const thumbnail = await covers.acquire([url.href], item.input.content, controller.signal);
        if (!thumbnail) throw issue("COVER_UNAVAILABLE", "没有读取到可用的原始图片。", 422);
        await applyPresentation(collectionId, item.input, { thumbnail }, { manual: true });
        return { state: publicState(), thumbnail };
      } finally { pageReads.delete(controller); }
    },
    async harness() {
      const { describeHarness } = await import("./harness/architecture.mjs");
      return describeHarness({ skills: skills.describe(), memoryPolicy: MEMORY_POLICY });
    },
    readPage: readPageWithTimeout,
    resolvePage(body) {
      const context = pageContext(body?.context);
      return resolvePageSession(store.read(), context, { at: clock() });
    },
    pageSource(body) {
      return { context: storedPageSource(store.read(), text(body?.conversationId, "对话编号", 150)) };
    },
    async openPage(body) {
      if (stopping) throw issue("SERVICE_STOPPING", "本地服务正在退出，请稍后重试。", 503);
      const context = pageContext(body?.context);
      pageIdentity(context);
      const requestId = text(body?.requestId, "读取请求编号", 100);
      if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw issue("INVALID_REQUEST", "请求编号格式不正确。");
      for (const key of ["forceNew", "reread"]) if (body[key] !== undefined && typeof body[key] !== "boolean") throw issue("INVALID_REQUEST", "页面读取操作格式不正确。");
      const fingerprint = createHash("sha256").update(JSON.stringify({ context, forceNew: Boolean(body.forceNew), reread: Boolean(body.reread) })).digest("hex");
      const saved = store.read().pageRequests[requestId];
      if (saved) {
        if (saved.fingerprint !== fingerprint) throw issue("INVALID_REQUEST", "同一读取请求不能替换为另一个页面或操作。");
        return pageResponse({ conversationId: saved.conversationId, replayed: true, created: false }, requestId);
      }
      const pendingRead = pageOpenRequests.get(requestId);
      if (pendingRead) {
        if (pendingRead.fingerprint !== fingerprint) throw issue("INVALID_REQUEST", "同一读取请求不能替换为另一个页面或操作。");
        return pendingRead.promise;
      }
      const promise = (async () => {
        const existing = resolvePageSession(store.read(), context, { at: clock() });
        let read;
        if (existing.status === "active" && !body.forceNew && !body.reread) read = { readable: true, context: storedPageSource(store.read(), existing.conversationId) };
        else read = await readPageWithTimeout({ context, requestId });
        if (!read.readable) return { ...read, state: publicState(), created: false };
        if (stopping) throw issue("SERVICE_STOPPING", "本地服务正在退出，页面未建立会话。", 503);
        let accepted;
        await store.update(draft => {
          accepted = acceptPageSession(draft, { context: read.context, requestId, fingerprint, forceNew: body.forceNew, reread: body.reread, at: clock() });
          refreshConversationMemory(draft, accepted.conversationId);
        });
        return { ...pageResponse(accepted, requestId), readable: true };
      })();
      pageOpenRequests.set(requestId, { fingerprint, promise });
      try { return await promise; } finally { pageOpenRequests.delete(requestId); }
    },
    async selectSurface(body) {
      await store.update(draft => updateSurfaceSession(draft, { ...body, at: clock() }));
      return { state: publicState() };
    },
    memories() { return { memories: publicMemories(store.read()) }; },
    conversationMemory(body) {
      const state = store.read();
      const conversation = conversationFor(state, text(body?.conversationId, "对话编号", 150));
      return { conversationId: conversation.id, workingMemory: conversation.workingMemory || null,
        memories: publicMemories(state).filter(entry => entry.sourceConversationId === conversation.id) };
    },
    async updateMemory(body) {
      const action = text(body?.action, "记忆操作", 20);
      await store.update(draft => {
        const memoryId = text(body.memoryId, "记忆编号", 150);
        const existing = draft.memory.entries.find(entry => entry.id === memoryId);
        if (!existing) throw issue("NOT_FOUND", "没有找到这条记忆。", 404);
        if (body.expectedVersion !== undefined && body.expectedVersion !== existing.version) throw issue("MEMORY_CHANGED", "这条记忆已更新，请刷新后再修改。", 409);
        if (action === "forget") forgetPreference(draft, { memoryId });
        else if (action === "replace") {
          forgetPreference(draft, { memoryId });
          rememberPreference(draft, { content: text(body.content, "记忆内容", 1000) });
        } else throw issue("INVALID_REQUEST", "记忆操作不受支持。");
      });
      return { state: publicState() };
    },
    async knowledgeSearch(body) {
      const query = text(body?.query, "搜索内容", 2000);
      const limit = body.limit ?? 6;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw issue("INVALID_REQUEST", "搜索数量须在 1 到 20 之间。");
      return knowledge.search({ query, limit });
    },
    async knowledgeRead(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      if (!store.read().collections.some(item => item.id === collectionId)) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
      const offset = body.offset ?? 0, limit = body.limit ?? 4000;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000) throw issue("INVALID_REQUEST", "原文阅读范围不正确。");
      const documentVersionId = body.documentVersionId === undefined ? undefined : text(body.documentVersionId, "原文版本", 200);
      try { return { document: await knowledge.readDocument({ collectionId, documentVersionId, offset, limit }) }; }
      catch (error) {
        if (error.code === "NOT_FOUND") throw issue("NOT_FOUND", "没有找到这条收藏的原文版本。", 404);
        throw error;
      }
    },
    async readingArticle(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      if (body.mode !== undefined && !readingModes.includes(body.mode)) throw issue("INVALID_REQUEST", "阅读方式不正确。");
      const collection = store.read().collections.find(item => item.id === collectionId);
      if (!collection) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
      const documentVersionId = body.documentVersionId === undefined ? undefined : text(body.documentVersionId, "原文版本", 200);
      const source = await loadReadingSource(knowledge, collection, documentVersionId);
      if (collection.editorial) source.editorial = structuredClone(collection.editorial);
      const state = store.read();
      const sameSource = item => item.collectionId === collectionId && item.documentVersionId === source.documentVersionId;
      const currentResults = state.reading.results.filter(item => sameSource(item) && item.contentHash === source.contentHash);
      const understanding = currentResults.findLast(item => item.mode === "understanding" && item.promptVersion === readingPromptVersion(item.mode))?.understanding || null;
      const results = currentResults.filter(item => item.mode !== "understanding"
        && (item.mode !== "plain" || item.promptVersion === readingPromptVersion(item.mode)));
      const jobs = state.jobs.filter(item => item.type === "reading" && sameSource(item));
      const understandingJob = jobs.findLast(item => item.readingMode === "understanding");
      const job = body.mode === "understanding" ? understandingJob : jobs.findLast(item => body.mode ? item.readingMode === body.mode : item.readingMode !== "understanding");
      const current = state.collections.find(item => item.id === collectionId);
      const canGenerateUnderstanding = Boolean(aiEnabled && current && !current.pendingPageCapture && understandingSourceAvailable(source));
      return { article: { ...source, results, understanding, canGenerateUnderstanding }, preferences: structuredClone(state.reading.preferences),
        ...(job ? { job: publicJob(job) } : {}), ...(understandingJob ? { understandingJob: publicJob(understandingJob) } : {}) };
    },
    async readingPreferences(body = {}) {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw issue("INVALID_REQUEST", "阅读偏好格式不正确。");
      if (!["defaultMode", "curationMode", "customPrompt", "fontSize", "readingWidth", "expectedVersion"].some(key => body[key] !== undefined)) return { preferences: structuredClone(store.read().reading.preferences) };
      let preferences;
      await store.update(draft => { preferences = updateReadingPreferences(draft, body); });
      return { preferences };
    },
    async readingGenerate(body) {
      if (stopping) throw issue("SERVICE_STOPPING", "本地服务正在退出，请稍后重试。", 503);
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      const requestId = text(body.requestId, "阅读请求编号", 150);
      if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw issue("INVALID_REQUEST", "请求编号格式不正确。");
      const mode = body.mode;
      if (!readingModes.includes(mode)) throw issue("INVALID_REQUEST", "阅读方式不正确。");
      const prompt = text(body.prompt, "阅读要求", 2000, true), question = text(body.question, "阅读问题", 2000, true);
      if (mode === "custom" && !prompt) throw issue("INVALID_REQUEST", "请写下希望怎样阅读这篇文章。");
      if (mode === "question" && !question) throw issue("INVALID_REQUEST", "请写下想了解的问题。");
      if (mode === "understanding" && (prompt || question)) throw issue("INVALID_REQUEST", "收藏解读仅使用已保存的原文。");
      const collection = store.read().collections.find(item => item.id === collectionId);
      if (!collection) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
      const requestedVersion = body.documentVersionId === undefined ? undefined : text(body.documentVersionId, "原文版本", 200);
      const source = await loadReadingSource(knowledge, collection, requestedVersion);
      if (!source.documentVersionId || !source.paragraphs.length) throw issue("READING_SOURCE_UNAVAILABLE", "这条收藏暂时没有可供阅读的原文，请先重新读取来源。", 409);
      if (!source.active) throw issue("SOURCE_CHANGED", "原文已更新，请基于当前原文重新生成。", 409);
      if (mode === "understanding" && !understandingSourceAvailable(source)) throw issue("READING_SOURCE_UNAVAILABLE", "这条收藏暂时没有可供解读的原文。", 409);
      const input = { collectionId, requestId, mode, prompt, question, documentVersionId: source.documentVersionId, contentHash: source.contentHash, sourceRevision: source.sourceRevision };
      input.fingerprint = readingFingerprint(input);
      let job;
      await store.update(draft => {
        const existing = draft.jobs.findLast(item => item.type === "reading" && item.readingInput?.requestId === requestId);
        if (existing) {
          if (existing.readingInput.fingerprint !== input.fingerprint) throw issue("REQUEST_CONFLICT", "这个阅读请求编号已用于不同的内容。", 409);
          job = existing; return;
        }
        if (!aiEnabled) throw issue("AI_DISABLED", "智能功能尚未配置，仍可阅读已保存的原文。", 503);
        const liveCollection = draft.collections.find(item => item.id === collectionId);
        if (!liveCollection || (liveCollection.sourceRevision || 1) !== source.sourceRevision
          || (mode === "understanding" && liveCollection.pendingPageCapture)) throw issue("SOURCE_CHANGED", "原文已更新，请重新打开后生成。", 409);
        if (draft.jobs.some(item => item.type === "reading" && item.collectionId === collectionId && ["queued", "running"].includes(item.status))) throw issue("JOB_RUNNING", "这篇文章正在生成阅读内容，可以先停止再切换。", 409);
        job = { id: id("job"), type: "reading", status: "queued", collectionId, readingMode: mode, documentVersionId: source.documentVersionId, readingInput: input, createdAt: now(), updatedAt: now() };
        appendJob(draft, job);
      });
      if (job.status === "queued") schedule(job.id);
      return { job: publicJob(job) };
    },
    async readingCancel(body) {
      const jobId = text(body?.jobId, "阅读任务编号", 150);
      let job;
      await store.update(draft => {
        job = draft.jobs.find(item => item.id === jobId && item.type === "reading");
        if (!job) throw issue("NOT_FOUND", "没有找到这次阅读任务。", 404);
        if (["queued", "running"].includes(job.status)) Object.assign(job, { status: "failed", errorCode: "READING_CANCELLED", error: "已停止这次阅读生成。", updatedAt: now() });
      });
      if (job.errorCode === "READING_CANCELLED") readingControllers.get(jobId)?.abort(issue("READING_CANCELLED", "已停止这次阅读生成。", 409));
      return { job: publicJob(job) };
    },
    async knowledgeSimilar(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      if (!store.read().collections.some(item => item.id === collectionId)) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
      const limit = body.limit ?? 5, aspect = text(body.aspect, "相似线索", 100, true);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw issue("INVALID_REQUEST", "相似文章数量须在 1 到 20 之间。");
      try {
        const similar = await knowledge.findSimilar({ collectionId, limit, aspect });
        if (!autoCurate || aspect) return similar;
        const curation = await localCuration.related(collectionId).catch(() => null);
        if (!curation) return similar;
        const retrieved = new Map(similar.items.map(item => [item.collectionId, item]));
        const ranked = curation.related.map(item => {
          const hit = retrieved.get(item.collectionId);
          const current = hit?.documentVersionId === item.documentVersionId ? hit : item;
          return { ...current, matchReasons:["主题线索相近，可对照原文"] };
        });
        const items = ranked.length ? ranked.slice(0, limit) : similar.items;
        return { ...similar, items, curation:{ status:curation.status, topicId:curation.topicId, title:curation.title } };
      }
      catch (error) {
        if (error.code === "KNOWLEDGE_SOURCE_UNAVAILABLE") throw issue(error.code, "这条收藏还没有可供比较的原文。可以先阅读或重新读取来源。", 409);
        throw error;
      }
    },
    async curationRelated(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      if (!store.read().collections.some(item => item.id === collectionId)) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
      return localCuration.related(collectionId);
    },
    async knowledgeConnections(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      if (!store.read().collections.some(item => item.id === collectionId)) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
      const limit = body.limit ?? 8;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw issue("INVALID_REQUEST", "关联文章数量须在 1 到 20 之间。");
      return knowledge.getConnections({ collectionId, limit });
    },
    async createConversation(body = {}) {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw issue("INVALID_REQUEST", "请提交对话信息。");
      const title = body.title === undefined ? undefined : text(body.title, "对话标题", 80);
      let conversationId;
      await store.update(draft => {
        const current = conversationFor(draft);
        const reusable = title === undefined && current.titleSource === "automatic" && !draft.messages.some(entry => entry.conversationId === current.id) && !draft.jobs.some(entry => entry.conversationId === current.id);
        if (reusable) conversationId = current.id;
        else {
          const conversation = { id: id("conversation"), title: title || "新的对话", titleSource: title ? "manual" : "automatic", createdAt: now(), updatedAt: now() };
          draft.conversations.push(conversation); conversationId = conversation.id;
        }
        draft.activeConversationId = conversationId;
      });
      const state = publicState();
      return { conversation: state.conversations.find(entry => entry.id === conversationId), state };
    },
    async selectConversation(body) {
      const requested = text(body?.conversationId, "对话编号", 150);
      await store.update(draft => { draft.activeConversationId = conversationFor(draft, requested).id; });
      const state = publicState();
      return { conversation: state.conversations.find(entry => entry.id === requested), state };
    },
    async workspace(body) {
      await store.update((draft) => {
        applyWorkspacePatch(draft, body);
        const touched = new Set(body.ops.filter((op) => op.field === "feedback" && op.key.startsWith("understanding:")).map((op) => op.key));
        for (const key of touched) {
          if (!["pending_rewrite", "confirmed_edited"].includes(draft.workspace.feedback[key]?.decision)) continue;
          const collectionId = key.slice("understanding:".length);
          const collection = draft.collections.find((item) => item.id === collectionId);
          if (!collection) continue;
          const sourceIds = new Set([collection.sourceResult?.id, collection.extraction?.collectionId,
            ...(collection.sourceHistory || []).flatMap((entry) => [entry.sourceResult?.id, entry.extraction?.collectionId])].filter(Boolean));
          for (const exhibition of draft.exhibitions) {
            if (!exhibition.collectionIds?.includes(collectionId) && !exhibition.sourceCollectionIds?.some((sourceId) => sourceIds.has(sourceId))) continue;
            // Human source review is separate from the signed AI evaluation.
            // Keep this warning even if the feedback is later removed: only a
            // new review or newly generated exhibition can establish confidence.
            exhibition.sourceReviewPending = true;
            exhibition.sourceReviewCollectionIds = [...new Set([...(exhibition.sourceReviewCollectionIds || []), collectionId])];
            exhibition.sourceReviewPendingAt ||= now();
          }
        }
      });
      await knowledge.sync();
      return { state: publicState() };
    },
    async capture(body) {
      if (!body || !["text", "link", "image"].includes(body.mode)) throw issue("INVALID_REQUEST", "请选择网页、文字或图片。");
      const input = { mode: body.mode, title: text(body.title, "标题", 200, true) };
      if (body.mode === "image") {
        if (typeof body.image !== "string" || body.image.length > 2_500_000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.image)) throw issue("INVALID_REQUEST", "暂时无法读取这张图片，请换一张体积较小、格式受支持的图片。");
        input.image = body.image;
        input.content = "";
      } else {
        input.content = text(body.content, "收藏内容", 60000);
        if (body.mode === "link") input.content = validURL(input.content).href;
      }
      let item, job, duplicate;
      await store.update((draft) => {
        if (input.mode === "link") {
          const key = sourceURLKey(input.content);
          const isVideoLink = youtubePreview(input.content);
          item = key && draft.collections.find(entry => (isVideoLink || !entry.input?.videoCaptions)
            && (sourceURLKey(entry.url) === key || (entry.input?.mode === "link" && sourceURLKey(entry.input.content) === key)));
          if (item) { duplicate = true; return; }
        }
        const conversationId = conversationFor(draft, body.conversationId).id;
        item = { id: id("collection"), ...initialCollection(input), content: input.content, input, status: aiEnabled ? "processing" : "saved", ...(input.mode === "link" ? { sourceSaveStatus: "unavailable" } : {}), createdAt: now(), addedAt: now(), updatedAt: now() };
        draft.collections.push(item);
        if (aiEnabled) {
          job = { id: id("job"), type: "ingest", status: "queued", collectionId: item.id, createdAt: now(), updatedAt: now() };
          appendJob(draft, job, conversationId);
        }
        appendMessage(draft, message("assistant", input.mode === "link" ? linkSaveReply(1, aiEnabled)
          : aiEnabled ? `《${item.title}》已收下，会在后台整理。` : `《${item.title}》已保存在这台电脑；连接整理服务后可以重试。`, { collectionIds: [item.id] }), conversationId);
      });
      if (duplicate) return { state: publicState(), collectionId: item.id, duplicate: true };
      await preserveTextInputs([item.id]);
      const response = { state: publicState(), collectionId: item.id, job: job ? publicJob(job) : undefined };
      if (job) schedule(job.id);
      else scheduleSavedPresentation(item.id, input);
      return response;
    },
    async revise(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      const correction = text(body?.correction, "修改说明", 5000);
      let job;
      await store.update((draft) => {
        const conversationId = conversationFor(draft, body.conversationId).id;
        const item = draft.collections.find((entry) => entry.id === collectionId);
        if (!item) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
        if (!aiEnabled) throw issue("AI_DISABLED", "智能功能尚未配置，原始收藏会保留。", 503);
        if (!item.receipt) throw issue("NEEDS_INPUT", "请先完成原始收藏的整理，再修改理解。", 409);
        if (item.pendingPageCapture) throw issue("PAGE_SAVE_PENDING", "这条收藏正在保存原文，请稍后重试。", 409);
        if (draft.jobs.some((entry) => entry.collectionId === collectionId && ["queued", "running"].includes(entry.status))) throw issue("JOB_RUNNING", "这条收藏仍在处理中。", 409);
        item.status = "processing"; item.updatedAt = now(); item.error = null;
        job = { id: id("job"), type: "revise", collectionId, correction, baseReceipt: item.receipt, status: "queued", createdAt: now(), updatedAt: now() };
        appendJob(draft, job, conversationId);
      });
      const response = { state: publicState(), job: publicJob(job) };
      schedule(job.id);
      return response;
    },
    async refreshSource(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      let job;
      await store.update((draft) => {
        const conversationId = conversationFor(draft, body.conversationId).id;
        const item = draft.collections.find((entry) => entry.id === collectionId);
        if (!item) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
        if (!aiEnabled && !item.input?.videoCaptions) throw issue("AI_DISABLED", "智能功能尚未配置，原始收藏会保留。", 503);
        if (item.input?.mode !== "link") throw issue("SOURCE_REFRESH_NOT_SUPPORTED", "只有网页收藏可以重新读取原文。", 409);
        if (item.pendingPageCapture) throw issue("PAGE_SAVE_PENDING", "这条收藏正在保存原文，请稍后重试。", 409);
        if (draft.jobs.some((entry) => entry.collectionId === collectionId && ["queued", "running"].includes(entry.status))) throw issue("JOB_RUNNING", "这条收藏仍在处理中。", 409);
        const sourceInput = { ...structuredClone(item.input), content: validURL(item.input.content).href };
        const sourceRevision = item.sourceRevision || 1;
        const history = item.sourceHistory ||= [];
        // The archive belongs to a source version, not to each retry attempt.
        // Snapshot before any external read so failure cannot erase old evidence.
        if (!history.some((entry) => entry.sourceRevision === sourceRevision && entry.receipt === item.receipt)) {
          const fields = ["input", "receipt", "extraction", "sourceResult", "title", "url", "source", "type", "content", "summary", "status", "thumbnail"];
          history.push({ ...Object.fromEntries(fields.filter((key) => item[key] !== undefined).map((key) => [key, structuredClone(item[key])])), sourceRevision, createdAt: now() });
        }
        item.sourceHistory = history.slice(-3);
        Object.assign(item, { sourceRevision, status: "processing", error: null, updatedAt: now() });
        job = { id: id("job"), type: "ingest", sourceRefresh: true, sourceInput, baseSourceRevision: sourceRevision, targetSourceRevision: sourceRevision + 1, collectionId, status: "queued", createdAt: now(), updatedAt: now() };
        appendJob(draft, job, conversationId);
        appendMessage(draft, message("assistant", `开始重新读取《${item.title}》的${item.input.videoCaptions ? "视频字幕" : "网页原文"}，旧版来源和理解会保留。`, { jobId: job.id, collectionIds: [collectionId] }));
      });
      const response = { state: publicState(), job: publicJob(job) };
      schedule(job.id);
      return response;
    },
    async profile(body) {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw issue("INVALID_REQUEST", "请提交策展人设置。");
      const profile = {
        name: currentCompanionName(text(body.name, "名字", 60)),
        personality: text(body.personality, "性格", 1000, true),
        preferences: text(body.preferences, "偏好", 5000, true),
      };
      await store.update((draft) => { replacePreferences(draft, { content: profile.preferences }); draft.profile = { ...profile, preferences: draft.profile.preferences }; });
      return { state: publicState() };
    },
    async send(body) {
      const value = text(body?.text, "消息", 60000);
      const requestId = body.requestId === undefined ? undefined : text(body.requestId, "请求编号", 100);
      if (requestId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw issue("INVALID_REQUEST", "请求编号格式不正确。");
      let clientDraftId;
      if (body.newConversation !== undefined) {
        if (!body.newConversation || typeof body.newConversation !== "object" || Array.isArray(body.newConversation) || body.conversationId !== undefined || !requestId) throw issue("INVALID_REQUEST", "新对话需要独立草稿和请求编号，不能同时指定已有对话。");
        clientDraftId = text(body.newConversation.clientDraftId, "草稿编号", 100);
        if (!/^[a-zA-Z0-9_-]+$/.test(clientDraftId)) throw issue("INVALID_REQUEST", "草稿编号格式不正确。");
      }
      let context = pageContext(body?.context);
      const submittedContext = structuredClone(context);
      const previewId = body.previewId;
      let preview;
      if (previewId !== undefined) {
        if (body.intent !== "collect-page" || typeof previewId !== "string" || !/^page-[a-f0-9]{32}$/.test(previewId)
          || !context?.url || context.text || context.selection || context.snapshotId) throw issue("INVALID_REQUEST", "正文预览收藏请求不正确。");
        preview = publicPreviews.get(previewId);
        if (!preview || preview.snapshot.url !== context.url || preview.expiresAt <= Date.now()) {
          throw issue("PAGE_PREVIEW_EXPIRED", "正文预览已失效，请重新预览后再收藏。", 409);
        }
        context = structuredClone(preview.snapshot);
      }
      const hasWorkspaceSelection = body.collectionIds !== undefined || body.exhibitionId !== undefined;
      if (body.intent !== undefined && !["chat", "collect-page"].includes(body.intent)) throw issue("INVALID_REQUEST", "消息意图不受支持。");
      if (hasWorkspaceSelection && body.intent === "collect-page") throw issue("INVALID_REQUEST", "收藏讨论不能同时作为收藏页面请求。");
      if (body.intent === "collect-page" && !context?.url) throw issue("NEEDS_CONTEXT", "我还没有拿到当前页面。请先关联要收藏的页面。");
      const memoryCommand = /^(?:请帮我|帮我|请)?\s*(记住|忘记)[\s:：，,]*(.+)$/u.exec(value);
      const selectedCuration = !memoryCommand && body.intent !== "collect-page" && parseScopedCurationCommand(value, hasWorkspaceSelection);
      const selectionRequest = workspaceRequest(body, selectedCuration ? 12 : 6);
      const curationCommand = !memoryCommand && !selectedCuration && isCurationCommand(value);
      const videoURL = body.intent === undefined && !hasWorkspaceSelection && parseVideoCaptureCommand(value);
      const webSearch = !memoryCommand && !selectedCuration && !curationCommand && !videoURL && body.intent !== "collect-page" && parseWebSearchRequest(value);
      const captures = memoryCommand || selectedCuration || curationCommand || webSearch || body.intent === "chat" || hasWorkspaceSelection ? []
        : videoURL ? [{ mode: "link", content: validURL(videoURL).href, title: "", videoCaptions: true }]
        : body.intent === "collect-page" ? [{ mode: "link", content: context.url, title: context.title || "" }] : captureFrom(value, context);
      const collectingPage = context?.url && captures.length === 1 && captures[0].mode === "link" && captures[0].content === context.url && (body.intent === "collect-page" || !/https?:\/\//i.test(value));
      const jobs = [];
      const savedPresentations = [];
      let reply, conversationId, pageSave, replayed = false;
      const requestFingerprint = requestId && createHash("sha256").update(JSON.stringify({ text: value, intent: body.intent ?? null, context: submittedContext ?? null, ...(previewId ? { previewId } : {}),
        collectionIds: selectionRequest.collectionIds === undefined ? null : [...selectionRequest.collectionIds].sort(), exhibitionId: selectionRequest.exhibitionId ?? null })).digest("hex");
      await store.update((draft) => {
        let conversation;
        if (clientDraftId) {
          const firstTurns = draft.firstTurnRequests ||= {};
          const accepted = firstTurns[clientDraftId];
          if (accepted) {
            if (accepted.requestId !== requestId || accepted.fingerprint !== requestFingerprint) throw issue("INVALID_REQUEST", "这份草稿已建立对话，请在原对话中继续。");
            conversation = conversationFor(draft, accepted.conversationId);
          } else {
            conversation = { id: id("conversation"), title: "新的对话", titleSource: "automatic", originSurface: body.originSurface || "workspace", createdAt: now(), updatedAt: now() };
            draft.conversations.push(conversation);
            firstTurns[clientDraftId] = { requestId, fingerprint: requestFingerprint, conversationId: conversation.id };
          }
        } else conversation = conversationFor(draft, body.conversationId);
        conversationId = conversation.id;
        const previous = requestId && draft.messages.find(entry => entry.role === "user" && entry.conversationId === conversationId && entry.requestId === requestId);
        if (previous) {
          if (previous.requestFingerprint !== requestFingerprint) throw issue("INVALID_REQUEST", "同一请求不能替换为不同的消息或引用，请重新发送。");
          const jobIds = new Set(draft.jobs.filter(job => job.messageId === previous.id).map(job => job.id));
          reply = draft.messages.findLast(entry => entry.role === "assistant" && (entry.sourceMessageId === previous.id || jobIds.has(entry.jobId))) || null;
          if (!reply && collectingPage) {
            const waiting = draft.collections.find(item => item.pendingPageCapture?.messageIds.includes(previous.id));
            if (waiting) pageSave = { collectionId: waiting.id, messageId: previous.id };
          }
          replayed = true; return;
        }
        // A page conversation owns its accepted snapshot. Browser navigation is
        // metadata until the person explicitly adopts a different page session.
        if (selectedCuration || videoURL || webSearch) context = undefined;
        else if (!preview && conversation.pageSource && !hasWorkspaceSelection) {
          if (context?.url && pageIdentity(context).key !== conversation.pageSession.pageKey) throw issue("PAGE_SESSION_MISMATCH", "这条消息仍属于之前的页面，请先切换对话再聊当前页。", 409);
          const accepted = structuredClone(conversation.pageSource);
          if (collectingPage && context?.snapshotId && context.snapshotId !== accepted.snapshotId) throw issue("PAGE_SOURCE_CHANGED", "这页已重新读取，请确认当前内容后再收藏。", 409);
          context = { ...accepted, originalContentSource: accepted.contentSource, contentSource: "stored-page-snapshot" };
        } else if (!preview && collectingPage && context?.snapshotId) throw issue("PAGE_SESSION_MISMATCH", "没有找到这次读取的页面，请重新读取后收藏。", 409);
        const workspace = webSearch ? null : workspaceSelection(selectionRequest, draft, Boolean(selectedCuration));
        const chosen = selectedCuration && scopedCurationSelection(selectedCuration, workspace, draft.collections);
        const workspaceContext = chosen
          ? (chosen.ids.length ? { collectionIds: chosen.ids } : null)
          : workspace;
        draft.activeConversationId = conversationId;
        if (body.originSurface === "companion" || body.originSurface === "workspace") updateSurfaceSession(draft, { surface: body.originSurface, conversationId, at: clock() });
        const userMessage = message("user", value, { conversationId, ...(requestId ? { requestId, requestFingerprint } : {}), ...(context ? { context } : {}), ...(workspaceContext ? { workspaceContext } : {}) });
        appendMessage(draft, userMessage, conversationId);
        if (memoryCommand) {
          const entry = text(memoryCommand[2], "偏好内容", 1000);
          if (memoryCommand[1] === "记住") {
            const saved = rememberPreference(draft, { content: entry, conversationId, sourceMessageId: userMessage.id });
            reply = message("assistant", `已记在这台电脑的偏好设定里：${entry}`, { memoryId: saved.id });
          } else {
            const forgotten = forgetPreference(draft, { content: entry });
            reply = message("assistant", forgotten.revokedIds.length ? `已从偏好设定中移除与“${entry}”有关的记录。` : `偏好设定里没有找到“${entry}”。你可以在设定中查看或修改。`);
          }
          reply.sourceMessageId = userMessage.id;
          appendMessage(draft, reply, conversationId);
        } else if (selectedCuration) {
          const clarification = curationSelectionPrompt(selectedCuration, chosen);
          if (clarification) {
            reply = appendMessage(draft, message("assistant", clarification, { sourceMessageId: userMessage.id }), conversationId);
          } else {
            const job = { id: id("job"), type: "curate-selected", status: "queued", messageId: userMessage.id,
              collectionIds: chosen.ids, curationQuestion: selectedCuration.question, createdAt: now(), updatedAt: now() };
            appendJob(draft, job, conversationId);
            jobs.push(job.id);
            reply = appendMessage(draft, message("assistant", `我会用你指定的 ${chosen.ids.length} 条收藏整理。`, { jobId: job.id, sourceMessageId: userMessage.id }), conversationId);
          }
        } else if (curationCommand) {
          const job = queueCuration(draft, conversationId);
          job.messageId = userMessage.id;
          jobs.push(job.id);
          reply = draft.messages.at(-1);
          reply.sourceMessageId = userMessage.id;
        } else if (collectingPage && (preview || conversation.pageSource) && acceptedPageCapture(context)) {
          const source = acceptedPageCapture(context);
          const fingerprint = pageCaptureFingerprint(source);
          const input = { mode: "link", content: context.url, title: source.title || context.title || "" };
          const urlKeys = new Set([sourceURLKey(input.content), sourceURLKey(source.url)]);
          let item = draft.collections.find(entry => !entry.input?.videoCaptions && (urlKeys.has(sourceURLKey(entry.url)) || (entry.input?.mode === "link" && urlKeys.has(sourceURLKey(entry.input.content)))));
          if (!item) {
            item = { id: id("collection"), ...initialCollection(input), content: input.content, input, status: "saved", createdAt: now(), addedAt: now(), updatedAt: now() };
            draft.collections.push(item);
          }
          if (!item.pendingPageCapture && item.savedPageFingerprint === fingerprint && item.knowledgeDocumentVersionId) {
            item.savedPageSnapshotId = context.snapshotId;
            reply = pageSaveReply(userMessage, item.id, item.sourceSaveStatus);
            appendMessage(draft, reply, conversationId);
          } else {
            if (item.pendingPageCapture?.fingerprint !== fingerprint && (item.pendingPageCapture || draft.jobs.some(job => job.collectionId === item.id && ["ingest", "revise"].includes(job.type) && ["queued", "running"].includes(job.status)))) {
              throw issue("PAGE_SAVE_PENDING", "这条收藏正在处理另一版原文，请稍后重试。", 409);
            }
            item.pendingPageCapture ||= { id: id("page-capture"), messageIds: [], fingerprint };
            item.pendingPageCapture.messageIds.push(userMessage.id);
            if (!item.knowledgeDocumentVersionId) item.sourceSaveStatus = "pending";
            pageSave = { collectionId: item.id, messageId: userMessage.id };
          }
        } else if (captures.length) {
          const collectionIds = [];
          let added = 0;
          for (const input of captures) {
            const urlKey = input.mode === "link" && sourceURLKey(input.content);
            const isVideoLink = urlKey && !collectingPage && youtubePreview(input.content);
            const existing = urlKey && draft.collections.find(item => (input.videoCaptions ? item.input?.videoCaptions : isVideoLink || !item.input?.videoCaptions)
              && (sourceURLKey(item.url) === urlKey || (item.input?.mode === "link" && sourceURLKey(item.input.content) === urlKey)));
            const collectionId = existing?.id || id("collection");
            if (!collectionIds.includes(collectionId)) collectionIds.push(collectionId);
            if (!existing) {
              draft.collections.push({ id: collectionId, ...initialCollection(input), content: input.content, input, status: aiEnabled || input.videoCaptions ? "processing" : "saved", ...(input.mode === "link" ? { sourceSaveStatus: "unavailable" } : {}), createdAt: now(), addedAt: now(), updatedAt: now() });
              added += 1;
            } else if (!input.videoCaptions || existing.status !== "failed" || existing.sourceSaveStatus === "complete"
                || draft.jobs.some(job => job.collectionId === collectionId && ["queued", "running"].includes(job.status))) continue;
            else Object.assign(existing, { status: "processing", error: null, updatedAt: now() });
            if (aiEnabled || input.videoCaptions) {
              const job = { id: id("job"), type: "ingest", status: "queued", collectionId, messageId: userMessage.id, createdAt: now(), updatedAt: now() };
              appendJob(draft, job, conversationId); jobs.push(job.id);
            } else if (input.mode === "link") savedPresentations.push([collectionId, input]);
          }
          if (videoURL) {
            const saved = draft.collections.find(item => item.id === collectionIds[0]);
            const replyText = jobs.length ? "已收藏链接，正在读取 YouTube 字幕。" : saved.sourceSaveStatus === "complete"
              ? "这段视频的字幕已保存在 Folio。" : "这段视频的字幕正在读取。";
            reply = message("assistant", replyText, { collectionIds });
          } else if (collectingPage) {
            reply = added ? pageSaveReply(userMessage, collectionIds[0], "unavailable", aiEnabled)
              : message("assistant", "这页已经在收藏里了，可以继续围绕它讨论。", { collectionIds });
          } else {
            const replyText = !added ? (collectionIds.length > 1 ? "这些链接已经收藏过了。" : "这条链接已经收藏过了。")
              : captures.every(input => input.mode === "link") ? linkSaveReply(added, aiEnabled)
              : aiEnabled ? "已收下了，我会在后台整理。你可以继续说。"
              : "已保存在这台电脑。智能功能尚未配置，原始内容会保留，连接整理服务后可点重试。";
            reply = message("assistant", replyText, { collectionIds });
          }
          reply.sourceMessageId = userMessage.id;
          appendMessage(draft, reply, conversationId);
        } else if (webSearch) {
          const validQuery = validateWebSearchQuery(webSearch);
          if (!validQuery || !searchWeb) {
            const feedback = validQuery ? webSearchUnavailable : "请发一下要搜索的主题，最多 300 字。";
            reply = appendMessage(draft, message("assistant", feedback, { sourceMessageId: userMessage.id }), conversationId);
          } else {
            const job = { id: id("job"), type: "chat", status: "queued", messageId: userMessage.id,
              webSearch: { request: webSearch, requestedAt: Number(clock()) }, createdAt: now(), updatedAt: now() };
            appendJob(draft, job, conversationId);
            jobs.push(job.id);
            reply = null;
          }
        } else if (aiEnabled) {
          const job = { id: id("job"), type: "chat", status: "queued", messageId: userMessage.id, profileSnapshot: structuredClone(draft.profile), memorySnapshot: snapshotMemory(draft), createdAt: now(), updatedAt: now() };
          appendJob(draft, job, conversationId); jobs.push(job.id);
          reply = null;
        } else {
          if (context) context.readStatus = "not_read";
          let replyText;
          if (demoLibrary) {
            replyText = "当前是演示模式。你可以收藏链接或文字，智能对话请使用 Folio 的个人模式。";
          } else if (context) {
            replyText = "页面仍然关联着，这次对话没有新增收藏。智能功能尚未配置，我暂时不能阅读并讨论页面内容；连接整理服务后可以继续。你仍可以明确说“收藏这个页面”来保存链接。";
          } else {
            replyText = "这条消息已记在本机对话中。智能功能尚未配置，我现在可以保存链接或“收藏：正文”，也可以用“记住：偏好”保存设定；暂时不能进行智能对话或生成展览。";
          }
          reply = message("assistant", replyText, pageSource(userMessage));
          appendMessage(draft, reply, conversationId);
        }
      });
      if (pageSave) {
        try { await persistAcceptedPage(pageSave.collectionId); }
        catch (error) {
          if (error.statusCode) throw error;
          throw issue("PAGE_SAVE_FAILED", "网页链接已保留，正文还没写入知识库，请再次收藏以重试。", 503);
        }
        reply = store.read().messages.findLast(item => item.role === "assistant" && item.sourceMessageId === pageSave.messageId);
        if (!reply) throw issue("PAGE_SAVE_FAILED", "正文还没有保存，请重新收藏。", 503);
      } else if (reply?.collectionIds?.length) await preserveTextInputs(reply.collectionIds);
      const response = { state: publicState(), message: reply, conversationId, ...(replayed ? { replayed: true } : {}) };
      jobs.forEach(schedule);
      for (const [collectionId, input] of savedPresentations) scheduleSavedPresentation(collectionId, input);
      return response;
    },
    async note(body) {
      const exhibitionId = text(body?.exhibitionId, "展览编号", 150);
      const value = text(body?.text, "想法", 10000, true);
      await store.update((draft) => {
        const exhibition = draft.exhibitions.find((item) => item.id === exhibitionId);
        if (!exhibition) throw issue("NOT_FOUND", "没有找到这场展览，请刷新后重试。", 404);
        exhibition.note = value;
        exhibition.noteUpdatedAt = now();
        const workspace = draft.workspace ||= emptyWorkspace();
        const recordId = `record-${exhibition.id}`;
        const recordIndex = workspace.exhibitionRecords.findIndex((item) => item.id === recordId);
        const previous = recordIndex >= 0 ? workspace.exhibitionRecords[recordIndex] : {};
        const record = { ...previous, id: recordId, exhibitionId: exhibition.id, exhibitionTitle: exhibition.title, content: value, createdAt: previous.createdAt || now(), updatedAt: now(), images: previous.images || [] };
        if (!value) { if (recordIndex >= 0) workspace.exhibitionRecords.splice(recordIndex, 1); }
        else if (recordIndex >= 0) workspace.exhibitionRecords[recordIndex] = record;
        else workspace.exhibitionRecords.unshift(record);
      });
      return { state: publicState() };
    },
    async retry(body) {
      const collectionId = text(body?.collectionId, "收藏编号", 150);
      let newJob;
      await store.update((draft) => {
        const conversationId = conversationFor(draft, body.conversationId).id;
        const item = draft.collections.find((entry) => entry.id === collectionId);
        if (!item) throw issue("NOT_FOUND", "没有找到这条收藏。", 404);
        if (draft.jobs.some((job) => job.collectionId === collectionId && ["queued", "running"].includes(job.status))) throw issue("JOB_RUNNING", "这条收藏仍在处理中。", 409);
        if (item.pendingPageCapture) throw issue("PAGE_SAVE_PENDING", "这条收藏正在保存原文，请稍后重试。", 409);
        if (!aiEnabled && !item.input?.videoCaptions) throw issue("AI_DISABLED", "智能功能尚未配置。原始收藏已保留。", 503);
        const pageVersion = item.savedPageSnapshotId ? item.knowledgeDocumentVersionId : undefined;
        const previous = draft.jobs.findLast((entry) => ["ingest", "revise"].includes(entry.type) && entry.collectionId === collectionId && entry.status === "failed" && (!pageVersion || entry.savedPageDocumentVersionId === pageVersion));
        if (previous) newJob = queueRetry(draft, previous);
        else {
          item.status = "processing"; item.error = null; item.updatedAt = now();
          newJob = { id: id("job"), type: "ingest", status: "queued", collectionId, ...(pageVersion ? { savedPageDocumentVersionId: pageVersion } : {}), createdAt: now(), updatedAt: now() };
          appendJob(draft, newJob, conversationId);
        }
      });
      const response = { state: publicState(), job: publicJob(newJob) };
      if (newJob.status === "queued") schedule(newJob.id);
      return response;
    },
    async retryJob(body) {
      const jobId = text(body?.jobId, "任务编号", 150);
      let job;
      await store.update((draft) => {
        if (body.conversationId !== undefined) conversationFor(draft, body.conversationId);
        const previous = draft.jobs.find((entry) => entry.id === jobId);
        if (!previous) throw issue("NOT_FOUND", "没有找到这项任务。", 404);
        const collection = draft.collections.find(item => item.id === previous.collectionId);
        if (previous.webSearch && !searchWeb) throw issue("WEB_SEARCH_UNAVAILABLE", webSearchUnavailable, 503);
        if (!aiEnabled && !previous.webSearch && previous.type !== "curate-selected" && !(previous.type === "ingest" && collection?.input?.videoCaptions)) throw issue("AI_DISABLED", "智能功能尚未配置，已完成的步骤会保留。", 503);
        job = queueRetry(draft, previous);
      });
      const response = { state: publicState(), job: publicJob(job) };
      if (job.status === "queued") schedule(job.id);
      return response;
    },
    async curate(body = {}) {
      let newJob;
      await store.update((draft) => {
        newJob = queueCuration(draft, conversationFor(draft, body.conversationId).id);
      });
      const response = { state: publicState(), job: publicJob(newJob) };
      schedule(newJob.id);
      return response;
    },
    async idle() {
      let current, selected;
      do {
        current = work; selected = selectedCurationWork;
        await Promise.all([current, selected]);
        await localCuration.idle();
      } while (current !== work || selected !== selectedCurationWork);
      await knowledge.idle();
      await store.flush();
    },
    close() {
      if (closePromise) return closePromise;
      stopping = true;
      localCuration.stop();
      const curationReadingClosing = curationModelReading.close();
      webSearchStop.abort(issue("INTERRUPTED", "联网搜索因 Folio 退出而中断。", 503));
      for (const controller of pageReads) controller.abort(issue("SERVICE_STOPPING", "本地服务正在退出。", 503));
      for (const controller of readingControllers.values()) controller.abort(issue("INTERRUPTED", "阅读生成因本地服务退出而中断。", 503));
      // Abort query/model preparation before waiting on the product queue: a
      // chat may itself be waiting for a local model to load in that queue.
      const knowledgeClosing = knowledge.close();
      closePromise = (async () => {
        await Promise.all([work, selectedCurationWork]);
        await localCuration.idle();
        try { await Promise.all([knowledgeClosing, curationReadingClosing]); }
        finally { await store.flush(); }
      })();
      return closePromise;
    },
  };
}
