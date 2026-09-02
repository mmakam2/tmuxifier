import { test, expect } from 'vitest';
import { vlanOptionLabel, currentNetLine } from '../src/web/proxmoxReaddress.ts';

test('vlanOptionLabel: vid · name · prefix, with the reason when not allocatable and "unnamed" for a blank name', () => {
  expect(vlanOptionLabel({ vid: 30, name: 'servers', prefix: '192.168.30.0/24', allocatable: true })).toBe('30 · servers · 192.168.30.0/24');
  expect(vlanOptionLabel({ vid: 40, name: 'lab', prefix: '192.168.40.0/24', allocatable: false, reason: 'VLAN 40 maps to 2 NetBox prefixes' }))
    .toBe('40 · lab · 192.168.40.0/24 — VLAN 40 maps to 2 NetBox prefixes');
  expect(vlanOptionLabel({ vid: 50, name: '', prefix: '192.168.50.0/24', allocatable: true })).toBe('50 · unnamed · 192.168.50.0/24');
});

test('currentNetLine: bridge · VLAN · ip · gw, with untagged/dhcp stand-ins and no gw segment when absent', () => {
  expect(currentNetLine({ hostname: 'dev-01', bridge: 'vmbr0', vlan: 20, ip: '192.168.20.5/24', gateway: '192.168.20.1' }))
    .toBe('vmbr0 · VLAN 20 · 192.168.20.5/24 · gw 192.168.20.1');
  expect(currentNetLine({ hostname: null, bridge: 'vmbr0', vlan: null, ip: null, gateway: null })).toBe('vmbr0 · untagged · dhcp');
  expect(currentNetLine({ hostname: null, bridge: null, vlan: 5, ip: null, gateway: null })).toBe('? · VLAN 5 · dhcp');
});
