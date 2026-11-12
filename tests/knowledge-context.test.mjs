import test from 'node:test';
import assert from 'node:assert/strict';
import { isSimilarityQuestion, similarityAnchor, isConnectionQuestion, connectionAnchor, knowledgeReferences, protectKnowledgeReferences } from '../desktop/server/knowledge/context.mjs';
import { buildConversationContext } from '../desktop/server/harness/context.mjs';

function fixture(overrides = {}) {
  const item = { id:'one', title:'光线与空间', url:'https://example.org/light', status:'ready', sourceRevision:2, understandingDocumentVersionId:'doc-v2', extraction:{ revision:3 }, ...overrides };
  return { item, state:{ profile:{}, collections:[item], workspace:{ feedback:{} } }, hit:{ collectionId:'one', documentVersionId:'doc-v2', sourceRevision:2, understandingRevision:3, title:item.title, summary:'当前经过核对的理解。', chunks:[{ chunkId:'c1', text:'当前实际读取的原文。', locator:'第 2 节' }] } };
}

test('only actual requests for similar material can expand a selected article scope', () => {
  for (const query of ['和这篇类似的有哪些？', '帮我找类似的文章', '推荐几篇和这条相似的内容', '像这篇的文章还有哪些', 'Find similar articles', 'Show related documents', '不用解释，帮我找类似文章']) assert.equal(isSimilarityQuestion(query), true, query);
  for (const query of ['不要找相似文章，只解释这篇', '不用推荐类似的内容', '作者说“类似的方法”是什么意思？', '这里的“相似”如何理解？', "What does 'similar articles' mean?", 'Do not find similar articles', '请解释这篇文章', '这两篇文章是不是相似？']) assert.equal(isSimilarityQuestion(query), false, query);
});

test('anchor resolution respects one explicit selection and never chooses among ambiguous articles', () => {
  const { state } = fixture();
  state.collections.push({ id:'two', title:'光线与空间的另一种研究', url:'https://example.org/other' });
  assert.equal(similarityAnchor({ text:'和这篇类似的有哪些', workspaceContext:{ collectionIds:['one'] } }, state), 'one');
  assert.equal(similarityAnchor({ text:'找类似文章', workspaceContext:{ collectionIds:['one', 'two'] } }, state), null);
  assert.equal(similarityAnchor({ text:'找和光线与空间类似的文章' }, state), 'one');
  assert.equal(similarityAnchor({ text:'找类似文章 https://example.org/light' }, state), 'one');
  assert.equal(similarityAnchor({ text:'找类似文章', context:{ url:'https://example.org/light' } }, state), 'one');
  state.collections.push({ id:'duplicate', title:'光线与空间', url:'https://example.org/light' });
  assert.equal(similarityAnchor({ text:'找和光线与空间类似的文章' }, state), null);
  assert.equal(similarityAnchor({ text:'不要找相似，只解释这篇', workspaceContext:{ collectionIds:['one'] } }, state), null);
});

test('connection requests expand only a clearly identified article', () => {
  const { state } = fixture();
  for (const query of ['查看关联', '这篇和哪些收藏有关联？', '找这条收藏的共同主题', 'Show connections to this article']) {
    assert.equal(isConnectionQuestion(query), true, query);
    assert.equal(connectionAnchor({ text:query, workspaceContext:{ collectionIds:['one'] } }, state), 'one', query);
  }
  for (const query of ['不要查看关联', '这篇说的“关联”是什么意思？', '解释一下文章之间的关系', '普通问候']) assert.equal(isConnectionQuestion(query), false, query);
  assert.equal(connectionAnchor({ text:'查看关联', workspaceContext:{ collectionIds:['one', 'two'] } }, state), null);
});

test('a relation cannot outlive corrections or understanding changes on either side', () => {
  const { state, hit } = fixture({ extraction:{ status:'qualified', revision:3 } });
  state.collections.push({ id:'anchor', status:'ready', sourceRevision:1, knowledgeDocumentVersionId:'anchor-v1', extraction:{ status:'qualified', revision:2 } });
  const references = knowledgeReferences([{ ...hit, connectionTo:'anchor', relationType:'shared_concept', sharedConcepts:[{ name:'自然光' }], connectionAnchorDocumentVersionId:'anchor-v1', connectionAnchorSourceRevision:1, connectionAnchorUnderstandingRevision:2 }], state);
  assert.deepEqual(references[0].sharedConcepts, ['自然光']);
  assert.equal(protectKnowledgeReferences(references, state).length, 1);
  for (const item of state.collections) {
    item.status = 'processing';
    assert.deepEqual(protectKnowledgeReferences(references, state), [], 'Starting a revision blocks old relations before the revision number changes.');
    item.status = 'ready';
    item.extraction.status = 'needs_confirmation';
    assert.deepEqual(protectKnowledgeReferences(references, state), []);
    item.extraction.status = 'qualified';
  }
  state.collections[1].extraction.revision = 3;
  assert.deepEqual(protectKnowledgeReferences(references, state), []);
  state.collections[1].extraction.revision = 2;
  state.workspace.feedback['understanding:anchor'] = { decision:'pending_rewrite' };
  assert.deepEqual(protectKnowledgeReferences(references, state), []);
  delete state.workspace.feedback['understanding:anchor'];
  state.workspace.feedback['understanding:one'] = { decision:'pending_rewrite' };
  assert.deepEqual(protectKnowledgeReferences(references, state), []);
});

