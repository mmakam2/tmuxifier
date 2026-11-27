import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolveTarget } from '../src/server/agentMailHub.js';
import { refusalText, renderThread, renderWho } from '../src/server/agentMailText.js';
import { createMailHarness, O, B, mark, paneMark, paneRow } from './helpers/agentMailHarness.js';

let h; let boxes; let marks; let store; let hub; let setPolicy; let names;

beforeEach(async () => {
  h = await createMailHarness();
  ({ boxes, marks, store, hub, setPolicy, names } = h);
});
afterEach(() => h.cleanup());

describe('agentMailHub: send', () => {
  test('send creates a thread and queues the first message', async () => {
    const r = await hub.send({ boxId: 'o', session: 'main' }, 'billing', 'ping');
    expect(r.ok).toBe(true);
    expect(store.thread(r.threadId).messages[0]).toMatchObject({ kind: 'task', from: 'starter', state: 'queued', body: 'ping' });
    expect(store.thread(r.threadId)).toMatchObject({ state: 'open', starter: O, peer: B });
    expect(r.text).toBe(`Sent. Thread ${r.threadId}. queued: billing/main is working`);
    expect(store.refusals()).toEqual([]);
  });

  test('the body is stored cleaned: controls stripped, CRLF folded, trailing space trimmed', async () => {
    const r = await hub.send(O, 'billing', 'a\x1b[31m\r\nb\x07  \n');
    expect(store.thread(r.threadId).messages[0].body).toBe('a[31m\nb');
  });

  test('a bare name goes to the box configured session; name/session goes to that session', async () => {
    boxes[1].sessionName = 'work';
    marks.b = { work: mark('working'), review: mark('working') };
    const bare = await hub.send(O, 'billing', 'one');
    expect(store.thread(bare.threadId).peer).toEqual({ boxId: 'b', session: 'work' });
    const named = await hub.send(O, 'billing/review', 'two');
    expect(store.thread(named.threadId).peer).toEqual({ boxId: 'b', session: 'review' });
    expect(resolveTarget('billing', boxes, 'o')).toEqual({ box: boxes[1], session: 'work', bare: true });
    expect(resolveTarget('  billing/review  ', boxes, 'o')).toEqual({ box: boxes[1], session: 'review', bare: false });
  });

  test('label matching ignores case; a label containing a slash and a space resolves; "db primary/review" splits at the last slash', async () => {
    const lab = { id: 'l', label: 'lab/db primary', sessionName: 'main' };
    const db = { id: 'd', label: 'DB Primary', sessionName: 'main' };
    boxes.push(lab, db);
    expect(resolveTarget('BILLING', boxes, 'o')).toEqual({ box: boxes[1], session: 'main', bare: true });
    expect(resolveTarget('Lab/DB Primary', boxes, 'o')).toEqual({ box: lab, session: 'main', bare: true });
    expect(resolveTarget('lab/db primary/review', boxes, 'o')).toEqual({ box: lab, session: 'review', bare: false });
    expect(resolveTarget('db primary/review', boxes, 'o')).toEqual({ box: db, session: 'review', bare: false });
    expect(resolveTarget('db primary', boxes, 'o')).toEqual({ box: db, session: 'main', bare: true });
    // the right side of the split must be a valid session name; no other match is attempted
    expect(resolveTarget('db primary/bad name', boxes, 'o')).toBeNull();
    expect(resolveTarget('nosuch/main', boxes, 'o')).toBeNull();
    expect(resolveTarget('/main', boxes, 'o')).toBeNull();
    expect(resolveTarget('', boxes, 'o')).toBeNull();
    expect(resolveTarget(42, boxes, 'o')).toBeNull();
    // a name matching more than one box is refused
    expect(resolveTarget('twin', [...boxes, { id: 't1', label: 'Twin', sessionName: 'main' }, { id: 't2', label: 'twin', sessionName: 'main' }], 'o')).toBeNull();

    // end to end through send, with the policy that lets o reach d
    await setPolicy('o', { send: true, sendTo: ['b', 'd'] });
    await setPolicy('d', { receive: true, receiveFrom: ['o'] });
    marks.d = { review: mark('working') };
    const r = await hub.send(O, 'DB PRIMARY/review', 'hi');
    expect(r.ok).toBe(true);
    expect(store.thread(r.threadId).peer).toEqual({ boxId: 'd', session: 'review' });
    expect(r.text).toBe(`Sent. Thread ${r.threadId}. queued: DB Primary/review is working`);
  });

  test('"." and "./review" address the caller own box', async () => {
    expect(resolveTarget('.', boxes, 'o')).toEqual({ box: boxes[0], session: 'main', bare: true });
    expect(resolveTarget('./review', boxes, 'o')).toEqual({ box: boxes[0], session: 'review', bare: false });
    expect(resolveTarget('./review', boxes, 'b')).toEqual({ box: boxes[1], session: 'review', bare: false });
    expect(resolveTarget('./', boxes, 'o')).toBeNull();
    expect(resolveTarget('./bad name', boxes, 'o')).toBeNull();
    expect(resolveTarget('.', boxes, 'gone')).toBeNull();

    await setPolicy('o', { send: true, receive: true, sendTo: ['b'] });
    marks.o.review = mark('ready');
    const r = await hub.send(O, './review', 'look at this');
    expect(r.ok).toBe(true);
    expect(store.thread(r.threadId)).toMatchObject({ starter: O, peer: { boxId: 'o', session: 'review' } });
    expect(r.text).toBe(`Sent. Thread ${r.threadId}. queued: orders/review is not listening`);
  });

  test('unknown box, own session, empty body, 65537-byte body are refused and logged', async () => {
    const typed = `no\x1b[2Jsuch\u202e${'x'.repeat(300)}`;
    const cleanTyped = `no[2Jsuch${'x'.repeat(191)}`;
    expect(cleanTyped).toHaveLength(200);
    const unknown = await hub.send(O, typed, 'ping');
    expect(unknown).toEqual({ ok: false, text: refusalText('unknown-box', { target: cleanTyped }) });

    // an explicit own session is refused; a bare own-box name skips the caller's own session and
    // finds no other agent here (agent workers spec 5.3)
    const own = await hub.send(O, 'orders/main', 'ping');
    expect(own).toEqual({ ok: false, text: refusalText('own-session') });
    const ownDot = await hub.send(O, './main', 'ping');
    expect(ownDot).toEqual({ ok: false, text: refusalText('own-session') });
    await setPolicy('o', { send: true, receive: true, sendTo: ['b'] });
    const bareOwn = await hub.send(O, 'orders', 'ping');
    expect(bareOwn).toEqual({ ok: false, text: refusalText('no-other-agent', { target: 'orders' }) });
    await setPolicy('o', { send: true, sendTo: ['b'] });

    const empty = await hub.send(O, 'billing', ' \n\t\x00 ');
    expect(empty).toEqual({ ok: false, text: refusalText('empty') });

    const big = await hub.send(O, 'billing', 'x'.repeat(65537));
    expect(big).toEqual({ ok: false, text: refusalText('too-large') });
    expect((await hub.send(O, 'billing', 'x'.repeat(65536))).ok).toBe(true);

    expect(store.threads()).toHaveLength(1);
    expect(store.refusals().reverse()).toEqual([
      { at: h.clock, from: O, target: cleanTyped, reason: refusalText('unknown-box', { target: cleanTyped }) },
      { at: h.clock, from: O, target: 'orders/main', reason: refusalText('own-session') },
      { at: h.clock, from: O, target: './main', reason: refusalText('own-session') },
      { at: h.clock, from: O, target: 'orders', reason: refusalText('no-other-agent', { target: 'orders' }) },
      { at: h.clock, from: O, target: 'billing', reason: refusalText('empty') },
      { at: h.clock, from: O, target: 'billing', reason: refusalText('too-large') },
    ]);
  });

  test('each policy failure is refused with its own wording and logged', async () => {
    const cases = [
      ['send-off', async () => setPolicy('o', { send: false, sendTo: ['b'] })],
      ['not-in-send-list', async () => setPolicy('o', { send: true, sendTo: [] })],
      ['receive-off', async () => setPolicy('b', { receive: false, receiveFrom: ['o'] })],
      ['not-in-receive-list', async () => setPolicy('b', { receive: true, receiveFrom: [] })],
    ];
    for (const [code, change] of cases) {
      await setPolicy('o', { send: true, sendTo: ['b'] });
      await setPolicy('b', { receive: true, receiveFrom: ['o'] });
      await change();
      const r = await hub.send(O, 'Billing', 'ping');
      expect(r).toEqual({ ok: false, text: refusalText(code, { target: 'Billing' }) });
      expect(store.refusals()[0]).toEqual({ at: h.clock, from: O, target: 'Billing', reason: r.text });
    }
    expect(new Set(store.refusals().map((x) => x.reason)).size).toBe(4);
    expect(store.threads()).toEqual([]);
  });

  test('a box with send off learns nothing about which boxes exist: send-off comes before the target is looked up', async () => {
    await setPolicy('o', { send: false, sendTo: ['b'] });
    const off = refusalText('send-off');
    for (const target of ['billing', 'nosuchbox', 'nosuchbox/main', 'orders', '.', '']) {
      expect(await hub.send(O, target, 'ping'), target).toEqual({ ok: false, text: off });
    }
    expect(store.refusals().map((r) => [r.target, r.reason])).toEqual(
      ['', '.', 'orders', 'nosuchbox/main', 'nosuchbox', 'billing'].map((t) => [t, off]),
    );
    expect(store.threads()).toEqual([]);
    // With send on, an unknown name is still told apart.
    await setPolicy('o', { send: true, sendTo: ['b'] });
    expect((await hub.send(O, 'nosuchbox', 'ping')).text).toBe(refusalText('unknown-box', { target: 'nosuchbox' }));
  });

  test('target box unreachable (paneMarksOf null) and target session without a marker are refused', async () => {
    delete marks.b;
    const down = await hub.send(O, 'Billing', 'ping');
    expect(down).toEqual({ ok: false, text: 'Billing is unreachable right now; try again shortly' });
    expect(down.text).toBe(refusalText('unreachable', { target: 'Billing' }));

    marks.b = { main: mark('ready') };
    const noAgent = await hub.send(O, 'billing/review', 'ping');
    expect(noAgent).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/review' }) });

    expect(store.threads()).toEqual([]);
    expect(store.refusals().map((x) => x.reason)).toEqual([noAgent.text, down.text]);
  });

  test('the status phrase follows the target marker', async () => {
    marks.b.main = mark('blocked', 'permission');
    expect((await hub.send(O, 'billing', 'a')).text).toMatch(/^Sent\. Thread t-[a-hj-km-np-z2-9]{8}\. queued: billing\/main is waiting on its operator$/);
    marks.b.main = mark('ready');
    expect((await hub.send(O, 'billing', 'b')).text).toMatch(/\. queued: billing\/main is not listening$/);
  });
});

