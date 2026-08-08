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
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null });
});

test('update patches only the provided keys and persists', async () => {
  await store.update({ theme: 'original' });
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: null });
  await store.update({ clawdAnim: 'pace' });
  // omitted key keeps the stored value — the PATCH-merge contract
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: 'pace' });
});

test('null clears a stored value', async () => {
  await store.update({ theme: 'original' });
  await store.update({ theme: null });
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null });
});

test('rejects non-slug values and unknown keys are ignored', async () => {
  await expect(store.update({ theme: 'Bad Theme!' })).rejects.toThrow(/invalid theme/);
  await expect(store.update({ clawdAnim: 'x'.repeat(33) })).rejects.toThrow(/invalid clawdAnim/);
  await expect(store.update({ theme: 42 })).rejects.toThrow(/invalid theme/);
  await store.update({ nonsense: 'value' }); // ignored, not an error
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null });
});

test('a corrupt file fails open to nulls', async () => {
  await fs.writeFile(path.join(dir, 'ui-settings.json'), '{nope');
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null });
});

test('non-slug garbage already in the file reads back as null', async () => {
  await fs.writeFile(path.join(dir, 'ui-settings.json'), JSON.stringify({ theme: '<script>', clawdAnim: 'star' }));
  expect(await store.read()).toEqual({ theme: null, clawdAnim: 'star' });
});
