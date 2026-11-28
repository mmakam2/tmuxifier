import { test, expect, afterEach } from 'vitest';
import { createWorkerBench } from './helpers/workerBench.js';
import { buildZoomPaneRemote, buildUnzoomWindowRemote } from '../src/server/boxActions.js';
import { buildPaneSnapshotRemote, parsePaneSnapshot } from '../src/server/tmuxInject.js';
import { parseWindowState, isWindowStateLine } from '../src/server/phoneZoom.js';

// The zoom and restore scripts against a REAL tmux server. What a stub cannot show:
// `resize-pane -Z` is a TOGGLE, so every script here must be safe to run twice and
// safe to run against a window that changed since the capture that asked for it.
//
// Isolation: test/helpers/workerBench.js (a private tmux server on its own socket
// under a private TMUX_TMPDIR and HOME). Its `bin/tmux` wrapper heads the script's
// PATH, so nothing here can reach the operator's tmux server.

const benches = [];
afterEach(async () => {
  for (const b of benches.splice(0)) await b.cleanup();
});

// Session `main`: window A holds panes a1 (active) and a2; window B holds b1 alone.
function fixture() {
  const b = createWorkerBench({ defaultShell: 'bash' });
  benches.push(b);
  const out = (...args) => b.tmux(...args).trim();
  const winA = out('new-session', '-d', '-s', 'main', '-x', '120', '-y', '40', '-P', '-F', '#{window_id}', 'sleep 600');
  const a1 = out('display-message', '-p', '-t', `=main:${winA}`, '#{pane_id}');
  const a2 = out('split-window', '-d', '-t', `=main:${winA}.${a1}`, '-P', '-F', '#{pane_id}', 'sleep 600');
  const winB = out('new-window', '-d', '-t', '=main:', '-P', '-F', '#{window_id}', 'sleep 600');
  const b1 = out('display-message', '-p', '-t', `=main:${winB}`, '#{pane_id}');
  out('select-window', '-t', `=main:${winA}`);
  out('select-pane', '-t', `=main:${winA}.${a1}`);
  return {
    b, out, winA, winB, a1, a2, b1,
    zoomed: (win) => out('display-message', '-p', '-t', `=main:${win}`, '#{window_zoomed_flag}'),
    activeIn: (win) => out('display-message', '-p', '-t', `=main:${win}`, '#{pane_id}'),
    focus: () => out('display-message', '-p', '-t', '=main:', '#{window_id} #{pane_id}'),
    width: (pane) => Number(out('display-message', '-p', '-t', pane, '#{pane_width}')),
    zoom: (session, win, pane) => b.run('sh', buildZoomPaneRemote(session, win, pane)),
    unzoom: (session, win) => b.run('sh', buildUnzoomWindowRemote(session, win)),
  };
}

test('zooms the pane in front, and it then has the whole window', () => {
  const f = fixture();
  f.out('split-window', '-h', '-d', '-t', `=main:${f.winA}.${f.a1}`, 'sleep 600');
  const before = f.width(f.a1);
  const r = f.zoom('main', f.winA, f.a1);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('__ZOOMED__');
  expect(f.zoomed(f.winA)).toBe('1');
  expect(f.width(f.a1)).toBe(120);
  expect(before).toBeLessThan(120);
});

test('zoom run twice leaves it zoomed (it is a toggle in tmux, never here)', () => {
  const f = fixture();
  f.zoom('main', f.winA, f.a1);
  const again = f.zoom('main', f.winA, f.a1);
  expect(f.zoomed(f.winA)).toBe('1');
  // Already zoomed, so this run did not zoom anything and says so.
  expect(again.stdout).not.toContain('__ZOOMED__');
});

test('a pane that is no longer the one in front is not zoomed, and the front pane keeps its place', () => {
  const f = fixture();
  const r = f.zoom('main', f.winA, f.a2); // a1 is the active pane
  expect(r.stdout).not.toContain('__ZOOMED__');
  expect(f.zoomed(f.winA)).toBe('0');
  expect(f.activeIn(f.winA)).toBe(f.a1);
});

test('a window that is no longer the session\'s current one is not zoomed', () => {
  const f = fixture();
  f.out('select-window', '-t', `=main:${f.winB}`);
  const r = f.zoom('main', f.winA, f.a1);
  expect(r.stdout).not.toContain('__ZOOMED__');
  expect(f.zoomed(f.winA)).toBe('0');
  expect(f.focus()).toBe(`${f.winB} ${f.b1}`);
});

