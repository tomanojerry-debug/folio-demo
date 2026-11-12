const list = value => Array.isArray(value) ? value : [];

// Older messages record every retrieval candidate, which does not establish
// that the answer cited those collections. Only explicit attributions qualify.
export function messageReferences(message, collections = []) {
  if (message?.role !== 'assistant') return { collections: [], scopeNotice: '' };
  const available = new Map(list(collections).filter(item => item && typeof item.id === 'string').map(item => [item.id, item]));
  const ids = ['explicit_citations', 'selected_curation'].includes(message.referenceAttribution)
    ? [...new Set(list(message.relatedCollectionIds).filter(id => typeof id === 'string'))]
    : [];
  return {
    collections: ids.map(id => available.get(id)).filter(Boolean),
    scopeNotice: message.contextTruncated ? '本轮上下文较长，部分内容未纳入。' : '',
  };
}
