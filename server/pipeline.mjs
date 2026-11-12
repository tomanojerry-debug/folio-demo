import { randomUUID, createHash } from "node:crypto";
import { executeCall } from "./ai/ai-service.mjs";
import { loadConfig } from "./ai/config.mjs";
import { safeFetch, htmlText, validURL } from "./safe-fetch.mjs";
import { sign, verify } from "./receipts.mjs";
import { fault } from "./errors.mjs";
import { CURATION_PLAN_MODE, createRoomPlan, assemblePlannedExhibition } from "./curation-plan.mjs";

const string = (v, max = 5000) => typeof v === "string" ? v.slice(0, max) : "";
const array = (v) => Array.isArray(v) ? v : [];
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call", "sensitive", "network_error"]);
function time(ms) { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
export function evidenceFor(text, id, segments) {
  if (segments?.length) return segments.map((segment, index) => ({ evidence_id: `${id}#e${index + 1}`, source_field: "transcript", locator: `${time(segment.start_ms)}–${time(segment.end_ms)}`, text: segment.text }));
  const chunks = [];
  let remaining = text;
  while (remaining.length) {
    let boundary = Math.min(1200, remaining.length);
    if (remaining.length > 1200) {
      // Prefer a paragraph, then a sentence or word boundary. Preserve every
      // source character; these are evidence fragments, not numbered paragraphs.
      const paragraph = remaining.lastIndexOf("\n", 1199) + 1;
      const sentence = [...remaining.slice(0, 1200).matchAll(/[。！？.!?](?:\s|$)/gu)].at(-1);
      const sentenceEnd = sentence ? sentence.index + sentence[0].length : 0;
      const word = remaining.lastIndexOf(" ", 1199) + 1;
      boundary = paragraph >= 600 ? paragraph : sentenceEnd >= 600 ? sentenceEnd : word >= 600 ? word : 1200;
      if (/\p{Surrogate}/u.test(remaining[boundary - 1]) && /[\uD800-\uDBFF]/u.test(remaining[boundary - 1])) boundary--;
    }
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  return chunks.map((content, index) => ({ evidence_id: `${id}#e${index + 1}`, source_field: "body_text", locator: `原文证据片段 ${index + 1}`, text: content }));
}
export async function model(callId, runtimeContext, { signal } = {}) {
  const config = loadConfig({ ...process.env, AI_REQUEST_TIMEOUT_MS: process.env.AI_REQUEST_TIMEOUT_MS || "105000", AI_TEXT_MAX_TOKENS: process.env.AI_TEXT_MAX_TOKENS || "8192" });
  const started = Date.now();
  const result = await executeCall(config, { callId, runtimeContext }, { signal });
  const finishReason = result?.choices?.[0]?.finish_reason;
  const trace = { callId, model: result.model || config.textModel, elapsedMs: Date.now() - started, createdAt: new Date().toISOString(), inputHash: hash(runtimeContext), usage: result.usage || null,
    ...(FINISH_REASONS.has(finishReason) ? { finishReason } : {}) };
  const invalid = () => Object.assign(fault("MODEL_OUTPUT_INVALID", 502), { trace });
  let payload;
  try { payload = JSON.parse(result?.choices?.[0]?.message?.content); } catch { throw invalid(); }
  const output = payload?.answer && typeof payload.answer === "object" ? payload.answer : payload;
  if (!output || Array.isArray(output) || typeof output !== "object") throw invalid();
  return { output, trace: { ...trace, outputHash: hash(output) } };
}
export function platform(raw) {
  const url = validURL(raw);
  const host = url.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) return "youtube";
  if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com") return "xiaohongshu";
  return "generic";
}
export function normalizeExtraction(output, evidence) {
  const ids = new Map(evidence.map((e) => [e.evidence_id, e]));
  let missing = false;
  const refs = (values, required = true) => {
    const list = array(values);
    if (list.some((id) => typeof id !== "string" || !ids.has(id))) throw fault("MODEL_OUTPUT_INVALID", 502);
    if (required && !list.length) missing = true;
    return list;
  };
  const locate = (entry) => refs(entry.evidence_ids).map((id) => ids.get(id).locator).filter((v, i, a) => a.indexOf(v) === i).join(" · ");
  if (output.status !== "candidate") return { status: "needs_input", reliability: 0, hint: string(output.needs_input_suggestion) || "内容不足，请补充正文。", summary: "", digest: { status: "unavailable", highlights: [] }, breakdown: { status: "unavailable", sections: [] } };
  if (!string(output.summary) || !output.digest || !output.breakdown) throw fault("MODEL_OUTPUT_INVALID", 502);
  const summaryEvidence = refs(output.summary_evidence_ids);
  const digestEvidence = refs(output.digest.evidence_ids);
  const digest = { status: string(output.digest.status, 30), overview: string(output.digest.overview), evidence_ids: digestEvidence, highlights: array(output.digest.highlights).slice(0, 3).map((h) => ({ text: string(h.text), locator: locate(h), evidence_ids: array(h.evidence_ids) })) };
  const breakdown = { status: string(output.breakdown.status, 30), reason: string(output.breakdown.reason), sections: array(output.breakdown.sections).slice(0, 20).map((s) => ({ title: string(s.title, 200), locator: locate(s), evidence_ids: array(s.evidence_ids), points: array(s.points).slice(0, 8).map((p) => ({ title: string(p.title, 200), explanation: string(p.explanation), locator: locate(p), evidence_ids: array(p.evidence_ids) })) })) };
  const conceptEvidence = array(output.concepts).slice(0, 12).map(c => ({ value: string(c.value, 100), evidence_ids: refs(c.evidence_ids) })).filter(entry => entry.value);
  const concepts = conceptEvidence.map(entry => entry.value);
  const score = Number(output.content_reliability_score);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw fault("MODEL_OUTPUT_INVALID", 502);
  const reliability = missing ? Math.min(score, 0.74) : score;
  return { status: reliability >= 0.75 ? "qualified" : "needs_confirmation", summary: string(output.summary), summaryEvidence, digest, breakdown, concepts, conceptEvidence, tags: concepts.slice(0, 5), reliability, evidence: summaryEvidence.map((id) => ids.get(id).locator).join(" · "), evidenceBundle: evidence, source: "live_ai", promptVersion: "P-001@1.0.0-demo", hint: missing ? "部分结论缺少证据定位，请先核对原文。" : array(output.uncertainties).map((s) => string(s, 300)).join("；") };
}

export async function ingest(input, deps = {}) {
  if (!input || !["text", "link", "image", "parsed"].includes(input.mode)) throw fault("INVALID_REQUEST");
  const call = deps.model || model;
  const id = `live-${randomUUID()}`;
  let text = string(input.content, 60001), title = string(input.title, 200), url = "", source = "用户提交的文字", type = "user_input", transcriptSource = null, segments;
  let sourcePlatform = "generic";
  if (text.length > 60000) throw fault("CONTENT_TOO_LONG", 413);
  if (input.mode === "link") {
    url = validURL(text).href;
    sourcePlatform = platform(url);
    if (sourcePlatform !== "generic") throw fault("WORKER_NOT_CONFIGURED", 503);
    let page;
    try { page = await (deps.fetch || safeFetch)(url); } catch (error) { throw error.code === "UNSAFE_URL" ? error : fault("FETCH_FAILED", 422); }
    const extracted = /text\/plain/i.test(page.type) ? { text: page.text, title: page.title || "网页收藏" } : htmlText(page.text);
    text = extracted.text; title = extracted.title; url = page.url; source = "网页正文"; type = "article";
    if (text.length > 60000) throw fault("CONTENT_TOO_LONG", 413);
  } else if (input.mode === "image") {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(input.image || "") || input.image.length > 2_500_000) throw fault("INVALID_REQUEST");
    const config = loadConfig();
    const vision = await (deps.vision || executeCall)(config, { callId: "CALL-VISION01", prompt: "只描述图中实际可见的主体、布局、色彩与清晰文字。区分看见的事实与不确定之处，不推断人物身份或用户意图。", imageSource: input.image });
    text = string(vision.content, 30000); title ||= "图片收藏"; source = "图片视觉理解（AI 描述）"; type = "image_note";
  } else if (input.mode === "parsed") {
    // This branch is called only with a server-verified Worker result, never with browser input.
    if (!deps.trustedWorker) throw fault("INVALID_REQUEST");
    url = validURL(input.url).href; sourcePlatform = platform(url); type = input.type === "image_note" ? "image_note" : "video";
    segments = array(input.segments);
    if (segments.some((s) => !Number.isFinite(s.start_ms) || !Number.isFinite(s.end_ms) || s.start_ms < 0 || s.end_ms < s.start_ms || typeof s.text !== "string")) throw fault("MODEL_OUTPUT_INVALID", 502);
    transcriptSource = input.transcriptSource;
    if (type === "video" && (!segments.length || !["platform_auto", "platform_manual", "local_faster_whisper"].includes(transcriptSource))) throw fault("NEEDS_INPUT", 422);
    if (segments.length) text = segments.map((s) => s.text).join("\n");
    else segments = undefined;
    source = transcriptSource === "local_faster_whisper" ? "本地语音转写" : type === "video" ? "平台字幕" : "小红书正文";
  }
  if (text.length < 20) throw fault("NEEDS_INPUT", 422);
  if (text.length > 60000) throw fault("CONTENT_TOO_LONG", 413);
  title ||= text.slice(0, 52);
  const evidence = evidenceFor(text, id, segments);
  // Source persistence is independent of the model result. Consumers can keep
  // the acquired body even when understanding fails or returns needs_input.
  await deps.onSource?.({ title, url, text, sourceKind: input.mode === "image" ? "image_description" : segments ? "transcript" : "body_text", evidence });
  const context = { item_id: id, item_version: 1, source_platform: sourcePlatform, content_type: type === "user_input" ? "text" : type === "article" ? "web" : type, modality: input.mode === "parsed" ? "video_link" : input.mode, parser_status: "ready", transcript_status: segments ? transcriptSource === "local_faster_whisper" ? "local_complete" : "platform_available" : "not_applicable", transcript_source: transcriptSource, source_fields: [segments ? "transcript" : "body_text"], normalized_content: { title, text, source_description: source }, evidence_bundle: evidence, user_corrections: [] };
  const { output, trace } = await withAliases(call, "CALL-P001", context, [{ collection: { id }, extraction: { evidenceBundle: evidence } }]);
  const extraction = { collectionId: id, ...normalizeExtraction(output, evidence), transcriptSource, trace };
  const collection = { id, title, url, source, type, status: extraction.status === "qualified" ? "ready" : extraction.status, addedAt: new Date().toISOString(), live: true };
  const signed = { collection, extraction };
  return { ...signed, receipt: sign(signed, "collection"), traceId: id };
}

