const sampleId = "folio-first-collection";
const form = document.querySelector("#trial-form");
const submit = document.querySelector("#submit");
const status = document.querySelector("#status");
const output = document.querySelector("#result");

const sampleTitle = document.querySelector("#sample-heading").textContent.trim();
const sample = {
  mode: "text",
  sampleId,
  content: document.querySelector("#sample-text").textContent.trim(),
};

const errors = {
  SERVICE_NOT_CONFIGURED: "在线模型暂不可用。你仍可阅读下方的示例展览。",
  RATE_LIMITED: "在线体验额度已用完，请稍后再试。下方的示例展览可以继续阅读。",
  QUOTA_UNAVAILABLE: "在线体验暂不可用，请稍后再试。",
  REQUEST_EXPIRED: "本次体验会话已失效，请再试一次。",
  REQUEST_RUNNING: "这段文字仍在处理中，请稍后重试。",
  PROCESSING_TIMEOUT: "模型这次没有及时返回，请稍后再试。",
  MODEL_OUTPUT_INVALID: "这次模型返回的内容无法显示，请重试。",
  NETWORK: "暂时无法连接在线体验，请检查网络后重试。",
};

class DemoError extends Error {
  constructor(code) {
    super(errors[code] || "这次没有取得整理结果，请重试。");
  }
}

async function request(action, options = {}) {
  let response;
  try {
    response = await fetch(`../api/forme?action=${action}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
    });
  } catch {
    throw new DemoError("NETWORK");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 429) throw new DemoError("RATE_LIMITED");
    throw new DemoError(data?.error);
  }
  if (!data || typeof data !== "object") throw new DemoError("NETWORK");
  return data;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function text(value, limit = 1200) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function showResult(data) {
  const { extraction, collection } = data;
  if (!extraction || !collection) throw new DemoError("MODEL_OUTPUT_INVALID");

  if (extraction.status === "needs_input") {
    output.replaceChildren(node("p", text(extraction.hint) || "这次模型没有从示例里提取出足够内容。", "response-hint"));
    status.textContent = "模型这次未能从示例里整理出要点。";
    return;
  }

  const summary = text(extraction.summary);
  const recognized = ["qualified", "needs_confirmation"].includes(extraction.status);
  if (!recognized || extraction.source !== "live_ai" || !summary) {
    throw new DemoError("MODEL_OUTPUT_INVALID");
  }

  const fragment = document.createDocumentFragment();
  fragment.append(
    node("h3", text(collection.title, 160) || sampleTitle, "response-title"),
    node("p", summary, "response-summary"),
  );

  const highlights = Array.isArray(extraction.digest?.highlights)
    ? extraction.digest.highlights.slice(0, 3).map((highlight) => text(highlight?.text, 350)).filter(Boolean)
    : [];
  if (highlights.length) {
    const list = node("ul", "", "response-list");
    list.append(...highlights.map((highlight) => node("li", highlight)));
    fragment.append(list);
  }

  const summaryIds = Array.isArray(extraction.summaryEvidence) ? new Set(extraction.summaryEvidence) : new Set();
  const citations = Array.isArray(extraction.evidenceBundle)
    ? extraction.evidenceBundle.filter((entry) => summaryIds.has(entry?.evidence_id) && text(entry?.text)).slice(0, 3)
    : [];
  if (citations.length) {
    const details = document.createElement("details");
    details.append(node("summary", "查看摘要引用的原文"));
    for (const citation of citations) details.append(node("blockquote", text(citation.text)));
    fragment.append(details);
  }

  const needsConfirmation = extraction.status === "needs_confirmation";
  if (needsConfirmation) {
    fragment.append(node("p", text(extraction.hint) || "这份整理仍需结合原文核对。", "response-hint"));
  }
  output.replaceChildren(fragment);
  status.textContent = needsConfirmation ? "已返回模型整理，部分内容待核对。" : "已完成模型整理。";
}

let requestId;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;

  submit.disabled = true;
  submit.textContent = "正在整理…";
  output.replaceChildren();
  status.textContent = "正在提交示例文字并等待模型返回。";
  output.setAttribute("aria-busy", "true");

  let completed = false;
  try {
    const session = await request("session");
    if (session.enabled !== true || session.publicDemo !== true || session.sampleId !== sampleId
      || typeof session.csrf !== "string" || !session.csrf) {
      throw new DemoError("SERVICE_NOT_CONFIGURED");
    }
    requestId ||= crypto.randomUUID();
    const result = await request("ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forme-csrf": session.csrf },
      body: JSON.stringify({ ...sample, requestId }),
    });
    showResult(result);
    completed = true;
  } catch (error) {
    status.textContent = error instanceof DemoError ? error.message : "这次没有取得整理结果，请重试。";
  } finally {
    output.removeAttribute("aria-busy");
    submit.disabled = completed;
    submit.textContent = completed ? "已返回结果" : "整理这段示例文字";
  }
});
submit.disabled = false;
