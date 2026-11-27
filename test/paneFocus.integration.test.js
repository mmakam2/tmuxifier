import { test, expect, afterEach } from 'vitest';
import path from 'node:path';
import { createWorkerBench } from './helpers/workerBench.js';
import { buildSelectPaneRemote } from '../src/server/boxActions.js';

// buildSelectPaneRemote against a REAL tmux server: what a click on an agent runs on the box.
// The cases that matter are the ones a stub cannot show: that a window and a pane which do not
// go together fail AND leave the operator's focus where it was (a pane that closed or moved
// between the poll and the click must not drag the operator to the wrong window), and that
// -Z keeps a zoomed window zoomed on the pane just focused.
//
// Isolation: test/helpers/workerBench.js (a private tmux server on its own -L socket under a
// private TMUX_TMPDIR and HOME, an environment built from scratch). Its `bin/tmux` wrapper
// heads the script's PATH, so the script's own tmux lookup (`command -v tmux`) lands on the
// private server and never on the operator's. `cleanup` kills that server only.

const benches = [];
afterEach(async () => {
  for (const b of benches.splice(0)) await b.cleanup();
});

// Session `main`: window A holds panes a1, a2 and window B holds b1, b2 (all running `sleep`,
// so no shell reads any rc file). Window A is current and a1 is its active pane.
function fixture() {
  const b = createWorkerBench({ defaultShell: 'bash' });
  benches.push(b);
  const out = (...args) => b.tmux(...args).trim();
  const winA = out('new-session', '-d', '-s', 'main', '-x', '120', '-y', '40', '-P', '-F', '#{window_id}', 'sleep 600');
  const a1 = out('display-message', '-p', '-t', `=main:${winA}`, '#{pane_id}');
  const a2 = out('split-window', '-d', '-t', `=main:${winA}.${a1}`, '-P', '-F', '#{pane_id}', 'sleep 600');
  const winB = out('new-window', '-d', '-t', '=main:', '-P', '-F', '#{window_id}', 'sleep 600');
  const b1 = out('display-message', '-p', '-t', `=main:${winB}`, '#{pane_id}');
  const b2 = out('split-window', '-d', '-t', `=main:${winB}.${b1}`, '-P', '-F', '#{pane_id}', 'sleep 600');
  out('select-window', '-t', `=main:${winA}`);
  out('select-pane', '-t', `=main:${winA}.${a1}`);
  return {
    b, out, winA, winB, a1, a2, b1, b2,
    // The operator's focus: the session's current window and its active pane.
    focus: () => out('display-message', '-p', '-t', '=main:', '#{window_id} #{pane_id}'),
    // The active pane of one window, current or not.
    activeIn: (win) => out('display-message', '-p', '-t', `=main:${win}`, '#{pane_id}'),
    zoomed: (win) => out('display-message', '-p', '-t', `=main:${win}`, '#{window_zoomed_flag}'),
    select: (session, win, pane) => b.run('sh', buildSelectPaneRemote(session, win, pane)),
  };
}

test('the script finds the bench\'s tmux, not the machine\'s', () => {
  const f = fixture();
  const found = f.b.run('sh', 'command -v tmux').stdout.trim();
  expect(found).toBe(path.join(f.b.env.PATH.split(':')[0], 'tmux'));
});

test('focuses another window and a pane of it that was not the active one', () => {
  const f = fixture();
  // Start somewhere else: window B current, and a2 (not a1) the active pane of window A.
  f.out('select-pane', '-t', `=main:${f.winA}.${f.a2}`);
  f.out('select-window', '-t', `=main:${f.winB}`);
  expect(f.focus()).toBe(`${f.winB} ${f.b1}`);

  const r = f.select('main', f.winA, f.a1);

  expect(r.code).toBe(0);
  expect(f.focus()).toBe(`${f.winA} ${f.a1}`);
  // list-panes agrees: this window is the active one and this pane the active pane of it.
  const rows = f.out('list-panes', '-t', '=main', '-F', '#{window_id} #{pane_id} #{window_active} #{pane_active}').split('\n');
  expect(rows).toContain(`${f.winA} ${f.a1} 1 1`);
  expect(rows).toContain(`${f.winA} ${f.a2} 1 0`);
});

test('keeps a zoomed window zoomed, now on the pane just focused', () => {
  const f = fixture();
  f.out('resize-pane', '-Z', '-t', `=main:${f.winA}.${f.a1}`);
  expect(f.zoomed(f.winA)).toBe('1');

  const r = f.select('main', f.winA, f.a2);

  expect(r.code).toBe(0);
  expect(f.zoomed(f.winA)).toBe('1');
  expect(f.activeIn(f.winA)).toBe(f.a2);
  expect(f.focus()).toBe(`${f.winA} ${f.a2}`);
});

test('a pane that is not in the named window fails and focuses nothing', () => {
  const f = fixture();
  // The poll said a1 lived in window B (it moved, or the client paired the ids wrongly).
  // Selecting window B first would already have dragged the operator there.
  const before = f.focus();
  expect(before).toBe(`${f.winA} ${f.a1}`);
  const bActive = f.activeIn(f.winB);

  const r = f.select('main', f.winB, f.a1);

  expect(r.code).not.toBe(0);
  expect(f.focus()).toBe(before);
  expect(f.activeIn(f.winB)).toBe(bActive);
});

test('a pane that closed fails and focuses nothing', () => {
  const f = fixture();
  // Pane ids are never reused within a server's life, so a closed pane's id is gone for good.
  const closed = f.out('split-window', '-d', '-t', `=main:${f.winB}.${f.b1}`, '-P', '-F', '#{pane_id}', 'sleep 600');
  f.out('kill-pane', '-t', closed);
  const before = f.focus();
  const bActive = f.activeIn(f.winB);

  const r = f.select('main', f.winB, closed);

  expect(r.code).not.toBe(0);
  expect(f.focus()).toBe(before);
  expect(f.activeIn(f.winB)).toBe(bActive);
});

test('a window that closed fails and focuses nothing', () => {
  const f = fixture();
  const gone = f.out('new-window', '-d', '-t', '=main:', '-P', '-F', '#{window_id}', 'sleep 600');
  const gonePane = f.activeIn(gone);
  f.out('kill-window', '-t', `=main:${gone}`);
  const before = f.focus();

  const r = f.select('main', gone, gonePane);

  expect(r.code).not.toBe(0);
  expect(f.focus()).toBe(before);
});

test('a session that does not exist fails, and a name that only prefixes a real one is not it', () => {
  const f = fixture();
  const before = f.focus();

  expect(f.select('ghost', f.winB, f.b1).code).not.toBe(0);
  // `-t 'mai'` would prefix-match `main`; the exact `=mai` must not.
  expect(f.select('mai', f.winB, f.b1).code).not.toBe(0);

  expect(f.focus()).toBe(before);
});
