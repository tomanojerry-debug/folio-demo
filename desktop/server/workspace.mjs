const rowFields = {
  exhibitionNotes: ["id", "kind", "content", "image", "images", "comment", "exhibitId", "exhibitTitle", "exhibitionId", "exhibitionTitle", "chapter", "chapterTitle", "source", "createdAt", "updatedAt"],
  exhibitionRecords: ["id", "exhibitionId", "exhibitionTitle", "createdAt", "updatedAt", "content", "images"],
  studioNotes: ["id", "exhibitionId", "exhibitionTitle", "title", "status", "cover", "updatedAt", "citations", "readingSource", "blocks", "body", "createdAt"],
  themes: ["id", "title", "status", "evidenceCount", "exhibitionId", "noteId"],
  exhibitionProgress: ["id", "status", "viewed", "revealed", "completed", "recommendationDecision"],
};
const feedbackFields = ["decision", "userSelected", "originalSummary", "acceptedSummary", "correctionPrompt", "reviewedAt", "revision", "acceptedTags", "tagsReviewedAt", "dismissed", "kept", "updatedAt", "value", "disputed", "correction"];
const invalid = () => Object.assign(new Error("只能保存个人备注、反馈和阅读记录，不能覆盖 AI 内容或处理任务。"), { code: "INVALID_WORKSPACE_PATCH", statusCode: 400 });
const safeKey = (key) => typeof key === "string" && key.length > 0 && key.length <= 300 && !["__proto__", "prototype", "constructor"].includes(key);
function safeJSON(value, depth = 0) {
  if (depth > 10) throw invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (value.length > 2_500_000 || value.includes("\0")) throw invalid(); return; }
  if (typeof value === "number") { if (!Number.isFinite(value)) throw invalid(); return; }
  if (Array.isArray(value)) { if (value.length > 1000) throw invalid(); value.forEach((item) => safeJSON(item, depth + 1)); return; }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  for (const [key, item] of Object.entries(value)) { if (!safeKey(key)) throw invalid(); safeJSON(item, depth + 1); }
}

export function emptyWorkspace() {
  return { feedback: {}, notes: {}, collectionCategories: {}, exhibitionNotes: [], exhibitionRecords: [], studioNotes: [], themes: [], exhibitionProgress: [] };
}

export function applyWorkspacePatch(state, body) {
  if (!body || Object.keys(body).some((key) => key !== "ops") || !Array.isArray(body.ops) || body.ops.length > 500) throw invalid();
  const workspace = state.workspace ||= emptyWorkspace();
  for (const op of body.ops) {
    if (!op || Object.keys(op).some((key) => !["field", "key", "value", "delete"].includes(key)) || !safeKey(op.key)) throw invalid();
    if (op.delete !== undefined && typeof op.delete !== "boolean") throw invalid();
    if (!op.delete) safeJSON(op.value);
    if (["feedback", "notes", "collectionCategories"].includes(op.field)) {
      if (op.field !== "feedback" && !state.collections.some((item) => item.id === op.key)) throw invalid();
      if (!op.delete && op.field === "feedback" && (!op.value || Array.isArray(op.value) || typeof op.value !== "object" || Object.keys(op.value).some((key) => !feedbackFields.includes(key)))) throw invalid();
      if (!op.delete && op.field !== "feedback" && (typeof op.value !== "string" || op.value.length > (op.field === "notes" ? 10000 : 100))) throw invalid();
      workspace[op.field] ||= {};
      if (op.delete) delete workspace[op.field][op.key];
      else workspace[op.field][op.key] = structuredClone(op.value);
    } else if (Object.hasOwn(rowFields, op.field)) {
      if (!op.delete && (!op.value || typeof op.value !== "object" || Array.isArray(op.value) || op.value.id !== op.key || Object.keys(op.value).some((key) => !rowFields[op.field].includes(key)))) throw invalid();
      const rows = workspace[op.field] ||= [];
      const index = rows.findIndex((row) => row.id === op.key);
      if (op.delete) { if (index >= 0) rows.splice(index, 1); }
      else if (index >= 0) rows[index] = structuredClone(op.value);
      else rows.unshift(structuredClone(op.value));
    } else throw invalid();
  }
}
