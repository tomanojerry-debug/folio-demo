const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeoutMessage = "暂未取得处理结果，请稍后点击重试以检查原任务。";

// Reuse the same request ID: the server returns the original cached result.
export async function requestResult(action, body, csrf, { fetchImpl = fetch, sleep = wait, now = Date.now, onPending = () => {} } = {}) {
  const deadline = now() + 240000;
  const payload = JSON.stringify(body);
  while (now() < deadline) {
    let response, data;
    try {
      response = await fetchImpl(`/api/forme?action=${action}`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Forme-CSRF": csrf },
        body: payload, signal: AbortSignal.timeout(Math.max(1, Math.min(170000, deadline - now()))),
      });
      try { data = await response.json(); } catch (error) {
        if (["TimeoutError", "AbortError"].includes(error.name)) throw error;
        throw new Error("服务没有返回完整结果，请稍后重试。");
      }
    } catch (error) {
      if (["TimeoutError", "AbortError"].includes(error.name)) throw new Error(timeoutMessage);
      throw error;
    }
    if (response.ok) return data;
    if (response.status === 409 && data.error === "REQUEST_RUNNING") {
      onPending();
      await sleep(Math.max(0, Math.min(3000, deadline - now())));
      continue;
    }
    throw Object.assign(new Error(data.message || "处理失败，请稍后重试。"), { code: data.error, status: response.status });
  }
  throw new Error(timeoutMessage);
}

export function syncTaskState(draft, task, status, message) {
  Object.assign(task, { status, error: status === "processing" ? null : message });
  // A failed revision must not discard the previously completed understanding.
  if (task.action === "revise") return;
  const item = draft.collections.find((i) => i.id === task.id);
  if (item) item.status = status === "processing" ? "processing" : "needs_input";
  const extraction = draft.extractions.find((e) => e.collectionId === task.id);
  if (extraction) Object.assign(extraction, { status, hint: message });
}

export function captureFeedbackMessage({ mode, status, aiEnabled } = {}) {
  if (mode === "link") {
    if (status === "queued" || status === "processing") return "链接已收藏，正文待读取";
    if (status === "saved") return "仅收藏了链接";
    if (status === "failed" || status === "interrupted") return "链接已收藏，整理未完成";
  }
  if (mode === "text" && ["saved", "queued", "processing"].includes(status)) return "文字已收藏";
  if (status === "ready") return "收到了，理解已整理好";
  if (status === "needs_input") return "原始内容已收好，还需要补充内容";
  if (status === "needs_confirmation") return "原始内容已收好，还需要核对来源";
  if (["failed", "interrupted"].includes(status)) return "原始内容已收好，整理未完成，可稍后重试";
  if (aiEnabled === false) return "已收好原始内容，智能整理尚未连接";
  if (status === "processing") return "收到了，正在理解中";
  if (status === "queued") return "收到了，已排队等待整理";
  if (status === "saved") return "原始内容已收好，可以继续整理";
  return "提交已收到，正在确认保存状态";
}

export function collectionUnderstandingState(item = {}, extraction = {}, { aiEnabled, acceptedSummary } = {}) {
  const phase = item.status || extraction.status;
  const waiting = ["queued", "processing"].includes(phase);
  const failed = ["failed", "interrupted"].includes(phase) || ["failed", "interrupted"].includes(extraction.status);
  const needsInput = phase === "needs_input" || (!["saved", "queued", "processing"].includes(phase) && extraction.status === "needs_input");
  const hasSummary = Boolean(String(acceptedSummary || extraction.summary || "").trim());
  const hasUnderstanding = hasSummary && !waiting && !failed && !needsInput && phase !== "saved" && !["queued", "processing", "unavailable"].includes(extraction.status);
  if (hasUnderstanding) return { hasUnderstanding: true, loading: false, statusMessage: phase === "needs_confirmation" || extraction.status === "needs_confirmation" ? "已有理解，部分内容仍需核对来源。" : "已根据原始内容整理。" };
  if (waiting && aiEnabled !== false) return { hasUnderstanding: false, loading: true, title: phase === "queued" ? "等待开始整理" : "正在理解中", description: phase === "queued" ? "原始内容已经收好，任务已排队。开始整理后会自动更新。" : "原始内容已经收好，正在读取和整理。完成后会自动更新。", statusMessage: phase === "queued" ? "原始内容已保存，等待开始整理。" : "正在读取与整理原始内容…" };
  if (failed) return { hasUnderstanding: false, loading: false, canRetry: aiEnabled !== false, title: "这次整理未完成", description: "原始内容仍然保留。你可以查看处理记录，并在服务可用时重试。", statusMessage: "原始内容已保留，这次尚未取得可核对的理解。" };
  if (needsInput) return { hasUnderstanding: false, loading: false, needsInput: true, title: "还需要一些原始内容", description: "当前材料不足以形成可靠理解。可以补充正文、文字稿或具体说明，再继续整理。", statusMessage: "原始内容已保留，尚需补充材料。" };
  return { hasUnderstanding: false, loading: false, canRetry: aiEnabled !== false && phase === "saved", title: aiEnabled === false ? "已保存原始内容" : "还没有可核对的理解", description: aiEnabled === false ? "智能整理尚未连接。原始内容已保存在这台电脑，你仍可以写下收藏它的原因；连接服务后再继续整理。" : "原始内容已经收好，尚未取得摘要或要点。可以查看处理记录后继续整理。", statusMessage: aiEnabled === false ? "原始内容已保存，智能整理尚未连接。" : "原始内容已保留，理解尚未完成。" };
}
