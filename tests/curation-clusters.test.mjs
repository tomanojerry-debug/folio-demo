import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCurationCandidates } from '../desktop/server/curation-clusters.mjs';
import { readingParagraphs } from '../desktop/server/reading.mjs';

function article(id, title, text, options = {}) {
  const url = options.url || `https://${id}.org/article`;
  return { collectionId:id, documentVersionId:`saved-${id}`, title, text, url, canonicalUrl:url, coverage:'complete', ...options };
}

const collision = [
  article('agency', 'AGENCY confirms ORBITA impact at Mirabel', 'Oct 11, 2024\n\nOn 10 October 2024, the ORBITA team measured the impact at Mirabel. Its investigators confirmed that the impact changed the orbit of Mirabel by 32 minutes.\n\nAGENCY tracked the spacecraft directly through radar.', {capturedAt:'2026-11-01T12:00:00Z'}),
  article('observatory', 'ORBITA impact at Mirabel observed by astronomers', '14 October 2024\n\nThe Observatory telescopes tracked debris around Mirabel after the ORBITA impact on 10 October 2024. Their imaging study showed a dust cloud continued growing for 7 days after impact.', {capturedAt:'2026-11-02T12:00:00Z'}),
  article('institute', 'ORBITA impact reshaped Mirabel', '19 Oct. 2024\n\nInstitute scientists simulated the impact of ORBITA on Mirabel, which took place on 10 October 2024. They used the simulations to compare the shape of Mirabel to observations and found that a crater could be 60 metres across.', {capturedAt:'2026-11-03T12:00:00Z'}),
];

const classify = (documents, anchorId = documents[0].collectionId) => classifyCurationCandidates({ anchorId, documents });

test('a shared named event generates a stable topic and versioned exact evidence from independently observed details', () => {
  const result = classify(collision);
  assert.equal(result.status, 'ready');
  assert.equal(result.topic.kind, 'event');
  assert.equal(result.articleCount, 3);
  assert.equal(result.independentSourceCount, 3);
  assert.equal(classify(collision, 'institute').topic.key, result.topic.key);
  assert.deepEqual(result.sources.map(item => item.publishedAt), ['2024-10-11','2024-10-14','2024-10-19']);
  for (const source of result.sources) {
    const stored = collision.find(doc => doc.collectionId === source.collectionId);
    assert.equal(source.documentVersionId, stored.documentVersionId);
    for (const evidence of source.evidence) {
      assert.ok(evidence.text.length <= 350);
      assert.equal(stored.text.slice(evidence.start, evidence.end), evidence.text);
    }
  }
});

test('when an identical cross-domain copy was saved later it neither raises article count nor replaces the original', () => {
  const reprint = article('republisher', collision[0].title, collision[0].text, {capturedAt:'2026-11-05T12:00:00Z'});
  assert.equal(classify([collision[0], collision[1], reprint], reprint.collectionId).reason, 'insufficient_articles');
  const result = classify([reprint, collision[0], collision[1], collision[2]], reprint.collectionId);
  assert.equal(result.status, 'ready');
  assert.deepEqual(new Set(result.sources.map(item => item.collectionId)), new Set(collision.map(item => item.collectionId)));
});

test('different publishers, URLs and writing styles do not turn one credited wire report into independent sourcing', () => {
  const syndicated = collision.map(item => ({ ...item, text:`Source: Reuters\n\n${item.text}` }));
  assert.equal(classify(syndicated).reason, 'insufficient_sources');
  const uncredited = collision.map(item => ({...item, text:`ORBITA impact at Mirabel on 10 October 2024. ${item.collectionId} published a notice about the collision of ORBITA with Mirabel. The press statement appeared shortly before noon.` }));
  assert.equal(classify(uncredited).status, 'related', 'a same-domain canonical URL does not certify original reporting');
});

test('independent reports repeating the same finding with no substantive difference stay related', () => {
  const reports = [
    article('alpha', 'ORBITA impact at Mirabel', 'At Mirabel the ORBITA impact moved the orbit by 32 minutes. Observers measured that result immediately after the collision.'),
    article('beta', 'Mirabel ORBITA impact update', 'Following the ORBITA impact, astronomers observed Mirabel and measured a change of 32 minutes in the orbit, a change they announced on Monday.'),
    article('gamma', 'News on the ORBITA impact at Mirabel', 'For Mirabel, a measurement confirmed the orbit shifted by 32 minutes after the ORBITA impact. The same outcome was expected by local readers.'),
  ];
  assert.equal(classify(reports).reason, 'no_new_information');
});

