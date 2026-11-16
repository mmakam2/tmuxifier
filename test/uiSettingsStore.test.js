import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUiSettingsStore } from '../src/server/uiSettingsStore.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uiset-'));
  store = createUiSettingsStore({ dataDir: dir });
});

test('reads nulls when nothing is stored (unset is distinguishable from a choice)', async () => {
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null, sidebarSpark: false });
});

test('update patches only the provided keys and persists', async () => {
  await store.update({ theme: 'original' });
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: null, sidebarSpark: false });
  await store.update({ clawdAnim: 'pace', sidebarSpark: false });
  // omitted key keeps the stored value — the PATCH-merge contract
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: 'pace', sidebarSpark: false });
});

test('null clears a stored value', async () => {
  await store.update({ theme: 'original' });
  await store.update({ theme: null });
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null, sidebarSpark: false });
});

test('rejects non-slug values and unknown keys are ignored', async () => {
  await expect(store.update({ theme: 'Bad Theme!' })).rejects.toThrow(/invalid theme/);
  await expect(store.update({ clawdAnim: 'x'.repeat(33) })).rejects.toThrow(/invalid clawdAnim/);
  await expect(store.update({ theme: 42 })).rejects.toThrow(/invalid theme/);
  await store.update({ nonsense: 'value' }); // ignored, not an error
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null, sidebarSpark: false });
});

test('a corrupt file fails open to nulls', async () => {
  await fs.writeFile(path.join(dir, 'ui-settings.json'), '{nope');
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null, sidebarSpark: false });
});

test('non-slug garbage already in the file reads back as null', async () => {
  await fs.writeFile(path.join(dir, 'ui-settings.json'), JSON.stringify({ theme: '<script>', clawdAnim: 'star' }));
  expect(await store.read()).toEqual({ theme: null, clawdAnim: 'star', sidebarSpark: false });
});

test('sidebarSpark defaults to false and round-trips a boolean', async () => {
  expect((await store.read()).sidebarSpark).toBe(false);
  await store.update({ sidebarSpark: true });
  expect((await store.read()).sidebarSpark).toBe(true);
  await store.update({ theme: 'original' }); // omitted key keeps the stored value
  expect((await store.read()).sidebarSpark).toBe(true);
  await store.update({ sidebarSpark: null }); // null resets to off
  expect((await store.read()).sidebarSpark).toBe(false);
});

test('sidebarSpark rejects non-booleans and stores nothing', async () => {
  await store.update({ sidebarSpark: true });
  for (const bad of ['true', 'yes', 1, 0, {}, []]) {
    await expect(store.update({ sidebarSpark: bad })).rejects.toThrow(/invalid sidebarSpark/);
  }
  expect((await store.read()).sidebarSpark).toBe(true);
});

test('a rejected mixed patch writes nothing, not even its valid keys', async () => {
  await store.update({ theme: 'original', sidebarSpark: true });
  // theme is valid and sorts first: a refactor that wrote between the two
  // validation loops would persist 'vercel' before sidebarSpark threw.
  await expect(store.update({ theme: 'vercel', sidebarSpark: 'yes' })).rejects.toThrow(/invalid sidebarSpark/);
  await expect(store.update({ clawdAnim: 'pace', theme: 'Bad Theme!' })).rejects.toThrow(/invalid theme/);
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: null, sidebarSpark: true });
  // The file itself, not just read()'s view of it.
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'ui-settings.json'), 'utf8'));
  expect(onDisk).toEqual({ theme: 'original', clawdAnim: null, sidebarSpark: true });
});

test('two overlapping updates both land (no lost key)', async () => {
  const [a, b] = await Promise.all([
    store.update({ theme: 'original' }),
    store.update({ sidebarSpark: true }),
  ]);
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: null, sidebarSpark: true });
  // Each call resolves with the state it produced, in call order: the second
  // one's result already carries the first one's key.
  expect(a).toEqual({ theme: 'original', clawdAnim: null, sidebarSpark: false });
  expect(b).toEqual({ theme: 'original', clawdAnim: null, sidebarSpark: true });
});

test('overlapping updates of one key apply in call order', async () => {
  await Promise.all(['original', 'vercel', 'instrument'].map((theme) => store.update({ theme })));
  expect((await store.read()).theme).toBe('instrument');
});

test('a rejected update does not wedge or reorder the ones around it', async () => {
  const results = await Promise.allSettled([
    store.update({ theme: 'original' }),
    store.update({ sidebarSpark: 'yes' }),
    store.update({ clawdAnim: 'pace' }),
  ]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: 'pace', sidebarSpark: false });
  await store.update({ sidebarSpark: true }); // the chain still accepts work afterwards
  expect((await store.read()).sidebarSpark).toBe(true);
});

test('only a literal true in the file reads as on', async () => {
  for (const stored of ['true', 1, {}, null]) {
    await fs.writeFile(path.join(dir, 'ui-settings.json'), JSON.stringify({ sidebarSpark: stored }));
    expect((await store.read()).sidebarSpark).toBe(false);
  }
  await fs.writeFile(path.join(dir, 'ui-settings.json'), JSON.stringify({ sidebarSpark: true }));
  expect((await store.read()).sidebarSpark).toBe(true);
});
