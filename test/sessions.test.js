import { test, expect, vi } from 'vitest';
import { createSessionManager, provisionKey, terminalKey, localKey, safeClientId } from '../src/server/sessions.js';

// Minimal fake PTY so we can drive output without a real ssh/tmux process.
function fakePty() {
  let dataCb;
  let exitCb;
  return {
    cols: 80,
    rows: 24,
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    write: () => {},
    resize: () => {},
    kill: () => {},
    emit: (d) => dataCb && dataCb(d),
    fireExit: () => exitCb && exitCb({ exitCode: 0 }),
  };
}

test('attach replays recent output to a reattaching client (reattach is not a blank screen)', () => {
  const pty = fakePty();
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.open({ key: 'box1', box: { host: 'h', user: 'me' }, session: 'web', size: { cols: 80, rows: 24 } });

  // ssh prints its password prompt while no client is attached (e.g. the first
  // tab closed, leaving the session in its grace window).
  pty.emit("root@h's password: ");

  // A new client reattaches — it must immediately receive the buffered output,
  // not a blank screen.
  let got = '';
  mgr.attach(entry, (d) => { got += d; });
  expect(got).toContain("root@h's password:");
});

test('attach replay is bounded and ends with the most recent output', () => {
  const pty = fakePty();
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.open({ key: 'box2', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });

  pty.emit('X'.repeat(200000)); // far more than the replay cap
  pty.emit('\r\nPROMPT$ ');

  let got = '';
  mgr.attach(entry, (d) => { got += d; });
  expect(got.length).toBeLessThan(200000);     // bounded, not the whole history
  expect(got.endsWith('PROMPT$ ')).toBe(true); // keeps the most recent tail
});

test('attach replay strips terminal query sequences so xterm does not answer them back as input', () => {
  const pty = fakePty();
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.open({ key: 'bq', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });

  // A program emitted DA/DSR queries to the terminal (e.g. tmux capability probing).
  // Replaying them would make the real xterm reply (e.g. "\x1b[>0;276;0c"), and the
  // reply lands on the shell as typed garbage like "0;276;0c".
  pty.emit('\x1b[c');              // primary DA query
  pty.emit('\x1b[>c');             // secondary DA query (the 0;276;0c culprit)
  pty.emit('prompt$ \x1b[6n');     // visible text + cursor-position query
  pty.emit('\x1b[31mred\x1b[0m');  // a real color sequence that MUST survive

  let got = '';
  mgr.attach(entry, (d) => { got += d; });
  expect(got).not.toContain('\x1b[c');
  expect(got).not.toContain('\x1b[>c');
  expect(got).not.toContain('\x1b[6n');
  expect(got).toContain('prompt$ ');     // text preserved
  expect(got).toContain('\x1b[31mred\x1b[0m'); // colors preserved
});