test('nearby reporting and similar names do not merge separately dated events or list unrelated articles', () => {
  const separate = article('later', 'ORBITA impact at Mirabel', 'On 26 October 2025, a second ORBITA impact at Mirabel was confirmed by observations. The new impact produced an orbit shift of 11 minutes.');
  const unrelated = article('garden', 'Preparing roses for winter', 'Local gardeners record the cost of protecting roses in cold weather and compare the insulation from mulch and dry leaves.');
  const result = classify([collision[0], collision[1], separate, unrelated]);
  assert.equal(result.status, 'related');
  assert.deepEqual(result.related.map(row => row.collectionId), ['observatory','later']);
  assert.deepEqual(classify([collision[0], unrelated]).related, []);
});

test('articles answering a specific explicit question can group, but a nearby question does not', () => {
  const title = 'How offline SQLite indexing handles deleted notes';
  const docs = [
    article('journal', title, 'We tested offline SQLite indexing against deleted notes. A benchmark shows the method returns no deleted notes within 6 seconds of a deletion.'),
    article('manual', title, 'Our authors interviewed 11 users about deleted notes during offline SQLite indexing. The survey records that old names appeared only in local backup copies.'),
    article('practice', 'Handling deleted notes in offline SQLite indexing', 'We used a documented procedure for offline SQLite indexing that handles deleted notes. Experiments reveal where SQLite stores deleted notes and compare the procedure across versions.'),
    article('backup', 'How does offline SQLite indexing handle backed up notes?', 'An experiment measured copies after a restore and examined offline SQLite indexing. A survey interviewed people who restored archived notes.'),
    article('why', 'Why offline SQLite indexing handles deleted notes', 'We observed how offline SQLite indexing handles deleted notes while inspecting a previous deletion. The researchers describe reasons for this behavior.'),
  ];
  const result = classify(docs);
  assert.equal(result.status, 'ready');
  assert.equal(result.topic.kind, 'question');
  assert.equal(result.articleCount, 3);
  assert.ok(!result.sources.some(source => source.collectionId === 'backup'));
  assert.equal(classify(docs, 'practice').topic?.key, result.topic.key, 'a new declarative headline can finish an existing question cluster');
});

test('declarative articles group by how they verify a completed task, with exact reader passages', () => {
  const noisy = 'Navigation menu '.repeat(135);
  const docs = [
    article('simulation', 'Benchmarking support agents', 'We evaluate agents against simulated users to reproduce difficult support tasks. A benchmark compares the final database state with the expected outcome after each agent task.'),
    article('browser', 'A web environment for autonomous agents', 'Our benchmark evaluates agents executing tasks in a reproducible environment.\n\nThe benchmark compares the predicted answer with a reference answer to evaluate information retrieval.\n\nProgrammatic checks evaluate whether the tool produced the expected state.'),
    article('desktop', 'Measuring desktop agent task completion', `We evaluate agents through a benchmark that runs desktop tasks in different operating systems.\n\n${noisy} We run the evaluation with reproducible setup and evaluation scripts for each desktop task.\n\nOur task evaluation saves the execution trace so graders can reproduce the result.`),
    article('voice', 'A voice interface for support agents', `Agents can route audio to different voice tools and send text through our gateway. ${noisy}\n\n${noisy}\n\nFor comparison, a grader can verify task completion after changing the generated voice. Keep the expected outcome fixed to evaluate voice quality across agent runs.`),
  ];
  const ids = ['browser', 'desktop', 'simulation'];
  for (const anchorId of ids) {
    const result = classify(docs, anchorId);
    assert.equal(result.topic.key, 'question:verify-outcomes');
    assert.deepEqual(result.sources.map(source => source.collectionId).sort(), ids);
    assert.equal(result.independentSourceCount, 3);
    for (const source of result.sources) {
      const saved = docs.find(doc => doc.collectionId === source.collectionId);
      for (const evidence of source.evidence) {
        const passage = readingParagraphs(saved.text).find(p => p.start <= evidence.start && p.end >= evidence.end);
        assert.ok(passage);
        assert.equal(passage.text.slice(evidence.start - passage.start, evidence.end - passage.start), evidence.text);
      }
    }
  }
  const scoped = question => classifyCurationCandidates({ anchorId:'simulation', documents:docs.slice(0, 3), question });
  assert.equal(scoped('How can we evaluate whether an agent actually completed a task?').status, 'ready');
  assert.equal(scoped('怎么验证 Agent 真的完成了任务').status, 'ready');
  assert.equal(scoped('怎么验证语音 Agent 的延迟').status, 'related');
  assert.equal(scoped('How do we evaluate whether this agent meets an audio latency target?').status, 'related');

  const calibration = article('calibration', 'Evaluating agent tasks with calibrated graders',
    'We evaluate whether an agent task achieved the expected outcome. The task evaluation uses model-based graders with a rubric and periodic human calibration to keep the scores consistent.');
  const update = classify([...docs.slice(0, 3), calibration], 'calibration');
  const supplement = update.sources.find(source => source.collectionId === 'calibration');
  const detail = 'detail:humanCalibration';
  assert.ok(supplement.contributionFeatures.includes(detail));
  assert.ok(update.sources.filter(source => source !== supplement).every(source => !source.contributionFeatures.includes(detail)));
  const citation = supplement.contributionEvidence[detail];
  assert.equal(calibration.text.slice(citation.start, citation.end), citation.text);
  assert.match(citation.text, /periodic human calibration/u);
});

