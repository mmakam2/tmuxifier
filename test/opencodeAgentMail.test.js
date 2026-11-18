import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentMailListener } from '../src/server/agentMailListener.js';
import { SESSION_NAME_RE } from '../src/server/sshCommand.js';
import {
  createMailPart,
  createMailSocketClient,
  createCore,
  takeOver,
  createReducer,
  parsePanes,
  parsePanesChecked,
  MAIL_SESSION_RE,
  MAIL_REOFFER_MS,
  MAIL_BACKOFF_MIN_MS,
  MAIL_BACKOFF_MAX_MS,
  MAIL_INFLIGHT_FILE,
} from '../src/server/assets/tmuxifier-opencode-agent.js';
import { createMailHarness, B, mark } from './helpers/agentMailHarness.js';

// The plugin's mail part (agent messaging, spec §6.2-6.4) against the REAL listener on a real
// unix socket over the real hub and stores: the box is `o` (orders), its OpenCode pane `%3` in
// tmux session `main`. Only OpenCode is faked: `synthetic` records its input and resolves the way
// 2.3.0 does (README-opencode-2.3-event-trace.md F1, fixture line 279), and the inbox events are
// copied from the recording (enqueued 280: no location; delivered 299: with location; F9: after
// a server restart only `inbox.delivered` for the old inboxID). The mail part's timers (backoff,
// hold-off, REOFFER_MS) run on an injected clock; the socket traffic is real.

const DIR = '/home/user/proj';
const SID = 'ses_e1b5dba6cffeeqBRex5168FE6A';
const SID2 = 'ses_e1b5dbb0000002ndSession0000';
const PANE = '%3';

let h; let home; let sock; let listener; let log; let parts;

beforeEach(async () => {
  h = await createMailHarness({ holdMs: 60_000 });
  await h.setPolicy('o', { send: true, sendTo: ['b'], receive: true, receiveFrom: ['b'] });
  await h.setPolicy('b', { send: true, sendTo: ['o'], receive: true, receiveFrom: ['o'] });
  h.marks.o = { main: mark('ready') };
  // What the hub saw, in order: every wait connecting and every ack.
  log = [];
  const waitMail = h.hub.waitMail;
  h.hub.waitMail = (caller, pane, signal) => { log.push(['wait', caller.session, pane]); return waitMail(caller, pane, signal); };
  const ack = h.hub.ack;
  h.hub.ack = (caller, id) => { log.push(['ack', caller.session, id]); return ack(caller, id); };
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mp-'));
  fs.mkdirSync(path.join(home, '.tmuxifier-mail'), { mode: 0o700 });
  sock = path.join(home, '.tmuxifier-mail', 'sock');
  listener = null;
  parts = [];
});

