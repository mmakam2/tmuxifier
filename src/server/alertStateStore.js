import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;
const RULES_DEFAULT = { version: VERSION, mutes: [], overrides: {} };
const TRIAGE_DEFAULT = { version: VERSION, acks: {} };

// Operator decisions, split across two files because they have different
// lifetimes: rules (mutes, per-key overrides) are durable policy meant to
// persist indefinitely; triage (acks) is transient, tied to whatever is
// currently firing.
export function createAlertStateStore({ dataDir, now = () => Date.now() }) {
  const rulesFile = path.join(dataDir, 'alert-rules.json');
  const triageFile = path.join(dataDir, 'alert-triage.json');
  const objShape = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // getRules() feeds decideAlert() every evaluation cycle. If the rules file
  // is corrupt, readJson() already quarantines it and hands back `fallback`
  // — that fallback MUST merge down to "no mutes, no overrides" so a corrupt
  // file makes the system over-notify rather than silently going quiet
  // behind a phantom mute (a false green, the one failure mode worse than
  // noise). `{}` as the fallback plus the defaults spread below is what
  // makes that hold.
  async function readRules() {
    const v = await readJson(rulesFile, { fallback: {}, validate: objShape });
    return { ...RULES_DEFAULT, ...v };
  }
  // Mirror on the triage side: a corrupt ack log must read back as "nothing
  // acked" (isAcked() -> false -> the caller still notifies), never as
  // silently-acked and never by throwing into the evaluation loop.
  async function readTriage() {
    const v = await readJson(triageFile, { fallback: {}, validate: objShape });
    return { ...TRIAGE_DEFAULT, ...v };
  }

  // Every mutator below is a read-modify-write over one of the two files.
  // Without serialization, two concurrent calls touching the same file (e.g.
  // a double-clicked Mute button) would both read the not-yet-modified file
  // and the second write would silently clobber the first's change — the
  // same class of bug store.js's `serialize` and passkeyStore.js's
  // `withLock` guard against elsewhere in this codebase. One queue per file
  // since rules and triage are independent lifetimes: serializing one must
  // not stall the other.
  function makeLock() {
    let queue = Promise.resolve();
    return (fn) => {
      const result = queue.then(fn, fn); // run regardless of the predecessor's fate
      queue = result.then(() => {}, () => {}); // the chain itself must never reject
      return result;
    };
  }
  const withRulesLock = makeLock();
  const withTriageLock = makeLock();

  return {
    async getRules() {
      const r = await readRules();
      return { mutes: r.mutes, overrides: r.overrides };
    },

    mute(key) {
      return withRulesLock(async () => {
        const r = await readRules();
        if (!r.mutes.includes(key)) r.mutes = [...r.mutes, key];
        await writeJson(rulesFile, r, { mode: 0o600 });
      });
    },

    unmute(key) {
      return withRulesLock(async () => {
        const r = await readRules();
        r.mutes = r.mutes.filter((k) => k !== key);
        await writeJson(rulesFile, r, { mode: 0o600 });
      });
    },

    setOverride(key, patch) {
      return withRulesLock(async () => {
        const r = await readRules();
        r.overrides = { ...r.overrides, [key]: { ...(r.overrides[key] || {}), ...patch } };
        await writeJson(rulesFile, r, { mode: 0o600 });
      });
    },

    async getTriage() {
      return (await readTriage()).acks;
    },

    ack(key) {
      return withTriageLock(async () => {
        const t = await readTriage();
        t.acks = { ...t.acks, [key]: { ackedAt: now() } };
        await writeJson(triageFile, t, { mode: 0o600 });
      });
    },

    // Inclusive on purpose: an occurrence timestamped at exactly the ack
    // moment is the occurrence that was acked, not one that arrived after.
    async isAcked(key, lastTs) {
      const acked = (await readTriage()).acks[key];
      return !!acked && acked.ackedAt >= lastTs;
    },
  };
}
