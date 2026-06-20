import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/server/store.js';

let dir;
let sshConfigPath;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-store-'));
  sshConfigPath = path.join(dir, 'ssh_config');
  await fs.writeFile(sshConfigPath, 'Host prod\n  HostName 10.0.0.5\n  User deploy\n');
});

test('addBox assigns id, defaults sessionName, persists', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  const box = await store.addBox({ host: 'h1' });
  expect(box.id).toBeTruthy();
  expect(box.sessionName).toBe('web');
  expect(box.label).toBe('h1');
  const again = createStore({ dataDir: dir, sshConfigPath });
  expect((await again.listBoxes())[0].id).toBe(box.id);
});

test('addBox rejects missing host', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  await expect(store.addBox({})).rejects.toThrow(/host/);
});

test('addBox sanitizes sessionName', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  const box = await store.addBox({ host: 'h', sessionName: 'a b/c' });
  expect(box.sessionName).toBe('a-b-c');
});

test('update and remove', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  const box = await store.addBox({ host: 'h' });
  await store.updateBox(box.id, { label: 'renamed' });
  expect((await store.getBox(box.id)).label).toBe('renamed');
  await store.removeBox(box.id);
  expect(await store.getBox(box.id)).toBeUndefined();
});

test('importFromSshConfig adds new aliases only', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  const first = await store.importFromSshConfig();
  expect(first.map((b) => b.host)).toEqual(['prod']);
  const second = await store.importFromSshConfig();
  expect(second).toEqual([]); // already present
});

test('addBox rejects an unsafe host (ssh flag injection guard)', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  await expect(store.addBox({ host: '-oProxyCommand=x' })).rejects.toThrow(/unsafe/);
});

test('updateBox rejects an unsafe host (ssh flag injection guard)', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  const box = await store.addBox({ host: 'safebox' });
  await expect(store.updateBox(box.id, { host: '-oProxyCommand=x' })).rejects.toThrow(/unsafe/);
});