afterEach(async () => {
  for (const p of parts) { try { p.abort(); } catch { /* the test checks what matters */ } }
  if (listener) await listener.close();
  await h.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

async function start() {
  listener = createAgentMailListener({ hub: h.hub, boxId: 'o', socketPath: sock });
  await listener.listen();
  return listener;
}

async function until(pred, what) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
// Let in-flight socket traffic and promise chains run for a while (for "nothing happened" checks).
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// A clock and timers the test drives: advance(ms) runs every timer due, in order.
function fakeClock(start = 5_000_000) {
  const c = { t: start, timers: [], seq: 0 };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => {
    const tm = { fn, at: c.t + Math.max(0, Number(ms) || 0), id: ++c.seq, unref() {} };
    c.timers.push(tm);
    return tm;
  };
  c.clearTimeout = (tm) => { c.timers = c.timers.filter((x) => x !== tm); };
  c.advance = (ms) => {
    const end = c.t + ms;
    for (;;) {
      const due = c.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      c.timers = c.timers.filter((x) => x !== due);
      c.t = due.at;
      due.fn();
    }
    c.t = end;
  };
  c.delays = () => c.timers.map((x) => x.at - c.t);
  return c;
}

// OpenCode's ctx.session.synthetic as 2.3.0 answers it (F1). `mode`: resolve, reject, throw, or
// manual (resolved by calling fn.pending.shift()()).
function fakeSynthetic() {
  let n = 0;
  const fn = (input) => {
    fn.calls.push(input);
    if (fn.mode === 'throw') throw new Error('synthetic threw');
    if (fn.mode === 'reject') return Promise.reject(new Error('synthetic rejected'));
    const result = {
      id: `msg_test${++n}`,
      sessionID: input.sessionID,
      time: { created: 1794837342720 },
      type: 'synthetic',
      payload: { text: input.text, metadata: input.metadata },
      delivery: input.delivery,
    };
    if (fn.mode === 'manual') return new Promise((resolve) => fn.pending.push(() => resolve(result)));
    return Promise.resolve(result);
  };
  fn.calls = [];
  fn.mode = 'resolve';
  fn.pending = [];
  return fn;
}

// Inbox events, shaped as the 2.3.0 recording has them (fixture lines 280 and 299).
let evn = 0;
const enqueued = (sessionID, inboxID, mid, text = `[tmuxifier-mail ${mid}] x`) => ({
  id: `evt_e${++evn}`,
  created: 1794837342720 + evn,
  type: 'session.inbox.enqueued',
  durable: { aggregateID: sessionID, seq: 100 + evn, version: 1 },
  data: { sessionID, inboxID, item: { type: 'synthetic', payload: { text, metadata: { tmuxifierMail: mid } }, delivery: 'queue' } },
});
const delivered = (sessionID, inboxID) => ({
  id: `evt_d${++evn}`,
  created: 1794837349252 + evn,
  type: 'session.inbox.delivered',
  durable: { aggregateID: sessionID, seq: 100 + evn, version: 1 },
  location: { directory: DIR },
  data: { sessionID, inboxID },
});
const cancelled = (sessionID, inboxID) => ({ ...delivered(sessionID, inboxID), id: `evt_c${++evn}`, type: 'session.inbox.cancelled' });

// A mail part over the real socket. `waits`/`acks`: what the part asked the client for.
function makePart(over = {}) {
  const clock = over.clock ?? fakeClock();
  const synthetic = over.synthetic ?? fakeSynthetic();
  const raw = over.client ?? createMailSocketClient({ sockPath: over.sockPath ?? sock });
  const waits = [];
  const acks = [];
  const client = {
    wait: (a) => { waits.push({ session: a.session, pane: a.pane, at: clock.t }); return raw.wait(a); },
    ack: (a) => { acks.push(a); return raw.ack(a); },
  };
  const part = createMailPart({
    home: over.home ?? home,
    client,
    synthetic,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...(over.state !== undefined ? { state: over.state } : {}),
  });
  parts.push(part);
  return { part, clock, synthetic, waits, acks };
}

// OpenCode session states as derive() reports them.
let states;
const derive = (sid) => (states.has(sid) ? { state: states.get(sid), cause: 'stop', ts: 1 } : null);
const target = (over = {}) => ({ pane: PANE, sessionID: SID, dir: DIR, ...over });
const T = (...entries) => new Map(entries);
const MAIN = () => T(['main', target()]);

beforeEach(() => { states = new Map([[SID, 'ready'], [SID2, 'ready']]); });

const listening = (s = 'main') => h.hub.listening('o')[s] ?? 0;
const msgOf = (sent) => h.store.thread(sent.threadId).messages[0];
const waitsInLog = () => log.filter((e) => e[0] === 'wait').length;
const inflightFile = () => path.join(home, '.tmuxifier-mail', MAIL_INFLIGHT_FILE);

// Arm, send one message, and return once synthetic has been called for it.
async function handOne(p, { to = 'orders', body = 'which version?', session = 'main' } = {}) {
  p.part.sync(p.targets ?? MAIN(), derive);
  await until(() => listening(session) === 1, 'the wait to connect');
  const sent = await h.hub.send(B, to, body);
  expect(sent.ok).toBe(true);
  await until(() => p.synthetic.calls.length >= 1, 'synthetic to be called');
  return sent;
}

describe('arming', () => {
  test('an eligible ready pane holds one wait; the hub lists the session as listening', async () => {
    await start();
    const p = makePart();
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 1, 'the wait');
    // Later sweeps change nothing: still one request, one waiter.
    p.part.sync(MAIN(), derive);
    p.part.sync(MAIN(), derive);
    await settle();
    expect(p.waits).toEqual([{ session: 'main', pane: PANE, at: p.clock.t }]);
    expect(log).toEqual([['wait', 'main', PANE]]);
    expect(listening()).toBe(1);
  });

  test('no wait for a target that is not ready, nor for a session with no target', async () => {
    await start();
    const p = makePart();
    for (const s of ['working', 'blocked']) {
      states.set(SID, s);
      p.part.sync(MAIN(), derive);
    }
    states.delete(SID); // a session the reducer does not know
    p.part.sync(MAIN(), derive);
    p.part.sync(T(), derive);
    await settle();
    expect(p.waits).toEqual([]);
    states.set(SID, 'ready');
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 1, 'the wait once ready');
  });

  test('a tmux session name the hub cannot address is never armed, and costs the others nothing', async () => {
    expect(MAIL_SESSION_RE.source).toBe(SESSION_NAME_RE.source);
    expect(MAIL_SESSION_RE.flags).toBe(SESSION_NAME_RE.flags);
    await start();
    const p = makePart();
    p.part.sync(T(['my proj', target({ pane: '%4', sessionID: SID2 })], ['main', target()]), derive);
    await until(() => listening() === 1, 'the wait of main');
    await settle();
    expect(p.waits.map((w) => w.session)).toEqual(['main']);
    expect(p.clock.timers).toEqual([]); // no backoff from a 400
  });
});

