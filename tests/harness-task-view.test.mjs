import test from "node:test";
import assert from "node:assert/strict";
import { renderTaskProgress, taskProgressItems } from "../site/curator/task-view.js";

const job = (id, status, more = {}) => ({ id, type: "curate", status, ...more });
const step = (name, status, more = {}) => ({ name, status, ...more });
const count = (html, token) => html.split(token).length - 1;

test("active and failed work is shown before quiet completions and only failures have retry buttons", () => {
  const html = renderTaskProgress([
    job("old-done", "complete"),
    job("failure", "failed", { error: "网络暂时没有连接成功。", harness: { steps: [step("compose", "failed")] } }),
    job("active", "running", { harness: { steps: [step("discover", "complete"), step("compose", "running")] } }),
    ...Array.from({ length: 5 }, (_, index) => job(`done-${index}`, "complete")),
  ]);
  assert.match(html, /class="task-progress"/);
  assert.match(html, /class="task-summary summary"/);
  assert.ok(html.indexOf('data-job-id="active"') < html.indexOf('data-job-id="done-4"'));
  assert.ok(html.indexOf('data-job-id="failure"') < html.indexOf('data-job-id="done-4"'));
  assert.equal(count(html, 'class="task-item '), 4);
  assert.equal(count(html, "处理已结束"), 2);
  assert.equal(count(html, "data-retry-job="), 1);
  assert.match(html, /data-retry-job="failure"/);
  assert.match(html, /正在编排展览/);
  assert.match(html, /编排展览未完成/);
  assert.match(html, /网络暂时没有连接成功/);
  assert.match(html, /<details class="task-details">/);
});

test("a newer attempt replaces every older failed attempt in its retry chain", () => {
  const html = renderTaskProgress([
    job("original", "failed", { createdAt: "2026-11-09T01:00:00Z" }),
    job("retry-one", "failed", { retryOf: "original", retryRootId: "original", createdAt: "2026-11-09T01:01:00Z" }),
    job("retry-two", "queued", { retryOf: "retry-one", retryRootId: "original", createdAt: "2026-11-09T01:02:00Z" }),
    job("independent", "failed"),
  ]);
  assert.doesNotMatch(html, /data-job-id="original"/);
  assert.doesNotMatch(html, /data-job-id="retry-one"/);
  assert.match(html, /data-job-id="retry-two"/);
  assert.match(html, /已排队，会接着完成的步骤继续/);
  assert.equal(count(html, "data-retry-job="), 1);
  assert.match(html, /data-retry-job="independent"/);
  const latestFailure = renderTaskProgress([job("one", "failed"), job("two", "failed", { retryOf: "one" }), job("three", "failed", { retryOf: "two" })]);
  assert.equal(count(latestFailure, 'class="task-item '), 1);
  assert.match(latestFailure, /data-retry-job="three"/);
});

test("shared task outcomes keep the latest retry and preserve attention versus completion", () => {
  const jobs = [
    job("original", "failed", { createdAt: "2026-11-09T01:00:00Z" }),
    job("retry", "complete", { retryOf: "original", createdAt: "2026-11-09T01:01:00Z", result: "needs_review" }),
    job("waiting", "complete", { result: "waiting_for_content" }),
    job("active", "running", { harness: { steps: [step("understand", "running")] } }),
    job("unknown", "unrecognized"),
  ];
  const before = structuredClone(jobs);
  const items = taskProgressItems(jobs);
  assert.deepEqual(items.map(item => item.job.id), ["retry", "waiting", "active"]);
  assert.deepEqual(items.map(item => item.state), ["review", "waiting", "running"]);
  assert.equal(items[0].important, false);
  assert.equal(items[0].status, "结果待核对");
  assert.equal(items[2].important, true);
  assert.equal(items[2].detail, "正在理解收藏");
  assert.deepEqual(jobs, before);
  assert.deepEqual(taskProgressItems(null), []);
});

