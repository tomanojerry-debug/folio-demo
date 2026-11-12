# P-002 收藏主题

## 能力提示词正文

从 eligible_extractions 中找出一个有材料支持、值得比较的主题。主题应能提出一个具体的问题或区别，不能只重复共同标签。主题的 evidence_ids 必须覆盖至少三条不同收藏，并覆盖 candidate_item_ids 中至少 60% 的条目。每条连接至少引用两条不同收藏中的证据，说明材料在什么细节上相互印证、补充或冲突。为连接给出本次输出内唯一的 connection_id。

forming_themes、confirmed_themes 和 explicit_feedback_constraints 提供上下文。避开 rejected_hidden_forgotten_themes。collection_activity_facts 不可用时不描述收藏习惯或动机。如果没有符合条件的主题，返回 waiting_for_content 和空 themes。

## 输出 Schema

```json
{"oneOf":[{"type":"object","properties":{"status":{"const":"candidate"},"themes":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string","minLength":1},"description":{"type":"string","minLength":1},"evidence_ids":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"uniqueItems":true},"connections":{"type":"array","items":{"type":"object","properties":{"connection_id":{"type":"string","minLength":1},"text":{"type":"string","minLength":1},"evidence_ids":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"uniqueItems":true}},"required":["connection_id","text","evidence_ids"],"additionalProperties":false},"minItems":1}},"required":["title","description","evidence_ids","connections"],"additionalProperties":false},"minItems":1,"maxItems":3}},"required":["status","themes"],"additionalProperties":false},{"type":"object","properties":{"status":{"const":"waiting_for_content"},"themes":{"const":[]}},"required":["status","themes"],"additionalProperties":false}]}
```