describe('wake and confirmation', () => {
  test('mail → synthetic called once with the queue+resume input naming our message id', async () => {
    await start();
    const p = makePart();
    const sent = await handOne(p);
    const m = msgOf(sent);
    await settle();
    expect(p.synthetic.calls).toHaveLength(1);
    const input = p.synthetic.calls[0];
    expect(input).toEqual({
      sessionID: SID,
      text: expect.stringMatching(new RegExp(`^\\[tmuxifier-mail ${m.id}\\] `)),
      delivery: 'queue',
      resume: true,
      metadata: { tmuxifierMail: m.id },
    });
    expect(Object.keys(input).sort()).toEqual(['delivery', 'metadata', 'resume', 'sessionID', 'text']);
    expect(input.text).toContain('which version?');
    expect(m.state).toBe('handed');
    expect(p.acks).toEqual([]);
  });

  test('inbox.delivered for that item → ack; store reads delivered; only then a new wait connects', async () => {
    await start();
    const p = makePart();
    const sent = await handOne(p);
    const m = msgOf(sent);
    await settle();
    // Sweeps while the item is in flight arm nothing (re-arming would re-queue the handed message).
    p.part.sync(MAIN(), derive);
    p.part.sync(MAIN(), derive);
    await settle();
    expect(listening()).toBe(0);
    expect(log).toEqual([['wait', 'main', PANE]]);
    p.part.onEvent(enqueued(SID, 'msg_test1', m.id));
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
    await until(() => listening() === 1, 'the next wait');
    expect(log).toEqual([['wait', 'main', PANE], ['ack', 'main', m.id], ['wait', 'main', PANE]]);
    expect(p.acks).toEqual([{ session: 'main', messageId: m.id }]);
    expect(p.synthetic.calls).toHaveLength(1);
  });

  test('inbox.delivered without any enqueued event still matches by the id synthetic returned', async () => {
    await start();
    const p = makePart();
    const sent = await handOne(p);
    await settle();
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
  });

  test('delivered before synthetic resolves (enqueued named the item first) → acked, once', async () => {
    await start();
    const synthetic = fakeSynthetic();
    synthetic.mode = 'manual';
    const p = makePart({ synthetic });
    const sent = await handOne(p);
    const m = msgOf(sent);
    p.part.onEvent(enqueued(SID, 'msg_test1', m.id));
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
    synthetic.pending.shift()();
    await settle();
    expect(p.acks).toHaveLength(1);
    expect(log.filter((e) => e[0] === 'ack')).toHaveLength(1);
  });

  test('delivered seen before synthetic resolves, with no enqueued event → acked when it resolves', async () => {
    await start();
    const synthetic = fakeSynthetic();
    synthetic.mode = 'manual';
    const p = makePart({ synthetic });
    const sent = await handOne(p);
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await settle();
    expect(msgOf(sent).state).toBe('handed');
    expect(p.acks).toEqual([]);
    synthetic.pending.shift()();
    await until(() => msgOf(sent).state === 'delivered', 'the ack after synthetic resolved');
    await until(() => listening() === 1, 'the next wait');
  });

  test('a delivered event for someone else\'s item acks nothing', async () => {
    await start();
    const p = makePart();
    const sent = await handOne(p);
    await settle();
    p.part.onEvent(delivered(SID, 'msg_operatorPrompt'));
    await settle();
    expect(p.acks).toEqual([]);
    expect(msgOf(sent).state).toBe('handed');
  });

  test('inbox.cancelled → no ack; the message is re-offered to the next wait', async () => {
    await start();
    const p = makePart();
    const sent = await handOne(p);
    const m = msgOf(sent);
    await settle();
    p.part.onEvent(cancelled(SID, 'msg_test1'));
    await until(() => p.synthetic.calls.length === 2, 'the re-offer');
    expect(p.synthetic.calls[1].metadata).toEqual({ tmuxifierMail: m.id });
    expect(log).toEqual([['wait', 'main', PANE], ['wait', 'main', PANE]]);
    expect(p.acks).toEqual([]);
    expect(msgOf(sent).state).toBe('handed');
  });

  test('synthetic rejects → no ack; that pane backs off; then the message is re-offered', async () => {
    await start();
    const synthetic = fakeSynthetic();
    synthetic.mode = 'reject';
    const p = makePart({ synthetic });
    const sent = await handOne(p);
    await until(() => p.clock.timers.length > 0, 'the hold-off timer');
    expect(p.clock.delays()).toEqual([MAIL_BACKOFF_MIN_MS]);
    synthetic.mode = 'resolve';
    p.part.sync(MAIN(), derive);
    p.clock.advance(MAIL_BACKOFF_MIN_MS - 1);
    p.part.sync(MAIN(), derive);
    await settle();
    expect(p.waits).toHaveLength(1);
    expect(p.acks).toEqual([]);
    p.clock.advance(1);
    await until(() => synthetic.calls.length === 2, 'the re-offer after the hold-off');
    expect(synthetic.calls[1].metadata.tmuxifierMail).toBe(msgOf(sent).id);
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
  });

  test('no delivery event within REOFFER_MS → the pane re-arms (and the hub re-offers)', async () => {
    expect(MAIL_REOFFER_MS).toBe(600_000);
    // The hub's own constant (not exported): the part's fallback must match it.
    const hubSrc = fs.readFileSync(new URL('../src/server/agentMailHub.js', import.meta.url), 'utf8');
    expect(/const REOFFER_MS = ([\d_]+);/.exec(hubSrc)?.[1].replace(/_/g, '')).toBe(String(MAIL_REOFFER_MS));
    await start();
    const p = makePart();
    const sent = await handOne(p);
    await settle();
    p.clock.advance(MAIL_REOFFER_MS - 1);
    p.part.sync(MAIN(), derive);
    await settle();
    expect(p.waits).toHaveLength(1);
    p.clock.advance(1);
    await until(() => p.synthetic.calls.length === 2, 'the re-arm and re-offer');
    expect(p.waits).toHaveLength(2);
    expect(p.acks).toEqual([]);
    expect(p.synthetic.calls[1].metadata.tmuxifierMail).toBe(msgOf(sent).id);
  });

  test('a wake posted in a ready window that is not idle (shell exited, completion turn next) is still acked', async () => {
    // Fixture 509-510: after `shell.exited` the marker reads ready until the shell-completion
    // notice starts an execution. A wake posted then is `queue`d and delivered inside that
    // execution (F10); the part must still ack it and must not re-arm while it works.
    await start();
    const r = createReducer({ now: () => 1 });
    let i = 0;
    const ev = (type, data, dir) => r.apply({ id: `w${++i}`, type, created: 1794837500000 + i, data, ...(dir ? { location: { directory: dir } } : {}) });
    ev('session.created', { sessionID: SID }, DIR);
    ev('session.inbox.enqueued', { sessionID: SID, inboxID: 'msg_u1', item: { type: 'user' } }, DIR);
    ev('session.execution.started', { sessionID: SID });
    ev('shell.created', { info: { id: 'sh_1', metadata: { sessionID: SID } } }, DIR);
    ev('session.execution.succeeded', { sessionID: SID });
    expect(r.derive(SID).state).toBe('working');
    ev('shell.exited', { id: 'sh_1', exit: 0, status: 'exited' }, DIR);
    expect(r.derive(SID).state).toBe('ready');
    const p = makePart();
    p.part.sync(MAIN(), r.derive);
    await until(() => listening() === 1, 'the wait');
    const sent = await h.hub.send(B, 'orders', 'in the window');
    await until(() => p.synthetic.calls.length === 1, 'synthetic');
    const m = msgOf(sent);
    // The shell-completion notice, then the execution it starts; our item joins it.
    ev('session.inbox.enqueued', { sessionID: SID, inboxID: 'msg_shell', item: { type: 'synthetic', payload: { text: '<shell id="sh_1" state="completed">', metadata: { source: 'shell', shellID: 'sh_1' } } } });
    p.part.onEvent(enqueued(SID, 'msg_test1', m.id));
    r.apply(enqueued(SID, 'msg_test1', m.id));
    ev('session.execution.started', { sessionID: SID });
    expect(r.derive(SID).state).toBe('working');
    p.part.sync(MAIN(), r.derive);
    const d = delivered(SID, 'msg_test1');
    r.apply(d);
    p.part.onEvent(d);
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
    p.part.sync(MAIN(), r.derive);
    await settle();
    expect(listening()).toBe(0); // still working: no wait
    expect(p.waits).toHaveLength(1);
    ev('session.execution.succeeded', { sessionID: SID });
    p.part.sync(MAIN(), r.derive);
    await until(() => listening() === 1, 'the wait once ready again');
  });
});

