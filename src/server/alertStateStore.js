import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;

// Operator decisions, split across two files because they have different
// lifetimes: rules (mutes, per-key overrides) are durable policy meant to
// persist indefinitely; triage (acks) is transient, tied to whatever is
// currently firing.
export function createAlertStateStore({ dataDir, now = () => Date.now() }) {
  const rulesFile = path.join(dataDir, 'alert-rules.json');
  const triageFile = path.join(dataDir, 'alert-triage.json');
  const objShape = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // getRules() feeds decideAlert() every evaluation cycle, and decideAlert()
  // calls mutes.includes(...) / looks overrides up by key with no shape
  // check of its own — this store is where the guarantee is made, not
  // there. readJson()'s `validate: objShape` only proves the top-level
  // parse is a non-array object; it says nothing about what `mutes` or
  // `overrides` actually hold. A hand-edited file like {"mutes":
  // "disk-full"} (a forgotten pair of brackets) parses fine and passes
  // objShape, so without the per-field coercion below, r.mutes would be a
  // STRING — and "disk-full".includes(key) is substring search, not array
  // membership, which can silently report an unrelated critical alert as
  // suppressed:muted. Coercing each field to its expected type here (never
  // trusting alertPolicy.js to defend itself against a malformed shape) is
  // what keeps a wrong-typed-but-parseable file on the same "fail loud,
  // never silent" side as a genuinely unparseable one.
  async function readRules() {
    const v = await readJson(rulesFile, { fallback: {}, validate: objShape });
    return {
      version: VERSION,
      mutes: Array.isArray(v.mutes) ? v.mutes : [],
      overrides: objShape(v.overrides) ? v.overrides : {},
    };
  }
  // Same coercion on the triage side, for consistency — though this side
  // already fails safe even without it: a non-object `acks` indexed by key
  // yields `undefined`, and isAcked() treats that as "not acked", which is
  // the safe direction (over-notify, never silently-acked).
  async function readTriage() {
    const v = await readJson(triageFile, { fallback: {}, validate: objShape });
    return {
      version: VERSION,
      acks: objShape(v.acks) ? v.acks : {},
    };
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
