import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckStore } from '../src/server/checkStore.js';
import { createSecretBox } from '../src/server/secretBox.js';

const mk = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkstore-'));
  let n = 0;
  return {
    dataDir,
    store: createCheckStore({
      dataDir, secretBox: createSecretBox('test-cookie-secret'),
      now: () => '2026-07-25T00:00:00.000Z', genId: () => `id${++n}`,
    }),
  };
};
const httpSpec = { label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' } };

test('addCheck assigns an id and lists it back', async () => {
  const { store } = await mk();
  const added = await store.addCheck(httpSpec);
  expect(added.id).toBe('id1');
  expect((await store.listChecks()).map((c) => c.label)).toEqual(['Invoice app']);
});

test('adding a second check does not clobber the first (push, not overwrite)', async () => {
  const { store } = await mk();
  await store.addCheck(httpSpec);
  await store.addCheck({ ...httpSpec, label: 'Second app' });
  const labels = (await store.listChecks()).map((c) => c.label).sort();
  expect(labels).toEqual(['Invoice app', 'Second app']);
});

test('a check added without a secret reports hasSecret false and carries no secret key', async () => {
  // Pins hasSecret's exact predicate. A plausible-looking but wrong redact —
  // e.g. `hasSecret: secret !== undefined` — would say `true` here, because the
  // stored field is an explicit `null` (not an absent key), not `undefined`.
  const { store } = await mk();
  const added = await store.addCheck(httpSpec);
  expect(added.hasSecret).toBe(false);
  expect('secret' in added).toBe(false);
  const listed = (await store.listChecks())[0];
  expect(listed.hasSecret).toBe(false);
  expect('secret' in listed).toBe(false);
});

test('a secret is sealed on disk and never appears in a listing', async () => {
  const { store, dataDir } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'super-secret-token' });
  expect(added.hasSecret).toBe(true);
  expect(added.secret).toBeUndefined();
  const raw = await fs.readFile(path.join(dataDir, 'checks.json'), 'utf8');
  expect(raw).not.toContain('super-secret-token');
  expect(raw).toContain('pvebox.v1:'); // secretBox scheme tag: it really went through seal()
  expect(await store.getCheck(added.id, { withSecret: true })).toMatchObject({ secret: 'super-secret-token' });
});

test('listChecks and a non-withSecret getCheck both redact the secret, not just addCheck\'s return value', async () => {
  // A broken redact applied only on the write path (addCheck's return) but not
  // on reads would pass a narrower test; this exercises the read paths too.
  const { store } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'super-secret-token' });
  const listed = (await store.listChecks())[0];
  expect(listed.hasSecret).toBe(true);
  expect('secret' in listed).toBe(false);
  const got = await store.getCheck(added.id);
  expect(got.hasSecret).toBe(true);
  expect('secret' in got).toBe(false);
});

test('getCheck without withSecret does not decrypt even implicitly', async () => {
  // If getCheck's default path called secretBox.open unconditionally it would
  // still "work" today (open() succeeds), so assert the redacted shape
  // directly rather than merely that no exception was thrown.
  const { store } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'super-secret-token' });
  const got = await store.getCheck(added.id);
  expect(got).not.toHaveProperty('secret');
  expect(got.hasSecret).toBe(true);
});

test('updating without resending the secret keeps the stored one', async () => {
  const { store } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'keepme' });
  await store.updateCheck(added.id, { ...httpSpec, label: 'Renamed' });
  const got = await store.getCheck(added.id, { withSecret: true });
  expect(got.label).toBe('Renamed');
  expect(got.secret).toBe('keepme');
});

test('updateCheck\'s own return value is redacted, not just a subsequent getCheck', async () => {
  // Every other update test re-fetches via a separate getCheck call, which
  // would still pass even if updateCheck itself handed back the raw record
  // (sealed secret key included) — a live risk the moment a route echoes this
  // return value straight to the browser. Inspect the return value directly.
  const { store } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'keepme' });
  const updated = await store.updateCheck(added.id, { ...httpSpec, label: 'Renamed' });
  expect(updated.hasSecret).toBe(true);
  expect('secret' in updated).toBe(false);
});

