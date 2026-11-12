// Original Folio demonstration material. Stable IDs preserve imported references.
const addedAt = "2026-11-12T00:00:00.000Z";
const demoSource = "Folio 示例笔记";
const noteUrl = id => `https://github.com/tomanojerry-debug/folio-demo/blob/main/site/demo/notes/${id}.md`;
const notes = [
  ["cave-space", "从岸边看一条河", "有水的画面往往也有路。先寻找画家把观看者安放在哪里，再沿着水边看远处。", "画的下缘可以成为进入景物的起点。", ["岸线", "视点"]],
  ["hermes-desktop", "桥把视线带到哪里", "桥可以连接两个地方，也可以横向切开整个画面。遮住桥再看一次，比较远景的重心。", "桥让画面有一条可以反复确认的方向。", ["桥", "视线"]],
  ["cowork-setup", "同一扇窗的两种光", "清晨的亮处先照出窗框。傍晚的光更低，室内物体在窗台旁形成清楚的轮廓。", "方向相同的光也能在不同时间改写构图。", ["窗", "光线"]],
  ["content-system", "色彩怎样留下空气", "把最冷和最暖的区域分别记下来，再看它们相邻的地方是否有一层过渡色。", "冷暖交界有时比轮廓更能提示距离。", ["颜色", "光线"]],
  ["local-agents", "人物以外的日常", "桌沿、衣袖和空椅子提供了关于动作的线索。看不清面孔时，可以从物件的位置猜测活动。", "静物的位置让刚刚发生的动作有迹可循。", ["人物", "日常"]],
  ["human-ai-trust", "画外还有一把椅子", "在构图边缘寻找一个未被画全的物件。它可能把注意力带向想象中的画外空间。", "截断的物件给观看者留下补全空间的机会。", ["边缘", "日常"]],
];

export const demoCollections = notes.map(([id, title]) => ({
  id, title, source: demoSource, type: "article", status: "ready",
  thumbnail: `./assets/demo/${id}.png`, url: noteUrl(id), addedAt,
}));

export const demoExtractions = notes.map(([collectionId, title, overview, summary, concepts]) => ({
  collectionId, title, status: "qualified", summary, quote: overview,
  quoteAt: "示例原文", evidence: "示例原文", concepts, tags: concepts,
  digest: { overview }, breakdown: [], source: "folio_demo_notes",
}));

export const provenance = Object.fromEntries(demoCollections.map(({ id }) => [
  id, { duration: "原创短文", caption: demoSource, fetchedBy: "Folio 示例资料" },
]));

const roomSpecs = [
  ["boundaries", "视线从哪里进入", "画面中的岸线和桥，怎样安排观看的起点和方向？"],
  ["practice", "光线如何改变空间", "用颜色与光线对照，找出两张画的远近关系。"],
  ["presence", "从物件读到日常", "当人物只是画面的一部分，物件还告诉了我们什么？"],
];

export const exhibitionFixture = {
  id: "systems-step-back",
  title: "从哪里开始看一张画",
  subtitle: "沿着视线、光线和物件，读六则观看笔记",
  status: "ready",
  themeId: "theme-systems-step-back",
  sourceCollectionIds: demoCollections.map(({ id }) => id),
  rooms: roomSpecs.map(([id, title, prompt], index) => {
    const pair = demoCollections.slice(index * 2, index * 2 + 2);
    const excerpts = demoExtractions.slice(index * 2, index * 2 + 2);
    return {
      id, number: String(index + 1).padStart(2, "0"), title, prompt, environment: "示例展厅",
      exhibits: pair.map((item, i) => ({
        id: item.id, title: item.title, platform: demoSource, media: "image", image: item.thumbnail,
        description: excerpts[i].summary, evidence: "示例原文",
      })),
      connection: {
        id: `${id}-comparison`, label: "策展比较", evidenceIds: pair.map(item => item.id),
        sideA: excerpts[0].summary, sideB: excerpts[1].summary, hypothesis: prompt,
      },
    };
  }),
};

const records = [
  ["systems-step-back", exhibitionFixture.title, 0, "同一张画，先看视点和边缘，再看颜色和物件，可以读出不同的线索。"],
  ["presence", "物件里的日常", 4, "试着先记下物件的排列，再解释画里发生了什么。"],
  ["external-shape", "把光放在一起看", 2, "比较不同的光线，可以解释同一个空间的轮廓为何会改变。"],
  ["visible-work", "沿着视线走", 1, "桥和岸线都能提供线索，跟着它们看一遍，再回到人物。"],
];

export const demoExhibitionRecords = records.map(([exhibitionId, exhibitionTitle, cover, content]) => ({
  id: `record-${exhibitionId}`, exhibitionId, exhibitionTitle, content,
  createdAt: addedAt, updatedAt: addedAt, images: [demoCollections[cover].thumbnail],
}));

export const demoExhibitionNotes = [0, 5].map((index) => ({
  id: `exhibit-note-demo-${index ? "responsibility" : "boundary"}`, kind: "text",
  content: demoExtractions[index].quote, comment: "下次看展时试试这个观察角度。",
  exhibitId: demoCollections[index].id, exhibitTitle: demoCollections[index].title,
  exhibitionId: exhibitionFixture.id, exhibitionTitle: exhibitionFixture.title,
  chapter: index ? "03" : "01", chapterTitle: roomSpecs[index ? 2 : 0][1],
  source: demoSource, createdAt: addedAt,
}));

export const demoStudioNotes = records.slice(0, 3).map(([exhibitionId, exhibitionTitle, cover, content], index) => ({
  id: `note-${exhibitionId}`, exhibitionId, exhibitionTitle, title: exhibitionTitle,
  status: index ? "draft" : "saved", cover: demoCollections[cover].thumbnail, updatedAt: addedAt,
  citations: [demoCollections[cover].title],
  blocks: [{ type: "opinion", ai: false, text: content }],
}));

export const demoThemes = [{
  id: exhibitionFixture.themeId, title: "观看的路线", status: "forming", evidenceCount: 6,
  exhibitionId: exhibitionFixture.id, noteId: "note-systems-step-back",
}];

export const exhibitInterpretation = Object.fromEntries(notes.map(([id, title, overview, summary, concepts], index) => {
  const peer = demoCollections[index % 2 === 0 ? index + 1 : index - 1];
  return [id, {
    kind: "原创示例文章", oneLiner: summary, overview, structure: "这则笔记提供一种实际可以尝试的观察方式。",
    facts: [["来源", demoSource], ["主题", concepts.join("、")]],
    reading: {
      subtitle: "试着换一种顺序看", deck: title,
      argument: [{ copy: overview, claim: summary, cites: ["示例原文"] }],
    },
    limits: {
      subtitle: "一种观看方法", items: [{
        basis: "编辑解读", kind: "适用范围", text: "这种观察方式可以提出问题。对画作历史的判断需要另查史料。", cite: "策展说明",
      }],
    },
    next: {
      subtitle: "再看同一展厅的另一则笔记", takeaway: "把观察放在一起，可以发现自己先注意到了什么。",
      copy: `接着看《${peer.title}》。`,
      relation: { phrase: peer.title, target: peer.id, kind: "同一展厅", evidence: "示例原文", backEvidence: "示例原文" },
    },
  }];
}));
