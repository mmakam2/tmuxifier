import { test, expect } from 'vitest';
import {
  createReducer,
  PANE_FORMAT,
  parsePanes,
  isOpencodeCmd,
  dirExact,
  dirUnder,
  foldForPanes,
  markerLine,
} from '../src/server/assets/tmuxifier-opencode-agent.js';

// Pane attribution: which tmux session an OpenCode session's state is written
// to (spec §4.1 "Attribution and writing").

// A reducer driven by synthetic events; `created` is in ms, `ts` in seconds.
function world() {
  const r = createReducer({ now: () => 1 });
  let i = 0;
  const ev = (type, created, data, dir) =>
    r.apply({ id: `w${++i}`, type, created: created * 1000, data, ...(dir ? { location: { directory: dir } } : {}) });
  return {
    r,
    created: (sid, at, dir, parentID) => ev('session.created', at, { sessionID: sid, ...(parentID ? { parentID } : {}) }, dir),
    start: (sid, at) => ev('session.execution.started', at, { sessionID: sid }),
    end: (sid, at) => ev('session.execution.succeeded', at, { sessionID: sid }),
    ask: (sid, at, id) => ev('permission.asked', at, { id, sessionID: sid }),
  };
}

const pane = (session, path, cmd = 'opencode', active = true) => ({ session, cmd, path, active });
const sc = (f) => `${f.state}/${f.cause}`;

test('PANE_FORMAT lists session, active flags, command and path, tab-separated', () => {
  expect(PANE_FORMAT).toBe('#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}');
});

test('parsePanes returns every well-formed row, active only for the active pane of the active window, and rejects malformed rows', () => {
  const text = 'web\t1\t1\topencode\t/home/user/proj\n' + 'web\t0\t1\tclaude\t/home/user/other\n' + 'dev\t1\t0\topencode\t/x\n' + 'bad\x01name\t1\t1\topencode\t/x\n' + 'short\t1\t1\n' + 'odd\t1\t1\tzsh\t/a\tb\n';
  expect(parsePanes(text)).toEqual([
    { session: 'web', cmd: 'opencode', path: '/home/user/proj', active: true },
    { session: 'web', cmd: 'claude', path: '/home/user/other', active: false },
    { session: 'dev', cmd: 'opencode', path: '/x', active: false },
  ]);
});

test('parsePanes rejects controls in any field, over-long names and paths, and caps the rows', () => {
  const ok = (s, p = '/p') => `${s}\t1\t1\topencode\t${p}\n`;
  expect(parsePanes(ok('a b.c-d_e') + ok('x', '/a\x1bb') + ok('y\x7f') + ok('\t'.slice(1)))).toEqual([
    { session: 'a b.c-d_e', cmd: 'opencode', path: '/p', active: true },
  ]);
  expect(parsePanes(ok('n'.repeat(256)))).toHaveLength(1);
  expect(parsePanes(ok('n'.repeat(257)))).toEqual([]);
  expect(parsePanes(ok('p', '/' + 'p'.repeat(4095)))).toHaveLength(1);
  expect(parsePanes(ok('p', '/' + 'p'.repeat(4096)))).toEqual([]);
  expect(parsePanes(ok('crlf').replace('\n', '\r\n'))).toEqual([]); // a CR is a control
  expect(parsePanes('nopath\t1\t1\topencode\t\n')).toEqual([]); // an empty path would match every directory
  let many = '';
  for (let k = 0; k < 600; k++) many += ok(`s${k}`);
  expect(parsePanes(many)).toHaveLength(500);
  for (const bad of [undefined, null, 42, {}]) expect(parsePanes(bad)).toEqual([]);
});

