// test/alertStateStore.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAlertStateStore } from '../src/server/alertStateStore.js';
import { decideAlert } from '../src/server/alertPolicy.js';

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

// --- Wrong-typed-but-parseable fields: a file like {"mutes": "disk-full"}
// (a plausible forgotten-brackets hand-edit) is syntactically valid JSON and
// passes the top-level objShape check, so readJson() does NOT quarantine it
// — quarantine only fires on a parse failure or a non-object top level.
// Without per-field coercion, r.mutes would come back as that raw string,
// and alertPolicy.js's `mutes.includes(alert.key)` on a string is substring
// search, not array membership: a critical, unrelated, unmuted alert could
// be silently reported as suppressed:muted. These tests pin the coercion at
// the store boundary — the layer that documents the "fail loud" guarantee —
// rather than trusting alertPolicy.js to defend itself against a bad shape.

test('a rules file with mutes as a string coerces to an empty array, not a substring-searchable string', async () => {
  const { store, dataDir } = await mk();
  await fs.writeFile(path.join(dataDir, 'alert-rules.json'), JSON.stringify({ mutes: 'disk-full', overrides: {} }));
  expect(await store.getRules()).toEqual({ mutes: [], overrides: {} });
  // The file was valid JSON and a valid top-level object, so it must NOT be
  // treated as corrupt — coercion, not quarantine, is the fix here.
  const left = await fs.readdir(dataDir);
  expect(left.some((f) => f.startsWith('alert-rules.json.corrupt-'))).toBe(false);
});

test('a rules file with mutes as a number coerces to an empty array', async () => {
  const { store, dataDir } = await mk();
  await fs.writeFile(path.join(dataDir, 'alert-rules.json'), JSON.stringify({ mutes: 4, overrides: {} }));
  expect((await store.getRules()).mutes).toEqual([]);
});

test('a rules file with mutes as null coerces to an empty array', async () => {
  const { store, dataDir } = await mk();
  await fs.writeFile(path.join(dataDir, 'alert-rules.json'), JSON.stringify({ mutes: null, overrides: {} }));
  expect((await store.getRules()).mutes).toEqual([]);
});

test('a rules file with overrides as a non-object (an array) coerces to an empty object', async () => {
  const { store, dataDir } = await mk();
  await fs.writeFile(path.join(dataDir, 'alert-rules.json'), JSON.stringify({ mutes: [], overrides: ['nope'] }));
  expect((await store.getRules()).overrides).toEqual({});
});

test('a rules file with overrides as a string coerces to an empty object', async () => {
  const { store, dataDir } = await mk();
  await fs.writeFile(path.join(dataDir, 'alert-rules.json'), JSON.stringify({ mutes: [], overrides: 'nope' }));
  expect((await store.getRules()).overrides).toEqual({});
});

// Same coercion, triage side. isAcked() already happens to fail safe here
// (indexing a non-object by key yields undefined -> not acked), but
// getTriage() itself must still report the documented shape (an object) —
// this is the assertion that actually distinguishes coerced from
// uncoerced, since the isAcked half passes either way.
test('a triage file with acks as a non-object coerces to an empty object', async () => {
  const { store, dataDir } = await mk();
  await fs.writeFile(path.join(dataDir, 'alert-triage.json'), JSON.stringify({ acks: 'nope' }));
  expect(await store.getTriage()).toEqual({});
  expect(await store.isAcked('check:a', 0)).toBe(false);
});

// End-to-end reproduction of the reported vulnerability: with the coercion
// in place, decideAlert() must notify on this critical, unrelated,
// genuinely-unmuted alert instead of reporting suppressed:muted.
test('regression: a string-typed mutes field in the rules file no longer suppresses an unrelated critical alert', async () => {
  const { store, dataDir } = await mk();
  await fs.writeFile(path.join(dataDir, 'alert-rules.json'), JSON.stringify({ mutes: 'disk-full', overrides: {} }));
  const rules = await store.getRules();
  const alert = {
    key: 'disk', source: 'disk', severity: 'critical', state: 'firing',
    count: 1, recentCount: 1, firstTs: 0, lastTs: 0, title: 't', body: '',
  };
  expect(decideAlert({ alert, rules, nowMs: 0, lastNotifiedAt: null })).toEqual({ notify: true, reason: 'notified' });
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
