import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createLocalShellActions } from '../src/server/localShellActions.js';
import { hashPassword } from '../src/server/auth.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';

let app, dir, scripts, runResult, gate;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-lsp-route-'));
  scripts = [];
  gate = null;
  runResult = { code: 0, stdout: '80 24 0 0 0 0 0 %2\nhost\nshell\n', stderr: '' };
  // The REAL createLocalShellActions over a fake `run` seam that records scripts.
  const run = async (script) => {
    scripts.push(script);
    if (gate) await gate;
    return runResult;
  };
  const localShellActions = createLocalShellActions({ run, cwd: dir, env: {} });
  const boxActions = createBoxActions({ run: async () => ({ code: 0, stdout: '', stderr: '' }), hostKeyPolicy: 'accept-new', controlDir: dir });
  const store = createStore({ dataDir: dir });
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  // The Host Shell's own series, keyed by pane: %2 is the session's active pane,
  // %4 an agent in its other window, %3 a pane of another session (which the
  // poller's narrowing keeps out of the real series; here it is the proof that
  // the route refuses it anyway).
  const history = {
    getSeries: (id) => (id === '__local__'
      ? [{ t: 1, up: true, agents: Object.assign(Object.create(null), {
        '%1': { session: 'local', windowId: '@0', focused: false, state: 'blocked', cause: 'question', ts: 100 },
        '%2': { session: 'local', windowId: '@0', focused: true, state: 'done', cause: 'stop', ts: 200 },
        '%3': { session: 'other', windowId: '@7', focused: true, state: 'blocked', cause: 'permission', ts: 300 },
        '%4': { session: 'local', windowId: '@1', focused: false, state: 'working', cause: 'prompt', ts: 400 },
        '%5': { session: 'local', windowId: '@1', focused: false },
        '%6': { session: 'my work', windowId: '@1', focused: false, state: 'working', ts: 500 },
        '%7': { session: 'local', windowId: '@x', focused: false, state: 'working', ts: 600 },
      }) }]
      : []),
    getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {},
  };
  app = buildServer({
    config, store, sessions, statusChecker, boxActions, history, localShellActions,
    deviceStore: createDeviceStore({ dataDir: dir }), passkeyStore: createPasskeyStore({ dataDir: dir }),
  });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

async function bearer() {
  const res = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'MCP' } });
  return { authorization: `Bearer ${res.json().token}` };
}

test('a browser session gets the Host Shell snapshot with the state of the pane the capture read', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane?lines=40', headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, width: 80, height: 24, cursorX: 0, cursorY: 0, alt: false, mouse: false,
    content: 'host\nshell', pane: '%2', agent: 'done', agentCause: 'stop', agentTs: 200, sessionName: 'local' });
  expect(scripts.at(-1)).toContain("capture-pane -e -p -t '=local:' -S -40");
});

test('a session query parameter is ignored: only the local session is ever captured', async () => {
  await app.inject({ method: 'GET', url: '/api/local-shell/pane?session=other', headers: await headers() });
  expect(scripts.at(-1)).toContain("-t '=local:'");
  expect(scripts.at(-1)).not.toContain('other');
});

test('a device token is refused and nothing runs', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane', headers: await bearer() });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'browser session required' });
  expect(scripts.length).toBe(0);
});

test('no credentials is 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane' });
  expect(res.statusCode).toBe(401);
  expect(scripts.length).toBe(0);
});

test('a failed capture is 502 and creates nothing', async () => {
  runResult = { code: 1, stdout: '', stderr: "can't find session: local" };
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane', headers: await headers() });
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ error: "can't find session: local" });
  expect(scripts.every((s) => !/new-session|has-session/.test(s))).toBe(true);
});

test('concurrent captures share one run', async () => {
  let release;
  gate = new Promise((r) => { release = r; });
  const h = await headers();
  const a = app.inject({ method: 'GET', url: '/api/local-shell/pane?lines=40', headers: h });
  const b = app.inject({ method: 'GET', url: '/api/local-shell/pane?lines=40', headers: h });
  await expect.poll(() => scripts.length).toBe(1);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(ra.statusCode).toBe(200);
  expect(rb.statusCode).toBe(200);
  expect(scripts.length).toBe(1);
});

test('503 when the capture action is not wired', async () => {
  const bare = buildServer({
    config: { bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
      passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir, localShell: 'none', configPath: path.join(dir, 'config.json') },
    store: createStore({ dataDir: dir }),
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    boxActions: {}, history: { getSeries: () => [], getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {} },
  });
  const login = await bare.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  const res = await bare.inject({ method: 'GET', url: '/api/local-shell/pane', headers: { cookie: `${c.name}=${c.value}` } });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ error: 'capture unavailable' });
});

