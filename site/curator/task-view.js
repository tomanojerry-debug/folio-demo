const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const TASK_NAMES = Object.freeze({ ingest: "整理收藏", revise: "修订理解", chat: "回答问题", curate: "整理展览", "curate-selected": "整理专题" });
const STAGE_NAMES = Object.freeze({ source: "读取来源", understand: "理解收藏", revise: "修订理解", context: "准备页面资料", answer: "生成回答", search: "搜索网页", discover: "发现主题", compose: "编排展览", evaluate: "独立质量检查" });
const KNOWN_STATUSES = new Set(["queued", "running", "failed", "complete", "waiting_for_content"]);
const text = (value, maximum = 300) => typeof value === "string" ? value.slice(0, maximum) : "";
const stageName = (step) => {
  if (step?.name === "source" && step.tool === "read-video-preview") return "读取视频标题与封面";
  if (step?.name === "source" && step.tool === "read-video-captions") return "读取视频字幕";
  return Object.hasOwn(STAGE_NAMES, step?.name) ? STAGE_NAMES[step.name] : text(step?.label, 80) || "处理步骤";
};
const stepsFor = (job) => Array.isArray(job.harness?.steps) ? job.harness.steps.filter((step) => step && typeof step === "object").slice(-40) : [];
const recency = (job, index) => {
  const created = Date.parse(job.createdAt || "");
  return Number.isFinite(created) ? created : index;
};

function latestAttempts(jobs) {
  const entries = jobs.filter((job) => job && typeof job === "object" && typeof job.id === "string" && KNOWN_STATUSES.has(job.status));
  const byId = new Map(entries.map((job) => [job.id, job]));
  const rootFor = (job, seen = new Set()) => {
    if (typeof job.retryRootId === "string" && job.retryRootId) return job.retryRootId;
    if (typeof job.retryOf !== "string" || !job.retryOf || seen.has(job.id)) return job.id;
    seen.add(job.id);
    const parent = byId.get(job.retryOf);
    return parent ? rootFor(parent, seen) : job.retryOf;
  };
  const latest = new Map();
  entries.forEach((job, index) => {
    const root = rootFor(job);
    const item = { job, index, time: recency(job, index) };
    const previous = latest.get(root);
    if (!previous || item.time > previous.time || (item.time === previous.time && item.index > previous.index)) latest.set(root, item);
  });
  return [...latest.values()];
}

/** Count current attempts only, so a recovered failure is not still a todo. */
export function summarizeTaskProgress(jobs = []) {
  const summary = { active: 0, failed: 0, review: 0, waiting: 0 };
  for (const { job } of latestAttempts(Array.isArray(jobs) ? jobs : [])) {
    const view = presentation(job);
    if (["queued", "running"].includes(view.state)) summary.active += 1;
    else if (view.state === "failed") summary.failed += 1;
    else if (view.state === "review") summary.review += 1;
    else if (view.state === "waiting") summary.waiting += 1;
  }
  return summary;
}

function presentation(job) {
  const steps = stepsFor(job);
  if (job.status === "failed") {
    const step = steps.findLast((item) => item.status === "failed") || steps.at(-1);
    return { state: "failed", status: "暂未完成", detail: step ? `${stageName(step)}未完成，可以继续处理。` : "这次处理未完成，可以继续处理。", important: true };
  }
  if (job.status === "queued") return { state: "queued", status: "等待处理", detail: job.retryOf ? "已排队，会接着完成的步骤继续。" : "已排队，稍后开始处理。", important: true };
  if (job.status === "running") {
    const running = steps.findLast((item) => item.status === "running");
    const previous = steps.at(-1);
    const detail = running ? `正在${stageName(running)}` : previous?.status === "complete" ? `已完成${stageName(previous)}，继续处理中。` : "正在准备处理。";
    return { state: "running", status: "处理中", detail, important: true };
  }
  if (job.status === "waiting_for_content" || job.result === "waiting_for_content") return { state: "waiting", status: "等待更多内容", detail: "现有收藏还没有足够的联系，等有新内容再整理。", important: false };
  if (job.result === "source_unavailable") return { state: "waiting", status: "等你补充正文", detail: "页面正文暂时没能读到，可以粘贴正文继续聊。", important: false };
  if (job.result === "transcript_saved") return { state: "complete", status: "字幕已存", detail: "可以在收藏中阅读字幕。", important: false };
  if (job.result === "needs_input") return { state: "waiting", status: "等待补充内容", detail: "原始内容已保留，补充资料后可以继续整理。", important: false };
  if (["needs_confirmation", "needs_review"].includes(job.result)) return { state: "review", status: "结果待核对", detail: job.type === "curate" ? "展览草稿已保留，仍需核对内容与来源。" : "整理结果已保留，仍需核对内容与来源。", important: false };
  // Completing an execution is not proof that its generated exhibition passed
  // evaluation. Older jobs may have no detailed outcome, so remain neutral.
  const inconsistent = steps.some((step) => ["failed", "running"].includes(step.status));
  return { state: inconsistent ? "review" : "complete", status: inconsistent ? "状态待核对" : "处理已结束", detail: inconsistent ? "处理记录中仍有未完成的步骤，请核对结果。" : "可以在对话或收藏馆查看处理结果。", important: false };
}

