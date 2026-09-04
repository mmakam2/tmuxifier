import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { hashPassword, COOKIE_NAME } from '../src/server/auth.js';

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

// A fake voiceLinks manager that records open() calls and lets a test fire the
// hooks the route wires; the real manager is covered by test/voiceLinks.test.js.
function fakeLinks() {
  const f = { opens: [], writes: [], closes: [] };
  f.open = (boxId, box, hooks) => {
    const link = { boxId, box, hooks, write: (b) => { f.writes.push(Buffer.from(b)); return true; }, close: (c, r) => { f.closes.push([c, r]); } };
    f.opens.push(link);
    return link;
  };
  return f;
}

async function fixture({ setupStatus = null, voiceLinks = fakeLinks() } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vl-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'), localShell: 'none',
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  const sessions = { open() { return {}; }, openLocal() { return {}; }, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const setupManager = setupStatus ? { currentForBox: () => ({ id: 'j1', boxId: saved.id, status: setupStatus }) } : undefined;
  const app = buildServer({ config, store, sessions, setupManager, voiceLinks, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };
  return { app, port, boxId: saved.id, cookie: `${c.name}=${c.value}`, voiceLinks };
}

function closeOf(ws) {
  return new Promise((resolve, reject) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', reject);
  });
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('unauthenticated upgrade is refused 1008', async () => {
  const { port, boxId } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`);
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'unauthorized' });
});

test('an Origin header for another host is refused 1008 forbidden origin, before auth', async () => {
  // The same CSRF chokepoint /term has: a page on another origin can open a
  // WebSocket to us with the browser attaching our cookie, so the upgrade is
  // refused on Origin BEFORE the cookie is even consulted. Sent WITH a valid
  // cookie here precisely so a regression could not hide behind the 401.
  const { port, boxId, cookie, voiceLinks } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, {
    headers: { cookie, origin: 'http://evil.example.com' },
  });
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'forbidden origin' });
  expect(voiceLinks.opens).toHaveLength(0);
});

test('unknown box is refused 1008', async () => {
  const { port, cookie } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=nope`, { headers: { cookie } });
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'unknown box' });
});

test('a box whose setup job is running is refused 1008 setting up, and no link is opened', async () => {
  const { port, boxId, cookie, voiceLinks } = await fixture({ setupStatus: 'running' });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'setting up' });
  expect(voiceLinks.opens).toHaveLength(0);
});

test('a parked (needs-interactive) job does not gate the link', async () => {
  const { port, boxId, cookie, voiceLinks } = await fixture({ setupStatus: 'needs-interactive' });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await tick(20);
  expect(voiceLinks.opens).toHaveLength(1);
  ws.close();
});

test('opens a link for the box, relays ready, forwards binary frames only, and closes the link with the socket', async () => {
  const { port, boxId, cookie, voiceLinks } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  const texts = [];
  ws.on('message', (d, isBinary) => { if (!isBinary) texts.push(d.toString()); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await tick(20);
  const link = voiceLinks.opens[0];
  expect(link.boxId).toBe(boxId);
  expect(link.box.id).toBe(boxId);
  link.hooks.onReady();
  await tick(20);
  expect(texts).toEqual(['ready']);
  ws.send(Buffer.from([1, 2, 3, 4]));
  ws.send('not audio');
  await tick(20);
  expect(voiceLinks.writes).toEqual([Buffer.from([1, 2, 3, 4])]);
  ws.close();
  await tick(20);
  expect(voiceLinks.closes[0]).toEqual([1000, 'closed']);
});

test('the link closing closes the socket with its code and reason', async () => {
  const { port, boxId, cookie, voiceLinks } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  const closed = closeOf(ws);
  await new Promise((res) => ws.on('open', res));
  await tick(20);
  voiceLinks.opens[0].hooks.onClose(4002, 'not-set-up');
  expect(await closed).toEqual({ code: 4002, reason: 'not-set-up' });
});

test('__local__ opens a link with no box', async () => {
  const { port, cookie, voiceLinks } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=__local__`, { headers: { cookie } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await tick(20);
  expect(voiceLinks.opens[0].boxId).toBe('__local__');
  expect(voiceLinks.opens[0].box).toBeNull();
  ws.close();
});

test('without a manager wired the upgrade closes 1011', async () => {
  const { port, boxId, cookie } = await fixture({ voiceLinks: null });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  expect((await closeOf(ws)).code).toBe(1011);
});

test('the permissions policy allows the microphone for this origin regardless of whisper', async () => {
  // The header rides the global onSend hook, so any response carries it —
  // an unauthenticated 401 avoids depending on a built dist/.
  const { app } = await fixture();
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(res.headers['permissions-policy']).toContain('microphone=(self)');
});