// Without `pane` the capture is the session's active pane, which moves: the
// state is that of the pane the capture itself names.
test('the default capture reports the state of the pane it read, whichever pane that is', async () => {
  runResult = { code: 0, stdout: '80 24 0 0 0 0 0 %4\nrow\n', stderr: '' };
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane', headers: await headers() });
  expect(res.json()).toMatchObject({ pane: '%4', agent: 'working', agentCause: 'prompt', agentTs: 400, sessionName: 'local' });
});

test('the default capture reads as no state for a pane with no entry, no marker timestamp, or no id from an old tmux', async () => {
  const get = async () => (await app.inject({ method: 'GET', url: '/api/local-shell/pane', headers: await headers() })).json();
  runResult = { code: 0, stdout: '80 24 0 0 0 0 0 %9\nrow\n', stderr: '' };   // a pane the series does not know
  expect(await get()).toMatchObject({ pane: '%9', agent: null, agentCause: null });
  expect(await get()).not.toHaveProperty('agentTs');
  runResult = { code: 0, stdout: '80 24 0 0 0 0 0 %5\nrow\n', stderr: '' };   // an entry with no state and no ts
  const quiet = await get();
  expect(quiet).toMatchObject({ pane: '%5', agent: null, agentCause: null });
  expect(quiet).not.toHaveProperty('agentTs');
  runResult = { code: 0, stdout: '80 24 0 0 0 0 0\nrow\n', stderr: '' };       // an old tmux that cannot name the pane
  const old = await get();
  expect(old).toMatchObject({ agent: null, agentCause: null, sessionName: 'local' });
  expect(old).not.toHaveProperty('pane');
  expect(old).not.toHaveProperty('agentTs');
});

// `pane=%254` is `%4` URL-decoded.
test('?pane= captures that pane exactly, from the server\'s own sample, and answers with its state', async () => {
  runResult = { code: 0, stdout: '80 24 1 2 0 0 0 %4\nagent row\n', stderr: '' };
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane?pane=%254&lines=40', headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, width: 80, height: 24, cursorX: 1, cursorY: 2, alt: false, mouse: false,
    content: 'agent row', pane: '%4', agent: 'working', agentCause: 'prompt', agentTs: 400, sessionName: 'local' });
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain("display-message -p -t '=local:@1.%4'");
  expect(scripts[0]).toContain("capture-pane -e -p -t '=local:@1.%4' -S -40");
  // Read-only: nothing is focused, nothing is created.
  expect(scripts[0]).not.toMatch(/select-|new-session|has-session/);
});

test('?pane= with an id the client made up, a pane of another session or an unknown one is refused and nothing runs', async () => {
  const h = await headers();
  for (const [url, status, error] of [
    ['pane=%2599', 404, 'no such agent pane'],                     // not in the Host Shell's series
    ['pane=%253', 404, 'no such agent pane'],                      // a pane of another session
    ['pane=%256', 404, 'no such agent pane'],                      // a session that is not the Host Shell's
    ['pane=%257', 400, 'session name must be letters, digits, _ or -'], // a window id no exact target can name
    ['pane=', 400, 'pane id must look like %12'],
    ['pane=4', 400, 'pane id must look like %12'],
    ['pane=%254;id', 400, 'pane id must look like %12'],
    ['pane=%25', 400, 'pane id must look like %12'],
    ['pane=%254&pane=%252', 400, 'pane id must look like %12'],    // repeated: an array, never read as one id
  ]) {
    const res = await app.inject({ method: 'GET', url: `/api/local-shell/pane?${url}`, headers: h });
    expect([res.statusCode, res.json()], url).toEqual([status, { error }]);
  }
  expect(scripts).toEqual([]);
});

test('?pane= ignores a session query: the local session is the only one ever captured', async () => {
  runResult = { code: 0, stdout: '80 24 0 0 0 0 0 %4\nx\n', stderr: '' };
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane?pane=%254&session=other', headers: await headers() });
  expect(res.json()).toMatchObject({ pane: '%4', sessionName: 'local' });
  expect(scripts[0]).toContain("'=local:@1.%4'");
  expect(scripts[0]).not.toContain('other');
});

test('?pane= for a device token is 403 and nothing runs', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane?pane=%254', headers: await bearer() });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'browser session required' });
  expect(scripts).toEqual([]);
});

