import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolveTarget } from '../src/server/agentMailHub.js';
import { refusalText, wakeText } from '../src/server/agentMailText.js';
import { createMailHarness, O, B, mark } from './helpers/agentMailHarness.js';

// Which session a send to a bare box name reaches (agent workers spec 5.3): the configured
// session when it can take mail, else the one other session that can, else refused. A session
// can take mail when it has a marker and its pane runs claude, opencode or something unknown.

const SIDE = { boxId: 'b', session: 'side' };
const OWN_SIDE = { boxId: 'o', session: 'side' };
const pane = (name, paneCmd) => ({ name, paneCmd });

let h; let boxes; let store; let hub;

beforeEach(async () => {
  h = await createMailHarness();
  ({ boxes, store, hub } = h);
});
afterEach(() => h.cleanup());

const peerOf = (r) => store.thread(r.threadId).peer;

describe('resolveTarget: bare', () => {
  test('"." and a whole-label match are bare; "./x" and "label/x" are not', () => {
    expect(resolveTarget('.', boxes, 'o')).toEqual({ box: boxes[0], session: 'main', bare: true });
    expect(resolveTarget('Billing', boxes, 'o')).toEqual({ box: boxes[1], session: 'main', bare: true });
    expect(resolveTarget('./main', boxes, 'o')).toEqual({ box: boxes[0], session: 'main', bare: false });
    expect(resolveTarget('billing/main', boxes, 'o')).toEqual({ box: boxes[1], session: 'main', bare: false });
  });
});

