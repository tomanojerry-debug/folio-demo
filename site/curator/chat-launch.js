/** Only identifiers and a user-written draft cross the workspace/chat boundary. */
export function normalizeWorkspaceChatRequest(value, requestId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('请从收藏馆重新打开对话。');
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  if (message.length > 60000) throw new TypeError('问题太长，请缩短到 60000 字以内。');
  const ids = value.collectionIds === undefined ? [] : value.collectionIds;
  if (!Array.isArray(ids) || ids.length > 6 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 150)) throw new TypeError('请最多选择 6 条收藏一起讨论。');
  const exhibitionId = value.exhibitionId;
  if (exhibitionId !== undefined && (typeof exhibitionId !== 'string' || !exhibitionId.trim() || exhibitionId.length > 150)) throw new TypeError('展览关联已失效，请重新打开。');
  const identifier = requestId || value.requestId || globalThis.crypto.randomUUID();
  if (typeof identifier !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(identifier)) throw new TypeError('对话请求已失效，请重新打开。');
  const expiresAt = value.expiresAt === undefined ? Date.now() + 12000 : value.expiresAt;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 15000) throw new TypeError('对话请求已过期，问题仍在收藏馆，请重新发送。');
  return { requestId: identifier, expiresAt, message, collectionIds: [...new Set(ids)], ...(exhibitionId ? { exhibitionId } : {}), submit: value.submit === true && Boolean(message) };
}

export function workspaceChatScope(request, state) {
  const collections = Array.isArray(state?.collections) ? state.collections : [];
  const exhibitions = Array.isArray(state?.exhibitions) ? state.exhibitions : [];
  if (request.collectionIds.some(id => !collections.some(item => item.id === id))) throw new TypeError('关联的收藏暂时不可用，请刷新收藏馆后再试。');
  const exhibition = request.exhibitionId && exhibitions.find(item => item.id === request.exhibitionId);
  if (request.exhibitionId && !exhibition) throw new TypeError('关联的展览暂时不可用，请刷新收藏馆后再试。');
  const titles = request.collectionIds.map(id => collections.find(item => item.id === id)?.title || '未命名收藏');
  return { collectionIds: request.collectionIds, ...(request.exhibitionId ? { exhibitionId: request.exhibitionId } : {}), title: exhibition?.title || (titles.length === 1 ? titles[0] : titles.length ? `${titles.length} 条收藏` : '我的收藏馆') };
}