test('a session whose active window runs claude is not folded even if another window runs opencode', () => {
  const text = 'web\t1\t1\tclaude\t/home/user/proj\nweb\t0\t1\topencode\t/home/user/proj\n';
  const panes = parsePanes(text);
  expect(panes.filter((p) => isOpencodeCmd(p.cmd)).map((p) => p.active)).toEqual([false]);
  expect(foldForPanes(createReducer(), panes, new Map(), 1).has('web')).toBe(false);
  // The opencode window becoming the active one is what makes it read opencode.
  const back = parsePanes('web\t0\t1\tclaude\t/home/user/proj\nweb\t1\t1\topencode\t/home/user/proj\n');
  expect(foldForPanes(createReducer(), back, new Map(), 1).get('web')).toEqual({ state: 'ready', cause: 'start', ts: 1 });
});

test('isOpencodeCmd accepts opencode and opencode-<suffix>, rejects node, bun, opencodex', () => {
  expect(isOpencodeCmd('opencode')).toBe(true);
  expect(isOpencodeCmd('opencode-linux-x64')).toBe(true);
  for (const cmd of ['node', 'bun', 'opencodex', 'xopencode', '', 'claude']) expect(isOpencodeCmd(cmd), cmd).toBe(false);
});

test('dirExact and dirUnder: trailing slashes, the pane deeper than the directory only, never the reverse, `/` only itself', () => {
  expect(dirExact('/a/b', '/a/b')).toBe(true);
  expect(dirExact('/a/b', '/a/b/')).toBe(true);
  expect(dirExact('/a/b/', '/a/b')).toBe(true);
  expect(dirExact('/a/b', '/a/b/sub')).toBe(false);
  expect(dirUnder('/a/b', '/a/b/sub')).toBe(true); // a pane deeper than the directory OpenCode reports
  expect(dirUnder('/a/b/', '/a/b/sub/x')).toBe(true);
  expect(dirUnder('/a/b', '/a/b')).toBe(false); // exact is its own tier
  expect(dirUnder('/a/b/sub', '/a/b')).toBe(false); // a parent pane never absorbs a child project
  for (const f of [dirExact, dirUnder]) {
    expect(f('/a/b', '/a/bc')).toBe(false);
    expect(f('/a/bc', '/a/b')).toBe(false);
    expect(f('/x', '/a/b')).toBe(false);
    expect(f(null, '/a/b')).toBe(false);
    expect(f('', '/a')).toBe(false);
    expect(f('/a', '')).toBe(false);
    expect(f('/a', undefined)).toBe(false);
  }
  // The filesystem root matches only itself, never everything under it.
  expect(dirExact('/', '/')).toBe(true);
  expect(dirUnder('/', '/a')).toBe(false);
  expect(dirUnder('/a', '/')).toBe(false);
});

test('foldForPanes: blocked beats working beats ready; ties go to the newest ts; the cause and ts are the chosen session\'s', () => {
  const w = world();
  for (const s of ['ses_a', 'ses_b', 'ses_c']) w.created(s, 100, '/proj');
  w.start('ses_a', 110); w.end('ses_a', 120); // ready/stop @120
  w.start('ses_b', 130); // working/prompt @130
  const panes = [pane('web', '/proj')];
  const since = new Map([['web', 0]]);
  expect(foldForPanes(w.r, panes, since, 999).get('web')).toEqual({ state: 'working', cause: 'prompt', ts: 130 });
  w.ask('ses_c', 140, 'per_c'); // blocked/permission @140 on a session that never started
  expect(foldForPanes(w.r, panes, since, 999).get('web')).toEqual({ state: 'blocked', cause: 'permission', ts: 140 });

  // Ties within a state: the newest ts wins.
  const t = world();
  t.created('ses_old', 100, '/proj'); t.created('ses_new', 100, '/proj');
  t.start('ses_new', 150); t.start('ses_old', 160); t.end('ses_old', 170); t.end('ses_new', 180);
  expect(foldForPanes(t.r, panes, since, 999).get('web')).toEqual({ state: 'ready', cause: 'stop', ts: 180 });
  t.start('ses_old', 200); t.start('ses_new', 210);
  expect(foldForPanes(t.r, panes, since, 999).get('web').ts).toBe(210);
  // A session that never started is a ready candidate like any other.
  const n = world();
  n.created('ses_n', 300, '/proj');
  expect(foldForPanes(n.r, panes, since, 999).get('web')).toEqual({ state: 'ready', cause: 'start', ts: 300 });
});

