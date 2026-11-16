import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createReducer,
  PANE_FORMAT,
  STATE_VERSION,
  parsePanes,
  mailTargets,
  foldForPanes,
} from '../src/server/assets/tmuxifier-opencode-agent.js';

// Which tmux pane may receive mail for which OpenCode session (spec §6.3
// rules 1-3; rule 4, "ready", is the waiter's own check). Operator evidence
// is a `session.viewed` or a `user` inbox item, per the OpenCode 2.3.0
// recording (test/fixtures/README-opencode-2.3-event-trace.md, F1-F2).

// A reducer driven by synthetic events; `created` is in ms, evidenceAt in seconds.
function world() {
  const r = createReducer({ now: () => 1 });
  let i = 0;
  const ev = (type, createdMs, data, dir) =>
    r.apply({ id: `e${++i}`, type, created: createdMs, data, ...(dir ? { location: { directory: dir } } : {}) });
  return {
    r,
    created: (sid, at, dir, parentID) =>
      ev('session.created', at * 1000, { sessionID: sid, ...(parentID ? { parentID } : {}) }, dir),
    start: (sid, at) => ev('session.execution.started', at * 1000, { sessionID: sid }),
    end: (sid, at) => ev('session.execution.succeeded', at * 1000, { sessionID: sid }),
    // `item.type` 'user' is an operator prompt; the inbox event names the directory.
    inbox: (sid, at, dir, type = 'user') =>
      ev('session.inbox.enqueued', at * 1000, { sessionID: sid, inboxID: `i${i}`, item: { type } }, dir),
    // `session.viewed` carries no location (F2).
    viewed: (sid, atMs) => ev('session.viewed', atMs, { sessionID: sid, idle: atMs - 40 }),
  };
}

const row = (session, wa, pa, cmd, p, id) => `${session}\t${wa}\t${pa}\t${cmd}\t${p}\t${id}\n`;
const panesOf = (...rows) => parsePanes(rows.join(''));
const SINCE0 = (...names) => new Map(names.map((n) => [n, 0]));

test('PANE_FORMAT gains #{pane_id} as its sixth field, and the state version moved with the session shape', () => {
  expect(PANE_FORMAT).toBe(
    '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_id}',
  );
  expect(STATE_VERSION).toBe(4); // Task 3 made it 2 (evidenceAt, the pane field), the mail wake flag 3, its removal 4
});

test('parsePanes drops a row whose pane id is not %N, and keeps pane otherwise', () => {
  const ok = row('web', '1', '1', 'opencode', '/home/user/proj', '%7');
  expect(parsePanes(ok)).toEqual([
    { session: 'web', cmd: 'opencode', path: '/home/user/proj', active: true, pane: '%7' },
  ]);
  expect(parsePanes(row('a', '1', '1', 'opencode', '/p', '%123456789'))).toHaveLength(1);
  for (const bad of ['', '7', '%', '%x', '%-1', '%1234567890', '%7 ', ' %7', '%7;id', '%07a', '$7', '@7']) {
    expect(parsePanes(row('a', '1', '1', 'opencode', '/p', bad))).toEqual([]);
  }
  // Exactly six fields: five (the old format) and seven are both refused.
  expect(parsePanes('web\t1\t1\topencode\t/p\n')).toEqual([]);
  expect(parsePanes(`${ok.trimEnd()}\textra\n`)).toEqual([]);
});

test('evidence: session.viewed and a user inbox item set evidenceAt; a synthetic item does not', () => {
  const w = world();
  w.created('ses_a', 100, '/p');
  expect(w.r.sessions.get('ses_a').evidenceAt).toBe(0);
  w.inbox('ses_a', 101, '/p', 'synthetic'); // OpenCode's own notice or our mail wake
  expect(w.r.sessions.get('ses_a').evidenceAt).toBe(0);
  w.inbox('ses_a', 102.9, '/p', 'user');
  expect(w.r.sessions.get('ses_a').evidenceAt).toBe(102);
  w.viewed('ses_a', 110_999);
  expect(w.r.sessions.get('ses_a').evidenceAt).toBe(Math.floor(110_999 / 1000)); // 110
  w.inbox('ses_a', 120, '/p', 'synthetic');
  expect(w.r.sessions.get('ses_a').evidenceAt).toBe(110);
});

