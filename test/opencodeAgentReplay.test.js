import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReducer, parsePanes, foldForPanes, markerLine } from '../src/server/assets/tmuxifier-opencode-agent.js';

// The acceptance test: replays every line of the real OpenCode 2.2.6
// recording (test/fixtures/opencode-event-trace.jsonl) through the real
// asset's reducer and pane fold, with a fixed pane listing, and asserts the
// marker trail of each tmux session by fixture line. Lines are the 1-based
// physical lines of the fixture, matching
// test/fixtures/README-opencode-event-trace.md. A `plugin.setup` with a new
// pid is a new server process, so it starts a fresh reducer; non-event lines
// are otherwise only counted. REPLAY_TRAIL=1 prints the whole trail.

const TRACE = fileURLToPath(new URL('./fixtures/opencode-event-trace.jsonl', import.meta.url));

const PANES = parsePanes(
  'octest\t1\t1\topencode\t/home/user/proj\n' +
  'octest2\t1\t1\topencode\t/home/user/proj\n' +
  'octest3\t1\t1\topencode\t/home/user/proj2\n',
);
const SINCE = new Map([['octest', 0], ['octest2', 0], ['octest3', 0]]);
const END_RE = /^session\.execution\.(succeeded|interrupted|failed)$/;

test('the recorded OpenCode trace drives the per-pane markers through every scenario', () => {
  expect(PANES.map((p) => p.session)).toEqual(['octest', 'octest2', 'octest3']);
  const lines = readFileSync(TRACE, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();

  let reducer = null;
  let setupPid = null;
  const trail = [];
  lines.forEach((text, i) => {
    const n = i + 1;
    const rec = JSON.parse(text);
    if (rec.kind === 'plugin.setup' && rec.pid !== setupPid) {
      setupPid = rec.pid;
      reducer = createReducer({ now: () => 0 });
    }
    if (rec.kind === 'event') reducer.apply(rec.event);
    const fold = foldForPanes(reducer, PANES, SINCE, 0);
    trail.push({ n, kind: rec.kind, type: rec.event?.type ?? '', fold, created: rec.event?.created });
  });
  expect(trail).toHaveLength(427);

  const sc = (f) => `${f.state}/${f.cause}`;
  const trailOf = (name) => (n) => sc(trail[n - 1].fold.get(name));
  const at = trailOf('octest');
  const trail2 = trailOf('octest2');
  const trail3 = trailOf('octest3');
  if (process.env.REPLAY_TRAIL) {
    for (const t of trail) {
      console.log(`${t.n}\t${t.kind === 'event' ? t.type : t.kind}\t${sc(t.fold.get('octest'))}\t${sc(t.fold.get('octest2'))}\t${sc(t.fold.get('octest3'))}`);
    }
  }

  // (a) warm-up, auto-allowed. A created session that has not started yet is
  // not a finished turn.
  expect(at(15)).toBe('ready/start'); expect(at(17)).toBe('ready/start');
  expect(at(18)).toBe('working/prompt'); expect(at(46)).toBe('ready/stop');
  // (b) Allow once.
  expect(at(60)).toBe('blocked/permission'); expect(at(61)).toBe('working/unblock'); expect(at(78)).toBe('ready/stop');
  // (c) reject with Escape.
  expect(at(92)).toBe('blocked/permission'); expect(at(93)).toBe('working/unblock'); expect(at(97)).toBe('ready/stop');
  // (e) question answered, (f) question dismissed.
  expect(at(127)).toBe('blocked/question'); expect(at(129)).toBe('working/unblock'); expect(at(142)).toBe('ready/stop');
  expect(at(155)).toBe('blocked/question'); expect(at(156)).toBe('working/unblock'); expect(at(160)).toBe('ready/stop');
  // (g) plain text turn.
  expect(at(173)).toBe('ready/stop');
  // (h) Always allow.
  expect(at(187)).toBe('blocked/permission'); expect(at(188)).toBe('working/unblock'); expect(at(204)).toBe('ready/stop');
  // (i) messy background shell: the shell from 221 runs until 247.
  expect(at(219)).toBe('blocked/permission'); expect(at(242).startsWith('working')).toBe(true); // shell still running
  expect(at(248)).toBe('working/resume'); expect(at(266)).toBe('ready/stop');
  // (j) clean background shell: the turn ends at 298 while the shell runs.
  expect(at(280)).toBe('blocked/permission'); expect(at(298)).toBe('working/prompt'); // background gate
  expect(at(303)).toBe('working/resume'); expect(at(313)).toBe('ready/stop');
  // (k)/(l) a second session in proj folds into both proj panes; proj2 has none.
  expect(trail2(343)).toBe('working/prompt'); expect(at(343)).toBe('working/prompt'); expect(trail3(343)).toBe('ready/start');
  expect(at(344)).toBe(at(343)); // duplicate changes nothing
  // (q) `opencode -c` in a fresh server: no session.created, directory learned at 415.
  expect(at(416)).toBe('working/prompt'); expect(at(426)).toBe('ready/stop');

  // The two proj panes always show the same fold; proj2 never sees a session.
  for (const t of trail) {
    expect(t.fold.get('octest2'), `line ${t.n}`).toEqual(t.fold.get('octest'));
    expect(t.fold.get('octest3'), `line ${t.n}`).toEqual({ state: 'ready', cause: 'start', ts: 0 });
  }
  // Before the first session exists, and after the server restart until the
  // resumed session's first turn, the proj panes read ready/start.
  for (const n of [1, 14, 403, 414, 415]) expect(at(n), `line ${n}`).toBe('ready/start');

  // The marker ts at 46 equals the execution.succeeded created time in seconds.
  expect(trail[45].type).toBe('session.execution.succeeded');
  expect(trail[45].fold.get('octest').ts).toBe(Math.floor(trail[45].created / 1000));
  expect(markerLine('octest', trail[45].fold.get('octest'))).toBe(`octest:ready:${Math.floor(trail[45].created / 1000)}:stop\n`);

  // No execution.succeeded|interrupted|failed line ever leaves octest blocked.
  const ends = trail.filter((t) => t.kind === 'event' && END_RE.test(t.type));
  expect(ends.length).toBeGreaterThan(10);
  for (const t of ends) expect(at(t.n).startsWith('blocked'), `line ${t.n}`).toBe(false);
});
