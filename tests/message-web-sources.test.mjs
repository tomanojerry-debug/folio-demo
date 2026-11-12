import test from 'node:test';
import assert from 'node:assert/strict';
import { messageWebSourcesText, renderMessageWebSources } from '../site/curator/message-web-sources.js';

test('web results link to the publisher and use a local WeChat icon only for its article host', () => {
  const message = { role:'assistant', webSources:[
    { title:'新模型发布', url:'https://mp.weixin.qq.com/s/example', source:'模型研究社', publishedAt:'2026-11-12', snippet:'这篇文章介绍本次更新。' },
    { title:'发布说明', url:'https://example.com/release', source:'Example' },
    { title:'参考资料', url:'https://mp.weixin.qq.com.example.com/release' },
    { title:'相关实现', url:'https://github.com/example/project' },
  ] };
  const html = renderMessageWebSources(message);
  assert.match(html, /aria-label="网页搜索结果"/);
  assert.match(html, /href="https:\/\/mp\.weixin\.qq\.com\/s\/example" data-external target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /is-wechat" aria-hidden="true"><\/span><span>模型研究社<\/span><time datetime="2026-11-12">2026-11-12<\/time>/);
  assert.equal((html.match(/is-wechat/g) || []).length, 1);
  assert.equal((html.match(/<time /g) || []).length, 1);
  assert.match(html, /aria-hidden="true">E<\/span><span>Example<\/span>/);
  assert.match(html, /<img src="\/curator\/assets\/search-sources\/github\.svg"/);
  assert.doesNotMatch(html, /<img src="https?:/);
  assert.match(messageWebSourcesText(message), /新模型发布\n模型研究社 · 2026-11-12\n这篇文章介绍本次更新。\nhttps:\/\/mp\.weixin\.qq\.com\/s\/example/);
});

test('search result text is escaped and unsafe URLs never become links', () => {
  const webSources = [
    { title:'<script>hello</script>', url:'https://example.org/?a=1&b=2', source:'<img onerror=x>', snippet:'<a href="/">test</a>' },
    { title:'unsafe-script', url:'javascript:alert(1)' },
    { title:'unsafe-credentials', url:'https://secret@example.org' },
    { title:'unsafe-file', url:'file:///tmp/test' },
  ];
  const html = renderMessageWebSources({ role:'assistant', webSources });
  assert.match(html, /&lt;script&gt;hello&lt;\/script&gt;/);
  assert.match(html, /&lt;img onerror=x&gt;/);
  assert.match(html, /&lt;a href=/);
  assert.match(html, /https:\/\/example\.org\/\?a=1&amp;b=2/);
  assert.doesNotMatch(html, /<script|<img|unsafe-|javascript:|secret@/);
  assert.equal(renderMessageWebSources({ role:'user', webSources }), '');
  assert.equal(renderMessageWebSources({ role:'assistant', webSources:[] }), '');
});
