import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { takeOver, parsePanes, foldForPanes, markerLine } from '../src/server/assets/tmuxifier-opencode-agent.js';

// The OpenCode 2.3.0 counterpart of opencodeAgentReplay.test.js: replays every
// `kind: "event"` line of the real 2.3.0 recording
// (test/fixtures/opencode-2.3-event-trace.jsonl, scenarios and facts in
// test/fixtures/README-opencode-2.3-event-trace.md) through the real asset's
// reducer and pane fold, with a fixed pane listing, and asserts the marker of
// each pane per scenario. Each plugin instance of the recorded server receives
// every event, so most events are in the trace two or three times (tags proj,
// proj2, root) under one `event.id`: the reducer's dedupe has to make the
// repeats no-ops. Assertion points are located by the recorder's own
// `kind: "scenario"` markers, never by a hard-coded line; the line numbers in
// the comments are the README's, for reading along. Every `plugin.setup` line
// runs the real hand-over (`takeOver`, what the default export's setup does):
// one in the same pid is a setup for another directory in the same server
// (lines 812, 1240), one with a new pid is a restarted server with nothing to
// take over from (line 1913). Cores are never attached or swept; other
// non-event lines are only counted. REPLAY_TRAIL=1 prints every change.

const TRACE = fileURLToPath(new URL('./fixtures/opencode-2.3-event-trace.jsonl', import.meta.url));

const PANES = parsePanes(
  'octest\t1\t1\topencode\t/home/user/proj\t%1\n' +
  'octest2\t1\t1\topencode\t/home/user/proj2\t%2\n',
);
const SINCE = new Map([['octest', 0], ['octest2', 0]]);
const END_RE = /^session\.execution\.(succeeded|interrupted|failed)$/;

const lines = readFileSync(TRACE, 'utf8').split('\n');
if (lines.at(-1) === '') lines.pop();
const recs = lines.map((text) => JSON.parse(text));
// Lines whose event id was not on an earlier line: the others are the same
// event as seen by another plugin instance.
const firstCopy = (() => {
  const ids = new Set();
  return recs.map((r) => {
    if (r.kind !== 'event') return false;
    const first = !ids.has(r.event.id);
    ids.add(r.event.id);
    return first;
  });
})();

const sc = (f) => `${f.state}/${f.cause}`;

// The scenario's physical lines: from its marker to the line before the next
// marker (1-based, inclusive).
function range(name) {
  const i = recs.findIndex((r) => r.kind === 'scenario' && r.name === name);
  if (i < 0) throw new Error(`no scenario ${name}`);
  let j = i + 1;
  while (j < recs.length && recs[j].kind !== 'scenario') j++;
  return { from: i + 1, to: j };
}

// The (1-based) line of the nth event `type` inside a scenario that satisfies
// `where`, counting each event once (its first copy).
function find(name, type, where = () => true, nth = 0) {
  const { from, to } = range(name);
  let seen = 0;
  for (let n = from; n <= to; n++) {
    const r = recs[n - 1];
    if (firstCopy[n - 1] && r.event.type === type && where(r.event)) {
      if (seen++ === nth) return n;
    }
  }
  throw new Error(`no ${type}#${nth} in scenario ${name}`);
}

const isShellDone = (e) => e.data?.item?.payload?.metadata?.source === 'shell';
const isMail = (e) => e.data?.item?.payload?.metadata?.tmuxifierMail === 'm-aaaaaaaa';
const ofSession = (suffix) => (e) => String(e.data?.sessionID).endsWith(suffix);

// The sessions of the recording: two in proj (one per TUI), one in proj2.
const S_PROJ = '5168FE6A';
const S_PROJ2 = '2YFtZRgT';
const S_PROJ_B = 'cLjAZ5Ap';

