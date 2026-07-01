import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHealthEventsStore } from '../src/server/healthEventsStore.js';

test('load returns [] when the file does not exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-health-'));
  expect(createHealthEventsStore({ dataDir: dir }).load()).toEqual([]);
});

test('save then load round-trips and creates the data dir', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-health-'));
  const dir = path.join(base, 'data');
  const store = createHealthEventsStore({ dataDir: dir });
  const events = [{ seq: 1, boxId: 'b1', label: 'web-01', host: 'h1', t: 1, kind: 'down' }];
  store.save(events);
  expect(store.load()).toEqual(events);
  await expect(fs.stat(path.join(dir, 'health-events.json'))).resolves.toBeTruthy();
});

test('load returns [] on a corrupt file instead of throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-health-'));
  await fs.writeFile(path.join(dir, 'health-events.json'), 'not json');
  expect(createHealthEventsStore({ dataDir: dir }).load()).toEqual([]);
});
