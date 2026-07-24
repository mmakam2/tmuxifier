import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNetboxStore } from '../src/server/netboxStore.js';
import { createSecretBox } from '../src/server/secretBox.js';

let dir;
const secretBox = createSecretBox('test-cookie');
const make = () => createNetboxStore({ dataDir: dir, secretBox });
const SPEC = { url: 'https://netbox.example.com/', token: 'nb-super-secret', tlsMode: 'ca' };

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-nbx-')); });

test('getSettings returns null before anything is saved', async () => {
  expect(await make().getSettings()).toBeNull();
});

test('setSettings seals the token; reads are redacted; file is 0600 and ciphertext-only', async () => {
  const store = make();
  const saved = await store.setSettings(SPEC);
  expect(saved.token).toBeUndefined();
  expect(saved.hasToken).toBe(true);
  expect(saved.url).toBe('https://netbox.example.com'); // normalized
  const got = await store.getSettings();
  expect(got.token).toBeUndefined();
  expect(got.hasToken).toBe(true);
  const raw = await fs.readFile(path.join(dir, 'netbox.json'), 'utf8');
  expect(raw).not.toContain('nb-super-secret');
  expect(raw).toContain('pvebox.v1:'); // secretBox scheme tag
  const stat = await fs.stat(path.join(dir, 'netbox.json'));
  expect(stat.mode & 0o777).toBe(0o600);
});

test('getSettings withSecret decrypts the token', async () => {
  const store = make();
  await store.setSettings(SPEC);
  expect((await store.getSettings({ withSecret: true })).token).toBe('nb-super-secret');
});

test('blank token on save keeps the existing token; other fields update', async () => {
  const store = make();
  await store.setSettings(SPEC);
  const saved = await store.setSettings({ url: 'https://nb2.example.com', token: '', tlsMode: 'insecure' });
  expect(saved.url).toBe('https://nb2.example.com');
  expect(saved.tlsMode).toBe('insecure');
  const full = await store.getSettings({ withSecret: true });
  expect(full.token).toBe('nb-super-secret');
});

test('blank token with nothing stored is rejected', async () => {
  await expect(make().setSettings({ url: 'https://x.example.com', token: '' })).rejects.toThrow(/token/);
});

test('invalid input is rejected before anything is written', async () => {
  const store = make();
  await expect(store.setSettings({ url: 'nope', token: 't' })).rejects.toThrow(/URL/);
  await expect(fs.stat(path.join(dir, 'netbox.json'))).rejects.toThrow(); // no file created
});

test('clearSettings removes the stored settings', async () => {
  const store = make();
  await store.setSettings(SPEC);
  await store.clearSettings();
  expect(await store.getSettings()).toBeNull();
});

test('dnsSuffix persists, is normalized, and survives the redacted read', async () => {
  const store = make();
  await store.setSettings({ ...SPEC, dnsSuffix: ' Lan.Example.COM ' });
  expect((await store.getSettings()).dnsSuffix).toBe('lan.example.com');
  expect((await store.getSettings({ withSecret: true })).dnsSuffix).toBe('lan.example.com');
});

test('omitting dnsSuffix on a later save clears it (rebuilt, not merged)', async () => {
  const store = make();
  await store.setSettings({ ...SPEC, dnsSuffix: 'lan.example.com' });
  await store.setSettings(SPEC);
  expect((await store.getSettings()).dnsSuffix).toBeNull();
});

test('after clearSettings, a blank token on the next save is rejected (no stale hasToken to fall back on)', async () => {
  const store = make();
  await store.setSettings(SPEC);
  await store.clearSettings();
  await expect(store.setSettings({ url: 'https://netbox.example.com', token: '' })).rejects.toThrow(/token/);
});
