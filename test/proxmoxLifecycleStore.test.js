import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProxmoxLifecycleStore } from '../src/server/proxmoxLifecycleStore.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-lifecycle-')); });

test('missing lifecycle history loads empty', () => {
  expect(createProxmoxLifecycleStore({ dataDir: dir }).load()).toEqual([]);
});

test('save/load round-trips lifecycle jobs', async () => {
  const store = createProxmoxLifecycleStore({ dataDir: dir });
  store.save([{ id: 'j1', action: 'start', status: 'done' }]);
  await store.whenIdle();
  expect(createProxmoxLifecycleStore({ dataDir: dir }).load()).toEqual([{ id: 'j1', action: 'start', status: 'done' }]);
});

test('corrupt lifecycle history is quarantined before the next save', async () => {
  await fs.writeFile(path.join(dir, 'proxmox-lifecycle-jobs.json'), 'not json');
  const store = createProxmoxLifecycleStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
  store.save([{ id: 'j2' }]);
  await store.whenIdle();
  expect((await fs.readdir(dir)).filter((name) => name.startsWith('proxmox-lifecycle-jobs.json.corrupt-'))).toHaveLength(1);
});