// Replays the whole recording. `echo` > 0 also re-delivers each event's
// `echo` predecessors straight after it (late duplicates of a stream, the way
// a second plugin instance's copy may arrive), which only a working dedupe
// makes harmless; echoes are never counted as lines.
function replay({ echo = 0 } = {}) {
  const opts = { home: '/nonexistent', listPanes: async () => null, now: () => 0 };
  let core = null;
  let setupPid = null;
  const setups = [];
  const ids = new Set();
  const trail = [];
  const redelivered = []; // what apply() returned for each echo
  let recent = [];
  let repeats = 0;
  recs.forEach((rec, i) => {
    const n = i + 1;
    if (rec.kind === 'plugin.setup') {
      core = takeOver(rec.pid === setupPid ? core : null, opts);
      setups.push({ n, samePid: rec.pid === setupPid });
      if (rec.pid !== setupPid) recent = []; // a new server has seen none of the earlier events
      setupPid = rec.pid;
    }
    let applied = null;
    let repeat = false;
    if (rec.kind === 'event') {
      repeat = ids.has(rec.event.id);
      ids.add(rec.event.id);
      if (repeat) repeats++;
      applied = core.reducer.apply(rec.event);
      for (const old of recent) redelivered.push(core.reducer.apply(old));
      recent = echo > 0 ? [...recent, rec.event].slice(-echo) : [];
    }
    const fold = foldForPanes(core.reducer, PANES, SINCE, 0);
    trail.push({ n, kind: rec.kind, type: rec.event?.type ?? '', fold, created: rec.event?.created, applied, repeat });
  });
  return { trail, setups, repeats, redelivered, core };
}

