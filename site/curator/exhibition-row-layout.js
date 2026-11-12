// Count-weighted, justified rows for exhibitions. Collection masonry is separate.
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));

export function exhibitionAspectRatio(count) {
  const amount = clamp(finite(count, 0), 0, 1_000_000);
  return Math.min(2.2, 0.76 + 0.32 * Math.log2(1 + amount / 6));
}

/** Preserve input order. Complete rows fill their width; short final rows stay compact. */
export function layoutExhibitionRows(items, options = {}) {
  const width = finite(options.width, 0);
  if (width <= 0 || !Array.isArray(items) || !items.length) return [];
  const gap = Math.max(0, finite(options.gap, 20));
  const target = Math.max(1, finite(options.targetHeight, 300));
  const minimumWidth = Math.max(1, finite(options.minCardWidth, 200));
  const minimumHeight = Math.max(1, finite(options.minRowHeight, 260));
  const maximumHeight = Math.max(minimumHeight, finite(options.maxRowHeight, 340));
  const source = items.map(item => ({ ...item, ratio:exhibitionAspectRatio(item.count) }));
  if (width < minimumWidth * 2 + gap) return source.map(item => ({
    height:clamp(target + 18 * Math.log2(1 + clamp(finite(item.count, 0), 0, 1_000_000) / 6), minimumHeight, maximumHeight),
    items:[{ id:item.id, width }],
  }));
  const rows = [];
  let start = 0;
  while (start < source.length) {
    let ratioSum = 0, bestEnd = start + 1, bestScore = Infinity;
    for (let end = start + 1; end <= source.length; end++) {
      ratioSum += source[end - 1].ratio;
      const available = width - gap * (end - start - 1);
      if (available <= 0) break;
      const idealHeight = available / ratioSum;
      if (end > start + 1 && source.slice(start, end).some(item => item.ratio * idealHeight < minimumWidth)) break;
      const score = Math.abs(Math.log(idealHeight / target));
      if (score < bestScore) { bestScore = score; bestEnd = end; }
      if (idealHeight < target && end > bestEnd) break;
    }
    const members = source.slice(start, bestEnd);
    const available = width - gap * (members.length - 1);
    const sum = members.reduce((value, item) => value + item.ratio, 0);
    const idealHeight = available / sum;
    const compactLastRow = bestEnd === source.length && idealHeight > target;
    const height = clamp(compactLastRow ? target : idealHeight, minimumHeight, maximumHeight);
    const contentWidth = compactLastRow ? Math.min(available, sum * height) : available;
    let used = 0;
    const cards = members.map((item, index) => {
      const cardWidth = index === members.length - 1 ? contentWidth - used : contentWidth * item.ratio / sum;
      used += cardWidth;
      return { id:item.id, width:cardWidth };
    });
    rows.push({ height, items:cards });
    start = bestEnd;
  }
  return rows;
}
