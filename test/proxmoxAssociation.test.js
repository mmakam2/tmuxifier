import { test, expect } from 'vitest';
import { associationMutation } from '../src/web/proxmoxAssociation.ts';

const current = { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' };

test('unchanged association produces no API mutation', () => {
  expect(associationMutation(current, { mode: 'linked', hostId: 'H1', node: 'pve', vmid: 131 })).toBeNull();
});

test('changed selection produces a verified link request without endpoint', () => {
  expect(associationMutation(current, { mode: 'linked', hostId: 'H2', node: 'pve2', vmid: 140 })).toEqual({
    kind: 'link', link: { hostId: 'H2', node: 'pve2', vmid: 140 },
  });
});

test('unlink mode produces unlink and incomplete selection throws', () => {
  expect(associationMutation(current, { mode: 'unlinked' })).toEqual({ kind: 'unlink' });
  expect(() => associationMutation(undefined, { mode: 'linked', hostId: 'H1', node: '', vmid: 0 })).toThrow(/select/);
});
