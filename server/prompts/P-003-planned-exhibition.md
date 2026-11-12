# P-003 已指定展品的展览文案

## 能力提示词正文

room_plan 已固定展品与顺序。按该计划给出单个 room_narrative，撰写标题、简短介绍和一组 claims。所有计划内的展品都必须被 claims 的证据覆盖。只使用这些展品的证据。不要返回 rooms、exhibit_ids、dialogue_nodes 或其他用于改变布局的字段。

用策展导语解释材料合在一起能让读者看到什么。每条 connection_claim 至少引用两件展品，且 connection_id 不重复。根据原文标记事实、作者观点、策展假设或问题。curatorial_lens 必须为 balanced。用 open_question 留下一个可继续追问的问题。没有足够证据写全时，返回 waiting_for_content 或 unable_to_curate。

## 输出 Schema

```json
{"oneOf":[{"type":"object","properties":{"status":{"const":"candidate"},"title":{"type":"string","minLength":1},"curatorial_lens":{"const":"balanced"},"curatorial_note":{"$ref":"#/$defs/claim"},"connection_claims":{"type":"array","items":{"$ref":"#/$defs/connection"},"minItems":1},"emerging_direction":{"$ref":"#/$defs/claim"},"open_question":{"type":"string","minLength":1},"room_narrative":{"type":"object","properties":{"title":{"type":"string","minLength":1},"introduction":{"type":"string","minLength":1},"claims":{"type":"array","items":{"$ref":"#/$defs/claim"},"minItems":1}},"required":["title","introduction","claims"],"additionalProperties":false}},"required":["status","title","curatorial_lens","curatorial_note","connection_claims","room_narrative"],"additionalProperties":false},{"type":"object","properties":{"status":{"enum":["waiting_for_content","unable_to_curate"]},"reason_codes":{"type":"array","items":{"type":"string","minLength":1}}},"required":["status"],"additionalProperties":false}],"$defs":{"claim":{"type":"object","properties":{"text":{"type":"string","minLength":1},"statement_type":{"enum":["fact","extraction","hypothesis","question"]},"evidence_ids":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"uniqueItems":true}},"required":["text","statement_type","evidence_ids"],"additionalProperties":false},"connection":{"type":"object","properties":{"connection_id":{"type":"string","minLength":1},"text":{"type":"string","minLength":1},"statement_type":{"enum":["fact","extraction","hypothesis","question"]},"evidence_ids":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"uniqueItems":true}},"required":["connection_id","text","statement_type","evidence_ids"],"additionalProperties":false}}}
```