test('updating with a whitespace-only secret also keeps the stored one', async () => {
  // "blank" must mean "empty or all-whitespace after trim", not merely "falsy" —
  // a naive `!spec.secret` check happens to agree with `.trim()` on '' but not on '   '.
  const { store } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'keepme' });
  await store.updateCheck(added.id, { ...httpSpec, secret: '   ' });
  expect((await store.getCheck(added.id, { withSecret: true })).secret).toBe('keepme');
});

test('updating WITH a new secret actually replaces the stored one', async () => {
  // The inverse of the two tests above: a broken "always keep existing" branch
  // (e.g. the blank-check condition inverted) would also pass those, but not this.
  const { store, dataDir } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'first-token' });
  await store.updateCheck(added.id, { ...httpSpec, secret: 'second-token' });
  expect((await store.getCheck(added.id, { withSecret: true })).secret).toBe('second-token');
  const raw = await fs.readFile(path.join(dataDir, 'checks.json'), 'utf8');
  expect(raw).not.toContain('first-token');
  expect(raw).not.toContain('second-token');
});

test('invalid input is refused before anything is written', async () => {
  const { store, dataDir } = await mk();
  await expect(store.addCheck({ ...httpSpec, type: 'nope' })).rejects.toThrow(/type/);
  expect(await store.listChecks()).toEqual([]);
  await expect(fs.stat(path.join(dataDir, 'checks.json'))).rejects.toThrow(); // no file created at all
});

test('an invalid update is refused before anything is written, leaving the existing record untouched', async () => {
  // Compares the raw file byte-for-byte, not just a couple of fields the fixture
  // happens to leave unchanged (e.g. `type: 'nope'` is the only field this spec
  // actually changes) — a write-then-validate bug that persists the mutated
  // record before assertCheckInput throws must move the file's bytes.
  const { store, dataDir } = await mk();
  const added = await store.addCheck({ ...httpSpec, secret: 'keepme' });
  const before = await fs.readFile(path.join(dataDir, 'checks.json'), 'utf8');
  await expect(store.updateCheck(added.id, { ...httpSpec, type: 'nope' })).rejects.toThrow(/type/);
  const after = await fs.readFile(path.join(dataDir, 'checks.json'), 'utf8');
  expect(after).toBe(before);
  const got = await store.getCheck(added.id, { withSecret: true });
  expect(got.label).toBe('Invoice app');
  expect(got.type).toBe('http');
  expect(got.secret).toBe('keepme');
});

test('getCheck withSecret:true on a secret-less check returns secret: null without throwing', async () => {
  // Task 7's runner calls getCheck(id, { withSecret: true }) for every due
  // check before executing it, including secret-less http/tcp/heartbeat
  // checks. secretBox.open(null) throws ("unrecognized sealed secret"), so an
  // unconditional open() here (dropping the found.secret ? ... : null guard)
  // would crash the runner on any check that never had a secret.
  const { store } = await mk();
  const added = await store.addCheck(httpSpec); // no secret at all
  const got = await store.getCheck(added.id, { withSecret: true });
  expect(got.secret).toBeNull();
});

test('getCheck returns null for an unknown id, with and without withSecret', async () => {
  // Task 7's runner iterates a listing and calls getCheck per id; a check
  // removed in between must come back as null, not throw, so the runner can
  // skip it rather than crash mid-sweep.
  const { store } = await mk();
  expect(await store.getCheck('missing')).toBeNull();
  expect(await store.getCheck('missing', { withSecret: true })).toBeNull();
});

test('removeCheck drops it and reports whether anything was removed', async () => {
  const { store } = await mk();
  const added = await store.addCheck(httpSpec);
  expect(await store.removeCheck(added.id)).toBe(true);
  expect(await store.removeCheck(added.id)).toBe(false);
  expect(await store.listChecks()).toEqual([]);
});

test('the file is written owner-only', async () => {
  const { store, dataDir } = await mk();
  await store.addCheck(httpSpec);
  const st = await fs.stat(path.join(dataDir, 'checks.json'));
  expect(st.mode & 0o777).toBe(0o600);
});
