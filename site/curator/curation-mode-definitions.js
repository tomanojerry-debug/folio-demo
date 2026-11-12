const mode = (label, description, slots) => Object.freeze({
  label, description, slots:Object.freeze(Object.entries(slots).map(([id, label]) => Object.freeze({ id, label }))),
});

export const TOPIC_PRESET_MODES = Object.freeze({
  plain: mode('通俗解读', '用日常语言讲清发生了什么、怎么知道，以及还有什么不确定。', {
    event:'发生了什么', evidence:'怎么知道', unknown:'还有什么不确定',
  }),
  'five-ws': mode('5W 概要', '按谁、什么、何时、何地、为什么逐项查看。', {
    who:'谁', what:'发生了什么', when:'何时', where:'何地', why:'为什么',
  }),
  perspectives: mode('不同观点', '查看有原文支持的不同说法、共同点和分歧。', {
    common:'共同事实', differences:'不同观点',
  }),
  concepts: mode('先解释概念', '从理解专题所需的概念和术语开始。', {
    first:'概念一', second:'概念二', third:'概念三',
  }),
  chinese: mode('中文概要', '用中文汇总重点，保留数字、专有名词和限定条件。', {
    takeaway:'核心要点', evidence:'关键依据', context:'背景与限制',
  }),
  english: mode('英文概要', '用简明英文汇总重点，保留各项出处。', {
    takeaway:'Key takeaway', evidence:'Key evidence', context:'Context and limits',
  }),
});

// Keep accepting previously saved custom readings in the local service.
export const TOPIC_MODEL_MODES = Object.freeze({
  ...TOPIC_PRESET_MODES,
  custom: mode('自定义读法', '按你写的阅读要求，从本展原文中整理内容。', {
    result:'自定义解读',
  }),
});

export const TOPIC_EDITORIAL_MODES = Object.freeze({
  overview: mode('速览', '先回答读者的问题，再给一个能看懂的原文例子。', {
    answer:'先知道这一点', example:'举个例子', limit:'判断的边界',
  }),
  compare: mode('来源对照', '按场景说明每篇资料能证明什么，以及哪里还不同。', {
    common:'一起说明了什么', contributions:'各来源补上了什么', differences:'差别与限制',
  }),
  full: mode('脉络深读', '按发生顺序或读者会追问的顺序展开，交代怎么核对。', {
    starting_point:'从哪里说起', development:'怎么展开', verification:'怎么核对', limits:'还有什么边界',
  }),
});

export const TOPIC_GENERATION_MODES = Object.freeze({ ...TOPIC_EDITORIAL_MODES, ...TOPIC_MODEL_MODES });