export async function revise(receipt, correction, call = model) {
  const previous = verify(receipt, "collection");
  if (typeof correction !== "string" || !correction.trim() || correction.length > 5000) throw fault("INVALID_REQUEST");
  const { collection, extraction: old } = previous;
  const evidence = old.evidenceBundle;
  if (!Array.isArray(evidence) || !evidence.length) throw fault("NEEDS_INPUT", 422);
  const { output, trace } = await withAliases(call, "CALL-P001", {
    item_id: collection.id, item_version: (old.revision || 1) + 1,
    source_platform: collection.url ? platform(collection.url) : "generic", content_type: collection.type,
    parser_status: "ready", transcript_source: old.transcriptSource,
    transcript_status: old.transcriptSource === "local_faster_whisper" ? "local_complete" : old.transcriptSource ? "platform_available" : "not_applicable",
    normalized_content: { title: collection.title, text: evidence.map((e) => e.text).join("\n"), source_description: collection.source },
    evidence_bundle: evidence, user_corrections: [{ text: correction.trim(), source: "user_feedback" }],
  }, [{ collection, extraction: old }]);
  const extraction = { collectionId: collection.id, ...normalizeExtraction(output, evidence), transcriptSource: old.transcriptSource, trace, revision: (old.revision || 1) + 1 };
  const result = { collection: { ...collection, status: extraction.status === "qualified" ? "ready" : extraction.status }, extraction };
  return { ...result, receipt: sign(result, "collection") };
}