/** Share the current task outcomes without treating historical attempts as work. */
export function taskProgressItems(jobs = []) {
  return latestAttempts(Array.isArray(jobs) ? jobs : []).map(({ job }) => ({ job, ...presentation(job) }));
}

function stepMarkup(step) {
  const status = step.status === "complete" ? (step.reused ? "已复用" : "已完成") : step.status === "running" ? "正在处理" : step.status === "failed" ? "失败" : "等待处理";
  const state = step.status === "complete" ? (step.reused ? "reused" : "complete") : ["running", "failed"].includes(step.status) ? step.status : "queued";
  return `<li class="task-step is-${state}"><span class="task-step-name">${escape(stageName(step))}</span><span class="task-step-status">${status}</span></li>`;
}

function taskMarkup(job, view) {
  const name = job.sourceRefresh ? "重新读取原文" : job.webSearch ? "搜索网页" : Object.hasOwn(TASK_NAMES, job.type) ? TASK_NAMES[job.type] : "后台任务";
  const steps = stepsFor(job);
  const error = view.state === "failed" ? text(job.error) : "";
  const subject = text(job.subject, 160);
  const detail = steps.length ? `<details class="task-details"><summary class="task-detail-summary summary">查看处理步骤（${steps.length}）</summary><ol class="task-steps">${steps.map(stepMarkup).join("")}</ol></details>` : "";
  const retry = view.state === "failed" ? `<button class="task-retry" type="button" data-retry-job="${escape(job.id)}" aria-label="继续处理：${escape(name)}">继续处理</button>` : "";
  return `<li class="task-item is-${view.state}" data-job-id="${escape(job.id)}"><div class="task-item-heading"><span class="task-name">${escape(name)}</span><span class="task-status">${view.status}</span></div>${subject ? `<p class="task-subject">${escape(subject)}</p>` : ""}<p class="task-stage">${escape(view.detail)}</p>${error ? `<p class="task-error">${escape(error)}</p>` : ""}${detail}${retry}</li>`;
}

/** Small, escaped product progress view. Engineering diagnostics stay in storage. */
export function renderTaskProgress(jobs, { limit = 5, completedLimit = 2 } = {}) {
  const maximum = Number.isFinite(limit) ? Math.min(20, Math.max(0, Math.floor(limit))) : 5;
  if (!Array.isArray(jobs) || !maximum) return "";
  const ordered = latestAttempts(jobs).map((item) => ({ ...item, view: presentation(item.job) })).sort((a, b) => Number(b.view.important) - Number(a.view.important) || b.time - a.time || b.index - a.index);
  let finished = 0;
  const quietMaximum = Number.isFinite(completedLimit) ? Math.min(maximum, Math.max(0, Math.floor(completedLimit))) : 2;
  const selected = ordered.filter((item) => item.view.important || finished++ < quietMaximum).slice(0, maximum);
  if (!selected.length) return "";
  return `<section class="task-progress" aria-label="处理进度"><div class="task-summary summary">处理进度</div><ol class="task-list">${selected.map(({ job, view }) => taskMarkup(job, view)).join("")}</ol></section>`;
}