describe('agentMailHub: callers', () => {
  test('a caller whose session has no marker cannot send or reply; it can still read and inbox', async () => {
    const s = await hub.send(O, 'billing', 'ping');
    expect((await hub.reply(B, s.threadId, 'pong')).ok).toBe(true);

    delete marks.o.main;
    const noAgent = refusalText('no-agent', { who: 'orders/main' });
    expect(await hub.send(O, 'billing', 'again')).toEqual({ ok: false, text: noAgent });
    expect(await hub.reply(O, s.threadId, 'more')).toEqual({ ok: false, text: noAgent });
    expect(await hub.who(O)).toEqual({ ok: false, text: noAgent });
    expect(store.refusals().map((r) => [r.target, r.reason])).toEqual([['', noAgent], [s.threadId, noAgent], ['billing', noAgent]]);

    const inbox = await hub.inbox(O);
    expect(inbox.ok).toBe(true);
    expect(inbox.text).toContain('pong');
    const read = await hub.read(O, s.threadId);
    expect(read.ok).toBe(true);
    expect(read.text).toContain('pong');

    // an unreachable caller box reads as no agent too
    delete marks.o;
    expect((await hub.send(O, 'billing', 'again')).text).toBe(noAgent);
    expect((await hub.inbox(O)).ok).toBe(true);
  });

  test('an invalid session name is refused by every operation, before anything is read or logged', async () => {
    const s = await hub.send(O, 'billing', 'ping');
    for (const bad of [{ boxId: 'o', session: 'bad name' }, { boxId: 'o', session: '' }, { boxId: 'o' }, null, { boxId: '', session: 'main' }]) {
      expect((await hub.who(bad)).ok).toBe(false);
      expect((await hub.send(bad, 'billing', 'x')).ok).toBe(false);
      expect((await hub.reply(bad, s.threadId, 'x')).ok).toBe(false);
      expect((await hub.read(bad, s.threadId)).ok).toBe(false);
      expect((await hub.inbox(bad)).ok).toBe(false);
    }
    expect(store.refusals()).toEqual([]);
    expect(store.thread(s.threadId).messages).toHaveLength(1);
  });

  test('a session named __proto__ is not running an agent unless it has its own marker', async () => {
    const P = { boxId: 'o', session: '__proto__' };
    expect(await hub.send(P, 'billing', 'x')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'orders/__proto__' }) });
    expect(await hub.send(O, 'billing/__proto__', 'x')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/__proto__' }) });
    expect(await hub.send(O, 'billing/constructor', 'x')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/constructor' }) });

    marks.b = JSON.parse('{"main":{"state":"working","cause":"prompt","ts":1},"__proto__":{"state":"ready","cause":"stop","ts":1}}');
    expect(Object.hasOwn(marks.b, '__proto__')).toBe(true);
    const r = await hub.send(O, 'billing/__proto__', 'x');
    expect(r.ok).toBe(true);
    expect(store.thread(r.threadId).peer).toEqual({ boxId: 'b', session: '__proto__' });
  });
});