test('localized equivalents never count as extra articles, even below a docs prefix', () => {
  const one = article('permissions', 'Permissions for automated tools', 'Permission rules let the agent allow or deny an operation. When running commands that make destructive changes, the tool asks for confirmation.', {url:'https://example.org/docs/en/tools/permissions'});
  const other = article('rules', 'Approval rules for tool calls', 'The tool policy engine evaluates each decision against the highest-priority rule. Users may choose an approval mode that prompts for explicit confirmation.', {url:'https://other.example/guide'});
  const translated = article('localized', '工具权限配置', '通过权限规则控制智能体如何执行工具调用。只读工具允许自动执行，修改重要系统文件等敏感操作先向用户请求人工确认。', {url:'https://example.org/docs/zh-CN/tools/permissions'});
  assert.equal(classify([one, other, translated]).reason, 'insufficient_articles');
  const extra = article('scheduling', 'Tool approvals in unattended jobs', 'In unattended jobs the system can deny the tool call if nobody is available to respond. When the tool prompts for confirmation, only the current session remembers the answer.', {url:'https://example.org/docs/en/jobs/permissions'});
  const ready = classify([one, translated, other, extra]);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.articleCount, 3);
  assert.equal(ready.independentSourceCount, 2);
  assert.equal(ready.sources.filter(source => [one.collectionId, translated.collectionId].includes(source.collectionId)).length, 1);
  const incremental = classifyCurationCandidates({
    anchorId:extra.collectionId, documents:[one, translated, other, extra], preferredSourceIds:[translated.collectionId],
  });
  assert.equal(incremental.articleCount, 3);
  assert.equal(incremental.independentSourceCount, 2);
  assert.ok(incremental.sources.some(source => source.collectionId === translated.collectionId));
  assert.ok(incremental.sources.every(source => source.collectionId !== one.collectionId));
});

test('different wordings of the same operational answer do not meet the information threshold', () => {
  const docs = [
    article('operations', 'An evaluation of agent task results', 'The benchmark checks the final database state at the end of every agent task. We compare that final database state with the expected outcome.'),
    article('review', 'Assessing task outcomes with an agent benchmark', 'The agent task benchmark evaluates success against the final database state. Its evaluation compares the final database state with the expected outcome.'),
    article('methods', 'An execution-based evaluation for agent tasks', 'This evaluation checks agent task completion by using the final database state. We compare the database state with the expected outcome.'),
  ];
  assert.equal(classify(docs).reason, 'no_new_information');
});

test('the generic implicit question matcher also finds an unrelated domain without merging a nearby problem', () => {
  const docs = [
    article('a', 'Reducing cold room condensation with air curtains', 'We tested air curtains to reduce cold room condensation, which lowered the relative humidity by 19 percent.'),
    article('b', 'Cold room condensation prevention through better door seals', 'We tested door seals to prevent cold room condensation and measured a 9 percent drop in relative humidity.'),
    article('c', 'Reducing cold room condensation with heat exchangers', 'We tested a heat exchanger to reduce cold room condensation and measured 22 percent lower relative humidity.'),
    article('d', 'Reducing cold room compressor noise', 'We tested a vibration mount to reduce cold room compressor noise by 10 percent.'),
  ];
  const result = classify(docs);
  assert.equal(result.status, 'ready');
  assert.equal(result.topic.kind, 'question');
  assert.deepEqual(result.sources.map(source => source.collectionId).sort(), ['a','b','c']);
  assert.equal(classify(docs, 'd').status, 'related');
});
