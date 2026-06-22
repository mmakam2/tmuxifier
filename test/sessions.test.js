import { test, expect } from 'vitest';
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

test('live output still fans out to an attached client after the replay', () => {
  const pty = fakePty();
  const mgr = createSessionManager({ spawn: () => pty });
  const entry = mgr.open({ key: 'box3', box: { host: 'h' }, session: 'web', size: { cols: 80, rows: 24 } });

  let got = '';
  mgr.attach(entry, (d) => { got += d; });
  pty.emit('live-after-attach');
  expect(got).toContain('live-after-attach');
});