test('a window with one pane is not zoomed and nothing is claimed', () => {
  const f = fixture();
  f.out('select-window', '-t', `=main:${f.winB}`);
  const r = f.zoom('main', f.winB, f.b1);
  expect(r.stdout).not.toContain('__ZOOMED__');
  expect(f.zoomed(f.winB)).toBe('0');
});

test('a pane that is not in that window fails and zooms nothing', () => {
  const f = fixture();
  const r = f.zoom('main', f.winA, f.b1);
  expect(r.code).not.toBe(0);
  expect(r.stdout).not.toContain('__ZOOMED__');
  expect(f.zoomed(f.winA)).toBe('0');
  expect(f.zoomed(f.winB)).toBe('0');
});

test('a session that only prefixes a real one is not matched', () => {
  const f = fixture();
  const r = f.zoom('mai', f.winA, f.a1);
  expect(r.code).not.toBe(0);
  expect(f.zoomed(f.winA)).toBe('0');
});

test('unzoom restores a zoomed window, and run twice leaves it unzoomed', () => {
  const f = fixture();
  f.zoom('main', f.winA, f.a1);
  const r = f.unzoom('main', f.winA);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('__UNZOOMED__');
  expect(f.zoomed(f.winA)).toBe('0');
  const again = f.unzoom('main', f.winA);
  expect(again.stdout).not.toContain('__UNZOOMED__');
  expect(f.zoomed(f.winA)).toBe('0');
});

test('unzoom works on a window that is no longer the current one, without changing focus', () => {
  const f = fixture();
  f.zoom('main', f.winA, f.a1);
  f.out('select-window', '-t', `=main:${f.winB}`);
  const r = f.unzoom('main', f.winA);
  expect(r.stdout).toContain('__UNZOOMED__');
  expect(f.zoomed(f.winA)).toBe('0');
  expect(f.focus()).toBe(`${f.winB} ${f.b1}`);
});

test('unzoom of a window that is gone fails and touches nothing', () => {
  const f = fixture();
  f.zoom('main', f.winA, f.a1);
  const r = f.unzoom('main', '@999');
  expect(r.code).not.toBe(0);
  expect(f.zoomed(f.winA)).toBe('1');
});

test('the capture with window state starts with a line the parser accepts, then the ordinary snapshot', () => {
  const f = fixture();
  const r = f.b.run('sh', buildPaneSnapshotRemote('main', { lines: 5, windowState: true }));
  expect(r.code).toBe(0);
  const nl = r.stdout.indexOf('\n');
  const first = r.stdout.slice(0, nl);
  expect(isWindowStateLine(first)).toBe(true);
  expect(parseWindowState(first)).toEqual({ windowId: f.winA, zoomed: false, panes: 2 });
  const snap = parsePaneSnapshot(r.stdout.slice(nl + 1));
  expect(snap.pane).toBe(f.a1);

  f.zoom('main', f.winA, f.a1);
  const z = f.b.run('sh', buildPaneSnapshotRemote('main', { lines: 5, windowState: true }));
  expect(parseWindowState(z.stdout.slice(0, z.stdout.indexOf('\n')))).toEqual({ windowId: f.winA, zoomed: true, panes: 2 });
});

test('the capture without window state is byte-for-byte what it was', () => {
  expect(buildPaneSnapshotRemote('main', { lines: 5 })).toBe(buildPaneSnapshotRemote('main', { lines: 5, windowState: false }));
  expect(buildPaneSnapshotRemote('main', { lines: 5 })).not.toContain('__WZ__');
});

test.each([
  ['a bad session', () => buildZoomPaneRemote('ma in', '@1', '%1')],
  ['a bad window', () => buildZoomPaneRemote('main', '1', '%1')],
  ['a bad pane', () => buildZoomPaneRemote('main', '@1', '1')],
  ['a non-string pane', () => buildZoomPaneRemote('main', '@1', 1)],
  ['unzoom: a bad session', () => buildUnzoomWindowRemote("m'ain", '@1')],
  ['unzoom: a bad window', () => buildUnzoomWindowRemote('main', '@1;x')],
])('the builders refuse %s', (_name, build) => {
  expect(build).toThrow();
});
