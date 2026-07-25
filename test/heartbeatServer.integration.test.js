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

// This daemon is the only process in the system that accepts input from the
// network, so the shape of what it refuses matters as much as what it accepts.
test('an unknown token records no liveness stamp either', async () => {
  const { port, heartbeatFile } = await start();
  await fetch(`http://127.0.0.1:${port}/hb/nope`, { method: 'POST' });
  await expect(fs.readFile(heartbeatFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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
