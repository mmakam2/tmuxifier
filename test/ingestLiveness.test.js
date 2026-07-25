import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIngestLiveness } from '../src/server/ingestLiveness.js';

const mk = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-'));
  return { file: path.join(dir, 'ingest-heartbeat.json') };
};

test('a fresh stamp reads as alive', async () => {
  const { file } = await mk();
  await fs.writeFile(file, JSON.stringify({ at: 1000 }));
  const got = await createIngestLiveness({ heartbeatFile: file, now: () => 2000, staleMs: 60000 }).status();
  expect(got).toEqual({ alive: true, lastSeenAt: 1000, staleFor: null });
});

test('a stale stamp reads as dead and reports how long', async () => {
  const { file } = await mk();
  await fs.writeFile(file, JSON.stringify({ at: 1000 }));
  const got = await createIngestLiveness({ heartbeatFile: file, now: () => 100000, staleMs: 60000 }).status();
  expect(got.alive).toBe(false);
  expect(got.staleFor).toBe(99000);
});

test('a missing stamp reads as dead rather than silently alive', async () => {
  const { file } = await mk();
  const got = await createIngestLiveness({ heartbeatFile: file, now: () => 5000, staleMs: 60000 }).status();
  expect(got).toEqual({ alive: false, lastSeenAt: null, staleFor: null });
});

// The whole point of this module is that "I cannot tell" must never render as
// "fine". A corrupt or hand-mangled stamp is exactly as uninformative as a
// missing one, so it has to land on the same side of the answer.
test('a corrupt stamp reads as dead rather than alive', async () => {
  const { file } = await mk();
  await fs.writeFile(file, 'not json at all');
  const got = await createIngestLiveness({ heartbeatFile: file, now: () => 5000, staleMs: 60000 }).status();
  expect(got.alive).toBe(false);
});

test('a stamp with a non-numeric timestamp reads as dead', async () => {
  const { file } = await mk();
  await fs.writeFile(file, JSON.stringify({ at: 'just now' }));
  const got = await createIngestLiveness({ heartbeatFile: file, now: () => 5000, staleMs: 60000 }).status();
  expect(got).toEqual({ alive: false, lastSeenAt: null, staleFor: null });
});
