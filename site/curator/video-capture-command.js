const urlToken = /(https?:\/\/[^\s<>"'“”‘’「」『』`。！？]+?)/.source;
const action = String.raw`(?:(?:请帮我|帮我|请|麻烦你)\s*)?(?:收藏|保存|收下|收好)(?:一下)?\s*(?:(?:这个|这段|这条)?视频(?:的?(?:内容|字幕|文字稿))?|字幕|逐字稿|文字稿)(?:一下|吧)?`;
const separator = String.raw`(?:\s*[+＋:：,，]\s*|\s+)`;
const urlFirst = new RegExp(`^${urlToken}${separator}${action}[。！!]?$`, 'iu');
const actionFirst = new RegExp(`^${action}${separator}${urlToken}[。！!]?$`, 'iu');

export function parseVideoCaptureCommand(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const raw = (urlFirst.exec(text) || actionFirst.exec(text))?.[1];
  if (!raw || raw.endsWith('?')) return '';
  try {
    const url = new URL(raw);
    return url.username || url.password ? '' : raw;
  } catch {
    return '';
  }
}
