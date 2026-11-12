const sampleId = "folio-first-collection";
const moduleURL = new URL(import.meta.url);
const workspaceSample = moduleURL.pathname.endsWith("/try/sample/app.js");
const endpoint = new URL(workspaceSample ? "../../api/forme" : "../api/forme", moduleURL);
const form = document.querySelector("#trial-form");
const submit = document.querySelector("#submit");
const status = document.querySelector("#status");
const output = document.querySelector("#result");

const workspaceURL = workspaceSample ? new URL("../../prototype/immersive-exhibition/light.html", moduleURL) : null;
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
    const url = new URL(endpoint);
    url.searchParams.set("action", action);
    response = await fetch(url, {
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

async function showResult(data) {
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
  let saved = false;
  if (workspaceURL) {
    try {
      const { savePublicSample } = await import(new URL("../../curator/public-library.js", moduleURL));
      saved = savePublicSample(data, sample.content, window.localStorage);
    } catch { /* Model results remain visible if browser storage is unavailable. */ }
    if (saved) {
      const link = node("a", "查看我的收藏 ↗", "response-open-collection");
      const destination = new URL(workspaceURL);
      destination.searchParams.set("collection", sampleId);
      destination.hash = "inbox";
      link.href = destination;
      fragment.append(link);
    }
  }
  output.replaceChildren(fragment);
  status.textContent = needsConfirmation ? "已返回模型整理，部分内容待核对。" : "已完成模型整理。";
  if (saved) status.textContent += " 已加入当前浏览器的收藏。";
  else if (workspaceURL) status.textContent += " 当前浏览器暂未保存这条收藏。";
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
    await showResult(result);
    completed = true;
  } catch (error) {
    status.textContent = error instanceof DemoError ? error.message : "这次没有取得整理结果，请重试。";
  } finally {
    output.removeAttribute("aria-busy");
    submit.disabled = completed;
    submit.textContent = completed ? "已返回结果" : buttonText;
  }
});
const buttonText = workspaceSample ? "整理并加入收藏" : "整理这段示例文字";
submit.textContent = buttonText;
if (workspaceSample) {
  const returnLink = document.querySelector('.header-inner nav a[href="#main"]');
  returnLink.href = new URL("#home", workspaceURL);
  returnLink.textContent = "返回工作台";
}
submit.disabled = false;
