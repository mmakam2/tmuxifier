import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolveTarget } from '../src/server/agentMailHub.js';
import { refusalText } from '../src/server/agentMailText.js';
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
    expect(none).toEqual({ ok: false, text: refusalText('no-agent', { who: 'orders/main' }) });

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
