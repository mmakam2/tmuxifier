import fs from 'node:fs';
import path from 'node:path';

export function createProvisionStore({ dataDir }) {
  const file = path.join(dataDir, 'provision-jobs.json');
  let pending = null;
  let flushing = false;
  let idleResolvers = [];
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      await fs.promises.mkdir(dataDir, { recursive: true });
      while (pending !== null) {
        const data = pending; pending = null;
        await fs.promises.writeFile(file, data);
      }
    } catch {
      // best effort: persistence must never crash a provision run
    } finally {
      flushing = false;
      const resolvers = idleResolvers; idleResolvers = [];
      for (const r of resolvers) r();
    }
  }
  return {
    load() {
      try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; }
      catch { return []; }
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
