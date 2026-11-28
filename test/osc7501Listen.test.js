import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeStubTmux } from './helpers/stubTmux.js';

const ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-osc-reporter.py', import.meta.url));

const osc = (body) => `\x1b]7501;${body}\x07`;
const tmps = [];
const kids = [];
afterEach(async () => {
  for (const k of kids.splice(0)) {
    if (k.exitCode === null) { k.kill('SIGKILL'); await new Promise((r) => k.once('exit', r)); }
  }
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// `before` runs before the listener starts: what it writes is there for the
// listener's start-up (the attach seed), with no race against the spawn.
function setup({ sessions = { 5: 'web' }, before } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'osc-listen-'));
  tmps.push(home);
  const stubDir = path.join(home, 'bin');
  mkdirSync(stubDir);
  const stub = makeStubTmux(stubDir, { sessionOf: sessions });
  const markerOf = (s, pane = '%5') => path.join(home, '.tmuxifier-agent', `${s}${pane}`);
  const legacyOf = (s) => path.join(home, '.tmuxifier-agent', s);
  const entryOfPane = (pane) => path.join(home, '.tmuxifier-osc', 'panes', pane.slice(1));
  const entryFile = entryOfPane('%5');
  if (before) before({ home, markerOf, legacyOf, entryFile, entryOfPane });
  // Another listener in the same home and stub tmux (a sibling pane's).
  const listen = (pane) => {
    const child = spawn('python3', [ASSET, 'listen', pane], {
      env: { HOME: home, PATH: `${stubDir}:${process.env.PATH}`, ...stub.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    kids.push(child);
    const exited = new Promise((r) => child.once('exit', (code) => r(code)));
    return { child, exited, send: (b) => child.stdin.write(b) };
  };
  const { child, exited, send } = listen('%5');
  return { home, stub, child, exited, markerOf, legacyOf, entryFile, entryOfPane, listen, send };
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
// On a fold change the listener writes the marker FIRST and persists its entry
// (under entries.lock) after it, so a marker on disk does not mean the entry is
// settled. A test that rewrites, restamps or removes the entry (the loop's
// part, which really does it under that lock) must first wait until the
// listener's persist for the line `c` it just saw has landed; otherwise the
// persist can read the entry before the test's write and write after it.
const waitPersisted = (t, c) => waitFor(() => {
  const e = JSON.parse(readFileSync(t.entryFile, 'utf8'));
  return e.lastWritten === c ? e : null;
});
const waitMarker = (t, session, re) => waitFor(() => { const c = readIf(t.markerOf(session)); return c && re.test(c) ? c : null; });

test('working then idle write the marker, EOF removes marker and entry', async () => {
  const t = setup();
  t.send(osc('state=working'));
  const c = await waitMarker(t, 'web', /^web:working:\d+:prompt:%5\n$/);
  expect(statSync(t.markerOf('web')).mode & 0o777).toBe(0o644);
  const entry = await waitPersisted(t, c);
  expect(entry.pid).toBe(t.child.pid);
  expect(entry.session).toBe('web');
  expect(entry.lastWritten).toBe(c);
  expect(Object.keys(entry).sort()).toEqual(['attachedAt', 'handover', 'lastWritten', 'pid', 'records', 'session', 'sha']);
  t.send(osc('state=idle'));
  await waitMarker(t, 'web', /^web:ready:\d+:stop:%5\n$/);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false);
  expect(existsSync(t.entryFile)).toBe(false);
});

test('EOF keeps a marker someone else rewrote', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /:working:/);
  writeFileSync(t.markerOf('web'), 'web:working:1:prompt:%5\n');
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe('web:working:1:prompt:%5\n');
  expect(existsSync(t.entryFile)).toBe(false);
});

test('handover seeds records and keeps marker and entry on EOF', async () => {
  const t = setup();
  mkdirSync(path.dirname(t.entryFile), { recursive: true });
  mkdirSync(path.dirname(t.markerOf('web')), { recursive: true });
  writeFileSync(t.markerOf('web'), 'web:working:1:prompt:%5\n');
  writeFileSync(t.entryFile, JSON.stringify({
    pid: 1, sha: 'x', session: 'web', records: { '': { state: 'working', kind: null } },
    lastWritten: 'web:working:1:prompt:%5\n', handover: true, attachedAt: 1,
  }));
  t.send(osc('state=idle'));
  const c = await waitMarker(t, 'web', /^web:ready:\d+:stop:%5\n$/);
  const cur = await waitPersisted(t, c);
  expect(cur.pid).toBe(t.child.pid);
  expect(cur.handover).toBe(false);
  writeFileSync(t.entryFile, JSON.stringify({ ...cur, handover: true }));
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(true);
  const after = JSON.parse(readFileSync(t.entryFile, 'utf8'));
  expect(after.pid).toBe(t.child.pid);
});

test('a sibling pane is not folded in: each pane has its own marker', async () => {
  const SIB = 'web:blocked:1:permission:%7\n';
  const t = setup({ before: (p) => {
    mkdirSync(path.dirname(p.entryFile), { recursive: true });
    mkdirSync(path.dirname(p.markerOf('web')), { recursive: true });
    writeFileSync(path.join(path.dirname(p.entryFile), '7'), JSON.stringify({
      pid: process.pid, sha: 'x', session: 'web', records: { '': { state: 'blocked', kind: 'permission' } },
      lastWritten: SIB, handover: false, attachedAt: 1,
    }));
    writeFileSync(p.markerOf('web', '%7'), SIB);
  } });
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /^web:working:\d+:prompt:%5\n$/);
  t.send(osc('state=clear'));
  await waitFor(() => !existsSync(t.markerOf('web')));
  expect(readFileSync(t.markerOf('web', '%7'), 'utf8')).toBe(SIB);
  expect(existsSync(t.legacyOf('web'))).toBe(false);
  t.child.stdin.end();
  await t.exited;
});

