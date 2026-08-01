import { test, expect } from 'vitest';
import { actionsForState, guestMatches, kindLabel } from '../src/web/proxmoxGuests.ts';

test('container actions are state-gated', () => {
  expect(actionsForState('running')).toEqual(['shutdown', 'stop', 'reboot', 'deprovision']);
  expect(actionsForState('stopped')).toEqual(['start', 'deprovision']);
  expect(actionsForState('missing')).toEqual(['deprovision']);
  expect(actionsForState('unknown')).toEqual([]);
});

const C = { boxId: 'B1', boxLabel: 'client01', hostId: 'H1', hostName: 'lab', node: 'pve-n02', vmid: 160, state: 'running' };

test('guestMatches: empty or blank term matches everything', () => {
  expect(guestMatches(C, '')).toBe(true);
  expect(guestMatches(C, '   ')).toBe(true);
});

test('guestMatches: label, host name, node, vmid, and state — case-insensitive substrings', () => {
  expect(guestMatches(C, 'CLIENT')).toBe(true);
  expect(guestMatches(C, 'lab')).toBe(true);
  expect(guestMatches(C, 'pve-n02')).toBe(true);
  expect(guestMatches(C, '160')).toBe(true);
  expect(guestMatches(C, 'RUN')).toBe(true);
  expect(guestMatches(C, 'nomatch')).toBe(false);
});

test('guestMatches: falls back to hostId when hostName is null', () => {
  expect(guestMatches({ ...C, hostName: null }, 'h1')).toBe(true);
});

const guest = (over = {}) => ({
  boxId: 'b1', boxLabel: 'vm-01', hostId: 'H1', hostName: 'lab', node: 'pve',
  vmid: 200, kind: 'qemu', containerName: 'vm-01', state: 'running',
  fetchedAt: 0, error: null, activeJob: null, ...over,
});

test('a kind mismatch offers no lifecycle action at all', () => {
  expect(actionsForState('mismatch')).toEqual([]);
});

test('kindLabel uses PVE shorthand', () => {
  expect(kindLabel('lxc')).toBe('CT');
  expect(kindLabel('qemu')).toBe('VM');
});

test('the filter matches the kind label the row displays', () => {
  expect(guestMatches(guest(), 'vm')).toBe(true);
  expect(guestMatches(guest({ kind: 'lxc', boxLabel: 'ct-01' }), 'ct')).toBe(true);
  expect(guestMatches(guest({ kind: 'lxc', boxLabel: 'ct-01' }), 'vm')).toBe(false);
  expect(guestMatches(guest(), '')).toBe(true);
});
