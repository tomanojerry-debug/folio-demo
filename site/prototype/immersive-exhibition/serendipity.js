// Serendipity 随机漫游：纯逻辑（候选池构建 / 随机洗牌 / 决策持久化键）。
// 与 DOM 无关，便于在 Node 测试中直接验证。

export function buildSerendipityCandidates({ ready, exhibition, directions, collections }) {
  const candidates = [];
  if (ready && exhibition) {
    const members = (exhibition.sourceCollectionIds || [])
      .map((id) => collections.find((item) => item.id === id))
      .filter(Boolean);
    candidates.push({
      id: exhibition.id,
      kind: "exhibition",
      title: exhibition.title,
      subtitle: exhibition.subtitle || "",
      meta: exhibition.meta || "",
      cover: exhibition.cover || "",
      tags: exhibition.tags || ["已就绪"],
      members,
    });
  }
  for (const direction of directions || []) {
    const members = (direction.members || [])
      .map((id) => collections.find((item) => item.id === id))
      .filter(Boolean);
    const anchor = members.find((item) => item.thumbnail) ?? members[0];
    candidates.push({
      id: direction.tag,
      kind: "direction",
      title: direction.tag,
      subtitle: "正在形成 · 你的收藏正在共同指向这个方向",
      meta: `${members.length} 条收藏 · 展览还在成形`,
      cover: anchor?.thumbnail || "",
      tags: ["正在形成", ...(direction.evidence || []).slice(0, 3)],
      members,
    });
  }
  return candidates;
}

export function shuffleCandidates(candidates) {
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function serendipityDecisionKey(candidate) {
  return `serendipity:${candidate.kind}:${candidate.id}`;
}

export function serendipityDecision(feedback, candidate) {
  return feedback?.[serendipityDecisionKey(candidate)] ?? null;
}

export function applySerendipityDecision(feedback, candidate, decision, now = new Date().toISOString()) {
  return { ...feedback, [serendipityDecisionKey(candidate)]: { decision, updatedAt: now } };
}
