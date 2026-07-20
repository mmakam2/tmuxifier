import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;
const EMPTY = { version: VERSION, passkeyOnly: false, rpId: null, userHandle: null, credentials: [] };

// Enrolled passkeys (data/passkeys.json). Public keys are not secrets, so
// nothing here is sealed by secretBox — but the file is still written 0o600 and
// inherits jsonFile.js's atomic rename and corrupt-file quarantine.
//
// A corrupt store therefore reads as empty, which also disarms passkeyOnly.
// That is deliberate: see the design doc. Failing closed would brick fleet
// access on a disk glitch, and whoever can corrupt this file can already read
// the password hash from .env on the same disk.
export function createPasskeyStore({ dataDir, now = () => Date.now(), log = (msg) => console.error(msg) }) {
  const file = path.join(dataDir, 'passkeys.json');
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (!('credentials' in v) || Array.isArray(v.credentials));

  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape, onCorrupt: log });
    return { ...EMPTY, ...v, credentials: Array.isArray(v.credentials) ? v.credentials : [] };
  }
  async function save(data) {
    await writeJson(file, data, { mode: 0o600 });
    return data;
  }
  const publicView = (c) => ({
    id: c.id, label: c.label,
    created: c.created ?? null, lastUsed: c.lastUsed ?? null,
    transports: Array.isArray(c.transports) ? c.transports : [],
  });

  // Every mutator below is a read-modify-write (readAll() then save()) over
  // the same file, with nothing otherwise stopping two concurrent calls from
  // both reading before either writes — the second save() would silently
  // clobber the first (a lost credential, a passkeyOnly flip that didn't
  // stick, two different minted user handles). withLock serializes every
  // mutating call onto a single promise chain so each read-modify-write
  // finishes before the next one starts.
  //
  // This is an IN-PROCESS mutex only — it does nothing across multiple OS
  // processes sharing data/passkeys.json. That's sufficient here: Tmuxifier
  // runs as a single Node process, so every mutation of this store goes
  // through this one queue.
  //
  // `fn` may reject (e.g. setPasskeyOnly(true) with no credentials
  // enrolled). The caller still observes that rejection via `result`, but
  // `queue` is re-armed with a handler that swallows it either way, so one
  // failed operation can never wedge every later call behind a permanently
  // rejected promise.
  let queue = Promise.resolve();
  function withLock(fn) {
    const result = queue.then(fn, fn);
    queue = result.then(() => {}, () => {});
    return result;
  }

  return {
    async list() { return (await readAll()).credentials.map(publicView); },
    // Server-internal: includes the public key and sign count. signCount is
    // normalized to a number here because verifyAssertion rejects a non-numeric
    // stored count (fail closed on a corrupt store) — without this, a record
    // whose signCount persisted as null would turn a valid passkey into a
    // permanent 401. Non-integer and negative values land on 0.
    //
    // Deliberately NOT normalized: an integer above 0xFFFFFFFF. signCount is
    // read from authenticator data as a uint32, so a larger stored value is
    // corruption — and verifyAssertion rejects it, which locks that one
    // credential rather than silently clamping to 0 and disabling clone
    // detection for it. Fail closed on the credential, not open.
    async listRaw() {
      return (await readAll()).credentials.map((c) => ({
        ...c,
        signCount: Number.isInteger(c.signCount) && c.signCount >= 0 ? c.signCount : 0,
      }));
    },
    async getRpId() { return (await readAll()).rpId ?? null; },
    async getPasskeyOnly() { return (await readAll()).passkeyOnly === true; },

    setPasskeyOnly(enabled) {
      return withLock(async () => {
        const data = await readAll();
        if (enabled && data.credentials.length === 0) {
          throw new Error('enroll a passkey before requiring passkey sign-in');
        }
        data.passkeyOnly = !!enabled;
        await save(data);
        return data.passkeyOnly;
      });
    },

    // A stable WebAuthn user id, so re-enrolling the same authenticator
    // replaces its credential instead of stacking duplicates in the keychain.
    getUserHandle() {
      return withLock(async () => {
        const data = await readAll();
        if (data.userHandle) return data.userHandle;
        data.userHandle = randomBytes(16).toString('base64url');
        await save(data);
        return data.userHandle;
      });
    },

    add(cred, { rpId } = {}) {
      return withLock(async () => {
        // The pin only protects anything if it's always a real hostname:
        // `undefined` would vanish from the persisted JSON entirely (so the
        // pin silently evaporates and a later add() re-pins to a different
        // host), and '' would pin the store to the empty string forever
        // (`'' ?? x` keeps `''`, and nothing else can clear it).
        if (typeof rpId !== 'string' || rpId.length === 0) {
          throw new Error('add() requires a non-empty rpId');
        }
        const data = await readAll();
        data.rpId = data.rpId ?? rpId; // pinned by the first enrollment only
        // Upsert by credential id: preserve the original `created` (shown in
        // the UI as "added on") instead of resetting it to now on re-enrollment.
        const existing = data.credentials.find((c) => c.id === cred.id);
        const entry = {
          ...cred,
          created: existing ? existing.created : (cred.created ?? now()),
          lastUsed: null,
        };
        data.credentials = [...data.credentials.filter((c) => c.id !== cred.id), entry];
        await save(data);
        return publicView(entry);
      });
    },

    remove(id) {
      return withLock(async () => {
        const data = await readAll();
        const before = data.credentials.length;
        data.credentials = data.credentials.filter((c) => c.id !== id);
        if (data.credentials.length === before) return { removed: false, disarmed: false };
        const disarmed = data.credentials.length === 0 && data.passkeyOnly === true;
        if (data.credentials.length === 0) { data.passkeyOnly = false; data.rpId = null; }
        await save(data);
        return { removed: true, disarmed };
      });
    },

    touch(id, { signCount }) {
      return withLock(async () => {
        const data = await readAll();
        const cred = data.credentials.find((c) => c.id === id);
        if (!cred) return;
        cred.signCount = signCount;
        cred.lastUsed = now();
        await save(data);
      });
    },
  };
}
