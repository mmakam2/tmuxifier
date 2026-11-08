import { test, expect } from 'vitest';
import {
  createReducer,
  PANE_FORMAT,
  parsePanes,
  isOpencodeCmd,
  dirMatches,
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

const pane = (session, path, cmd = 'opencode') => ({ session, cmd, path });
const sc = (f) => `${f.state}/${f.cause}`;

test('PANE_FORMAT lists session, active flags, command and path, tab-separated', () => {
  expect(PANE_FORMAT).toBe('#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}');
});

test('parsePanes keeps only the active pane of the active window and rejects malformed rows', () => {
  const text = 'web\t1\t1\topencode\t/home/user/proj\n' + 'web\t0\t1\tclaude\t/home/user/other\n' + 'dev\t1\t0\topencode\t/x\n' + 'bad\x01name\t1\t1\topencode\t/x\n' + 'short\t1\t1\n' + 'odd\t1\t1\tzsh\t/a\tb\n';
  expect(parsePanes(text)).toEqual([{ session: 'web', cmd: 'opencode', path: '/home/user/proj' }]);
});

test('parsePanes rejects controls in any field, over-long names and paths, and caps the rows', () => {
  const ok = (s, p = '/p') => `${s}\t1\t1\topencode\t${p}\n`;
  expect(parsePanes(ok('a b.c-d_e') + ok('x', '/a\x1bb') + ok('y\x7f') + ok('\t'.slice(1)))).toEqual([
    { session: 'a b.c-d_e', cmd: 'opencode', path: '/p' },
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

test('a session whose active window runs claude is not an opencode session even if another window is', () => {
  const text = 'web\t1\t1\tclaude\t/home/user/proj\nweb\t0\t1\topencode\t/home/user/proj\n';
  expect(parsePanes(text).filter((p) => isOpencodeCmd(p.cmd))).toEqual([]);
});

test('isOpencodeCmd accepts opencode and opencode-<suffix>, rejects node, bun, opencodex', () => {
  expect(isOpencodeCmd('opencode')).toBe(true);
  expect(isOpencodeCmd('opencode-linux-x64')).toBe(true);
  for (const cmd of ['node', 'bun', 'opencodex', 'xopencode', '', 'claude']) expect(isOpencodeCmd(cmd), cmd).toBe(false);
});

test('dirMatches: exact, trailing slash, pane under dir, dir under pane, unrelated', () => {
  expect(dirMatches('/a/b', '/a/b')).toBe(true);
  expect(dirMatches('/a/b', '/a/b/')).toBe(true);
  expect(dirMatches('/a/b/', '/a/b')).toBe(true);
  expect(dirMatches('/a/b', '/a/b/sub')).toBe(true);
  expect(dirMatches('/a/b/sub', '/a/b')).toBe(true);
  expect(dirMatches('/a/b', '/a/bc')).toBe(false);
  expect(dirMatches('/a/bc', '/a/b')).toBe(false);
  expect(dirMatches('/x', '/a/b')).toBe(false);
  expect(dirMatches(null, '/a/b')).toBe(false);
  // The filesystem root matches only itself, never everything under it.
  expect(dirMatches('/', '/')).toBe(true);
  expect(dirMatches('/', '/a')).toBe(false);
  expect(dirMatches('/a', '/')).toBe(false);
  expect(dirMatches('', '/a')).toBe(false);
  expect(dirMatches('/a', '')).toBe(false);
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
  // A session with no directory is attributed nowhere.
  const u = createReducer({ now: () => 50 });
  u.apply({ id: 'x', type: 'session.execution.started', data: { sessionID: 'ses_u' } });
  expect(sc(foldForPanes(u, [pane('one', '/proj')], new Map(), 999).get('one'))).toBe('ready/start');
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