test('evidence falls back to the injected clock when created is not a finite number', () => {
  const r = createReducer({ now: () => 777 });
  r.apply({ id: 'x1', type: 'session.created', created: 1000, data: { sessionID: 'ses_a' }, location: { directory: '/p' } });
  r.apply({ id: 'x2', type: 'session.viewed', data: { sessionID: 'ses_a' } });
  expect(r.sessions.get('ses_a').evidenceAt).toBe(777);
});

test('recording evidence changes no derived state, no ts, and creates no session', () => {
  const w = world();
  w.created('ses_a', 100, '/p');
  w.start('ses_a', 101);
  w.end('ses_a', 102);
  const before = w.r.derive('ses_a');
  expect(before).toEqual({ state: 'ready', cause: 'stop', ts: 102 });
  expect(w.viewed('ses_a', 105_000)).toBe(false);
  expect(w.inbox('ses_a', 106, '/p', 'user')).toBe(false);
  expect(w.r.derive('ses_a')).toEqual(before);
  // A view of a session nobody told the reducer about is ignored outright.
  expect(w.viewed('ses_unknown', 107_000)).toBe(false);
  expect(w.r.sessions.has('ses_unknown')).toBe(false);
  expect(w.r.state.hints.has('ses_unknown')).toBe(false);
});

test('a user prompt for a session the reducer does not know yet seeds its evidence when the session is created', () => {
  const w = world();
  // `opencode -c`: no session.created, the first inbox item only leaves a hint.
  w.inbox('ses_resumed', 200.5, '/p', 'user');
  expect(w.r.sessions.has('ses_resumed')).toBe(false);
  expect(w.r.state.hints.get('ses_resumed')).toMatchObject({ dir: '/p', lastInbox: 'user', evidenceAt: 200 });
  // The turn's execution.started (no directory of its own) creates it from the hint.
  w.start('ses_resumed', 201);
  const s = w.r.sessions.get('ses_resumed');
  expect(s.evidenceAt).toBe(200);
  expect(s.dir).toBe('/p');
  expect(w.r.state.hints.has('ses_resumed')).toBe(false);
  // A step event, which names session and directory, creates it just the same.
  w.inbox('ses_resumed2', 210, '/q', 'user');
  w.r.apply({ id: 'step', type: 'session.step.started', created: 211_000, data: { sessionID: 'ses_resumed2' }, location: { directory: '/q' } });
  expect(w.r.sessions.get('ses_resumed2')).toMatchObject({ evidenceAt: 210, dir: '/q' });
  // A synthetic notice before the prompt leaves no evidence in the hint.
  const v = world();
  v.inbox('ses_s', 300, '/p', 'synthetic');
  expect(v.r.state.hints.get('ses_s').evidenceAt).toBe(0);
  v.inbox('ses_s', 310, '/p', 'user');
  v.inbox('ses_s', 320, '/p', 'synthetic');
  expect(v.r.state.hints.get('ses_s')).toMatchObject({ lastInbox: 'synthetic', evidenceAt: 310 });
  // A view of a session nobody has created is ignored, so it cannot seed anything.
  v.viewed('ses_s', 400_000);
  expect(v.r.state.hints.get('ses_s').evidenceAt).toBe(310);
});

