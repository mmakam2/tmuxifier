import { test, expect, vi } from 'vitest';
import { createSessionManager } from '../src/server/sessions.js';

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
