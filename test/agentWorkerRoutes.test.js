import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createBoxRemoval } from '../src/server/boxRemoval.js';
import { hashPassword } from '../src/server/auth.js';
import { createAgentWorkerStore } from '../src/server/agentWorkerStore.js';
import { createAgentWorkers, START_CODES } from '../src/server/agentWorkers.js';
import { createWorkerBench } from './helpers/workerBench.js';

// The agent-worker browser routes (design 5.1, 5.4) over a real box store, a real worker store
// and the real starter, whose script runs in the worker bench (test/helpers/workerBench.js: a
// private tmux server on its own -L socket under a private TMUX_TMPDIR and HOME). What the
// poller would supply (the snapshot, probeOne) and the setup job table are plain objects a
// test holds still. `sessionsOf` and `panesOf` are built from the snapshot exactly as index.js
// builds them, and box removal is wired with the same onRemoved index.js passes.

let dir, bench, store, workerStore, app, browser, bearer;
let snapshot, probes, probeThrows, setupJobs, execOverride;
// The light probe that records the box's agents into the health history: the calls in order
// with probeOne's (`polls`), and what it answers (`refreshImpl`). `refreshAgents: false` boots a
// poller without it.
let refreshes, polls, refreshImpl;

const route = (m, url, extra = {}) => app.inject({ method: m, url, headers: browser, ...extra });

// The production result shape is { code, stdout, stderr }; the bench returns { code, stdout }.
// `execOverride` stands in for a box the bench cannot be (no tmux at all, a dead transport).
const execCommand = async (box, remote, opts) => {
  if (execOverride) return execOverride(box, remote, opts);
  const r = bench.run('sh', remote);
  return { code: r.code, stdout: r.stdout, stderr: '' };
};

beforeEach(() => {
  bench = createWorkerBench({ defaultShell: 'bash' });
  snapshot = {};
  probes = [];
  probeThrows = false;
  refreshes = [];
  polls = [];
  refreshImpl = null;
  setupJobs = new Map();
  execOverride = null;
});

afterEach(async () => {
  await app?.close();
  app = null;
  await bench.cleanup();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function boot({ withWorkers = true, withMail = false, starter = null, refreshAgents = true } = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-workersr-'));
  store = createStore({ dataDir: dir });
  const orders = await store.addBox({ host: '192.168.1.10', label: 'orders' });
  const billing = await store.addBox({ host: '192.168.1.11', label: 'billing' });
  snapshot[orders.id] = { reachable: true, sessions: [] };
  snapshot[billing.id] = { reachable: true, sessions: [] };
  const setupManager = { currentForBox: (id) => setupJobs.get(id) ?? null, cancelForBox() {} };
  const statusPoller = {
    getSnapshot: () => snapshot,
    probeOne: async (id) => { probes.push(id); polls.push(['probeOne', id]); if (probeThrows) throw new Error('probe hung up'); },
  };
  // Not async: a synchronous throw stays synchronous.
  if (refreshAgents) {
    statusPoller.refreshAgents = (id) => {
      refreshes.push(id);
      polls.push(['refreshAgents', id]);
      return refreshImpl ? refreshImpl(id) : Promise.resolve(true);
    };
  }
  // index.js's sessionsOf: null unless the snapshot entry is there and reachable.
  const sessionsOf = (id) => { const e = statusPoller.getSnapshot()[id]; return e?.reachable ? e.sessions : null; };
  // index.js's panesOf: the pane rows only when the entry is reachable and carries them.
  const panesOf = (id) => { const e = statusPoller.getSnapshot()[id]; return e?.reachable && Array.isArray(e.panes) ? e.panes : null; };
  workerStore = createAgentWorkerStore({ dataDir: dir });
  const agentWorkers = withWorkers
    ? {
      store: workerStore,
      starter: starter ?? createAgentWorkers({
        execCommand,
        workerStore,
        setupRunning: (id) => setupManager.currentForBox(id)?.status === 'running',
        sessionsOf,
        panesOf,
      }),
    }
    : null;
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {}, closeGroup() {} };
  const removeBox = createBoxRemoval({
    store, sessions,
    onRemoved: async (box) => { await workerStore.removeBox(box.id); },
  });
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const deviceStore = createDeviceStore({ dataDir: dir });
  app = buildServer({
    config, store, deviceStore, sessions, statusPoller, setupManager, removeBox,
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    // The worker routes read only whether messaging is on.
    agentMail: withMail ? { kick: async () => {} } : null,
    agentWorkers,
    log: () => {},
  });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  browser = { cookie: `${c.name}=${c.value}` };
  const { token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  bearer = { authorization: `Bearer ${token}` };
  return { orders, billing };
}

function projectDir(name) {
  const d = path.join(bench.home, name);
  mkdirSync(d, { recursive: true });
  return d;
}

const hasSession = (name) => {
  try { bench.tmux('has-session', '-t', `=${name}`); return true; } catch { return false; }
};

const ROUTES = (id) => [
  ['GET', `/api/boxes/${id}/workers`],
  ['PUT', `/api/boxes/${id}/workers`],
  ['POST', `/api/boxes/${id}/workers/start`],
];
const bodyFor = (m) => (m === 'GET' ? undefined : {});

test('GET answers the default record for an untouched box, and whether messaging is on', async () => {
  const { orders } = await boot();
  const res = await route('GET', `/api/boxes/${orders.id}/workers`);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ workers: { projects: [], mailStart: false, max: 3 }, mail: false });
  await app.close(); app = null;
  await fs.rm(dir, { recursive: true, force: true });
  const { orders: o2 } = await boot({ withMail: true });
  expect((await route('GET', `/api/boxes/${o2.id}/workers`)).json()).toEqual({ workers: { projects: [], mailStart: false, max: 3 }, mail: true });
});