test('a pane whose session changed: the marker moves to the new name and the old file is removed', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /:working:/);
  t.stub.setSessions({ 5: 'web2' });
  t.send(osc('state=idle'));
  const c = await waitMarker(t, 'web2', /^web2:ready:\d+:start:%5\n$/);
  expect(existsSync(t.markerOf('web'))).toBe(false);
  await waitPersisted(t, c);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web2'))).toBe(false); // EOF removes the file lastWritten names
});

test('a pane whose session changed leaves an old file someone else rewrote', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /:working:/);
  writeFileSync(t.markerOf('web'), 'web:blocked:1:permission:%5\n');
  t.stub.setSessions({ 5: 'web2' });
  t.send(osc('state=idle'));
  await waitMarker(t, 'web2', /^web2:ready:\d+:start:%5\n$/);
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe('web:blocked:1:permission:%5\n');
  t.child.stdin.end();
  await t.exited;
});

test('a junk entry is tolerated; first idle is ready/start', async () => {
  const t = setup();
  mkdirSync(path.dirname(t.entryFile), { recursive: true });
  writeFileSync(t.entryFile, 'not json');
  t.send(osc('state=idle'));
  await waitMarker(t, 'web', /^web:ready:\d+:start:%5\n$/);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
});

test('a session name with a space is sanitized in the filename only', async () => {
  const t = setup({ sessions: { 5: 'my proj' } });
  t.send(osc('state=working'));
  await waitMarker(t, 'my_proj', /^my proj:working:\d+:prompt:%5\n$/);
  t.child.stdin.end();
  await t.exited;
});

test('a bare clear removes the marker this reporter wrote, and the next idle is a first observation', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /:working:/);
  t.send(osc('state=clear'));
  await waitFor(() => !existsSync(t.markerOf('web')));
  t.send(osc('state=idle'));
  await waitMarker(t, 'web', /^web:ready:\d+:start:%5\n$/);
  t.child.stdin.end();
  await t.exited;
});

test('a successor that owns the entry is not overwritten by the handed-over listener at EOF', async () => {
  const t = setup();
  t.send(osc('state=working'));
  const c = await waitMarker(t, 'web', /^web:working:\d+:prompt:%5\n$/);
  await waitPersisted(t, c);
  const successor = JSON.stringify({
    pid: t.child.pid + 100000, sha: 'new', session: 'web', records: {}, lastWritten: null, handover: true, attachedAt: 2,
  });
  writeFileSync(t.entryFile, successor);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.entryFile, 'utf8')).toBe(successor);
  expect(existsSync(t.markerOf('web'))).toBe(true);
});