test("waiting for more content is a distinct normal outcome and never an exhibition success", () => {
  const html = renderTaskProgress([job("waiting", "complete", { result: "waiting_for_content", harness: { steps: [step("discover", "complete")] } })]);
  assert.match(html, /等待更多内容/);
  assert.match(html, /还没有足够的联系/);
  assert.doesNotMatch(html, /处理已结束|展览已完成|生成成功|data-retry-job/);
  assert.match(html, /发现主题/);
  assert.match(renderTaskProgress([job("waiting", "waiting_for_content")]), /等待更多内容/);
});

test("a successful video preview describes the title and cover without claiming source acquisition", () => {
  const html = renderTaskProgress([job("video", "failed", { type: "ingest", harness: { steps: [step("source", "complete", { tool: "read-video-preview" }), step("understand", "failed")] } })]);
  assert.match(html, /读取视频标题与封面/);
  assert.doesNotMatch(html, /读取来源|read-video-preview/);
});

test("reused steps show reuse explicitly and never expose call, budget or signing diagnostics", () => {
  const html = renderTaskProgress([job("reused", "running", {
    receipt: "secret-signed-receipt", contextManifest: { characterCount: 999 },
    harness: { runId: "run-secret", limits: { maxModelCalls: 3 }, calls: [{ callId: "CALL-P003", usage: { total_tokens: 12345 } }], checkpoints: { source: "private-original-content" }, steps: [step("discover", "complete", { reused: true, tool: "CALL-P002" }), step("compose", "complete", { reused: true }), step("evaluate", "running")] },
  })]);
  assert.match(html, /正在独立质量检查/);
  assert.equal(count(html, "已复用"), 2);
  assert.match(html, /正在处理/);
  for (const secret of ["CALL-P003", "CALL-P002", "total_tokens", "maxModelCalls", "12345", "run-secret", "secret-signed-receipt", "private-original-content", "characterCount"]) assert.equal(html.includes(secret), false, secret);
});

test("completed execution is never presented as proof of quality or successful content acquisition", () => {
  const ordinary = renderTaskProgress([job("done", "complete", { harness: { steps: [step("evaluate", "complete")] } })]);
  assert.match(ordinary, /处理已结束/);
  assert.doesNotMatch(ordinary, /评测通过|生成成功|质量合格|data-retry-job/);
  const review = renderTaskProgress([job("review", "complete", { result: "needs_review" })]);
  assert.match(review, /结果待核对/);
  assert.match(review, /展览草稿已保留/);
  assert.doesNotMatch(review, /处理已结束|生成成功/);
  const unavailable = renderTaskProgress([job("unavailable", "complete", { type: "chat", result: "source_unavailable" })]);
  assert.match(unavailable, /页面正文暂时没能读到/);
  const inconsistent = renderTaskProgress([job("inconsistent", "complete", { harness: { steps: [step("evaluate", "failed")] } })]);
  assert.match(inconsistent, /状态待核对/);
  assert.match(inconsistent, />失败</);
  assert.doesNotMatch(inconsistent, /处理已结束/);
});

test("HTML and attribute injection are escaped and arbitrary status strings never become classes", () => {
  const html = renderTaskProgress([job('bad" onmouseover="alert(1)', "failed", { type: '<img src=x onerror=alert(1)>', error: '<script>alert("private")</script>&', harness: { steps: [{ name: "future", label: '<svg onload="alert(1)">', status: '<img src=x>' }] } })]);
  assert.doesNotMatch(html, /<(?:script|svg|img)[\s>]/);
  assert.match(html, /data-retry-job="bad&quot; onmouseover=&quot;alert\(1\)"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;svg onload=&quot;/);
  assert.match(html, /后台任务/);
  assert.doesNotMatch(html, /class="[^\n]*<img/);
  assert.equal(renderTaskProgress([job("unknown", '<img src=x>')]), "");
});

test("limits and empty inputs keep the view quiet without mutating job data", () => {
  const jobs = [job("failed", "failed"), job("queued", "queued"), job("done", "complete")];
  const before = structuredClone(jobs);
  assert.equal(renderTaskProgress([]), "");
  assert.equal(renderTaskProgress(null), "");
  assert.equal(renderTaskProgress(jobs, { limit: 0 }), "");
  assert.equal(count(renderTaskProgress(jobs, { limit: 1 }), 'class="task-item '), 1);
  assert.deepEqual(jobs, before);
});
