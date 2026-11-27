import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, calls, boxId, failNext, setupRunning, probed, probeThrows, serverArgs;
// The poller's two calls, in the order they happened. Each entry carries how many remote
// scripts had run when it STARTED, so "after the select" is an observed fact, not an inference.
let refreshed, refreshImpl, probeGate, order;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-win-'));
  calls = [];
  failNext = false;
  probed = [];
  probeThrows = false;
  refreshed = [];
  refreshImpl = null;
  probeGate = null;
  order = [];
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'no such window' }; }
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
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  setupRunning = false;
  const setupManager = { currentForBox: () => (setupRunning ? { status: 'running' } : null) };
  // Shaped like the real poller's probeOne (statusPoller.js): probes one box and
  // swaps that box's entry into the cached snapshot /api/status serves.
  // refreshAgents is its light probe: it patches the snapshot and records the box's agents
  // into the health history, which is where the browser reads per-pane agent state.
  const statusPoller = {
    getSnapshot: () => ({}),
    probeOne: async (id) => {
      probed.push(id);
      order.push({ call: 'probeOne', id, scriptsSoFar: calls.length });
      if (probeGate) await probeGate;
      if (probeThrows) throw new Error('probe blew up');
      return { reachable: true };
    },
    refreshAgents: async (id) => {
      refreshed.push(id);
      order.push({ call: 'refreshAgents', id, scriptsSoFar: calls.length });
      return refreshImpl ? refreshImpl(id) : true;
    },
  };
  serverArgs = { config, store, sessions, statusChecker, statusPoller, boxActions, setupManager };
  app = buildServer(serverArgs);
});

const winUrl = () => '/api/boxes/' + boxId + '/window';

async function headers(target = app) {
  const res = await target.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('POST window selects the window by a SESSION-QUALIFIED, exact-match target', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { session: 'web', windowId: '@7' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@7' });
  const remote = calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes('select-window'));
  // Both halves are load-bearing. The session, because a grouped session shares
  // its window objects and a bare `-t '@7'` then steers whichever of them tmux
  // resolves first (verified on tmux 3.5a: it moved the clone and exited 0).
  // The '=', because a bare session target prefix-matches when no exact match
  // exists, so a vanished 'web' would silently steer 'web2'.
  expect(remote).toContain("select-window -t '=web:@7'");
});

test('POST window rejects anything that is not a tmux window id, without touching ssh', async () => {
  const h = await headers();
  // The id becomes a tmux target, so it is re-validated here rather than
  // trusted from the client that read it out of a status snapshot.
  for (const windowId of ['', '7', 'web:1', '@1;rm -rf /', "@1'", '@' + '9'.repeat(10), 42, null, undefined]) {
    const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { session: 'web', windowId } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST window is refused while the box\'s setup job is running', async () => {
  const h = await headers();
  setupRunning = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { session: 'web', windowId: '@1' } });
  expect(res.statusCode).toBe(409);
  expect(calls.length).toBe(0);
});

test('POST window 404s on an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/window', headers: h, payload: { session: 'web', windowId: '@1' } });
  expect(res.statusCode).toBe(404);
});

test('POST window maps a vanished window to 502', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { session: 'web', windowId: '@1' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain('no such window');
});

test('POST window requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, payload: { session: 'web', windowId: '@1' } });
  expect(res.statusCode).toBe(401);
});
// An apostrophe is the shell-quoting hazard worth pinning; spelled by code point
// so the list below stays on one readable line.
const QUOTE = String.fromCharCode(39);

