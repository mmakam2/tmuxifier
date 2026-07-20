import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoiceStore } from '../src/server/voiceStore.js';
import { DEFAULT_MODEL_ID } from '../src/server/voiceCatalog.js';

let dataDir;
beforeEach(async () => { dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-voice-')); });
afterEach(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });

test('defaults to disabled with the default model when the file is absent', async () => {
  const store = createVoiceStore({ dataDir });
  expect(await store.read()).toEqual({ enabled: false, model: DEFAULT_MODEL_ID });
});

test('update persists and returns the merged settings', async () => {
  const store = createVoiceStore({ dataDir });
  expect(await store.update({ enabled: true })).toEqual({ enabled: true, model: DEFAULT_MODEL_ID });
  // A fresh store instance must see it — proving it actually hit disk.
  expect(await createVoiceStore({ dataDir }).read()).toEqual({ enabled: true, model: DEFAULT_MODEL_ID });
});

test('a partial update leaves the other field alone', async () => {
  const store = createVoiceStore({ dataDir });
  await store.update({ enabled: true, model: 'base.en' });
  expect(await store.update({ enabled: false })).toEqual({ enabled: false, model: 'base.en' });
});

test('rejects a model outside the catalog', async () => {
  const store = createVoiceStore({ dataDir });
  await expect(store.update({ model: '../../etc/passwd' })).rejects.toThrow(/model/i);
  await expect(store.update({ model: 'nope' })).rejects.toThrow(/model/i);
  // The rejected write must not have persisted anything.
  expect(await store.read()).toEqual({ enabled: false, model: DEFAULT_MODEL_ID });
});

test('the file is written owner-only', async () => {
  const store = createVoiceStore({ dataDir });
  await store.update({ enabled: true });
  const st = await fs.stat(path.join(dataDir, 'voice.json'));
  expect(st.mode & 0o777).toBe(0o600);
});

test('a corrupt file falls back to defaults instead of throwing', async () => {
  await fs.writeFile(path.join(dataDir, 'voice.json'), 'not json at all');
  expect(await createVoiceStore({ dataDir }).read()).toEqual({ enabled: false, model: DEFAULT_MODEL_ID });
});
