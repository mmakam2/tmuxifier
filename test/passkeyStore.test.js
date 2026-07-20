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
