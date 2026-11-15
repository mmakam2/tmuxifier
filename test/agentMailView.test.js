import { test, expect } from 'vitest';
import {
  nameOf, participant, pairLine, statusLine, threadRow, messageRow, refusalRow, policyChanged, relAge, mailEnabledFrom,
} from '../src/web/agentMailView.ts';

const boxes = [
  { id: 'o', label: 'orders' },
  { id: 'b', label: 'billing' },
  { id: 's', label: 'search' },
];

test('pairLine says what is missing in the operator words', () => {
  expect(pairLine({ boxId: 's', send: { ok: false, code: 'receive-off' }, receive: null }, boxes, 'orders')).toBe("search   send: waiting, search's receive switch is off");
  expect(pairLine({ boxId: 'b', send: { ok: true }, receive: { ok: true } }, boxes, 'orders')).toBe('billing   send ✓   receive ✓');
});

test('every policy code has a pair wording, in both directions', () => {
  const send = (code) => pairLine({ boxId: 's', send: { ok: false, code }, receive: null }, boxes, 'orders');
  const recv = (code) => pairLine({ boxId: 's', send: null, receive: { ok: false, code } }, boxes, 'orders');
  // orders → search: the sender is this box, the receiver is search.
  expect(send('send-off')).toBe("search   send: waiting, orders's send switch is off");
  expect(send('not-in-send-list')).toBe("search   send: waiting, orders's send list does not include search");
  expect(send('receive-off')).toBe("search   send: waiting, search's receive switch is off");
  expect(send('not-in-receive-list')).toBe("search   send: waiting, search's receive list does not include orders");
  // search → orders: the roles swap.
  expect(recv('send-off')).toBe("search   receive: waiting, search's send switch is off");
  expect(recv('not-in-send-list')).toBe("search   receive: waiting, search's send list does not include orders");
  expect(recv('receive-off')).toBe("search   receive: waiting, orders's receive switch is off");
  expect(recv('not-in-receive-list')).toBe("search   receive: waiting, orders's receive list does not include search");
  // A code this bundle does not know (a newer server) still reads as waiting.
  expect(send('something-new')).toBe('search   send: waiting');
  // Both directions on one line, the send half first.
  expect(pairLine({ boxId: 'b', send: { ok: true }, receive: { ok: false, code: 'send-off' } }, boxes, 'orders'))
    .toBe("billing   send ✓   receive: waiting, billing's send switch is off");
  // A pair naming a box that has since gone.
  expect(pairLine({ boxId: 'gone', send: { ok: true }, receive: null }, boxes, 'orders')).toBe('removed box   send ✓');
});

test('statusLine covers off, down, error, up with and without tools, and 0, 1 and several listeners', () => {
  expect(statusLine({ state: 'off', installed: null, listening: 0 })).toBe('Messaging is off');
  expect(statusLine({ state: 'down', installed: null, listening: 0 })).toBe('Socket not connected: box unreachable');
  for (const error of ['socket path too long', 'bad home', 'forward failed', 'not verified']) {
    expect(statusLine({ state: 'error', installed: null, listening: 0, error })).toBe(`Socket not connected: ${error}`);
  }
  expect(statusLine({ state: 'error', installed: true, listening: 0 })).toBe('Socket not connected');
  expect(statusLine({ state: 'up', installed: false, listening: 0 })).toBe('Tools not installed: run setup on this box');
  expect(statusLine({ state: 'up', installed: true, listening: 0 })).toBe('Tools installed · socket connected · no sessions listening');
  expect(statusLine({ state: 'up', installed: true, listening: 1 })).toBe('Tools installed · socket connected · 1 session listening');
  expect(statusLine({ state: 'up', installed: true, listening: 2 })).toBe('Tools installed · socket connected · 2 sessions listening');
  expect(statusLine({ state: 'up', installed: null, listening: 3 })).toBe('Socket connected · 3 sessions listening');
  expect(statusLine({ state: 'warming', installed: null, listening: 0 })).toBe('Messaging status unknown');
});

const thread = (over = {}) => ({
  id: 't-abc23456',
  starter: { boxId: 'o', session: 'main' },
  peer: { boxId: 'b', session: 'main' },
  state: 'open', reason: null, createdAt: 1_000_000, activeAt: 1_000_000, count: 4, dropped: 0,
  status: 'queued: billing/main is working',
  ...over,
});