test('PUT then GET round-trips the record; only projects, mailStart and max are taken', async () => {
  const { orders, billing } = await boot();
  const payload = {
    projects: [{ name: 'api', dir: '/opt/billing-api', trust: true }, { name: 'web', dir: '/opt/web' }],
    mailStart: true, max: 2,
    extra: 'ignored', version: 9,
  };
  const put = await route('PUT', `/api/boxes/${orders.id}/workers`, { payload });
  expect(put.statusCode).toBe(200);
  const expected = {
    projects: [{ name: 'api', dir: '/opt/billing-api', trust: true }, { name: 'web', dir: '/opt/web', trust: false }],
    mailStart: true, max: 2,
  };
  expect(put.json()).toEqual({ workers: expected });
  expect((await route('GET', `/api/boxes/${orders.id}/workers`)).json()).toEqual({ workers: expected, mail: false });
  expect(await workerStore.get(orders.id)).toEqual(expected);
  // the other box is untouched
  expect((await route('GET', `/api/boxes/${billing.id}/workers`)).json().workers.projects).toEqual([]);
});

test('PUT with a rule failure is 400 with the rule\'s message and stores nothing', async () => {
  const { orders } = await boot();
  const bad = await route('PUT', `/api/boxes/${orders.id}/workers`, { payload: { projects: [{ name: 'api', dir: '/opt/../x' }] } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json()).toEqual({ error: 'bad directory for project api' });
  expect(await workerStore.all()).toEqual({});
  expect((await route('PUT', `/api/boxes/${orders.id}/workers`, { payload: { max: 9 } })).json()).toEqual({ error: 'max must be 1 to 8' });
  for (const payload of [[], ['x'], 'text', 7]) {
    const r = await route('PUT', `/api/boxes/${orders.id}/workers`, { payload: JSON.stringify(payload), headers: { ...browser, 'content-type': 'application/json' } });
    expect(r.statusCode, JSON.stringify(payload)).toBe(400);
  }
  expect(await workerStore.all()).toEqual({});
});

test('start runs the real starter on the box, answers the session and re-probes the box', async () => {
  const { orders } = await boot();
  await workerStore.set(orders.id, { projects: [{ name: 'api', dir: projectDir('api') }, { name: 'web', dir: projectDir('web') }] });
  const first = await route('POST', `/api/boxes/${orders.id}/workers/start`, { payload: {} });
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ ok: true, session: 'worker-api-1' });
  expect(hasSession('worker-api-1')).toBe(true);
  expect(probes).toEqual([orders.id]);
  // A named project, and a probe that throws does not turn a start that happened into an error.
  probeThrows = true;
  const web = await route('POST', `/api/boxes/${orders.id}/workers/start`, { payload: { project: 'web' } });
  expect(web.statusCode).toBe(200);
  expect(web.json()).toEqual({ ok: true, session: 'worker-web-1' });
  expect(hasSession('worker-web-1')).toBe(true);
  expect(probes).toEqual([orders.id, orders.id]);
});

// A start also records the box's agents into the health history, which is what the agent rows
// read: without it the started worker's row is missing until the watch stream nudges a light
// probe or the next sweep (always the sweep with the watch off or held).
test('start probes and then refreshes the agents, each once, after the start', async () => {
  const { orders } = await boot();
  await workerStore.set(orders.id, { projects: [{ name: 'api', dir: projectDir('api') }] });
  const res = await route('POST', `/api/boxes/${orders.id}/workers/start`, { payload: {} });
  expect(res.json()).toEqual({ ok: true, session: 'worker-api-1' });
  expect(polls).toEqual([['probeOne', orders.id], ['refreshAgents', orders.id]]);
});