test('the real 2.3.0 plain turn: the prompt then the view set evidenceAt, nothing else moves', () => {
  const trace = fileURLToPath(new URL('./fixtures/opencode-2.3-event-trace.jsonl', import.meta.url));
  const recs = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const from = recs.findIndex((x) => x.kind === 'scenario' && x.name === 'a-plain');
  const to = recs.findIndex((x) => x.kind === 'scenario' && x.name === 'h1-tmx-who');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const r = createReducer({ now: () => 1 });
  const evidence = [];
  let sid = null;
  for (const rec of recs.slice(from, to)) {
    if (rec.kind !== 'event') continue;
    r.apply(rec.event);
    if (rec.event.type === 'session.created') sid = rec.event.data.sessionID;
    if (sid && r.sessions.get(sid)) evidence.push(r.sessions.get(sid).evidenceAt);
  }
  const viewed = recs.slice(from, to).find((x) => x.kind === 'event' && x.event.type === 'session.viewed').event;
  const prompt = recs.slice(from, to).find((x) => x.kind === 'event' && x.event.type === 'session.inbox.enqueued').event;
  expect(prompt.data.item.type).toBe('user');
  const s = r.sessions.get(sid);
  expect(s.evidenceAt).toBe(Math.floor(viewed.created / 1000));
  // The prompt alone had already set it, before the turn started or ended.
  expect(evidence).toContain(Math.floor(prompt.created / 1000));
  expect(r.derive(sid)).toMatchObject({ state: 'ready', cause: 'stop' });
  const panes = panesOf(row('octest', '1', '1', 'opencode', '/home/user/proj', '%3'));
  expect(mailTargets(r, panes, SINCE0('octest')).get('octest')).toEqual({ pane: '%3', sessionID: sid, dir: '/home/user/proj' });
});

test('a pane with only persisted, unviewed sessions in its directory has no target', () => {
  const w = world();
  // Sessions that merely exist in the directory (finished turns, no operator evidence).
  w.created('ses_old', 10, '/proj');
  w.start('ses_old', 11);
  w.end('ses_old', 12);
  w.created('ses_old2', 20, '/proj');
  w.inbox('ses_old2', 21, '/proj', 'synthetic');
  const panes = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'));
  expect(mailTargets(w.r, panes, new Map()).size).toBe(0);
  expect(mailTargets(w.r, panes, SINCE0('web')).size).toBe(0); // a floor of 0 is still no evidence
  // The first view or prompt makes the pane eligible.
  w.viewed('ses_old2', 30_000);
  expect(mailTargets(w.r, panes, SINCE0('web')).get('web')).toEqual({ pane: '%1', sessionID: 'ses_old2', dir: '/proj' });
});

test('the newest evidence since hosting wins among root sessions in the directory; child sessions are never targets', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.created('ses_b', 11, '/proj');
  w.created('ses_child', 12, '/proj', 'ses_b');
  w.inbox('ses_a', 50, '/proj');
  w.inbox('ses_b', 60, '/proj');
  w.viewed('ses_child', 90_000); // the newest of all, but a subagent session
  const panes = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'));
  expect(mailTargets(w.r, panes, SINCE0('web')).get('web').sessionID).toBe('ses_b');
  w.viewed('ses_a', 70_000);
  expect(mailTargets(w.r, panes, SINCE0('web')).get('web').sessionID).toBe('ses_a');
});

test('evidence older than since does not count; evidence at since does', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.created('ses_b', 11, '/proj');
  w.inbox('ses_a', 50, '/proj');
  w.inbox('ses_b', 60, '/proj');
  const panes = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'));
  const at = (n) => mailTargets(w.r, panes, new Map([['web', n]])).get('web')?.sessionID;
  expect(at(55)).toBe('ses_b'); // ses_a's prompt predates this TUI, ses_b's does not
  expect(at(60)).toBe('ses_b');
  expect(at(61)).toBe(undefined); // both predate it: not listening
  expect(at(50)).toBe('ses_b');
  // Another tmux session's floor does not apply.
  expect(mailTargets(w.r, panes, new Map([['dev', 99]])).get('web').sessionID).toBe('ses_b');
});

test('two sessions with the same newest evidence second are ambiguous: no target', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.created('ses_b', 11, '/proj');
  w.inbox('ses_a', 50.1, '/proj');
  w.inbox('ses_b', 50.9, '/proj');
  const panes = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'));
  expect(mailTargets(w.r, panes, SINCE0('web')).size).toBe(0);
  w.viewed('ses_b', 51_000);
  expect(mailTargets(w.r, panes, SINCE0('web')).get('web').sessionID).toBe('ses_b');
});

