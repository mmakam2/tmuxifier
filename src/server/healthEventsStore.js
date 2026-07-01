import fs from 'node:fs';
import path from 'node:path';

// Persist health events to data/health-events.json. Synchronous on purpose: the
// history manager calls save() only on an edge (a state change), so writes are
// rare, and the file is capped to healthEventsMax. The whole data/ dir is already
// gitignored, so this file needs no .gitignore entry. Same best-effort contract
// as fleetStore.js — persistence must never crash the status poll.
export function createHealthEventsStore({ dataDir }) {
  const file = path.join(dataDir, 'health-events.json');
  return {
    load() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    },
    save(events) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(events, null, 2));
      } catch {
        // Best effort: persistence must never crash a poll cycle.
      }
    },
  };
}
