import { randomUUID } from "node:crypto";

const LABELS = Object.freeze({ source: "读取来源", understand: "理解收藏", revise: "修订理解", context: "准备参考资料", search: "搜索公开网页", answer: "生成回答", reading: "生成阅读辅助", discover: "发现主题", compose: "编排展览", evaluate: "独立质量检查" });
const TOOL_LABELS = Object.freeze({ "read-video-preview": "读取视频标题与封面", "read-video-captions": "读取视频字幕" });
const POLICIES = Object.freeze({
  ingest: { stages: ["source", "understand"], calls: ["CALL-P001", "CALL-VISION01"], maxModelCalls: 2 },
  revise: { stages: ["revise"], calls: ["CALL-P001"], maxModelCalls: 2 },
  chat: { stages: ["context", "search", "answer"], calls: ["CALL-CHAT"], maxModelCalls: 1 },
  reading: { stages: ["source", "reading"], calls: ["CALL-READING"], maxModelCalls: 1 },
  curate: { stages: ["discover", "compose", "evaluate"], calls: ["CALL-P002", "CALL-P003", "CALL-PEVAL"], maxModelCalls: 3 },
});
const TOOLS = Object.freeze({
  source: ["source", "read-source", "read-video-preview", "read-video-captions", "read-page", "read-stored-source", "safeFetch"],
  understand: ["understand", "ingest", "CALL-P001", "CALL-VISION01"],
  revise: ["revise", "CALL-P001"],
  context: ["context", "read-page", "read-source", "safeFetch", "search-library", "search-memory"],
  search: ["search-web"],
  answer: ["answer", "chat", "CALL-CHAT"],
  reading: ["reading", "CALL-READING"],
  discover: ["discover", "CALL-P002"],
  compose: ["compose", "curate", "CALL-P003"],
  evaluate: ["evaluate", "CALL-PEVAL"],
});
const now = () => new Date().toISOString();
const fault = (code) => Object.assign(new Error({ HARNESS_TIMEOUT: "这一步等待超时，可以稍后重试。", HARNESS_BUDGET_EXCEEDED: "本次任务已达到智能调用上限。", TOOL_NOT_ALLOWED: "本次任务不允许执行这个操作。" }[code] || "任务执行失败。"), { code });
const errorCode = (error) => typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "PROCESSING_FAILED";
const integer = (value, fallback, maximum) => Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
const safeString = (value, max = 120) => typeof value === "string" ? value.slice(0, max) : undefined;
const copyFields = (value, fields) => Object.fromEntries(fields.filter((key) => value?.[key] !== undefined).map((key) => [key, structuredClone(value[key])]));

function usageSummary(value) {
  if (!value || typeof value !== "object") return undefined;
  const fields = ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"];
  const summary = Object.fromEntries(fields.filter((key) => Number.isFinite(value[key]) && value[key] >= 0).map((key) => [key, value[key]]));
  return Object.keys(summary).length ? summary : undefined;
}

function traceSummary(result) {
  const trace = result?.trace || {};
  const summary = {};
  if (safeString(trace.model || result?.model)) summary.model = safeString(trace.model || result?.model);
  for (const key of ["inputHash", "outputHash"]) if (typeof trace[key] === "string" && /^[a-f0-9]{64}$/i.test(trace[key])) summary[key] = trace[key];
  for (const key of ["promptVersion", "schemaVersion", "policyVersion"]) if (safeString(trace[key])) summary[key] = safeString(trace[key]);
  const usage = usageSummary(trace.usage || result?.usage);
  if (usage) summary.usage = usage;
  return summary;
}

