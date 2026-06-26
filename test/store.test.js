import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/server/store.js';

let dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-store-'));
});

test('addBox assigns id, defaults sessionName, persists', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'h1' });
  expect(box.id).toBeTruthy();
  expect(box.sessionName).toBe('web');
  expect(box.label).toBe('h1');
  const again = createStore({ dataDir: dir });
  expect((await again.listBoxes())[0].id).toBe(box.id);
});

test('addBox rejects missing host', async () => {
  const store = createStore({ dataDir: dir });
  await expect(store.addBox({})).rejects.toThrow(/host/);
});

test('addBox sanitizes sessionName', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'h', sessionName: 'a b/c' });
  expect(box.sessionName).toBe('a-b-c');
});

test('update and remove', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'h' });
  await store.updateBox(box.id, { label: 'renamed' });
  expect((await store.getBox(box.id)).label).toBe('renamed');
  await store.removeBox(box.id);
  expect(await store.getBox(box.id)).toBeUndefined();
});

test('exportBoxes returns a versioned snapshot of all boxes', async () => {
  const store = createStore({ dataDir: dir });
  await store.addBox({ host: 'h1', user: 'deploy' });
  await store.addBox({ host: 'h2' });
  const payload = await store.exportBoxes();
  expect(payload.type).toBe('tmuxifier-boxes');
  expect(payload.version).toBe(1);
  expect(typeof payload.exportedAt).toBe('string');
  expect(payload.boxes.map((b) => b.host)).toEqual(['h1', 'h2']);
});

test('importBoxes adds boxes from an exported payload', async () => {
  const src = createStore({ dataDir: dir });
  await src.addBox({ host: 'h1', user: 'deploy', port: 2222, proxyJump: 'bastion' });
  const payload = await src.exportBoxes();

  const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-store-'));
  const dest = createStore({ dataDir: destDir });
  const { added, skipped } = await dest.importBoxes(payload);
  expect(skipped).toBe(0);
  expect(added).toHaveLength(1);
  const box = added[0];
  expect(box).toMatchObject({ host: 'h1', user: 'deploy', port: 2222, proxyJump: 'bastion' });
  // import re-mints identity so it never collides with the source instance
  expect(box.id).not.toBe(payload.boxes[0].id);
});

test('importBoxes skips duplicate hosts and re-imports are no-ops', async () => {
  const store = createStore({ dataDir: dir });
  await store.addBox({ host: 'h1' });
  const payload = { boxes: [{ host: 'h1' }, { host: 'h2' }] };
  const first = await store.importBoxes(payload);
  expect(first.added.map((b) => b.host)).toEqual(['h2']);
  expect(first.skipped).toBe(1); // h1 already exists
  const second = await store.importBoxes(payload);
  expect(second.added).toEqual([]);
  expect(second.skipped).toBe(2);
});

test('importBoxes accepts a bare array and skips unsafe entries', async () => {
  const store = createStore({ dataDir: dir });
  const { added, skipped } = await store.importBoxes([
    { host: 'good' },
    { host: 'bad host!' }, // fails assertBoxSafe
    { label: 'no-host' }, // missing host
  ]);
  expect(added.map((b) => b.host)).toEqual(['good']);
  expect(skipped).toBe(2);
});

test('importBoxes rejects payloads without a boxes array', async () => {
  const store = createStore({ dataDir: dir });
  await expect(store.importBoxes({ nope: true })).rejects.toThrow(/boxes array/);
  await expect(store.importBoxes(null)).rejects.toThrow(/boxes array/);
});

test('addBox rejects an unsafe host (ssh flag injection guard)', async () => {
  const store = createStore({ dataDir: dir });
  await expect(store.addBox({ host: '-oProxyCommand=x' })).rejects.toThrow(/unsafe/);
});

test('addBox rejects duplicate host ignoring case', async () => {
  const store = createStore({ dataDir: dir });
  await store.addBox({ host: 'Prod-DB' });

  await expect(store.addBox({ host: 'prod-db' })).rejects.toThrow(/host already exists/);
});

test('addBox rejects duplicate label ignoring case', async () => {
  const store = createStore({ dataDir: dir });
  await store.addBox({ host: 'prod-db-1', label: 'Primary DB' });

  await expect(store.addBox({ host: 'prod-db-2', label: 'primary db' })).rejects.toThrow(/label already exists/);
});

test('updateBox rejects duplicate host and label from another box', async () => {
  const store = createStore({ dataDir: dir });
  const first = await store.addBox({ host: 'prod-db-1', label: 'Primary DB' });
  const second = await store.addBox({ host: 'prod-db-2', label: 'Replica DB' });

  await expect(store.updateBox(second.id, { host: 'PROD-DB-1' })).rejects.toThrow(/host already exists/);
  await expect(store.updateBox(second.id, { label: 'primary db' })).rejects.toThrow(/label already exists/);
  await expect(store.updateBox(first.id, { label: 'PRIMARY DB' })).resolves.toMatchObject({ label: 'PRIMARY DB' });
});

test('updateBox clears user when sent null', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'example.com', label: 'ex', user: 'root', port: 2222, proxyJump: 'jump.example.com' });
  const updated = await store.updateBox(box.id, { user: null });
  expect(updated.user).toBe(undefined);
});

test('updateBox clears port when sent null', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'example.com', label: 'ex', port: 2222 });
  const updated = await store.updateBox(box.id, { port: null });
  expect(updated.port).toBe(undefined);
});

test('updateBox clears proxyJump when sent null', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'example.com', label: 'ex', proxyJump: 'jump.example.com' });
  const updated = await store.updateBox(box.id, { proxyJump: null });
  expect(updated.proxyJump).toBe(undefined);
});

test('updateBox rejects an unsafe host (ssh flag injection guard)', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'safebox' });
  await expect(store.updateBox(box.id, { host: '-oProxyCommand=x' })).rejects.toThrow(/unsafe/);
});

test('addBox normalizes missing and blank tags to an empty list', async () => {
  const store = createStore({ dataDir: dir });

  const missing = await store.addBox({ host: 'missing-tags' });
  const blank = await store.addBox({ host: 'blank-tags', tags: [' ', '\t', ''] });

  expect(missing.tags).toEqual([]);
  expect(blank.tags).toEqual([]);
});

test('addBox trims, collapses whitespace, and stores only the first non-empty tag', async () => {
  const store = createStore({ dataDir: dir });

  const box = await store.addBox({
    host: 'tagged-box',
    tags: ['  Prod   Web  ', 'Staging'],
  });

  expect(box.tags).toEqual(['Prod Web']);
});

test('updateBox can clear and replace the primary tag', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: 'retagged-box', tags: ['Prod'] });

  const cleared = await store.updateBox(box.id, { tags: [] });
  expect(cleared.tags).toEqual([]);

  const replaced = await store.updateBox(box.id, { tags: ['  Staging   East '] });
  expect(replaced.tags).toEqual(['Staging East']);
});