describe('agentMailHub: reply', () => {
  test('reply by a participant queues a message for the other side; a non-participant is refused', async () => {
    const s = await hub.send(O, 'billing', 'ping');
    const back = await hub.reply(B, s.threadId, 'pong');
    expect(back).toEqual({ ok: true, text: `Sent. Thread ${s.threadId}. queued: orders/main is working` });
    const again = await hub.reply(O, s.threadId, 'thanks');
    expect(again.ok).toBe(true);
    expect(again.text).toBe(`Sent. Thread ${s.threadId}. queued: billing/main is working`);
    expect(store.thread(s.threadId).messages.map((m) => [m.kind, m.from, m.state, m.body])).toEqual([
      ['task', 'starter', 'queued', 'ping'],
      ['reply', 'peer', 'queued', 'pong'],
      ['reply', 'starter', 'queued', 'thanks'],
    ]);

    marks.b.review = mark('working');
    const outsider = await hub.reply({ boxId: 'b', session: 'review' }, s.threadId, 'me too');
    expect(outsider).toEqual({ ok: false, text: refusalText('not-a-participant') });
    const unknown = await hub.reply(B, 't-zzzzzzzz', 'pong');
    expect(unknown).toEqual({ ok: false, text: refusalText('not-a-participant') });
    expect(store.refusals().map((r) => [r.from, r.target, r.reason])).toEqual([
      [B, 't-zzzzzzzz', refusalText('not-a-participant')],
      [{ boxId: 'b', session: 'review' }, s.threadId, refusalText('not-a-participant')],
    ]);
    expect(store.thread(s.threadId).messages).toHaveLength(3);
  });

  test('reply body rules match send, and a closed thread refuses replies', async () => {
    const s = await hub.send(O, 'billing', 'ping');
    expect(await hub.reply(B, s.threadId, '  ')).toEqual({ ok: false, text: refusalText('empty') });
    expect(await hub.reply(B, s.threadId, 'x'.repeat(65537))).toEqual({ ok: false, text: refusalText('too-large') });
    store.closeThread(s.threadId, 'operator');
    const closed = await hub.reply(B, s.threadId, 'pong');
    expect(closed.ok).toBe(false);
    expect(closed.text).toBe('refused: this thread is closed. Do not start a new thread for the same matter; tell your operator instead.\nclosed by the operator');
    expect(store.refusals()[0]).toEqual({ at: h.clock, from: B, target: s.threadId, reason: closed.text });
    expect(store.thread(s.threadId).messages).toHaveLength(1);
  });

  test('reply after the permission was withdrawn closes the thread and is refused', async () => {
    const s = await hub.send(O, 'billing', 'ping');
    await setPolicy('b', { receive: false, receiveFrom: ['o'] });
    const r = await hub.reply(B, s.threadId, 'pong');
    expect(r).toEqual({ ok: false, text: `${refusalText('closed')}\nclosed: permission withdrawn` });
    const t = store.thread(s.threadId);
    expect(t).toMatchObject({ state: 'closed', reason: 'permission withdrawn' });
    expect(t.messages.map((m) => m.state)).toEqual(['dropped']);
    expect(store.refusals()[0]).toMatchObject({ from: B, target: s.threadId, reason: r.text });
    // the recipient never reads the dropped body; the sender still sees its own words
    const recipientView = await hub.read(B, s.threadId);
    expect(recipientView.ok).toBe(true);
    expect(recipientView.text).not.toContain('ping');
    expect(recipientView.text).toContain('[not delivered]');
    expect(recipientView.text).toContain('closed: permission withdrawn');
    const senderView = await hub.read(O, s.threadId);
    expect(senderView.text).toContain('ping');
    expect(senderView.text).not.toContain('[not delivered]');
    expect(store.thread(s.threadId).messages[0].body).toBe('ping');
    // turning it back on does not reopen the thread
    await setPolicy('b', { receive: true, receiveFrom: ['o'] });
    expect((await hub.reply(B, s.threadId, 'pong')).text).toBe(r.text);
  });
});

