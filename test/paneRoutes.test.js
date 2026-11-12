import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';

let gate = null;
let app, dir, calls, boxId, failNext, noMouseNext, captureOut, sizedCalls, setupRunning;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pane-'));
  calls = [];
  // Tests flip this to exercise the routes' 502 mapping — consumed by the very
  // next call so a test can fail exactly one ssh round trip.
  failNext = false;
  gate = null;
  // The wheel script's own box-side refusal (exit 93): pane not mouse-aware.
  noMouseNext = false;
  captureOut = '80 24 3 10 0 0 0\nhello\nworld\n';
  // Real createBoxActions over a fake ssh transport (the run seam) — the argv
  // building, quoting, and parsing under test are the real code.
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'boom' }; }
    if (noMouseNext) { noMouseNext = false; return { code: 93, stdout: '', stderr: '' }; }
    const remote = argv[argv.length - 1];
    if (remote.includes('capture-pane')) {
      // The screen is read when the capture STARTS, as tmux does: a capture
      // held at the gate still returns what was on screen before it.
      const out = captureOut;
      if (gate) await gate;
      return { code: 0, stdout: out, stderr: '' };
    }
    if (remote.includes('send-keys')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const boxActions = createBoxActions({ run, runStdin: run, hostKeyPolicy: 'accept-new', controlDir: dir });
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ label: 'b1', host: '192.168.1.10', user: 'u', sessionName: 'main' });
  boxId = box.id;
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  sizedCalls = [];
  setupRunning = false;
  const sessions = {
    open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
    ensureSizedViewer(args) { sizedCalls.push(args); return {}; },
  };
  const setupManager = { currentForBox: () => (setupRunning ? { status: 'running' } : null) };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const history = { getSeries: () => [{ t: 1, up: true, agent: 'waiting', agents: { main: { cause: 'permission' }, side: { state: 'blocked', cause: 'question' } } }], getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {} };
  app = buildServer({
    config, store, sessions, statusChecker, boxActions, history, setupManager,
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

test('GET pane returns parsed snapshot plus agent state', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane`, headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    ok: true, width: 80, height: 24, cursorX: 3, cursorY: 10, alt: false, mouse: false,
    content: 'hello\nworld', agent: 'waiting', agentCause: 'permission', sessionName: 'main',
  });
});

test('GET pane on an alt-screen pane ships only the visible screen, flagged alt/mouse', async () => {
  captureOut = '80 2 0 1 1 1 1\nstale-shell-1\nstale-shell-2\nclaude-1\nclaude-2\n';
  const h = await headers();
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane`, headers: h });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.alt).toBe(true);
  expect(body.mouse).toBe(true);
  expect(body.content).toBe('claude-1\nclaude-2');
});

test('GET pane with viewer geometry ensures the sizing client after a good capture', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?cols=48&rows=90&client=dev1`, headers: h });
  expect(res.statusCode).toBe(200);
  expect(sizedCalls.length).toBe(1);
  expect(sizedCalls[0]).toMatchObject({ clientId: 'dev1', cols: 48, rows: 90 });
  expect(sizedCalls[0].box?.id).toBe(boxId);
});

test('GET pane geometry is best-effort and validated: bad, partial, or out-of-range never sizes', async () => {
  const h = await headers();
  for (const q of ['cols=48', 'rows=90', 'cols=abc&rows=90&client=c', 'cols=48.5&rows=90&client=c', 'cols=10&rows=90&client=c', 'cols=48&rows=999&client=c', 'cols=48&rows=90']) {
    const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?${q}`, headers: h });
    expect(res.statusCode).toBe(200);
  }
  expect(sizedCalls.length).toBe(0);
});

test('GET pane geometry is not applied while the box is mid-setup or after a failed capture', async () => {
  const h = await headers();
  setupRunning = true;
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?cols=48&rows=90&client=c`, headers: h })).statusCode).toBe(200);
  setupRunning = false;
  failNext = true;
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?cols=48&rows=90&client=c`, headers: h })).statusCode).toBe(502);
  expect(sizedCalls.length).toBe(0);
});

