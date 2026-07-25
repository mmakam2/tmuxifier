import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { createHeartbeatServer } from '../src/server/ingest/heartbeatServer.js';

let running = null;
afterEach(async () => { if (running) { await running.server.close(); running = null; } });

async function start({ known = ['tok-abc'] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-'));
  const checkinLog = createEventLog({ dir, prefix: 'checkins', now: () => 1000 });
  const heartbeatFile = path.join(dir, 'ingest-heartbeat.json');
  const server = createHeartbeatServer({
    checkinLog, heartbeatFile, now: () => 1000,
    isKnownToken: async (t) => known.includes(t),
  });
  const port = await server.listen(0, '127.0.0.1');
  running = { server, checkinLog, dir, heartbeatFile, port };
  return running;
}

test('a check-in on a known token is recorded and answered 204', async () => {
  const { port, checkinLog } = await start();
  const res = await fetch(`http://127.0.0.1:${port}/hb/tok-abc`, { method: 'POST' });
  expect(res.status).toBe(204);
  const events = await checkinLog.readSince(0);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ via: 'heartbeat', key: 'check:tok-abc', state: 'checkin' });
});

test('GET works too, because most cron jobs reach for curl without -X', async () => {
  const { port, checkinLog } = await start();
  expect((await fetch(`http://127.0.0.1:${port}/hb/tok-abc`)).status).toBe(204);
  expect(await checkinLog.readSince(0)).toHaveLength(1);
});

test('an unknown token is refused and recorded nowhere', async () => {
  const { port, checkinLog } = await start();
  expect((await fetch(`http://127.0.0.1:${port}/hb/nope`, { method: 'POST' })).status).toBe(404);
  expect(await checkinLog.readSince(0)).toEqual([]);
});

test('any other path is refused', async () => {
  const { port } = await start();
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${port}/api/boxes`)).status).toBe(404);
});

test('a liveness stamp is written so the dashboard can tell dead from quiet', async () => {
  const { port, heartbeatFile } = await start();
  await fetch(`http://127.0.0.1:${port}/hb/tok-abc`, { method: 'POST' });
  expect(JSON.parse(await fs.readFile(heartbeatFile, 'utf8')).at).toBe(1000);
});

test('an oversized request body is rejected rather than buffered', async () => {
  const { port } = await start();
  const res = await fetch(`http://127.0.0.1:${port}/hb/tok-abc`, { method: 'POST', body: 'x'.repeat(200000) });
  expect(res.status).toBe(413);
});

// Liveness is the DAEMON's heartbeat, not a record of traffic. Stamping only on
// an accepted check-in (as this first shipped) made a healthy receiver report
// itself dead in two ordinary situations: freshly installed with no check-ins
// yet, and any heartbeat whose window is longer than staleMs — a daily backup
// stamps once per 24h, leaving the stamp stale for 23h55m of every day. A banner
// lit ~99.7% of the time on a healthy system trains the operator to ignore it,
// which is the alert fatigue this whole feature exists to avoid.
test('liveness is stamped on listen, before any check-in has arrived', async () => {
  const { heartbeatFile } = await start();
  expect(JSON.parse(await fs.readFile(heartbeatFile, 'utf8')).at).toBe(1000);
});

test('liveness is re-stamped on an interval, so an idle receiver never reads as dead', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-'));
  const heartbeatFile = path.join(dir, 'ingest-heartbeat.json');
  let t = 1000;
  const ticks = [];
  const server = createHeartbeatServer({
    checkinLog: createEventLog({ dir, prefix: 'checkins', now: () => t }),
    heartbeatFile, now: () => t, isKnownToken: async () => true,
    setIntervalFn: (fn) => { ticks.push(fn); return 1; }, clearIntervalFn: () => {},
  });
  await server.listen(0, '127.0.0.1');
  running = { server };
  expect(ticks).toHaveLength(1);
  t = 999000; // no traffic in the meantime
  await ticks[0]();
  expect(JSON.parse(await fs.readFile(heartbeatFile, 'utf8')).at).toBe(999000);
});

test('closing clears the liveness timer rather than leaving it running', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-'));
  let cleared = null;
  const server = createHeartbeatServer({
    checkinLog: createEventLog({ dir, prefix: 'checkins', now: () => 1000 }),
    heartbeatFile: path.join(dir, 'ingest-heartbeat.json'), now: () => 1000,
    isKnownToken: async () => true,
    setIntervalFn: () => 'timer-handle', clearIntervalFn: (h) => { cleared = h; },
  });
  await server.listen(0, '127.0.0.1');
  await server.close();
  expect(cleared).toBe('timer-handle');
});

test('a token with path traversal or a wildcard character is refused, not looked up', async () => {
  const seen = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-'));
  const server = createHeartbeatServer({
    checkinLog: createEventLog({ dir, prefix: 'checkins', now: () => 1000 }),
    heartbeatFile: path.join(dir, 'ingest-heartbeat.json'),
    now: () => 1000,
    isKnownToken: async (t) => { seen.push(t); return true; },
  });
  const port = await server.listen(0, '127.0.0.1');
  running = { server };
  for (const bad of ['..%2F..%2Fetc', 'tok%20abc', '*', 'a'.repeat(129)]) {
    expect((await fetch(`http://127.0.0.1:${port}/hb/${bad}`)).status).toBe(404);
  }
  // The pattern rejects them outright: nothing malformed is ever handed to the
  // token lookup, which in the real daemon reads data/checks.json.
  expect(seen).toEqual([]);
});

test('an unsupported method on a valid token is refused', async () => {
  const { port, checkinLog } = await start();
  expect((await fetch(`http://127.0.0.1:${port}/hb/tok-abc`, { method: 'DELETE' })).status).toBe(404);
  expect(await checkinLog.readSince(0)).toEqual([]);
});
