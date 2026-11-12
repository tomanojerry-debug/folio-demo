import { taskProgressItems } from './task-view.js';

export const CHAT_REPLY_PENDING = '正在整理回复…';

const list = value => Array.isArray(value) ? value : [];
const failedCollection = item => ['failed','needs_input','interrupted'].includes(item?.status);
const subject = type => ({chat:'这段回答',ingest:'这件收藏',revise:'这段理解',curate:'这场展览','curate-selected':'这张专题'})[type] || '这次整理';

/** Natural conversation cues only. Callers pass conversation-filtered data. */
export function conversationActivity({jobs=[],messages=[],collections=[],busy=false,capturing=false}={}) {
  // Use the same retry-chain reduction as the management view, while keeping
  // its cards, execution steps and completed-task labels out of conversations.
  const latest = taskProgressItems(list(jobs).map(job => job.status === 'interrupted' ? {...job,status:'failed',errorCode:'INTERRUPTED'} : job)).map(item=>item.job);
  const active = latest.filter(job=>['queued','running'].includes(job.status));
  const current = active.findLast(job=>job.type==='chat') || active.at(-1);
  let pending = '';
  if (busy) pending = capturing ? '我在确认这页的内容…' : '消息正在发送…';
  else if (current?.webSearch) pending = '正在搜索网页…';
  else if (current) pending = current.sourceRefresh ? '我在重新读取原文…' : ({
    chat:CHAT_REPLY_PENDING,
    ingest:'我在整理刚收下的内容…',
    revise:'我在重新看看这段理解…',
    curate:'我在把这些收藏整理成一场展览…',
    'curate-selected':'正在整理你指定的收藏…',
  })[current.type] || '我在接着整理…';

  const recoveries = [];
  for (const job of latest) {
    if (job.status !== 'failed') continue;
    const collection = list(collections).find(item=>item.id===job.collectionId);
    const receipt = job.collectionId && failedCollection(collection) && list(messages).some(message=>list(message.collectionIds).includes(job.collectionId));
    if (receipt) continue;
    const error = typeof job.error === 'string' ? job.error.trim() : '';
    const reply = error && list(messages).findLast(message=>message.role==='assistant'
      && (message.jobId===job.id || (job.messageId && message.sourceMessageId===job.messageId))
      && String(message.text || message.content || '').trim()===error);
    if (job.webSearch) {
      recoveries.push({jobId:job.id,messageId:reply?.id || '',description:reply ? '' : '这次网页搜索未完成。',retryLabel:'重新搜索',ariaLabel:'重新搜索网页'});
      continue;
    }
    const topic = subject(job.type);
    const description = reply ? '' : job.errorCode==='INTERRUPTED'
      ? `${topic}刚才中断了，已有内容会保留。`
      : `${topic}还没完成，已有内容会保留。`;
    recoveries.push({jobId:job.id,messageId:reply?.id || '',description,retryLabel:'继续整理',ariaLabel:`继续整理${topic}`});
  }
  return {pending,recoveries};
}