test('threadRow: title "orders/main → billing/main", message count, relative time, closed reason in operator words ("closed by you")', () => {
  const now = 1_000_000 + 2 * 60_000;
  expect(threadRow(thread(), boxes, now)).toEqual({
    title: 'orders/main → billing/main',
    meta: '4 messages · 2 min ago',
    state: 'open',
    status: 'queued: billing/main is working',
  });
  expect(threadRow(thread({ count: 1 }), boxes, now).meta).toBe('1 message · 2 min ago');
  expect(threadRow(thread({ count: 3, dropped: 5 }), boxes, now).meta).toBe('3 messages, 5 older dropped · 2 min ago');
  expect(threadRow(thread({ state: 'closed', reason: 'operator', status: 'closed by the operator' }), boxes, now))
    .toMatchObject({ state: 'closed by you', status: 'closed by the operator' });
  expect(threadRow(thread({ state: 'closed', reason: 'permission withdrawn' }), boxes, now).state).toBe('closed: permission withdrawn');
  expect(threadRow(thread({ state: 'closed', reason: 'box removed' }), boxes, now).state).toBe('closed: box removed');
  expect(threadRow(thread({ state: 'closed', reason: null }), boxes, now).state).toBe('closed');
});

test('relAge buckets: just now, minutes, hours, days; a clock ahead of now reads just now', () => {
  expect(relAge(0, 59_000)).toBe('just now');
  expect(relAge(0, 60_000)).toBe('1 min ago');
  expect(relAge(0, 3600_000)).toBe('1 h ago');
  expect(relAge(0, 2 * 86400_000)).toBe('2 d ago');
  expect(relAge(10_000, 0)).toBe('just now');
});

test('a participant whose box was removed reads "removed box/main"', () => {
  expect(nameOf('b', boxes)).toBe('billing');
  expect(nameOf('gone', boxes)).toBe('removed box');
  expect(participant({ boxId: 'gone', session: 'main' }, boxes)).toBe('removed box/main');
  expect(threadRow(thread({ peer: { boxId: 'gone', session: 'main' } }), boxes, 1_000_000).title).toBe('orders/main → removed box/main');
});

test('messageRow names the sender side, the send time and the delivery state, and keeps the body as text', () => {
  const t = { ...thread(), v: 1, messages: [] };
  const at = new Date(2026, 10, 14, 9, 5).getTime();
  const body = '<b>not markup</b>\nsecond line';
  expect(messageRow({ id: 'm-a', kind: 'task', from: 'starter', body, at, state: 'queued' }, t, boxes))
    .toEqual({ who: 'orders/main', when: '2026-11-14 09:05', state: 'queued', body });
  expect(messageRow({ id: 'm-b', kind: 'reply', from: 'peer', body: 'ok', at, state: 'handed', handedAt: at, handedPane: '%3' }, t, boxes))
    .toMatchObject({ who: 'billing/main', state: 'handed, not yet confirmed' });
  expect(messageRow({ id: 'm-c', kind: 'reply', from: 'peer', body: 'ok', at, state: 'delivered', deliveredAt: at }, t, boxes).state).toBe('delivered');
  expect(messageRow({ id: 'm-d', kind: 'reply', from: 'peer', body: 'ok', at, state: 'dropped' }, t, boxes).state).toBe('dropped');
});

test('refusalRow shows the server reason as it is', () => {
  const r = { at: 0, from: { boxId: 'o', session: 'main' }, target: 'billing/main', reason: 'refused: billing/main is not accepting mail from agents' };
  expect(refusalRow(r, boxes, 3 * 3600_000)).toEqual({
    when: '3 h ago', who: 'orders/main', target: 'billing/main', reason: 'refused: billing/main is not accepting mail from agents',
  });
});

test('policyChanged ignores list order and detects each field', () => {
  const base = { send: true, sendTo: ['b', 's'], receive: false, receiveFrom: ['b'] };
  expect(policyChanged(base, { ...base, sendTo: ['s', 'b'] })).toBe(false);
  expect(policyChanged(base, { ...base })).toBe(false);
  expect(policyChanged(base, { ...base, send: false })).toBe(true);
  expect(policyChanged(base, { ...base, receive: true })).toBe(true);
  expect(policyChanged(base, { ...base, sendTo: ['b'] })).toBe(true);
  expect(policyChanged(base, { ...base, sendTo: ['b', 'o'] })).toBe(true);
  expect(policyChanged(base, { ...base, receiveFrom: [] })).toBe(true);
  expect(policyChanged(base, { ...base, receiveFrom: ['s'] })).toBe(true);
});

test('mailEnabledFrom: only an explicit true from /api/ui-config turns messaging on', () => {
  expect(mailEnabledFrom({ termFont: null, agentMail: true })).toBe(true);
  expect(mailEnabledFrom({ agentMail: false })).toBe(false);
  // An older server without the field, a malformed value, or no config at all reads as off.
  expect(mailEnabledFrom({ termFont: null })).toBe(false);
  expect(mailEnabledFrom({ agentMail: 'true' })).toBe(false);
  expect(mailEnabledFrom(null)).toBe(false);
  expect(mailEnabledFrom(undefined)).toBe(false);
});
