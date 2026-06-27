import { test, expect } from 'vitest';
import { buildNet0, buildCreateParams } from '../src/server/proxmoxParams.js';

test('buildNet0 dhcp and static (with vlan + override)', () => {
  expect(buildNet0({ bridge: 'vmbr0', ipMode: 'dhcp' })).toBe('name=eth0,bridge=vmbr0,ip=dhcp');
  expect(buildNet0({ bridge: 'vmbr0', vlan: 5, ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' }))
    .toBe('name=eth0,bridge=vmbr0,tag=5,ip=192.168.1.50/24,gw=192.168.1.1');
  expect(buildNet0({ bridge: 'vmbr0', ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' }, '192.168.1.99/24'))
    .toContain('ip=192.168.1.99/24');
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
