// test/alertStateStore.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAlertStateStore } from '../src/server/alertStateStore.js';

const mk = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertstate-'));
  return { dataDir, store: createAlertStateStore({ dataDir, now: () => 5000 }) };
};

test('a fresh store returns rules in the exact shape decideAlert consumes', async () => {
  const { store } = await mk();
  expect(await store.getRules()).toEqual({ mutes: [], overrides: {} });
});

test('mute is idempotent and unmute reverses it', async () => {
  const { store } = await mk();
  await store.mute('check:a');
  await store.mute('check:a');
  expect((await store.getRules()).mutes).toEqual(['check:a']);
  await store.unmute('check:a');
  expect((await store.getRules()).mutes).toEqual([]);
});

// Distinct from the idempotency test above: with only one muted key ever in
// play there, a mutant that made unmute() clear the *entire* mutes list
// (`r.mutes = []`) instead of filtering out just the given key would still
// pass. Two keys, unmute one, and assert the other survives.
test('unmuting one key leaves an unrelated muted key in place', async () => {
  const { store } = await mk();
  await store.mute('check:a');
  await store.mute('check:b');
  await store.unmute('check:a');
  expect((await store.getRules()).mutes).toEqual(['check:b']);
});

test('setOverride merges rather than replacing, so one field does not clear another', async () => {
  const { store } = await mk();
  await store.setOverride('check:a', { failuresBeforeNotify: 5 });
  await store.setOverride('check:a', { severity: 'critical' });
  expect((await store.getRules()).overrides['check:a']).toEqual({ failuresBeforeNotify: 5, severity: 'critical' });
});

// Isolates the overrides object being keyed correctly rather than a mutant
// that stores a single override and overwrites it regardless of key.
test('overrides for two different keys stay independent', async () => {
  const { store } = await mk();
  await store.setOverride('check:a', { severity: 'critical' });
  await store.setOverride('check:b', { failuresBeforeNotify: 1 });
  expect(await store.getRules()).toEqual({
    mutes: [],
    overrides: { 'check:a': { severity: 'critical' }, 'check:b': { failuresBeforeNotify: 1 } },
  });
});

test('ack records the acknowledged timestamp for the key', async () => {
  const { store } = await mk();
  await store.ack('check:a');
  expect(await store.getTriage()).toEqual({ 'check:a': { ackedAt: 5000 } });
});

test('an ack covers occurrences up to its moment but not later ones', async () => {
  const { store } = await mk();
  await store.ack('check:a');
  expect(await store.isAcked('check:a', 4000)).toBe(true);
  expect(await store.isAcked('check:a', 6000)).toBe(false);
});

// The brief's two data points (4000/6000) straddle 5000 but never land on it,
// so a mutant swapping `>=` for `>` in isAcked survives them both — an
// occurrence timestamped exactly at the ack moment is the one case where the
// two operators disagree.
test('isAcked is inclusive at exactly the acked timestamp', async () => {
  const { store } = await mk();
  await store.ack('check:a');
  expect(await store.isAcked('check:a', 5000)).toBe(true);
});

// Guards against an isAcked/getTriage implementation that ignores its `key`
// argument (e.g. returns the only entry in the acks map regardless of which
// key was asked about) — a real risk once there is more than one acked key.
test('isAcked is false for a key that was never acked, even when another key was', async () => {
  const { store } = await mk();
  await store.ack('check:a');
  expect(await store.isAcked('check:b', 1)).toBe(false);
});

test('rules and triage live in separate files', async () => {
  const { store, dataDir } = await mk();
  await store.mute('check:a');
  await store.ack('check:b');
  expect(JSON.parse(await fs.readFile(path.join(dataDir, 'alert-rules.json'), 'utf8')).mutes).toEqual(['check:a']);
  expect(JSON.parse(await fs.readFile(path.join(dataDir, 'alert-triage.json'), 'utf8')).acks['check:b']).toBeTruthy();
});

test('both state files are written mode 0600', async () => {
  const { store, dataDir } = await mk();
  await store.mute('check:a');
  await store.ack('check:b');
  const rulesStat = await fs.stat(path.join(dataDir, 'alert-rules.json'));
  const triageStat = await fs.stat(path.join(dataDir, 'alert-triage.json'));
  expect(rulesStat.mode & 0o777).toBe(0o600);
  expect(triageStat.mode & 0o777).toBe(0o600);
});

// --- The fail-loud contract: this is the point of the task. A corrupt rules
// file must fall back to "no mutes, no overrides", never to anything that
// would make the system go quiet (that would be a false green). jsonFile.js
// already quarantines the corrupt file and hands back whatever `fallback` was
// passed to readJson — this test pins that the fallback chosen here, once
// merged with the store's defaults, is the safe one.
test('a corrupt rules file is quarantined and getRules() comes back with the safe no-mutes fallback', async () => {
  const { store, dataDir } = await mk();
  const file = path.join(dataDir, 'alert-rules.json');
  await fs.writeFile(file, 'not json at all {{{');

  expect(await store.getRules()).toEqual({ mutes: [], overrides: {} });

  const left = await fs.readdir(dataDir);
  expect(left.some((f) => f.startsWith('alert-rules.json.corrupt-'))).toBe(true);
});

// Same fail-loud direction on the triage side: a corrupt ack log must read as
// "nothing acked" (isAcked -> false -> the caller still notifies), never as
// silently-acked, and never throw and take the evaluation loop down with it.
test('a corrupt triage file is quarantined and reads back as nothing acked', async () => {
  const { store, dataDir } = await mk();
  const file = path.join(dataDir, 'alert-triage.json');
  await fs.writeFile(file, 'also not json {{{');

  expect(await store.getTriage()).toEqual({});
  expect(await store.isAcked('check:a', 0)).toBe(false);

  const left = await fs.readdir(dataDir);
  expect(left.some((f) => f.startsWith('alert-triage.json.corrupt-'))).toBe(true);
});

// --- Concurrency: mute/unmute/setOverride are all read-modify-write over the
// same rules file (ack likewise over the triage file), so two concurrent
// calls must not be able to interleave their reads before either writes —
// the same class of bug store.js's `serialize` and passkeyStore.js's
// `withLock` exist to prevent. This race is deterministic, not "usually
// happens": Promise.all evaluates both call expressions synchronously back
// to back, and each mutator awaits its first readJson (an fsp.readFile)
// before doing anything else, so both reads are dispatched against the
// identical, not-yet-modified file before either call's write can land.
test('concurrent mute() calls for different keys do not lose either write', async () => {
  const { store } = await mk();
  await Promise.all([store.mute('check:a'), store.mute('check:b')]);
  expect((await store.getRules()).mutes.sort()).toEqual(['check:a', 'check:b']);
});

test('concurrent setOverride() calls for different keys do not lose either write', async () => {
  const { store } = await mk();
  await Promise.all([
    store.setOverride('check:a', { severity: 'critical' }),
    store.setOverride('check:b', { failuresBeforeNotify: 1 }),
  ]);
  expect(await store.getRules()).toEqual({
    mutes: [],
    overrides: { 'check:a': { severity: 'critical' }, 'check:b': { failuresBeforeNotify: 1 } },
  });
});

test('concurrent ack() calls for different keys do not lose either write', async () => {
  const { store } = await mk();
  await Promise.all([store.ack('check:a'), store.ack('check:b')]);
  expect(await store.getTriage()).toEqual({
    'check:a': { ackedAt: 5000 },
    'check:b': { ackedAt: 5000 },
  });
});
