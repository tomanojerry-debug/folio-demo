const TASK = /(?:策展|整理(?:成|为)?|生成|做(?:成|出)?|制作)[^，,。；;！？!?\n]{0,48}?(?:专题(?:卡片?)?|小展|展览|卡片)|成卡/u;
const POLITE = /^(?:请帮我|麻烦你|帮我|给我|请)\s*/u;
const SCOPE = /^(?:只使用|仅使用|只采用|仅采用|仅根据|只根据|只用|仅用|使用|采用|根据|基于|按照|按|用|把|将)\s*([\s\S]+)$/u;
const OWNED = /^(?:(?:我(?:刚刚|刚|之前|最近|已|已经)?收藏|我(?:刚刚|刚|之前)?选(?:择|中)?|我(?:刚刚|刚|之前)?引用|我指定|已保存|已收藏|所选|选中|引用)的)\s*/u;
const COUNT = /^(?:这|那)?(几|[一二两三四五六七八九十0-9]+)(?:条|篇|份)(?:收藏|材料|文章|资料|内容)?$/u;
const SELECTED = /^(?:(?:这|那)(?:条|篇|份)(?:收藏|材料|文章|资料|内容)?|(?:这些|上述|下列|刚才的)(?:收藏|材料|文章|资料|内容)|(?:选中|所选)的收藏|收藏)$/u;
const number = new Map(['一','二','三','四','五','六','七','八','九','十','十一','十二'].map((value, index) => [value, index + 1]));
number.set('两', 2);

function scopeNames(value) {
  const matched = SCOPE.exec(value.trim().replace(POLITE, ''));
  if (!matched) return undefined;
  const original = matched[1].trim();
  const names = original.replace(OWNED, '').trim();
  const count = COUNT.exec(names)?.[1];
  if (count) return { names: '', expectedCount: number.get(count) || (/^\d+$/u.test(count) ? Number(count) : undefined) };
  if (!names || SELECTED.test(names) || /^(?:我的?|已有的?|最近的?|已保存的?|已收藏的?)?(?:收藏|内容)$/u.test(names)) return { names: '' };
  return { names };
}

function questionFor(task, after) {
  const question = /(?:^|[，,。；;:：\n])\s*(?:重点(?:是|讲)?|回答|围绕|问题(?:是|为)?|主题(?:是|为)?)\s*[:：]?\s*([^。；;，,！？!?\n]+)/u.exec(after)?.[1]
    || /(?:关于|围绕)\s*(.+?)的(?:专题|小展|展览|卡片)/u.exec(task)?.[1];
  return question?.trim().replace(/^[“「『《]|[”」』》]$/gu, '').slice(0, 200) || '';
}

export function parseScopedCurationCommand(value, hasSelection = false) {
  if (typeof value !== 'string' || value.length > 6000) return null;
  const request = value.trim().replace(POLITE, '');
  if (/^(?:不要|别|先别|无需|不用|不必|不需要|能否说明|请问|怎么|怎样|如何|为什么)/u.test(request)) return null;
  if (hasSelection && /^策展[。！!]?$/u.test(request)) return { names: '', question: '' };
  const quoted = /《[^》]*》|「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/gu;
  const task = TASK.exec(request.replace(quoted, value => ' '.repeat(value.length)));
  if (!task) return null;
  const before = request.slice(0, task.index).replace(/[，,\s]+$/u, '');
  const after = request.slice(task.index + task[0].length);
  if (/(?:不要|别|无需|不用|不必|不需要)\s*$/u.test(before)) return null;
  const afterScope = after.split(/[。；;\n]|[，,](?=\s*(?:只|仅)(?:用|使用|采用|根据))/u)
    .map(part => scopeNames(part.replace(/^[，,\s]+/u, '')
      .replace(/[，,]\s*(?:重点|回答|围绕|问题|主题)[\s\S]*$/u, '')))
    .find(names => names !== undefined);
  const beforeScope = scopeNames(before);
  if (before && beforeScope === undefined && !/^(?:能不能|能否|可以|想请你)\s*$/u.test(before)) return null;
  // Preserve the separate full-library exhibition command when no sources were specified.
  if (!hasSelection && !beforeScope?.names && !afterScope?.names && /(?:展览|小展)$/u.test(task[0])
    && !/(?:只|仅|这|那|上述|选中|所选|指定)/u.test(before) && !afterScope) return null;
  if (!hasSelection && !beforeScope && !afterScope && /卡片$/u.test(task[0]) && !/专题|策展/u.test(task[0])) return null;
  const restrictions = [...after.matchAll(/(?:(?:不要|别|不再|不能|不)(?:使用|采用|用|纳入|包含|包括|引用)|排除|去掉|剔除)\s*([^。；;，,\n]+)/gu)];
  const conflictingNames = beforeScope?.names && afterScope?.names && beforeScope.names !== afterScope.names;
  const conflictingCounts = beforeScope?.expectedCount !== undefined && afterScope?.expectedCount !== undefined
    && beforeScope.expectedCount !== afterScope.expectedCount;
  const needsSelection = conflictingNames || conflictingCounts || restrictions.some(([, excluded]) => !/^(?:其他|别的|另外|额外|不相关的)(?:收藏|材料|文章|资料|来源|内容)$/u.test(excluded.trim()));
  const scope = afterScope?.names ? afterScope : beforeScope?.names ? beforeScope
    : afterScope?.expectedCount !== undefined ? afterScope : beforeScope || afterScope;
  const action = request.slice(task.index, task.index + task[0].length);
  return { ...(scope || { names: '' }), question: questionFor(action, after), ...(needsSelection ? { needsSelection: true } : {}) };
}