describe('agentMailHub: a bare name finds the agent that can take mail', () => {
  test('the configured session has an agent: the thread goes to it, even with another one elsewhere', async () => {
    h.marks.b = { main: mark('working'), side: mark('working') };
    h.sessions.b = [pane('main', 'claude'), pane('side', 'claude')];
    const r = await hub.send(O, 'billing', 'ping');
    expect(r.ok).toBe(true);
    expect(peerOf(r)).toEqual(B);
  });

  test('no agent in the configured session, one Claude in side: the thread goes to side', async () => {
    h.marks.b = { side: mark('working') };
    h.sessions.b = [pane('main', 'zsh'), pane('side', 'claude')];
    const r = await hub.send(O, 'billing', 'ping');
    expect(r.ok).toBe(true);
    expect(peerOf(r)).toEqual(SIDE);
    expect(r.text).toBe(`Sent. Thread ${r.threadId}. queued: billing/side is working`);
    expect(store.refusals()).toEqual([]);
  });

  test('an OpenCode pane and a pane of unknown kind count too', async () => {
    h.marks.b = { side: mark('working') };
    h.sessions.b = [pane('main', 'zsh'), pane('side', 'opencode')];
    expect(peerOf(await hub.send(O, 'billing', 'one'))).toEqual(SIDE);
    h.sessions.b = [pane('main', 'zsh'), pane('side', 'node')];
    expect(peerOf(await hub.send(O, 'billing', 'two'))).toEqual(SIDE);
    // a marker whose session the listing does not show is of unknown kind
    h.sessions.b = [pane('main', 'zsh')];
    expect(peerOf(await hub.send(O, 'billing', 'three'))).toEqual(SIDE);
  });

  test('no agent in the configured session, two elsewhere: refused several-agents and logged', async () => {
    h.marks.b = { side: mark('working'), other: mark('ready') };
    h.sessions.b = [pane('main', 'zsh'), pane('side', 'claude'), pane('other', 'opencode')];
    const r = await hub.send(O, 'Billing', 'ping');
    expect(r).toEqual({ ok: false, text: refusalText('several-agents', { target: 'Billing' }) });
    expect(store.refusals()).toEqual([{ at: h.clock, from: O, target: 'Billing', reason: r.text }]);
    expect(store.threads()).toEqual([]);
  });

  test('the configured session runs Codex (marker present), one Claude in side: the thread goes to side', async () => {
    h.marks.b = { main: mark('ready'), side: mark('working') };
    h.sessions.b = [pane('main', 'codex'), pane('side', 'claude')];
    const r = await hub.send(O, 'billing', 'ping');
    expect(r.ok).toBe(true);
    expect(peerOf(r)).toEqual(SIDE);
  });

  test('pi and agy panes do not count either', async () => {
    h.marks.b = { main: mark('ready'), side: mark('ready'), third: mark('working') };
    h.sessions.b = [pane('main', 'pi'), pane('side', 'agy'), pane('third', 'claude')];
    expect(peerOf(await hub.send(O, 'billing', 'ping'))).toEqual({ boxId: 'b', session: 'third' });
  });

  test('only a Codex session: refused no-agent, as today', async () => {
    h.marks.b = { main: mark('ready') };
    h.sessions.b = [pane('main', 'codex')];
    const r = await hub.send(O, 'billing', 'ping');
    expect(r).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/main' }) });
    expect(store.refusals()[0]).toEqual({ at: h.clock, from: O, target: 'billing', reason: r.text });
    expect(store.threads()).toEqual([]);

    h.marks.b = { side: mark('ready') };
    h.sessions.b = [pane('main', 'zsh'), pane('side', 'codex')];
    expect(await hub.send(O, 'billing', 'ping')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/main' }) });
  });

  test('no session listing: every session with a marker counts', async () => {
    h.marks.b = { side: mark('working') };
    expect(h.sessions.b).toBeUndefined();
    const r = await hub.send(O, 'billing', 'ping');
    expect(r.ok).toBe(true);
    expect(peerOf(r)).toEqual(SIDE);

    h.marks.b = { side: mark('working'), other: mark('working') };
    expect(await hub.send(O, 'billing', 'ping')).toEqual({ ok: false, text: refusalText('several-agents', { target: 'billing' }) });
  });

  test('a marker under a name that is not a valid session name is never a candidate', async () => {
    h.marks.b = { 'bad name': mark('working'), side: mark('working') };
    expect(peerOf(await hub.send(O, 'billing', 'ping'))).toEqual(SIDE);
  });

  test('a caller in side of its own box sends to ".": its own session never counts', async () => {
    await h.setPolicy('o', { send: true, receive: true, sendTo: ['b'] });
    h.marks.o = { side: mark('working') };
    h.sessions.o = [pane('main', 'zsh'), pane('side', 'claude')];
    const none = await hub.send(OWN_SIDE, '.', 'ping');
    expect(none).toEqual({ ok: false, text: refusalText('no-other-agent', { target: '.' }) });

    h.marks.o = { side: mark('working'), other: mark('ready') };
    h.sessions.o = [pane('main', 'zsh'), pane('side', 'claude'), pane('other', 'claude')];
    const r = await hub.send(OWN_SIDE, '.', 'ping');
    expect(r.ok).toBe(true);
    expect(store.thread(r.threadId)).toMatchObject({ starter: OWN_SIDE, peer: { boxId: 'o', session: 'other' } });
  });

  test('a caller in the configured session sends to its own box name: it resolves among the other sessions', async () => {
    await h.setPolicy('o', { send: true, receive: true, sendTo: ['b'] });
    h.marks.o = { main: mark('working'), side: mark('ready') };
    const r = await hub.send(O, 'orders', 'ping');
    expect(r.ok).toBe(true);
    expect(store.thread(r.threadId)).toMatchObject({ starter: O, peer: OWN_SIDE });
    // an explicit name of its own session is still its own session
    expect(await hub.send(O, './main', 'ping')).toEqual({ ok: false, text: refusalText('own-session') });
    expect(await hub.send(O, 'orders/main', 'ping')).toEqual({ ok: false, text: refusalText('own-session') });
  });

  test('"billing/side" explicit with no agent there: refused no-agent, as today', async () => {
    h.marks.b = { main: mark('working') };
    h.sessions.b = [pane('main', 'claude'), pane('side', 'zsh')];
    const r = await hub.send(O, 'billing/side', 'ping');
    expect(r).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/side' }) });
    expect(store.threads()).toEqual([]);
  });

  test('an explicit target whose pane runs Codex keeps today\'s marker test', async () => {
    h.marks.b = { side: mark('ready') };
    h.sessions.b = [pane('side', 'codex')];
    const r = await hub.send(O, 'billing/side', 'ping');
    expect(r.ok).toBe(true);
    expect(peerOf(r)).toEqual(SIDE);
  });

  test('the checks before reachable still come first: an unreachable box is unreachable, not no-agent', async () => {
    delete h.marks.b;
    expect(await hub.send(O, 'billing', 'ping')).toEqual({ ok: false, text: refusalText('unreachable', { target: 'billing' }) });
  });
});

// A send that starts a worker (agent workers spec 5.3): a bare name with no agent that can take
// mail, or `fresh`, starts an interactive Claude Code in its own session on the box, through
// the real starter and start script on a worker bench (a private tmux server, see
// test/helpers/workerBench.js), and queues the message for it. Delivery is the existing path.
describe('agentMailHub: a send starts a worker', () => {
  let w;
  const WORKER = { boxId: 'b', session: 'worker-api-1' };
  const RECORD = { mailStart: true, projects: [{ name: 'api' }, { name: 'web' }] };

  async function world(record = RECORD, extra = {}) {
    w = await createMailHarness({}, {
      workers: { b: record, o: record },
      installed: ['b', 'o'],
      sessions: { b: [pane('main', 'zsh')], o: [pane('main', 'claude')] },
      ...extra,
    });
    w.marks.b = {};
    return w;
  }
  afterEach(async () => { if (w) await w.cleanup(); w = null; });

  const benchSessions = () => {
    try {
      return w.bench.tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean).sort();
    } catch { return []; } // no sessions at all
  };
  const peer = (r) => w.store.thread(r.threadId).peer;
  // A starter that counts the calls made to it, over the harness's real one.
  const counting = () => {
    const c = { calls: 0 };
    c.start = (...a) => { c.calls += 1; return w.workers.start(...a); };
    return c;
  };

  test('a bare name on a box with no agent starts worker-api-1 and queues the message for it', async () => {
    await world();
    const r = await w.hub.send(O, 'billing', 'build the thing');
    expect(r.ok, r.text).toBe(true);
    expect(peer(r)).toEqual(WORKER);
    expect(r.text.startsWith(`Sent. Thread ${r.threadId}. `)).toBe(true);
    expect(benchSessions()).toEqual(['worker-api-1']);
    expect(w.store.thread(r.threadId).messages.map((m) => m.state)).toEqual(['queued']);
    expect(w.store.refusals()).toEqual([]);

    // The worker's agent comes up: its marker reads ready and its waiter connects.
    w.marks.b = { 'worker-api-1': mark('ready', 'start') };
    w.sessions.b = [pane('main', 'zsh'), pane('worker-api-1', 'claude')];
    const ac = new AbortController();
    const got = await w.hub.waitMail(WORKER, '%3', ac.signal);
    const m = w.store.thread(r.threadId).messages[0];
    expect(got).toEqual({ messageId: m.id, text: wakeText({ messageId: m.id, threadId: r.threadId, from: 'orders/main', body: 'build the thing', kind: 'task' }) });
    expect(m.state).toBe('handed');
  });

  test('mailStart off: a bare name is refused no-agent as today, fresh is workers-off; nothing started', async () => {
    await world({ ...RECORD, mailStart: false });
    const c = counting();
    const hub = w.makeHub({ workers: c });
    expect(await hub.send(O, 'billing', 'x')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/main' }) });
    expect(await hub.send(O, 'billing', 'x', { fresh: '' })).toEqual({ ok: false, text: refusalText('workers-off', { target: 'billing' }) });
    expect(c.calls).toBe(0);
    expect(benchSessions()).toEqual([]);
    expect(w.store.threads()).toEqual([]);
    expect(w.store.refusals()).toHaveLength(2);
  });

  test('mail tools not installed on the box: refused mail-not-set-up, nothing started', async () => {
    await world();
    w.installed.delete('b');
    const c = counting();
    const hub = w.makeHub({ workers: c });
    expect(await hub.send(O, 'billing', 'x')).toEqual({ ok: false, text: refusalText('mail-not-set-up', { target: 'billing' }) });
    expect(await hub.send(O, 'billing', 'x', { fresh: 'web' })).toEqual({ ok: false, text: refusalText('mail-not-set-up', { target: 'billing' }) });
    expect(c.calls).toBe(0);
    expect(benchSessions()).toEqual([]);
  });

  test('fresh names a project: "web" starts worker-web-1; an unknown one is no-project naming it', async () => {
    await world();
    const r = await w.hub.send(O, 'billing', 'x', { fresh: 'web' });
    expect(r.ok, r.text).toBe(true);
    expect(peer(r)).toEqual({ boxId: 'b', session: 'worker-web-1' });
    const nope = await w.hub.send(O, 'billing', 'x', { fresh: 'nope' });
    expect(nope).toEqual({ ok: false, text: refusalText('no-project', { target: 'billing', project: 'nope' }) });
    expect(nope.text).toBe('refused: billing has no project named "nope"; run "tmx who"');
    expect(benchSessions()).toEqual(['worker-web-1']);
  });

  test('fresh "" starts a worker even while an agent runs in the configured session', async () => {
    await world();
    w.marks.b = { main: mark('ready') };
    w.sessions.b = [pane('main', 'claude')];
    const r = await w.hub.send(O, 'billing', 'x', { fresh: '' });
    expect(r.ok, r.text).toBe(true);
    expect(peer(r)).toEqual(WORKER);
    // a bare send still goes to the running agent
    expect(peer(await w.hub.send(O, 'billing', 'y'))).toEqual(B);
  });

  test('fresh with a box/session target is refused fresh-needs-box', async () => {
    await world();
    w.marks.b = { side: mark('ready') };
    const c = counting();
    const hub = w.makeHub({ workers: c });
    expect(await hub.send(O, 'billing/side', 'x', { fresh: '' })).toEqual({ ok: false, text: refusalText('fresh-needs-box') });
    expect(c.calls).toBe(0);
  });

  test('the box already runs its maximum of workers: refused worker-cap', async () => {
    await world({ ...RECORD, max: 1 });
    w.sessions.b = [pane('main', 'zsh'), pane('worker-api-1', 'claude')];
    expect(await w.hub.send(O, 'billing', 'x')).toEqual({ ok: false, text: refusalText('worker-cap', { target: 'billing' }) });
    expect(benchSessions()).toEqual([]);
  });

  test('the starter has no listing of the box: refused unreachable, in the existing wording', async () => {
    await world();
    delete w.sessions.b;
    expect(await w.hub.send(O, 'billing', 'x')).toEqual({ ok: false, text: refusalText('unreachable', { target: 'billing' }) });
  });

  test('the sender\'s send switch off: send-off, and the starter is never asked', async () => {
    await world();
    await w.setPolicy('o', { send: false, sendTo: ['b'] });
    const c = counting();
    const hub = w.makeHub({ workers: c });
    expect(await hub.send(O, 'billing', 'x')).toEqual({ ok: false, text: refusalText('send-off') });
    expect(await hub.send(O, 'billing', 'x', { fresh: '' })).toEqual({ ok: false, text: refusalText('send-off') });
    expect(c.calls).toBe(0);
  });

  test('no room in the store before the start: store-full, nothing started', async () => {
    await world();
    const c = counting();
    const hub = w.makeHub({ workers: c, store: { ...w.store, hasRoom: () => false } });
    expect(await hub.send(O, 'billing', 'x')).toEqual({ ok: false, text: refusalText('store-full') });
    expect(c.calls).toBe(0);
    expect(benchSessions()).toEqual([]);
  });

  test('the store fills while the worker starts: store-full, the worker stays up, a later bare send joins it', async () => {
    await world();
    let room = [true, false];
    const hub = w.makeHub({ store: { ...w.store, hasRoom: () => (room.length ? room.shift() : true) } });
    expect(await hub.send(O, 'billing', 'x')).toEqual({ ok: false, text: refusalText('store-full') });
    expect(benchSessions()).toEqual(['worker-api-1']);
    expect(w.store.threads()).toEqual([]);
    room = [];
    const r = await hub.send(O, 'billing', 'y');
    expect(r.ok, r.text).toBe(true);
    expect(peer(r)).toEqual(WORKER);
    expect(benchSessions()).toEqual(['worker-api-1']);
  });

  test('a second bare send while the first worker has no marker yet goes to that worker', async () => {
    await world();
    const c = counting();
    const hub = w.makeHub({ workers: c });
    const one = await hub.send(O, 'billing', 'one');
    // joining starts nothing, so it needs none of a start's conditions
    w.installed.delete('b');
    const two = await hub.send(O, 'billing', 'two');
    expect(two.ok, two.text).toBe(true);
    expect(peer(two)).toEqual(WORKER);
    expect(c.calls).toBe(1);
    expect(benchSessions()).toEqual(['worker-api-1']);
    expect(w.store.thread(one.threadId).peer).toEqual(WORKER);
  });

  test('two bare sends awaited together: one worker, two threads on it', async () => {
    await world();
    const [one, two] = await Promise.all([w.hub.send(O, 'billing', 'one'), w.hub.send(O, 'billing', 'two')]);
    expect(one.ok, one.text).toBe(true);
    expect(two.ok, two.text).toBe(true);
    expect(one.threadId).not.toBe(two.threadId);
    expect(peer(one)).toEqual(WORKER);
    expect(peer(two)).toEqual(WORKER);
    expect(benchSessions()).toEqual(['worker-api-1']);
  });

  test('two fresh sends together: two workers with different names', async () => {
    await world();
    const [one, two] = await Promise.all([
      w.hub.send(O, 'billing', 'one', { fresh: '' }),
      w.hub.send(O, 'billing', 'two', { fresh: '' }),
    ]);
    expect([peer(one).session, peer(two).session].sort()).toEqual(['worker-api-1', 'worker-api-2']);
    expect(benchSessions()).toEqual(['worker-api-1', 'worker-api-2']);
  });

  test('a fresh send never joins a pending bare start', async () => {
    await world();
    const bare = await w.hub.send(O, 'billing', 'one');
    const fresh = await w.hub.send(O, 'billing', 'two', { fresh: '' });
    expect(peer(bare)).toEqual(WORKER);
    expect(peer(fresh)).toEqual({ boxId: 'b', session: 'worker-api-2' });
  });

  test('messaging without the starter (workers: null): a bare name with no agent is no-agent', async () => {
    await world();
    const hub = w.makeHub({ workers: null });
    expect(await hub.send(O, 'billing', 'x')).toEqual({ ok: false, text: refusalText('no-agent', { who: 'billing/main' }) });
    expect(await hub.send(O, 'billing', 'x', { fresh: '' })).toEqual({ ok: false, text: refusalText('workers-off', { target: 'billing' }) });
    expect(benchSessions()).toEqual([]);
  });

  test('a lead starts a worker beside itself on its own box (its own send and receive switches, and mailStart)', async () => {
    await world(RECORD, { policies: { o: { send: true, receive: true, sendTo: ['b'] }, b: { receive: true, receiveFrom: ['o'] } } });
    // a bare name of its own box, with no other agent there
    const r = await w.hub.send(O, '.', 'help me');
    expect(r.ok, r.text).toBe(true);
    expect(w.store.thread(r.threadId)).toMatchObject({ starter: O, peer: { boxId: 'o', session: 'worker-api-1' } });
    // and a fresh one beside both
    const fresh = await w.hub.send(O, 'orders', 'and this', { fresh: 'api' });
    expect(fresh.ok, fresh.text).toBe(true);
    expect(peer(fresh)).toEqual({ boxId: 'o', session: 'worker-api-2' });
    // without its own receive switch, no thread to its own box, and no start
    await w.setPolicy('o', { send: true, sendTo: ['b'] });
    expect(await w.hub.send(O, '.', 'x', { fresh: '' })).toEqual({ ok: false, text: refusalText('receive-off', { target: '.' }) });
    expect(benchSessions()).toEqual(['worker-api-1', 'worker-api-2']);
  });

  test('own box, no other agent and no worker started: refused no-other-agent', async () => {
    await world({ ...RECORD, mailStart: false }, { policies: { o: { send: true, receive: true, sendTo: ['b'] }, b: { receive: true, receiveFrom: ['o'] } } });
    const r = await w.hub.send(O, '.', 'x');
    expect(r).toEqual({ ok: false, text: refusalText('no-other-agent', { target: '.' }) });
    expect(await w.hub.send(O, 'orders', 'x')).toEqual({ ok: false, text: refusalText('no-other-agent', { target: 'orders' }) });
  });
});
