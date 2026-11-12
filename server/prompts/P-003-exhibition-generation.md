# P-003 展览编排

## 能力提示词正文

给 theme_candidate 和 eligible_exhibits 编排一条可以阅读的路线。标题写具体问题。策展导语说明这些材料为何放在一起，章节介绍说明本节关注的区别。每章至少一个能用证据复核的判断。合计选 5 到 9 件展品，遵守 configuration 的约束，只用 eligible_exhibits 的 item_id，同一展品只出现在一个章节。章节之间要有顺序，让读者可以带着上一节的问题继续看。

事实、来源的观点、跨资料的解释和开放问题分别用 fact、extraction、hypothesis、question。证据来自选中的展品。每条跨收藏连接至少需要两件不同展品，用独立的 connection_id 标识。参照 validated_connections，同时核对原片段。curatorial_lens 填 balanced。没有证据支持的新方向可省略。结尾给一个材料尚未完全回答的问题。无法满足引用与展品数量要求时返回 waiting_for_content。

## 输出 Schema

```json
{"oneOf":[{"type":"object","properties":{"status":{"const":"candidate"},"title":{"type":"string","minLength":1},"curatorial_lens":{"const":"balanced"},"curatorial_note":{"$ref":"#/$defs/claim"},"connection_claims":{"type":"array","items":{"$ref":"#/$defs/connection"},"minItems":1},"emerging_direction":{"$ref":"#/$defs/claim"},"open_question":{"type":"string","minLength":1},"rooms":{"type":"array","items":{"type":"object","properties":{"room_id":{"type":"string","minLength":1},"title":{"type":"string","minLength":1},"introduction":{"type":"string","minLength":1},"exhibit_ids":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"maxItems":9,"uniqueItems":true},"claims":{"type":"array","items":{"$ref":"#/$defs/claim"},"minItems":1}},"required":["room_id","title","introduction","exhibit_ids","claims"],"additionalProperties":false},"minItems":1}},"required":["status","title","curatorial_lens","curatorial_note","connection_claims","open_question","rooms"],"additionalProperties":false},{"type":"object","properties":{"status":{"enum":["waiting_for_content","unable_to_curate"]},"reason_codes":{"type":"array","items":{"type":"string","minLength":1}}},"required":["status"],"additionalProperties":false}],"$defs":{"claim":{"type":"object","properties":{"text":{"type":"string","minLength":1},"statement_type":{"enum":["fact","extraction","hypothesis","question"]},"evidence_ids":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"uniqueItems":true}},"required":["text","statement_type","evidence_ids"],"additionalProperties":false},"connection":{"type":"object","properties":{"connection_id":{"type":"string","minLength":1},"text":{"type":"string","minLength":1},"statement_type":{"enum":["fact","extraction","hypothesis","question"]},"evidence_ids":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"uniqueItems":true}},"required":["connection_id","text","statement_type","evidence_ids"],"additionalProperties":false}}}
```