test('foldForPanes: a finished turn outranks a newer session that has not started (fixture lines 336-342)', () => {
  const w = world();
  w.created('ses_done', 100, '/proj'); w.start('ses_done', 110); w.end('ses_done', 120); // ready/stop @120
  w.created('ses_fresh', 200, '/proj'); // ready/start @200, newer
  const panes = [pane('web', '/proj')];
  expect(foldForPanes(w.r, panes, new Map([['web', 0]]), 999).get('web')).toEqual({ state: 'ready', cause: 'stop', ts: 120 });
  // Once the fresh session starts, it wins as working.
  w.start('ses_fresh', 210);
  expect(foldForPanes(w.r, panes, new Map([['web', 0]]), 999).get('web')).toEqual({ state: 'working', cause: 'prompt', ts: 210 });
  // A finished turn older than since is still excluded: the fresh session's ready/start shows.
  const x = world();
  x.created('ses_done', 100, '/proj'); x.start('ses_done', 110); x.end('ses_done', 120);
  x.created('ses_fresh', 200, '/proj');
  expect(foldForPanes(x.r, panes, new Map([['web', 150]]), 999).get('web')).toEqual({ state: 'ready', cause: 'start', ts: 200 });
});

test('foldForPanes: a session finished before the pane\'s since is excluded and the pane reads ready/start at since', () => {
  const w = world();
  w.created('ses_a', 100, '/proj'); w.start('ses_a', 110); w.end('ses_a', 120);
  const panes = [pane('web', '/proj')];
  expect(foldForPanes(w.r, panes, new Map([['web', 500]]), 999).get('web')).toEqual({ state: 'ready', cause: 'start', ts: 500 });
  // ts equal to since is still a candidate.
  expect(sc(foldForPanes(w.r, panes, new Map([['web', 120]]), 999).get('web'))).toBe('ready/stop');
  // A newer turn of the same session is its own state again.
  w.start('ses_a', 600);
  expect(foldForPanes(w.r, panes, new Map([['web', 500]]), 999).get('web')).toEqual({ state: 'working', cause: 'prompt', ts: 600 });
  // No since recorded for the pane: everything counts; no candidates at all reads ready/start at now.
  expect(sc(foldForPanes(w.r, panes, new Map(), 999).get('web'))).toBe('working/prompt');
  expect(foldForPanes(createReducer(), panes, new Map(), 999).get('web')).toEqual({ state: 'ready', cause: 'start', ts: 999 });
});

test('foldForPanes: two tmux sessions in the same directory get the same fold; a pane in another directory is untouched', () => {
  const w = world();
  w.created('ses_a', 100, '/proj'); w.start('ses_a', 110);
  const panes = [pane('one', '/proj'), pane('two', '/proj/sub'), pane('other', '/elsewhere'), pane('shell', '/proj', 'zsh')];
  const fold = foldForPanes(w.r, panes, new Map(), 999);
  expect(fold.get('one')).toEqual({ state: 'working', cause: 'prompt', ts: 110 });
  expect(fold.get('two')).toEqual(fold.get('one'));
  expect(fold.get('other')).toEqual({ state: 'ready', cause: 'start', ts: 999 });
  expect(fold.has('shell')).toBe(false); // not an opencode pane: never written
  // An opencode pane that is not the active pane of the active window is never folded.
  expect(foldForPanes(w.r, [pane('bg', '/proj', 'opencode', false)], new Map(), 999).has('bg')).toBe(false);
  // A session with no directory is attributed nowhere.
  const u = createReducer({ now: () => 50 });
  u.apply({ id: 'x', type: 'session.execution.started', data: { sessionID: 'ses_u' } });
  expect(sc(foldForPanes(u, [pane('one', '/proj')], new Map(), 999).get('one'))).toBe('ready/start');
});

