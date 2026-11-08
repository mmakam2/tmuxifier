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

function setup({ sessions = { 5: 'web' } } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'osc-listen-'));
  tmps.push(home);
  const stubDir = path.join(home, 'bin');
  mkdirSync(stubDir);
  const stub = makeStubTmux(stubDir, { sessionOf: sessions });
  const child = spawn('python3', [ASSET, 'listen', '%5'], {
    env: { HOME: home, PATH: `${stubDir}:${process.env.PATH}`, ...stub.env },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  kids.push(child);
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const markerOf = (s) => path.join(home, '.tmuxifier-agent', s);
  const entryFile = path.join(home, '.tmuxifier-osc', 'panes', '5');
  return { home, stub, child, exited, markerOf, entryFile, send: (b) => child.stdin.write(b) };
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
const waitMarker = (t, session, re) => waitFor(() => { const c = readIf(t.markerOf(session)); return c && re.test(c) ? c : null; });

test('working then idle write the marker, EOF removes marker and entry', async () => {
  const t = setup();
  t.send(osc('state=working'));
  const c = await waitMarker(t, 'web', /^web:working:\d+:prompt\n$/);
  expect(statSync(t.markerOf('web')).mode & 0o777).toBe(0o644);
  const entry = JSON.parse(readFileSync(t.entryFile, 'utf8'));
  expect(entry.pid).toBe(t.child.pid);
  expect(entry.session).toBe('web');
  expect(entry.lastWritten).toBe(c);
  expect(Object.keys(entry).sort()).toEqual(['attachedAt', 'handover', 'lastWritten', 'pid', 'records', 'session', 'sha']);
  t.send(osc('state=idle'));
  await waitMarker(t, 'web', /^web:ready:\d+:stop\n$/);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false);
  expect(existsSync(t.entryFile)).toBe(false);
});

test('EOF keeps a marker someone else rewrote', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /:working:/);
  writeFileSync(t.markerOf('web'), 'web:working:1:prompt\n');
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe('web:working:1:prompt\n');
  expect(existsSync(t.entryFile)).toBe(false);
});

test('handover seeds records and keeps marker and entry on EOF', async () => {
  const t = setup();
  mkdirSync(path.dirname(t.entryFile), { recursive: true });
  mkdirSync(path.dirname(t.markerOf('web')), { recursive: true });
  writeFileSync(t.markerOf('web'), 'web:working:1:prompt\n');
  writeFileSync(t.entryFile, JSON.stringify({
    pid: 1, sha: 'x', session: 'web', records: { '': { state: 'working', kind: null } },
    lastWritten: 'web:working:1:prompt\n', handover: true, attachedAt: 1,
  }));
  t.send(osc('state=idle'));
  await waitMarker(t, 'web', /^web:ready:\d+:stop\n$/);
  const cur = JSON.parse(readFileSync(t.entryFile, 'utf8'));
  expect(cur.pid).toBe(t.child.pid);
  expect(cur.handover).toBe(false);
  writeFileSync(t.entryFile, JSON.stringify({ ...cur, handover: true }));
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(true);
  const after = JSON.parse(readFileSync(t.entryFile, 'utf8'));
  expect(after.pid).toBe(t.child.pid);
});

test('sibling pane keeps the session blocked', async () => {
  const t = setup();
  mkdirSync(path.dirname(t.entryFile), { recursive: true });
  writeFileSync(path.join(path.dirname(t.entryFile), '7'), JSON.stringify({
    pid: process.pid, sha: 'x', session: 'web', records: { '': { state: 'blocked', kind: 'permission' } },
    lastWritten: null, handover: false, attachedAt: 1,
  }));
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /^web:blocked:\d+:permission\n$/);
  t.send(osc('state=idle'));
  await waitFor(() => JSON.parse(readFileSync(t.entryFile, 'utf8')).records['']?.state === 'idle');
  await new Promise((r) => setTimeout(r, 100));
  expect(readFileSync(t.markerOf('web'), 'utf8')).toMatch(/^web:blocked:\d+:permission\n$/);
  t.child.stdin.end();
  await t.exited;
});

test('a renamed session gets its own marker', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /:working:/);
  t.stub.setSessions({ 5: 'web2' });
  t.send(osc('state=idle'));
  await waitMarker(t, 'web2', /^web2:ready:\d+:start\n$/);
  expect(readFileSync(t.markerOf('web'), 'utf8')).toMatch(/:working:/);
  t.child.stdin.end();
  await t.exited;
});

test('a junk entry is tolerated; first idle is ready/start', async () => {
  const t = setup();
  mkdirSync(path.dirname(t.entryFile), { recursive: true });
  writeFileSync(t.entryFile, 'not json');
  t.send(osc('state=idle'));
  await waitMarker(t, 'web', /^web:ready:\d+:start\n$/);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
});

test('a session name with a space is sanitized in the filename only', async () => {
  const t = setup({ sessions: { 5: 'my proj' } });
  t.send(osc('state=working'));
  await waitMarker(t, 'my_proj', /^my proj:working:\d+:prompt\n$/);
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
  await waitMarker(t, 'web', /^web:ready:\d+:start\n$/);
  t.child.stdin.end();
  await t.exited;
});

test('a successor that owns the entry is not overwritten by the handed-over listener at EOF', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /^web:working:\d+:prompt\n$/);
  const successor = JSON.stringify({
    pid: t.child.pid + 100000, sha: 'new', session: 'web', records: {}, lastWritten: null, handover: true, attachedAt: 2,
  });
  writeFileSync(t.entryFile, successor);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.entryFile, 'utf8')).toBe(successor);
  expect(existsSync(t.markerOf('web'))).toBe(true);
});