test('POST window requires a session name, and validates it, without touching ssh', async () => {
  const h = await headers();
  // An absent session is a 400 and deliberately NOT a fallback to the bare-id
  // target: that target is ambiguous under grouped sessions, and acting on a
  // target we cannot pin is what this codebase refuses to do elsewhere.
  for (const session of [undefined, '', 'my session', 'web' + QUOTE, 'web:1', 'web.1', 'a'.repeat(65), 42, null]) {
    const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session, windowId: '@1' } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST window re-probes the box so the next /api/status is authoritative', async () => {
  const h = await headers();
  // /api/status serves the poller's cache, which only moves on the poll interval
  // (30s by default). Without this re-probe the client repaints from a snapshot
  // whose `active` flag still names the PREVIOUS window, so the dropdown snaps
  // back within a second and stays wrong until the next sweep.
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2' } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([boxId]);
});

test('POST window still succeeds when the re-probe throws', async () => {
  const h = await headers();
  probeThrows = true;
  // The switch already happened on the box; a failing refresh of our own cache
  // must never turn that into an error the UI would revert.
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@2' });
});

test('POST window works on a deployment with no status poller wired', async () => {
  // statusPoller is optional on buildServer (several suites construct a server
  // without one), so the re-probe is best-effort in that direction too.
  const noPoller = buildServer({ ...serverArgs, statusPoller: undefined });
  const h = await headers(noPoller);
  const res = await noPoller.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@3' } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([]);
});

test('POST window with a paneId runs the pane script and answers both ids', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'main', windowId: '@3', paneId: '%12' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@3', paneId: '%12' });
  const remote = calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes('select-window'));
  expect(remote).toContain("select-window -t '=main:@3'");
  expect(remote).toContain("select-pane -Z -t '=main:@3.%12'");
  expect(probed).toEqual([boxId]);
});

test('POST window rejects a paneId that is not a tmux pane id, without touching ssh', async () => {
  const h = await headers();
  for (const paneId of ['12', '', '%', 'main', '%1;rm -rf /', "%1'", '%' + '9'.repeat(10), '@3', 12, null]) {
    const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'main', windowId: '@3', paneId } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pane id must look like %12' });
  }
  expect(calls.length).toBe(0);
});

test('POST window without a paneId is the window-only script and answer, unchanged', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'main', windowId: '@3' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@3' });
  const remote = calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes('select-window'));
  expect(remote).not.toContain('select-pane');
});

test('POST window with a paneId is refused while the box\'s setup job is running', async () => {
  const h = await headers();
  setupRunning = true;
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'main', windowId: '@3', paneId: '%12' } });
  expect(res.statusCode).toBe(409);
  expect(calls.length).toBe(0);
});

test('POST window maps a pane that left the window to 502 and does not re-probe', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'main', windowId: '@3', paneId: '%12' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain('no such window');
  expect(probed).toEqual([]);
});

// A select also records the box's agents into the health history. probeOne only moves the
// status snapshot (/api/status); the per-pane agent state the browser reads, `visible` and
// `focused` included, comes from the history series. Without this the series keeps naming the
// window the operator just left until the watch stream nudges a light probe or the next sweep
// (always the sweep with TMUXIFIER_AGENT_WATCH=off), and the pane jumped to is not acknowledged.
test('POST window probes and then refreshes the agents, each once, after the select ran', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@2' });
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.some((argv) => argv[argv.length - 1].includes("select-window -t '=web:@2'"))).toBe(true);
  // Both calls started after the one remote script (the select) had run, and in this order.
  expect(order).toEqual([
    { call: 'probeOne', id: boxId, scriptsSoFar: calls.length },
    { call: 'refreshAgents', id: boxId, scriptsSoFar: calls.length },
  ]);
});

test('POST window with a paneId probes and then refreshes the agents, each once, after the select ran', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'main', windowId: '@3', paneId: '%12' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@3', paneId: '%12' });
  expect(calls.some((argv) => argv[argv.length - 1].includes("select-pane -Z -t '=main:@3.%12'"))).toBe(true);
  expect(order).toEqual([
    { call: 'probeOne', id: boxId, scriptsSoFar: calls.length },
    { call: 'refreshAgents', id: boxId, scriptsSoFar: calls.length },
  ]);
});