test('foldForPanes: an exact directory match wins over a nested project; a parent pane never folds a child project', () => {
  const w = world();
  w.created('ses_top', 100, '/home/user/repo'); w.start('ses_top', 110); w.end('ses_top', 120); // ready/stop @120
  w.created('ses_sub', 130, '/home/user/repo/sub'); w.start('ses_sub', 140); w.ask('ses_sub', 150, 'per_s'); // blocked @150
  const panes = [pane('top', '/home/user/repo'), pane('sub', '/home/user/repo/sub')];
  const fold = foldForPanes(w.r, panes, new Map(), 999);
  expect(fold.get('top')).toEqual({ state: 'ready', cause: 'stop', ts: 120 });
  expect(fold.get('sub')).toEqual({ state: 'blocked', cause: 'permission', ts: 150 });
  // A parent pane with no session of its own still does not absorb the child project.
  const c = world();
  c.created('ses_sub', 130, '/home/user/repo/sub'); c.start('ses_sub', 140);
  expect(foldForPanes(c.r, [pane('top', '/home/user/repo')], new Map(), 999).get('top')).toEqual({ state: 'ready', cause: 'start', ts: 999 });
  // A pane deeper than every reported directory falls back to the directories above it.
  const d = world();
  d.created('ses_top', 100, '/home/user/repo'); d.start('ses_top', 110);
  expect(foldForPanes(d.r, [pane('deep', '/home/user/repo/sub/x')], new Map(), 999).get('deep')).toEqual({ state: 'working', cause: 'prompt', ts: 110 });
  // An exact session, even a finished one before since, keeps the prefix tier out:
  // the pane's own directory is the one OpenCode reports for it.
  d.created('ses_deep', 200, '/home/user/repo/sub/x'); d.start('ses_deep', 210); d.end('ses_deep', 220);
  d.ask('ses_top', 600, 'per_t'); // the parent directory's session is blocked, and newer
  expect(foldForPanes(d.r, [pane('deep', '/home/user/repo/sub/x')], new Map(), 999).get('deep')).toEqual({ state: 'ready', cause: 'stop', ts: 220 });
  expect(foldForPanes(d.r, [pane('deep', '/home/user/repo/sub/x')], new Map([['deep', 500]]), 999).get('deep')).toEqual({ state: 'ready', cause: 'start', ts: 500 });
});

test('foldForPanes: child sessions are never chosen directly', () => {
  const w = world();
  w.created('ses_p', 100, '/proj');
  w.start('ses_p', 110); w.end('ses_p', 120);
  w.created('ses_c', 130, '/proj', 'ses_p');
  w.start('ses_c', 140);
  const panes = [pane('web', '/proj')];
  // The child's work rolls up into the parent: the parent is the one chosen,
  // so the ts is the parent's (moved by the child's start).
  expect(foldForPanes(w.r, panes, new Map(), 999).get('web')).toEqual({ state: 'working', cause: 'prompt', ts: 140 });
  w.ask('ses_c', 150, 'per_c');
  expect(foldForPanes(w.r, panes, new Map(), 999).get('web')).toEqual({ state: 'blocked', cause: 'permission', ts: 150 });
  // An orphan child whose parent is gone is still not a root, so not a candidate.
  w.r.apply({ id: 'del', type: 'session.deleted', created: 160_000, data: { sessionID: 'ses_p' } });
  expect(sc(foldForPanes(w.r, panes, new Map(), 999).get('web'))).toBe('ready/start');
});

test('markerLine writes session:state:ts:cause with a trailing newline', () => {
  expect(markerLine('web', { state: 'blocked', cause: 'permission', ts: 1794098652 })).toBe('web:blocked:1794098652:permission\n');
  expect(markerLine('octest', { state: 'ready', cause: 'start', ts: 0 })).toBe('octest:ready:0:start\n');
});

test('foldForPanes treats a missing or non-Map since as empty', () => {
  const w = world();
  w.created('ses_a', 100, '/proj'); w.start('ses_a', 110);
  const panes = [pane('web', '/proj')];
  for (const since of [undefined, null, {}, [['web', 500]], 'web']) {
    expect(foldForPanes(w.r, panes, since, 999).get('web'), String(since)).toEqual({ state: 'working', cause: 'prompt', ts: 110 });
  }
});
