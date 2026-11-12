import { test, expect } from 'vitest';
import { planCommit } from '../src/web/agentSwitcherCommit.ts';

const plan = (target, panes, focused, parked, sess) =>
  planCommit({ target, panes, focused, parked, sessionOf: (iid) => sess[iid] ?? 'local' });

test('already open in a docked pane: focus it, even when it is not the focused pane', () => {
  expect(plan({ boxId: 'y', session: 't1' }, ['x#1', 'y#1'], 'x#1', [], { 'x#1': 's', 'y#1': 't1' }))
    .toEqual({ kind: 'focus', paneId: 'y#1' });
});

test('first matching docked pane in layout order wins over the focused one', () => {
  expect(plan({ boxId: 'y', session: 't1' }, ['y#1', 'y#2'], 'y#2', [], { 'y#1': 't1', 'y#2': 't1' }))
    .toEqual({ kind: 'focus', paneId: 'y#1' });
});

test('Host Shell docked is always a focus', () => {
  expect(plan({ boxId: '__local__', session: 'local' }, ['x#1', '__local__#1'], 'x#1', [], { 'x#1': 's' }))
    .toEqual({ kind: 'focus', paneId: '__local__#1' });
});

test('same box, different session: switch the focused pane', () => {
  expect(plan({ boxId: 'x', session: 't2' }, ['x#1', 'y#1'], 'y#1', [], { 'x#1': 't1', 'y#1': 's' }))
    .toEqual({ kind: 'replace', occupant: 'y#1', iid: 'x#2', resetTab: false });
  expect(plan({ boxId: 'x', session: 't2' }, ['y#1', 'x#1'], 'x#1', [], { 'x#1': 't1', 'y#1': 's' }))
    .toEqual({ kind: 'switch', paneId: 'x#1' });
});

test('same box wins over a parked tab on that session', () => {
  expect(plan({ boxId: 'x', session: 't2' }, ['x#1'], 'x#1', ['x#2'], { 'x#1': 't1', 'x#2': 't2' }))
    .toEqual({ kind: 'switch', paneId: 'x#1' });
});

test("different box: the focused pane is replaced by the box's lowest undocked ordinal", () => {
  expect(plan({ boxId: 'y', session: 't1' }, ['x#1'], 'x#1', [], { 'x#1': 's' }))
    .toEqual({ kind: 'replace', occupant: 'x#1', iid: 'y#1', resetTab: false });
});

test('different box already docked on another session elsewhere: the next ordinal is used', () => {
  expect(plan({ boxId: 'y', session: 't2' }, ['x#1', 'y#1'], 'x#1', [], { 'x#1': 's', 'y#1': 't1' }))
    .toEqual({ kind: 'replace', occupant: 'x#1', iid: 'y#2', resetTab: false });
});

test('a parked tab already on the target session is preferred over the lowest ordinal', () => {
  expect(plan({ boxId: 'y', session: 't2' }, ['x#1'], 'x#1', ['y#1', 'y#3'], { 'x#1': 's', 'y#1': 't1', 'y#3': 't2' }))
    .toEqual({ kind: 'replace', occupant: 'x#1', iid: 'y#3', resetTab: false });
});

test('several parked tabs on the target session: the lowest ordinal', () => {
  expect(plan({ boxId: 'y', session: 't2' }, ['x#1'], 'x#1', ['y#4', 'y#2'], { 'x#1': 's', 'y#4': 't2', 'y#2': 't2' }))
    .toEqual({ kind: 'replace', occupant: 'x#1', iid: 'y#2', resetTab: false });
});

test('a parked tab on a different session at the chosen ordinal must be reset', () => {
  expect(plan({ boxId: 'y', session: 't2' }, ['x#1'], 'x#1', ['y#1'], { 'x#1': 's', 'y#1': 't1' }))
    .toEqual({ kind: 'replace', occupant: 'x#1', iid: 'y#1', resetTab: true });
});

test('no focused pane: the first pane is the occupant', () => {
  const sess = { 'x#1': 's', 'z#1': 's' };
  const want = { kind: 'replace', occupant: 'x#1', iid: 'y#1', resetTab: false };
  expect(plan({ boxId: 'y', session: 't1' }, ['x#1', 'z#1'], null, [], sess)).toEqual(want);
  expect(plan({ boxId: 'y', session: 't1' }, ['x#1', 'z#1'], 'gone#1', [], sess)).toEqual(want);
});

test('nothing docked: open as the first pane', () => {
  expect(plan({ boxId: 'y', session: 't1' }, [], null, [], {}))
    .toEqual({ kind: 'open', iid: 'y#1', resetTab: false });
});

test('nothing docked and a parked tab on another session: open with a reset', () => {
  expect(plan({ boxId: 'y', session: 't2' }, [], null, ['y#1'], { 'y#1': 't1' }))
    .toEqual({ kind: 'open', iid: 'y#1', resetTab: true });
});

test('Host Shell not docked takes the slot as __local__#1', () => {
  expect(plan({ boxId: '__local__', session: 'local' }, ['x#1'], 'x#1', ['__local__#1'], { 'x#1': 's' }))
    .toEqual({ kind: 'replace', occupant: 'x#1', iid: '__local__#1', resetTab: false });
  expect(plan({ boxId: '__local__', session: 'local' }, [], null, [], {}))
    .toEqual({ kind: 'open', iid: '__local__#1', resetTab: false });
});

test('a Host Shell occupant is replaced like any pane', () => {
  expect(plan({ boxId: 'y', session: 't1' }, ['__local__#1'], '__local__#1', [], {}))
    .toEqual({ kind: 'replace', occupant: '__local__#1', iid: 'y#1', resetTab: false });
});