describe('agentMailHub: read and inbox', () => {
  test('read marks the caller messages delivered and returns the whole thread; inbox does the same for undelivered ones', async () => {
    const s = await hub.send(O, 'billing', 'ping');
    h.clock += 1000;
    await hub.reply(B, s.threadId, 'pong');
    h.clock += 1000;

    const r = await hub.read(B, s.threadId);
    expect(r.ok).toBe(true);
    const t = store.thread(s.threadId);
    expect(t.messages.map((m) => m.state)).toEqual(['delivered', 'queued']);
    expect(t.messages[0].deliveredAt).toBe(h.clock);
    expect(r.text).toBe(renderThread(t, names));
    expect(r.text).toContain('ping');
    expect(r.text).toContain('pong');
    expect(r.text).toContain('thread ' + s.threadId + ' between orders/main and billing/main');

    // billing has nothing left; orders gets the pong once
    expect(await hub.inbox(B)).toEqual({ ok: true, text: 'inbox empty' });
    const s2 = await hub.send(O, 'billing', 'second task');
    h.clock += 1000;
    await hub.reply(B, s2.threadId, 'second answer');
    const inbox = await hub.inbox(O);
    expect(inbox.ok).toBe(true);
    expect(inbox.text.indexOf('pong')).toBeGreaterThan(-1);
    expect(inbox.text.indexOf('pong')).toBeLessThan(inbox.text.indexOf('second answer'));
    expect(inbox.text).toContain(`from the agent in billing/main, thread ${s.threadId}`);
    expect(inbox.text).not.toContain('ping');
    expect(store.thread(s.threadId).messages.map((m) => m.state)).toEqual(['delivered', 'delivered']);
    expect(store.thread(s2.threadId).messages.map((m) => m.state)).toEqual(['queued', 'delivered']);
    expect(await hub.inbox(O)).toEqual({ ok: true, text: 'inbox empty' });

    // a handed message counts as undelivered
    store.setMessageState(s2.threadId, store.thread(s2.threadId).messages[0].id, 'handed', { handedAt: h.clock, handedPane: '%1' });
    expect((await hub.inbox(B)).text).toContain('second task');
    expect(store.thread(s2.threadId).messages[0].state).toBe('delivered');
  });

  test('read by a non-participant or of an unknown thread is refused and logged', async () => {
    const s = await hub.send(O, 'billing', 'ping');
    const outsider = { boxId: 'b', session: 'review' };
    expect(await hub.read(outsider, s.threadId)).toEqual({ ok: false, text: refusalText('not-a-participant') });
    expect(await hub.read(B, 'nope')).toEqual({ ok: false, text: refusalText('not-a-participant') });
    expect(store.refusals().map((r) => [r.from, r.target])).toEqual([[B, 'nope'], [outsider, s.threadId]]);
    expect(store.thread(s.threadId).messages[0].state).toBe('queued');
  });

  test('read and inbox close a thread whose permission is gone instead of delivering', async () => {
    const s = await hub.send(O, 'billing', 'ping');
    await setPolicy('o', { send: false, sendTo: ['b'] });
    expect(await hub.inbox(B)).toEqual({ ok: true, text: 'inbox empty' });
    const t = store.thread(s.threadId);
    expect(t).toMatchObject({ state: 'closed', reason: 'permission withdrawn' });
    expect(t.messages[0].state).toBe('dropped');
    const r = await hub.read(B, s.threadId);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('closed: permission withdrawn');
    expect(r.text).not.toContain('ping');
    expect(r.text).toContain('[not delivered]');
  });

  test('a thread closed by the operator hides dropped bodies from their recipient only', async () => {
    const s = await hub.send(O, 'billing', 'task body');
    await hub.read(B, s.threadId); // delivered: stays visible after the close
    await hub.reply(B, s.threadId, 'answer body');
    await hub.reply(O, s.threadId, 'follow-up body');
    store.closeThread(s.threadId, 'operator');
    expect(store.thread(s.threadId).messages.map((m) => m.state)).toEqual(['delivered', 'dropped', 'dropped']);
    const forB = (await hub.read(B, s.threadId)).text;
    expect(forB).toContain('task body');
    expect(forB).toContain('answer body'); // its own words
    expect(forB).not.toContain('follow-up body');
    const forO = (await hub.read(O, s.threadId)).text;
    expect(forO).toContain('task body');
    expect(forO).toContain('follow-up body');
    expect(forO).not.toContain('answer body');
    expect(forO.match(/\[not delivered\]/g)).toHaveLength(1);
    expect(forB.match(/\[not delivered\]/g)).toHaveLength(1);
  });
});

