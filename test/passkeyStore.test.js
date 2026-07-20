import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPasskeyStore } from '../src/server/passkeyStore.js';

let dir, store;
const CRED = { id: 'cred-a', publicKey: 'cose-a', alg: -7, signCount: 0, label: 'Laptop', transports: ['internal'] };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pk-'));
  store = createPasskeyStore({ dataDir: dir, now: () => 1700000000000 });
});

test('starts empty and unpinned', async () => {
  expect(await store.list()).toEqual([]);
  expect(await store.getRpId()).toBeNull();
  expect(await store.getPasskeyOnly()).toBe(false);
});

test('adds a credential and returns only the public view', async () => {
  const view = await store.add(CRED, { rpId: 'tmux.example.com' });
  expect(view).toEqual({ id: 'cred-a', label: 'Laptop', created: 1700000000000, lastUsed: null, transports: ['internal'] });
  expect(JSON.stringify(await store.list())).not.toContain('cose-a');
  expect((await store.listRaw())[0].publicKey).toBe('cose-a');
});

test('pins the rp id on the first enrollment and never overwrites it', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.add({ ...CRED, id: 'cred-b' }, { rpId: 'other.example.com' });
  expect(await store.getRpId()).toBe('tmux.example.com');
});

// Re-enrolling the same authenticator must replace, not duplicate.
test('upserts by credential id', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.add({ ...CRED, label: 'Renamed' }, { rpId: 'tmux.example.com' });
  const list = await store.list();
  expect(list).toHaveLength(1);
  expect(list[0].label).toBe('Renamed');
});

test('touch records the new sign count and last-used time', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.touch('cred-a', { signCount: 9 });
  expect((await store.listRaw())[0].signCount).toBe(9);
  expect((await store.list())[0].lastUsed).toBe(1700000000000);
});

// verifyAssertion rejects a non-numeric stored count, so a record whose
// signCount persisted as null must not reach it — that would turn a valid
// passkey into a permanent 401.
test('listRaw normalizes a missing or null sign count to 0', async () => {
  await store.add({ ...CRED, signCount: null }, { rpId: 'tmux.example.com' });
  expect((await store.listRaw())[0].signCount).toBe(0);
  await store.add({ id: 'cred-b', publicKey: 'cose-b', alg: -7, label: 'B', transports: [] }, { rpId: 'tmux.example.com' });
  expect((await store.listRaw()).find((c) => c.id === 'cred-b').signCount).toBe(0);
});

test('remove reports whether anything was removed', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  expect(await store.remove('nope')).toEqual({ removed: false, disarmed: false });
  expect(await store.remove('cred-a')).toEqual({ removed: true, disarmed: false });
  expect(await store.list()).toEqual([]);
});

test('refuses to arm passkey-only with no credential enrolled', async () => {
  await expect(store.setPasskeyOnly(true)).rejects.toThrow(/enroll a passkey/);
});

test('arms passkey-only once a credential exists', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  expect(await store.setPasskeyOnly(true)).toBe(true);
  expect(await store.getPasskeyOnly()).toBe(true);
});

// Anti-lockout guard: deleting the last passkey must not leave the toggle armed
// with nothing able to satisfy it.
test('removing the last credential disarms passkey-only and clears the pin', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.setPasskeyOnly(true);
  expect(await store.remove('cred-a')).toEqual({ removed: true, disarmed: true });
  expect(await store.getPasskeyOnly()).toBe(false);
  expect(await store.getRpId()).toBeNull();
});

test('generates a stable user handle once', async () => {
  const a = await store.getUserHandle();
  expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(await store.getUserHandle()).toBe(a);
});

test('writes the file owner-only', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  const st = await fs.stat(path.join(dir, 'passkeys.json'));
  expect(st.mode & 0o777).toBe(0o600);
});

// A corrupt store fails OPEN: the armed state is unrecoverable from a
// quarantined file, and failing closed would brick fleet access on a disk
// glitch. See the spec's "corrupt store fails open" section.
test('quarantines a corrupt file and starts empty', async () => {
  const file = path.join(dir, 'passkeys.json');
  await fs.writeFile(file, '{ not json');
  const warnings = [];
  const s = createPasskeyStore({ dataDir: dir, log: (m) => warnings.push(m) });
  expect(await s.list()).toEqual([]);
  expect(await s.getPasskeyOnly()).toBe(false);
  expect(warnings.join(' ')).toMatch(/unreadable/);
  const left = await fs.readdir(dir);
  expect(left.some((f) => f.startsWith('passkeys.json.corrupt-'))).toBe(true);
});

// --- Concurrency: every mutator is a read-modify-write over the same file,
// so two concurrent calls must not be able to interleave their read before
// either writes. These races are deterministic, not "usually happens":
// Promise.all evaluates both call expressions synchronously, back to back,
// and each of add()/remove()/touch()/setPasskeyOnly()/getUserHandle() awaits
// its first `readJson` (a `fsp.readFile`) before doing anything else. Calling
// an async function runs it synchronously up to that first await, so BOTH
// reads are dispatched — against the identical, not-yet-modified file —
// before either call's write can happen. Nothing about disk or scheduler
// timing needs to cooperate for that half of the race; only which write
// lands last is genuinely racy, and the assertions below are written to
// catch a lost/clobbered write no matter which one that is.

test('concurrent add() calls for different credential ids do not lose a write', async () => {
  await Promise.all([
    store.add(CRED, { rpId: 'tmux.example.com' }),
    store.add({ ...CRED, id: 'cred-b', label: 'Phone' }, { rpId: 'tmux.example.com' }),
  ]);
  const ids = (await store.list()).map((c) => c.id).sort();
  expect(ids).toEqual(['cred-a', 'cred-b']);
});