test('directory tiers: an exact directory beats a parent; a parent is used only when nothing is exact', () => {
  const w = world();
  w.created('ses_root', 10, '/proj');
  w.created('ses_sub', 11, '/proj/sub');
  w.inbox('ses_root', 80, '/proj');
  w.inbox('ses_sub', 50, '/proj/sub');
  const sub = panesOf(row('web', '1', '1', 'opencode', '/proj/sub', '%1'));
  // /proj/sub has a session of its own: its older evidence wins over the parent project's newer one.
  expect(mailTargets(w.r, sub, SINCE0('web')).get('web').sessionID).toBe('ses_sub');
  // A pane in a directory with no session of its own falls back to the parent.
  const deeper = panesOf(row('web', '1', '1', 'opencode', '/proj/other', '%1'));
  expect(mailTargets(w.r, deeper, SINCE0('web')).get('web').sessionID).toBe('ses_root');
  // Never the reverse: a TUI in a parent directory does not absorb the projects below it.
  const above = panesOf(row('web', '1', '1', 'opencode', '/', '%1'));
  expect(mailTargets(w.r, above, SINCE0('web')).size).toBe(0);
  // And a stale-only exact tier is not escaped to a parent project (the fold's rule too).
  const stale = new Map([['web', 60]]); // ses_sub's prompt (50) is stale, the parent's (80) is not
  expect(mailTargets(w.r, sub, stale).size).toBe(0);
});

test('two tmux sessions hosting opencode in one directory: neither is in the map', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.inbox('ses_a', 50, '/proj');
  const one = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'));
  expect(mailTargets(w.r, one, SINCE0('web', 'dev')).get('web').sessionID).toBe('ses_a');
  const two = panesOf(
    row('web', '1', '1', 'opencode', '/proj', '%1'),
    row('dev', '1', '1', 'opencode', '/proj', '%2'),
  );
  expect(mailTargets(w.r, two, SINCE0('web', 'dev')).size).toBe(0);
});

test('the second TUI in a non-active window or pane still makes the directory ambiguous', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.inbox('ses_a', 50, '/proj');
  const since = SINCE0('web', 'dev');
  const inOtherWindow = panesOf(
    row('web', '1', '1', 'opencode', '/proj', '%1'),
    row('dev', '1', '1', 'zsh', '/proj', '%2'),
    row('dev', '0', '1', 'opencode', '/proj', '%3'),
  );
  expect(mailTargets(w.r, inOtherWindow, since).size).toBe(0);
  const inOtherPane = panesOf(
    row('dev', '1', '0', 'opencode', '/proj', '%3'),
    row('dev', '1', '1', 'zsh', '/proj', '%2'),
    row('web', '1', '1', 'opencode', '/proj', '%1'),
  );
  expect(mailTargets(w.r, inOtherPane, since).size).toBe(0);
  // dev hosts opencode but its active pane runs a shell: it is not a target itself.
  expect(mailTargets(w.r, inOtherPane, since).has('dev')).toBe(false);
  // A pane in dev that does not run opencode never counts.
  const shellOnly = panesOf(
    row('web', '1', '1', 'opencode', '/proj', '%1'),
    row('dev', '1', '1', 'zsh', '/proj', '%2'),
    row('dev', '0', '1', 'claude', '/proj', '%3'),
  );
  expect(mailTargets(w.r, shellOnly, since).get('web')).toEqual({ pane: '%1', sessionID: 'ses_a', dir: '/proj' });
});

test('a second TUI in a subdirectory or parent of the target directory is in the same tier', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.inbox('ses_a', 50, '/proj');
  const since = SINCE0('web', 'dev');
  // dev's TUI sits below the directory OpenCode reports: its tier reaches ses_a too.
  const below = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'), row('dev', '0', '0', 'opencode', '/proj/sub', '%2'));
  expect(mailTargets(w.r, below, since).size).toBe(0);
  // dev's TUI in an unrelated directory is no ambiguity.
  const apart = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'), row('dev', '1', '1', 'opencode', '/elsewhere', '%2'));
  expect(mailTargets(w.r, apart, since).get('web').sessionID).toBe('ses_a');
  // A parent directory is never in the tier of a deeper session.
  const parent = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'), row('dev', '1', '1', 'opencode', '/', '%2'));
  expect(mailTargets(w.r, parent, since).get('web').sessionID).toBe('ses_a');
});

