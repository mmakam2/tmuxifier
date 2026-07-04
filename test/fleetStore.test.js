import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFleetStore } from '../src/server/fleetStore.js';

test('load returns [] when the file does not exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fleetstore-'));
  const store = createFleetStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
});

test('save then load round-trips the jobs array and creates the data dir', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fleetstore-'));
  const dir = path.join(base, 'data'); // does not exist yet
  const store = createFleetStore({ dataDir: dir });
  const jobs = [{ id: 'j1', command: 'uptime', status: 'done', targets: [] }];
  store.save(jobs);
  await store.whenIdle();
  expect(store.load()).toEqual(jobs);
  await expect(fs.stat(path.join(dir, 'fleet-jobs.json'))).resolves.toBeTruthy();
});

test('load returns [] on a corrupt file instead of throwing — and quarantines it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fleetstore-'));
  await fs.writeFile(path.join(dir, 'fleet-jobs.json'), 'not json');
  const store = createFleetStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
  store.save([{ id: 'j9', targets: [] }]); // a later save must not destroy the original bytes
  await store.whenIdle();
  const q = (await fs.readdir(dir)).filter((n) => n.startsWith('fleet-jobs.json.corrupt-'));
  expect(q).toHaveLength(1);
  expect(await fs.readFile(path.join(dir, q[0]), 'utf8')).toBe('not json');
});
