import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openState } from "../desktop/server/state.mjs";
import { createHarness, publicHarness } from "../desktop/server/harness/runtime.mjs";

async function fixture(t, type = "curate", limits) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-harness-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openState(directory);
  await store.update((draft) => { draft.jobs.push({ id: "job-test", type, status: "running" }); });
  return { directory, store, harness: await createHarness({ store, jobId: "job-test", limits }) };
}

test("completed checkpoints persist through reopening and return independent copies", async (t) => {
  const { directory, harness } = await fixture(t);
  const result = { status: "candidate", receipt: "private-signed-theme" };
  await harness.step("discover", async () => result, { checkpoint: true });
  result.receipt = "mutated-outside";
  const reopened = await openState(directory);
  const resumed = await createHarness({ store: reopened, jobId: "job-test" });
  const cached = await resumed.step("discover", () => { throw new Error("Do not repeat the completed stage"); }, { checkpoint: true });
  assert.equal(cached.receipt, "private-signed-theme");
  cached.receipt = "mutated-copy";
  assert.equal(resumed.snapshot().checkpoints.discover.value.receipt, "private-signed-theme");
  assert.equal(resumed.snapshot().steps.at(-1).reused, true);
  assert.equal(resumed.snapshot().steps.at(-1).label, "发现主题");
});

test("a failed later stage keeps the completed stage reusable by an explicitly retried job", async (t) => {
  const { store, harness } = await fixture(t);
  await harness.step("discover", () => ({ receipt: "valid-theme" }), { checkpoint: true });
  await assert.rejects(harness.step("compose", () => { throw Object.assign(new Error("private provider body"), { code: "MODEL_PROVIDER_ERROR" }); }, { checkpoint: true }), { code: "MODEL_PROVIDER_ERROR" });
  assert.equal(harness.snapshot().steps.at(-1).status, "failed");
  assert.equal(harness.snapshot().steps.at(-1).errorCode, "MODEL_PROVIDER_ERROR");
  assert.equal(harness.snapshot().checkpoints.compose, undefined);
  await store.update((draft) => {
    draft.jobs.push({ id: "job-retry", type: "curate", status: "queued", harness: { ...harness.snapshot(), runId: "run-retry", steps: [], calls: [] } });
  });
  const retried = await createHarness({ store, jobId: "job-retry" });
  let discovered = 0;
  assert.equal((await retried.step("discover", () => { discovered++; }, { checkpoint: true })).receipt, "valid-theme");
  await retried.step("compose", () => ({ receipt: "candidate" }), { checkpoint: true });
  assert.equal(discovered, 0);
  assert.equal(retried.snapshot().steps.at(-1).status, "complete");
});

test("model attempts reserve a durable finite budget and failures do not automatically retry", async (t) => {
  const { directory, harness } = await fixture(t, "ingest", { maxModelCalls: 1 });
  let attempts = 0;
  await assert.rejects(harness.step("understand", () => harness.invoke("CALL-P001", () => { attempts++; throw Object.assign(new Error("rate limit"), { code: "MODEL_RATE_LIMITED" }); })), { code: "MODEL_RATE_LIMITED" });
  assert.equal(attempts, 1);
  const reopened = await openState(directory);
  const resumed = await createHarness({ store: reopened, jobId: "job-test", limits: { maxModelCalls: 100 } });
  await assert.rejects(resumed.step("understand", () => resumed.invoke("CALL-P001", () => { attempts++; })), { code: "HARNESS_BUDGET_EXCEEDED" });
  assert.equal(attempts, 1);
  assert.equal(resumed.snapshot().calls.length, 1);
  assert.equal(resumed.snapshot().limits.maxModelCalls, 1);
});

