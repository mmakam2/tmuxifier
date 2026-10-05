import { test, expect } from 'vitest';
import { buildNet0, buildCreateParams, parseNet0, net0Field, describeNet0, buildNet0Readdress, normalizeMac, macOfNet0, cleanGuestName, fingerprintComplete } from '../src/server/proxmoxParams.js';

test('buildNet0 dhcp and static (with vlan + override)', () => {
  expect(buildNet0({ bridge: 'vmbr0', ipMode: 'dhcp' })).toBe('name=eth0,bridge=vmbr0,ip=dhcp');
  expect(buildNet0({ bridge: 'vmbr0', vlan: 5, ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' }))
    .toBe('name=eth0,bridge=vmbr0,tag=5,ip=192.168.1.50/24,gw=192.168.1.1');
  expect(buildNet0({ bridge: 'vmbr0', ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' }, '192.168.1.99/24'))
    .toContain('ip=192.168.1.99/24');
});

// auto-static presets store no cidr (net.cidr is null); the provision flow
// allocates an address from NetBox and passes it as ipOverride. buildNet0
// must take the same ip/gw branch as static once that override is present.
test('buildNet0 auto-static takes the static ip/gw branch via the allocated ipOverride', () => {
  expect(buildNet0({ bridge: 'vmbr0', vlan: 30, ipMode: 'auto-static', cidr: null, gateway: '192.168.30.1' }, '192.168.30.50/24'))
    .toBe('name=eth0,bridge=vmbr0,tag=30,ip=192.168.30.50/24,gw=192.168.30.1');
});

const PRESET = {
  template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst', storage: 'local-lvm',
  diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512, unprivileged: true,
  features: { nesting: true, keyctl: false }, onboot: false,
  net: { bridge: 'vmbr0', ipMode: 'dhcp' }, dns: { nameserver: '1.1.1.1' },
};

test('buildCreateParams maps a preset to PVE fields', () => {
  const p = buildCreateParams(PRESET, { vmid: 123, hostname: 'dev-01', publicKeys: ['ssh-ed25519 AAA a', 'ssh-ed25519 BBB b'] });
  expect(p).toMatchObject({
    vmid: 123, hostname: 'dev-01',
    ostemplate: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
    rootfs: 'local-lvm:8', cores: 2, memory: 2048, swap: 512,
    unprivileged: 1, onboot: 0, net0: 'name=eth0,bridge=vmbr0,ip=dhcp',
    features: 'nesting=1', nameserver: '1.1.1.1',
  });
  expect(p['ssh-public-keys']).toBe('ssh-ed25519 AAA a\nssh-ed25519 BBB b\n');
  expect(p.password).toBeUndefined();
});

test('buildCreateParams sets password only when provided', () => {
  expect(buildCreateParams(PRESET, { vmid: 1, hostname: 'h', publicKeys: [], password: 'sekret' }).password).toBe('sekret');
  expect(buildCreateParams(PRESET, { vmid: 1, hostname: 'h', publicKeys: [] }).password).toBeUndefined();
});

test('buildCreateParams emits mpN params for additional disk mounts', () => {
  const withMounts = { ...PRESET, mounts: [{ id: 'mp0', storage: 'local-lvm', sizeGiB: 8, path: '/data', backup: true }, { id: 'mp1', storage: 'local', sizeGiB: 4, path: '/extra', backup: false }] };
  const p = buildCreateParams(withMounts, { vmid: 1, hostname: 'h', publicKeys: [] });
  expect(p.mp0).toBe('local-lvm:8,mp=/data,backup=1');
  expect(p.mp1).toBe('local:4,mp=/extra');
  expect(buildCreateParams(PRESET, { vmid: 1, hostname: 'h', publicKeys: [] }).mp0).toBeUndefined();
});

test('auto-static net0 takes both overrides; static keeps its stored gateway', () => {
  const autoNet = { bridge: 'vmbr0', vlan: 3, ipMode: 'auto-static', cidr: null, gateway: null };
  expect(buildNet0(autoNet, '192.168.1.5/24', '192.168.1.1'))
    .toBe('name=eth0,bridge=vmbr0,tag=3,ip=192.168.1.5/24,gw=192.168.1.1');
  const staticNet = { bridge: 'vmbr0', vlan: null, ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' };
  expect(buildNet0(staticNet, undefined, undefined))
    .toBe('name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1');
});

const LINE = 'name=eth0,bridge=vmbr0,firewall=1,gw=192.168.20.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.20.5/24,ip6=fd00::5/64,gw6=fd00::1,tag=20,type=veth';

test('parseNet0 keeps every pair in order and rejects what PVE never writes', () => {
  expect(parseNet0(LINE).map(([k]) => k)).toEqual(['name', 'bridge', 'firewall', 'gw', 'hwaddr', 'ip', 'ip6', 'gw6', 'tag', 'type']);
  expect(net0Field(parseNet0(LINE), 'hwaddr')).toBe('BC:24:11:AA:BB:CC');
  expect(net0Field(parseNet0(LINE), 'rate')).toBeNull();
  expect(() => parseNet0('')).toThrow(/empty/);
  expect(() => parseNet0('name=eth0,garbage')).toThrow(/unparseable/);
});

test('buildNet0Readdress rewrites only tag/ip/gw, in place, keeping hwaddr and IPv6 verbatim', () => {
  expect(buildNet0Readdress(parseNet0(LINE), { vlan: 30, ip: '192.168.30.7/24', gateway: '192.168.30.1' }))
    .toBe('name=eth0,bridge=vmbr0,firewall=1,gw=192.168.30.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.30.7/24,ip6=fd00::5/64,gw6=fd00::1,tag=30,type=veth');
});

test('buildNet0Readdress appends the managed keys an untagged dhcp interface lacks', () => {
  const pairs = parseNet0('name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp,type=veth');
  expect(buildNet0Readdress(pairs, { vlan: 30, ip: '192.168.30.7/24', gateway: '192.168.30.1' }))
    .toBe('name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=192.168.30.7/24,type=veth,tag=30,gw=192.168.30.1');
});

test('describeNet0 reads the IPv4 view and nulls dhcp/absent fields', () => {
  expect(describeNet0(parseNet0(LINE))).toEqual({ bridge: 'vmbr0', vlan: 20, ip: '192.168.20.5/24', gateway: '192.168.20.1' });
  expect(describeNet0(parseNet0('name=eth0,bridge=vmbr0,ip=dhcp'))).toEqual({ bridge: 'vmbr0', vlan: null, ip: null, gateway: null });
  expect(describeNet0(parseNet0('name=eth0,bridge=vmbr1,ip=manual,tag=abc,gw=nope'))).toEqual({ bridge: 'vmbr1', vlan: null, ip: null, gateway: null });
});

test('macOfNet0 reads an LXC hwaddr and normalizes its case', () => {
  expect(macOfNet0('lxc', 'name=eth0,bridge=vmbr0,hwaddr=bc:24:11:aa:bb:cc,ip=dhcp')).toBe('BC:24:11:AA:BB:CC');
});

test('macOfNet0 reads a QEMU MAC from the leading NIC-model key, whatever the model', () => {
  for (const model of ['virtio', 'e1000', 'vmxnet3', 'some-future-nic']) {
    expect(macOfNet0('qemu', `${model}=BC:24:11:00:00:01,bridge=vmbr0,firewall=1`)).toBe('BC:24:11:00:00:01');
  }
});

test('macOfNet0 returns null for anything absent or malformed — it never throws', () => {
  expect(macOfNet0('lxc', 'name=eth0,bridge=vmbr0,ip=dhcp')).toBeNull();
  expect(macOfNet0('lxc', '')).toBeNull();
  expect(macOfNet0('lxc', undefined)).toBeNull();
  expect(macOfNet0('lxc', 'garbage')).toBeNull();
  expect(macOfNet0('lxc', 'name=eth0,hwaddr=BC:24:11:AA:BB')).toBeNull();
  expect(macOfNet0('lxc', 'name=eth0,hwaddr=BC:24:11:AA:BB:CC;touch x')).toBeNull();
  expect(macOfNet0('qemu', 'bridge=vmbr0,virtio=BC:24:11:00:00:01')).toBeNull(); // the model key must lead
  expect(macOfNet0('qemu', 'virtio=not-a-mac,bridge=vmbr0')).toBeNull();
  expect(macOfNet0('other', 'hwaddr=BC:24:11:AA:BB:CC')).toBeNull();
});

test('normalizeMac accepts only a six-octet colon MAC', () => {
  expect(normalizeMac(' bc:24:11:aa:bb:cc ')).toBe('BC:24:11:AA:BB:CC');
  expect(normalizeMac('BC-24-11-AA-BB-CC')).toBeNull();
  expect(normalizeMac(42)).toBeNull();
});

test('cleanGuestName allowlists the PVE guest-name shape', () => {
  expect(cleanGuestName('web01')).toBe('web01');
  expect(cleanGuestName('web-01.lab')).toBe('web-01.lab');
  expect(cleanGuestName('web 01')).toBeNull();
  expect(cleanGuestName('-web')).toBeNull();
  expect(cleanGuestName('a'.repeat(64))).toBeNull();
  expect(cleanGuestName(undefined)).toBeNull();
});

test('fingerprintComplete requires both halves, already canonical', () => {
  expect(fingerprintComplete({ name: 'web01', mac: 'BC:24:11:AA:BB:CC' })).toBe(true);
  expect(fingerprintComplete({ name: 'web01', mac: 'bc:24:11:aa:bb:cc' })).toBe(false); // not normalized
  expect(fingerprintComplete({ name: 'web01' })).toBe(false);
  expect(fingerprintComplete({ mac: 'BC:24:11:AA:BB:CC' })).toBe(false);
  expect(fingerprintComplete({ name: 'web 01', mac: 'BC:24:11:AA:BB:CC' })).toBe(false);
  expect(fingerprintComplete(null)).toBe(false);
  expect(fingerprintComplete('web01')).toBe(false);
});
