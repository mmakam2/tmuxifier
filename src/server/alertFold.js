// An alert is not a stored row — it is a fold over the append-only log by key.
// This is what lets the store stay append-only: "one problem, 47 occurrences,
// first seen 03:12" is computed at read time rather than mutated in place.
export function foldEvents(events, { nowMs = Date.now(), windowMs = 3600000 } = {}) {
  const byKey = new Map();
  // Sort events chronologically by ts, then by id for determinism on ties.
  // Same-ts events (common in Task 1's ${ts}-N pattern) must order consistently.
  for (const e of [...events].sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1))) {
    let a = byKey.get(e.key);
    if (!a) {
      a = { key: e.key, source: e.source, severity: e.severity, state: 'resolved',
            count: 0, recentCount: 0, firstTs: null, lastTs: null, title: e.title, body: e.body };
      byKey.set(e.key, a);
    }
    a.source = e.source;
    a.title = e.title;
    a.body = e.body;
    a.severity = e.severity;
    if (e.state === 'resolved') {
      a.state = 'resolved';
      a.count = 0;
      a.recentCount = 0;
      a.firstTs = null;
      a.lastTs = e.ts;
      continue;
    }
    a.state = 'firing';
    a.count += 1;
    if (e.ts >= nowMs - windowMs) a.recentCount += 1;
    if (a.firstTs === null) a.firstTs = e.ts;
    a.lastTs = e.ts;
  }
  // Sort by lastTs descending (newest first), with id as a tie-break for determinism.
  return [...byKey.values()].sort((x, y) => {
    const tsDiff = (y.lastTs || 0) - (x.lastTs || 0);
    return tsDiff !== 0 ? tsDiff : (x.key < y.key ? -1 : 1);
  });
}