test('POST window refreshes only after the probe has settled, and answers only after the refresh has', async () => {
  const h = await headers();
  let releaseProbe, releaseRefresh;
  probeGate = new Promise((r) => { releaseProbe = r; });
  refreshImpl = () => new Promise((r) => { releaseRefresh = r; });
  let answered = false;
  const pending = app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2' } })
    .then((r) => { answered = true; return r; });
  await expect.poll(() => probed.length).toBe(1);
  await new Promise((r) => setTimeout(r, 20));
  expect(refreshed).toEqual([]); // probeOne is still out: the refresh waits for it
  releaseProbe();
  await expect.poll(() => refreshed.length).toBe(1);
  await new Promise((r) => setTimeout(r, 20));
  expect(answered).toBe(false); // the refresh is still out: the response waits for it
  releaseRefresh(true);
  const res = await pending;
  expect([res.statusCode, res.json()]).toEqual([200, { ok: true, windowId: '@2' }]);
});

test('POST window still answers ok when the refresh resolves false, throws synchronously or rejects', async () => {
  const h = await headers();
  const variants = [
    () => false,
    () => { throw new Error('sync boom'); },
    async () => { throw new Error('boom'); },
    () => Promise.reject(new Error('rejected')),
  ];
  for (const impl of variants) {
    refreshImpl = impl;
    refreshed = [];
    const win = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2' } });
    expect([win.statusCode, win.json()]).toEqual([200, { ok: true, windowId: '@2' }]);
    expect(refreshed).toEqual([boxId]);
    refreshed = [];
    const pane = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'main', windowId: '@3', paneId: '%12' } });
    expect([pane.statusCode, pane.json()]).toEqual([200, { ok: true, windowId: '@3', paneId: '%12' }]);
    expect(refreshed).toEqual([boxId]);
  }
});

test('POST window answers ok from a poller that has probeOne but no refreshAgents', async () => {
  const probeOnly = buildServer({ ...serverArgs, statusPoller: { getSnapshot: () => ({}), probeOne: async (id) => { probed.push(id); return { reachable: true }; } } });
  const h = await headers(probeOnly);
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2' } });
  expect(res.statusCode).toBe(200);
  const probeOnlyRes = await probeOnly.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2', paneId: '%5' } });
  expect([probeOnlyRes.statusCode, probeOnlyRes.json()]).toEqual([200, { ok: true, windowId: '@2', paneId: '%5' }]);
  expect(probed).toEqual([boxId, boxId]); // the probe still ran: the missing refresh took nothing else with it
});

test('POST window never refreshes the agents after a refused or failed select', async () => {
  const h = await headers();
  const post = (payload, url = winUrl()) => app.inject({ method: 'POST', url, headers: h, payload });
  // 502: the select failed on the box, with and without a pane.
  failNext = true;
  expect((await post({ session: 'main', windowId: '@3' })).statusCode).toBe(502);
  failNext = true;
  expect((await post({ session: 'main', windowId: '@3', paneId: '%12' })).statusCode).toBe(502);
  // 400: a bad pane id, window id or session name.
  expect((await post({ session: 'main', windowId: '@3', paneId: '12' })).statusCode).toBe(400);
  expect((await post({ session: 'main', windowId: '3' })).statusCode).toBe(400);
  expect((await post({ windowId: '@3' })).statusCode).toBe(400);
  // 404: no such box.
  expect((await post({ session: 'main', windowId: '@3' }, '/api/boxes/nope/window')).statusCode).toBe(404);
  // 409: the box's setup job is running.
  setupRunning = true;
  expect((await post({ session: 'main', windowId: '@3', paneId: '%12' })).statusCode).toBe(409);
  setupRunning = false;
  // 503: no way to run the select.
  const unwired = buildServer({ ...serverArgs, boxActions: {} });
  const res = await unwired.inject({ method: 'POST', url: winUrl(), headers: await headers(unwired), payload: { session: 'main', windowId: '@3' } });
  expect(res.statusCode).toBe(503);
  expect(refreshed).toEqual([]);
  expect(probed).toEqual([]);
});
