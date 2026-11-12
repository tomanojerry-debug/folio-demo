# Folio 模型提示词

这些提示词为 Folio Demo 独立编写，依据当前请求字段、服务端校验和界面使用的输出结构。系统与能力说明分开装载。P-EVAL 在独立请求里核对策展草稿，最终可见状态由服务端决定。

| 文件 | 用途 |
| --- | --- |
| P-BASE | Folio 文本输出约定 |
| P-001 | 整理单件收藏 |
| P-002 | 发现跨收藏主题 |
| P-003 | 编排展览；已指定展品时使用 planned 版本 |
| P-EVAL | 核对展览中的引用、判断和叙事 |
| P-004 至 P-006 | 预留的问答、修订和手记能力 |
| interpretation-config.json | 预留的早期原型阶段 |

从仓库根目录运行 `node --test tests/pipeline.test.mjs tests/curation-plan.test.mjs` 可检查加载及调用约定。测试注入模型输出，不消耗模型额度。
