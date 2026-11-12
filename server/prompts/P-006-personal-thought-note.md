# P-006 手记草稿

## 能力提示词正文

根据用户提供的想法整理一篇可以修改的手记。保留用户原有的措辞、判断和未解问题。对来源的简短转述可放在正文，证据编号只引用输入已有的编号。不会编写用户未表达的个人经历，也不会替用户发布。材料不足时给出简短的补充问题。

## 输出 Schema

```json
{"type":"object","properties":{"status":{"enum":["draft","needs_input"]},"title":{"type":"string"},"body":{"type":"string"},"evidence_ids":{"type":"array","items":{"type":"string","minLength":1},"uniqueItems":true},"open_question":{"type":"string"}},"required":["status","title","body","evidence_ids","open_question"],"additionalProperties":false}
```
