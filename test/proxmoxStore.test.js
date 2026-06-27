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

test('keys are sealed on disk, redacted on read, revealed via withSecret', async () => {
  const store = make();
  const k = await store.addKey({ name: 'mgmt', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 you@example.com' });
  expect(k.publicKey).toBeUndefined();              // redacted return
  expect(k.hasKey).toBe(true);
  const list = await store.listKeys();
  expect(list[0].id).toBe(k.id);
  expect(list[0].publicKey).toBeUndefined();        // redacted list
  expect((await store.listKeys({ withSecret: true }))[0].publicKey).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1 you@example.com');
  const raw = await fs.readFile(path.join(dir, 'proxmox.json'), 'utf8');
  expect(raw).toContain('pvebox.v1:');              // ciphertext on disk
  expect(raw).not.toContain('AAAAC3NzaC1lZDI1');    // not the cleartext key
  await expect(store.addKey({ name: 'bad', publicKey: 'nope' })).rejects.toThrow(/public key/);
  await store.removeKey(k.id);
  expect(await store.listKeys()).toHaveLength(0);
});

test('a legacy cleartext key still reads via withSecret', async () => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'proxmox.json'), JSON.stringify({ version: 1, hosts: [], keys: [{ id: 'k0', name: 'legacy', publicKey: 'ssh-ed25519 LEGACY you@example.com', createdAt: 'x' }], presets: [] }));
  const store = make();
  expect((await store.listKeys({ withSecret: true }))[0].publicKey).toBe('ssh-ed25519 LEGACY you@example.com');
  expect((await store.listKeys())[0].publicKey).toBeUndefined();
});

test('root password is sealed, status is boolean, withSecret reveals, clear removes', async () => {
  const store = make();
  expect(await store.hasRootPassword()).toBe(false);
  expect(await store.getRootPassword({ withSecret: true })).toBeNull();
  await store.setRootPassword('hunter2!');
  expect(await store.hasRootPassword()).toBe(true);
  expect(await store.getRootPassword({ withSecret: true })).toBe('hunter2!');
  expect(await store.getRootPassword()).toBeNull(); // not revealed without withSecret
  const raw = await fs.readFile(path.join(dir, 'proxmox.json'), 'utf8');
  expect(raw).not.toContain('hunter2!');
  await expect(store.setRootPassword('1234')).rejects.toThrow(/5 characters/);
  await store.clearRootPassword();
  expect(await store.hasRootPassword()).toBe(false);
});

test('presets validate against the existing host and persist normalized (keys are not preset-scoped)', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  const preset = await store.addPreset({
    name: 'dev', hostId: h.id, template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
    storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
    unprivileged: true, features: { nesting: true },
    net: { bridge: 'vmbr0', ipMode: 'dhcp' }, startAfterCreate: true,
    mounts: [{ id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: '/data', backup: true }],
  });
  expect(preset.id).toBeTruthy();
  expect(preset.net.ipMode).toBe('dhcp');
  expect(preset.keyIds).toBeUndefined();            // keyIds dropped from the preset model
  expect(preset.mounts).toEqual([{ id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: '/data', backup: true }]);
  expect((await store.getPreset(preset.id)).name).toBe('dev');
  await expect(store.addPreset({ ...preset, name: 'dev2', hostId: 'ghost' })).rejects.toThrow(/host/);
});
