import path from 'node:path';
import { readJsonSync, writeFileAtomic } from './jsonFile.js';

// The debounced-write JSON persistence behind the persisted job managers
// (fleet, setup, provision, lifecycle) — previously four byte-identical
// copies. save() serializes eagerly and coalesces disk writes: while a write
// is in flight, later saves just replace `pending`, and flush() loops until
// nothing is pending. whenIdle() resolves once no write is pending or in
// flight — the graceful-shutdown seam registerShutdownFlush awaits.
export function createDebouncedJsonStore({ dataDir, filename }) {
  const file = path.join(dataDir, filename);
  let pending = null;        // latest serialized payload awaiting write, or null
  let flushing = false;
  let idleResolvers = [];
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (pending !== null) {
        const data = pending; pending = null;
        await writeFileAtomic(file, data);
      }
    } catch {
      // best effort: persistence must never crash a job run
    } finally {
      flushing = false;
      const resolvers = idleResolvers; idleResolvers = [];
      for (const r of resolvers) r();
    }
  }
  return {
    load() {
      return readJsonSync(file, { fallback: [], validate: Array.isArray });
    },
    save(jobs) {
      try { pending = JSON.stringify(jobs, null, 2); } catch { return; }
      void flush();
    },
    whenIdle() {
      if (!flushing && pending === null) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
  };
}
