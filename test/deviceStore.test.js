import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceStore, NOTIFY_KINDS } from '../src/server/deviceStore.js';

let dir, store, clock;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-dev-'));
  clock = { t: 1_000_000 };
  store = createDeviceStore({ dataDir: dir, now: () => clock.t });
});

test('enroll returns the token once and never persists it', async () => {
  const { device, token } = await store.enroll({ name: 'Fold' });
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  expect(device).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{16}$/), name: 'Fold', created: 1_000_000,
    lastSeen: null, hasFcmToken: false, notify: { 'agent-input': true, 'agent-done': true },
  });
  const raw = await fs.readFile(path.join(dir, 'devices.json'), 'utf8');
  expect(raw).not.toContain(token);
  const mode = (await fs.stat(path.join(dir, 'devices.json'))).mode & 0o777;
  expect(mode).toBe(0o600);
});

test('verify accepts the minted token and rejects everything else', async () => {
  const { device, token } = await store.enroll({ name: 'Fold' });
  expect((await store.verify(token))?.id).toBe(device.id);
  expect(await store.verify(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(null);
  expect(await store.verify('')).toBe(null);
  expect(await store.verify(null)).toBe(null);
});

test('remove revokes: verify fails afterwards', async () => {
  const { device, token } = await store.enroll({ name: 'Fold' });
  expect(await store.remove(device.id)).toEqual({ removed: true });
  expect(await store.remove(device.id)).toEqual({ removed: false });
  expect(await store.verify(token)).toBe(null);
});

test('touch updates lastSeen at most once a minute', async () => {
  const { device, token } = await store.enroll({ name: 'Fold' });
  clock.t += 5000;
  await store.touch(device.id);
  expect((await store.list())[0].lastSeen).toBe(1_005_000);
  clock.t += 30_000; // within throttle window
  await store.touch(device.id);
  expect((await store.list())[0].lastSeen).toBe(1_005_000);
  clock.t += 31_000; // past it
  await store.touch(device.id);
  expect((await store.list())[0].lastSeen).toBe(1_066_000);
  expect(await store.verify(token)).not.toBe(null); // touch never disturbs auth
});

test('updateSelf merges notify, clears fcmToken on null, ignores unknown ids', async () => {
  const { device } = await store.enroll({ name: 'Fold', fcmToken: 'fcm-abc' });
  expect((await store.list())[0].hasFcmToken).toBe(true);
  const upd = await store.updateSelf(device.id, { notify: { 'agent-done': false } });
  expect(upd.notify).toEqual({ 'agent-input': true, 'agent-done': false });
  // PATCH-merge rule: an omitted key keeps its stored value; the CLEARING case
  // must work explicitly (see memory: patch-merge-omitted-key-keeps-stored-value).
  const cleared = await store.updateSelf(device.id, { fcmToken: null });
  expect(cleared.hasFcmToken).toBe(false);
  expect(await store.updateSelf('feedfeedfeedfeed', {})).toBe(null);
});

test('listNotifiable filters by fcm token and per-kind toggle', async () => {
  const a = await store.enroll({ name: 'A', fcmToken: 'fcm-a' });
  await store.enroll({ name: 'B' }); // no fcm token
  const c = await store.enroll({ name: 'C', fcmToken: 'fcm-c' });
  await store.updateSelf(c.device.id, { notify: { 'agent-input': false } });
  const targets = await store.listNotifiable('agent-input');
  expect(targets).toEqual([{ id: a.device.id, fcmToken: 'fcm-a' }]);
  expect(NOTIFY_KINDS).toEqual(['agent-input', 'agent-done']);
});

test('clearFcmToken drops delivery without revoking auth', async () => {
  const { device, token } = await store.enroll({ name: 'A', fcmToken: 'fcm-a' });
  await store.clearFcmToken(device.id);
  expect(await store.listNotifiable('agent-input')).toEqual([]);
  expect(await store.verify(token)).not.toBe(null);
});

test('enroll validates the name', async () => {
  await expect(store.enroll({ name: '' })).rejects.toThrow(/name/);
  await expect(store.enroll({ name: 'x'.repeat(65) })).rejects.toThrow(/name/);
  await expect(store.enroll({ name: 'bad\u0007bell' })).rejects.toThrow(/name/);
});

test('corrupt store fails open to empty', async () => {
  await fs.writeFile(path.join(dir, 'devices.json'), '{nope', 'utf8');
  const logs = [];
  const s2 = createDeviceStore({ dataDir: dir, now: () => clock.t, log: (m) => logs.push(m) });
  expect(await s2.list()).toEqual([]);
  expect(logs.length).toBeGreaterThan(0);
});