test('a probe-only chunk is not an observation: a foreign working marker is untouched and survives EOF', async () => {
  const t = setup();
  mkdirSync(path.dirname(t.markerOf('web')), { recursive: true });
  writeFileSync(t.markerOf('web'), 'web:working:1:prompt:%5\n'); // the Claude hook's
  t.send(osc('?'));
  await waitFor(() => JSON.parse(readFileSync(t.entryFile, 'utf8')).pid === t.child.pid);
  await new Promise((r) => setTimeout(r, 300));
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe('web:working:1:prompt:%5\n');
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe('web:working:1:prompt:%5\n');
  expect(existsSync(t.entryFile)).toBe(false);
});

test('a listener the loop restamped (handover in flight) touches neither marker nor entry at EOF', async () => {
  const t = setup();
  t.send(osc('state=working'));
  const c = await waitMarker(t, 'web', /^web:working:\d+:prompt:%5\n$/);
  // The loop's pre-attach write: pid stripped, attachedAt restamped, handover set.
  const cur = await waitPersisted(t, c);
  const restamped = JSON.stringify({ ...cur, pid: undefined, attachedAt: cur.attachedAt + 1, handover: true });
  writeFileSync(t.entryFile, restamped);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.entryFile, 'utf8')).toBe(restamped);
  expect(existsSync(t.markerOf('web'))).toBe(true);
});

test('the loop dropped the entry for a gone pane before EOF: the listener still removes its own marker', async () => {
  const t = setup();
  t.send(osc('state=working'));
  const c = await waitMarker(t, 'web', /^web:working:\d+:prompt:%5\n$/);
  await waitPersisted(t, c);
  rmSync(t.entryFile); // pass_once: pane gone / pipe gone, concurrent with the pane's death
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false);
});

test('attach seed: a fresh listener on a session with no marker writes ready/start before any chunk', async () => {
  const t = setup();
  const c = await waitMarker(t, 'web', /^web:ready:\d+:start:%5\n$/);
  const entry = await waitPersisted(t, c);
  expect(entry.pid).toBe(t.child.pid);
  expect(entry.session).toBe('web');
  t.send(osc('state=idle'));
  await new Promise((r) => setTimeout(r, 300));
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe(c); // the agent's own idle changes nothing
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false); // ours: removed at a real EOF
});

test('attach seed: an existing marker (the hook\'s) is untouched before any chunk', async () => {
  const t = setup();
  mkdirSync(path.dirname(t.markerOf('web')), { recursive: true });
  writeFileSync(t.markerOf('web'), 'web:working:1:prompt:%5\n');
  await waitFor(() => JSON.parse(readFileSync(t.entryFile, 'utf8')).pid === t.child.pid);
  await new Promise((r) => setTimeout(r, 300));
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe('web:working:1:prompt:%5\n');
  expect(JSON.parse(readFileSync(t.entryFile, 'utf8')).lastWritten).toBe(null);
  t.child.stdin.end();
  await t.exited;
});

test('attach seed: a seeded start (entry with records/lastWritten) writes nothing before its first chunk', async () => {
  const t = setup();
  mkdirSync(path.dirname(t.entryFile), { recursive: true });
  writeFileSync(t.entryFile, JSON.stringify({
    sha: 'x', session: 'web', records: { '': { state: 'idle', kind: null } },
    lastWritten: 'web:ready:1:start:%5\n', handover: true, attachedAt: 1,
  }));
  await waitFor(() => JSON.parse(readFileSync(t.entryFile, 'utf8')).pid === t.child.pid);
  await new Promise((r) => setTimeout(r, 300));
  expect(existsSync(t.markerOf('web'))).toBe(false);
  t.child.stdin.end();
  await t.exited;
});

test('attach seed is per pane: a session-wide file and a sibling pane\'s file do not stop it and are not touched', async () => {
  const t = setup({ before: (p) => {
    mkdirSync(path.dirname(p.markerOf('web')), { recursive: true });
    writeFileSync(p.legacyOf('web'), 'web:working:1:prompt\n');
    writeFileSync(p.markerOf('web', '%7'), 'web:blocked:1:permission:%7\n');
  } });
  await waitMarker(t, 'web', /^web:ready:\d+:start:%5\n$/);
  expect(readFileSync(t.legacyOf('web'), 'utf8')).toBe('web:working:1:prompt\n');
  expect(readFileSync(t.markerOf('web', '%7'), 'utf8')).toBe('web:blocked:1:permission:%7\n');
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false);
  expect(readFileSync(t.legacyOf('web'), 'utf8')).toBe('web:working:1:prompt\n');
});

