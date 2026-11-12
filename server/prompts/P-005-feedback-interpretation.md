# P-005 整理修订意见

## 能力提示词正文

读用户明确提出的修改，找出改哪条解读、希望保留什么、哪些地方还不清楚。把改动写成供用户核对的建议，保留用户原意。仅在输入提供目标编号时填写 target_id。模糊的态度或一句感叹不足以推断长期偏好。不会写入资料或偏好。

## 输出 Schema

```json
{"type":"object","properties":{"status":{"enum":["interpreted","needs_clarification"]},"target_id":{"type":"string"},"requested_changes":{"type":"array","items":{"type":"string","minLength":1}},"constraints_to_keep":{"type":"array","items":{"type":"string","minLength":1}},"clarifying_question":{"type":"string"}},"required":["status","target_id","requested_changes","constraints_to_keep","clarifying_question"],"additionalProperties":false}
```