// Races setPasskeyOnly(true) against remove() of a NON-last credential (two
// enrolled, one removed) so neither call's "last credential" guard can ever
// throw regardless of which order the mutex (once added) picks — the test
// only wants to expose the lost-write interleaving, not the guard.
//
// Whichever of the two writes lands last pre-fix, one of the two checks
// below is violated: if remove()'s write lands last, the final file has
// passkeyOnly back at false even though setPasskeyOnly() returned true; if
// setPasskeyOnly()'s write lands last, cred-a is still in the final file
// even though remove() reported { removed: true }. Verified by hand for
// both orderings before writing this, so the test doesn't depend on which
// one actually happens on a given run.
test('setPasskeyOnly(true) racing remove() never reports success for a change that did not persist', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.add({ ...CRED, id: 'cred-b' }, { rpId: 'tmux.example.com' });

  const [removeResult, setResult] = await Promise.all([
    store.remove('cred-a'),
    store.setPasskeyOnly(true),
  ]);

  const finalList = await store.list();
  const finalArmed = await store.getPasskeyOnly();
  if (removeResult.removed) {
    expect(finalList.some((c) => c.id === 'cred-a')).toBe(false);
  }
  expect(finalArmed).toBe(setResult);
});

// Regression guard on the lock's error handling, not on the pre-fix code
// (there's no queue to wedge without a lock, so this passes either way): if
// withLock ever let a rejection propagate into `queue` itself instead of
// swallowing it, every later mutation would inherit that rejection forever.
test('a throwing mutation does not wedge later mutations', async () => {
  await expect(store.setPasskeyOnly(true)).rejects.toThrow(/enroll a passkey/);
  await store.add(CRED, { rpId: 'tmux.example.com' });
  expect(await store.list()).toHaveLength(1);
});

test('concurrent first-ever getUserHandle() calls mint the same handle', async () => {
  const [a, b] = await Promise.all([store.getUserHandle(), store.getUserHandle()]);
  expect(a).toBe(b);
  // The winner of the race must be what's actually on disk, not an orphaned
  // value some caller was handed but the store never persisted.
  expect(await store.getUserHandle()).toBe(a);
});

// The rpId pin exists so a hostname change is detected, not silently
// defeated. `?? rpId` with no validation lets undefined vanish from the
// JSON (so the "pin" silently evaporates and a later add() re-pins to a
// different host) or lets '' pin the store to the empty string forever
// (`'' ?? x` keeps `''`). Both are reachable only by a caller bug — the
// route layer should always pass a real hostname — but add() should refuse
// them outright rather than accept and persist either.
test('add() refuses a missing, empty, or non-string rpId', async () => {
  await expect(store.add(CRED, {})).rejects.toThrow(/rpId/);
  await expect(store.add(CRED, { rpId: '' })).rejects.toThrow(/rpId/);
  await expect(store.add(CRED, { rpId: 42 })).rejects.toThrow(/rpId/);
  expect(await store.list()).toEqual([]);
  expect(await store.getRpId()).toBeNull();
});

// signCount boundary coverage: negative and non-integer values are corrupt
// input and normalize to 0. 0xFFFFFFFF (uint32 max) and anything above it
// must pass through UNCHANGED — verifyAssertion is what rejects an
// out-of-range count, deliberately locking that one credential instead of
// clamping it to 0 and disabling clone detection for it.
test('listRaw normalizes negative and non-integer sign counts to 0', async () => {
  await store.add({ ...CRED, id: 'cred-neg', signCount: -1 }, { rpId: 'tmux.example.com' });
  await store.add({ ...CRED, id: 'cred-frac', signCount: 1.5 }, { rpId: 'tmux.example.com' });
  const raw = await store.listRaw();
  expect(raw.find((c) => c.id === 'cred-neg').signCount).toBe(0);
  expect(raw.find((c) => c.id === 'cred-frac').signCount).toBe(0);
});

test('listRaw passes sign counts at and above the uint32 boundary through unchanged', async () => {
  await store.add({ ...CRED, id: 'cred-max', signCount: 0xFFFFFFFF }, { rpId: 'tmux.example.com' });
  await store.add({ ...CRED, id: 'cred-over', signCount: 0xFFFFFFFF + 1 }, { rpId: 'tmux.example.com' });
  const raw = await store.listRaw();
  expect(raw.find((c) => c.id === 'cred-max').signCount).toBe(0xFFFFFFFF);
  expect(raw.find((c) => c.id === 'cred-over').signCount).toBe(0xFFFFFFFF + 1);
});

// `created` is displayed as "added on" in the UI, so re-enrolling the same
// authenticator (upsert by credential id) must not reset it to the current
// time. Uses its own store over the same dir with a mutable clock, since the
// shared `store` from beforeEach is pinned to one fixed `now`.
test('re-enrolling the same credential id preserves the original created time', async () => {
  let t = 1000;
  const s = createPasskeyStore({ dataDir: dir, now: () => t });
  await s.add(CRED, { rpId: 'tmux.example.com' });
  t = 2000;
  const reenrolled = await s.add({ ...CRED, label: 'Renamed' }, { rpId: 'tmux.example.com' });
  expect(reenrolled.created).toBe(1000);
  const list = await s.list();
  expect(list[0].created).toBe(1000);
  expect(list[0].label).toBe('Renamed');
});