test('a non-ASCII session name is sanitised byte for byte, like the hook', async () => {
  const t = setup({ sessions: { 5: 'café' } });
  t.send(osc('state=working'));
  await waitMarker(t, 'caf__', /^café:working:\d+:prompt:%5\n$/);
  t.child.stdin.end();
  await t.exited;
});

test('an inherited session-wide line for a non-ASCII session finds the file the older listener named per character, and migration releases it', async () => {
  const OLD = 'café:working:1:prompt\n';
  const t = setup({ sessions: { 5: 'café' }, before: (p) => {
    mkdirSync(path.dirname(p.entryFile), { recursive: true });
    mkdirSync(path.dirname(p.legacyOf('caf_')), { recursive: true });
    writeFileSync(p.legacyOf('caf_'), OLD); // the old listener's per-character spelling
    writeFileSync(p.entryFile, JSON.stringify({
      sha: 'x', session: 'café', records: { '': { state: 'working', kind: null } },
      lastWritten: OLD, handover: true, attachedAt: 1,
    }));
  } });
  // The pane file takes the per-byte name; the old line is carried, ts included.
  await waitFor(() => readIf(t.markerOf('caf__')) === 'café:working:1:prompt:%5\n');
  expect(existsSync(t.legacyOf('caf_'))).toBe(false);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('caf__'))).toBe(false);
  expect(existsSync(t.entryFile)).toBe(false);
});

const LEGACY = 'web:working:1700000000:prompt\n';
// The entry a listener of the previous asset version leaves for its successor.
const legacyEntry = (over = {}) => JSON.stringify({
  sha: 'old', session: 'web', records: { '': { state: 'working', kind: null } },
  lastWritten: LEGACY, handover: true, attachedAt: 1, ...over,
});
// `files(p)` returns { <absolute path>: <content> } to write before the listener starts.
const plant = (entry, files = () => ({})) => (p) => {
  mkdirSync(path.dirname(p.entryFile), { recursive: true });
  mkdirSync(path.dirname(p.legacyOf('web')), { recursive: true });
  writeFileSync(p.entryFile, entry);
  for (const [file, content] of Object.entries(files(p))) writeFileSync(file, content);
};
const entryOf = (t) => JSON.parse(readFileSync(t.entryFile, 'utf8'));

test('migration: a session-wide marker still ours is removed and carried to the pane file with its state, cause and ts', async () => {
  const t = setup({ before: plant(legacyEntry(), (p) => ({ [p.legacyOf('web')]: LEGACY })) });
  const NEW = 'web:working:1700000000:prompt:%5\n';
  await waitFor(() => readIf(t.markerOf('web')) === NEW);
  expect(existsSync(t.legacyOf('web'))).toBe(false);
  await waitFor(() => entryOf(t).pid === t.child.pid && entryOf(t).lastWritten === NEW);
  t.send(osc('state=idle'));
  await waitMarker(t, 'web', /^web:ready:\d+:stop:%5\n$/); // the fold continues: a finished turn, not a first observation
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false);
});

test('migration: a session-wide file someone else rewrote is kept; the pane file comes from the inherited records', async () => {
  const OTHER = 'web:blocked:5:permission\n'; // an older sibling listener's fold, or the hook's
  const t = setup({ before: plant(legacyEntry(), (p) => ({ [p.legacyOf('web')]: OTHER })) });
  const c = await waitMarker(t, 'web', /^web:working:\d+:prompt:%5\n$/);
  expect(c).not.toBe('web:working:1700000000:prompt:%5\n'); // not ours: nothing of the old line is carried
  expect(readFileSync(t.legacyOf('web'), 'utf8')).toBe(OTHER);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.legacyOf('web'), 'utf8')).toBe(OTHER);
});

