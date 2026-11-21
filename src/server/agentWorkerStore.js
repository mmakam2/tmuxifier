import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';
import { EMPTY_WORKERS, normalizeWorkers } from './agentWorkerRules.js';

// data/agent-workers.json: { version: 1, boxes: { <box id>: { projects, mailStart, max } } }, 0o600.
// The record's shape and rules are agentWorkerRules.js's; this file only keeps them.
// Loaded once, kept in memory, every mutation serialised on one promise chain. Box ids are
// user-controlled keys, so the in-memory map has no prototype.

const clone = (r) => ({ projects: r.projects.map((p) => ({ ...p })), mailStart: r.mailStart, max: r.max });

export function createAgentWorkerStore({ dataDir }) {
  const file = path.join(dataDir, 'agent-workers.json');
  let boxes = null; // null-prototype map, loaded lazily
  let chain = Promise.resolve();

  async function load() {
    if (boxes) return boxes;
    const doc = await readJson(file, {
      fallback: { version: 1, boxes: {} },
      validate: (v) => v && typeof v === 'object' && v.boxes && typeof v.boxes === 'object' && !Array.isArray(v.boxes),
    });
    const m = Object.create(null);
    for (const id of Object.keys(doc.boxes)) {
      // A file is not proof: an entry that no longer passes the rules (edited by hand, or
      // written by an older version) is absent, so a directory that would not be accepted on
      // write never reaches a starter.
      try { m[id] = normalizeWorkers(doc.boxes[id]); } catch { /* absent */ }
    }
    boxes = m;
    return boxes;
  }

  const snapshot = (m) => {
    const out = Object.create(null);
    for (const id of Object.keys(m)) out[id] = clone(m[id]);
    return out;
  };

  const persist = (m) => {
    const plain = {};
    for (const id of Object.keys(m)) Object.defineProperty(plain, id, { value: m[id], enumerable: true, writable: true, configurable: true });
    return writeJson(file, { version: 1, boxes: plain });
  };

  // Run `fn(working copy)` after every earlier mutation; adopt and persist the copy only if it
  // returns without throwing. A failed mutation leaves memory and file as they were.
  function mutate(fn) {
    const run = chain.then(async () => {
      const working = snapshot(await load());
      const result = fn(working);
      await persist(working);
      boxes = working;
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }

  return {
    async all() {
      return snapshot(await load());
    },
    async get(id) {
      const m = await load();
      return Object.hasOwn(m, id) ? clone(m[id]) : EMPTY_WORKERS;
    },
    // Save `id`'s record. `normalizeWorkers` throws (naming the field) on a bad one, before
    // anything is written.
    set(id, raw) {
      return mutate((m) => {
        const record = normalizeWorkers(raw);
        m[id] = record;
        return clone(record);
      });
    },
    async removeBox(id) {
      await mutate((m) => {
        delete m[id];
      });
    },
  };
}
