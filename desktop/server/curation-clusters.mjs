import { createHash } from 'node:crypto';
import { canonicalSourceUrl, searchUnits } from './knowledge/tokenize.mjs';
import { readingParagraphs } from './reading.mjs';

const MAX_DOCUMENTS = 40;
const MAX_BODY = 40_000;
const MAX_EVIDENCE = 350;
const MAX_SOURCES = 8;
const MIN_SOURCES = 2;
const MIN_ARTICLES = 3;
const FIRST_PASSAGES = 15;
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const words = value => searchUnits(value.replace(/[’']s\b/giu, ''), { limit: 180 });
const digest = value => createHash('sha256').update(value).digest('hex');
const asText = value => typeof value === 'string' ? value : '';
const topicStopWords = new Set(`article articles announcement announcements associated association asteroid asteroids business city cities company companies conference country coverage daily data day days daylong different edition event events example first government ground headline highlights humanity image images information institute international internationalized issue issues latest launch launches law local main measurement measurements media million minutes mission model months motion national new news northern observatory official orbit organization organizations overview part period planetary press project projects published read release releases report reports research results rules saturday science second service source space statement statements story study system team technique technology telescope test testing time timeline times today update view video week weeks world year years january february march april may june july august september october november december mon monday tue tuesday wed wednesday thu thursday fri friday sat saturday sun sunday sep sept oct nov dec impact impacts collision collided deflection deflected nasa eso esa ap reuters afp initial public global announces announced confirmation confirmed target about reshape reshaped plan plans after before during near southern independent perspective council full expected legislation said says 文章 报道 新闻 项目 计划 方案 日期 政府 方面 全国 全球 公告 发布 相关 问题 信息 社会 人类 公司 系统 事件 结果 研究 团队 发现 科学 机构 首次 首个 最新 第一次 年度 上午 下午 数据 工作 实验 试验 测试 工程 任务 正式 观测 分析`.split(/\s+/u));
topicStopWords.add('earth');
topicStopWords.add('planet');

const EVENT_ACTIONS = new Map(Object.entries({
  impact: /\b(?:impact\w*|collid\w*|collision\w*|crash\w*|struck|deflect\w*|reshap\w*)\b|撞击|相撞|碰撞|坠毁|偏转/u,
  launch: /\b(?:launch\w*|lifted off|lift-off|blast\w* off|takeoff)\b|发射|升空|起飞/u,
  closure: /\b(?:closur\w*|closed|closing|shut\w* down|cancel\w*|suspend\w*|suspension)\b|关闭|关停|暂停|停运|取消/u,
  opening: /\b(?:open(?:s|ed|ing)?|inaugurat\w*|debut\w*)\b|开幕|开通|开业|开放|启用/u,
  legislation: /\b(?:bill|legislation|enact\w*|pass\w* (?:the|a) law|ordinance|ban(?:ned|s)?|repeal\w*)\b|法案|法规|条例|禁令|废除|立法/u,
  approval: /\b(?:approv\w*|reject\w*|clearance|verdict|ruling|ruled|certif\w*)\b|批准|否决|批复|驳回|判决|裁定/u,
  election: /\b(?:elect\w*|runoff|referendum|ballot\w*)\b|大选|选举|公投|投票/u,
  transaction: /\b(?:acquir\w*|acquisition|merg\w*|takeover|buyout)\b|收购|并购|合并/u,
  release: /\b(?:releas\w*|unveil\w*|debut\w*|roll(?:ed|s|ing)? out)\b|发布|发布会|上线|推出/u,
  disaster: /\b(?:flood\w*|earthquake\w*|wildfire\w*|landslide\w*|hurricane\w*|tornado\w*|eruption\w*|blackout\w*|outage\w*)\b|洪水|地震|山火|滑坡|飓风|台风|龙卷风|喷发|停电/u,
  findings: /\b(?:discover\w*|find(?:s|ings)?|found|detect\w*|confirm\w*|observ\w*|measur\w*)\b|发现|确认|测量|观测|检测/u,
}));

const CONTRIBUTION_TYPES = new Map(Object.entries({
  orbit: /\b(?:orbit\w*|orbital period|orbital motion)\b|轨道|运行周期/u,
  imaging: /\b(?:imag(?:e|es|ing)|spectr\w*|polarisation|polarization|sensor\w*|photograph\w*|telescope\w*)\b|影像|光谱|偏振|遥感|传感器|望远镜/u,
  material: /\b(?:debris|ejecta|dust cloud|plume|particle\w*|fragments|material composition|mineralogy)\b|碎屑|喷射物|尘埃|微粒|颗粒|成分/u,
  shape: /\b(?:crater\w*|reshap\w*|shape\w*|boulder\w*|deform\w*|rebound\w*)\b|撞击坑|形态|形变|重塑|反弹|结构变化/u,
  methods: /\b(?:simulat\w*|experiment\w*|tested|instrument\w*|method\w*|protocol\w*|benchmark\w*|algorithm\w*|procedure\w*|workflow\w*)\b|模拟|仿真|试验|实验|仪器|方法|基准|算法|流程|操作步骤/u,
  survey: /\b(?:survey\w*|interview\w*|witness\w*|case stud\w*|respondents)\b|调查|访谈|目击者|案例|受访者/u,
  delivery: /\b(?:launch\w*|install\w*|deploy\w*|repaired|arriv\w*|construct\w*|commission\w*)\b|发射|部署|安装|到达|建造|修复/u,
  rule: /\b(?:regulation\w*|requirements?|standards?|specification\w*|conditions?|eligib\w*)\b|规范|标准|资格|适用条件|门槛|要求/u,
  cost: /\b(?:cost\w*|price\w*|funding|financ\w*|investment\w*|budget\w*|fee\w*)\b|成本|价格|资助|融资|投资|预算|费用/u,
  consequences: /\b(?:displac\w*|injur\w*|death\w*|damag\w*|disrupt\w*|loss\w*|affected)\b|伤亡|损失|损坏|受灾|中断|受影响/u,
  reasons: /\b(?:because|as a result of|attribut\w* to|driv\w* by|evidence suggests|hypothesi\w*)\b|原因|由于|因为|归因|推测|假设/u,
}));

const ORIGINAL_WORK = /\b(?:measur\w*|observ\w*|followed|tracked|recorded|captured|conduc\w*|interview\w*|simulat\w*|experiment\w*|tested|analys\w*|researchers? (?:found|showed)|study (?:found|showed)|team (?:found|showed)|published (?:a|the|their) study|paper (?:finds|shows)|we (?:found|demonstrate|examine|used|compare)|first-hand|eyewitness)\b|测量|观测|追踪|记录|采访|实测|模拟|仿真|试验|实验|研究显示|研究发现|研究表明|团队发现|现场目击|调查发现/iu;
const FINDING = /\b(?:found that|show(?:ed|s) that|results? (?:show\w*|suggest\w*|reveal\w*)|shorten\w*|reveal\w*|conclude\w*|succeeded|confirmed)\b|测得|显示|表明|证实|观测到/iu;
const FUTURE_WORK = /\b(?:planned to|plans? to|will conduct|will measure|will observe|will study|will analyse|expected to conduct)\b|计划开展|预计开展|将开展|将进行调查/iu;
const ATTRIBUTED_WORK = /^(?:according to|based on (?:an?|the) (?:report|statement|release) by|citing (?:a |the )?|as (?:reported|stated|announced) by|据.{1,25}(?:报道|消息|通报)|援引|转引|引述)\s*/iu;
const CLAIM_MEASURE = /\b\d+(?:\.\d+)?\s*(?:%|(?:percent|seconds?|minutes?|hours?|days?|weeks?|months?|years?|kilomet(?:er|re)s?|met(?:er|re)s?|miles?|kilograms?|tons?|million|billion|dollars?|euros?|degrees?)\b)|\d+(?:\.\d+)?\s*(?:%|秒|分钟|小时|天|周|个月|年|公里|千米|米|公斤|吨|万元|亿元|度|例|人)/giu;
const QUESTION_INTENT = /^(?:(how|why|what|which|can|does|do|is|are|should|when|where)\b|(该如何|如何|怎么|怎样|为何|为什么|什么是|是否|能否|哪种|什么时候|在哪里))/iu;
const QUESTION_KINDS = new Map([
  ['how','method'], ['如何','method'], ['该如何','method'], ['怎么','method'], ['怎样','method'],
  ['why','reason'], ['为何','reason'], ['为什么','reason'],
  ['what','definition'], ['什么是','definition'], ['which','choice'], ['哪种','choice'],
  ['when','time'], ['什么时候','time'], ['where','place'], ['在哪里','place'],
  ['是否','boolean'], ['能否','boolean'],
]);
const DATE = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b|(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日|\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(20\d{2})\b|\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*|\s+)(20\d{2})\b/giu;
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const WIRE_SOURCES = new Map([
  ['associated press', 'ap'], ['the associated press', 'ap'], ['ap', 'ap'], ['美联社', 'ap'],
  ['reuters', 'reuters'], ['路透社', 'reuters'], ['afp', 'afp'], ['法新社', 'afp'],
  ['agence france presse', 'afp'], ['agence france-presse', 'afp'],
  ['xinhua', 'xinhua'], ['新华社', 'xinhua'], ['china news service', 'cns'], ['中新社', 'cns'],
]);
const SHARED_HOSTS = new Set(['qq.com','weixin.qq.com','weibo.com','medium.com','substack.com','zhihu.com','bilibili.com','xiaohongshu.com','rednote.com','youtube.com']);
const MULTIPART_SUFFIX = /^(?:co|com|gov|edu|ac|org|net)\.[a-z]{2}$/u;
const LOCALE_PREFIX = /^(?:ar|de|en|es|fr|id|it|ja|ko|nl|pl|pt|ru|th|tr|vi|zh)(?:[-_][a-z]{2,8})?$/iu;
const LOCALIZED_SECTIONS = new Set(['docs', 'documentation', 'help', 'support', 'kb']);

// A frame describes a recurring operational question and ways a source can
// answer it. A shared subject (such as "agent") is not evidence of a shared
// question. Match what the source does about the problem, in its own text.
const QUESTION_FRAMES = [
  {
    id:'resume-execution',
    label:'任务中断后，如何保留状态并继续执行？',
    focus:/\b(?:long[- ]running|durable execution|resum(?:e|es|ing|ption)|recover\w*|persist(?:ence|ent|ing|ed)|checkpoint\w*|compaction|continuity|context window)\b|长任务|长期运行|断点|续跑|恢复执行|继续执行|持久化|上下文窗口|上下文压缩/u,
    aim:/\b(?:execution|agent\w*|workflow\w*|task\w*|session\w*|job\w*|run\w*|context|interruption)\b|任务|智能体|工作流|执行|运行|会话|上下文|中断/u,
    center:/\b(?:long[- ]running|durable execution|persist\w* (?:a |the )?(?:workflow|session|state)|checkpoint\w*)\b|长期运行|长任务|持久化|检查点/u,
    mechanisms:{
      checkpoint:/\b(?:checkpoints?|checkpointer\w*|sav(?:e|es|ing) (?:the |current )?(?:graph |execution )?state|checkpointing|checkpointable)\b|检查点|保存(?:任务|执行|当前|运行)?状态/u,
      handoff:/\b(?:progress (?:file|log|notes?)|handoff\w*|context reset|feature list|session handoff|git (?:history|log|commit))\b|进度文件|交接记录|进度日志/u,
      summary:/\b(?:compaction|context summar\w*|summari[sz]\w* (?:its |the )?(?:contents|context|conversation))\b|上下文压缩|对话摘要/u,
      notes:/\b(?:structured note.taking|persistent memory outside|notes?.{0,55}(?:outside|context window)|write\w* .{0,30}notes?)\b|结构化笔记|上下文之外.{0,16}(?:记录|笔记)/u,
      memory:/\b(?:cross.thread memory|short.term memory|thread[- ]scoped|persistent sessions?|thread id|thread_id|key.value store)\b|会话标识|跨会话记忆|线程状态/u,
      crash:/\b(?:crash recovery|fault tolerance|process (?:restart|failure)|restart\w* (?:the |a |from|after)|durable execution|recover\w* (?:from (?:a |an )?(?:crash|failure)|on restart)|replay\w* (?:execution|event\w*))\b|崩溃恢复|故障恢复|进程重启|持久执行/u,
    },
    refinements:{
      invocationRecovery:/\b(?:register\w*|persist\w*|record\w*)\b.{0,60}\bbefore (?:execution|starting|the (?:run|task))\b.{0,85}\brecover\w* on restart\b|(?:执行|运行)前.{0,16}(?:登记|持久化).{0,30}重启.{0,12}恢复/u,
    },
  },
  {
    id:'authorize-actions',
    label:'工具调用在什么情况下需要人工确认？',
    focus:/\b(?:permission\w*|approv\w*|allow\w*|den(?:y|ies|ied|ial|ying)|policy|human[- ]in[- ]the[- ]loop|user (?:confirmation|consent)|external input)\b|权限|批准|人工确认|授权|用户确认|允许|拒绝|审批|人工介入/u,
    aim:/\b(?:tools?|execut(?:e|ion|ing)|action\w*|commands?|interrupt\w*|cli|operations?)\b|工具|执行|调用|操作|中断/u,
    center:/\b(?:permission\w*|approv\w*|human[- ]in[- ]the[- ]loop|user (?:confirmation|consent)|external input)\b|权限|人工确认|审批|人工介入/u,
    mechanisms:{
      decision:/\b(?:allow\w*.{0,85}den(?:y|ied|ial|ying)|den(?:y|ied|ial|ying).{0,85}allow\w*|ask_user|permission modes?|approval modes?|authorization rules?|permission rules?|managed polic\w*)\b|允许.{0,50}拒绝|权限规则|权限模式|审批模式/u,
      confirmation:/\b(?:human[- ]in[- ]the[- ]loop|(?:ask|prompt|wait)\w* .{0,50}(?:approval|confirmation|external input|consent)|approv\w*.{0,45}(?:tool call|action|execution)|user confirmation|external input)\b|人工确认|用户确认|等待.{0,15}(?:批准|审批|输入)|确认后执行/u,
      scope:/\b(?:permanent\w*|once|session|until|domain|project|directory)\b.{0,80}\b(?:approv\w*|permission\w*|consent|allowlist|allow\w*|den(?:y|ial|ied))\b|\b(?:approv\w*|permission\w*|consent|allowlist)\b.{0,80}\b(?:permanent\w*|this time|this session|until|domain|project|directory)\b|授权范围|会话内|永久批准|仅本次/u,
      risk:/\b(?:read.only|destructive|sandbox(?:ed|ing)?|least privilege|credential\w*|sensitive)\b|只读|破坏性|敏感操作|沙盒|最小权限/u,
      precedence:/\b(?:highest.priority|precedence|priority rule|first matching|non.interactive|default decision|default deny|deny by default)\b|优先级|默认拒绝|非交互模式/u,
      numericPriority:/\b(?:highest.priority rule|higher (?:numbers?|priority) (?:wins?|takes precedence)|numeric priority|rule priority values?)\b|最高优先级规则|较高的优先级值/u,
      unattended:/\b(?:non.interactive|headless|unattended)\b.{0,100}\b(?:den(?:y|ied|ial)|ask_user|approval|confirmation)\b|非交互.{0,25}(?:批准|拒绝|确认)/u,
      urlScope:/\b(?:url approvals?|allowedurls|url allowlists?|domain.specific (?:approval|permission))\b|网址.{0,12}(?:授权|白名单)|域名许可/u,
      interruption:/\b(?:interrupt\w*.{0,80}(?:human|external input|approv\w*|resume|confirmation)|pause\w*.{0,65}(?:external input|approv\w*|resume|confirmation)|(?:human|external input|approv\w*).{0,55}interrupt\w*)\b|中断.{0,18}(?:输入|批准|确认)|暂停.{0,18}(?:审批|输入)/u,
    },
  },
  {
    id:'verify-outcomes',
    label:'怎样验证系统真正完成了任务？',
    focus:/\b(?:evaluat\w*|evals?|benchmark\w*|graders?|scoring|measure\w*|verif\w*|validat\w*|correctness|reproduc\w*)\b|评测|验证|基准|打分|评分|衡量|可复现/u,
    aim:/\b(?:agents?|tasks?|workflows?|outcomes?|execution|actions?|interactions?|runs?)\b|智能体|任务|执行|工作流|结果|操作|交互/u,
    center:/\b(?:benchmark\w*|evaluat\w*|evals?)\b|评测|基准/u,
    needsEarlyFocus:true,
    mechanisms:{
      endState:/\b(?:final (?:database |environment )?state|end state|state change|reference (?:state|answer)|expected (?:outcome|state)|functional correctness|execution.based|programmatically validat\w*|database state|environment state|initial state setup|world state|task (?:completion|success))\b|最终状态|执行结果|功能正确性|任务完成|真实结果|结果状态|初始状态/u,
      stateComparison:/\b(?:final database state|database state (?:to|with)|compar\w*.{0,45}(?:reference answer|expected state)|answer.{0,20}annotated reference)\b|比较.{0,25}(?:最终状态|参考答案)|数据库最终状态/u,
      repetition:/\b(?:pass\^?k|pass@k|consistent\w* across|multiple trials|repeat\w* (?:runs?|trials?)|reliability over|across \d+ (?:runs|trials))\b|重复.{0,8}(?:试验|运行)|多轮试验|成功率/u,
      interaction:/\b(?:real.world (?:computer|tasks?|settings)|interactable|interactive environment|self.hostable web environment|simulat\w* users?|(?:web|desktop) (?:apps|applications)|operating systems|reproducible setup)\b|真实环境|真实任务|模拟用户|真实网页|桌面应用|可复现环境/u,
      graders:/\b(?:grader\w*|assertions?|rubrics?|deterministic checks?|human (?:evaluation|graders?)|grading methods?|evaluation scripts?|evaluation approaches|annotated programs?)\b|评分器|评分规则|评测脚本|人工评判|程序化检查/u,
      trace:/\b(?:execution trace|tool trace|transcript\w*|intermediate steps?|trajectory|trajectories|tool calls? logs?)\b|操作轨迹|调用记录|对话日志|中间步骤/u,
    },
    // These details can add evidence to an existing question. They do not
    // qualify another document as answering the question by themselves.
    refinements:{
      humanCalibration:/\b(?:human calibration|calibrat\w*.{0,45}(?:human graders?|human judgment|human evaluation)|human graders?.{0,45}calibrat\w*)\b|人工校准|(?:人工|人类).{0,15}校准.{0,15}评分/u,
      graderRubric:/\b(?:llm|model.based) graders?.{0,80}\b(?:rubrics?|criteria)\b|\b(?:llm|model.based) rubrics?\b|模型评分.{0,20}(?:规则|标准|量表)/u,
      weightedChecks:/\b(?:weighted (?:graders?|scoring)|(?:combined grader|weighted) scores?\b.{0,45}\bthreshold|all graders? must pass)\b|评分.{0,12}加权|全部评分项.{0,12}通过/u,
      reliabilityTradeoff:/\bpass@k\b.{0,250}\bpass\^k\b|\bpass\^k\b.{0,250}\bpass@k\b/u,
    },
  },
];
const ACTIONABLE_STATEMENT = /\b(?:is|are|allows?|enables?|supports?|provides?|compares?|checks?|records?|works?|defines?|uses?|keeps?|includes?|matches?|must|should|can|when|by|then|requires?|waits?|returns?|chooses?|evaluates?|runs?|tests?|preserv\w*|persist\w*|surviv\w*|restart\w*|we|you|through|instead)\b|可以|用于|提供|比较|记录|支持|需要|允许|必须|通过|之后|之前|选择|启用|会在|不会|保存|是指/u;
const ANSWER_CLAUSE = /\b(?:compar\w*|validat\w*|check\w*|verif\w*|restore\w*|persist\w*|summari[sz]\w*|recover\w*|paus\w*|prompt\w*|ask(?:s|ed)?|den(?:y|ies|ied)|allow\w*)\b|比较|比对|验证|恢复|持久化|暂停|提示|询问|批准|拒绝/u;
const VAGUE_INTRO = /^(?:we (?:introduce|present|describe) |(?:in|this) (?:this )?(?:section|guide|article)|本(?:章|文|节)(?:介绍|概述))/iu;
const FRAME_SECTION_CUE = /\b(?:control|guide|configure|policy|using|benchmark|evaluat\w*|recover\w*|durable execution|persistence|interruption|interrupts?)\b|配置|权限|审批|评测|持久化|中断/u;
const BOILERPLATE = /^(?:\s*(?:section titled|on this page|copy link|jump to|skip to|see also|quick links|sign in|related links|previous page)\b|\s*\[?\s*(?:https?:\/\/|contents?\s*[:：])|\s*(?:跳转到|目录|复制链接))/iu;
const SCOPE_FILLER = /^(?:ai|real(?:ly)?|actually|true|correct(?:ly)?|genuine(?:ly)?|successful(?:ly)?|finish\w*|complet\w*|reliabl\w*|systems?|approach\w*|method\w*|whether|rules?|确实|真的|真正|实际|正确|顺利|成功|完成|系统|框架|方法|办法|做法|处理|情况|负责|时机|需要|什么时候|如何|怎样|怎么|哪些|经过|人工|规则)$/u;
const PROCEDURAL_GOALS = new Map(Object.entries({
  prevent: /\b(?:prevent\w*|reduc\w*|mitigat\w*|avoid\w*|lower\w*|minimi[sz]\w*)\b|防止|降低|减少|避免|缓解/u,
  improve: /\b(?:improv\w*|increas\w*|strengthen\w*|optimi[sz]\w*|enhanc\w*)\b|提高|改善|增强|优化/u,
  diagnose: /\b(?:diagnos\w*|troubleshoot\w*|detect\w*|identify\w*)\b|诊断|排查|检测|识别/u,
  configure: /\b(?:configur\w*|set up|install\w*|operat\w*)\b|配置|设置|安装|操作/u,
}));

function domain(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./u, '');
    const parts = host.split('.');
    if (parts.length < 2 || /^[\d.]+$/u.test(host)) return '';
    return parts.slice(MULTIPART_SUFFIX.test(parts.slice(-2).join('.')) ? -3 : -2).join('.');
  } catch { return ''; }
}

function comparableUrl(raw) {
  const canonical = canonicalSourceUrl(raw);
  if (!canonical) return '';
  const url = new URL(canonical);
  return `${url.host.replace(/^www\./u, '')}${url.pathname.replace(/\/+$/u, '')}${url.search}`;
}

function localeRoute(raw) {
  const url = new URL(raw);
  const parts = url.pathname.split('/').filter(Boolean);
  const prefix = LOCALIZED_SECTIONS.has(parts[0]) ? 1 : 0;
  if (parts.length < prefix + 2 || !LOCALE_PREFIX.test(parts[prefix])) return '';
  const path = [...parts.slice(0, prefix), ...parts.slice(prefix + 1)].join('/');
  return `${url.hostname.replace(/^www\./u, '')}/${path}${url.search}`;
}

function validDate(year, month, day) {
  const value = new Date(Date.UTC(+year, +month - 1, +day));
  return value.getUTCMonth() + 1 === +month && value.getUTCDate() === +day ? value.toISOString().slice(0, 10) : '';
}

function dates(text) {
  return [...text.matchAll(DATE)].map(match => {
    if (match[1] || match[4]) return validDate(match[1] || match[4], match[2] || match[5], match[3] || match[6]);
    const month = MONTHS.indexOf((match[8] || match[10]).slice(0, 3).toLowerCase()) + 1;
    return validDate(match[9] || match[12], month, match[7] || match[11]);
  }).filter(Boolean);
}

function publicationDate(doc) {
  const supplied = asText(doc.publishedAt);
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(supplied)) return supplied.slice(0, 10);
  for (const row of doc.text.split(/\r?\n/u).slice(0, 4)) {
    const candidate = row.trim().replace(/^(?:published(?: on)?\s*:?|发布日期\s*[:：]?)\s*/iu, '');
    if (!candidate || candidate.length > 30 || candidate.replace(DATE, '').trim()) continue;
    const [date] = dates(candidate);
    if (date) return date;
  }
  return '';
}

function factualFeatures(text) {
  const normalized = text.toLowerCase();
  const types = [...CONTRIBUTION_TYPES].filter(([, test]) => test.test(normalized)).map(([type]) => type);
  const measures = [...normalized.matchAll(CLAIM_MEASURE)].map(([measure]) => measure.replace(/\s+/gu, '').replace(/percent/u, '%').replace(/(?<=[a-z])s$/u, ''));
  return [...new Set([...types, ...measures.map(measure => `measure:${measure}`)])];
}

function focalWords(text) {
  return words(text).filter(word => !/^\d/u.test(word) && !topicStopWords.has(word) && ![...EVENT_ACTIONS.values()].some(test => test.test(word)));
}

function namedTerms(title, early) {
  const fromTitle = [...title.matchAll(/\b[A-Z]{2,}[A-Z\d-]*\b/gu)].map(match => match[0]);
  const fromBody = early.flatMap(row => [...row.text.matchAll(/\b[A-Z]{2,}[A-Z\d-]*\b|(?<!^["“'‘]?)[A-Z][a-z][A-Za-z\d-]{2,}\b/gu)].map(match => match[0]));
  return new Set(focalWords([...fromTitle, ...fromBody].join(' ')));
}

function passagesOf(text) {
  const parts = [], seen = new Set();
  const paragraphs = readingParagraphs(text);
  let paragraphIndex = 0;
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    for (const segment of sentenceSegmenter.segment(line[0])) {
      let value = segment.segment.trim();
      if (value.length < 24 || /^https?:\/\//iu.test(value)) continue;
      if (value.length > MAX_EVIDENCE) {
        const boundary = value.lastIndexOf(' ', MAX_EVIDENCE);
        value = value.slice(0, boundary >= 250 ? boundary : MAX_EVIDENCE).trimEnd();
      }
      const start = line.index + segment.index + segment.segment.indexOf(value);
      const end = start + value.length;
      while (paragraphIndex < paragraphs.length && paragraphs[paragraphIndex].end <= start) paragraphIndex++;
      const paragraph = paragraphs[paragraphIndex];
      if (!paragraph || paragraph.start > start || paragraph.end < end) continue;
      const terms = focalWords(value);
      const key = words(value).join(' ');
      if (seen.has(key) || terms.length < 2) continue;
      seen.add(key);
      parts.push({ text:value, start, end, lineStart:line.index, terms, features:factualFeatures(value), independent: ORIGINAL_WORK.test(value) && !ATTRIBUTED_WORK.test(value) });
      if (parts.length >= 160) return parts;
    }
  }
  return parts;
}

function answerProfile(doc, frame) {
  const title = doc.title.toLowerCase();
  const titleFocus = frame.focus.test(title);
  const lead = doc.text.slice(0, 2400).toLowerCase().replace(/\s+/gu, ' ');
  const leadFocus = frame.focus.test(lead) && frame.aim.test(lead);
  const purposeIsEarly = frame.center.test(title) || frame.center.test(lead.slice(0, 500));
  if (frame.needsEarlyFocus && !titleFocus && !leadFocus) return null;
  const evidence = [];
  for (const row of doc.passages) {
    if (BOILERPLATE.test(row.text) || ATTRIBUTED_WORK.test(row.text)) continue;
    const statement = row.text.toLowerCase();
    const nearby = doc.text.slice(Math.max(0, row.start - 115), row.end + 115).toLowerCase().replace(/\s+/gu, ' ');
    const technique = Object.entries(frame.mechanisms).filter(([, test]) => test.test(statement)).map(([name]) => name);
    if (!technique.length || !frame.aim.test(nearby) && !frame.aim.test(title)) continue;
    const clear = frame.focus.test(statement) && frame.aim.test(statement);
    if (!clear && !titleFocus && !frame.focus.test(nearby)) continue;
    const codeFragment = /^(?:\/\/|#\s|[\s]*[\w.]+\s*=|from\s+\w+\s+import\b|import\s+\w+|def\s+\w+)/u.test(statement);
    if (codeFragment) continue;
    const direct = ACTIONABLE_STATEMENT.test(statement) || row.independent || clear && ACTIONABLE_STATEMENT.test(nearby);
    const concrete = ANSWER_CLAUSE.test(statement);
    const complete = /^[\p{Lu}\p{Script=Han}“"]/u.test(row.text) && /[。.!?]$/u.test(statement);
    const focal = Number(clear) + Number(direct) + Number(complete);
    evidence.push({
      ...row, focal, answerWeight:4 * Number(concrete) + 2 * Number(complete) + 2 * Number(row.text.length >= 70) - 6 * Number(VAGUE_INTRO.test(statement) && !concrete) - 3 * Number(row.text.length < 45),
      features:[...technique.map(name => `answer:${name}`),
        ...Object.entries(frame.refinements || {}).filter(([, test]) => test.test(statement)).map(([name]) => `detail:${name}`),
        ...row.features.filter(value => value.startsWith('measure:'))],
      // A factual description in the source's own guide also counts as direct
      // evidence, even if it does not describe a formal experiment.
      independent:direct && !doc.origin?.external,
    });
  }
  const direct = evidence.filter(row => row.independent);
  const methods = new Set(direct.flatMap(row => row.features.filter(value => value.startsWith('answer:'))));
  if (!direct.length || !evidence.some(row => row.focal >= 2) || !titleFocus && !leadFocus && (direct.length < 4 || methods.size < 2)) return null;
  const leadEvidence = evidence.filter(row => row.start < 2400).length;
  const score = 4 * Number(titleFocus) + 6 * Number(purposeIsEarly) + 2 * Number(titleFocus && (frame.aim.test(title) || FRAME_SECTION_CUE.test(title)))
    + 2 * Number(leadFocus) + 2 * Math.min(4, leadEvidence) + Math.min(5, methods.size) + Math.min(3, direct.length / 4);
  return { frame, evidence, score };
}

function attribute(doc) {
  const supplied = asText(doc.attribution).trim();
  const byline = asText(doc.byline).trim();
  const lead = doc.text.slice(0, 800);
  const credit = /^(?:\s*[-–—(]?\s*)?(?:(?:originally (?:published|reported) (?:by|in|on)|republished from|reprinted from|adapted from|provided by|source|attribution|report by|by|via|written by|\(source\)|来源|稿源|转载自|原载于|转自|稿件来源)\s*[:：-]?\s*)([^\n\r.。|]{2,75})/imu;
  const wireCredit = /(?:^|\n|(?:^|\s)[A-Z][A-Z -]{2,20},?\s+)\((Reuters|Associated Press|AP|AFP|Xinhua)\)\s*[-–—:]/u;
  const publisherHost = domain(doc.url);
  const canonicalHost = domain(doc.canonicalUrl);
  const explicitOrigin = domain(doc.originUrl) || (canonicalHost !== publisherHost ? canonicalHost : '');
  if (explicitOrigin) return { key: `domain:${explicitOrigin}`, verified:true, external:explicitOrigin !== publisherHost };
  const value = supplied || (WIRE_SOURCES.has(byline.toLowerCase()) ? byline : '') || lead.match(wireCredit)?.[1] || lead.match(credit)?.[1] || '';
  if (!value) return null;
  const normalized = value.replace(/\s+.*(?:staff|reporters?|writers?)\b.*$/iu, '').replace(/[^\p{L}\p{N} -]/gu, '').trim().toLowerCase();
  if (!normalized || normalized.length > 55) return null;
  const wire = WIRE_SOURCES.get(normalized);
  if (wire) return { key:`wire:${wire}`, verified:true, external:!publisherHost.startsWith(`${wire}.`) };
  // A conventional personal byline names the author, not the originating newsroom.
  if (!supplied && /^\s*(?:by|written by)\s+/iu.test(lead)) return null;
  return { key:`name:${normalized.replace(/[^\p{L}\p{N}]+/gu, '')}`, verified:true, external:Boolean(supplied || /^\s*(?:originally|republished|reprinted|adapted|转载|转自|原载)/imu.test(lead)) };
}

function shingles(tokens, size) {
  return new Set(tokens.slice(0, Math.max(0, tokens.length - size + 1)).map((_, i) => tokens.slice(i, i + size).join(' ')));
}

function prepare(doc) {
  const title = asText(doc?.title).trim();
  const url = canonicalSourceUrl(doc?.url);
  const text = asText(doc?.text).slice(0, MAX_BODY);
  if (!doc?.collectionId || !doc.documentVersionId || !url || !title || !text.trim() || doc.coverage === 'unavailable') return null;
  const passages = passagesOf(text);
  if (!passages.length) return null;
  const titleTerms = focalWords(title);
  const early = passages.slice(0, FIRST_PASSAGES).filter(row => row.start < 3400);
  const events = [...EVENT_ACTIONS].flatMap(([family, action]) => {
    if (!action.test(title.toLowerCase())) return [];
    const context = early.filter(row => action.test(row.text.toLowerCase()));
    if (!context.length) return [];
    return [{ family, context, focus:[...new Set([...titleTerms, ...context.flatMap(row => row.terms)])] }];
  });
  const question = [title, ...early.slice(0, 3).map(row => row.text)].map(value => {
    const intent = QUESTION_INTENT.exec(value)?.[0].toLowerCase();
    const kind = QUESTION_KINDS.get(intent);
    if (!intent || !kind && !/[?？]$/u.test(value)) return null;
    const terms = focalWords(value);
    return terms.length >= 2 && terms.length <= 12 ? { text:value, intent:kind || 'boolean', focus:terms } : null;
  }).find(Boolean);
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const tokens = normalized.split(' ').flatMap(token => /^\p{Script=Han}{3,}$/u.test(token) ? [...token] : [token]);
  const origin = attribute({ ...doc, text });
  const prepared = { ...doc, title, url, text, passages, titleTerms, early, events, question, origin, named:namedTerms(title, early),
    hash:digest(normalized), shingles:shingles(tokens, 4), host:domain(url), urlKey:comparableUrl(doc.canonicalUrl || url), localeKey:localeRoute(url) };
  prepared.answers = QUESTION_FRAMES.map(frame => answerProfile(prepared, frame)).filter(Boolean).sort((a, b) => b.score - a.score);
  return prepared;
}

const intersect = (left, right) => [...new Set(left)].filter(term => right.includes(term));
const subset = (terms, container) => terms.every(term => container.includes(term));

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  const smaller = a.size < b.size ? a : b, larger = smaller === a ? b : a;
  return [...smaller].filter(value => larger.has(value)).length / smaller.size;
}

function copyOf(a, b) {
  if (a.urlKey === b.urlKey || a.hash === b.hash || a.localeKey && a.localeKey === b.localeKey) return true;
  if (Math.min(a.shingles.size, b.shingles.size) >= 10 && overlap(a.shingles, b.shingles) >= .77) return true;
  const sameTitle = a.titleTerms.length > 2 && subset(a.titleTerms, b.titleTerms) && subset(b.titleTerms, a.titleTerms);
  return sameTitle && Math.min(a.shingles.size, b.shingles.size) >= 6 && overlap(a.shingles, b.shingles) >= .48;
}

function originalSourceScore(doc) {
  if (doc.origin?.key.startsWith('domain:')) return doc.origin.key === `domain:${doc.host}` ? 4 : -4;
  if (doc.origin?.key.startsWith('wire:')) return doc.host.startsWith(`${doc.origin.key.slice(5)}.`) ? 4 : -4;
  const site = doc.host.split('.')[0];
  const header = `${doc.title}\n${doc.text.slice(0, 500)}`.toLowerCase();
  return site.length >= 3 && header.includes(site) ? 1 : 0;
}

function dedupe(documents, preferredSourceIds) {
  const groups = [];
  for (const doc of documents) {
    const duplicates = groups.filter(items => items.some(previous => copyOf(doc, previous)));
    if (!duplicates.length) { groups.push([doc]); continue; }
    duplicates[0].push(doc);
    for (const duplicate of duplicates.slice(1)) {
      duplicates[0].push(...duplicate);
      groups.splice(groups.indexOf(duplicate), 1);
    }
  }
  const captured = doc => Date.parse(doc.capturedAt || '') || Number.MAX_SAFE_INTEGER;
  const evidenceQuality = doc => Number(doc.coverage === 'complete') * 40 + Math.min(30, doc.answers[0]?.evidence.length || 0) + Math.min(8, doc.passages.length / 15);
  return groups.map(group => group.sort((a, b) => Number(preferredSourceIds.has(b.collectionId)) - Number(preferredSourceIds.has(a.collectionId))
    || originalSourceScore(b) - originalSourceScore(a)
    || (a.localeKey && a.localeKey === b.localeKey ? evidenceQuality(b) - evidenceQuality(a) : 0)
    || captured(a) - captured(b) || a.collectionId.localeCompare(b.collectionId))[0]);
}

function originKeys(documents) {
  const aliases = new Map();
  const nameKey = value => asText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (const doc of documents) {
    if (!doc.host || SHARED_HOSTS.has(doc.host)) continue;
    const key = `domain:${doc.host}`;
    const names = [doc.host.split('.')[0], nameKey(doc.publisher)].filter(Boolean);
    for (const name of names) {
      if (!aliases.has(name)) aliases.set(name, key);
      else if (aliases.get(name) !== key) aliases.set(name, null);
    }
  }
  return new Map(documents.map(doc => {
    if (doc.origin) {
      const key = doc.origin.key;
      return [doc.collectionId, key.startsWith('name:') ? aliases.get(key.slice(5)) || key : key];
    }
    const publisher = nameKey(doc.publisher);
    if (publisher && !SHARED_HOSTS.has(doc.host)) return [doc.collectionId, aliases.get(publisher) || `publisher:${publisher}`];
    if (publisher) return [doc.collectionId, `publisher:${publisher}`];
    return [doc.collectionId, doc.host && !SHARED_HOSTS.has(doc.host) ? `domain:${doc.host}` : ''];
  }));
}

function eventDates(event, pair, doc) {
  return new Set([...dates(doc.title), ...event.context.filter(row => intersect(row.terms, pair).length > 0).flatMap(row => dates(row.text))]);
}

function candidatesForEvent(documents, anchor) {
  const clusters = [];
  for (const event of anchor.events) {
    const matching = documents.map(doc => ({ doc, event:doc.events.find(item => item.family === event.family) })).filter(entry => entry.event);
    const salient = event.focus.filter(term => matching.filter(entry => entry.event.focus.includes(term)).length >= MIN_ARTICLES)
      .sort((a, b) => Number(anchor.titleTerms.includes(b)) - Number(anchor.titleTerms.includes(a)) || a.localeCompare(b)).slice(0, 20);
    for (const [i, first] of salient.entries()) for (const second of salient.slice(i + 1)) {
      const pair = [first, second].sort();
      // At least two members must use the subject in the headline; boilerplate
      // references repeated in several ledes are not a topic by themselves.
      const group = matching.filter(entry => subset(pair, entry.event.focus));
      if (group.filter(({ doc }) => intersect(pair, doc.titleTerms).length).length < 2) continue;
      const known = group.map(({ event, doc }) => eventDates(event, pair, doc));
      const anchorDates = known[0];
      const datesByFrequency = [...new Set(known.flatMap(value => [...value]))].sort((a, b) => known.filter(set => set.has(b)).length - known.filter(set => set.has(a)).length || a.localeCompare(b));
      const eventDate = datesByFrequency.find(date => (!anchorDates.size || anchorDates.has(date)) && known.filter(set => set.has(date)).length > 1) || (anchorDates.size === 1 ? [...anchorDates][0] : '');
      const distinctPrimaryDates = new Set(known.flatMap(set => set.size === 1 ? [...set] : []));
      if (!eventDate && distinctPrimaryDates.size > 1) continue;
      const rows = group.filter((_, index) => !eventDate || !known[index].size || known[index].has(eventDate)).map(entry => entry.doc);
      if (rows.length < MIN_ARTICLES) continue;
      const headlineCount = rows.filter(doc => intersect(pair, doc.titleTerms).length > 0).length;
      const namedCount = pair.filter(term => rows.filter(doc => doc.named.has(term)).length >= 2).length;
      const distinctChineseSubject = pair.some(term => /\p{Script=Han}/u.test(term)) && rows.filter(doc => subset(pair, doc.titleTerms)).length >= 2;
      if (!namedCount && !eventDate && !distinctChineseSubject) continue;
      clusters.push({ kind:'event', family:event.family, terms:pair, rows, eventDate, key:`event:${digest(JSON.stringify([event.family, pair, eventDate])).slice(0, 24)}`, label:anchor.title, score:headlineCount + namedCount * 3 + (eventDate ? 2 : 0) });
    }
  }
  return clusters;
}

function candidatesForQuestion(documents, anchor) {
  const candidates = new Map();
  for (const seed of documents.filter(doc => doc.question)) {
    const q = seed.question;
    const focus = q.focus.slice().sort();
    const key = `question:${digest(JSON.stringify([q.intent, focus])).slice(0, 24)}`;
    if (candidates.has(key)) continue;
    const rows = documents.filter(doc => {
      if (doc.collectionId === seed.collectionId) return true;
      const titleCoverage = intersect(focus, doc.titleTerms).length;
      const context = doc.early.some(row => subset(focus, row.terms));
      if (doc.question && (doc.question.intent !== q.intent || !subset(focus, doc.question.focus))) return false;
      return titleCoverage === focus.length || context && titleCoverage >= Math.max(2, focus.length - 1);
    });
    if (rows.length >= MIN_ARTICLES && rows.includes(anchor)) {
      candidates.set(key, { kind:'question', intent:q.intent, terms:focus, rows, key, label:q.text, score:2 + focus.length });
    }
  }
  return [...candidates.values()];
}

function requestedFocus(question, frame) {
  const probes = [frame.focus, frame.aim, ...Object.values(frame.mechanisms)];
  const specific = probes.reduce((remaining, test) => remaining.replace(new RegExp(test.source, 'gu'), ' '), question);
  return focalWords(specific).filter(term => !SCOPE_FILLER.test(term));
}

function profileMatchesFocus(doc, profile, focus) {
  if (!focus.length) return true;
  const contexts = [doc.title, ...profile.evidence.map(row => doc.text.slice(Math.max(0, row.start - 100), row.end + 100))];
  const covered = new Set(contexts.flatMap(context => focalWords(context)));
  return focus.every(term => covered.has(term));
}

function scopeIntent(question) {
  return QUESTION_KINDS.get(QUESTION_INTENT.exec(question)?.[0].toLowerCase());
}

function candidatesForAnswerFrames(documents, anchor, question) {
  const intent = scopeIntent(question);
  if (intent === 'reason' || intent === 'definition') return [];
  const topics = [];
  for (const frame of QUESTION_FRAMES) {
    if (question && (!frame.focus.test(question) || !frame.aim.test(question))) continue;
    const focus = question ? requestedFocus(question, frame) : [];
    const matching = documents.flatMap(doc => {
      const profile = question ? doc.answers.find(answer => answer.frame === frame) : doc.answers[0];
      return profile?.frame === frame && profileMatchesFocus(doc, profile, focus) ? [{ doc, profile }] : [];
    });
    if (matching.length < 2 || !matching.some(row => row.doc === anchor)) continue;
    const profiles = new Map(matching.map(({ doc, profile }) => [doc.collectionId, profile.evidence]));
    topics.push({
      kind:'question', family:frame.id, terms:focalWords(frame.label), profiles, rows:matching.map(({ doc }) => doc),
      key:`question:${frame.id}`,
      label:frame.label, score:matching.reduce((score, row) => score + row.profile.score, 0) / matching.length,
    });
  }
  return topics;
}

function sharedFocusSets(terms) {
  const sets = [];
  for (let first = 0; first < terms.length - 1; first++) {
    for (let second = first + 1; second < terms.length; second++) {
      if (terms.length === 2) sets.push([terms[first], terms[second]].sort());
      for (let third = second + 1; third < terms.length; third++) {
        sets.push([terms[first], terms[second], terms[third]].sort());
      }
    }
  }
  return sets;
}

function genericQuestionCandidates(documents, anchor, question) {
  // For topics without a vocabulary frame, require declarative goals and two
  // shared, specific concepts used together in a direct, substantive claim.
  // Do not infer a question from the subject or a broad embedding alone.
  if (anchor.answers.length || ['reason', 'definition', 'time'].includes(scopeIntent(question))) return [];
  const topics = [];
  for (const [family, goal] of PROCEDURAL_GOALS) {
    if (question && !goal.test(question)) continue;
    const matching = documents.filter(doc => !doc.answers.length && !doc.question && goal.test(doc.title.toLowerCase()));
    if (matching.length < MIN_ARTICLES || !matching.includes(anchor)) continue;
    const titleFocus = new Map(matching.map(doc => [doc, focalWords(doc.title).filter(term => !goal.test(term) && !SCOPE_FILLER.test(term))]));
    const terms = titleFocus.get(anchor).filter(term => matching.filter(doc => titleFocus.get(doc).includes(term)).length >= MIN_ARTICLES).slice(0, 12);
    for (const focus of sharedFocusSets(terms)) {
      if (question && !subset(focus, focalWords(question))) continue;
      const matchingFocus = matching.filter(doc => subset(focus, titleFocus.get(doc)));
      // A wider phrase is not its own problem when other articles repeatedly
      // qualify it with a third concept that the anchor does not discuss.
      if (focus.length === 2 && matchingFocus.some(doc => titleFocus.get(doc).some(term => !focus.includes(term)
        && matchingFocus.filter(other => titleFocus.get(other).includes(term)).length >= MIN_ARTICLES))) continue;
      const profiles = new Map();
      const rows = matchingFocus.filter(doc => {
        const evidence = doc.passages.filter(row => {
          const statement = row.text.toLowerCase();
          return subset(focus, row.terms) && goal.test(statement) && ACTIONABLE_STATEMENT.test(statement)
            && !ATTRIBUTED_WORK.test(row.text) && !BOILERPLATE.test(row.text);
        }).map(row => ({ ...row, focal:3, independent:!doc.origin?.external }));
        if (!evidence.length) return false;
        profiles.set(doc.collectionId, evidence);
        return true;
      });
      if (rows.length < MIN_ARTICLES || !rows.includes(anchor)) continue;
      const title = rows.map(row => row.title).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
      topics.push({
        kind:'question', family, terms:focus, rows, profiles,
        key:`question:${digest(JSON.stringify([family, focus])).slice(0, 24)}`,
        label:`「${title}」有哪些做法？`, score:1,
      });
    }
  }
  return topics;
}

function legacyQuestionMatch(topic, question) {
  if (!question) return true;
  const intent = scopeIntent(question);
  if (intent && topic.intent && intent !== topic.intent) return false;
  const words = focalWords(question).filter(term => !SCOPE_FILLER.test(term));
  const match = intersect(words, topic.terms);
  return match.length >= 2 && match.length / topic.terms.length >= .66 && match.length / words.length >= .65;
}

function qualifiedPassages(doc, topic) {
  if (topic.profiles) return topic.profiles.get(doc.collectionId) || [];
  const relevant = doc.passages.filter(row => intersect(topic.terms, row.terms).length > 0);
  const hasCentralEvidence = relevant.some(row => row.independent || row.features.length > 0);
  if (!hasCentralEvidence) return relevant.slice(0, 2);
  const result = [];
  const focusedLines = new Set(relevant.map(row => row.lineStart));
  for (const [index, row] of doc.passages.entries()) {
    const focal = intersect(topic.terms, row.terms).length;
    const nearby = focusedLines.has(row.lineStart) || index > 0 && intersect(topic.terms, doc.passages[index - 1].terms).length > 0;
    if (!focal && (!nearby || !row.features.length)) continue;
    if (!row.features.length && !row.independent && !focal) continue;
    result.push({ ...row, focal });
  }
  return result;
}

function sourceProjection({ doc, evidence:rows, originKey, otherFeatures, directWork }, direct, newFeature) {
  const ranked = rows.map(row => {
    const newFeatures = row.features.filter(feature => !otherFeatures.has(feature));
    const score = (row.focal || 0) * 4 + Number(row.independent) * 4 + Number(FINDING.test(row.text)) * 5
      + row.features.length + newFeatures.length * 2 + (row.answerWeight || 0) - Number(FUTURE_WORK.test(row.text)) * 7;
    return { ...row, score };
  }).sort((a, b) => b.score - a.score || a.start - b.start);
  const cite = row => ({
    id:`local-evidence:${digest(`${doc.documentVersionId}\0${row.start}\0${row.end}`).slice(0, 24)}`,
    text:row.text, start:row.start, end:row.end, locator:`原文字符 ${row.start + 1}–${row.end}`,
  });
  const contributionEvidence = new Map();
  for (const row of ranked.filter(direct)) for (const feature of row.features) {
    if (!contributionEvidence.has(feature)) contributionEvidence.set(feature, cite(row));
  }
  const newCitation = newFeature && contributionEvidence.get(newFeature);
  const evidence = ranked.slice(0, 3).map(cite);
  const leadingEvidence = newCitation ? [newCitation, ...evidence.filter(entry => entry.id !== newCitation.id)].slice(0, 3) : evidence;
  return { collectionId:doc.collectionId, documentVersionId:doc.documentVersionId, title:doc.title, url:doc.url,
    publisher:asText(doc.publisher).trim() || doc.host, publishedAt:publicationDate(doc), capturedAt:doc.capturedAt || '',
    originKey, independent:directWork, contributionFeatures:[...contributionEvidence.keys()],
    contributionEvidence:Object.fromEntries(contributionEvidence), evidence:leadingEvidence };
}

function checkTopic(topic, allDocuments, passages = topic.rows.map(doc => ({ doc, evidence:qualifiedPassages(doc, topic) })), requireNewInformation = true) {
  const keys = originKeys(allDocuments);
  const rows = passages.filter(row => row.evidence.length > 0).map(({ doc, evidence }) => ({ doc, originKey:keys.get(doc.collectionId), evidence }));
  if (rows.length < MIN_ARTICLES) return { reason:'insufficient_articles' };
  const byOrigin = new Map();
  for (const row of rows) {
    if (!row.originKey) continue;
    const group = byOrigin.get(row.originKey) || [];
    group.push(row);
    byOrigin.set(row.originKey, group);
  }
  if (byOrigin.size < MIN_SOURCES) return { reason:'insufficient_sources' };

  const direct = (evidence, row) => evidence.independent || !topic.profiles && row.doc.origin?.verified && !ATTRIBUTED_WORK.test(evidence.text);
  const featuresByOrigin = new Map([...byOrigin].map(([key, group]) => [key, new Set(group.flatMap(row => row.evidence.filter(evidence => direct(evidence, row)).flatMap(evidence => evidence.features)))]));
  const contributions = rows.map(row => {
    const otherFeatures = new Set([...featuresByOrigin].filter(([key]) => key !== row.originKey).flatMap(([, features]) => [...features]));
    const directWork = !topic.profiles && row.doc.origin?.verified || row.evidence.some(evidence => direct(evidence, row));
    const addsInformation = row.evidence.some(evidence => direct(evidence, row) && evidence.features.some(feature => !otherFeatures.has(feature)));
    return { ...row, otherFeatures, addsInformation, directWork };
  });
  const independent = new Set(contributions.filter(row => row.directWork && row.originKey).map(row => row.originKey));
  if (independent.size < MIN_SOURCES) return { reason:'insufficient_sources' };
  const novel = contributions.find(row => row.originKey && row.addsInformation);
  if (!novel && requireNewInformation) return { reason:'no_new_information' };

  const anchor = contributions[0];
  const anotherOrigin = novel && contributions.find(row => row.originKey && row.originKey !== novel.originKey && row.directWork);
  const prioritized = [anchor, novel, anotherOrigin, ...contributions].filter(Boolean);
  return { prioritized, direct, independentSourceCount:independent.size, articleCount:rows.length };
}

function continuationContribution(rows, direct, baseIds) {
  const baseFeatures = new Set(rows.filter(row => baseIds.has(row.doc.collectionId)).flatMap(row => row.doc.passages.flatMap(passage => passage.features)));
  for (const row of rows) {
    if (baseIds.has(row.doc.collectionId) || !row.originKey) continue;
    const features = row.evidence.filter(passage => direct(passage, row)).flatMap(passage => passage.features);
    const feature = features.find(value => !baseFeatures.has(value));
    if (feature) return { row, feature };
  }
  return null;
}

function exactThree(topic, rows, anchor) {
  const seed = rows.find(row => row.doc === anchor);
  if (!seed) return null;
  const others = rows.filter(row => row !== seed);
  for (const [index, first] of others.entries()) {
    for (const second of others.slice(index + 1)) {
      const group = [seed, first, second];
      const checked = checkTopic(topic, group.map(row => row.doc), group);
      if (checked.prioritized) return checked;
    }
  }
  return null;
}

function isRelated(doc, anchor) {
  if (!anchor) return false;
  if (anchor.answers[0] && anchor.answers[0].frame === doc.answers[0]?.frame) return true;
  const sharedTitle = intersect(doc.titleTerms, anchor.titleTerms);
  if (sharedTitle.length > 1 || sharedTitle.some(term => anchor.named.has(term) && doc.named.has(term))) return true;
  const focus = anchor.early.flatMap(row => row.terms);
  if (intersect(doc.titleTerms, focus).length >= 2) return true;
  return anchor.events.some(event => doc.events.some(other => other.family === event.family && intersect(event.focus, other.focus).length >= 2));
}

/** Qualifies locally retrieved candidates. Topic and novelty come from source evidence, never an LLM or a URL alone. */
export function classifyCurationCandidates({ anchorId, documents = [], question, preferredTopicKeys = [], preferredSourceIds = [], includeAllSources = false, usedSources = [], automaticGroup = false, continuation } = {}) {
  const anchorInput = documents.find(doc => doc?.collectionId === anchorId);
  const preparedAnchor = prepare(anchorInput);
  const others = documents.filter(doc => doc?.collectionId !== anchorId).slice(0, MAX_DOCUMENTS - 1).map(prepare).filter(Boolean);
  const usedIds = new Set(usedSources.map(source => source.id));
  const usedUrls = new Set(usedSources.map(source => comparableUrl(source.url)).filter(Boolean));
  const usedLocales = new Set(usedSources.map(source => canonicalSourceUrl(source.url)).filter(Boolean).map(localeRoute).filter(Boolean));
  const unique = dedupe(preparedAnchor ? [preparedAnchor, ...others] : others, new Set([...usedIds, ...preferredSourceIds]));
  const distinct = unique.filter(doc => !usedIds.has(doc.collectionId) && !usedUrls.has(doc.urlKey) && !usedLocales.has(doc.localeKey));
  const anchor = preparedAnchor && distinct.includes(unique[0]) ? unique[0] : null;
  const related = distinct.filter(doc => doc !== anchor && isRelated(doc, anchor)).map(({ collectionId, documentVersionId, title, url }) => ({ collectionId, documentVersionId, title, url }));
  if (!anchor) return { status:'related', reason:'source_unavailable', related };
  if (distinct.length < MIN_ARTICLES) return { status:'related', reason:'insufficient_articles', related };
  const focus = asText(question).normalize('NFKC').toLowerCase().trim().slice(0, 500);
  const legacy = [...candidatesForQuestion(distinct, anchor), ...candidatesForEvent(distinct, anchor)].filter(topic => legacyQuestionMatch(topic, focus));
  const preferred = new Set(preferredTopicKeys);
  const topics = [...legacy, ...candidatesForAnswerFrames(distinct, anchor, focus), ...genericQuestionCandidates(distinct, anchor, focus)]
    .sort((a, b) => Number(preferred.has(b.key)) - Number(preferred.has(a.key))
      || b.rows.length - a.rows.length || b.score - a.score || a.key.localeCompare(b.key));
  let reason = 'no_clear_topic';
  let repeatsBase = false;
  for (const topic of topics.slice(0, 30)) {
    const { kind, label, key, family, terms, intent, eventDate } = topic;
    const summary = { kind, label, key, family, terms, intent, eventDate };
    if (continuation && !continuation.matchesTopic(summary)) continue;
    const checked = checkTopic(topic, distinct, undefined, !continuation);
    if (!checked.prioritized) { if (reason === 'no_clear_topic') reason = checked.reason; continue; }
    const distinctRows = [...new Map(checked.prioritized.map(row => [row.doc.collectionId, row])).values()];
    const group = automaticGroup && exactThree(topic, distinctRows, anchor);
    if (automaticGroup && !group) { reason = 'insufficient_sources'; continue; }
    const { prioritized, direct, ...counts } = group || checked;
    const rows = group ? [...new Map(prioritized.map(row => [row.doc.collectionId, row])).values()] : distinctRows;
    if (continuation && rows.length !== documents.length) continue;
    const contribution = continuation && continuationContribution(rows, direct, continuation.baseIds);
    if (continuation && !contribution) { repeatsBase = true; continue; }
    const sources = (includeAllSources ? rows : rows.slice(0, MAX_SOURCES))
      .map(row => sourceProjection(row, evidence => direct(evidence, row), row === contribution?.row ? contribution.feature : undefined));
    return { status:'ready', reason:'ready', related, topic:summary, sources, ...counts,
      ...(contribution ? { continuationSourceId:contribution.row.doc.collectionId } : {}) };
  }
  return { status:'related', reason:repeatsBase ? 'no_new_information' : reason, related, ...(repeatsBase ? { repeatsBase:true } : {}) };
}
