// Retrieval candidates remain in the context manifest for auditing. Only an
// explicit citation to a source supplied this turn can become a shown reference.
export const CITATION_RULES = "直接回答当前问题，不要无故提起收藏。collections 只是候选资料，不等于引用。仅在依据本轮某条收藏作答时，在对应句后加 [[collection:该条完整id]]，只许使用本轮 collections 中的 id。未使用收藏则不加；不要沿用历史 id、单列引用清单或向用户解释标记。应用会处理标记。";

export function parseCollectionCitations(value, allowedIds, maxChars = 16000) {
  const allowed = new Set(allowedIds);
  const relatedCollectionIds = [];
  const seen = new Set();
  const marker = /\[\[collection:([^\]\r\n]*)\]\]/g;
  const input = value.trim();
  let text = "", cursor = 0;
  // Cap the visible body while parsing, so citations in a discarded tail cannot
  // appear below a shorter answer. The provider already bounds model output.
  for (const match of input.matchAll(marker)) {
    const segment = input.slice(cursor, match.index);
    if (text.length + segment.length > maxChars) {
      text += segment.slice(0, maxChars - text.length);
      return { text: text.trim(), relatedCollectionIds };
    }
    text += segment;
    const id = match[1];
    if (text.trim() && allowed.has(id) && !seen.has(id)) {
      seen.add(id);
      relatedCollectionIds.push(id);
    }
    cursor = match.index + match[0].length;
  }
  // A provider token limit may cut off its final marker. Never show protocol
  // fragments or infer a source from a partial ID.
  let tail = input.slice(cursor);
  const opening = tail.lastIndexOf("[[");
  if (opening >= 0) {
    const fragment = tail.slice(opening + 2);
    if ("collection:".startsWith(fragment) || fragment.startsWith("collection:")) tail = tail.slice(0, opening);
  }
  text += tail.slice(0, maxChars - text.length);
  return { text: text.trim(), relatedCollectionIds };
}
