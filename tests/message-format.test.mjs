import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage } from '../site/curator/message-format.js';

test('chat replies render Chinese paragraphs, emphasis and lists without visible Markdown markers', () => {
  const html = formatMessage('把喜欢的留下。\n\n- **聊收藏**：一起找联系\n- 写下 `一句话`\n\n1. 先收藏\n2. 再看展');
  assert.match(html, /<p>把喜欢的留下。<\/p>/);
  assert.match(html, /<ul><li><strong>聊收藏<\/strong>：一起找联系<\/li>/);
  assert.match(html, /<code>一句话<\/code>/);
  assert.match(html, /<ol><li>先收藏<\/li><li>再看展<\/li><\/ol>/);
  assert.doesNotMatch(html, /\*\*/);
});
test('reply formatting treats source HTML, links and fenced code as untrusted text', () => {
  const html = formatMessage('<img src=x onerror=alert(1)>\n**<script>alert(1)</script>**\n\n[jump](javascript:alert(1))\n\n```html\n<svg onload=alert(1)>\n**原样代码**\n```');
  assert.doesNotMatch(html, /<(?:img|script|svg|a)[\s>]/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<pre aria-label="代码片段"><code>&lt;svg/);
  assert.match(html, /\*\*原样代码\*\*/);
});