test("unknown tools, mismatched task calls and mismatched stage calls fail closed", async (t) => {
  const { harness } = await fixture(t, "chat");
  let executions = 0;
  const unsafe = () => { executions++; };
  await assert.rejects(harness.invoke("CALL-P001", unsafe), { code: "TOOL_NOT_ALLOWED" });
  await assert.rejects(harness.invoke("CALL-UNKNOWN", unsafe), { code: "TOOL_NOT_ALLOWED" });
  await assert.rejects(harness.step("compose", unsafe), { code: "TOOL_NOT_ALLOWED" });
  await assert.rejects(harness.step("context", unsafe, { tool: "shell.exec" }), { code: "TOOL_NOT_ALLOWED" });
  await assert.rejects(harness.step("context", () => harness.invoke("CALL-CHAT", unsafe)), { code: "TOOL_NOT_ALLOWED" });
  assert.equal(executions, 0);
  assert.equal(harness.snapshot().calls.length, 0);
});

test("timeout aborts the operation and a late model result cannot complete or checkpoint", async (t) => {
  const { harness } = await fixture(t, "chat", { stepTimeoutMs: 15 });
  let resolveModel;
  let signal;
  const result = harness.step("answer", () => harness.invoke("CALL-CHAT", (value) => {
    signal = value;
    return new Promise((resolve) => { resolveModel = resolve; });
  }), { checkpoint: true });
  await assert.rejects(result, { code: "HARNESS_TIMEOUT" });
  assert.equal(signal.aborted, true);
  assert.equal(harness.snapshot().calls[0].status, "failed");
  assert.equal(harness.snapshot().calls[0].errorCode, "HARNESS_TIMEOUT");
  resolveModel({ output: "late private output", trace: { model: "test" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.snapshot().steps[0].status, "failed");
  assert.equal(harness.snapshot().calls[0].status, "failed");
  assert.equal(harness.snapshot().checkpoints.answer, undefined);
});

test("public run summaries contain bounded call metadata and omit all private checkpoint data", async (t) => {
  const { harness } = await fixture(t, "curate");
  await harness.step("discover", () => harness.invoke("CALL-P002", () => ({
    output: { receipt: "private-receipt", body: "private-body" },
    trace: { callId: "CALL-P002", model: "test-model", inputHash: "a".repeat(64), usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, raw: "private-body" }, authorization: "secret-token", prompt: "private-prompt", arbitrary: { private: true } },
  })), { checkpoint: true });
  const summary = publicHarness(harness.snapshot());
  const encoded = JSON.stringify(summary);
  for (const forbidden of ["private-receipt", "private-body", "private-prompt", "secret-token", "checkpoints", "arbitrary", "authorization"]) assert.equal(encoded.includes(forbidden), false, forbidden);
  assert.equal(summary.calls[0].model, "test-model");
  assert.deepEqual(summary.calls[0].usage, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
  assert.equal(summary.calls[0].status, "complete");
  summary.steps[0].label = "mutated";
  assert.equal(harness.snapshot().steps[0].label, "发现主题");
});

test("reopening an interrupted run marks unknown in-flight work failed and consumes its reserved call", async (t) => {
  const { directory, store } = await fixture(t, "chat");
  await store.update((draft) => {
    const harness = draft.jobs[0].harness;
    harness.steps.push({ id: "step-crashed", name: "answer", status: "running", startedAt: new Date().toISOString() });
    harness.calls.push({ id: "call-crashed", callId: "CALL-CHAT", status: "running", startedAt: new Date().toISOString() });
  });
  const reopened = await openState(directory);
  const harness = await createHarness({ store: reopened, jobId: "job-test" });
  assert.equal(harness.snapshot().steps[0].errorCode, "INTERRUPTED");
  assert.equal(harness.snapshot().calls[0].errorCode, "INTERRUPTED");
  let called = false;
  await assert.rejects(harness.invoke("CALL-CHAT", () => { called = true; }), { code: "HARNESS_BUDGET_EXCEEDED" });
  assert.equal(called, false);
});

test("simultaneous model reservations cannot exceed the job budget", async (t) => {
  const { harness } = await fixture(t, "chat");
  let calls = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => harness.invoke("CALL-CHAT", async () => { calls++; return { model: "test" }; })));
  assert.equal(calls, 1);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected" && item.reason.code === "HARNESS_BUDGET_EXCEEDED").length, 4);
  assert.equal(harness.snapshot().calls.length, 1);
});
