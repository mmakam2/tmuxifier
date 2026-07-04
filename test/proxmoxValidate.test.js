import { test, expect } from 'vitest';
import {
  parseEndpoint, isCidr, isIp,
  assertHostInput, assertKeyInput, assertPresetInput, assertProvisionInput, assertRootPassword,
} from '../src/server/proxmoxValidate.js';

test('parseEndpoint accepts host and host:port, strips scheme, defaults 8006', () => {
  expect(parseEndpoint('pve.example.com')).toEqual({ host: 'pve.example.com', port: 8006 });
  expect(parseEndpoint('pve.example.com:8443')).toEqual({ host: 'pve.example.com', port: 8443 });
  expect(parseEndpoint('https://192.168.1.10:8006')).toEqual({ host: '192.168.1.10', port: 8006 });
  expect(() => parseEndpoint('bad host')).toThrow();
  expect(() => parseEndpoint('pve.example.com:70000')).toThrow();
});

test('isCidr / isIp', () => {
  expect(isCidr('192.168.1.10/24')).toBe(true);
  expect(isCidr('192.168.1.10')).toBe(false);
  expect(isIp('192.168.1.1')).toBe(true);
  expect(isIp('192.168.1.1/24')).toBe(false);
});

test('assertHostInput requires name, endpoint, token id pattern, and secret when asked', () => {
  const ok = { name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!tmuxifier', tokenSecret: 'x', verifyMode: 'pin', fingerprint256: 'AB:CD' };
  expect(() => assertHostInput(ok, { requireSecret: true })).not.toThrow();
  expect(() => assertHostInput({ ...ok, name: '' }, { requireSecret: true })).toThrow(/name/);
  expect(() => assertHostInput({ ...ok, tokenId: 'nope' }, { requireSecret: true })).toThrow(/token id/);
  expect(() => assertHostInput({ ...ok, tokenSecret: '' }, { requireSecret: true })).toThrow(/token secret/);
  expect(() => assertHostInput({ ...ok, tokenSecret: '' }, { requireSecret: false })).not.toThrow();
  expect(() => assertHostInput({ ...ok, verifyMode: 'pin', fingerprint256: '' }, { requireSecret: true })).toThrow(/fingerprint/);
  expect(() => assertHostInput({ ...ok, verifyMode: 'bogus' }, { requireSecret: true })).toThrow(/verifyMode/);
});

test('assertKeyInput requires a name and a single valid public-key line', () => {
  expect(() => assertKeyInput({ name: 'mgmt', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 you@example.com' })).not.toThrow();
  expect(() => assertKeyInput({ name: '', publicKey: 'ssh-ed25519 AAAA' })).toThrow(/name/);
  expect(() => assertKeyInput({ name: 'k', publicKey: 'not a key' })).toThrow(/public key/);
  expect(() => assertKeyInput({ name: 'k', publicKey: 'ssh-ed25519 AAAA\nssh-ed25519 BBBB' })).toThrow(/single/);
});

const PRESET = {
  name: 'dev', hostId: 'h1', template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
  storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
  unprivileged: true, features: { nesting: true },
  net: { bridge: 'vmbr0', vlan: null, ipMode: 'dhcp', cidr: null, gateway: null },
  dns: {}, keyIds: ['k1'], onboot: false, startAfterCreate: true,
};

test('assertPresetInput validates ranges, refs, and static-network completeness', () => {
  const ctx = { hostIds: ['h1'] }; // keyIds ctx removed with the dead param
  expect(() => assertPresetInput(PRESET, ctx)).not.toThrow();
  expect(() => assertPresetInput({ ...PRESET, cores: 0 }, ctx)).toThrow(/cores/);
  expect(() => assertPresetInput({ ...PRESET, diskGiB: 0 }, ctx)).toThrow(/disk/);
  expect(() => assertPresetInput({ ...PRESET, keyIds: [] }, ctx)).not.toThrow(); // keys are no longer preset-scoped
  expect(() => assertPresetInput({ ...PRESET, hostId: 'nope' }, ctx)).toThrow(/host/);
  const staticNet = { ...PRESET, net: { bridge: 'vmbr0', vlan: 5, ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' } };
  expect(() => assertPresetInput(staticNet, ctx)).not.toThrow();
  expect(() => assertPresetInput({ ...staticNet, net: { ...staticNet.net, cidr: 'bad' } }, ctx)).toThrow(/cidr/);
  expect(() => assertPresetInput({ ...staticNet, net: { ...staticNet.net, gateway: 'nope' } }, ctx)).toThrow(/gateway/);
  expect(() => assertPresetInput({ ...PRESET, net: { ...PRESET.net, bridge: 'no spaces!' } }, ctx)).toThrow(/bridge/);
});

test('assertPresetInput validates additional disk mounts', () => {
  const ctx = { hostIds: ['h1'] };
  const ok = { ...PRESET, mounts: [{ id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: '/data', backup: true }] };
  expect(() => assertPresetInput(ok, ctx)).not.toThrow();
  expect(() => assertPresetInput({ ...ok, mounts: [{ id: 'bad', storage: 'local-lvm', sizeGiB: 8, path: '/data' }] }, ctx)).toThrow(/mount id/);
  expect(() => assertPresetInput({ ...ok, mounts: [{ id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: 'relative' }] }, ctx)).toThrow(/path/);
  expect(() => assertPresetInput({ ...ok, mounts: [{ id: 'mp0', storage: 'local-lvm', sizeGiB: 0, path: '/data' }] }, ctx)).toThrow(/size/);
  expect(() => assertPresetInput({ ...ok, mounts: [{ id: 'mp0', storage: 'x', sizeGiB: 8, path: '/a' }, { id: 'mp0', storage: 'x', sizeGiB: 8, path: '/b' }] }, ctx)).toThrow(/duplicate/);
});

test('assertProvisionInput validates hostname, vmid, and ip', () => {
  expect(() => assertProvisionInput({ hostname: 'dev-01' })).not.toThrow();
  expect(() => assertProvisionInput({ hostname: 'Bad_Host' })).toThrow(/hostname/);
  expect(() => assertProvisionInput({ hostname: 'ok', vmid: 50 })).toThrow(/vmid/);
  expect(() => assertProvisionInput({ hostname: 'ok', vmid: 150 })).not.toThrow();
  expect(() => assertProvisionInput({ hostname: 'ok', ip: 'bad' })).toThrow(/ip/);
  expect(() => assertProvisionInput({ hostname: 'ok', tags: ['prod'] })).not.toThrow();
  expect(() => assertProvisionInput({ hostname: 'ok', tags: 'prod' })).toThrow(/tags/);
  expect(() => assertProvisionInput({ hostname: 'ok', tags: [1] })).toThrow(/tags/);
});

test('assertRootPassword requires at least 5 characters', () => {
  expect(() => assertRootPassword('hunter2')).not.toThrow();
  expect(() => assertRootPassword('1234')).toThrow(/5 characters/);
  expect(() => assertRootPassword('')).toThrow(/5 characters/);
  expect(() => assertRootPassword(undefined)).toThrow(/5 characters/);
});
