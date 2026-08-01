import { test, expect } from 'vitest';
import { associationMutation, associationSectionVisible, guestOptionDisabled, guestOptionLabel, guestOptionValue, parseGuestOption } from '../src/web/proxmoxAssociation.ts';

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

test('guestOptionValue/parseGuestOption round-trip both kinds', () => {
  expect(guestOptionValue({ kind: 'qemu', vmid: 131 })).toBe('qemu:131');
  expect(guestOptionValue({ kind: 'lxc', vmid: 200 })).toBe('lxc:200');
  expect(parseGuestOption('qemu:131')).toEqual({ kind: 'qemu', vmid: 131 });
  expect(parseGuestOption('lxc:200')).toEqual({ kind: 'lxc', vmid: 200 });
  // Round trip: decode(encode(x)) === x for both kinds.
  for (const item of [{ kind: 'qemu', vmid: 131 }, { kind: 'lxc', vmid: 200 }]) {
    expect(parseGuestOption(guestOptionValue(item))).toEqual(item);
  }
});

test('parseGuestOption: an unrecognized kind token defaults to lxc, never qemu', () => {
  expect(parseGuestOption('bogus:5').kind).toBe('lxc');
});

// The empty string is what a select's value becomes when nothing is assigned
// to it (or it is explicitly cleared) — Finding 2's fail-closed fix depends on
// this producing a vmid that associationMutation's Number.isInteger guard
// rejects, not a number that happens to collide with a real guest.
test('parseGuestOption: the empty string (no selection) yields an unusable, non-integer vmid', () => {
  const parsed = parseGuestOption('');
  expect(Number.isInteger(parsed.vmid)).toBe(false);
});

// F1: a qemu template must never be selectable — linking to one and then
// hitting Deprovision from the Guests tab would destroy the template every
// future clone depends on. It gets the same shown-but-disabled treatment as
// a guest already linked to a different box.
test('guestOptionDisabled: a template is disabled regardless of link state', () => {
  expect(guestOptionDisabled({ template: true, linkedBoxId: null })).toBe(true);
  expect(guestOptionDisabled({ template: true, linkedBoxId: 'b1' }, 'b1')).toBe(true);
});

test('guestOptionDisabled: a plain guest is disabled only when linked to a different box', () => {
  expect(guestOptionDisabled({ template: false, linkedBoxId: null })).toBe(false);
  expect(guestOptionDisabled({ template: false, linkedBoxId: 'b1' }, 'b1')).toBe(false);
  expect(guestOptionDisabled({ template: false, linkedBoxId: 'b1' }, 'b2')).toBe(true);
});

test('guestOptionLabel: a template is visibly marked, not silently hidden', () => {
  const item = { hostId: 'H1', node: 'pve', kind: 'qemu', vmid: 300, name: 'vm-template', state: 'stopped', linkedBoxId: null, template: true };
  expect(guestOptionLabel(item)).toBe('300 | VM | vm-template | stopped | TEMPLATE');
});

test('guestOptionLabel: a non-template guest carries no TEMPLATE marker', () => {
  const item = { hostId: 'H1', node: 'pve', kind: 'lxc', vmid: 131, name: 'dev-01', state: 'running', linkedBoxId: null, template: false };
  expect(guestOptionLabel(item)).toBe('131 | CT | dev-01 | running');
});

test('guestOptionLabel: template and linked-elsewhere markers combine', () => {
  const item = { hostId: 'H1', node: 'pve', kind: 'qemu', vmid: 300, name: 'vm-template', state: 'stopped', linkedBoxId: 'other', template: true };
  expect(guestOptionLabel(item, 'me')).toBe('300 | VM | vm-template | stopped | TEMPLATE | linked');
});
