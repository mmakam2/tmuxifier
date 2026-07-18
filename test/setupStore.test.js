import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSetupStore } from '../src/server/setupStore.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-setup-')); });

test('load returns [] when the file is absent', () => {
  expect(createSetupStore({ dataDir: dir }).load()).toEqual([]);
});

test('save then load round-trips through the file', async () => {
  const store = createSetupStore({ dataDir: dir });
  store.save([{ id: 'j1', status: 'done' }]);
  await store.whenIdle();
  expect(createSetupStore({ dataDir: dir }).load()).toEqual([{ id: 'j1', status: 'done' }]);
});

test('a corrupt file loads as [] and is quarantined', async () => {
  await fs.writeFile(path.join(dir, 'setup-jobs.json'), 'not json');
  const store = createSetupStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
  store.save([{ id: 'j2' }]);
  await store.whenIdle();
  const q = (await fs.readdir(dir)).filter((n) => n.startsWith('setup-jobs.json.corrupt-'));
  expect(q).toHaveLength(1);
});
