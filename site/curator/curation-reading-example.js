// A fixed editorial example using short, verified excerpts from three public
// articles. It never reads the user's library or calls a model.
const sources = [
  {
    id: 'nasa',
    publisher: 'NASA',
    title: 'NASA Confirms DART Mission Impact Changed Asteroid’s Motion in Space',
    date: '2022-10-11',
    role: '任务实测',
    contribution: '公布撞击后测得的初步轨道周期。',
    url: 'https://www.nasa.gov/news-release/nasa-confirms-dart-mission-impact-changed-asteroids-motion-in-space/',
  },
  {
    id: 'eso',
    publisher: 'ESO',
    title: 'First results from ESO telescopes on the aftermath of DART’s asteroid impact',
    date: '2023-03-21',
    role: '地面观测',
    contribution: '用望远镜记录碎屑云，并研究撞击前后的光线变化。',
    url: 'https://www.eso.org/public/news/eso2303/',
  },
  {
    id: 'esa',
    publisher: 'ESA',
    title: 'Planetary defence mission Hera heading for deflected asteroid',
    date: '2024-10-07',
    role: '后续调查',
    contribution: '解释为什么要发射 Hera，以及近距离调查要回答的问题。',
    url: 'https://www.esa.int/media-advisories/news-media/media/media-advisories/n-57-2024-planetary-defence-mission-hera-heading-for-deflected-asteroid',
  },
];

const evidence = [
  { id: 'nasa-impact', sourceId: 'nasa', badge:'撞击日期', quote: 'DART’s intentional collision with Dimorphos on Sept. 26', locator: '正文：撞击日期与轨道周期段落' },
  { id: 'nasa-orbit', sourceId: 'nasa', badge:'轨道周期', quote: 'by 32 minutes, shortening the 11 hour and 55-minute orbit to 11 hours and 23 minutes', locator: '正文：撞击前后的轨道周期' },
  { id: 'eso-debris', sourceId: 'eso', badge:'碎屑云', quote: 'followed the evolution of the cloud of debris for a month', locator: '正文：MUSE 碎屑云观测' },
  { id: 'eso-light', sourceId: 'eso', badge:'偏振观测', quote: 'the level of polarisation suddenly dropped after the impact', locator: '正文：FORS2 偏振与亮度观测' },
  { id: 'eso-particles', sourceId: 'eso', badge:'可能解释', quote: 'smaller ones into the cloud', locator: '正文：对观测结果的另一种解释' },
  { id: 'esa-revised', sourceId: 'esa', badge:'33 分钟', quote: 'by 33 minutes, nearly 5% of its original value', locator: '正文：ESA 引用的地面观测结果' },
  { id: 'esa-launch', sourceId: 'esa', badge:'发射时间', quote: 'on 7 October at 10:52 local time', locator: '导言：Hera 发射信息' },
  { id: 'esa-unknown', sourceId: 'esa', badge:'待解问题', quote: 'How big was the crater left by DART’s impact', locator: '正文：撞击留下的待解问题' },
].map(entry => ({
  ...entry,
  url: `${sources.find(source => source.id === entry.sourceId).url}#:~:text=${encodeURIComponent(entry.quote).replaceAll('-', '%2D')}`,
}));

