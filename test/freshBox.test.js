import { test, expect } from 'vitest';
import { freshBoxFrom } from '../src/web/freshBox.ts';

const cached = { id: 'b1', label: 'web01', host: '192.168.1.10', proxmox: { hostId: 'H1', node: 'a1n', vmid: 120, kind: 'lxc' } };

test('the server copy wins: a link the server re-homed since page load is what the modal shows', () => {
  const moved = { ...cached, proxmox: { hostId: 'H2', node: 'b1n', vmid: 305, kind: 'lxc' } };
  expect(freshBoxFrom([{ id: 'b0' }, moved], cached)).toBe(moved);
});

test('a failed fetch falls back to the cached box', () => {
  expect(freshBoxFrom(null, cached)).toBe(cached);
});

test('a box the fresh list no longer has falls back to the cached box', () => {
  expect(freshBoxFrom([{ id: 'other' }], cached)).toBe(cached);
});
