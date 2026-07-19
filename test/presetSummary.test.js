import { test, expect } from 'vitest';
import { presetSummary } from '../src/web/presetSummary.ts';

const base = {
  id: 'p1', name: 'debian_vlan3_autostatic', hostId: 'h1', node: null,
  template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
  storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
  unprivileged: true, features: {},
  net: { bridge: 'vmbr0', vlan: 3, ipMode: 'auto-static', cidr: null, gateway: null },
  dns: { nameserver: null, searchdomain: null }, mounts: [], onboot: false,
  startAfterCreate: true, boxDefaults: { user: 'root', sessionName: 'web', tags: [] },
  createdAt: '2026-07-19T00:00:00.000Z',
};

test('full auto-static preset: basename, cores/mem, disk, vlan, ip mode', () => {
  expect(presetSummary(base)).toBe('debian-12-standard_12.7-1_amd64 · 2c / 2 GiB · disk 8 GiB · vlan 3 · IP auto (NetBox)');
});

test('no vlan + dhcp drops the vlan part and says DHCP', () => {
  const p = { ...base, net: { ...base.net, vlan: null, ipMode: 'dhcp' } };
  expect(presetSummary(p)).toBe('debian-12-standard_12.7-1_amd64 · 2c / 2 GiB · disk 8 GiB · DHCP');
});

test('static ip mode and fractional GiB memory', () => {
  const p = { ...base, memoryMiB: 1536, net: { ...base.net, ipMode: 'static' } };
  expect(presetSummary(p)).toBe('debian-12-standard_12.7-1_amd64 · 2c / 1.5 GiB · disk 8 GiB · vlan 3 · static IP');
});
