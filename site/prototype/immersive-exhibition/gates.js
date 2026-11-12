function gate(id, title, passed, detail, reasonCode = null) {
  return { id, title, passed, detail, reasonCode };
}

export function evaluateCurationGates({ collections, extractions, exhibition }) {
  const readyIds = new Set(collections.filter((item) => item.status === "ready").map((item) => item.id));
  const qualified = extractions.filter((item) => readyIds.has(item.collectionId) && item.reliability >= 0.75 && item.evidence);
  const gate1 = gate("GATE-001", "内容理解可靠", qualified.length >= 6, `${qualified.length}/6 条收藏达到 0.75 且具有证据`, "insufficient_qualified_content");

  const supportRate = collections.length ? qualified.length / collections.length : 0;
  const gate2 = gate("GATE-002", "主题证据充分", qualified.length >= 3 && supportRate >= 0.6, `${qualified.length} 条支持，支持率 ${Math.round(supportRate * 100)}%`, "theme_under_supported");

  const connections = exhibition?.rooms?.map((room) => room.connection) ?? [];
  const validConnections = connections.filter((connection) => connection.evidenceIds?.length >= 2 && connection.score >= 4);
  const gate3 = gate("GATE-003", "连接可信", connections.length > 0 && validConnections.length === connections.length, `${validConnections.length}/${connections.length} 条连接双侧有据且评分不低于 4/5`, "connection_unreliable");

  const exhibits = exhibition?.rooms?.flatMap((room) => room.exhibits) ?? [];
  const uniqueExhibits = new Set(exhibits.map((item) => item.id));
  const gate4Passed = exhibits.length >= 5 && exhibits.length <= 9 && uniqueExhibits.size === exhibits.length && exhibition?.status === "ready";
  const gate4 = gate("GATE-004", "展览发布完整", gate4Passed, `${exhibits.length} 件展品，引用与推断标签已检查`, "exhibition_not_publishable");

  const gates = [gate1, gate2, gate3, gate4];
  const failed = gates.find((item) => !item.passed);
  return { status: failed ? "blocked" : "passed", gates, blockedBy: failed?.id ?? null };
}