test('POST keys: wheel sends gated SGR wheel reports to the pane', async () => {
  const h = await headers();
  const up = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { wheel: 'up', steps: 5 } });
  expect(up.statusCode).toBe(200);
  const remote = calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes('[<64;'));
  expect(remote).toContain('exit 93');
  expect(remote).toContain('-lt 5');
  expect(remote).toContain("send-keys -t '=main:' -l --");
  const down = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { wheel: 'down' } });
  expect(down.statusCode).toBe(200);
  expect(calls.map((argv) => argv[argv.length - 1]).some((r) => r.includes('[<65;'))).toBe(true);
});

test('POST keys: wheel validates direction, steps and exclusivity', async () => {
  const h = await headers();
  const bad = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { wheel: 'sideways' } });
  expect(bad.statusCode).toBe(400);
  const badSteps = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { wheel: 'up', steps: 999 } });
  expect(badSteps.statusCode).toBe(400);
  const fracSteps = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { wheel: 'up', steps: 1.5 } });
  expect(fracSteps.statusCode).toBe(400);
  const withText = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { wheel: 'up', text: 'x' } });
  expect(withText.statusCode).toBe(400);
  const withKey = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { wheel: 'up', key: 'Enter' } });
  expect(withKey.statusCode).toBe(400);
});

test('POST keys: a pane refusing mouse input is 409, not 502', async () => {
  const h = await headers();
  noMouseNext = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { wheel: 'up' } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/mouse/);
});

test('POST keys: named key goes unquoted from the allowlist, text goes literal and sanitized', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { key: 'Enter' } })).statusCode).toBe(200);
  // sess() produces a sanitized, colon-suffixed target ('=main:', not '=main').
  expect(calls.some((argv) => argv[argv.length - 1] === "tmux send-keys -t '=main:' Enter")).toBe(true);
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'hi\nthere' } })).statusCode).toBe(200);
  expect(calls.some((argv) => argv[argv.length - 1] === "tmux send-keys -t '=main:' -l -- 'hi there'")).toBe(true);
});

test('POST keys validates: exactly one of text/key, allowlisted key, bounded text', async () => {
  const h = await headers();
  const both = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'x', key: 'Enter' } });
  expect(both.statusCode).toBe(400);
  const neither = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: {} });
  expect(neither.statusCode).toBe(400);
  const badKey = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { key: 'C-d' } });
  expect(badKey.statusCode).toBe(400);
  const huge = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'x'.repeat(65537) } });
  expect(huge.statusCode).toBe(400);
});

test('both routes 404 an unknown box and 401 without auth', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'GET', url: '/api/boxes/nope/pane', headers: h })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane` })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, payload: { key: 'Enter' } })).statusCode).toBe(401);
});

test('POST keys 404s an unknown box too, not just GET pane', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/keys', headers: h, payload: { key: 'Enter' } });
  expect(res.statusCode).toBe(404);
});

test('GET pane maps a transport failure to 502 with an error body', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane`, headers: h });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toBe('boom');
});

test('POST keys maps a transport failure to 502 with an error body', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'x' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toBe('boom');
});

test('POST keys with whitespace-only text is a no-op: 200 skipped, no send-keys reaches the box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: '   \r\n  ' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, skipped: 'empty' });
  // The guard that prevents a bare `send-keys -l --` from reaching the box:
  // sanitizeSendText ate the whole payload, so no ssh round trip should have
  // been made at all.
  expect(calls.some((argv) => argv[argv.length - 1].includes('send-keys'))).toBe(false);
  expect(calls.length).toBe(0);
});

test('GET pane with session captures that session and reports its agent state', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=side&lines=40`, headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ content: 'hello\nworld', agent: 'blocked', agentCause: 'question', sessionName: 'side' });
  const remote = calls.at(-1).at(-1);
  expect(remote).toContain("capture-pane -e -p -t '=side:' -S -40");
});

test('GET pane with session: a session with no agent entry reports null state', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=other`, headers: await headers() });
  expect(res.json()).toMatchObject({ agent: null, agentCause: null, sessionName: 'other' });
});