describe('eligibility changes', () => {
  test('target lost → the held wait is aborted', async () => {
    await start();
    const p = makePart();
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 1, 'the wait');
    p.part.sync(T(), derive);
    await until(() => listening() === 0, 'the abort');
    await settle();
    expect(p.waits).toHaveLength(1);
  });

  test('state no longer ready → aborted; ready again → a new wait', async () => {
    await start();
    const p = makePart();
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 1, 'the wait');
    states.set(SID, 'working');
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 0, 'the abort');
    states.set(SID, 'ready');
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 1, 'the new wait');
    expect(p.waits).toHaveLength(2);
    expect(p.clock.timers).toEqual([]); // our own aborts never back off
  });

  test('the target moves to another OpenCode session → the wait is replaced, and mail goes to the new one', async () => {
    await start();
    const p = makePart();
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 1, 'the wait');
    p.part.sync(T(['main', target({ sessionID: SID2 })]), derive);
    await until(() => p.waits.length === 2, 'the second wait');
    await until(() => listening() === 1, 'one waiter');
    await h.hub.send(B, 'orders', 'to the new session');
    await until(() => p.synthetic.calls.length === 1, 'synthetic');
    expect(p.synthetic.calls[0].sessionID).toBe(SID2);
  });

  test('mail arriving after the target stopped being ready (no sync yet) is dropped, then re-offered', async () => {
    await start();
    const p = makePart();
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 1, 'the wait');
    states.set(SID, 'working'); // the reducer moved; the next sweep has not run
    const sent = await h.hub.send(B, 'orders', 'too late');
    await until(() => msgOf(sent).state === 'handed', 'the hand-off');
    await settle();
    expect(p.synthetic.calls).toEqual([]);
    expect(p.acks).toEqual([]);
    p.part.sync(MAIN(), derive);
    await settle();
    expect(p.waits).toHaveLength(1); // not ready: no re-arm, no loop
    states.set(SID, 'ready');
    p.part.sync(MAIN(), derive);
    await until(() => p.synthetic.calls.length === 1, 'the re-offer');
    expect(p.synthetic.calls[0].metadata.tmuxifierMail).toBe(msgOf(sent).id);
  });

  test('Review Focus 1: tmux session renamed → old wait aborted, new wait under the new name', async () => {
    h.marks.o = { main: mark('ready'), main2: mark('ready') };
    await start();
    const p = makePart();
    p.part.sync(MAIN(), derive);
    await until(() => listening('main') === 1, 'the wait under main');
    p.part.sync(T(['main2', target()]), derive);
    await until(() => listening('main') === 0 && listening('main2') === 1, 'the wait under main2');
    const sent = await h.hub.send(B, 'orders/main2', 'after the rename');
    expect(sent.ok).toBe(true);
    await until(() => p.synthetic.calls.length === 1, 'synthetic');
    await settle();
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
    expect(log.filter((e) => e[0] === 'ack')).toEqual([['ack', 'main2', msgOf(sent).id]]);
    expect(log.filter((e) => e[0] === 'wait').map((e) => e[1])).toEqual(['main', 'main2', 'main2']);
  });

  test('Review Focus 4: pane gone after synthetic, before delivery → still acked on delivery, no new wait', async () => {
    await start();
    const p = makePart();
    const sent = await handOne(p);
    await settle();
    p.part.sync(T(), derive); // the TUI exited: the pane is back at a shell
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
    p.part.sync(T(), derive);
    await settle();
    expect(p.waits).toHaveLength(1);
    expect(listening()).toBe(0);
  });
});

describe('the socket', () => {
  test('Review Focus 2: listener closed and socket removed → backoff 30 s, 60 s … capped at 30 min, nothing in between; re-arms when it answers', async () => {
    expect([MAIL_BACKOFF_MIN_MS, MAIL_BACKOFF_MAX_MS]).toEqual([30_000, 1_800_000]);
    await start();
    const p = makePart();
    p.part.sync(MAIN(), derive);
    await until(() => listening() === 1, 'the wait');
    await listener.close(); // Tmuxifier stops: the held wait ends idle, the socket file goes
    listener = null;
    expect(fs.existsSync(sock)).toBe(false);
    // The idle came back at once (under a second): the next wait comes a second later.
    await until(() => p.clock.timers.length === 1, 'the quick-idle hold-off');
    p.clock.advance(1000);
    expect(p.waits).toHaveLength(2);
    const delays = [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000];
    for (const delay of delays) {
      await until(() => p.clock.delays().includes(delay), `a ${delay} ms backoff`);
      expect(p.clock.delays()).toEqual([delay]);
      const before = p.waits.length;
      p.clock.advance(delay - 1);
      p.part.sync(MAIN(), derive); // sweeps keep coming; none may connect
      p.part.sync(MAIN(), derive);
      expect(p.waits).toHaveLength(before);
      p.clock.advance(1);
      expect(p.waits).toHaveLength(before + 1);
    }
    // Tmuxifier is back: the next scheduled try connects and holds.
    await until(() => p.clock.delays().includes(1_800_000), 'the capped backoff');
    await start();
    p.clock.advance(1_800_000);
    await until(() => listening() === 1, 'the re-armed wait');
    // An answer resets the backoff: the next outage starts at 30 s again.
    await listener.close();
    listener = null;
    await until(() => p.clock.delays().includes(1000), 'the quick-idle hold-off');
    p.clock.advance(1000);
    await until(() => p.clock.delays().includes(30_000), 'a fresh 30 s backoff');
  });

  test('one outage backs off once: two waits failing together give one 30 s timer, not 60 s', async () => {
    h.marks.o = { main: mark('ready'), web: mark('ready') };
    await start();
    const p = makePart();
    const both = T(['main', target()], ['web', target({ pane: '%9', sessionID: SID2 })]);
    p.part.sync(both, derive);
    await until(() => listening('main') === 1 && listening('web') === 1, 'two waits');
    await listener.close();
    listener = null;
    await until(() => p.clock.timers.length === 2, 'the two quick-idle hold-offs');
    p.clock.advance(1000);
    expect(p.waits).toHaveLength(4);
    await until(() => p.clock.delays().includes(30_000), 'the backoff');
    await settle();
    expect(p.clock.delays()).toEqual([30_000]);
    p.clock.advance(30_000);
    expect(p.waits).toHaveLength(6);
    await until(() => p.clock.delays().includes(60_000), 'the doubled backoff');
    await settle();
    expect(p.clock.delays()).toEqual([60_000]);
  });

  test('a socket path the kernel cannot bind (Review Focus 5) makes the part inert: one try, no retry loop', async () => {
    const long = path.join(home, 'x'.repeat(120), 'sock');
    const p = makePart({ sockPath: long });
    p.part.sync(MAIN(), derive);
    await settle();
    p.clock.advance(MAIL_BACKOFF_MAX_MS * 4);
    p.part.sync(MAIN(), derive);
    await settle();
    expect(p.waits).toHaveLength(1);
    expect(p.clock.timers).toEqual([]);
  });
});

