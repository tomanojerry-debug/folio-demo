import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDesktopService } from '../desktop/server/service.mjs';

function model(_call, context) {
  const ids = [context.evidence_bundle[0].evidence_id];
  const body = context.normalized_content.text;
  return { output:{ status:'candidate', summary:body, summary_evidence_ids:ids,
    digest:{ status:'compact', overview:body, evidence_ids:ids, highlights:[{ text:body, evidence_ids:ids }] },
    breakdown:{ status:'not_applicable', sections:[] },
    concepts:[{ value:body.includes('自然光') ? '自然光' : '咖啡', evidence_ids:ids }],
    content_reliability_score:0.95, uncertainties:[] }, trace:{ model:'injected-connections-fixture' } };
}

test('the service exposes versioned two-sided relations and chat can follow a selected article', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forme-connections-service-'));
  let dispatched;
  const service = await createDesktopService({ directory, config:{ zhipuApiKey:'', timeoutMs:1000 }, aiEnabled:true, autoCurate:false,
    knowledgeEmbedder:null, knowledgeReranker:null, model,
    async chat(_config, input) {
      const message = input.messages.find(message => message.content.startsWith('策展参考资料'));
      dispatched = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
      const linked = dispatched.collections.find(item => item.connectionTo);
      return { choices:[{ message:{ content:`两篇都讨论自然光，具体建议需要分别核对。${linked ? `[[collection:${linked.id}]]` : ''}` } }] };
    } });
  t.after(async () => { await service.close(); await rm(directory, { recursive:true, force:true }); });
  const a = await service.capture({ mode:'text', title:'庭院的自然光', content:'庭院的自然光经过百叶窗进入工作室，作者认为合适的遮挡能够减少眩光，改善长时间阅读。' });
  const b = await service.capture({ mode:'text', title:'玻璃屋的自然光', content:'玻璃屋的自然光穿过透明屋顶，作者记录强光会增加眩光，提醒使用者在午后留意视觉疲劳。' });
  const c = await service.capture({ mode:'text', title:'咖啡风味记录', content:'咖啡烘焙的温度曲线会影响酸度与香气，需要保留烘焙批次和品尝结果以便比较。' });
  await service.idle();
  const connected = await service.knowledgeConnections({ collectionId:a.collectionId });
  const peer = connected.items.find(item => item.collectionId === b.collectionId);
  assert.ok(peer);
  assert.equal(peer.relationType, 'shared_concept');
  assert.ok(peer.concepts.some(concept => concept.name === '自然光'));
  assert.ok(peer.anchorChunks.length && peer.chunks.length);
  assert.ok(peer.documentVersionId && connected.anchor.documentVersionId);
  assert.ok(!connected.items.some(item => item.collectionId === c.collectionId));
  assert.doesNotMatch(JSON.stringify(connected), /"relationType":"(?:supports|contradicts|causes)"/);

  await service.send({ text:'查看关联', intent:'chat', collectionIds:[a.collectionId] });
  await service.idle();
  assert.ok(dispatched.collections.some(item => item.id === b.collectionId && item.connectionTo === a.collectionId));
  assert.ok(dispatched.collections.some(item => item.id === a.collectionId));
  const response = service.state().messages.filter(item => item.role === 'assistant').at(-1);
  assert.deepEqual(response.relatedCollectionIds, [b.collectionId]);

  await service.workspace({ ops:[{ field:'feedback', key:`understanding:${b.collectionId}`, value:{ decision:'pending_rewrite', correctionPrompt:'先核对观点。' } }] });
  assert.ok(!(await service.knowledgeConnections({ collectionId:a.collectionId })).items.some(item => item.collectionId === b.collectionId));
  assert.match((await service.knowledgeRead({ collectionId:b.collectionId })).document.text, /增加眩光/);
  await assert.rejects(service.knowledgeConnections({ collectionId:'forged' }), { statusCode:404 });
  await assert.rejects(service.knowledgeConnections({ collectionId:a.collectionId, limit:99 }), { statusCode:400 });
});