// The grace timer and close() must evict by identity, not by key: if the PTY
// dies on its own during the grace window and the client reopens the box, the
// stale timer used to delete the NEW entry — hasLiveSession went false (letting
// the status poller probe over a live interactive login) and the next open
// spawned a duplicate ssh that kicked the first client's tmux attach.
test('a stale grace timer cannot evict a successor session under the same key', () => {
  vi.useFakeTimers();
  try {
    const pty1 = fakePty();
    const pty2 = fakePty();
    const ptys = [pty1, pty2];
    const mgr = createSessionManager({ spawn: () => ptys.shift(), graceSeconds: 1 });
    const e1 = mgr.open({ key: 'box1', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });
    mgr.detach(e1);   // no listeners → arms the grace timer
    pty1.fireExit();  // ssh dies on its own mid-grace (network drop)
    const e2 = mgr.open({ key: 'box1', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });
    expect(e2).not.toBe(e1);
    vi.advanceTimersByTime(60_000); // stale timer for e1 fires (if still armed)
    expect(mgr.hasLiveSession('box1')).toBe(true);
    expect(mgr._count()).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test('closing a replaced entry does not evict its successor', () => {
  const pty1 = fakePty();
  const pty2 = fakePty();
  const ptys = [pty1, pty2];
  const mgr = createSessionManager({ spawn: () => ptys.shift() });
  const e1 = mgr.open({ key: 'k', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });
  pty1.fireExit(); // e1's PTY is gone; the map no longer holds it
  const e2 = mgr.open({ key: 'k', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });
  mgr.close(e1);   // straggling cleanup still holding the old entry
  expect(mgr.hasLiveSession('k')).toBe(true);
  expect(e2.exited).toBe(false);
});

test('live output still fans out to an attached client after the replay', () => {
  const pty = fakePty();
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.open({ key: 'box3', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });

  let got = '';
  mgr.attach(entry, (d) => { got += d; });
  pty.emit('live-after-attach');
  expect(got).toContain('live-after-attach');
});

// Provision mode kills its PTY when the socket closes — but provision() hands
// the SAME entry to a second socket with the same key (e.g. a reconnect after
// a network blip). The old socket's straggling close must not abort the
// provisioning script the replacement is still watching (a nonzero exit rolls
// the box back as if the user cancelled).
test('a replaced provision socket closing does not kill the entry the replacement watches', () => {
  const pty = fakePty();
  let killed = false;
  pty.kill = () => { killed = true; };
  const mgr = createSessionManager({ spawn: () => pty });

  const e1 = mgr.provision({ key: 'provision:b1', box: { host: 'h' }, script: 'echo hi' });
  const off1 = mgr.attach(e1, () => {});
  const e2 = mgr.provision({ key: 'provision:b1', box: { host: 'h' }, script: 'echo hi' });
  expect(e2).toBe(e1); // second socket shares the live entry
  const off2 = mgr.attach(e2, () => {});

  // First socket closes (its listener detaches first, as in the WS handler).
  off1();
  expect(mgr.closeIfUnwatched(e1)).toBe(false);
  expect(killed).toBe(false);
  expect(mgr.hasLiveSession('provision:b1')).toBe(true);

  // Last socket closes — now the PTY really dies.
  off2();
  expect(mgr.closeIfUnwatched(e2)).toBe(true);
  expect(killed).toBe(true);
  expect(mgr.hasLiveSession('provision:b1')).toBe(false);
});

test('closeIfUnwatched on a sole-socket provision closes immediately (original behavior)', () => {
  const pty = fakePty();
  let killed = false;
  pty.kill = () => { killed = true; };
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.provision({ key: 'provision:b2', box: { host: 'h' }, script: 'echo hi' });
  const off = mgr.attach(entry, () => {});
  off();
  expect(mgr.closeIfUnwatched(entry)).toBe(true);
  expect(killed).toBe(true);
});

test('attach resize jiggle restores the original width (node-pty cols mutates on resize)', () => {
  // Mimic node-pty: resize() mutates the stored size and the getters return it.
  let dataCb;
  const pty = {
    cols: 120, rows: 30,
    resizes: [],
    resize(c, r) { this.resizes.push([c, r]); this.cols = c; this.rows = r; },
    onData: (cb) => { dataCb = cb; },
    onExit: () => {},
    write: () => {}, kill: () => {},
  };
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.open({ key: 'box1', box: { host: 'h', user: 'me' }, session: 'web', size: { cols: 120, rows: 30 } });
  mgr.attach(entry, () => {});
  expect(pty.resizes).toEqual([[119, 30], [120, 30]]);
  expect(pty.cols).toBe(120);
});

// B8 (2026-07-29 review): the interactive-finish PTY is keyed
// `provision:<boxId>`, so a plain hasLiveSession(box.id) reported "no live
// session" while the user was typing an SSH password at the -tt prompt. The
// status checker and Fleet then fired BatchMode probes into that prompt — the
// exact collision their guard exists to prevent — and stamped a 5-minute
// needsAuth backoff mid-finish. The guard has to cover both keys.
test('hasLiveSessionForBox sees a provision PTY, not just a terminal session', () => {
  const mgr = createSessionManager({ spawn: () => fakePty() });
  mgr.provision({ key: provisionKey('b1'), box: { id: 'b1', host: 'h', user: 'me' }, script: 'true' });

  expect(mgr.hasLiveSession('b1')).toBe(false);       // no ordinary terminal
  expect(mgr.hasLiveSessionForBox('b1')).toBe(true);  // but a live interactive login
});

test('hasLiveSessionForBox sees an ordinary terminal session too', () => {
  const mgr = createSessionManager({ spawn: () => fakePty() });
  mgr.open({ key: terminalKey('b1', 'viewer'), box: { id: 'b1', host: 'h', user: 'me' }, session: 'web', size: { cols: 80, rows: 24 } });
  expect(mgr.hasLiveSessionForBox('b1')).toBe(true);
});

test('hasLiveSessionForBox is false for a box with neither', () => {
  const mgr = createSessionManager({ spawn: () => fakePty() });
  expect(mgr.hasLiveSessionForBox('b1')).toBe(false);
});

// The replay lands on a client whose emulator was NEVER cleared. On a reconnect
// inside the PTY grace window that client still holds the screen it drew, so
// writing the buffer on top of it re-runs the window's scrolls and absolute
// cursor moves over the cells they already produced — the duplicated, smeared,
// misplaced characters that only a full browser restart cleared, because only a
// restart outlives the grace window and forces a fresh tmux attach.
//
// So the replay clears the screen it is about to rebuild. The SGR reset leads
// and is load-bearing: CSI 2J fills with the CURRENT background colour, so
// clearing while the client still carries a full-screen program's background
// would flood the terminal with it instead of blanking it.
test('attach clears the screen before replaying so the replay cannot paint over what is already there', () => {
  const pty = fakePty();
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.open({ key: 'box1', box: { host: 'h', user: 'me' }, session: 'web', size: { cols: 80, rows: 24 } });
  pty.emit('screen-the-client-already-drew');

  let got = '';
  mgr.attach(entry, (d) => { got += d; });
  expect(got).toBe('\x1b[0m\x1b[H\x1b[2Jscreen-the-client-already-drew');
});

// The clear rides along with a replay; it is not an unconditional write. A
// session that has produced nothing has no screen to rebuild, and clearing
// anyway would wipe whatever the client legitimately had.
test('attach sends nothing when there is no output to replay', () => {
  const pty = fakePty();
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.open({ key: 'box1', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });

  let got = '';
  mgr.attach(entry, (d) => { got += d; });
  expect(got).toBe('');
});

// --- one attach per viewer -------------------------------------------------
//
// Tmuxifier used to key a box's PTY by box id alone, so every browser watching
// a box shared ONE ssh and ONE `tmux attach`. That is mirroring, not
// multiplexing: there is a single screen, drawn at a single size, and whichever
// client resized last won. Any viewer whose window was SMALLER than that size
// then received cursor moves past its own last row/column — the smeared,
// misplaced characters reported from a multi-machine setup. (A viewer larger
// than the stream is fine; it just shows unused margin.)
//
// Now the key carries a per-viewer client id, so each browser gets its own
// attach and tmux — the actual multiplexer — sizes each client's screen itself.

test('terminalKey isolates viewers by client id but is stable for one viewer', () => {
  expect(terminalKey('box1', 'aaa')).toBe(terminalKey('box1', 'aaa')); // reconnect reuses its PTY
  expect(terminalKey('box1', 'aaa')).not.toBe(terminalKey('box1', 'bbb'));
  expect(terminalKey('box1', 'aaa')).not.toBe(terminalKey('box2', 'aaa'));
});

// A client id only ever becomes a Map key, never shell text — but it arrives
// from the browser, so it is bounded and charset-checked anyway. Anything
// unusable collapses to one shared id, which is exactly the old behaviour: a
// stale cached bundle that sends no id keeps working, sharing a PTY as before,
// instead of minting a fresh ssh on every reconnect.
test('safeClientId falls back to a shared id for a missing or unusable one', () => {
  expect(safeClientId('AbC-123_x')).toBe('AbC-123_x');
  expect(safeClientId(undefined)).toBe('shared');
  expect(safeClientId('')).toBe('shared');
  expect(safeClientId('has spaces')).toBe('shared');
  expect(safeClientId('a:b')).toBe('shared');
  expect(safeClientId('x'.repeat(65))).toBe('shared');
  expect(localKey(undefined)).toBe(localKey('shared'));
});

test('two viewers of one box get their own PTY instead of sharing a screen', () => {
  const spawned = [];
  const mgr = createSessionManager({ spawn: () => { const p = fakePty(); spawned.push(p); return p; } });
  const box = { id: 'box1', host: 'h', user: 'me' };

  const a = mgr.open({ key: terminalKey('box1', 'laptop'), box, session: 'web', size: { cols: 100, rows: 30 } });
  const b = mgr.open({ key: terminalKey('box1', 'desktop'), box, session: 'web', size: { cols: 200, rows: 50 } });

  expect(a).not.toBe(b);
  expect(spawned).toHaveLength(2); // two ssh/tmux clients, not one shared one
  expect(mgr._count()).toBe(2);
});

test('one viewer reconnecting reuses its own PTY rather than spawning another', () => {
  const spawned = [];
  const mgr = createSessionManager({ spawn: () => { const p = fakePty(); spawned.push(p); return p; } });
  const box = { id: 'box1', host: 'h' };
  const key = terminalKey('box1', 'laptop');

  const first = mgr.open({ key, box, session: 'web', size: { cols: 80, rows: 24 } });
  const again = mgr.open({ key, box, session: 'web', size: { cols: 80, rows: 24 } });

  expect(again).toBe(first);
  expect(spawned).toHaveLength(1);
});

// The probe and Fleet guards ask "is any interactive login live for this box?"
// so they never fire a BatchMode ssh into a live password prompt. They used to
// answer it by testing two literal keys; with a viewer id in the key that no
// longer works, so entries carry the box as a group instead.
test('hasLiveSessionForBox sees a terminal opened under any viewer id', () => {
  const mgr = createSessionManager({ spawn: () => fakePty() });
  mgr.open({ key: terminalKey('box1', 'some-viewer'), box: { id: 'box1', host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });

  expect(mgr.hasLiveSessionForBox('box1')).toBe(true);
  expect(mgr.hasLiveSessionForBox('box2')).toBe(false);
});

test('closeGroup drops every viewer of a box, not just the one that asked', () => {
  const killed = [];
  const mgr = createSessionManager({ spawn: () => { const p = fakePty(); p.kill = () => killed.push(p); return p; } });
  const box = { id: 'box1', host: 'h' };
  mgr.open({ key: terminalKey('box1', 'laptop'), box, session: 'web', size: { cols: 80, rows: 24 } });
  mgr.open({ key: terminalKey('box1', 'desktop'), box, session: 'web', size: { cols: 80, rows: 24 } });
  mgr.open({ key: terminalKey('box2', 'laptop'), box: { id: 'box2', host: 'h2' }, session: 'web', size: { cols: 80, rows: 24 } });

  mgr.closeGroup('box1');

  expect(killed).toHaveLength(2);
  expect(mgr.hasLiveSessionForBox('box1')).toBe(false);
  expect(mgr.hasLiveSessionForBox('box2')).toBe(true); // untouched
});

// Editing a box's connection fields drops its terminals so they reconnect with
// the new settings. It must NOT abort an interactive setup finish running on
// the same box — that PTY is someone typing an ssh password.
test('closeGroup can drop a box terminals while leaving its provision PTY alive', () => {
  const mgr = createSessionManager({ spawn: () => fakePty() });
  const box = { id: 'box1', host: 'h' };
  mgr.open({ key: terminalKey('box1', 'laptop'), box, session: 'web', size: { cols: 80, rows: 24 } });
  mgr.provision({ key: provisionKey('box1'), box, script: 'true' });

  mgr.closeGroup('box1', 'terminal');

  expect(mgr.hasLiveSession(terminalKey('box1', 'laptop'))).toBe(false);
  expect(mgr.hasLiveSession(provisionKey('box1'))).toBe(true);
});

// A viewer id comes from the browser, and each new one costs a real ssh process
// and a real tmux client. Bounded so a buggy or hostile client cannot mint them
// without limit.
test('opening more viewers than the cap throws instead of spawning without limit', () => {
  const mgr = createSessionManager({ spawn: () => fakePty(), maxViewersPerBox: 2 });
  const box = { id: 'box1', host: 'h' };
  // Attached, i.e. genuinely being watched — an unwatched PTY yields its slot.
  mgr.attach(mgr.open({ key: terminalKey('box1', 'v1'), box, session: 'web', size: { cols: 80, rows: 24 } }), () => {});
  mgr.attach(mgr.open({ key: terminalKey('box1', 'v2'), box, session: 'web', size: { cols: 80, rows: 24 } }), () => {});

  expect(() => mgr.open({ key: terminalKey('box1', 'v3'), box, session: 'web', size: { cols: 80, rows: 24 } }))
    .toThrow(/too many viewers/i);
  // An already-open viewer still reconnects once the cap is reached.
  expect(() => mgr.open({ key: terminalKey('box1', 'v1'), box, session: 'web', size: { cols: 80, rows: 24 } }))
    .not.toThrow();
});

// The cap counts LIVE viewers, and a browser tab that has gone away is not one.
// Its PTY lingers only so a reconnect can reclaim it, and holding a slot for
// the full grace window would let a handful of opened-and-closed tabs lock a
// box out of new viewers for 45 seconds.
test('an abandoned viewer in its grace window yields its slot to a new one', () => {
  const mgr = createSessionManager({ spawn: () => fakePty(), maxViewersPerBox: 2 });
  const box = { id: 'box1', host: 'h' };
  const size = { cols: 80, rows: 24 };

  const a = mgr.open({ key: terminalKey('box1', 'v1'), box, session: 'web', size });
  const offA = mgr.attach(a, () => {});
  const b = mgr.open({ key: terminalKey('box1', 'v2'), box, session: 'web', size });
  mgr.attach(b, () => {});

  offA();          // v1's tab closed: its listener is gone…
  mgr.detach(a);   // …and its PTY is only held for the grace window

  expect(() => mgr.open({ key: terminalKey('box1', 'v3'), box, session: 'web', size })).not.toThrow();
  expect(mgr.hasLiveSession(terminalKey('box1', 'v1'))).toBe(false); // reclaimed, not merely ignored
  expect(mgr.hasLiveSession(terminalKey('box1', 'v2'))).toBe(true);  // a watched viewer is untouched
});
