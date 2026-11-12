import { normalizeWorkspaceChatRequest, workspaceChatScope } from './chat-launch.js';
import { parseVideoCaptureCommand } from './video-capture-command.js';

/** Open the full conversation surface after the initial message is durably saved. */
export function createWorkspaceChatLauncher({ api, navigate, storage, flush = async () => {}, sample = false }) {
  let inFlight = null;
  let pendingStart = null;
  const store = (key, value) => { try { storage?.setItem(key, value); } catch { /* The saved message still carries its explicit references. */ } };
  async function launch(detail) {
    if (sample) return { accepted: false, error: '这是独立示例。返回私人收藏馆后，可以和 Tag 讨论自己的收藏。' };
    try {
      const request = normalizeWorkspaceChatRequest(detail);
      await flush();
      const state = await api('state');
      workspaceChatScope(request, state);
      const hasScope = request.collectionIds.length > 0 || Boolean(request.exhibitionId);
      const startsConversation = Boolean(request.message || hasScope);
      let conversationId;
      if (startsConversation) {
        const signature = JSON.stringify([request.message, request.collectionIds, request.exhibitionId || '', request.submit]);
        if (!pendingStart || pendingStart.signature !== signature) pendingStart = { signature, requestId: request.requestId, sent: false };
        if (!pendingStart.conversationId) {
          const created = await api('conversations', {});
          if (!created.conversation?.id) throw new Error('新对话还没有创建成功，输入已保留。');
          pendingStart.conversationId = created.conversation.id;
        }
        conversationId = pendingStart.conversationId;
        if (hasScope) store(`forme.workspace-chat.scope:${conversationId}`, JSON.stringify({ collectionIds: request.collectionIds, ...(request.exhibitionId ? { exhibitionId: request.exhibitionId } : {}) }));
        if (request.submit && !pendingStart.sent) {
          const videoCapture = !hasScope && parseVideoCaptureCommand(request.message);
          await api('messages', { text: request.message, conversationId, requestId: pendingStart.requestId,
            ...(!videoCapture ? { intent: 'chat', collectionIds: request.collectionIds, ...(request.exhibitionId ? { exhibitionId: request.exhibitionId } : {}) } : {}) });
          pendingStart.sent = true;
        } else if (!request.submit && request.message) store(`forme.workspace-chat.draft:${conversationId}`, request.message);
      } else {
        const conversations = Array.isArray(state.conversations) ? state.conversations : [];
        conversationId = conversations.find(item => item.id === state.surfaceSessions?.workspace?.conversationId)?.id
          || conversations.find(item => item.id === state.activeConversationId)?.id
          || [...conversations].sort((a,b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]?.id;
        if (conversationId) await api('conversations/select', { conversationId });
        else conversationId = (await api('conversations', {})).conversation?.id;
      }
      if (!conversationId) throw new Error('对话暂时没有打开，请稍后再试。');
      await navigate(`/prototype/immersive-exhibition/light.html?conversation=${encodeURIComponent(conversationId)}#chat`);
      pendingStart = null;
      return { accepted: true, conversationId };
    } catch (error) {
      return { accepted: false, error: error?.message || '对话暂时没有打开，输入已保留，请重试。' };
    }
  }
  return detail => {
    if (inFlight) return inFlight;
    inFlight = launch(detail || {}).finally(() => { inFlight = null; });
    return inFlight;
  };
}
