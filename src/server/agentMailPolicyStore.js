import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';
import { EMPTY_POLICY, normalizePolicy } from './agentMailPolicy.js';

// data/agent-mail-policy.json: { version: 1, boxes: { <box id>: policy } }, 0o600.
// Loaded once, kept in memory, every mutation serialised on one promise chain. Box ids are
// user-controlled keys, so the in-memory map has no prototype.

const clone = (p) => ({ send: p.send, sendTo: [...p.sendTo], receive: p.receive, receiveFrom: [...p.receiveFrom] });

export function createAgentMailPolicyStore({ dataDir }) {
  const file = path.join(dataDir, 'agent-mail-policy.json');
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
      const e = doc.boxes[id];
      const strs = (l) => (Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []);
      m[id] = { send: e?.send === true, sendTo: strs(e?.sendTo), receive: e?.receive === true, receiveFrom: strs(e?.receiveFrom) };
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

  // Drop entries for boxes that no longer exist and strip them from every list.
  function prune(m, knownIds) {
    for (const id of Object.keys(m)) {
      if (!knownIds.has(id)) { delete m[id]; continue; }
      m[id].sendTo = m[id].sendTo.filter((x) => knownIds.has(x));
      m[id].receiveFrom = m[id].receiveFrom.filter((x) => knownIds.has(x));
    }
  }

  return {
    async all() {
      return snapshot(await load());
    },
    async get(id) {
      const m = await load();
      return Object.hasOwn(m, id) ? clone(m[id]) : EMPTY_POLICY;
    },
    // Save `id`'s policy. `mirror` lists box ids whose counterpart entry should also learn about
    // this box: B in my sendTo gets me in its receiveFrom, B in my receiveFrom gets me in its
    // sendTo. Switches of the other box are never touched.
    set(id, raw, { knownIds, mirror = [] }) {
      return mutate((m) => {
        const policy = normalizePolicy(raw, { selfId: id, knownIds });
        m[id] = policy;
        for (const other of Array.isArray(mirror) ? mirror : []) {
          if (typeof other !== 'string' || other === id || !knownIds.has(other)) continue;
          const wantsRecv = policy.sendTo.includes(other);
          const wantsSend = policy.receiveFrom.includes(other);
          if (!wantsRecv && !wantsSend) continue;
          const theirs = Object.hasOwn(m, other) ? m[other] : clone(EMPTY_POLICY);
          if (wantsRecv && !theirs.receiveFrom.includes(id)) theirs.receiveFrom.push(id);
          if (wantsSend && !theirs.sendTo.includes(id)) theirs.sendTo.push(id);
          m[other] = theirs;
        }
        prune(m, knownIds);
        return snapshot(m);
      });
    },
    async removeBox(id) {
      await mutate((m) => {
        delete m[id];
        for (const k of Object.keys(m)) {
          m[k].sendTo = m[k].sendTo.filter((x) => x !== id);
          m[k].receiveFrom = m[k].receiveFrom.filter((x) => x !== id);
        }
      });
    },
  };
}
