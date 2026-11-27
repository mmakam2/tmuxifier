import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkerBench } from './helpers/workerBench.js';
import { createAgentWorkerStore } from '../src/server/agentWorkerStore.js';
import { createAgentWorkers, START_SETTLE_MS } from '../src/server/agentWorkers.js';

// The starter (design section 5.2) over the real start script: `execCommand` runs each remote
// through the worker bench (test/helpers/workerBench.js: a private tmux server on its own -L
// socket under a private TMUX_TMPDIR and HOME), under `sh` as a box's login shell would, and
// the settings come from a real store in a temp dir. Only the box's listing (`sessionsOf`)
// and the setup gate are plain functions, because they are what a test has to hold still.

const BOX = { id: 'b1', host: 'box.example.com' };

let bench;
let dataDir;
let store;
let calls;

beforeEach(() => {
  bench = createWorkerBench({ defaultShell: 'bash' });
  dataDir = mkdtempSync(path.join(tmpdir(), 'agent-workers-'));
  store = createAgentWorkerStore({ dataDir });
  calls = [];
});

afterEach(async () => {
  await bench.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

function projectDir(name) {
  const dir = path.join(bench.home, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The production result shape is { code, stdout, stderr }; the bench returns { code, stdout }.
const benchExec = async (box, remote, opts) => {
  calls.push({ box: box.id, opts });
  const r = bench.run('sh', remote);
  return { code: r.code, stdout: r.stdout, stderr: '' };
};

function starter(overrides = {}) {
  return createAgentWorkers({
    execCommand: benchExec,
    workerStore: store,
    setupRunning: () => false,
    sessionsOf: () => [],
    ...overrides,
  });
}

async function saveDefault(extra = {}) {
  await store.set(BOX.id, {
    projects: [{ name: 'api', dir: projectDir('api') }, { name: 'web', dir: projectDir('web') }],
    ...extra,
  });
}

const hasSession = (name) => {
  try { bench.tmux('has-session', '-t', `=${name}`); return true; } catch { return false; }
};

test('no project name starts the first project, with the 12 s script timeout', async () => {
  await saveDefault();
  const r = await starter().start(BOX);
  expect(r).toEqual({ ok: true, session: 'worker-api-1', project: 'api', trust: null });
  expect(hasSession('worker-api-1')).toBe(true);
  expect(calls).toEqual([{ box: 'b1', opts: { timeoutMs: 12000 } }]);
});

test('a named project starts that project', async () => {
  await saveDefault();
  const r = await starter().start(BOX, { project: 'web' });
  expect(r).toMatchObject({ ok: true, session: 'worker-web-1', project: 'web' });
  expect(hasSession('worker-web-1')).toBe(true);
});

test('a project with trust on reports the trust result', async () => {
  await store.set(BOX.id, { projects: [{ name: 'api', dir: projectDir('api'), trust: true }] });
  const r = await starter().start(BOX);
  expect(r).toEqual({ ok: true, session: 'worker-api-1', project: 'api', trust: 'written' });
});

test('an unknown project is no-project and nothing is executed', async () => {
  await saveDefault();
  expect(await starter().start(BOX, { project: 'nope' })).toEqual({ ok: false, code: 'no-project' });
  expect(calls).toHaveLength(0);
});

test('a box with no record is no-project and nothing is executed', async () => {
  expect(await starter().start(BOX)).toEqual({ ok: false, code: 'no-project' });
  expect(calls).toHaveLength(0);
});

test('a running setup job is setup-running and nothing is executed', async () => {
  await saveDefault();
  const seen = [];
  const r = await starter({ setupRunning: (id) => { seen.push(id); return true; } }).start(BOX);
  expect(r).toEqual({ ok: false, code: 'setup-running' });
  expect(seen).toEqual(['b1']);
  expect(calls).toHaveLength(0);
});

test('a box that is not reachable is unreachable and nothing is executed', async () => {
  await saveDefault();
  const r = await starter({ sessionsOf: () => null }).start(BOX);
  expect(r).toEqual({ ok: false, code: 'unreachable' });
  expect(calls).toHaveLength(0);
});

test('a mode outside the closed list is bad-mode, checked before anything else', async () => {
  await saveDefault();
  const r = await starter({ setupRunning: () => true, sessionsOf: () => null }).start(BOX, { mode: 'headless' });
  expect(r).toEqual({ ok: false, code: 'bad-mode' });
  expect(calls).toHaveLength(0);
});

test('checks run in order: setup before reachable before project', async () => {
  // No record (no-project), not reachable, setup running: setup wins.
  expect(await starter({ setupRunning: () => true, sessionsOf: () => null }).start(BOX)).toEqual({ ok: false, code: 'setup-running' });
  expect(await starter({ sessionsOf: () => null }).start(BOX)).toEqual({ ok: false, code: 'unreachable' });
});

// With no pane listing (`panesOf` not given, as here, or null) the session rows' active panes count.
test('max running workers is worker-cap; leftover shells do not count and keep their numbers', async () => {
  await saveDefault({ max: 2 });
  const two = (paneCmd) => [
    { name: 'worker-api-1', paneCmd },
    { name: 'worker-api-2', paneCmd },
  ];
  expect(await starter({ sessionsOf: () => two('claude') }).start(BOX)).toEqual({ ok: false, code: 'worker-cap' });
  expect(calls).toHaveLength(0);

  const r = await starter({ sessionsOf: () => two('zsh') }).start(BOX);
  expect(r).toMatchObject({ ok: true, session: 'worker-api-3' });
});

test('the running count reads the pane rows: any pane of a worker session running claude counts it once', async () => {
  await saveDefault({ max: 2 });
  // The session rows show each worker's active pane, a shell; the pane rows show what runs behind it.
  const sessions = [{ name: 'worker-api-1', paneCmd: 'zsh' }, { name: 'worker-api-2', paneCmd: 'zsh' }];
  const pane = (session, id, cmd, active) => ({ session, windowId: '@1', pane: id, index: 0, active, zoomed: false, cmd });
  const both = [
    pane('worker-api-1', '%1', 'zsh', true), pane('worker-api-1', '%2', 'claude', false), pane('worker-api-1', '%3', 'claude', false),
    pane('worker-api-2', '%4', 'zsh', true), pane('worker-api-2', '%5', 'claude', false),
  ];
  expect(await starter({ sessionsOf: () => sessions, panesOf: () => both }).start(BOX)).toEqual({ ok: false, code: 'worker-cap' });
  expect(calls).toHaveLength(0);
  // One worker left on claude: room for one more, and the names come from the session rows.
  const one = both.filter((p) => p.session === 'worker-api-1');
  expect(await starter({ sessionsOf: () => sessions, panesOf: () => [...one, pane('worker-api-2', '%4', 'zsh', true)] }).start(BOX))
    .toMatchObject({ ok: true, session: 'worker-api-3' });
  // A pane listing that is not known falls back to the session rows: both shells, nothing running.
  expect(await starter({ sessionsOf: () => [...sessions, { name: 'worker-api-3', paneCmd: 'zsh' }], panesOf: () => null }).start(BOX))
    .toMatchObject({ ok: true, session: 'worker-api-4' });
});

test('Review Focus 2: two starts made together get two names, one script each', async () => {
  await saveDefault();
  const workers = starter({ sessionsOf: () => [] });
  const [a, b] = await Promise.all([workers.start(BOX), workers.start(BOX)]);
  expect(a).toMatchObject({ ok: true, session: 'worker-api-1' });
  expect(b).toMatchObject({ ok: true, session: 'worker-api-2' });
  expect(hasSession('worker-api-1')).toBe(true);
  expect(hasSession('worker-api-2')).toBe(true);
  // The second took the next name from the first's start, not from a lost race (`exists`).
  expect(calls).toHaveLength(2);
});

test('a just-started worker counts against the cap before the listing shows it', async () => {
  await saveDefault({ max: 1 });
  const workers = starter({ sessionsOf: () => [] });
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  expect(await workers.start(BOX)).toEqual({ ok: false, code: 'worker-cap' });
  expect(calls).toHaveLength(1);
});

test('a just-started name is not counted twice once the listing shows it', async () => {
  await saveDefault({ max: 2 });
  let listing = [];
  const workers = starter({ sessionsOf: () => listing });
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  listing = [{ name: 'worker-api-1', paneCmd: 'claude' }];
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-2' });
});

test('after 60 s a start no longer counts on its own; an existing name is retried with the next', async () => {
  await saveDefault({ max: 1 });
  let t = 1_000_000;
  const workers = starter({ sessionsOf: () => [], now: () => t });
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  t += 61_000;
  // The listing still shows nothing, so worker-api-1 is tried, the script reports `exists`,
  // and the one retry takes worker-api-2.
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-2' });
  expect(calls).toHaveLength(3);
});

// The listing clock (statusPoller.listingSeq): how many status reads of the box have been
// applied. Two applied after a start mean the listing was read after the session existed, so
// the listing, not the starter's memory, says what runs.
function listingClock(start = 7) {
  let n = start;
  return { listingSeq: () => n, advance: (k) => { n += k; } };
}

test('START_SETTLE_MS is 15 s', () => {
  expect(START_SETTLE_MS).toBe(15000);
});

test('with a listing clock, a start still counts while the listing has not been read twice since', async () => {
  await saveDefault({ max: 1 });
  const clock = listingClock();
  const workers = starter({ sessionsOf: () => [], listingSeq: clock.listingSeq });
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  expect(await workers.start(BOX)).toEqual({ ok: false, code: 'worker-cap' });
  clock.advance(1);
  expect(await workers.start(BOX)).toEqual({ ok: false, code: 'worker-cap' });
  expect(calls).toHaveLength(1);
});

test('two reads after a start, a name the listing does not show is forgotten: the next start reuses it', async () => {
  await saveDefault({ max: 1 });
  const clock = listingClock();
  const workers = starter({ sessionsOf: () => [], listingSeq: clock.listingSeq });
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  bench.tmux('kill-session', '-t', '=worker-api-1');
  clock.advance(2);
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  expect(hasSession('worker-api-1')).toBe(true);
  expect(calls).toHaveLength(2);
});

test('two reads after a start, a listed name whose pane runs claude counts against the cap', async () => {
  await saveDefault({ max: 1 });
  const clock = listingClock();
  let listing = [];
  const workers = starter({ sessionsOf: () => listing, listingSeq: clock.listingSeq });
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  listing = [{ name: 'worker-api-1', paneCmd: 'claude' }];
  clock.advance(2);
  expect(await workers.start(BOX)).toEqual({ ok: false, code: 'worker-cap' });
  expect(calls).toHaveLength(1);
});

test('two reads after a start, a listed name still at its shell counts for 15 s, then only as a taken name', async () => {
  await saveDefault({ max: 1 });
  const clock = listingClock();
  let t = 1_000_000;
  let listing = [];
  const workers = starter({ sessionsOf: () => listing, listingSeq: clock.listingSeq, now: () => t });
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  listing = [{ name: 'worker-api-1', paneCmd: 'zsh' }];
  clock.advance(2);
  t += 5_000;
  expect(await workers.start(BOX)).toEqual({ ok: false, code: 'worker-cap' });
  t += 15_000;
  // The shell is a leftover (design 5.8): it keeps its number and does not use up the cap.
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-2' });
  expect(calls).toHaveLength(2);
});

test('the clock is read with the listing: a read applied while the start runs does not vouch for the older listing', async () => {
  await saveDefault({ max: 1 });
  const clock = listingClock();
  let readLands = false;
  // A status read applied while the start awaits the store, after it took the listing.
  const workerStore = { get: async (id) => { if (readLands) clock.advance(1); return store.get(id); } };
  const workers = starter({ workerStore, sessionsOf: () => [], listingSeq: clock.listingSeq });
  expect(await workers.start(BOX)).toMatchObject({ ok: true, session: 'worker-api-1' });
  clock.advance(1);
  readLands = true;
  expect(await workers.start(BOX)).toEqual({ ok: false, code: 'worker-cap' });
  expect(calls).toHaveLength(1);
});

test('a second exists is start-failed', async () => {
  await saveDefault();
  const dir = path.join(bench.home, 'api');
  bench.tmux('new-session', '-d', '-s', 'worker-api-1', '-c', dir, 'sleep 600');
  bench.tmux('new-session', '-d', '-s', 'worker-api-2', '-c', dir, 'sleep 600');
  expect(await starter().start(BOX)).toEqual({ ok: false, code: 'start-failed' });
  expect(calls).toHaveLength(2);
  expect(hasSession('worker-api-3')).toBe(false);
});

test('a project whose directory is missing on the box is no-dir', async () => {
  await store.set(BOX.id, { projects: [{ name: 'api', dir: path.join(bench.home, 'gone') }] });
  expect(await starter().start(BOX)).toEqual({ ok: false, code: 'no-dir' });
});

test('a box without the agent is no-agent-binary', async () => {
  await saveDefault();
  rmSync(path.join(bench.home, '.local', 'bin', 'claude'));
  expect(await starter().start(BOX)).toEqual({ ok: false, code: 'no-agent-binary' });
});

test('a non-zero exit, an unparseable result, a failed transport or store are start-failed', async () => {
  await saveDefault();
  const exec = (res) => starter({ execCommand: async () => res });
  expect(await exec({ code: 1, stdout: '', stderr: 'duplicate session' }).start(BOX)).toEqual({ ok: false, code: 'start-failed' });
  // A `started` line on a failed exit is still a failure.
  expect(await exec({ code: 255, stdout: 'WORKER: started\n', stderr: '' }).start(BOX)).toEqual({ ok: false, code: 'start-failed' });
  expect(await exec({ code: 0, stdout: 'WORKER: started-ish\n', stderr: '' }).start(BOX)).toEqual({ ok: false, code: 'start-failed' });
  expect(await starter({ execCommand: async () => { throw new Error('ssh died'); } }).start(BOX)).toEqual({ ok: false, code: 'start-failed' });
  const brokenStore = { get: async () => { throw new Error('disk'); } };
  expect(await starter({ workerStore: brokenStore }).start(BOX)).toEqual({ ok: false, code: 'start-failed' });
});

test('a failed start does not hold the box: the next start runs', async () => {
  await saveDefault();
  let fail = true;
  const workers = starter({
    execCommand: async (box, remote, opts) => {
      if (fail) { fail = false; throw new Error('ssh died'); }
      return benchExec(box, remote, opts);
    },
  });
  const [a, b] = await Promise.all([workers.start(BOX), workers.start(BOX)]);
  expect(a).toEqual({ ok: false, code: 'start-failed' });
  expect(b).toMatchObject({ ok: true, session: 'worker-api-1' });
});

test('starts on different boxes do not wait for each other', async () => {
  await saveDefault();
  await store.set('b2', { projects: [{ name: 'api', dir: projectDir('api') }] });
  let release;
  const gate = new Promise((r) => { release = r; });
  const order = [];
  const workers = starter({
    execCommand: async (box, remote, opts) => {
      if (box.id === 'b1') await gate;
      order.push(box.id);
      return { code: 0, stdout: 'WORKER: started\n', stderr: '' };
    },
  });
  const first = workers.start(BOX);
  const second = await workers.start({ id: 'b2', host: 'box2.example.com' });
  expect(second).toMatchObject({ ok: true, session: 'worker-api-1' });
  release();
  expect(await first).toMatchObject({ ok: true, session: 'worker-api-1' });
  expect(order).toEqual(['b2', 'b1']);
});
