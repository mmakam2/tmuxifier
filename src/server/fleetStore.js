import fs from 'node:fs';
import path from 'node:path';

// Persist fleet jobs to data/fleet-jobs.json. Synchronous on purpose: the fleet
// runner calls save() fire-and-forget at each checkpoint without awaiting, and
// the file is small (capped to fleetMaxJobs). The whole data/ dir is already
// gitignored, so this file needs no .gitignore entry.
export function createFleetStore({ dataDir }) {
  const file = path.join(dataDir, 'fleet-jobs.json');
  return {
    load() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    },
    save(jobs) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(jobs, null, 2));
      } catch {
        // Best effort: persistence must never crash a fleet run.
      }
    },
  };
}