test('GET pane with an invalid session is 400 and never reaches ssh', async () => {
  const h = await headers();
  for (const s of ['bad name', 'a;b', '', 'x'.repeat(65)]) {
    const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=${encodeURIComponent(s)}`, headers: h });
    expect(res.statusCode, s).toBe(400);
  }
  const twice = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=a&session=b`, headers: h });
  expect(twice.statusCode).toBe(400);
  expect(calls.length).toBe(0);
});

test('GET pane with session from a device token is 403; without session it still works', async () => {
  const b = await bearer();
  const refused = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=main`, headers: b });
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).toEqual({ error: 'browser session required' });
  expect(calls.length).toBe(0);
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane`, headers: b })).statusCode).toBe(200);
});

test('GET pane with session ignores cols/rows: the switcher never sizes anything', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=side&cols=48&rows=90&client=c`, headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(sizedCalls.length).toBe(0);
});

test('GET pane with session stays ungated while the box setup job runs', async () => {
  setupRunning = true;
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=side`, headers: await headers() });
  expect(res.statusCode).toBe(200);
});

test('concurrent captures of one box and session share one ssh', async () => {
  const h = await headers();
  let open; gate = new Promise((r) => { open = r; });
  const url = `/api/boxes/${boxId}/pane?session=side&lines=40`;
  const both = Promise.all([app.inject({ method: 'GET', url, headers: h }), app.inject({ method: 'GET', url, headers: h })]);
  await new Promise((r) => setTimeout(r, 50));
  expect(calls.filter((a) => a.at(-1).includes('capture-pane')).length).toBe(1);
  open();
  expect((await both).map((r) => r.statusCode)).toEqual([200, 200]);
});

test('captures of two sessions on one box are not coalesced', async () => {
  const h = await headers();
  let open; gate = new Promise((r) => { open = r; });
  const get = (s) => app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=${s}&lines=40`, headers: h });
  const both = Promise.all([get('side'), get('main')]);
  await new Promise((r) => setTimeout(r, 50));
  expect(calls.filter((a) => a.at(-1).includes('capture-pane')).length).toBe(2);
  open();
  expect((await both).map((r) => r.statusCode)).toEqual([200, 200]);
});

// Issue #9 item 3. The single flight is for the browser preview only. A device
// read (the Android app, MCP read_pane) that joined a capture already in flight
// could get a screen from before the keys it had just sent.
test('a device read after send-keys runs its own capture instead of joining one in flight', async () => {
  const app1 = await bearer();
  const mcp = await bearer();
  const captures = () => calls.filter((a) => a.at(-1).includes('capture-pane')).length;
  const url = `/api/boxes/${boxId}/pane`;
  let open; gate = new Promise((r) => { open = r; });
  const early = app.inject({ method: 'GET', url, headers: app1 }); // the app's poll, held mid-capture
  await new Promise((r) => setTimeout(r, 50));
  expect(captures()).toBe(1);
  gate = null; // only the early capture stays held

  const sent = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: mcp, payload: { text: 'typed' } });
  expect(sent.statusCode).toBe(200);
  captureOut = '80 24 3 10 0 0 0\ntyped\n'; // the box's screen now shows the keys
  const late = app.inject({ method: 'GET', url, headers: mcp });
  await new Promise((r) => setTimeout(r, 50));
  expect(captures()).toBe(2);

  open();
  expect((await late).json().content).toBe('typed');
  expect((await early).json().content).toBe('hello\nworld');
});

test('a device read does not join a browser preview of the same session and depth', async () => {
  const h = await headers();
  const b = await bearer();
  let open; gate = new Promise((r) => { open = r; });
  // Same box, same session (the configured `main`), same depth: one key in the single flight.
  const both = Promise.all([
    app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=main&lines=200`, headers: h }),
    app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?lines=200`, headers: b }),
  ]);
  await new Promise((r) => setTimeout(r, 50));
  expect(calls.filter((a) => a.at(-1).includes('capture-pane')).length).toBe(2);
  open();
  expect((await both).map((r) => r.statusCode)).toEqual([200, 200]);
});