describe('agentMailHub: policy and who', () => {
  test('same-box send needs both switches and no list entry', async () => {
    marks.o.review = mark('ready');
    await setPolicy('o', { send: true, receive: false, sendTo: ['b'] });
    expect(await hub.send(O, './review', 'x')).toEqual({ ok: false, text: refusalText('receive-off', { target: './review' }) });
    await setPolicy('o', { send: false, receive: true });
    expect(await hub.send(O, './review', 'x')).toEqual({ ok: false, text: refusalText('send-off', { target: './review' }) });
    await setPolicy('o', { send: true, receive: true });
    const r = await hub.send(O, 'orders/review', 'x');
    expect(r.ok).toBe(true);
    const back = await hub.reply({ boxId: 'o', session: 'review' }, r.threadId, 'y');
    expect(back.ok).toBe(true);
    expect(back.text).toBe(`Sent. Thread ${r.threadId}. queued: orders/main is working`);
  });

  test('who lists only boxes the caller may start a thread with, with state and listening', async () => {
    boxes.push({ id: 'c', label: 'crm', sessionName: 'main' }, { id: 'x', label: 'down', sessionName: 'main' });
    await setPolicy('o', { send: true, sendTo: ['b', 'x'] });
    await setPolicy('b', { receive: true, receiveFrom: ['o'] });
    await setPolicy('c', { receive: true });
    await setPolicy('x', { receive: true, receiveFrom: ['o'] });
    marks.b = { work: mark('working'), main: mark('ready'), review: mark('blocked', 'permission'), 'bad name': mark('ready') };
    marks.c = { main: mark('ready') };
    marks.o.review = mark('ready');

    const r = await hub.who(O);
    expect(r).toEqual({
      ok: true,
      text: renderWho([
        { box: 'billing', session: 'main', state: 'idle', listening: false },
        { box: 'billing', session: 'review', state: 'blocked', listening: false },
        { box: 'billing', session: 'work', state: 'working', listening: false },
      ]),
    });
    expect(r.text).toBe('billing/main  idle, not listening\nbilling/review  blocked, not listening\nbilling/work  working, not listening');

    // with receive on, the caller's own box lists its other sessions, never the caller itself
    await setPolicy('o', { send: true, receive: true, sendTo: ['b'] });
    const mine = await hub.who(O);
    expect(mine.text.split('\n')).toEqual([
      'orders/review  idle, not listening',
      'billing/main  idle, not listening',
      'billing/review  blocked, not listening',
      'billing/work  working, not listening',
    ]);

    await setPolicy('o', { send: false, receive: true, sendTo: ['b'] });
    expect(await hub.who(O)).toEqual({ ok: true, text: renderWho([]) });
  });
});

