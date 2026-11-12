export function json3Segments(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const segments = [];
  for (const event of events) {
    if (!Number.isFinite(event?.tStartMs) || event.tStartMs < 0 || !Array.isArray(event.segs)) continue;
    const start = event.tStartMs;
    const duration = Number.isFinite(event.dDurationMs) ? Math.max(0, event.dDurationMs) : 0;
    const text = event.segs.map((part) => typeof part?.utf8 === "string" ? part.utf8 : "").join("").replace(/\s+/g, " ").trim();
    if (text && Number.isFinite(start + duration)) segments.push({ start_ms: start, end_ms: start + duration, text });
  }
  return segments;
}