test('migration: a legacy line that was a sibling\'s fold is removed, and the pane file says what this pane\'s own records say', async () => {
  const FOLD = 'web:blocked:1700000000:permission\n';
  const entry = legacyEntry({ records: { '': { state: 'idle', kind: null } }, lastWritten: FOLD });
  const t = setup({ before: plant(entry, (p) => ({ [p.legacyOf('web')]: FOLD })) });
  await waitMarker(t, 'web', /^web:ready:\d+:start:%5\n$/);
  expect(existsSync(t.legacyOf('web'))).toBe(false);
  t.child.stdin.end();
  await t.exited;
});

test('migration: a pane file that already exists is not touched', async () => {
  const HOOK = 'web:blocked:9:question:%5\n';
  const t = setup({ before: plant(legacyEntry(), (p) => ({ [p.legacyOf('web')]: LEGACY, [p.markerOf('web')]: HOOK })) });
  await waitFor(() => entryOf(t).pid === t.child.pid);
  await waitFor(() => !existsSync(t.legacyOf('web')));
  await new Promise((r) => setTimeout(r, 300));
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe(HOOK);
  expect(entryOf(t).lastWritten).toBe(null);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe(HOOK);
});

test('migration when tmux cannot name the pane\'s session: the inherited session is used; with none, only the owned file goes', async () => {
  const a = setup({ sessions: {}, before: plant(legacyEntry(), (p) => ({ [p.legacyOf('web')]: LEGACY })) });
  await waitFor(() => readIf(a.markerOf('web')) === 'web:working:1700000000:prompt:%5\n');
  expect(existsSync(a.legacyOf('web'))).toBe(false);
  a.child.stdin.end();
  expect(await a.exited).toBe(0);

  const b = setup({ sessions: {}, before: plant(legacyEntry({ session: undefined }), (p) => ({ [p.legacyOf('web')]: LEGACY })) });
  await waitFor(() => entryOf(b).pid === b.child.pid);
  await waitFor(() => !existsSync(b.legacyOf('web')));
  expect(existsSync(b.markerOf('web'))).toBe(false);
  expect(entryOf(b).lastWritten).toBe(null);
  b.child.stdin.end();
  expect(await b.exited).toBe(0);
});

test('migration with sibling panes: each successor writes its own pane file from its records at start, whether or not it owned the session-wide file', async () => {
  // Two panes of `web`, both handed over from older listeners. The
  // session-wide file holds what B's old listener wrote last, so only B can
  // prove it is ours; A must still get its own marker without new output.
  const A_OLD = 'web:blocked:1699999000:permission\n';
  const B_OLD = 'web:working:1700000000:prompt\n';
  const t = setup({ sessions: { 5: 'web', 7: 'web' }, before: (p) => {
    mkdirSync(path.dirname(p.entryFile), { recursive: true });
    mkdirSync(path.dirname(p.legacyOf('web')), { recursive: true });
    writeFileSync(p.entryOfPane('%5'), JSON.stringify({
      sha: 'old', session: 'web', records: { '': { state: 'blocked', kind: 'permission' } },
      lastWritten: A_OLD, handover: true, attachedAt: 1,
    }));
    writeFileSync(p.entryOfPane('%7'), JSON.stringify({
      sha: 'old', session: 'web', records: { '': { state: 'working', kind: null } },
      lastWritten: B_OLD, handover: true, attachedAt: 1,
    }));
    writeFileSync(p.legacyOf('web'), B_OLD);
  } });
  const b = t.listen('%7');
  await waitMarker(t, 'web', /^web:blocked:\d+:permission:%5\n$/);
  await waitFor(() => readIf(t.markerOf('web', '%7')) === 'web:working:1700000000:prompt:%7\n');
  await waitFor(() => !existsSync(t.legacyOf('web')));
  const entryB = () => JSON.parse(readFileSync(t.entryOfPane('%7'), 'utf8'));
  await waitFor(() => entryOf(t).pid === t.child.pid && entryB().pid === b.child.pid);
  expect(entryOf(t).lastWritten).toBe(readFileSync(t.markerOf('web'), 'utf8'));
  expect(entryB().lastWritten).toBe('web:working:1700000000:prompt:%7\n');
  t.child.stdin.end();
  b.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(await b.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false);
  expect(existsSync(t.markerOf('web', '%7'))).toBe(false);
});