describe('restart and hand-over', () => {
  test('the in-flight map is persisted 0600 with the inboxID, and removed when acked', async () => {
    await start();
    const p = makePart();
    const sent = await handOne(p);
    const m = msgOf(sent);
    await until(() => fs.existsSync(inflightFile()), 'the in-flight file');
    expect(fs.statSync(inflightFile()).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(fs.readFileSync(inflightFile(), 'utf8'));
    expect(doc.entries).toEqual([{ inboxID: 'msg_test1', messageId: m.id, tmuxSession: 'main', sessionID: SID, postedAt: p.clock.t }]);
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
    await until(() => !fs.existsSync(inflightFile()), 'the file to go');
  });

  test('the in-flight file is never written when ~/.tmuxifier-mail does not exist (never created)', async () => {
    await start();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mp-h-'));
    try {
      const p = makePart({ home: other });
      await handOne(p);
      await settle();
      expect(fs.readdirSync(other)).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('Review Focus 3 (F9): a restarted server delivers the old item with no enqueued replay; the new core acks it from the file and posts no second synthetic', async () => {
    await start();
    const a = makePart();
    const sent = await handOne(a);
    const m = msgOf(sent);
    await until(() => fs.existsSync(inflightFile()), 'the in-flight file');
    a.part.abort(); // the old OpenCode process is gone; nothing is handed over in memory
    // The new process: a fresh mail part, same home, a fresh clock a little later.
    const clock = fakeClock(a.clock.t + 20_000);
    const b = makePart({ clock });
    b.part.sync(MAIN(), derive);
    b.part.sync(MAIN(), derive);
    await settle();
    expect(b.waits).toEqual([]); // an entry for main is in flight: no wait, so nothing re-queued
    // A replayed enqueued for a known message id posts nothing either.
    b.part.onEvent(enqueued(SID, 'msg_test1', m.id));
    b.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack from the new core');
    await until(() => listening() === 1, 'the new core\'s first wait');
    expect(b.synthetic.calls).toEqual([]);
    expect(log).toEqual([['wait', 'main', PANE], ['ack', 'main', m.id], ['wait', 'main', PANE]]);
  });

  test('a loaded entry expires REOFFER_MS after it was posted, not after it was loaded', async () => {
    await start();
    const a = makePart();
    await handOne(a);
    await until(() => fs.existsSync(inflightFile()), 'the in-flight file');
    a.part.abort();
    const clock = fakeClock(a.clock.t + 100_000);
    const b = makePart({ clock });
    b.part.sync(MAIN(), derive);
    clock.advance(MAIL_REOFFER_MS - 100_000 - 1);
    b.part.sync(MAIN(), derive);
    await settle();
    expect(b.waits).toEqual([]);
    clock.advance(1);
    await until(() => b.waits.length === 1, 'the wait after expiry');
    // An entry already older than REOFFER_MS is not loaded at all.
    b.part.abort();
    const c = makePart({ clock: fakeClock(a.clock.t + MAIL_REOFFER_MS) });
    c.part.sync(MAIN(), derive);
    await until(() => c.waits.length === 1, 'a wait at once');
  });

  test('in-process hand-over: the next part gets the state, acks the item and posts nothing', async () => {
    await start();
    const a = makePart();
    const sent = await handOne(a);
    await settle();
    a.part.abort();
    fs.rmSync(inflightFile(), { force: true }); // the memory hand-over alone must carry it
    const b = makePart({ state: a.part.state });
    expect(b.part.state).toBe(a.part.state);
    b.part.sync(MAIN(), derive);
    await settle();
    expect(b.waits).toEqual([]);
    b.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
    expect(b.synthetic.calls).toEqual([]);
  });

  test('hand-over while synthetic is still pending: the old part records the id, the new part acks', async () => {
    await start();
    const synthetic = fakeSynthetic();
    synthetic.mode = 'manual';
    const a = makePart({ synthetic });
    const sent = await handOne(a);
    a.part.abort();
    const b = makePart({ state: a.part.state });
    b.part.sync(MAIN(), derive);
    synthetic.pending.shift()(); // resolves inside the aborted part
    await settle();
    expect(b.waits).toEqual([]);
    b.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
  });

  test('abort() ends every held wait and arms nothing', async () => {
    h.marks.o = { main: mark('ready'), web: mark('ready') };
    await start();
    const p = makePart();
    p.part.sync(T(['main', target()], ['web', target({ pane: '%9', sessionID: SID2 })]), derive);
    await until(() => listening('main') === 1 && listening('web') === 1, 'two waits');
    p.part.abort();
    await until(() => listening('main') === 0 && listening('web') === 0, 'both ended');
    p.part.sync(MAIN(), derive);
    p.clock.advance(MAIL_BACKOFF_MAX_MS);
    await settle();
    expect(p.waits).toHaveLength(2);
    expect(p.clock.timers).toEqual([]);
    expect(() => p.part.abort()).not.toThrow();
  });
});

describe('nothing throws', () => {
  test('synthetic throwing synchronously: no ack, the pane holds off, then the message is re-offered', async () => {
    await start();
    const synthetic = fakeSynthetic();
    synthetic.mode = 'throw';
    const p = makePart({ synthetic });
    const sent = await handOne(p);
    await until(() => p.clock.timers.length === 1, 'the hold-off');
    synthetic.mode = 'resolve';
    p.clock.advance(MAIL_BACKOFF_MIN_MS);
    await until(() => synthetic.calls.length === 2, 'the re-offer');
    expect(p.acks).toEqual([]);
    expect(msgOf(sent).state).toBe('handed');
  });

  test('client.wait rejecting or throwing → a socket backoff, never a throw', async () => {
    for (const wait of [() => Promise.reject(new Error('x')), () => { throw new Error('y'); }]) {
      const p = makePart({ client: { wait, ack: async () => false } });
      expect(() => p.part.sync(MAIN(), derive)).not.toThrow();
      await until(() => p.clock.timers.length === 1, 'the backoff');
      expect(p.clock.delays()).toEqual([MAIL_BACKOFF_MIN_MS]);
      p.part.abort();
    }
  });

  test('the socket client: null arguments are values, never a throw (issue #18)', async () => {
    expect(() => createMailSocketClient(null)).not.toThrow();
    const nowhere = createMailSocketClient(null);
    await expect(nowhere.wait({ session: 'main', pane: PANE })).resolves.toEqual({ kind: 'down', reason: 'path' });
    const c = createMailSocketClient({ sockPath: sock });
    expect(() => c.wait(null)).not.toThrow();
    await expect(c.wait(null)).resolves.toEqual({ kind: 'down', reason: 'args' });
    expect(() => c.ack(null)).not.toThrow();
    await expect(c.ack(null)).resolves.toBe(false);
  });

  test('malformed events and arguments return normally', async () => {
    await start();
    const p = makePart();
    const sent = await handOne(p);
    await settle();
    const throwing = {};
    Object.defineProperty(throwing, 'data', { get() { throw new Error('getter'); } });
    Object.defineProperty(throwing, 'type', { value: 'session.inbox.delivered' });
    const bad = [
      undefined, null, 5, 'x', {}, throwing,
      { type: 'session.inbox.delivered' },
      { type: 'session.inbox.delivered', data: null },
      { type: 'session.inbox.delivered', data: { inboxID: 5 } },
      { type: 'session.inbox.enqueued', data: { inboxID: 'msg_test1', item: null } },
      { type: 'session.inbox.enqueued', data: { inboxID: 'msg_x', item: { type: 'synthetic', payload: { metadata: { tmuxifierMail: {} } } } } },
      { type: 'session.inbox.cancelled', data: { inboxID: 'msg_x\n' } },
    ];
    for (const e of bad) expect(() => p.part.onEvent(e)).not.toThrow();
    for (const [t, d] of [[undefined, undefined], [null, null], [T(['main', null]), derive], [MAIN(), () => { throw new Error('derive'); }], [T([5, target()]), derive]]) {
      expect(() => p.part.sync(t, d)).not.toThrow();
    }
    await settle();
    expect(msgOf(sent).state).toBe('handed');
    p.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack still works');
  });
});

describe('parsePanesChecked (R17: fail closed on an incomplete listing)', () => {
  const row = (session, cmd = 'opencode', p = DIR, id = '%3') => `${session}\t1\t1\t${cmd}\t${p}\t${id}\n`;

  test('complete for a clean listing, with the same panes parsePanes returns', () => {
    const text = row('main') + row('web', 'zsh', '/tmp', '%4');
    expect(parsePanesChecked(text)).toEqual({ panes: parsePanes(text), complete: true });
    expect(parsePanesChecked('')).toEqual({ panes: [], complete: true });
  });

  test('incomplete when any non-empty line is dropped', () => {
    for (const bad of ['main\t1\t1\topencode\n', row('main', 'opencode', DIR, 'x'), row('a\x01b')]) {
      const r = parsePanesChecked(row('main') + bad);
      expect(r.complete).toBe(false);
      expect(r.panes).toEqual(parsePanes(row('main') + bad));
    }
  });

  test('incomplete when the 500-row cap is hit; exactly 500 rows is complete', () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => row(`s${i}`, 'zsh', '/tmp', `%${i}`)).join('');
    expect(parsePanesChecked(rows(500)).complete).toBe(true);
    const over = parsePanesChecked(rows(501));
    expect(over.complete).toBe(false);
    expect(over.panes).toHaveLength(500);
  });

  test('not a string → no panes, incomplete', () => {
    expect(parsePanesChecked(null)).toEqual({ panes: [], complete: false });
  });
});

describe('the core', () => {
  // A core whose reducer knows one ready session in DIR with operator evidence, over a listing
  // the test controls; `synthetic` given, so the core builds its mail part over home's socket.
  async function coreRig(over = {}) {
    const state = { panes: `main\t1\t1\topencode\t${DIR}\t${PANE}\n` };
    const synthetic = over.synthetic ?? fakeSynthetic();
    const opts = {
      home,
      now: () => 1000,
      listPanes: async () => state.panes,
      paneCacheMs: 0,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
      synthetic,
      ...over.opts,
    };
    const core = over.prev ? takeOver(over.prev, opts) : createCore(opts);
    if (!over.prev) {
      let i = 0;
      const ev = (type, data, dir) => core.handle({ id: `c${++i}`, type, created: 1_001_000 + i, data, ...(dir ? { location: { directory: dir } } : {}) });
      await ev('session.created', { sessionID: SID }, DIR);
      await ev('session.inbox.enqueued', { sessionID: SID, inboxID: 'msg_u1', item: { type: 'user' } }, DIR);
      await ev('session.execution.started', { sessionID: SID });
      await ev('session.execution.succeeded', { sessionID: SID });
    }
    return { core, state, synthetic, opts };
  }
  const cores = [];
  afterEach(() => { for (const c of cores.splice(0)) c.abort(); });

  test('a core given synthetic arms the eligible pane after a sweep and exposes mailState', async () => {
    await start();
    const { core } = await coreRig();
    cores.push(core);
    await core.sweep();
    await until(() => listening() === 1, 'the core\'s wait');
    expect(log).toEqual([['wait', 'main', PANE]]);
    expect(core.mailState).toBeTruthy();
    expect(core.mailState.inflight).toBeInstanceOf(Map);
  });

  test('no synthetic, or mail: null → no mail part, nothing waits', async () => {
    await start();
    for (const opts of [{ synthetic: null }, { mail: null }]) {
      const { core } = await coreRig({ opts });
      cores.push(core);
      await core.sweep();
      expect(core.mailState).toBe(null);
    }
    await settle();
    expect(log).toEqual([]);
  });

  test('an incomplete listing (a dropped row) or a failed one feeds no targets: the wait is aborted', async () => {
    await start();
    const { core, state } = await coreRig();
    cores.push(core);
    await core.sweep();
    await until(() => listening() === 1, 'the wait');
    const good = state.panes;
    state.panes = `${good}other\t1\t1\topencode\n`; // a row with the wrong field count
    await core.sweep();
    await until(() => listening() === 0, 'the abort on an incomplete listing');
    state.panes = good;
    await core.sweep();
    await until(() => listening() === 1, 'the wait again');
    state.panes = null; // tmux failed
    await core.sweep();
    await until(() => listening() === 0, 'the abort on a failed listing');
  });

  test('ambiguity appears (another tmux session hosts opencode in the same directory) → the wait is aborted', async () => {
    await start();
    const { core, state } = await coreRig();
    cores.push(core);
    await core.sweep();
    await until(() => listening() === 1, 'the wait');
    state.panes += `web\t0\t1\topencode\t${DIR}\t%8\n`; // hosting in a background window
    await core.sweep();
    await until(() => listening() === 0, 'the abort');
  });

  test('handle feeds inbox events to the mail part: delivered → ack', async () => {
    await start();
    const { core } = await coreRig();
    cores.push(core);
    await core.sweep();
    await until(() => listening() === 1, 'the wait');
    const sent = await h.hub.send(B, 'orders', 'via the core');
    await until(() => core.mailState.inflight.size === 1 && [...core.mailState.inflight.values()][0].inboxID, 'the post');
    await core.handle(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack');
  });

  test('takeOver: the old core\'s waits end, the next core gets prev.mailState and acks the in-flight item', async () => {
    await start();
    const first = await coreRig();
    cores.push(first.core);
    await first.core.sweep();
    await until(() => listening() === 1, 'the wait');
    const sent = await h.hub.send(B, 'orders', 'across a hand-over');
    await until(() => first.synthetic.calls.length === 1, 'synthetic');
    await settle();
    const next = await coreRig({ prev: first.core, opts: { synthetic: first.synthetic } });
    cores.push(next.core);
    expect(next.core.mailState).toBe(first.core.mailState);
    await next.core.sweep();
    await settle();
    expect(listening()).toBe(0); // in flight: no wait from either core
    await next.core.handle(delivered(SID, 'msg_test1'));
    await until(() => msgOf(sent).state === 'delivered', 'the ack by the next core');
    await next.core.sweep();
    await until(() => listening() === 1, 'the next core\'s wait');
    expect(first.synthetic.calls).toHaveLength(1);
  });

  test('the event stream ending on its own aborts the mail part: the held wait ends and nothing re-arms', async () => {
    await start();
    const { core } = await coreRig();
    cores.push(core);
    await core.sweep();
    await until(() => listening() === 1, 'the wait');
    let end;
    const ended = new Promise((r) => { end = r; });
    const ctx = { event: { subscribe: () => (async function* stream() { await ended; })() } };
    const attached = core.attach(ctx);
    end();
    await attached;
    await until(() => listening() === 0, 'the wait to end with the stream');
    await core.sweep(); // an ended core sweeps nothing and syncs nothing
    core.resyncMail();
    await settle();
    expect(listening()).toBe(0);
    expect(log.filter((e) => e[0] === 'wait')).toHaveLength(1);
  });

  test('takeOver aborts the old core\'s held wait', async () => {
    await start();
    const first = await coreRig();
    cores.push(first.core);
    await first.core.sweep();
    await until(() => listening() === 1, 'the wait');
    const next = await coreRig({ prev: first.core, opts: { synthetic: null } });
    cores.push(next.core);
    await until(() => listening() === 0, 'the old wait to end');
  });
});

describe('hand-over wakes, hold-offs (issue #18)', () => {
  // A client the test answers by hand: every wait and ack is a pending call it resolves.
  function manualClient() {
    const c = { waits: [], acks: [] };
    c.wait = (a) => new Promise((resolve) => {
      c.waits.push({ ...a, resolve });
      a.signal?.addEventListener('abort', () => resolve({ kind: 'down', reason: 'aborted' }), { once: true });
    });
    c.ack = (a) => new Promise((resolve) => c.acks.push({ ...a, resolve }));
    return c;
  }
  // A synthetic whose every call the test settles: calls[i].resolve(result) / .reject(err).
  function heldSynthetic() {
    const fn = (input) => new Promise((resolve, reject) => fn.calls.push({ input, resolve, reject }));
    fn.calls = [];
    return fn;
  }
  const tick = () => new Promise((r) => setImmediate(r));
  const MAIL = (id) => ({ kind: 'mail', text: `[tmuxifier-mail ${id}] hi`, messageId: id });

  test('an ack the aborted part finishes re-arms the new part at once, not at its next sync', async () => {
    const client = manualClient();
    const clock = fakeClock();
    const a = makePart({ client, clock });
    a.part.sync(MAIN(), derive);
    await tick();
    client.waits[0].resolve(MAIL('m-aaaaaaaa'));
    await until(() => a.synthetic.calls.length === 1, 'synthetic');
    await tick();
    a.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => client.acks.length === 1, 'the ack request');
    a.part.abort();
    const b = makePart({ client, clock, state: a.part.state });
    b.part.sync(MAIN(), derive);
    await tick();
    expect(b.waits).toEqual([]); // still in flight: no wait
    client.acks[0].resolve(true); // answers inside the aborted part
    await until(() => b.waits.length === 1, 'the new part to re-arm without a sync');
    expect(a.waits).toHaveLength(1);
    expect(a.part.state.inflight.size).toBe(0);
  });

  test('an ack refused (false) inside the aborted part still drops the entry and wakes the new part', async () => {
    const client = manualClient();
    const clock = fakeClock();
    const a = makePart({ client, clock });
    a.part.sync(MAIN(), derive);
    await tick();
    client.waits[0].resolve(MAIL('m-aaaaaaaa'));
    await until(() => a.synthetic.calls.length === 1, 'synthetic');
    await tick();
    a.part.onEvent(delivered(SID, 'msg_test1'));
    await until(() => client.acks.length === 1, 'the ack request');
    a.part.abort();
    const b = makePart({ client, clock, state: a.part.state });
    b.part.sync(MAIN(), derive);
    client.acks[0].resolve(false);
    await until(() => b.waits.length === 1, 'the re-arm');
    expect(a.part.state.inflight.size).toBe(0);
  });

  test('a synthetic that fails inside the aborted part holds the new part off 30 s, then it re-arms', async () => {
    const client = manualClient();
    const clock = fakeClock();
    const synthetic = heldSynthetic();
    const a = makePart({ client, clock, synthetic });
    a.part.sync(MAIN(), derive);
    await tick();
    client.waits[0].resolve(MAIL('m-aaaaaaaa'));
    await until(() => synthetic.calls.length === 1, 'synthetic');
    a.part.abort();
    const b = makePart({ client, clock, state: a.part.state });
    b.part.sync(MAIN(), derive);
    await tick();
    expect(b.waits).toEqual([]);
    synthetic.calls[0].reject(new Error('refused'));
    // (The other timer is the new part's REOFFER_MS timer of the entry it adopted; it finds the
    // entry gone when it fires.)
    await until(() => b.clock.delays().includes(MAIL_BACKOFF_MIN_MS), 'the new part\'s hold-off timer');
    expect(b.waits).toEqual([]);
    clock.advance(MAIL_BACKOFF_MIN_MS);
    await until(() => b.waits.length === 1, 'the re-arm after the hold-off');
  });

  test('the old part\'s delivered arriving at the new part before the old synthetic resolves: acked once, by the new part', async () => {
    const client = manualClient();
    const clock = fakeClock();
    const synthetic = heldSynthetic();
    const a = makePart({ client, clock, synthetic });
    a.part.sync(MAIN(), derive);
    await tick();
    client.waits[0].resolve(MAIL('m-aaaaaaaa'));
    await until(() => synthetic.calls.length === 1, 'synthetic');
    a.part.abort();
    const b = makePart({ client, clock, state: a.part.state });
    b.part.sync(MAIN(), derive);
    b.part.onEvent(delivered(SID, 'msg_x1')); // no entry knows msg_x1 yet: remembered
    await tick();
    expect(client.acks).toEqual([]);
    synthetic.calls[0].resolve({ id: 'msg_x1' }); // resolves inside the aborted part
    await until(() => client.acks.length === 1, 'the ack');
    expect(client.acks[0]).toMatchObject({ session: 'main', messageId: 'm-aaaaaaaa' });
    client.acks[0].resolve(true);
    await until(() => b.waits.length === 1, 'the re-arm');
    await tick();
    expect(client.acks).toHaveLength(1);
  });

  test('quick idles in a row double the hold-off (1 s, 2 s, 4 s ... 30 s); a slow idle ends the run', async () => {
    const client = manualClient();
    const clock = fakeClock();
    const p = makePart({ client, clock });
    p.part.sync(MAIN(), derive);
    const seen = [];
    for (let i = 0; i < 8; i++) {
      await until(() => client.waits.length === i + 1, `wait ${i + 1}`);
      client.waits[i].resolve({ kind: 'idle' });
      await until(() => clock.timers.length === 1, `hold-off ${i + 1}`);
      seen.push(clock.delays()[0]);
      clock.advance(clock.delays()[0]);
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    await until(() => client.waits.length === 9, 'wait 9');
    clock.advance(MAIL_BACKOFF_MIN_MS); // this one is held for a while
    client.waits[8].resolve({ kind: 'idle' });
    await until(() => client.waits.length === 10, 'a slow idle re-arms at once');
    expect(clock.timers).toEqual([]);
    client.waits[9].resolve({ kind: 'idle' }); // quick again: the run starts over at 1 s
    await until(() => clock.timers.length === 1, 'the first hold-off of a new run');
    expect(clock.delays()).toEqual([1000]);
  });

  test('a hold-off is dropped when the pane\'s target becomes another OpenCode session', async () => {
    const client = manualClient();
    const clock = fakeClock();
    const synthetic = heldSynthetic();
    const p = makePart({ client, clock, synthetic });
    p.part.sync(MAIN(), derive);
    await tick();
    client.waits[0].resolve(MAIL('m-aaaaaaaa'));
    await until(() => synthetic.calls.length === 1, 'synthetic');
    synthetic.calls[0].reject(new Error('refused'));
    await until(() => clock.timers.some((t) => t.at - clock.t === MAIL_BACKOFF_MIN_MS), 'the hold-off');
    p.part.sync(MAIN(), derive);
    await tick();
    expect(client.waits).toHaveLength(1); // held off for the same OpenCode session
    p.part.sync(T(['main', target({ sessionID: SID2 })]), derive);
    await until(() => client.waits.length === 2, 'the new session to arm at once');
    expect(client.waits[1]).toMatchObject({ session: 'main', pane: PANE });
  });
});
