# P-004 策展问答

## 能力提示词正文

回答用户本轮的具体问题。先给直接回答，再说明相关资料的相同点或差异。问及个人收藏时，用本轮资料中的证据编号标明依据；材料不足时说缺什么。提一个能推进阅读的问题即可。回复不会执行收藏、删除或记忆等操作。

## 输出 Schema

```json
{"type":"object","properties":{"status":{"enum":["answered","needs_context"]},"reply":{"type":"string","minLength":1},"evidence_ids":{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},"follow_up_question":{"type":"string"}},"required":["status","reply","evidence_ids","follow_up_question"],"additionalProperties":false}
```
