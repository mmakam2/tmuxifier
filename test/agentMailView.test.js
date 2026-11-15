import { test, expect } from 'vitest';
import {
  nameOf, participant, pairLine, statusLine, threadRow, messageRow, refusalRow, policyChanged, relAge, mailEnabledFrom,
  NO_MIRROR, mirrorOnAdd, mirrorOnRemove, mirrorToSend,
  threadHead, operatorStatus, MAIL_NO_THREADS, MAIL_NO_REFUSALS, messagesLoadError, stopFailedLine,
} from '../src/web/agentMailView.ts';
import { STATUS_KINDS, statusPhrase } from '../src/server/agentMailText.js';

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
  // A box whose ssh master already carries another box's forward (agentMailForward.js) names it.
  expect(statusLine({ state: 'error', installed: null, listening: 0, error: 'shares a connection with orders' }))
    .toBe('Socket not connected: shares a connection with orders');
  // The fail-closed readings when a box's ssh connection cannot be resolved (agentMailForward.js).
  expect(statusLine({ state: 'error', installed: null, listening: 0, error: 'connection not resolved' }))
    .toBe('Socket not connected: connection not resolved');
  // A box that waits names the boxes it waits for: one, two, then the first two and a count.
  for (const error of [
    "waiting for billing's connection to resolve",
    "waiting for billing and search's connections to resolve",
    "waiting for billing, search and 2 more's connections to resolve",
  ]) {
    expect(statusLine({ state: 'error', installed: null, listening: 0, error })).toBe(`Socket not connected: ${error}`);
  }
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
    status: 'waiting: billing/main is working', // the server's 'queued: …', in operator words
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

test('messageRow: sender, delivery state in words ("waiting", "handed over", "delivered", "dropped"), body untouched', () => {
  const t = { ...thread(), v: 1, messages: [] };
  const at = new Date(2026, 10, 14, 9, 5).getTime();
  const body = '<b>not markup</b>\n  indented second line\thttps://example.com/x';
  expect(messageRow({ id: 'm-a', kind: 'task', from: 'starter', body, at, state: 'queued' }, t, boxes))
    .toEqual({ who: 'orders/main', when: '2026-11-14 09:05', state: 'waiting', body });
  expect(messageRow({ id: 'm-b', kind: 'reply', from: 'peer', body: 'ok', at, state: 'handed', handedAt: at, handedPane: '%3' }, t, boxes))
    .toEqual({ who: 'billing/main', when: '2026-11-14 09:05', state: 'handed over', body: 'ok' });
  expect(messageRow({ id: 'm-c', kind: 'reply', from: 'peer', body: 'ok', at, state: 'delivered', deliveredAt: at }, t, boxes).state).toBe('delivered');
  expect(messageRow({ id: 'm-d', kind: 'reply', from: 'peer', body: 'ok', at, state: 'dropped' }, t, boxes).state).toBe('dropped');
  // A state this bundle does not know (a newer server) passes through as it is.
  expect(messageRow({ id: 'm-e', kind: 'reply', from: 'peer', body: 'ok', at, state: 'parked' }, t, boxes).state).toBe('parked');
  // The sender of a removed box still reads as a participant.
  expect(messageRow({ id: 'm-f', kind: 'reply', from: 'peer', body: 'ok', at, state: 'queued' }, { ...t, peer: { boxId: 'gone', session: 'w2' } }, boxes).who).toBe('removed box/w2');
});

test('refusalRow shows the server reason as it is', () => {
  const r = { at: 0, from: { boxId: 'o', session: 'main' }, target: 'billing/main', reason: 'refused: billing/main is not accepting mail from agents' };
  expect(refusalRow(r, boxes, 3 * 3600_000)).toEqual({
    when: '3 h ago', who: 'orders/main', target: 'billing/main', reason: 'refused: billing/main is not accepting mail from agents',
  });
});

test('refusalRow names the sender, the target as typed and the reason', () => {
  // The target is what the agent typed: not resolved against the box list, not re-cased.
  const r = { at: 60_000, from: { boxId: 's', session: 'w1' }, target: 'Billing/MAIN', reason: 'refused: there is no box named Billing' };
  expect(refusalRow(r, boxes, 120_000)).toEqual({
    when: '1 min ago', who: 'search/w1', target: 'Billing/MAIN', reason: 'refused: there is no box named Billing',
  });
  // A thread id typed as the target, from a box removed since.
  expect(refusalRow({ at: 0, from: { boxId: 'gone', session: 'main' }, target: 't-abc23456', reason: 'refused: that thread is closed' }, boxes, 0))
    .toEqual({ when: 'just now', who: 'removed box/main', target: 't-abc23456', reason: 'refused: that thread is closed' });
});

test('a thread with dropped older messages says how many are no longer kept', () => {
  const t = (over) => ({ ...thread(), v: 1, messages: [], ...over });
  expect(threadHead(t({ dropped: 5 }), boxes)).toEqual({
    title: 'orders/main → billing/main', state: 'open', dropped: '5 older messages are no longer kept',
  });
  expect(threadHead(t({ dropped: 1 }), boxes).dropped).toBe('1 older message is no longer kept');
  expect(threadHead(t({ dropped: 0 }), boxes).dropped).toBe(null);
  // The full thread carries `reason` only once closed; the state reads as in the list.
  expect(threadHead(t({ state: 'closed', reason: 'operator' }), boxes).state).toBe('closed by you');
  expect(threadHead(t({ state: 'closed', reason: undefined }), boxes).state).toBe('closed');
});