test('the recorded OpenCode 2.3.0 trace drives the per-pane markers through every scenario', () => {
  expect(PANES.map((p) => p.session)).toEqual(['octest', 'octest2']);
  expect(recs).toHaveLength(1983);

  const { trail, setups, repeats, redelivered } = replay();
  expect(trail).toHaveLength(1983);
  expect(redelivered, 'the plain replay re-delivers nothing of its own').toEqual([]);

  const at = (n) => sc(trail[n - 1].fold.get('octest'));
  const at2 = (n) => sc(trail[n - 1].fold.get('octest2'));
  const tsOf = (n, pane = 'octest') => trail[n - 1].fold.get(pane).ts;
  const secOf = (n) => Math.floor(trail[n - 1].created / 1000);
  if (process.env.REPLAY_TRAIL) {
    let prev = '';
    for (const t of trail) {
      const row = `${sc(t.fold.get('octest'))}\t${sc(t.fold.get('octest2'))}`;
      if (row !== prev || t.kind !== 'event') console.log(`${t.n}\t${t.kind === 'event' ? t.type : t.kind}\t${row}`);
      prev = row;
    }
  }

  // Hand-overs: 812 and 1240 are setups for another directory in the same
  // server, 1913 is the server restarted after its kill (new pid).
  expect(setups, 'plugin.setup lines and whether each kept the pid').toEqual([
    { n: 1, samePid: false },
    { n: 812, samePid: true },
    { n: 1240, samePid: true },
    { n: 1913, samePid: false },
  ]);

  // Events reach every plugin instance: 611 of the 1814 events are a repeat of
  // an earlier line's event id, and a repeat changes nothing at all.
  expect(repeats, 'lines repeating an earlier line\'s event id').toBe(611);
  for (const t of trail) {
    if (!t.repeat) continue;
    expect(t.applied, `line ${t.n}`).toBe(false);
    expect(t.fold, `line ${t.n}`).toEqual(trail[t.n - 2].fold);
  }

  // (a) plain turn (lines 15-34). A created session, and an operator prompt
  // that is only enqueued, have finished nothing yet.
  const aEnd = find('a-plain', 'session.execution.succeeded');
  expect(at(find('a-plain', 'session.created'))).toBe('ready/start');
  expect(at(find('a-plain', 'session.inbox.enqueued'))).toBe('ready/start');
  expect(at(find('a-plain', 'session.execution.started'))).toBe('working/prompt');
  expect(at(find('a-plain', 'session.inbox.delivered'))).toBe('working/prompt');
  expect(at(aEnd)).toBe('ready/stop');
  expect(at(find('a-plain', 'session.viewed'))).toBe('ready/stop'); // viewing is not a state change
  expect(tsOf(aEnd)).toBe(secOf(aEnd));
  expect(markerLine('octest', trail[aEnd - 1].fold.get('octest'))).toBe(`octest:ready:${secOf(aEnd)}:stop\n`);

  // (b1, g3) permission asked (275-276), a mail synthetic queued while the
  // prompt is open (280), allowed once (282): the prompt blocks, the queued
  // item does not unblock it, and the one turn ends once (364).
  expect(at(find('b1-permission-once', 'session.execution.started'))).toBe('working/prompt');
  expect(at(find('b1-permission-once', 'permission.asked'))).toBe('blocked/permission');
  const g3 = find('g3-synthetic-during-permission', 'session.inbox.enqueued', isMail);
  expect(at(g3)).toBe('blocked/permission');
  expect(at(find('b1-approve-once', 'permission.replied'))).toBe('working/unblock');
  // the tool's shell (283-285) and the delivery of the queued item (299) happen inside the turn
  expect(at(find('b1-approve-once', 'shell.created'))).toBe('working/unblock');
  expect(at(find('b1-approve-once', 'shell.exited'))).toBe('working/unblock');
  const queuedInbox = recs[g3 - 1].event.data.inboxID;
  const g3Delivered = find('b1-approve-once', 'session.inbox.delivered', (e) => e.data.inboxID === queuedInbox);
  expect(at(g3Delivered)).toBe('working/unblock');
  expect(at(find('b1-approve-once', 'session.execution.succeeded'))).toBe('ready/stop');

  // (b2) permission reject (385-390): the reject unblocks, the interrupt ends the turn.
  expect(at(find('b2-permission-reject', 'session.execution.started'))).toBe('working/prompt'); // not resume: g3's synthetic is long delivered
  expect(at(find('b2-permission-reject', 'permission.asked'))).toBe('blocked/permission');
  expect(at(find('b2-permission-reject', 'permission.replied'))).toBe('working/unblock');
  const b2End = find('b2-permission-reject', 'session.execution.interrupted');
  expect(at(b2End)).toBe('ready/stop');
  expect(tsOf(b2End)).toBe(secOf(b2End));

  // (c) question form (414-416, 429): `form.created` with metadata.kind "question".
  expect(at(find('c-question', 'session.execution.started'))).toBe('working/prompt');
  expect(at(find('c-question', 'form.created'))).toBe('blocked/question');
  expect(at(find('c-question', 'form.replied'))).toBe('working/unblock');
  expect(at(find('c-question', 'session.execution.succeeded'))).toBe('ready/stop');

  // (d, g2) a shell moved to the background (ctrl+b) with a mail synthetic
  // queued during it (431-530): the ask blocks (451), the queued item changes
  // nothing (456), allowing starts the shell (458-459), OpenCode's own ctrl+b
  // notice is a synthetic enqueued with no directory (462), and the turn ends
  // (507) while the shell runs: working, like the Claude hook's background gate.
  expect(at(find('d-background-shell', 'session.execution.started'))).toBe('working/prompt');
  expect(at(find('d-background-shell', 'permission.asked'))).toBe('blocked/permission');
  expect(at(find('g2-synthetic-while-bg-shell', 'session.inbox.enqueued', isMail))).toBe('blocked/permission');
  expect(at(find('d-approve', 'permission.replied'))).toBe('working/unblock');
  expect(at(find('d-approve', 'shell.created'))).toBe('working/unblock');
  expect(at(find('d-ctrl-b-sent-2', 'session.inbox.enqueued', (e) => !isShellDone(e)))).toBe('working/unblock'); // the ctrl+b notice
  const dTurnEnd = find('d-ctrl-b-sent-2', 'session.execution.succeeded', undefined, 0);
  expect(at(dTurnEnd)).toBe('working/prompt'); // the shell still runs
  expect(at(find('d-ctrl-b-sent-2', 'session.viewed', undefined, 0))).toBe('working/prompt');
  // The shell's completion comes back as a synthetic (510) that starts a new execution (511).
  // Between shell.exited (509) and that execution.started the session is momentarily
  // finished, exactly as in the 2.2.6 recording (fixture 247 -> 248); not asserted.
  const dResume = find('d-ctrl-b-sent-2', 'session.execution.started');
  expect(dResume).toBeGreaterThan(find('d-ctrl-b-sent-2', 'session.inbox.enqueued', isShellDone));
  expect(at(dResume)).toBe('working/resume');
  const dEnd = find('d-ctrl-b-sent-2', 'session.execution.succeeded', undefined, 1);
  expect(at(dEnd)).toBe('ready/stop');
  expect(tsOf(dEnd)).toBe(secOf(dEnd));

  // (g1) a mail synthetic on an idle session (534-536, 808): enqueueing it
  // changes nothing, it starts a turn that reads as a resume, and the
  // tools' shells inside the turn (742-763) do not end it.
  const g1Queued = find('g1-synthetic-idle', 'session.inbox.enqueued', isMail);
  expect(at(g1Queued)).toBe('ready/stop');
  const g1Start = find('g1-synthetic-idle', 'session.execution.started');
  expect(g1Start).toBeGreaterThan(g1Queued);
  expect(at(g1Start)).toBe('working/resume');
  expect(at(find('g1-synthetic-idle', 'session.inbox.delivered'))).toBe('working/resume');
  expect(at(find('g1-synthetic-idle', 'shell.created', undefined, 0))).toBe('working/resume');
  expect(at(find('g1-synthetic-idle', 'shell.exited', undefined, 1))).toBe('working/resume');
  const g1End = find('g1-synthetic-idle', 'session.execution.succeeded');
  expect(at(g1End)).toBe('ready/stop');
  expect(tsOf(g1End)).toBe(secOf(g1End));
  expect(at(find('g1-synthetic-idle', 'session.viewed'))).toBe('ready/stop');

  // (e) a second TUI in proj2 (810-866): the setup for proj2 in the same server
  // (812) hands everything over, so the proj pane keeps its finished turn with
  // the same marker ts, and the proj2 pane gets its own states from its session.
  const eStart = find('e-second-tui-proj2', 'session.execution.started');
  const eEnd = find('e-second-tui-proj2', 'session.execution.succeeded');
  for (let n = 1; n < eStart; n++) expect(at2(n), `line ${n}`).toBe('ready/start'); // nothing in proj2 before its turn
  expect(at2(find('e-second-tui-proj2', 'session.created', ofSession(S_PROJ2)))).toBe('ready/start');
  expect(at2(find('e-second-tui-proj2', 'session.inbox.enqueued'))).toBe('ready/start');
  expect(at2(eStart)).toBe('working/prompt');
  for (let n = g1End; n <= eEnd; n++) {
    expect(at(n), `line ${n}`).toBe('ready/stop'); // proj's marker is not touched by proj2's turn
    expect(tsOf(n), `line ${n}`).toBe(secOf(g1End));
  }
  expect(at2(eEnd)).toBe('ready/stop');
  expect(tsOf(eEnd, 'octest2')).toBe(secOf(eEnd));

  // (f) a second TUI in proj, a new session there (867-905): its creation must
  // not hide the first session's finished turn; its own turn is working, and
  // the newest finished turn of the two is the one the marker carries.
  const fCreated = find('f-second-tui-same-proj', 'session.created', ofSession(S_PROJ_B));
  expect(at(fCreated)).toBe('ready/stop');
  expect(tsOf(fCreated)).toBe(secOf(g1End));
  const fStart = find('f-second-tui-same-proj', 'session.execution.started');
  expect(at(fStart)).toBe('working/prompt');
  expect(at2(fStart)).toBe('ready/stop');
  const fEnd = find('f-second-tui-same-proj', 'session.execution.succeeded');
  expect(at(fEnd)).toBe('ready/stop');
  expect(tsOf(fEnd)).toBe(secOf(fEnd));

  // (i) two TUIs run a command at the same moment (906-1050): each pane works
  // on its own session, one session ending does not end the other's turn.
  const iStartA = find('i-concurrent-shell', 'session.execution.started', ofSession(S_PROJ));
  const iStartB = find('i-concurrent-shell', 'session.execution.started', ofSession(S_PROJ2));
  expect(at(iStartA)).toBe('working/prompt');
  expect(at2(iStartA)).toBe('ready/stop');
  expect(at(iStartB)).toBe('working/prompt');
  expect(at2(iStartB)).toBe('working/prompt');
  const iEndA = find('i-concurrent-shell', 'session.execution.succeeded', ofSession(S_PROJ));
  const iEndB = find('i-concurrent-shell', 'session.execution.succeeded', ofSession(S_PROJ2));
  expect(at(iEndA)).toBe('ready/stop');
  expect(at2(iEndA)).toBe('working/prompt'); // proj2's turn goes on
  expect(at2(iEndB)).toBe('ready/stop');
  expect(at(iEndB)).toBe('ready/stop');

  // (f5, f2) a mail synthetic through proj's context for proj2's session, and
  // for a session with no TUI (1051-1149): the enqueued item names no
  // directory, the session is known, and the turn reads as a resume. No
  // session.viewed follows the second one; it does not matter.
  const f5Queued = find('f5-synthetic-cross-dir', 'session.inbox.enqueued', isMail);
  expect(at2(f5Queued)).toBe('ready/stop');
  const f5Start = find('f5-synthetic-cross-dir', 'session.execution.started');
  expect(at2(f5Start)).toBe('working/resume');
  expect(at(f5Start)).toBe('ready/stop');
  expect(at2(find('f5-synthetic-cross-dir', 'session.execution.succeeded'))).toBe('ready/stop');
  const noTuiStart = find('f2-no-tui-synthetic', 'session.execution.started');
  expect(at2(noTuiStart)).toBe('working/resume');
  expect(at2(find('f2-no-tui-synthetic', 'session.execution.succeeded'))).toBe('ready/stop');
  expect(() => find('f2-no-tui-synthetic', 'session.viewed')).toThrow(/no session\.viewed/);

  // (j) a plain operator turn in proj after the skill probes (1151-1236).
  expect(at(find('j-skill-add', 'session.execution.started'))).toBe('working/prompt');
  expect(at(find('j-skill-add', 'session.execution.succeeded'))).toBe('ready/stop');

  // (F7) a third plugin instance (root) from 1240: every event three times. A
  // permission ask per config style: each blocks and each reply unblocks.
  for (const name of ['f7-global-bash-key', 'f7-project-dot-opencode-jsonc', 'f7-project-opencode-json']) {
    expect(at(find(name, 'session.execution.started')), name).toBe('working/prompt');
    expect(at(find(name, 'permission.asked')), name).toBe('blocked/permission');
    expect(at(find(name, 'permission.replied')), name).toBe('working/unblock');
  }
  expect(at(find('f7-global-bash-key', 'session.execution.succeeded'))).toBe('ready/stop');
  expect(at(find('f7-project-dot-opencode-jsonc', 'session.execution.succeeded'))).toBe('ready/stop');
  // The execution started in f7-project-opencode-json (1597) never ends in the
  // recording before the server is killed (no execution.succeeded between 1597
  // and 1982): the operator prompts of f7-agent-scoped (1707) and
  // k-busy-then-queue (1844) join it, and the mail synthetic queued in it
  // (1903) changes nothing. The session stays working, except while asking. Which cause the
  // marker carries while working is incidental here (the turn's last unblock), so only the state
  // is pinned.
  const working = (n, what) => expect(at(n), `${what} (line ${n})`).toMatch(/^working\//);
  const openFrom = find('f7-project-opencode-json', 'session.execution.started');
  const restartAt = setups.at(-1).n;
  for (let n = openFrom; n < restartAt; n++) {
    expect(trail[n - 1].type, `line ${n}`).not.toMatch(END_RE);
  }
  working(find('f7-agent-scoped', 'session.inbox.enqueued'), 'the f7-agent-scoped prompt joining the open turn');
  expect(at(find('f7-agent-scoped', 'permission.asked'))).toBe('blocked/permission');
  expect(at(find('f7-agent-scoped', 'permission.replied'))).toBe('working/unblock');
  working(find('k-busy-then-queue', 'session.inbox.enqueued', (e) => e.data?.item?.type === 'user'), 'the k-busy-then-queue prompt joining the open turn');
  working(find('k-busy-then-queue', 'session.inbox.enqueued', isMail), 'the mail synthetic queued in the open turn');
  working(restartAt - 1, 'the last line before the restart');

  // (k) the server is killed and restarted (1907-1983): the new server is a
  // new process with nothing to take over from, delivers the old inbox item
  // (1924) with no inbox.enqueued replay and no execution.started, then runs
  // the turn. Until the first step (1925) the reducer knows no session and
  // reads ready/start; that step names the session and its directory, so the
  // turn reads as working, and its end as finished.
  const kSetup = restartAt;
  const kDelivered = find('k-kill-server', 'session.inbox.delivered');
  expect(kDelivered).toBeGreaterThan(kSetup);
  for (let n = kSetup; n <= kDelivered; n++) {
    expect(at(n), `line ${n}`).toBe('ready/start');
    expect(at2(n), `line ${n}`).toBe('ready/start');
  }
  const kStep = find('k-kill-server', 'session.step.started');
  expect(kStep).toBe(kDelivered + 1);
  expect(at(kStep)).toBe('working/prompt');
  const kEnd = find('k-kill-server', 'session.execution.succeeded');
  expect(kEnd).toBe(recs.length - 1);
  expect(at(kEnd)).toBe('ready/stop');
  expect(tsOf(kEnd)).toBe(secOf(kEnd));
  expect(at(recs.length)).toBe('ready/stop'); // session.viewed
  for (let n = kStep; n < kEnd; n++) expect(at(n), `line ${n}`).toBe('working/prompt');

  // (F8) none of the events the reducer does not handle moves a marker:
  // delivered, viewed, renamed, instructions, usage, reasoning and the
  // step/tool/text events of a turn the core already knows. The one exception
  // is the first step after the restart (above), which names a turn the new
  // core never saw start.
  const F8_RE = /^session\.(inbox\.delivered|viewed|renamed|instructions\.updated|usage\.updated|reasoning\..+|step\..+|tool\..+|text\..+)$/;
  const moved = trail.filter((t) => t.kind === 'event' && F8_RE.test(t.type)
    && JSON.stringify([...t.fold]) !== JSON.stringify([...trail[t.n - 2].fold])).map((t) => t.n);
  expect(moved, 'lines where an F8 event moved a marker').toEqual([kStep]);
  expect(trail.filter((t) => t.kind === 'event' && F8_RE.test(t.type)).length, 'F8 event lines').toBe(1270);

  // No execution end ever leaves a pane blocked.
  const ends = trail.filter((t) => t.kind === 'event' && END_RE.test(t.type));
  expect(ends.length, 'execution end lines (every copy; 21 distinct events)').toBe(32);
  for (const t of ends) {
    expect(at(t.n).startsWith('blocked'), `line ${t.n}`).toBe(false);
    expect(at2(t.n).startsWith('blocked'), `line ${t.n}`).toBe(false);
  }
});

// A duplicate must change nothing wherever it arrives, not only when it comes
// right behind the original: re-delivering each event's three predecessors after
// it must leave every line's marker exactly as in the plain replay, and every
// re-delivery must report no change.
test('a re-delivered event of the 2.3.0 trace changes nothing', () => {
  const plain = replay();
  const withEchoes = replay({ echo: 3 });
  expect(plain.redelivered, 'the plain replay re-delivers nothing').toEqual([]);
  expect(withEchoes.redelivered.length, 'echoes re-delivered').toBeGreaterThan(4000);
  const changed = withEchoes.redelivered.flatMap((applied, i) => (applied === false ? [] : [i]));
  expect(changed, 'indexes of echoes that reported a change').toEqual([]);
  for (const t of withEchoes.trail) {
    expect(t.fold, `line ${t.n} with echoes vs the plain replay`).toEqual(plain.trail[t.n - 1].fold);
  }
});
