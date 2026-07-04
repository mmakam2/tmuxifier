import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProvisionStore } from '../src/server/provisionStore.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pj-')); });

test('load returns [] when the file is absent', () => {
  expect(createProvisionStore({ dataDir: dir }).load()).toEqual([]);
});

test('save then load round-trips through the file', async () => {
  const store = createProvisionStore({ dataDir: dir });
  store.save([{ id: 'j1', status: 'done' }]);
  await store.whenIdle();
  expect(createProvisionStore({ dataDir: dir }).load()).toEqual([{ id: 'j1', status: 'done' }]);
});

test('a corrupt file loads as [] and is moved aside, so a save cannot destroy it', async () => {
  await fs.writeFile(path.join(dir, 'provision-jobs.json'), 'not json');
  const store = createProvisionStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
  store.save([{ id: 'j2' }]);
  await store.whenIdle();
  const q = (await fs.readdir(dir)).filter((n) => n.startsWith('provision-jobs.json.corrupt-'));
  expect(q).toHaveLength(1);
  expect(await fs.readFile(path.join(dir, q[0]), 'utf8')).toBe('not json');
});