// Agent state is per pane (pane-level design 8.1); mail is still addressed to sessions.
describe('agentMailHub: panes and sessions', () => {
  test('a session runs an agent when any pane mark names it', async () => {
    h.paneMarks.b = {
      '%1': paneMark('main', 'working'), '%2': paneMark('main', 'blocked', 'permission'),
      '%3': paneMark('review', 'ready'), '%4': paneMark('review', 'working'),
      '%5': paneMark('work', 'ready'), '%6': paneMark('work', 'ready'),
    };
    // one row per session; the word is the worst of its panes: blocked, then working, then idle
    expect((await hub.who(O)).text).toBe(renderWho([
      { box: 'billing', session: 'main', state: 'blocked', listening: false },
      { box: 'billing', session: 'review', state: 'working', listening: false },
      { box: 'billing', session: 'work', state: 'idle', listening: false },
    ]));
    const r = await hub.send(O, 'billing/review', 'x');
    expect(r.ok).toBe(true);
    expect(r.text).toBe(`Sent. Thread ${r.threadId}. queued: billing/review is working`);
    expect((await hub.send(O, 'billing', 'y')).text).toMatch(/queued: billing\/main is waiting on its operator$/);
    // a session no pane mark names runs nothing, even with marks on every other pane
    expect(await hub.send(O, 'billing/other', 'z')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/other' }) });
    // the caller is checked the same way: orders/main with no pane mark naming it is no agent
    h.paneMarks.o = { '%7': paneMark('review', 'working') };
    expect(await hub.send(O, 'billing', 'w')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'orders/main' }) });
    // an unreachable box (null) and a reachable one with no marker ({}) are told apart
    h.paneMarks.o = { '%7': paneMark('main', 'working') };
    h.paneMarks.b = {};
    expect(await hub.send(O, 'billing/main', 'v')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/main' }) });
    h.paneMarks.b = null;
    expect(await hub.send(O, 'billing/main', 'v')).toEqual({ ok: false, text: refusalText('unreachable', { target: 'billing/main' }) });
  });

  test('a bare target still means sessions: configured first, else the only one, else several-agents', async () => {
    // the configured session, whatever else runs
    h.paneMarks.b = { '%1': paneMark('main', 'working'), '%2': paneMark('main', 'ready'), '%3': paneMark('side', 'ready') };
    expect(store.thread((await hub.send(O, 'billing', 'one')).threadId).peer).toEqual(B);
    // two agent panes in one other session are still one session
    h.paneMarks.b = { '%3': paneMark('side', 'ready'), '%4': paneMark('side', 'working') };
    expect(store.thread((await hub.send(O, 'billing', 'two')).threadId).peer).toEqual({ boxId: 'b', session: 'side' });
    // two other sessions: several-agents
    h.paneMarks.b = { '%3': paneMark('side', 'ready'), '%5': paneMark('other', 'ready') };
    expect(await hub.send(O, 'Billing', 'three')).toEqual({ ok: false, text: refusalText('several-agents', { target: 'Billing' }) });
  });

  test('mail kinds are judged by any pane of the session, not only the active one', async () => {
    // session main: the active pane is a shell, a background pane runs claude with a mark
    h.panes.b = [paneRow('main', '%1', 'zsh'), paneRow('main', '%2', 'claude', { active: false })];
    h.paneMarks.b = { '%2': paneMark('main', 'working') };
    expect(store.thread((await hub.send(O, 'billing', 'one')).threadId).peer).toEqual(B);
    // the active pane runs Codex (marked), a background pane runs claude (marked): main takes mail
    h.panes.b = [paneRow('main', '%1', 'codex'), paneRow('main', '%2', 'claude', { active: false })];
    h.paneMarks.b = { '%1': paneMark('main', 'ready'), '%2': paneMark('main', 'working') };
    expect(store.thread((await hub.send(O, 'billing', 'two')).threadId).peer).toEqual(B);
    // only Codex is marked; the unmarked shell beside it runs no agent: no session can take mail
    h.panes.b = [paneRow('main', '%1', 'codex'), paneRow('main', '%2', 'zsh', { active: false })];
    h.paneMarks.b = { '%1': paneMark('main', 'ready') };
    expect(await hub.send(O, 'billing', 'three')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/main' }) });
    // no pane listing (unknown, or not complete): every marked session counts, as before
    h.panes.b = null;
    expect(store.thread((await hub.send(O, 'billing', 'four')).threadId).peer).toEqual(B);
  });
});

