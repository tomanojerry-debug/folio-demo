// Frozen independently before first scoring. The first run failed; later runs
// are regressions, not new blind validation. Keep every query and label fixed.
export const freshKnowledgeChallenge = Object.freeze({
  name:'forme-knowledge-fresh-6docs-12queries-v1', version:1,
  fixtureMode:'synthetic-labelled-fresh-challenge',
  labelPolicy:'3 directly supports the requested detail; 2 substantially supports a requested comparison. Labels frozen before scoring; unlabelled results conservatively count as false.',
  documents:[
    { id:'fresh-corner', group:'fresh-corner', title:'在转角之前看懂方向', url:'https://fresh.synthetic.example/corner', body:'图书馆改造记录提出，在读者到达岔路之前放置方向标识，并让每一层的图标含义保持一致。颜色可以区分区域，但不能成为唯一线索：色觉差异者可能无法辨认，应同时写出区域名称并提供形状或图标。把整张楼层地图缩小塞进每一个路口，会增加读者寻找目的地的负担。入口总览与路口指引承担不同任务。' },
    { id:'fresh-terminal', group:'fresh-terminal', title:'Consistency at the terminal', url:'https://fresh.synthetic.example/terminal', body:'Airport wayfinding works best when a pictogram keeps the same meaning from entrance to gate. Place directional signs before decision points so passengers can choose a route without stopping in the crossing. Color coding can supplement text labels and recognizable symbols, but a traveler should not need to distinguish colors to find the correct concourse. A full map at the entrance and brief guidance at a junction serve different purposes.' },
    { id:'fresh-printer', group:'fresh-printer', title:'One submitted job, one printed copy', url:'https://fresh.synthetic.example/printer', body:'A network printer accepts a client-supplied idempotency key for each logical print job. If the connection breaks after acceptance, the client retries with the same key rather than creating a fresh job identifier. The printer stores the key and completed result together, so a duplicate request can return the previous result instead of printing another copy. Retries with a new key are distinct jobs. The key is scoped to an account and expires after twenty-four hours.' },
    { id:'fresh-queue', group:'fresh-queue', title:'队列收到两次，不等于业务要做两次', url:'https://fresh.synthetic.example/queue', body:'消息队列可能再次投递同一事件，消费者应使用稳定的事件编号去重。只有业务结果和已处理编号可靠地一起提交，才能在处理后崩溃并重启时避免重复执行。如果每次重投都生成新的编号，去重记录便失去作用。本文的图像转换任务按工作空间与事件编号确定唯一性；单纯把最近编号留在内存里不能覆盖进程重启。' },
    { id:'fresh-dough', group:'fresh-dough', title:'面团膨胀之后还要观察什么', url:'https://fresh.synthetic.example/dough', body:'这份面包实验把室温组设为二十四摄氏度。酵母活性会随温度变化，但把面团加得越热并不意味着成品越好：过快发酵可能让风味发展不足，温度过高也会伤害酵母。作者用体积、气泡和按压后的回弹共同判断进度，不只依赖钟表。配方含糖量、含水量和发酵剂状态改变时，原先时间表也需要调整。' },
    { id:'fresh-retard', group:'fresh-retard', title:'An overnight pause in the dough schedule', url:'https://fresh.synthetic.example/retard', body:'Cold fermentation slows sourdough activity, allowing a baker to extend the schedule and develop flavor gradually. Refrigeration does not stop fermentation completely. Judge the dough by expansion, bubbles and its response to touch rather than treating an overnight timer as proof of readiness. A warm kitchen or a more active starter can change the required time. The experiment compares flavor and handling, not a universal promise that longer storage always improves bread.' },
  ],
  queries:[
    { id:'fresh01', category:'cross_language', query:'How should a library mark its zones when some readers cannot tell the colors apart?', relevant:{'fresh-corner':3} },
    { id:'fresh02', category:'cross_language', query:'机场的指示牌为什么要让同一个图形从入口到登机口始终表达同一个意思？', relevant:{'fresh-terminal':3} },
    { id:'fresh03', category:'paraphrase', query:'图书馆和航站楼的文章，对岔路前的信息提示以及颜色搭配文字，有哪些共同建议？', relevant:{'fresh-corner':3,'fresh-terminal':3} },
    { id:'fresh04', category:'cross_language', query:'How can an image worker avoid processing an event again after crashing and restarting?', relevant:{'fresh-queue':3} },
    { id:'fresh05', category:'cross_language', query:'网络中断后重新提交打印，怎样避免同一份文档又打印一遍？', relevant:{'fresh-printer':3} },
    { id:'fresh06', category:'paraphrase', query:'队列一条任务发来两遍，为什么临时记在内存里仍然可能让它重复执行？', relevant:{'fresh-queue':3} },
    { id:'fresh07', category:'cross_language', query:'Does making a bread dough much hotter always help fermentation and final flavor?', relevant:{'fresh-dough':3} },
    { id:'fresh08', category:'cross_language', query:'酸面包放冰箱过夜，发酵是否完全停止，第二天怎么判断它准备好了？', relevant:{'fresh-retard':3} },
    { id:'fresh09', category:'no_result', query:'二维流形上的欧拉示性数怎样计算？', relevant:{} },
    { id:'fresh10', category:'no_result', query:'What causes the rings of Saturn to change brightness?', relevant:{} },
    { id:'fresh11', category:'assistant_identity', query:'你是什么模型在回答我？', relevant:{} },
    { id:'fresh12', category:'assistant_identity', query:'Tell me which model powers you.', relevant:{} },
  ],
  similarCases:[
    {id:'fresh-similar-a',anchor:'fresh-corner',relevant:{'fresh-terminal':3}},
    {id:'fresh-similar-b',anchor:'fresh-printer',relevant:{'fresh-queue':3}},
    {id:'fresh-similar-c',anchor:'fresh-dough',relevant:{'fresh-retard':3}},
  ],
  mutationProbe:{revisionId:'fresh-dough',staleQuery:'室温组 二十四摄氏度',staleMarkers:['二十四摄氏度'],failureId:'fresh-corner',deletionId:'fresh-queue',deletionQuery:'消费者 稳定的事件编号 去重'},
});