export const curationReadingExample = {
  id: 'dart-planetary-defence',
  title: '撞上一颗小行星之后',
  subtitle: '从 NASA 的 DART 撞击，到地面望远镜观测，再到 ESA 派出的后续探测器：一次行星防御实验如何被测量和追踪。',
  kicker: '行星防御',
  reason: '三篇报道补全了同一次实验的三个问题：轨道改变了多少、撞击留下了什么、还有哪些问题要到现场才能回答。',
  updatedLabel: '事件回顾 · 2022—2024',
  hero: {
    src: 'https://cdn.eso.org/images/screen/eso2303b.jpg',
    alt: '艺术示意图：DART 撞击 Dimorphos 后，碎屑云从小行星表面向外喷出。',
    credit: 'ESO/M. Kornmesser',
    sourceUrl: 'https://www.eso.org/public/images/eso2303b/',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  sources,
  evidence,
  overview: [
    { title: '轨道周期缩短了约半小时', text: 'DART 撞上小行星卫星 Dimorphos 后，NASA 的初步测量显示，它绕主星一圈从 11 小时 55 分钟缩短到 11 小时 23 分钟。', evidenceIds: ['nasa-orbit'] },
    { title: '望远镜追踪了一个月的碎屑云', text: 'ESO 发布的观测显示，撞击抛出的物质陆续形成团块、螺旋和长尾。研究团队持续追踪了一个月。', evidenceIds: ['eso-debris'] },
    { title: '后续任务要调查撞击现场', text: 'ESA 于 2024 年 10 月发射 Hera。轨道周期已经测出，但撞击留下了多大的坑、是否改变了整颗小行星的形状，仍是这篇报道提出的问题。', evidenceIds: ['esa-launch', 'esa-unknown'] },
  ],
  comparison: [
    {
      title: '三篇报道，各补上哪块证据？',
      prompt: '同一次撞击，有人测轨道，有人看碎屑，还有人准备去现场。',
      entries: [
        { title: 'NASA · 轨道改变了多少？', text: '用地面望远镜测量 Dimorphos 绕主星的周期。2022 年首次发布的结果是缩短 32 分钟。', evidenceIds: ['nasa-orbit'] },
        { title: 'ESO · 撞击抛出了什么？', text: '研究团队追踪了碎屑云的演变，另一组发现撞击后反射光的偏振程度突然下降。它们补充的是物质和表面的线索。', evidenceIds: ['eso-debris', 'eso-light'] },
        { title: 'ESA · 哪些问题还需近距离调查？', text: 'Hera 的发射报道把关注点放在撞击坑、整体形状、结构和质量。报道提出这些问题，并未给出现场测量结果。', evidenceIds: ['esa-launch', 'esa-unknown'] },
      ],
    },
    {
      title: '为什么看到两个数字？',
      prompt: '这里是同一次实验在不同时间公布的测量值。',
      entries: [
        { title: '2022 年的初步数字', text: 'NASA 的首次公告写的是 32 分钟。', evidenceIds: ['nasa-orbit'] },
        { title: '2024 年报道引用的数字', text: 'ESA 在 Hera 发射报道中引用的地面观测值是 33 分钟，接近原周期的 5%。', evidenceIds: ['esa-revised'] },
      ],
    },
  ],
  timeline: [
    { date: '2022-09-26', title: 'DART 撞上 Dimorphos', text: '撞击之后，地面天文学家继续观测小行星卫星绕主星运行的时间。', evidenceIds: ['nasa-impact'] },
    { date: '2022-10-11', title: 'NASA 公布首次轨道测量', text: '每绕主星一圈约少了 32 分钟。', evidenceIds: ['nasa-orbit'] },
    { date: '2023-03-21', title: 'ESO 发布撞击后观测', text: '望远镜记录了碎屑从云团逐渐演变为带有长尾的结构。', evidenceIds: ['eso-debris'] },
    { date: '2024-10-07', title: 'ESA 发射 Hera', text: '新的探测器将前往同一个双小行星系统，进行近距离调查。', evidenceIds: ['esa-launch', 'esa-unknown'] },
  ],
  deepDive: [
    { title: '缩短的是哪一段轨道周期？', text: '这里的周期是小天体 Dimorphos 绕着较大的 Didymos 运行一圈所需的时间。把撞击前后的周期放在一起，就能看出撞击确实改变了它的运动。', evidenceIds: ['nasa-orbit'] },
    { title: '看见变化，和解释变化，是两回事', text: 'ESO 的一组观测显示，撞击后偏振减弱、系统更亮。原文提出两种解释：撞击可能露出了内部物质，也可能把表面物质打碎成更小的颗粒。原文没有在两种解释间下结论。', evidenceIds: ['eso-light', 'eso-particles'] },
    { title: '从地面测量走向现场调查', text: '周期变化说明撞击产生了效果。要理解这次撞击留下的形变，以及不同小行星能否有类似反应，仍需了解 Dimorphos 的结构和质量。Hera 的发射报道给出了这些研究问题。', evidenceIds: ['nasa-orbit', 'esa-unknown'] },
  ],
};