test('start still answers its session when the refresh resolves false, throws synchronously or rejects, or is not there', async () => {
  const { orders } = await boot();
  await workerStore.set(orders.id, { projects: [{ name: 'api', dir: projectDir('api') }], max: 8 });
  const variants = [() => false, () => { throw new Error('sync boom'); }, () => Promise.reject(new Error('rejected'))];
  for (const [i, impl] of variants.entries()) {
    refreshImpl = impl;
    refreshes = [];
    const res = await route('POST', `/api/boxes/${orders.id}/workers/start`, { payload: {} });
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true, session: `worker-api-${i + 1}` }]);
    expect(refreshes).toEqual([orders.id]);
  }
  await app.close(); app = null;
  await fs.rm(dir, { recursive: true, force: true });
  const again = await boot({ refreshAgents: false });
  // Another project: the bench's tmux server still holds the first boot's workers.
  await workerStore.set(again.orders.id, { projects: [{ name: 'web', dir: projectDir('web') }] });
  probes = [];
  const res = await route('POST', `/api/boxes/${again.orders.id}/workers/start`, { payload: {} });
  expect([res.statusCode, res.json()]).toEqual([200, { ok: true, session: 'worker-web-1' }]);
  expect(probes).toEqual([again.orders.id]);
});

test('start ignores mailStart: the operator\'s start is not a mail start', async () => {
  const { orders } = await boot();
  await workerStore.set(orders.id, { projects: [{ name: 'api', dir: projectDir('api') }], mailStart: false });
  const res = await route('POST', `/api/boxes/${orders.id}/workers/start`, { payload: { project: 'api' } });
  expect(res.json()).toEqual({ ok: true, session: 'worker-api-1' });
});

test('a project that is not a project name is 400 before anything runs', async () => {
  const { orders } = await boot();
  await workerStore.set(orders.id, { projects: [{ name: 'api', dir: projectDir('api') }] });
  let ran = 0;
  execOverride = async () => { ran++; return { code: 0, stdout: 'WORKER: started\n', stderr: '' }; };
  for (const project of ['API', '../x', 'a'.repeat(25), '', null, 3, ['api']]) {
    const res = await route('POST', `/api/boxes/${orders.id}/workers/start`, { payload: { project } });
    expect(res.statusCode, JSON.stringify(project)).toBe(400);
    expect(res.json().error).toBe('project must be a project name');
  }
  for (const payload of [[], 'text']) {
    const r = await route('POST', `/api/boxes/${orders.id}/workers/start`, { payload: JSON.stringify(payload), headers: { ...browser, 'content-type': 'application/json' } });
    expect(r.statusCode, JSON.stringify(payload)).toBe(400);
  }
  expect(ran).toBe(0);
  expect(probes).toEqual([]);
  expect(refreshes).toEqual([]);
});

test('every start failure answers its status, the operator\'s wording and the code', async () => {
  const { orders, billing } = await boot();
  const start = (id, payload = {}) => route('POST', `/api/boxes/${id}/workers/start`, { payload });
  const expectFail = async (res, status, code, error) => {
    expect(res.statusCode, code).toBe(status);
    expect(res.json(), code).toEqual({ error, code });
  };
  await workerStore.set(orders.id, { projects: [{ name: 'api', dir: projectDir('api') }, { name: 'gone', dir: path.join(bench.home, 'gone') }], max: 1 });

  // no-project: a box with no projects, and a project name the record does not hold.
  await expectFail(await start(billing.id), 400, 'no-project', 'no such project');
  await expectFail(await start(orders.id, { project: 'nope' }), 400, 'no-project', 'no such project');

  setupJobs.set(orders.id, { status: 'running' });
  await expectFail(await start(orders.id), 409, 'setup-running', 'box setup is still running');
  setupJobs.clear();

  snapshot[orders.id] = { reachable: false, sessions: [] };
  await expectFail(await start(orders.id), 502, 'unreachable', 'box is unreachable');
  delete snapshot[orders.id];
  await expectFail(await start(orders.id), 502, 'unreachable', 'box is unreachable');

  snapshot[orders.id] = {
    reachable: true,
    sessions: [{ name: 'worker-api-1', paneCmd: 'claude' }],
    panes: [{ session: 'worker-api-1', windowId: '@1', pane: '%1', index: 0, active: true, zoomed: false, cmd: 'claude' }],
  };
  await expectFail(await start(orders.id), 409, 'worker-cap', 'this box already runs as many started agents as its limit allows');
  snapshot[orders.id] = { reachable: true, sessions: [] };

  await expectFail(await start(orders.id, { project: 'gone' }), 502, 'no-dir', 'the project directory does not exist on the box');

  rmSync(path.join(bench.home, '.local', 'bin', 'claude'));
  await expectFail(await start(orders.id), 502, 'no-agent-binary', 'Claude Code is not installed on the box');

  // The bench always has tmux (its pinned wrapper leads every PATH), so a box without one is
  // the script's own answer, given here by the transport.
  execOverride = async () => ({ code: 0, stdout: 'WORKER: no-tmux\n', stderr: '' });
  await expectFail(await start(orders.id), 502, 'no-tmux', 'tmux is not installed on the box');
  execOverride = async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host 192.168.1.10 port 22: Connection refused' });
  await expectFail(await start(orders.id), 502, 'start-failed', 'starting the agent failed');

  expect(probes).toEqual([]);
  expect(refreshes).toEqual([]);
});

