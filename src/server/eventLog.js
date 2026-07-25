import fs from 'node:fs/promises';
import path from 'node:path';

// Append-only, day-partitioned NDJSON. Deliberately not jsonFile.js: that module
// quarantines a whole corrupt file, which is right for a state document and wrong
// for an append log, where one bad line must not cost a day of history. Appends of
// modest lines under O_APPEND are atomic, which is what lets one process append
// while another tails without locking.
const DAY_MS = 86400000;

export function createEventLog({ dir, prefix, now = () => Date.now() }) {
  let seq = 0;
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const fileFor = (key) => path.join(dir, `${prefix}-${key}.ndjson`);

  async function readFileLines(key) {
    let raw;
    try {
      raw = await fs.readFile(fileFor(key), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip the bad line only */ }
    }
    return out;
  }

  return {
    dayKey,
    async append(event) {
      const ts = typeof event.ts === 'number' ? event.ts : now();
      // event is spread after id/ts so a caller-supplied id can't collide with the
      // sequence counter, but a caller-supplied ts (Task 20's backdated retention
      // test) would otherwise win the spread and desync the file it lands in from
      // the value used to compute dayKey() above — so ts is reassigned after the
      // spread to guarantee the stored value is the resolved number.
      const stored = { id: `${ts}-${seq++}`, ts, ...event };
      stored.ts = ts;
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(fileFor(dayKey(ts)), `${JSON.stringify(stored)}\n`, { mode: 0o600 });
      return stored;
    },
    readDay: readFileLines,
    async readSince(sinceMs, untilMs = now()) {
      const keys = [];
      for (let t = sinceMs; t <= untilMs + DAY_MS; t += DAY_MS) {
        const k = dayKey(t);
        if (!keys.includes(k)) keys.push(k);
      }
      const all = [];
      for (const k of keys) all.push(...await readFileLines(k));
      return all
        .filter((e) => e.ts >= sinceMs && e.ts <= untilMs)
        .sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
    },
    async prune(maxAgeDays) {
      const cutoff = now() - maxAgeDays * DAY_MS;
      let names;
      try { names = await fs.readdir(dir); } catch { return []; }
      const removed = [];
      for (const name of names) {
        const m = name.match(new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`));
        if (!m) continue;
        if (Date.parse(`${m[1]}T00:00:00Z`) < cutoff) {
          await fs.unlink(path.join(dir, name));
          removed.push(name);
        }
      }
      return removed.sort();
    },
  };
}
