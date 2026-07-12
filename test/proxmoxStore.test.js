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
const presetSpec = (hostId, overrides = {}) => ({
  name: 'dev', hostId, node: 'pve',
  template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
  storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
  unprivileged: true, features: { nesting: true },
  net: { bridge: 'vmbr0', vlan: null, ipMode: 'dhcp', cidr: null, gateway: null },
  dns: { nameserver: null, searchdomain: null },
  onboot: false, startAfterCreate: true,
  mounts: [{ id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: '/data', backup: true }],
  boxDefaults: { user: 'root', sessionName: 'web', tags: [] },
  ...overrides,
});

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
  const preset = await store.addPreset(presetSpec(h.id));
  expect(preset.id).toBeTruthy();
  expect(preset.net.ipMode).toBe('dhcp');
  expect(preset.keyIds).toBeUndefined();            // keyIds dropped from the preset model
  expect(preset.mounts).toEqual([{ id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: '/data', backup: true }]);
  expect((await store.getPreset(preset.id)).name).toBe('dev');
  await expect(store.addPreset(presetSpec('ghost', { name: 'dev2' }))).rejects.toThrow(/host/);
});

test('updatePreset replaces fields while preserving id and createdAt', async () => {
  let nextId = 0;
  const store = createProxmoxStore({
    dataDir: dir, secretBox, makeId: () => `id-${++nextId}`, now: () => '2026-07-10T12:00:00.000Z',
  });
  const host = await store.addHost(HOST);
  const original = await store.addPreset(presetSpec(host.id));

  const updated = await store.updatePreset(original.id, presetSpec(host.id, {
    name: 'production', cores: 6, memoryMiB: 8192,
    mounts: [{ id: 'mp0', storage: 'fast-lvm', sizeGiB: 32, path: '/srv', backup: false }],
  }));

  expect(updated).toMatchObject({
    id: original.id, createdAt: '2026-07-10T12:00:00.000Z',
    name: 'production', cores: 6, memoryMiB: 8192,
  });
  expect(updated.mounts).toEqual([
    { id: 'mp0', storage: 'fast-lvm', sizeGiB: 32, path: '/srv', backup: false },
  ]);
  expect(await store.getPreset(original.id)).toEqual(updated);
});

test('updatePreset rejects invalid input without changing the stored preset', async () => {
  const store = make();
  const host = await store.addHost(HOST);
  const original = await store.addPreset(presetSpec(host.id));

  await expect(store.updatePreset(original.id, presetSpec(host.id, { diskGiB: 0 })))
    .rejects.toThrow(/disk/);
  expect(await store.getPreset(original.id)).toEqual(original);
});

test('updatePreset ignores its own name but rejects another preset name', async () => {
  const store = make();
  const host = await store.addHost(HOST);
  const dev = await store.addPreset(presetSpec(host.id));
  await store.addPreset(presetSpec(host.id, { name: 'production' }));

  await expect(store.updatePreset(dev.id, presetSpec(host.id, { name: 'dev', cores: 4 })))
    .resolves.toMatchObject({ id: dev.id, name: 'dev', cores: 4 });
  await expect(store.updatePreset(dev.id, presetSpec(host.id, { name: 'production' })))
    .rejects.toThrow(/name already exists/);
  expect((await store.getPreset(dev.id)).name).toBe('dev');
});

test('updatePreset returns undefined for an unknown id', async () => {
  const store = make();
  const host = await store.addHost(HOST);
  expect(await store.updatePreset('missing', presetSpec(host.id))).toBeUndefined();
  expect(await store.listPresets()).toEqual([]);
});

test('a corrupt proxmox.json is quarantined so stored secrets are never overwritten', async () => {
  const store = make();
  await store.addHost(HOST);
  const file = path.join(dir, 'proxmox.json');
  const original = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, original.slice(0, 40)); // truncated mid-write
  const after = make();
  expect(await after.listHosts()).toEqual([]); // unreadable, so empty — but…
  await after.addHost(HOST); // …a new write must not destroy the sealed secrets
  const q = (await fs.readdir(dir)).filter((n) => n.startsWith('proxmox.json.corrupt-'));
  expect(q).toHaveLength(1);
  expect(await fs.readFile(path.join(dir, q[0]), 'utf8')).toBe(original.slice(0, 40));
});

test('an auto-static preset persists with cidr forced null', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  const p = await store.addPreset({
    name: 'auto', hostId: h.id, template: 'local:vztmpl/x.tar.zst', storage: 'local-lvm',
    diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
    net: { bridge: 'vmbr0', ipMode: 'auto-static', vlan: 30, gateway: '192.168.30.1', cidr: '192.168.30.9/24' },
  });
  expect(p.net.ipMode).toBe('auto-static');
  expect(p.net.vlan).toBe(30);
  expect(p.net.cidr).toBeNull();     // allocated at provision time; never stored
  expect(p.net.gateway).toBeNull();  // inferred from the NetBox prefix; never stored
});