test('a code the route has no wording for (bad-mode, or one added later) is 502 starting the agent failed', async () => {
  for (const code of ['bad-mode', 'something-new']) {
    const { orders } = await boot({ starter: { start: async () => ({ ok: false, code }) } });
    const res = await route('POST', `/api/boxes/${orders.id}/workers/start`, { payload: {} });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'starting the agent failed', code });
    await app.close(); app = null;
    await fs.rm(dir, { recursive: true, force: true });
  }
  // every code the starter can answer is one the tests above or here map
  expect([...START_CODES].sort()).toEqual(['bad-mode', 'no-agent-binary', 'no-dir', 'no-project', 'no-tmux', 'setup-running', 'start-failed', 'unreachable', 'worker-cap']);
});

test('every worker route: 401 anonymous, 403 for a device token, 404 for an unknown box, 503 when not built', async () => {
  const { orders } = await boot();
  await workerStore.set(orders.id, { projects: [{ name: 'api', dir: projectDir('api') }] });
  for (const [m, url] of ROUTES(orders.id)) {
    expect((await app.inject({ method: m, url, payload: bodyFor(m) })).statusCode, `${m} ${url} anon`).toBe(401);
    const dev = await app.inject({ method: m, url, headers: bearer, payload: bodyFor(m) });
    expect(dev.statusCode, `${m} ${url} device`).toBe(403);
    expect(dev.json()).toEqual({ error: 'browser session required' });
  }
  // the device PUT wrote nothing and the device start started nothing
  expect((await workerStore.get(orders.id)).projects).toHaveLength(1);
  expect(hasSession('worker-api-1')).toBe(false);
  for (const [m, url] of ROUTES('nope')) {
    const res = await route(m, url, { payload: bodyFor(m) });
    expect(res.statusCode, `${m} ${url}`).toBe(404);
    expect(res.json()).toEqual({ error: 'box not found' });
  }
  await app.close(); app = null;
  await fs.rm(dir, { recursive: true, force: true });
  const { orders: o2 } = await boot({ withWorkers: false });
  for (const [m, url] of ROUTES(o2.id)) {
    const res = await route(m, url, { payload: bodyFor(m) });
    expect(res.statusCode, `${m} ${url} not built`).toBe(503);
    expect(res.json()).toEqual({ error: 'agent workers are unavailable' });
  }
});

test('none of the worker routes is in DEVICE_ALLOWED_ROUTES', async () => {
  const src = await fs.readFile(new URL('../src/server/server.js', import.meta.url), 'utf8');
  const m = /const DEVICE_ALLOWED_ROUTES = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\);/.exec(src);
  expect(m).not.toBeNull();
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  expect(entries.length).toBeGreaterThan(10);
  expect(entries.filter((e) => e.includes('workers'))).toEqual([]);
});

test('removing a box drops its worker record', async () => {
  const { orders, billing } = await boot();
  await workerStore.set(orders.id, { projects: [{ name: 'api', dir: '/opt/billing-api' }], max: 2 });
  await workerStore.set(billing.id, { projects: [{ name: 'web', dir: '/opt/web' }] });
  expect((await route('DELETE', `/api/boxes/${orders.id}`)).statusCode).toBe(200);
  expect(Object.keys(await workerStore.all())).toEqual([billing.id]);
  // ...and so does the file: a fresh store over the same directory reads the same.
  expect(Object.keys(await createAgentWorkerStore({ dataDir: dir }).all())).toEqual([billing.id]);
});
