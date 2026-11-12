import { mountChatController } from './main.js';

const mounted = new WeakMap();
let templateRequest, stylesheetRequest;

function loadStyles() {
  if (stylesheetRequest) return stylesheetRequest;
  stylesheetRequest = new Promise((resolve,reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/curator/conversation-component.css';
    link.dataset.conversationStyles = 'true';
    link.addEventListener('load',resolve,{once:true});
    link.addEventListener('error',() => reject(new Error('聊天界面样式暂时没有加载好，请重试。')),{once:true});
    document.head.append(link);
  }).catch(error => { stylesheetRequest = null; throw error; });
  return stylesheetRequest;
}

function loadTemplate() {
  if (!templateRequest) templateRequest = fetch('/curator/',{credentials:'same-origin'})
    .then(response => { if (!response.ok) throw new Error('聊天界面暂时没有加载好，请重试。'); return response.text(); })
    .then(html => {
      const source = new DOMParser().parseFromString(html,'text/html');
      return ['chat-panel','profile-dialog','toast'].map(id => {
        const node = source.getElementById(id);
        if (!node) throw new Error('聊天界面还没有准备好，请重试。');
        return node;
      });
    }).catch(error => { templateRequest = null; throw error; });
  return templateRequest;
}

/**
 * Mount once in a persistent sibling of #app. The caller owns routes, history,
 * service subscriptions and the containing workspace; this controller owns only
 * its chat/profile/reference DOM. update() never calls onState, preventing loops.
 */
export async function mountEmbeddedConversation(host, callbacks = {}) {
  if (mounted.has(host)) return mounted.get(host);
  const mounting = (async () => {
    const [nodes] = await Promise.all([loadTemplate(),loadStyles()]);
    const root = document.createElement('div');
    root.className = 'conversation-surface';
    root.dataset.chatController = 'true';
    root.hidden = host.hidden;
    root.append(...nodes.map(node => document.importNode(node,true)));
    host.append(root);
    const controller = await mountChatController(root,{...callbacks,embedded:true});
    return {
      update: controller.update,
      select: controller.select,
      create: controller.create,
      setVisible(visible) {
        if (visible) { host.hidden = false; controller.setVisible(true); }
        else { controller.setVisible(false); host.hidden = true; }
      },
      destroy() { controller.destroy(); root.remove(); mounted.delete(host); },
    };
  })().catch(error => { mounted.delete(host); throw error; });
  mounted.set(host,mounting);
  return mounting;
}