test('?pane= answers 404 when there is no history to name the pane', async () => {
  const bare = buildServer({
    config: { bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
      passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir, localShell: 'none', configPath: path.join(dir, 'config.json') },
    store: createStore({ dataDir: dir }),
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    boxActions: {}, localShellActions: createLocalShellActions({ run: async (s) => { scripts.push(s); return runResult; }, cwd: dir, env: {} }),
  });
  const login = await bare.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  const res = await bare.inject({ method: 'GET', url: '/api/local-shell/pane?pane=%254', headers: { cookie: `${c.name}=${c.value}` } });
  expect(res.statusCode).toBe(404);
  expect(scripts).toEqual([]);
});

test('?pane= for a pane that has gone is 502 with tmux\'s words', async () => {
  runResult = { code: 1, stdout: '', stderr: "can't find pane: %4" };
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane?pane=%254', headers: await headers() });
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ error: "can't find pane: %4" });
});

// ---- POST /api/local-shell/window --------------------------------------------

const post = async (payload, h) => app.inject({ method: 'POST', url: '/api/local-shell/window', headers: h ?? await headers(), payload });

test('POST /api/local-shell/window selects the window then focuses the pane of the local session', async () => {
  const res = await post({ windowId: '@1', paneId: '%4' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@1', paneId: '%4' });
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain("select-window -t '=local:@1'");
  expect(scripts[0]).toContain("select-pane -Z -t '=local:@1.%4'");
  expect(scripts[0]).not.toMatch(/new-session|has-session/);
});

test('POST /api/local-shell/window with no pane is the window-only select', async () => {
  const res = await post({ windowId: '@3' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@3' });
  expect(scripts[0]).toContain("select-window -t '=local:@3'");
  expect(scripts[0]).not.toContain('select-pane');
});

test('POST /api/local-shell/window ignores a session in the body: only the local session is ever targeted', async () => {
  const res = await post({ windowId: '@1', session: 'other' });
  expect(res.statusCode).toBe(200);
  expect(scripts[0]).toContain("'=local:@1'");
  expect(scripts[0]).not.toContain('other');
});

test('POST /api/local-shell/window refuses bad ids with 400 and runs nothing', async () => {
  const h = await headers();
  for (const [payload, error] of [
    [{}, 'window id must look like @7'],
    [undefined, 'window id must look like @7'],
    [{ windowId: '7' }, 'window id must look like @7'],
    [{ windowId: 7 }, 'window id must look like @7'],
    [{ windowId: "@1'; id" }, 'window id must look like @7'],
    [{ paneId: '%4' }, 'window id must look like @7'],
    [{ windowId: '@1', paneId: '4' }, 'pane id must look like %12'],
    [{ windowId: '@1', paneId: null }, 'pane id must look like %12'],
    [{ windowId: '@1', paneId: 4 }, 'pane id must look like %12'],
    [{ windowId: '@1', paneId: '%4;id' }, 'pane id must look like %12'],
  ]) {
    const res = await post(payload, h);
    expect([res.statusCode, res.json()], JSON.stringify(payload)).toEqual([400, { error }]);
  }
  expect(scripts).toEqual([]);
});

test('POST /api/local-shell/window is browser-only: it is not a device route, and a device token is 403 with nothing run', async () => {
  const src = await fs.readFile(new URL('../src/server/server.js', import.meta.url), 'utf8');
  const m = /const DEVICE_ALLOWED_ROUTES = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\);/.exec(src);
  expect(m).not.toBeNull();
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  expect(entries.length).toBeGreaterThan(10);
  expect(entries.filter((e) => e.includes('local-shell'))).toEqual([]);
  const res = await post({ windowId: '@1', paneId: '%4' }, await bearer());
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'browser session required' });
  expect(scripts).toEqual([]);
});

test('POST /api/local-shell/window with no credentials is 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/local-shell/window', payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(401);
  expect(scripts).toEqual([]);
});

test('POST /api/local-shell/window is 502 with tmux\'s words when the command fails, and creates nothing', async () => {
  runResult = { code: 1, stdout: '', stderr: "can't find pane: %4\n" };
  const res = await post({ windowId: '@1', paneId: '%4' });
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ error: "can't find pane: %4" });
  expect(scripts.every((s) => !/new-session/.test(s))).toBe(true);
  runResult = { code: 1, stdout: '', stderr: '' };
  expect((await post({ windowId: '@1' })).json()).toEqual({ error: 'failed to select window' });
});

test('POST /api/local-shell/window is 503 when the action is not wired', async () => {
  const bare = buildServer({
    config: { bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
      passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir, localShell: 'none', configPath: path.join(dir, 'config.json') },
    store: createStore({ dataDir: dir }),
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    boxActions: {}, history: { getSeries: () => [], getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {} },
  });
  const login = await bare.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  const res = await bare.inject({ method: 'POST', url: '/api/local-shell/window', headers: { cookie: `${c.name}=${c.value}` }, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ error: 'window switching unavailable' });
});