test('current understanding requires matching source, document and understanding versions', () => {
  const { state, hit } = fixture();
  const [current] = knowledgeReferences([hit], state);
  assert.equal(current.understandingStatus, 'ready');
  assert.equal(current.summary, hit.summary);
  for (const stale of [{ sourceRevision:1 }, { documentVersionId:'doc-v1' }, { understandingRevision:2 }, { understandingRevision:null }]) {
    const [result] = knowledgeReferences([{ ...hit, ...stale, summary:'必须屏蔽的旧理解' }], state);
    assert.equal(result.understandingStatus, 'not_ready', JSON.stringify(stale));
    assert.doesNotMatch(result.summary, /必须屏蔽/);
    assert.equal(result.evidence[0].text, hit.chunks[0].text, 'Actual read source remains available without reusing stale generated understanding');
  }
});

test('legacy understanding without a document pointer still checks its source and understanding revision', () => {
  const { state, hit } = fixture({ understandingDocumentVersionId:undefined, extraction:{} });
  assert.equal(knowledgeReferences([{ ...hit, understandingRevision:1 }], state)[0].understandingStatus, 'ready');
  assert.equal(knowledgeReferences([{ ...hit, understandingRevision:2 }], state)[0].understandingStatus, 'not_ready');
});

test('pending user corrections cannot leak either old generated summaries or old understanding evidence', () => {
  for (const decision of ['pending_rewrite', 'confirmed_edited']) {
    const { state, hit } = fixture();
    state.workspace.feedback['understanding:one'] = { decision };
    const [reference] = knowledgeReferences([{ ...hit, summary:'旧理解秘密', chunks:[{ chunkId:'old', text:'旧理解证据秘密' }] }], state);
    assert.equal(reference.status, 'needs_confirmation');
    assert.equal(reference.understandingStatus, 'not_ready');
    assert.equal(reference.evidenceStatus, 'not_available');
    assert.deepEqual(reference.evidence, []);
    assert.doesNotMatch(JSON.stringify(reference), /秘密/);
  }
});

test('unavailable source metadata does not masquerade as source text, and results remain bounded', () => {
  const { state, hit } = fixture({ status:'failed' });
  const references = knowledgeReferences([{ collectionId:'missing' }, { collectionId:'one' }, hit], state);
  assert.equal(references.length, 1);
  assert.equal(references[0].documentVersionId, null);
  assert.equal(references[0].evidenceStatus, 'not_available');
  assert.match(references[0].summary, /尚未取得/);
  const [bounded] = knowledgeReferences([{ ...hit, chunks:Array.from({ length:5 }, (_, index) => ({ chunkId:`c${index}`, text:'证'.repeat(2000), locator:'位置' })) }], state);
  assert.equal(bounded.evidence.length, 2);
  assert.equal(bounded.evidence[0].text.length, 800);
  assert.equal(bounded.evidence[0].excerpt, true);
});

test('trusted search candidates remain inside explicit scope until similarity expansion is explicitly requested', () => {
  const { state, hit } = fixture();
  state.collections.push({ ...state.collections[0], id:'two', title:'另一篇文章' });
  state.messages = [{ id:'current', role:'user', text:'看看这条', workspaceContext:{ collectionIds:['one'] } }];
  const references = knowledgeReferences([hit, { ...hit, collectionId:'two' }], state);
  const scoped = buildConversationContext({ state, messageId:'current', collectionReferences:references });
  assert.deepEqual(scoped.manifest.itemIds, ['one']);
  state.messages[0].text = '和这条类似的还有哪些？';
  const expanded = buildConversationContext({ state, messageId:'current', collectionReferences:references, expandCollectionScope:true });
  assert.deepEqual(expanded.manifest.itemIds, ['one', 'two']);
});
