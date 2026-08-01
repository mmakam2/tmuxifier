import { test, expect } from 'vitest';
import { associationMutation, associationSectionVisible } from '../src/web/proxmoxAssociation.ts';

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

test('add mode with an untouched picker produces no mutation', () => {
  // current === undefined models add mode (no box yet); an unlinked draft must be a no-op.
  expect(associationMutation(undefined, { mode: 'unlinked' })).toBeNull();
});

test('association section hides only for unlinked boxes with no Proxmox hosts', () => {
  expect(associationSectionVisible(0, false)).toBe(false);
  expect(associationSectionVisible(1, false)).toBe(true);
  expect(associationSectionVisible(0, true)).toBe(true); // a stale link must stay visible to unlink
  expect(associationSectionVisible(2, true)).toBe(true);
});

test('changing only the kind is a real mutation, not a no-op', () => {
  const current = { hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc' };
  // Same coordinates, different type: vmid 131 was recreated as a VM, and the
  // operator is re-linking to clear the mismatch. Comparing only hostId/node/
  // vmid would report "nothing changed" and silently skip the write.
  expect(associationMutation(current, { mode: 'linked', hostId: 'H1', node: 'pve', vmid: 131, kind: 'qemu' }))
    .toEqual({ kind: 'link', link: { hostId: 'H1', node: 'pve', vmid: 131, kind: 'qemu' } });
  expect(associationMutation(current, { mode: 'linked', hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc' }))
    .toBeNull();
});