test('the drawer: empty states and the one-line failures', () => {
  expect(MAIL_NO_THREADS).toBe('No messages yet.');
  expect(MAIL_NO_REFUSALS).toBe('Nothing refused.');
  expect(messagesLoadError('agent messaging is off')).toBe('Messages could not be loaded: agent messaging is off');
  expect(stopFailedLine('no open thread with that id')).toBe('Could not stop this thread: no open thread with that id');
  // A message with a line break still makes one line.
  expect(stopFailedLine('a\nb')).toBe('Could not stop this thread: a b');
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

// The Edit Box section's "also write the matching entry" choice, per list entry.
// `listed` is the list as it was when the modal opened. mirrorToSend returns the
// per-list object the PUT carries; the server mirrors each list only from its own key.
const none = { sendTo: [], receiveFrom: [] };
test('mirror: a box added with the tick on is mirrored; one added with it off is not', () => {
  const draft = { sendTo: ['b'], receiveFrom: [] };
  expect(mirrorToSend(mirrorOnAdd(NO_MIRROR, 'sendTo', 'b', { tick: true, listed: [] }), draft)).toEqual({ sendTo: ['b'], receiveFrom: [] });
  expect(mirrorToSend(mirrorOnAdd(NO_MIRROR, 'sendTo', 'b', { tick: false, listed: [] }), draft)).toEqual(none);
  // A box that was in the list when the modal opened has nothing new to mirror.
  expect(mirrorToSend(mirrorOnAdd(NO_MIRROR, 'sendTo', 'b', { tick: true, listed: ['b'] }), draft)).toEqual(none);
});

test('mirror: removed, then added again with the tick off, is not mirrored', () => {
  let marks = mirrorOnAdd(NO_MIRROR, 'sendTo', 'b', { tick: true, listed: [] });
  marks = mirrorOnRemove(marks, 'sendTo', 'b');
  expect(mirrorToSend(marks, { sendTo: [], receiveFrom: [] })).toEqual(none);
  marks = mirrorOnAdd(marks, 'sendTo', 'b', { tick: false, listed: [] });
  expect(mirrorToSend(marks, { sendTo: ['b'], receiveFrom: [] })).toEqual(none);
  // ...and added again with the tick back on, it is mirrored again.
  expect(mirrorToSend(mirrorOnAdd(marks, 'sendTo', 'b', { tick: true, listed: [] }), { sendTo: ['b'], receiveFrom: [] })).toEqual({ sendTo: ['b'], receiveFrom: [] });
});

test('mirror: added to one list with the tick on and to the other with it off, only the ticked list is mirrored', () => {
  let marks = mirrorOnAdd(NO_MIRROR, 'sendTo', 'b', { tick: true, listed: [] });
  marks = mirrorOnAdd(marks, 'receiveFrom', 'b', { tick: false, listed: [] });
  expect(mirrorToSend(marks, { sendTo: ['b'], receiveFrom: ['b'] })).toEqual({ sendTo: ['b'], receiveFrom: [] });
  // The reverse.
  let rev = mirrorOnAdd(NO_MIRROR, 'sendTo', 'b', { tick: false, listed: [] });
  rev = mirrorOnAdd(rev, 'receiveFrom', 'b', { tick: true, listed: [] });
  expect(mirrorToSend(rev, { sendTo: ['b'], receiveFrom: ['b'] })).toEqual({ sendTo: [], receiveFrom: ['b'] });
  // Ticked in the send list while already in the receive list when the modal opened:
  // the receive entry is not touched.
  const pre = mirrorOnAdd(NO_MIRROR, 'sendTo', 's', { tick: true, listed: [] });
  expect(mirrorToSend(pre, { sendTo: ['s'], receiveFrom: ['s'] })).toEqual({ sendTo: ['s'], receiveFrom: [] });
  // Removing it from the ticked list leaves nothing to mirror.
  marks = mirrorOnRemove(marks, 'sendTo', 'b');
  expect(mirrorToSend(marks, { sendTo: [], receiveFrom: ['b'] })).toEqual(none);
  // A mark on one list never survives in the other: removing from the other list
  // leaves the ticked one standing.
  let both = mirrorOnAdd(NO_MIRROR, 'sendTo', 's', { tick: true, listed: [] });
  both = mirrorOnAdd(both, 'receiveFrom', 's', { tick: true, listed: [] });
  both = mirrorOnRemove(both, 'receiveFrom', 's');
  expect(mirrorToSend(both, { sendTo: ['s'], receiveFrom: [] })).toEqual({ sendTo: ['s'], receiveFrom: [] });
});

test('operatorStatus: every server status phrase reads "waiting" where agents read "queued", the rest unchanged', () => {
  const ctx = { who: 'billing/main', seconds: 12 };
  for (const kind of STATUS_KINDS) {
    const phrase = statusPhrase(kind, ctx);
    const shown = operatorStatus(phrase);
    if (kind === 'queued' || kind.startsWith('queued-')) {
      expect(phrase.startsWith('queued')).toBe(true);
      expect(shown).toBe(`waiting${phrase.slice('queued'.length)}`);
    } else {
      expect(shown).toBe(phrase);
    }
  }
  expect(operatorStatus(statusPhrase('queued-working', ctx))).toBe('waiting: billing/main is working');
  // The phrases without a leading "queued" pass through as they are.
  expect(operatorStatus(statusPhrase('nothing-new', ctx))).toBe('nothing new since the last reply');
  expect(operatorStatus(statusPhrase('closed', ctx))).toBe('closed');
  expect(operatorStatus('queued')).toBe('waiting');
  // Only a leading word is replaced: a box or session named "queued" is left alone.
  expect(operatorStatus('delivered 3 s ago, no reply yet')).toBe('delivered 3 s ago, no reply yet');
  expect(operatorStatus('queuedx: odd')).toBe('queuedx: odd');
  // The thread row shows the operator form.
  expect(threadRow(thread(), boxes, 1_000_000).status).toBe('waiting: billing/main is working');
});