export function verifiedItems(receipts) {
  if (!Array.isArray(receipts) || receipts.length < 6 || receipts.length > 12) throw fault("INSUFFICIENT_ITEMS", 422);
  const items = receipts.map((r) => verify(r, "collection"));
  if (new Set(items.map((i) => i.collection.id)).size !== items.length || items.some((i) => i.extraction.status !== "qualified")) throw fault("INSUFFICIENT_ITEMS", 422);
  if (JSON.stringify(items).length > 300000) throw fault("CONTENT_TOO_LONG", 413);
  return items;
}
function evidenceIndex(items) { return new Map(items.flatMap((i) => i.extraction.evidenceBundle.map((e) => [e.evidence_id, { ...e, itemId: i.collection.id }]))); }
function mapStrings(value, mapping) {
  if (typeof value === "string") return mapping.get(value) || value;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, mapping));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, mapping)]));
  return value;
}
async function withAliases(call, callId, context, items) {
  const forward = new Map();
  items.forEach((item, index) => {
    forward.set(item.collection.id, `item${index + 1}`);
    item.extraction.evidenceBundle.forEach((e, i) => forward.set(e.evidence_id, `item${index + 1}-e${i + 1}`));
  });
  const result = await call(callId, mapStrings(context, forward));
  return { ...result, output: mapStrings(result.output, new Map([...forward].map(([a, b]) => [b, a]))) };
}
function checkedRefs(ids, evidence, minItems = 1) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !evidence.has(id)) || new Set(ids.map((id) => evidence.get(id).itemId)).size < minItems) throw fault("MODEL_OUTPUT_INVALID", 502);
}
function extractionContent(item) {
  const { trace, ...content } = item.extraction;
  return { item_id: item.collection.id, title: item.collection.title, ...content };
}
function curationContent({ collection, extraction }) {
  // Composition needs the full source once. Digest, breakdown and diagnostics
  // repeat generated interpretations already represented by the summary.
  return {
    item_id: collection.id,
    title: collection.title,
    content_type: collection.type,
    source: collection.source,
    url: collection.url,
    status: extraction.status,
    summary: extraction.summary,
    summary_evidence_ids: extraction.summaryEvidence,
    evidenceBundle: extraction.evidenceBundle,
    transcript_source: extraction.transcriptSource,
  };
}
export async function discover(receipts, call = model) {
  const items = verifiedItems(receipts), evidence = evidenceIndex(items);
  const { output, trace } = await withAliases(call, "CALL-P002", { eligible_extractions: items.map(extractionContent), collection_activity_facts: { available: false, reason: "Actual collection timestamps were not provided; processing timestamps are not collection behavior." }, candidate_item_ids: items.map((i) => i.collection.id), forming_themes: [], confirmed_themes: [], explicit_feedback_constraints: [], rejected_hidden_forgotten_themes: [] }, items);
  if (output.status !== "candidate" || !array(output.themes).length) return { status: "waiting_for_content", message: "这些收藏暂时没有足够明确的共同主题，请再添加相关内容。", trace };
  const theme = output.themes.find((t) => {
    try { checkedRefs(t.evidence_ids, evidence, 3); return new Set(t.evidence_ids.map((id) => evidence.get(id).itemId)).size / items.length >= 0.6 && array(t.connections).length > 0 && t.connections.every((c) => { checkedRefs(c.evidence_ids, evidence, 2); return true; }); } catch { return false; }
  });
  if (!theme) return { status: "waiting_for_content", message: "主题或跨内容连接未通过证据校验，请补充相关收藏。", trace };
  return { status: "candidate", theme, receipt: sign({ items, theme, traces: [trace] }, "theme", 3600) };
}
export async function curate(receipt, call = model, options = {}) {
  const { items, theme, traces } = verify(receipt, "theme");
  const roomPlan = options.recoveryPlan === true ? createRoomPlan(items, theme) : null;
  if (roomPlan && !roomPlan.length) return { status: "waiting_for_content", message: "主题证据不足以支持至少 5 件展品，请补充相关收藏。" };
  const plannedIds = roomPlan ? new Set(roomPlan.flatMap((room) => room.exhibit_ids)) : null;
  const eligibleItems = plannedIds ? items.filter((item) => plannedIds.has(item.collection.id)) : items;
  const plannedEvidence = new Set(eligibleItems.flatMap((item) => item.extraction.evidenceBundle.map((entry) => entry.evidence_id)));
  const { output: response, trace } = await withAliases(call, "CALL-P003", {
    theme_candidate: theme,
    eligible_exhibits: eligibleItems.map(curationContent),
    collection_activity_facts: { available: false, reason: "Do not infer collecting duration, frequency or motivation from processing metadata." },
    validated_connections: roomPlan ? array(theme.connections).filter((connection) => array(connection.evidence_ids).length && connection.evidence_ids.every((id) => plannedEvidence.has(id))) : theme.connections,
    explicit_feedback_constraints: [], curatorial_lens: "balanced", recent_exhibition_summaries: [],
    configuration: { min_items: roomPlan ? 5 : 6, exhibit_range: [5, 9], unique_exhibits_across_rooms: true },
    ...(roomPlan ? { composition_mode: CURATION_PLAN_MODE, room_plan: roomPlan } : {}),
  }, items);
  const output = roomPlan ? assemblePlannedExhibition(response, roomPlan, items) : response;
  if (output.status !== "candidate") return { status: "waiting_for_content", message: "暂时未能形成完整展览，请补充相关收藏。" };
  const selected = array(output.rooms).flatMap((r) => array(r.exhibit_ids));
  if (selected.length < 5 || selected.length > 9 || new Set(selected).size !== selected.length || selected.some((id) => !items.some((i) => i.collection.id === id)) || !string(output.title)) throw fault("MODEL_OUTPUT_INVALID", 502);
  const evidence = evidenceIndex(items.filter((i) => selected.includes(i.collection.id)));
  checkedRefs(output.curatorial_note?.evidence_ids, evidence);
  if (!array(output.connection_claims).length) throw fault("MODEL_OUTPUT_INVALID", 502);
  for (const room of output.rooms) {
    if (!string(room.title) || !array(room.claims).length) throw fault("MODEL_OUTPUT_INVALID", 502);
    for (const claim of room.claims) { checkedRefs(claim.evidence_ids, evidence); if (!["fact", "extraction", "hypothesis", "question"].includes(claim.statement_type)) throw fault("MODEL_OUTPUT_INVALID", 502); }
  }
  for (const c of output.connection_claims) {
    checkedRefs(c.evidence_ids, evidence, 2);
    if (c.statement_type === undefined) c.statement_type = "hypothesis";
    if (!["fact", "extraction", "hypothesis", "question"].includes(c.statement_type)) throw fault("MODEL_OUTPUT_INVALID", 502);
  }
  if (output.emerging_direction?.text) checkedRefs(output.emerging_direction.evidence_ids, evidence);
  const candidate = { ...output, id: `exhibition-${randomUUID()}`, createdAt: new Date().toISOString(), sourceCollectionIds: selected };
  return { status: "candidate", receipt: sign({ items, candidate, traces: [...traces, trace] }, "exhibition-candidate", 3600) };
}
export async function evaluate(receipt, call = model) {
  const { items, candidate, traces } = verify(receipt, "exhibition-candidate");
  const { output, trace } = await withAliases(call, "CALL-PEVAL", { evaluation_target_type: "exhibition", candidate_id: candidate.id, candidate_version: 1, candidate, evidence_bundle: [...evidenceIndex(items).values()], explicit_user_constraints: [], deterministic_checks: { references_exist: true, unique_exhibits: true, source_count: candidate.sourceCollectionIds.length }, rubric_version: "P-EVAL@1.0.0-demo" }, items);
  const findings = ["grounding_findings", "fact_inference_findings", "overinterpretation_findings", "user_constraint_conflicts"];
  const assessments = array(output.connection_assessments);
  const passed = output.status === "evaluated" && output.narrative_coherence?.score >= 4 && output.narrative_coherence.score <= 5 && findings.every((k) => Array.isArray(output[k]) && output[k].length === 0) && candidate.connection_claims.every((c) => assessments.some((a) => a.connection_id === c.connection_id && a.score >= 4 && a.score <= 5));
  // EDD calibration is still outstanding: private preview, never a production-ready claim.
  const exhibition = { ...candidate, status: passed ? "preview" : "needs_review", evaluation: output, traces: [...traces, trace], items: items.map((i) => ({ id: i.collection.id, title: i.collection.title, summary: i.extraction.summary, url: i.collection.url })) };
  return { exhibition, receipt: sign(exhibition, "exhibition"), message: passed ? "展览预览已生成，来源与结构校验通过。" : "已生成草稿，质量检查发现需要核对的内容。" };
}
