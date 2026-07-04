import path from 'node:path';
import { readJsonSync, writeJsonSync } from './jsonFile.js';

// Persist health events to data/health-events.json. Synchronous on purpose: the
// history manager calls save() only on an edge (a state change), so writes are
// rare, and the file is capped to healthEventsMax. The whole data/ dir is already
// gitignored, so this file needs no .gitignore entry. Same best-effort contract
// as fleetStore.js — persistence must never crash the status poll.
export function createHealthEventsStore({ dataDir }) {
  const file = path.join(dataDir, 'health-events.json');
  return {
    load() {
      return readJsonSync(file, { fallback: [], validate: Array.isArray });
    },
    save(events) {
      try {
        writeJsonSync(file, events);
      } catch {
        // Best effort: persistence must never crash a poll cycle.
      }
    },
  };
}
