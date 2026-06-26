import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProxmoxStore } from '../src/server/proxmoxStore.js';
import { createSecretBox } from '../src/server/secretBox.js';

let dir;
const secretBox = createSecretBox('test-cookie');
const make = () => createProxmoxStore({ dataDir: dir, secretBox });
const HOST = { name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!tmuxifier', tokenSecret: 'super-secret', verifyMode: 'pin', fingerprint256: 'AB:CD:EF' };

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pve-')); });

test('addHost seals the token; reads are redacted; on-disk file is 0600 and ciphertext-only', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  expect(h.tokenSecret).toBeUndefined();
  expect(h.hasToken).toBe(true);
  const list = await store.listHosts();
  expect(list[0].tokenSecret).toBeUndefined();
  const raw = await fs.readFile(path.join(dir, 'proxmox.json'), 'utf8');
  expect(raw).not.toContain('super-secret');
  expect(raw).toContain('pvebox.v1:');
  const stat = await fs.stat(path.join(dir, 'proxmox.json'));
  expect(stat.mode & 0o777).toBe(0o600);
});

test('getHost withSecret returns the decrypted token; default is redacted', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  expect((await store.getHost(h.id)).hasToken).toBe(true);
  expect((await store.getHost(h.id, { withSecret: true })).tokenSecret).toBe('super-secret');
});

test('updateHost without a new secret keeps the stored token', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  await store.updateHost(h.id, { defaultNode: 'pve' });
  expect((await store.getHost(h.id, { withSecret: true })).tokenSecret).toBe('super-secret');
  await store.updateHost(h.id, { tokenSecret: 'rotated' });
  expect((await store.getHost(h.id, { withSecret: true })).tokenSecret).toBe('rotated');
});

test('host/key/preset names are unique', async () => {
  const store = make();
  await store.addHost(HOST);
  await expect(store.addHost(HOST)).rejects.toThrow(/name/);
});

test('keys CRUD with validation', async () => {
  const store = make();
  const k = await store.addKey({ name: 'mgmt', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 you@example.com' });
  expect((await store.listKeys())[0].id).toBe(k.id);
  await expect(store.addKey({ name: 'bad', publicKey: 'nope' })).rejects.toThrow(/public key/);
  await store.removeKey(k.id);
  expect(await store.listKeys()).toHaveLength(0);
});

test('presets validate against existing hosts and keys and persist normalized', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  const k = await store.addKey({ name: 'mgmt', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 you@example.com' });
  const preset = await store.addPreset({
    name: 'dev', hostId: h.id, template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
    storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
    unprivileged: true, features: { nesting: true },
    net: { bridge: 'vmbr0', ipMode: 'dhcp' }, keyIds: [k.id], startAfterCreate: true,
  });
  expect(preset.id).toBeTruthy();
  expect(preset.net.ipMode).toBe('dhcp');
  expect((await store.getPreset(preset.id)).name).toBe('dev');
  await expect(store.addPreset({ ...preset, name: 'dev2', keyIds: ['ghost'] })).rejects.toThrow(/key/);
});