/** A public projection deliberately excludes checkpoints, prompts and model output. */
export function publicHarness(harness) {
  if (!harness || harness.version !== 1) return undefined;
  return {
    ...copyFields(harness, ["version", "runId", "jobType", "createdAt", "updatedAt"]),
    limits: copyFields(harness.limits, ["maxModelCalls", "stepTimeoutMs"]),
    steps: (Array.isArray(harness.steps) ? harness.steps : []).slice(-40).map((step) => copyFields(step, ["id", "name", "label", "tool", "status", "startedAt", "finishedAt", "durationMs", "errorCode", "reused"])),
    calls: (Array.isArray(harness.calls) ? harness.calls : []).slice(-10).map((call) => ({
      ...copyFields(call, ["id", "callId", "status", "startedAt", "finishedAt", "durationMs", "errorCode"]),
      ...traceSummary({ trace: call }),
    })),
  };
}

/**
 * Executes read/model work. Product mutations must happen only after step resolves.
 * Every reservation is persisted before the external operation starts. A timeout
 * aborts the cooperative signal and settles the attempt; late output is discarded.
 */
export async function createHarness({ store, jobId, limits = {} } = {}) {
  if (!store?.read || !store?.update) throw new TypeError("A persisted job store is required");
  const job = store.read().jobs.find((entry) => entry.id === jobId);
  const policy = POLICIES[job?.type];
  if (!policy) throw fault("TOOL_NOT_ALLOWED");
  const resolvedLimits = {
    maxModelCalls: integer(limits.maxModelCalls, policy.maxModelCalls, policy.maxModelCalls),
    stepTimeoutMs: integer(limits.stepTimeoutMs, 120_000, 300_000),
  };
  const active = new Map();
  const timedOutCalls = new Set();

  async function update(mutation) {
    return store.update((draft) => {
      const current = draft.jobs.find((entry) => entry.id === jobId);
      if (!current) throw fault("TOOL_NOT_ALLOWED");
      mutation(current.harness);
      current.harness.updatedAt = now();
    });
  }
  await store.update((draft) => {
    const current = draft.jobs.find((entry) => entry.id === jobId);
    if (!current || current.type !== job.type) throw fault("TOOL_NOT_ALLOWED");
    if (!current.harness) current.harness = { version: 1, runId: `run-${randomUUID()}`, jobType: job.type, createdAt: now(), updatedAt: now(), steps: [], calls: [], checkpoints: {}, limits: resolvedLimits };
    else {
      if (current.harness.version !== 1 || (current.harness.jobType !== undefined && current.harness.jobType !== job.type) || !Array.isArray(current.harness.steps) || !Array.isArray(current.harness.calls) || !current.harness.checkpoints || typeof current.harness.checkpoints !== "object" || Array.isArray(current.harness.checkpoints)) throw fault("TOOL_NOT_ALLOWED");
      // A fresh caller cannot raise a persisted run's budget.
      current.harness.limits = {
        maxModelCalls: Math.min(integer(current.harness.limits?.maxModelCalls, resolvedLimits.maxModelCalls, policy.maxModelCalls), resolvedLimits.maxModelCalls),
        stepTimeoutMs: Math.min(integer(current.harness.limits?.stepTimeoutMs, resolvedLimits.stepTimeoutMs, 300_000), resolvedLimits.stepTimeoutMs),
      };
      for (const entry of [...current.harness.steps, ...current.harness.calls]) {
        if (entry.status === "running") Object.assign(entry, { status: "failed", errorCode: "INTERRUPTED", finishedAt: now(), durationMs: Math.max(0, Date.now() - Date.parse(entry.startedAt)) || 0 });
      }
    }
  });
  const snapshot = () => structuredClone(store.read().jobs.find((entry) => entry.id === jobId)?.harness);

  async function invoke(callId, operation) {
    if (!policy.calls.includes(callId) || typeof operation !== "function") throw fault("TOOL_NOT_ALLOWED");
    // The active stage is kept until the operation settles, even after timeout.
    // It prevents a late callback from starting another external invocation.
    const runningStep = [...active.values()].at(-1);
    if (runningStep?.signal.aborted) throw fault("HARNESS_TIMEOUT");
    if (runningStep && !TOOLS[runningStep.name].includes(callId)) throw fault("TOOL_NOT_ALLOWED");
    const call = { id: `call-${randomUUID()}`, callId, status: "running", startedAt: now() };
    await update((harness) => {
      if (harness.calls.length >= harness.limits.maxModelCalls) throw fault("HARNESS_BUDGET_EXCEEDED");
      harness.calls.push(call);
    });
    const started = Date.now();
    try {
      if (runningStep?.signal.aborted) throw fault("HARNESS_TIMEOUT");
      const result = await operation(runningStep?.signal);
      if (runningStep?.signal.aborted || timedOutCalls.has(call.id)) throw fault("HARNESS_TIMEOUT");
      await update((harness) => Object.assign(harness.calls.find((entry) => entry.id === call.id), { status: "complete", finishedAt: now(), durationMs: Date.now() - started, ...traceSummary(result) }));
      return result;
    } catch (error) {
      await update((harness) => {
        const current = harness.calls.find((entry) => entry.id === call.id);
        if (current.status === "running") Object.assign(current, { status: "failed", finishedAt: now(), durationMs: Date.now() - started, errorCode: errorCode(error) });
      });
      throw error;
    }
  }

  async function step(name, operation, { checkpoint = false, tool, timeoutMs } = {}) {
    if (!policy.stages.includes(name) || (tool !== undefined && !TOOLS[name]?.includes(tool)) || typeof operation !== "function") throw fault("TOOL_NOT_ALLOWED");
    // Calls in one job must remain sequential; sharing one harness across nested
    // stages would make timeout ownership and model-call attribution ambiguous.
    if (active.size) throw fault("TOOL_NOT_ALLOWED");
    const label = TOOL_LABELS[tool] || LABELS[name];
    const previous = snapshot().checkpoints[name];
    if (checkpoint && previous && Object.hasOwn(previous, "value")) {
      await update((harness) => {
        harness.steps.push({ id: `step-${randomUUID()}`, name, label, ...(tool ? { tool } : {}), status: "complete", startedAt: now(), finishedAt: now(), durationMs: 0, reused: true });
        harness.steps = harness.steps.slice(-40);
      });
      return structuredClone(previous.value);
    }
    const controller = new AbortController();
    const entry = { id: `step-${randomUUID()}`, name, label, ...(tool ? { tool } : {}), status: "running", startedAt: now() };
    active.set(entry.id, { name, signal: controller.signal });
    try { await update((harness) => { harness.steps.push(entry); harness.steps = harness.steps.slice(-40); }); }
    catch (error) { active.delete(entry.id); throw error; }
    const started = Date.now();
    const limit = Math.min(integer(timeoutMs, snapshot().limits.stepTimeoutMs, 300_000), snapshot().limits.stepTimeoutMs);
    let timer;
    let operationSettled = false;
    const work = Promise.resolve().then(() => operation(controller.signal)).finally(() => { operationSettled = true; if (controller.signal.aborted) active.delete(entry.id); });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fault("HARNESS_TIMEOUT")); }, limit);
    });
    try {
      const result = await Promise.race([work, timeout]);
      clearTimeout(timer);
      if (controller.signal.aborted) throw fault("HARNESS_TIMEOUT");
      await update((harness) => {
        Object.assign(harness.steps.find((item) => item.id === entry.id), { status: "complete", finishedAt: now(), durationMs: Date.now() - started });
        if (checkpoint) harness.checkpoints[name] = { completedAt: now(), value: structuredClone(result) };
      });
      return result;
    } catch (error) {
      await update((harness) => {
        Object.assign(harness.steps.find((item) => item.id === entry.id), { status: "failed", finishedAt: now(), durationMs: Date.now() - started, errorCode: errorCode(error) });
        if (controller.signal.aborted) for (const call of harness.calls) if (call.status === "running") {
          timedOutCalls.add(call.id);
          Object.assign(call, { status: "failed", finishedAt: now(), durationMs: Math.max(0, Date.now() - Date.parse(call.startedAt)), errorCode: "HARNESS_TIMEOUT" });
        }
      });
      throw error;
    } finally {
      clearTimeout(timer);
      if (operationSettled) active.delete(entry.id);
    }
  }
  return { step, invoke, snapshot };
}
