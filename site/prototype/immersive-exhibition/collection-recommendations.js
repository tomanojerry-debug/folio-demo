/** The original tag co-occurrence recommendation, shared by both home views. */
export function collectionDirections(collections = [], extractions = [], { feedback = {}, limit = 4 } = {}) {
  const ids = new Set(collections.map(item => item.id));
  const counts = new Map();
  for (const extraction of extractions) {
    if (!ids.has(extraction.collectionId)) continue;
    const review = feedback[`understanding:${extraction.collectionId}`];
    if (review?.userSelected && review.decision === "pending_rewrite") continue;
    for (const tag of extraction.tags || []) {
      if (typeof tag !== "string" || !tag.trim()) continue;
      if (!counts.has(tag)) counts.set(tag, new Set());
      counts.get(tag).add(extraction.collectionId);
    }
  }
  return [...counts.entries()]
    .filter(([, members]) => members.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, members]) => ({
      tag,
      members: [...members],
      evidence: [tag, ...[...counts.entries()]
        .filter(([other, set]) => other !== tag && set.size >= 2 && [...set].every(id => members.has(id)))
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, 2).map(([other]) => other)],
    }));
}

export function recommendedCollections(collections, extractions, { feedback = {}, excludeId, limit = 2 } = {}) {
  if (limit <= 0) return [];
  const selected = [], seen = new Set();
  for (const direction of collectionDirections(collections, extractions, { feedback, limit: Number.MAX_SAFE_INTEGER })) {
    if (feedback[`insight:${direction.tag}`]?.dismissed) continue;
    const members = collections.filter(item => direction.members.includes(item.id) && item.id !== excludeId && !seen.has(item.id));
    const item = members.find(item => item.thumbnail) || members[0];
    if (!item) continue;
    selected.push({ ...direction, item });
    seen.add(item.id);
    if (selected.length >= limit) break;
  }
  return selected;
}

const escape = (value = "") => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

/** The original Recommend card, used by the original rail and the desktop rail. */
export function renderRecommendationCard(recommendation, state, { artwork = {}, typeLabel = "内容" } = {}) {
  const { item, tag, members } = recommendation;
  if (!item) return "";
  const extraction = state.extractions?.find(entry => entry.collectionId === item.id) || item.extraction;
  const image = artwork[item.id] || item.thumbnail || "";
  const summary = recommendation.summary || extraction?.summary || item.title;
  const tags = [...new Set([...(extraction?.tags || []), ...(extraction?.concepts || [])])].slice(0, 3);
  const category = state.collectionCategories?.[item.id] || "未分类";
  return `<figure class="circular-card" data-action="open-collection" data-collection-id="${escape(item.id)}" data-tag="${escape(tag)}" data-members="${escape(members.join(","))}" tabindex="0" role="button" aria-label="查看推荐收藏：${escape(item.title)}"><div class="circular-media${image ? "" : " no-image"}">${image ? `<img src="${escape(image)}" alt="" loading="lazy"/>` : `<span aria-hidden="true">${escape([...tag][0] || "✦")}</span>`}</div><figcaption><header class="circular-card__identity"><small>${escape(item.source || "我的收藏")} · ${escape(typeLabel)}</small><strong data-category-label data-collection-id="${escape(item.id)}">${escape(category)}</strong></header><div class="circular-card__ability"><strong>${escape(item.title)}</strong></div><p>${escape(summary)}</p>${tags.length ? `<div class="recommend-focus-tags">${tags.map(tag => `<span>${escape(tag)}</span>`).join("")}</div>` : ""}</figcaption><i class="circular-holo" aria-hidden="true"></i></figure>`;
}