test('another opencode pane of the same tmux session is not another tmux session', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.inbox('ses_a', 50, '/proj');
  const panes = panesOf(
    row('web', '1', '1', 'opencode', '/proj', '%1'),
    row('web', '0', '1', 'opencode', '/proj', '%2'),
  );
  expect(mailTargets(w.r, panes, SINCE0('web')).get('web')).toEqual({ pane: '%1', sessionID: 'ses_a', dir: '/proj' });
});

test('different directories on one box: each tmux session maps to its own session', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.created('ses_b', 11, '/proj2');
  w.inbox('ses_a', 50, '/proj');
  w.inbox('ses_b', 40, '/proj2');
  const panes = panesOf(
    row('web', '1', '1', 'opencode', '/proj', '%1'),
    row('dev', '1', '1', 'opencode', '/proj2', '%4'),
  );
  const out = mailTargets(w.r, panes, SINCE0('web', 'dev'));
  expect([...out.keys()].sort()).toEqual(['dev', 'web']);
  expect(out.get('web')).toEqual({ pane: '%1', sessionID: 'ses_a', dir: '/proj' });
  expect(out.get('dev')).toEqual({ pane: '%4', sessionID: 'ses_b', dir: '/proj2' });
});

test('only the active pane of the active window of an opencode session is a target', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.inbox('ses_a', 50, '/proj');
  const since = SINCE0('web');
  for (const [wa, pa] of [['0', '1'], ['1', '0'], ['0', '0']]) {
    expect(mailTargets(w.r, panesOf(row('web', wa, pa, 'opencode', '/proj', '%1')), since).size).toBe(0);
  }
  // Active, but running a shell or Claude: not opencode, no target.
  for (const cmd of ['zsh', 'claude', 'node', 'opencodex']) {
    expect(mailTargets(w.r, panesOf(row('web', '1', '1', cmd, '/proj', '%1')), since).size).toBe(0);
  }
  expect(mailTargets(w.r, panesOf(row('web', '1', '1', 'opencode-cli', '/proj', '%1')), since).get('web').pane).toBe('%1');
});

test('mailTargets leaves the reducer and the marker fold untouched', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.inbox('ses_a', 50, '/proj');
  const panes = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'));
  const fold = foldForPanes(w.r, panes, SINCE0('web'), 100);
  mailTargets(w.r, panes, SINCE0('web'));
  expect(foldForPanes(w.r, panes, SINCE0('web'), 100)).toEqual(fold);
});

test('malformed input gives an empty map and never throws', () => {
  const w = world();
  w.created('ses_a', 10, '/proj');
  w.inbox('ses_a', 50, '/proj');
  const good = panesOf(row('web', '1', '1', 'opencode', '/proj', '%1'));
  for (const reducer of [null, undefined, {}, { sessions: null }, { sessions: [] }, 'x']) {
    expect(mailTargets(reducer, good, new Map())).toEqual(new Map());
  }
  for (const panes of [null, undefined, 'x', 42, {}, [null, undefined, 3, 'a', {}, { session: 5, cmd: 'opencode' }]]) {
    expect(mailTargets(w.r, panes, new Map())).toEqual(new Map());
  }
  for (const since of [null, undefined, {}, 'x', [], 5]) {
    expect(mailTargets(w.r, good, since).get('web').sessionID).toBe('ses_a');
  }
  // A pane without a valid tmux pane id is never a target (hand-built rows bypass parsePanes).
  for (const bad of [undefined, '', '%', '7', '%7;x', 7, null]) {
    const p = [{ session: 'web', cmd: 'opencode', path: '/proj', active: true, pane: bad }];
    expect(mailTargets(w.r, p, new Map()).size).toBe(0);
  }
  // A session whose dir is missing is never a candidate.
  const r = createReducer({ now: () => 1 });
  r.apply({ id: 'n1', type: 'session.created', created: 1000, data: { sessionID: 'ses_nodir' } });
  r.apply({ id: 'n2', type: 'session.viewed', created: 2000, data: { sessionID: 'ses_nodir' } });
  expect(mailTargets(r, good, new Map()).size).toBe(0);
});
