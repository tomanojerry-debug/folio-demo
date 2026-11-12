const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value : "";

export function isSimilarityQuestion(value) {
  const query = text(value);
  if (/(?:不要|不用|别|无需|不必|不想|不需要)[^，,。.!！？?;；\n]{0,12}(?:类似|相似|推荐|同类)|\b(?:do not|don't|no need to)\b[^,.!?;\n]{0,30}\b(?:similar|related|recommend)/iu.test(query)) return false;
  if (/(?:是什么意思|什么含义|如何理解|怎么理解|解释这|解释一下)|\b(?:what does|what is meant by|explain (?:the|this))\b/iu.test(query) && !/(?:帮我找|推荐几|列出几|找几)|\b(?:find|recommend|list)\b/iu.test(query)) return false;
  return /(?:找|查|搜|推荐|列出).{0,20}(?:类似|相似|同类)|(?:类似|相似|像这(?:篇|条)).{0,25}(?:有哪些|哪些|有没有|还有|文章|内容|收藏|资料)|^(?:和|跟|与)这(?:篇|条).{0,10}(?:类似|相似)[？?。\s]*$|\b(?:find|show|recommend|suggest|search|list)\b.{0,50}\b(?:similar|related)\b|\b(?:similar|related)\s+(?:articles|documents|collections)\b|\blike this\b/iu.test(query);
}

export function similarityAnchor(message, state) {
  if (!isSimilarityQuestion(message?.text)) return null;
  return resolveAnchor(message, state);
}

export function isConnectionQuestion(value) {
  const query = text(value);
  if (/(?:不要|不用|别|无需|不必|不需要)[^，,。.!！？?;；\n]{0,12}(?:关联|关系|相关)|\b(?:do not|don't|no need to)\b[^,.!?;\n]{0,30}\b(?:connections?|related)/iu.test(query)) return false;
  if (/(?:是什么意思|什么含义|如何理解|怎么理解|解释这|解释一下)|\b(?:what does|what is meant by|explain (?:the|this))\b/iu.test(query)) return false;
  return /(?:查看|看看|查找|寻找|找|列出|展示).{0,12}(?:关联|共同主题)|(?:这篇|这条|这份|文章|收藏).{0,25}(?:和|与|跟|有).{0,15}(?:哪些|什么|其他).{0,15}(?:关联|相关|联系)|(?:关联|相关|共同主题).{0,15}(?:文章|收藏|资料).{0,12}(?:哪些|有哪些|还有)|\b(?:show|find|list)\b.{0,30}\bconnections?\b|\bwhat\b.{0,15}\bconnected to\b/iu.test(query);
}

export function connectionAnchor(message, state) {
  return isConnectionQuestion(message?.text) ? resolveAnchor(message, state) : null;
}

function resolveAnchor(message, state) {
  const explicit = list(message.workspaceContext?.collectionIds);
  if (explicit.length === 1) return explicit[0];
  if (explicit.length > 1) return null;
  const value = text(message.text).normalize("NFKC").toLowerCase();
  const matches = list(state?.collections).filter(item => {
    const title = text(item.title).normalize("NFKC").toLowerCase();
    return (title.length >= 4 && value.includes(title)) || (item.url && (value.includes(item.url.toLowerCase()) || message.context?.url === item.url));
  });
  return matches.length === 1 ? matches[0].id : null;
}

/** Project actual read chunks into the existing bounded conversation contract. */
export function knowledgeReferences(hits, state) {
  const byId = new Map(list(state?.collections).map(item => [item.id, item]));
  const seen = new Set();
  return list(hits).flatMap(hit => {
    const item = byId.get(hit.collectionId);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    const blocked = ["pending_rewrite", "confirmed_edited"].includes(state.workspace?.feedback?.[`understanding:${item.id}`]?.decision);
    const ready = !blocked && item.status === "ready" && hit.understandingRevision === (item.extraction?.revision || 1)
      && hit.sourceRevision === (item.sourceRevision || 1)
      && (!item.understandingDocumentVersionId || item.understandingDocumentVersionId === hit.documentVersionId);
    const chunks = blocked ? [] : list(hit.chunks).filter(chunk => text(chunk.text));
    const summary = blocked ? "这条收藏的理解正在等待核对，不能复用旧摘要或旧理解证据。"
      : ready ? text(hit.summary) : hit.documentVersionId ? "原文已保留；智能整理尚未完成或对应旧版本，以下仅提供本轮读取的原文片段。" : "尚未取得可读取的原文，不能推断正文内容。";
    return [{
      id: item.id,
      title: text(hit.title || item.title).slice(0, 300),
      url: text(hit.url || item.url).slice(0, 4000),
      status: blocked ? "needs_confirmation" : text(item.status) || "unknown",
      understandingStatus: ready ? "ready" : "not_ready",
      understandingRevision: ready ? hit.understandingRevision : null,
      documentVersionId: hit.documentVersionId || null,
      sourceRevision: hit.sourceRevision ?? null,
      sourceKind: hit.sourceKind || "body_text",
      summary: summary.slice(0, 1200),
      summaryExcerpt: summary.length > 1200,
      evidenceStatus: chunks.length ? "available" : "not_available",
      evidence: chunks.slice(0, 2).map(chunk => ({
        evidence_id: text(chunk.evidence_id || chunk.chunkId).slice(0, 200),
        locator: text(chunk.locator).slice(0, 200),
        text: chunk.text.slice(0, 800),
        excerpt: Boolean(chunk.excerpt || chunk.text.length > 800),
      })),
      ...(hit.similarityTo ? { similarityTo: hit.similarityTo, matchReasons: list(hit.matchReasons).slice(0, 3).map(reason => text(reason).slice(0, 100)) } : {}),
      ...(hit.connectionTo ? {
        connectionTo:text(hit.connectionTo).slice(0, 150),
        relationType:hit.relationType === "shared_concept" ? "shared_concept" : "related_topic",
        sharedConcepts:list(hit.sharedConcepts).slice(0, 2).map(concept => text(concept.name).slice(0, 100)),
        connectionAnchorDocumentVersionId:hit.connectionAnchorDocumentVersionId || null,
        connectionAnchorSourceRevision:hit.connectionAnchorSourceRevision || null,
        connectionAnchorUnderstandingRevision:hit.connectionAnchorUnderstandingRevision || null,
        matchReasons:list(hit.matchReasons).slice(0, 3).map(reason => text(reason).slice(0, 100)),
      } : {}),
    }];
  });
}

/** Recheck feedback and version bindings immediately before model dispatch. */
export function protectKnowledgeReferences(references, state) {
  const byId = new Map(list(state?.collections).map(item => [item.id, item]));
  return list(references).flatMap(reference => {
    const item = byId.get(reference.id);
    if (!item) return [];
    if (reference.connectionTo) {
      const anchor = byId.get(reference.connectionTo);
      if (!anchor || ["pending_rewrite", "confirmed_edited"].includes(state.workspace?.feedback?.[`understanding:${anchor.id}`]?.decision)) return [];
      if (reference.connectionAnchorDocumentVersionId && anchor.knowledgeDocumentVersionId && reference.connectionAnchorDocumentVersionId !== anchor.knowledgeDocumentVersionId) return [];
      if (reference.connectionAnchorSourceRevision && reference.connectionAnchorSourceRevision < (anchor.sourceRevision || 1)) return [];
      if (reference.relationType === "shared_concept" && (anchor.status !== "ready" || item.status !== "ready"
        || anchor.extraction?.status !== "qualified" || item.extraction?.status !== "qualified"
        || reference.connectionAnchorUnderstandingRevision !== (anchor.extraction.revision || 1)
        || reference.understandingRevision !== (item.extraction.revision || 1)
        || (anchor.understandingDocumentVersionId && anchor.understandingDocumentVersionId !== reference.connectionAnchorDocumentVersionId)
        || (item.understandingDocumentVersionId && item.understandingDocumentVersionId !== reference.documentVersionId))) return [];
    }
    if (reference.documentVersionId && item.knowledgeDocumentVersionId && reference.documentVersionId !== item.knowledgeDocumentVersionId) return [];
    if (reference.sourceRevision && reference.sourceRevision < (item.sourceRevision || 1)) return [];
    const blocked = ["pending_rewrite", "confirmed_edited"].includes(state.workspace?.feedback?.[`understanding:${item.id}`]?.decision);
    if (blocked && reference.connectionTo) return [];
    if (blocked) return [{ ...reference, status:"needs_confirmation", understandingStatus:"not_ready", understandingRevision:null,
      summary:"这条收藏的理解正在等待核对，不能复用旧摘要或旧理解证据。", summaryExcerpt:false, evidence:[], evidenceStatus:"not_available" }];
    const current = item.status === "ready" && item.extraction?.status === "qualified"
      && reference.understandingRevision === (item.extraction.revision || 1)
      && (!item.understandingDocumentVersionId || item.understandingDocumentVersionId === reference.documentVersionId);
    if (reference.understandingStatus === "ready" && !current) return [{ ...reference, status:item.status, understandingStatus:"not_ready", understandingRevision:null,
      summary:"原文片段已提供；本轮不复用旧版智能理解。", summaryExcerpt:false }];
    return [reference];
  });
}
