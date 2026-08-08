import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFleetScriptsStore } from '../src/server/fleetScriptsStore.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fscripts-'));
  store = createFleetScriptsStore({ dataDir: dir });
});

const spec = { name: 'apt upgrade', script: 'sudo apt-get update && sudo apt-get -y upgrade\n' };

test('an absent file reads as an empty list', async () => {
  expect(await store.listScripts()).toEqual([]);
});

test('addScript normalizes, stamps timestamps, and round-trips through the file', async () => {
  const rec = await store.addScript(spec);
  expect(rec.id).toMatch(/^fs-/);
  expect(rec.name).toBe('apt upgrade');
  expect(rec.script).toBe(spec.script);
  expect(rec.createdAt).toBeTruthy();
  expect(rec.updatedAt).toBeTruthy();
  expect(await store.listScripts()).toEqual([rec]);
  // A fresh store over the same directory sees it: the write really landed.
  const reopened = createFleetScriptsStore({ dataDir: dir });
  expect(await reopened.listScripts()).toEqual([rec]);
});

test('the data file is written 0o600', async () => {
  await store.addScript(spec);
  const st = await fs.stat(path.join(dir, 'fleet-scripts.json'));
  expect(st.mode & 0o777).toBe(0o600);
});

test('name is required, trimmed, and capped at 80 chars', async () => {
  await expect(store.addScript({ ...spec, name: '   ' })).rejects.toThrow(/name/);
  await expect(store.addScript({ ...spec, name: 'x'.repeat(81) })).rejects.toThrow(/name/);
  const rec = await store.addScript({ ...spec, name: '  apt upgrade  ' });
  expect(rec.name).toBe('apt upgrade');
});

test('script body is required and capped at 65536 chars', async () => {
  await expect(store.addScript({ ...spec, script: '   \n ' })).rejects.toThrow(/script/);
  await expect(store.addScript({ ...spec, script: 'x'.repeat(65537) })).rejects.toThrow(/65536/);
  // Exactly at the cap is fine: it is the same limit POST /api/fleet/jobs allows.
  const rec = await store.addScript({ ...spec, script: 'x'.repeat(65536) });
  expect(rec.script.length).toBe(65536);
});

test('description is optional, trimmed, capped at 200, and clearable with an empty string', async () => {
  await expect(store.addScript({ ...spec, description: 'd'.repeat(201) })).rejects.toThrow(/description/);
  const rec = await store.addScript({ ...spec, description: '  updates every box  ' });
  expect(rec.description).toBe('updates every box');
  const cleared = await store.updateScript(rec.id, { description: '' });
  expect(cleared.description).toBeUndefined();
  // An omitted key keeps the stored value — the patch-merge rule.
  const kept = await store.updateScript(rec.id, { name: 'apt upgrade v2' });
  expect(kept.description).toBeUndefined();
  expect(kept.name).toBe('apt upgrade v2');
});

test('names are unique case-insensitively, on both add and rename', async () => {
  const first = await store.addScript(spec);
  await expect(store.addScript({ ...spec, name: 'APT Upgrade' })).rejects.toThrow(/already exists/);
  const second = await store.addScript({ ...spec, name: 'docker prune' });
  await expect(store.updateScript(second.id, { name: 'apt upgrade' })).rejects.toThrow(/already exists/);
  // Re-saving a record under its own name is not a conflict.
  const same = await store.updateScript(first.id, { name: 'apt upgrade', script: 'echo hi' });
  expect(same.name).toBe('apt upgrade');
  expect(same.script).toBe('echo hi');
});

test('updateScript merges onto the stored record and keeps id and createdAt', async () => {
  const rec = await store.addScript(spec);
  const upd = await store.updateScript(rec.id, { script: 'echo changed' });
  expect(upd).toMatchObject({ id: rec.id, name: rec.name, createdAt: rec.createdAt, script: 'echo changed' });
  await expect(store.updateScript('fs-nope', { script: 'x' })).rejects.toThrow('script not found');
});

test('removeScript drops the record and is a no-op for an unknown id', async () => {
  const rec = await store.addScript(spec);
  await store.removeScript('fs-nope');
  expect(await store.listScripts()).toHaveLength(1);
  await store.removeScript(rec.id);
  expect(await store.listScripts()).toEqual([]);
});

test('listScripts returns newest-updated first, with a stable id tie-break', async () => {
  const a = await store.addScript({ name: 'a', script: 'echo a' });
  const b = await store.addScript({ name: 'b', script: 'echo b' });
  const ids = (await store.listScripts()).map((s) => s.id);
  expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
  // Touching `a` must float it to the front regardless of insertion order.
  await new Promise((r) => setTimeout(r, 2));
  await store.updateScript(a.id, { script: 'echo a2' });
  expect((await store.listScripts())[0].id).toBe(a.id);
});

test('the store caps at 200 scripts', async () => {
  const full = createFleetScriptsStore({ dataDir: dir });
  for (let i = 0; i < 200; i++) await full.addScript({ name: `s${i}`, script: 'echo x' });
  await expect(full.addScript({ name: 'one-too-many', script: 'echo x' })).rejects.toThrow(/200/);
});

test('concurrent adds are serialized — no write is lost', async () => {
  await Promise.all([
    store.addScript({ name: 'one', script: 'echo 1' }),
    store.addScript({ name: 'two', script: 'echo 2' }),
    store.addScript({ name: 'three', script: 'echo 3' }),
  ]);
  expect(await store.listScripts()).toHaveLength(3);
});

test('a corrupt file is quarantined and read as empty rather than destroying it', async () => {
  const file = path.join(dir, 'fleet-scripts.json');
  await fs.writeFile(file, '{ not json');
  expect(await store.listScripts()).toEqual([]);
  const left = await fs.readdir(dir);
  expect(left.some((f) => f.startsWith('fleet-scripts.json.corrupt-'))).toBe(true);
});

// The setup manager resolves a saved script by id at run time (it stores only
// the id plus a frozen display name), so a single-record read is the one thing
// this store lacked. A bad id must read as "not found", never throw — the
// caller records it as a skip.
test('getScript returns the record by id, and null for anything else', async () => {
  const rec = await store.addScript(spec);
  expect(await store.getScript(rec.id)).toEqual(rec);
  expect(await store.getScript('fs-nope')).toBeNull();
  expect(await store.getScript('')).toBeNull();
  expect(await store.getScript(undefined)).toBeNull();
  expect(await store.getScript(null)).toBeNull();
});