describe('agentMailHub: the storage bound', () => {
  const HOUR = 3_600_000;

  test('1500 sends never leave more than 1000 threads: the longest idle are closed "storage limit" and deleted, and a wait on one ends with that', async () => {
    const ids = [];
    for (let i = 0; i < 1000; i++) {
      h.clock += 10_000;
      ids.push((await hub.send(O, 'billing', `task ${i}`)).threadId);
    }
    expect(store.count()).toBe(1000);
    // The lead still waits on its oldest thread when the store has to make room.
    const ac = new AbortController();
    const waiting = hub.waitReplies(O, [ids[0], ids[999]], 540_000, ac.signal);
    await new Promise((r) => setImmediate(r));
    for (let i = 1000; i < 1500; i++) {
      h.clock += 10_000;
      const r = await hub.send(O, 'billing', `task ${i}`);
      expect(r.ok, r.text).toBe(true);
      ids.push(r.threadId);
      expect(store.count()).toBe(1000);
    }
    expect(await waiting).toEqual({
      got: false,
      text: `thread ${ids[0]}: closed: storage limit\nthread ${ids[999]}: queued: billing/main is working`,
    });
    ac.abort();
    // The survivors are the 1000 most recently active.
    expect(store.threads().map((t) => t.id).sort()).toEqual(ids.slice(500).sort());
    expect(store.refusals()).toEqual([]);
    // A removed thread is gone for its participants too.
    expect(await hub.reply(B, ids[0], 'late')).toEqual({ ok: false, text: refusalText('not-a-participant') });
    await store.whenIdle();
  }, 60_000);

  test('a flood of threads all active within the hour: the send past the bound is refused "store-full" and logged, and passes once one has aged', async () => {
    for (let i = 0; i < 1000; i++) expect((await hub.send(O, 'billing', `task ${i}`)).ok).toBe(true);
    const first = store.threads().at(-1).id;
    h.clock += HOUR; // exactly an hour: still recent
    const full = await hub.send(O, 'billing', 'one too many');
    expect(full).toEqual({ ok: false, text: 'refused: the mail store is full, so no new thread can be started; tell your operator' });
    expect(full.text).toBe(refusalText('store-full'));
    expect(store.count()).toBe(1000);
    expect(store.refusals()[0]).toEqual({ at: h.clock, from: O, target: 'billing', reason: full.text });
    // Replies in the threads that exist are not affected.
    expect((await hub.reply(B, first, 'still talking')).ok).toBe(true);
    // Once the others are more than an hour idle, a new thread takes the place of the longest idle.
    h.clock += 1;
    const again = await hub.send(O, 'billing', 'now it fits');
    expect(again.ok, again.text).toBe(true);
    expect(store.count()).toBe(1000);
    expect(store.thread(first)).not.toBeNull(); // it was active a millisecond ago
    await store.whenIdle();
  }, 60_000);

  test('a policy refusal comes before the storage bound, and a refused send prunes nothing', async () => {
    for (let i = 0; i < 1000; i++) await hub.send(O, 'billing', `task ${i}`);
    h.clock += 2 * HOUR;
    await setPolicy('b', { receive: false, receiveFrom: ['o'] });
    expect((await hub.send(O, 'billing', 'x')).text).toBe(refusalText('receive-off', { target: 'billing' }));
    expect(store.count()).toBe(1000);
    await store.whenIdle();
  }, 60_000);

  test('a hub built over a loaded store prunes it: boot enforces the bound', async () => {
    for (let i = 0; i < 1200; i++) {
      h.clock += 10_000;
      store.createThread({ starter: O, peer: B });
    }
    expect(store.count()).toBe(1200);
    await store.whenIdle();
    // The next process: a new store over the same files, loaded, then its hub.
    const { createAgentMailStore } = await import('../src/server/agentMailStore.js');
    const reloaded = createAgentMailStore({ dataDir: h.dir, now: () => h.clock });
    await reloaded.load();
    expect(reloaded.count()).toBe(1200);
    const hub2 = h.makeHub({ store: reloaded });
    expect(reloaded.count()).toBe(1000);
    expect(typeof hub2.prune).toBe('function');
    await reloaded.whenIdle();
    const again = createAgentMailStore({ dataDir: h.dir, now: () => h.clock });
    await again.load();
    expect(again.count()).toBe(1000);
    // The daily prune is the same call: 100 more idle threads, then prune.
    for (let i = 0; i < 100; i++) { h.clock += 10_000; reloaded.createThread({ starter: O, peer: B }); }
    h.clock += 2 * HOUR;
    hub2.prune();
    expect(reloaded.count()).toBe(1000);
    await reloaded.whenIdle();
  }, 60_000);
});
