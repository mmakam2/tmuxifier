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

const LINK = { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' };

test('ordinary addBox cannot create lifecycle authority', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.10', source: 'proxmox', proxmox: LINK });
  expect(box.source).toBe('manual');
  expect(box.proxmox).toBeUndefined();
});

test('trusted provisioning addBox persists linkage', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox(
    { host: '192.168.1.10', source: 'proxmox', proxmox: LINK },
    { trustedProxmox: true },
  );
  expect(box).toMatchObject({ source: 'proxmox', proxmox: LINK });
});

test('setProxmoxLink writes one unique verified target; clear removes authority', async () => {
  const store = createStore({ dataDir: dir });
  const first = await store.addBox({ host: '192.168.1.10', label: 'first' });
  const second = await store.addBox({ host: '192.168.1.11', label: 'second' });
  expect(await store.setProxmoxLink(first.id, LINK)).toMatchObject({ source: 'proxmox', proxmox: LINK });
  await expect(store.setProxmoxLink(second.id, LINK)).rejects.toThrow(/already linked/);
  const reassigned = await store.setProxmoxLink(first.id, { ...LINK, vmid: 132 });
  expect(reassigned.proxmox.vmid).toBe(132);
  const cleared = await store.clearProxmoxLink(first.id);
  expect(cleared.source).toBe('manual');
  expect(cleared.proxmox).toBeUndefined();
});

test('updateBox cannot mutate source or proxmox linkage', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.10' });
  await expect(store.updateBox(box.id, { proxmox: LINK })).rejects.toThrow(/link route/);
  await expect(store.updateBox(box.id, { source: 'proxmox' })).rejects.toThrow(/link route/);
});

test('import strips proxmox authority and source', async () => {
  const store = createStore({ dataDir: dir });
  const result = await store.importBoxes({ boxes: [
    { host: '192.168.1.10', label: 'imported', source: 'proxmox', proxmox: LINK },
  ] });
  expect(result.added[0].source).toBe('manual');
  expect(result.added[0].proxmox).toBeUndefined();
});

test('a corrupt boxes.json is quarantined — the next write cannot destroy it', async () => {
  await fs.writeFile(path.join(dir, 'boxes.json'), '[{"id": "b1", "host": "important-host"'); // truncated mid-write
  const store = createStore({ dataDir: dir });
  expect(await store.listBoxes()).toEqual([]); // unreadable, so no boxes — but…
  const q = (await fs.readdir(dir)).filter((n) => n.startsWith('boxes.json.corrupt-'));
  expect(q).toHaveLength(1); // …the original bytes were moved aside, not left to be overwritten
  await store.addBox({ host: 'new-box' });
  expect(await fs.readFile(path.join(dir, q[0]), 'utf8')).toContain('important-host');
});

test('a boxes.json that is not an array is treated as corrupt, not crashed on', async () => {
  await fs.writeFile(path.join(dir, 'boxes.json'), '{}');
  const store = createStore({ dataDir: dir });
  expect(await store.getBox('x')).toBeUndefined(); // used to throw TypeError (.find on {})
});

test('setProxmoxLink can move an existing link to a new node, preserving vmid/host/endpoint', async () => {
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.40', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' } }, { trustedProxmox: true });
  await store.setProxmoxLink(box.id, { hostId: 'H1', node: 'pve2', vmid: 131, endpoint: 'pve.example.com:8006' });
  const reloaded = (await createStore({ dataDir: dir }).getBox(box.id));
  expect(reloaded.proxmox).toEqual({ hostId: 'H1', node: 'pve2', vmid: 131, endpoint: 'pve.example.com:8006' });
});

test('an explicit null label clears back to the host default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-store-lbl-'));
  const store = createStore({ dataDir: dir });
  const b = await store.addBox({ host: '192.168.1.10', user: 'root', label: 'friendly' });
  const updated = await store.updateBox(b.id, { label: null });
  expect(updated.label).toBe('192.168.1.10');
  await fs.rm(dir, { recursive: true, force: true });
});
