import { test, expect } from 'vitest';
import { actionsForState, containerMatches } from '../src/web/proxmoxContainers.ts';

test('container actions are state-gated', () => {
  expect(actionsForState('running')).toEqual(['shutdown', 'stop', 'reboot', 'deprovision']);
  expect(actionsForState('stopped')).toEqual(['start', 'deprovision']);
  expect(actionsForState('missing')).toEqual(['deprovision']);
  expect(actionsForState('unknown')).toEqual([]);
});

const C = { boxId: 'B1', boxLabel: 'datumworks01', hostId: 'H1', hostName: 'lab', node: 'proxmox02', vmid: 160, state: 'running' };

test('containerMatches: empty or blank term matches everything', () => {
  expect(containerMatches(C, '')).toBe(true);
  expect(containerMatches(C, '   ')).toBe(true);
});

test('containerMatches: label, host name, node, vmid, and state — case-insensitive substrings', () => {
  expect(containerMatches(C, 'DATUM')).toBe(true);
  expect(containerMatches(C, 'lab')).toBe(true);
  expect(containerMatches(C, 'proxmox02')).toBe(true);
  expect(containerMatches(C, '160')).toBe(true);
  expect(containerMatches(C, 'RUN')).toBe(true);
  expect(containerMatches(C, 'nomatch')).toBe(false);
});

test('containerMatches: falls back to hostId when hostName is null', () => {
  expect(containerMatches({ ...C, hostName: null }, 'h1')).toBe(true);
});
