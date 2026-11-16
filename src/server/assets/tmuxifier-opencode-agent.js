// Tmuxifier's OpenCode agent-state reporter: an OpenCode V2 plugin that turns
// OpenCode's own event stream into the `~/.tmuxifier-agent/<session>` markers
// the Claude Code hook (tmuxifier-agent-hook.sh) writes, so an OpenCode pane
// shows the same working / blocked / done / idle states.
//
// It runs INSIDE OpenCode's shared server, not in a TUI, and under OpenCode's
// embedded Bun on the box as well as under Node in vitest: plain ESM, node
// builtins only, no imports from the repo, nothing at module load, and nothing
// may ever throw out of an event handler into the agent.
//
// Every rule below rests on the real OpenCode 2.2.6 recording
// (test/fixtures/opencode-event-trace.jsonl + README-opencode-event-trace.md;
// design: docs/superpowers/specs/2026-11-07-opencode-agent-state-design.md §3):
//
// 1. One `opencode serve --service` process per user serves every TUI, in any
//    tmux session, and outlives the last TUI. process.env.TMUX is the first
//    TUI's forever, and a TUI exit produces no event at all.
// 2. That process sets the plugin up once per project directory, and every
//    instance's subscription sees every event of the process: events arrive
//    doubled with the same `event.id`, hence the `seenIds` dedupe.
// 3. The plugin directory is watched; a rewritten plugin file is reloaded by
//    the running server (the singleton hand-over lives in the entry point).
// 4. The turn boundary is `session.execution.started` ->
//    `session.execution.succeeded | interrupted` (`session.status`/`idle`
//    never fire). Operator prompts arrive as `session.inbox.enqueued` with
//    `item.type: "user"`; a finished background job re-enters as
//    `item.type: "synthetic"` (a resume, not a prompt).
// 5. A block is `permission.asked` (cleared by `permission.replied`: once,
//    always or reject) or `form.created` (cleared by `form.replied` /
//    `form.cancelled`). A reject is followed within the millisecond by
//    `session.execution.interrupted`: nothing survives a turn end in 2.2.6.
// 6. A shell moved to the background (ctrl+b) is bracketed exactly by
//    `shell.created` (`info.id`, `info.metadata.sessionID`) and `shell.exited`
//    (`id`); the turn ends with `execution.succeeded` while it still runs.
// 7. `event.location.directory` rides on `session.created`, `inbox.enqueued`
//    (except the synthetic ctrl+b notices), `permission.*`, `form.*`,
//    `shell.*`; never on `session.execution.*`. A resumed session
//    (`opencode -c`) has no `session.created`, but its first `inbox.enqueued`
//    names the directory before `execution.started`. An inbox item for a
//    session the reducer does not know yet creates no session; it leaves a
//    hint (directory + inbox kind, at most 500, oldest dropped first) that
//    seeds the session when it is created.
//
// 8. Operator evidence (agent messaging, spec §6.3): which OpenCode session
//    a human is working in is `session.viewed` (OpenCode 2.3.0: it fires after
//    a turn ends only while a TUI shows the session, has no `location`, and
//    opening or continuing a session emits nothing) or a `user` inbox item (an
//    operator prompt; `synthetic` items are OpenCode's own notices and our mail
//    wakes, never evidence). It is recorded as `evidenceAt` on the session
//    (epoch seconds), carried through the hint for a session not yet known, and
//    never moves a state, a marker or a `ts`.
//
// 9. A Tmuxifier mail wake (agent messaging, spec §6.5) is an OpenCode
//    `synthetic` inbox item we post, with our message id in
//    `payload.metadata.tmuxifierMail`. Its `inbox.enqueued` carries no
//    `location` (2.3.0 recording, README F1), so it is recognised there, on the
//    session the reducer already knows, by that metadata matching
//    MAIL_MSG_ID_RE and never by its text. It reads like Claude Code's mail
//    wake: it touches no shell and no block (OpenCode brackets its shells with
//    `shell.created`/`shell.exited`, so there is no token to clear), `blocked`
//    outranks `working` in deriveState so it never turns a block into work, and
//    the turn it starts is `working/resume` (a synthetic item is a resume).
//
// 10. The mail socket (agent messaging, spec §6.5): the box's listener, a
//    plain HTTP server on the unix socket `~/.tmuxifier-mail/sock`. The plugin
//    talks to it through `createMailSocketClient` (below): a held
//    `GET /v1/wait?session=&pane=%N` that answers 200 with the wake text or 204
//    idle, and `POST /v1/ack` (form body `session`, `m`). Every outcome is a
//    resolved value, never a throw or a rejection (see the client's comment).
//
// 11. Which pane an agent's `tmx` speaks for (agent messaging, spec §6.9). The
//    agent's shell commands run from the one shared server, whose TMUX_PANE is
//    the first TUI's forever, so `createPaneTagger` (below) sets
//    TMUXIFIER_MAIL_PANE on each shell command to the pane of the calling
//    session's mail target, or `none`, and `tmx` prefers it. In 2.3.0
//    `tool.execute.before` names the session, the call and `input.command`;
//    `shell.create.before` follows in the same millisecond with `command` and a
//    mutable `env` and nothing else (README F4): the two are matched by command
//    text. Both fire only in the instance whose directory owns the session.
//
// A setup for another directory in the same process (fact 2, fixture line
// 316) or a hot reload (fact 3) hands the reducer's state over to the next
// core (`STATE_VERSION` guards the shape; an incompatible one starts fresh).
// A core that does start fresh mid-turn still learns the turn from its next
// step/tool/text event, which names the session and its directory (the
// `execution.*` events name no directory): such an event on a session that is
// not executing marks it executing with cause `prompt`, so the turn's end reads
// ready/stop. Replies and inbox items for unknown sessions create nothing, so
// no phantom finished session is minted.
//
// Clock: an event's own `created` (ms) when it is a finite number, else the injected
// `now()`; every `ts` here is epoch SECONDS, the sh hook's unit.

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// The pure reducer: OpenCode events -> per-OpenCode-session derived state.
// ---------------------------------------------------------------------------

const SEEN_MAX = 5000;
const HINT_MAX = 500;

// The shape of the state a reducer hands over (`reducer.state`: sessions,
// hints, seenIds and the session objects in them). Bump it whenever that shape
// changes: a core loaded from newer bytes then starts fresh instead of reading
// an older core's state it does not understand.
export const STATE_VERSION = 3;

// A Tmuxifier message id as agentMailStore.js mints it (`MSG_ID_RE` there):
// `m-` and 8 characters of an alphabet without i, l, o, 0, 1. Spelled out here
// because the asset imports nothing from the repo; a test pins the two equal.
export const MAIL_MSG_ID_RE = /^m-[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

// Is this inbox item one of our mail wakes? A `synthetic` item (never an
// operator's `user` prompt) whose metadata names one of our message ids.
function isMailWake(item) {
  const id = item?.type === 'synthetic' ? item.payload?.metadata?.tmuxifierMail : null;
  return typeof id === 'string' && MAIL_MSG_ID_RE.test(id);
}

// Turn activity: these `session.*` events only happen inside a turn, carry
// `location.directory` and `data.sessionID`, and never follow the turn's end
// in the 2.2.6 trace (unlike `session.renamed`, `session.viewed`). For a
// session not executing they mean the core missed `execution.started`.
const TURN_ACTIVITY_RE = /^session\.(step|tool|text)\./;

// Events that only ever act on a session the reducer already knows: a reply
// to a request it never saw, or an inbox item for a session it never saw (a
// plugin hot-reloaded mid-turn), must not mint a session of its own.
const NEVER_CREATES = new Set([
  'permission.replied',
  'form.replied',
  'form.cancelled',
  'session.inbox.enqueued',
]);

const RELEVANT = new Set([
  'session.created',
  'session.deleted',
  'session.inbox.enqueued',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.interrupted',
  'session.execution.failed',
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'form.cancelled',
  'shell.created',
  'shell.exited',
]);

const str = (v) => (typeof v === 'string' && v ? v : null);

// The OpenCode session an event is about. Most carry `data.sessionID`;
// `form.created` names it inside the form and `shell.created` inside the
// shell's metadata. `shell.exited` names only the shell (found by holder).
function sessionIdOf(event) {
  const data = event.data;
  if (!data || typeof data !== 'object') return null;
  if (event.type === 'form.created') return str(data.form?.sessionID);
  if (event.type === 'shell.created') return str(data.info?.metadata?.sessionID);
  return str(data.sessionID);
}

function newSession(id) {
  return {
    id,
    dir: null,
    parent: null,
    executing: false,
    started: false,
    cause: 'prompt',
    blocks: new Map(),
    shells: new Set(),
    lastInbox: null,
    // The newest user/synthetic inbox item was one of our mail wakes (fact 9);
    // implies lastInbox === 'synthetic', so the turn it starts is a resume.
    mailWake: false,
    // Epoch seconds of the newest operator evidence (session.viewed or a user
    // inbox item); 0 = none seen by this core.
    evidenceAt: 0,
    ts: 0,
  };
}

// Derived state of one session (spec §4.1): blocked if it or any child is
// blocked; else working if it is executing, holds a running shell, or has a
// working child; else ready/stop, or ready/start for a session that has never
// seen `session.execution.started` (between `session.created` and its first
// turn it has finished nothing, so it must not read as a finished turn).
// Children are sessions whose `parent` is this one; `visiting` keeps a
// malformed parent cycle from recursing forever.
export function deriveState(session, reducer, visiting = new Set()) {
  visiting.add(session.id);
  const children = [];
  for (const s of reducer.sessions.values()) {
    if (s.parent === session.id && !visiting.has(s.id)) children.push(s);
  }
  const childStates = children.map((c) => deriveState(c, reducer, visiting));

  if (session.blocks.size > 0) {
    return { state: 'blocked', cause: session.blocks.values().next().value };
  }
  const blockedChild = childStates.find((d) => d.state === 'blocked');
  if (blockedChild) return { state: 'blocked', cause: blockedChild.cause };
  if (session.executing || session.shells.size > 0) {
    return { state: 'working', cause: session.cause };
  }
  const workingChild = childStates.find((d) => d.state === 'working');
  if (workingChild) return { state: 'working', cause: workingChild.cause };
  return { state: 'ready', cause: session.started ? 'stop' : 'start' };
}

// The state a previous core's reducer handed over, if it is this version's.
function adoptable(state) {
  try {
    return !!state && typeof state === 'object' && state.version === STATE_VERSION
      && state.sessions instanceof Map && state.hints instanceof Map && state.seenIds instanceof Set;
  } catch {
    return false;
  }
}

// `state`: a previous reducer's `reducer.state`, adopted as-is when its
// version matches (the previous core is aborted and never applies again).
export function createReducer({ now = () => Math.floor(Date.now() / 1000), state = null } = {}) {
  const adopt = adoptable(state);
  const sessions = adopt ? state.sessions : new Map();
  const seenIds = adopt ? state.seenIds : new Set();
  // sessionID -> { dir, lastInbox, mailWake, evidenceAt } from inbox items of sessions
  // not (yet) known: a resumed session (`opencode -c`) has no session.created,
  // and its execution.started carries no directory, so its first inbox item is
  // the only place its directory is named (fact 7), and a user item there is
  // the operator evidence the session starts with (fact 8).
  const hints = adopt ? state.hints : new Map();
  const reducer = {
    sessions,
    seenIds,
    state: { version: STATE_VERSION, sessions, hints, seenIds },
    apply,
    derive,
  };

  function derive(sessionID) {
    const s = sessions.get(sessionID);
    if (!s) return null;
    const d = deriveState(s, reducer);
    return { state: d.state, cause: d.cause, ts: s.ts };
  }

  // The session plus its ancestors: everyone whose derived state an event on
  // `id` can change.
  function chainOf(id) {
    const chain = [];
    const seen = new Set();
    let cur = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = sessions.get(cur)?.parent ?? null;
    }
    return chain;
  }

  function snapshot(ids) {
    const out = new Map();
    for (const id of ids) {
      const s = sessions.get(id);
      out.set(id, s ? deriveState(s, reducer) : null);
    }
    return out;
  }

  function remember(id) {
    seenIds.add(id);
    if (seenIds.size > SEEN_MAX) seenIds.delete(seenIds.values().next().value);
  }

  function hint(sid, dir, item, at = 0) {
    const prev = hints.get(sid);
    hints.delete(sid);
    const kind = item?.type;
    const known = kind === 'user' || kind === 'synthetic';
    const prevAt = Number.isFinite(prev?.evidenceAt) ? prev.evidenceAt : 0;
    hints.set(sid, {
      dir: prev?.dir ?? dir,
      lastInbox: known ? kind : prev?.lastInbox ?? null,
      mailWake: known ? isMailWake(item) : prev?.mailWake === true,
      evidenceAt: kind === 'user' && Number.isFinite(at) ? Math.max(prevAt, at) : prevAt,
    });
    if (hints.size > HINT_MAX) hints.delete(hints.keys().next().value);
  }

  function findHolder(field, key) {
    for (const s of sessions.values()) if (s[field].has(key)) return s;
    return null;
  }

  function apply(event) {
    try {
      return applyUnsafe(event);
    } catch {
      return false;
    }
  }

  function applyUnsafe(event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return false;
    const eventId = str(event.id);
    if (eventId) {
      if (seenIds.has(eventId)) return false;
      remember(eventId);
    }
    const type = event.type;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const dir = str(event.location?.directory);
    let sid = sessionIdOf(event);
    const ts = Number.isFinite(event.created) ? Math.floor(event.created / 1000) : now();

    // Operator evidence only: no state, no ts, no marker, and a session nobody
    // told the reducer about is not created for it (fact 8).
    if (type === 'session.viewed') {
      const viewed = sid ? sessions.get(sid) : null;
      if (viewed) viewed.evidenceAt = Math.max(viewed.evidenceAt, ts);
      return false;
    }

    const midTurn = TURN_ACTIVITY_RE.test(type) && !!sid && !!dir && !sessions.get(sid)?.executing;
    if (!RELEVANT.has(type) && !midTurn) {
      // Not state, but still a directory hint for a session we know.
      const s = sid ? sessions.get(sid) : null;
      if (s && !s.dir && dir) s.dir = dir;
      return false;
    }
    if (type === 'form.created' && sid === 'global') return false; // MCP elicitation: no owner

    // A reply or a shell exit acts on whichever session holds the request or
    // the shell (`shell.exited` names no session at all).
    const key = type === 'permission.replied' ? str(data.requestID)
      : type === 'form.replied' || type === 'form.cancelled' || type === 'shell.exited' ? str(data.id)
        : null;
    if (type === 'shell.exited') {
      const holder = key ? findHolder('shells', key) : null;
      if (!holder) return false;
      sid = holder.id;
    } else if (key && !sessions.get(sid)?.blocks.has(key)) {
      const holder = findHolder('blocks', key);
      if (holder) sid = holder.id;
    }
    if (!sid) return false;
    if (type === 'session.deleted') hints.delete(sid);
    if (type === 'session.deleted' && !sessions.has(sid)) return false;
    if (NEVER_CREATES.has(type) && !sessions.has(sid)) {
      if (type === 'session.inbox.enqueued') hint(sid, dir, data.item, ts);
      return false;
    }

    const affected = chainOf(sid);
    // A session.created that names a parent links this session under it: the
    // parent's chain must be compared too, or an already-running child would
    // change its parent's state without moving the parent's ts.
    const parentID = type === 'session.created' ? str(data.parentID) : null;
    if (parentID && !sessions.get(sid)?.parent) {
      for (const id of chainOf(parentID)) if (!affected.includes(id)) affected.push(id);
    }
    const before = snapshot(affected);

    let s = sessions.get(sid);
    if (!s) {
      s = newSession(sid);
      sessions.set(sid, s);
      const h = hints.get(sid);
      if (h) {
        hints.delete(sid);
        s.dir = h.dir;
        s.lastInbox = h.lastInbox;
        s.mailWake = h.mailWake === true;
        s.evidenceAt = Number.isFinite(h.evidenceAt) ? h.evidenceAt : 0;
      }
    }
    if (!s.dir && dir) s.dir = dir;

    switch (type) {
      case 'session.created':
        if (!s.parent && parentID) s.parent = parentID;
        break;
      case 'session.deleted':
        sessions.delete(sid);
        break;
      case 'session.inbox.enqueued': {
        const kind = data.item?.type;
        if (kind === 'user' || kind === 'synthetic') {
          s.lastInbox = kind;
          s.mailWake = isMailWake(data.item);
        }
        // Only an operator's prompt is evidence: a mail wake, like OpenCode's
        // own notices, is a synthetic item, and nothing else here (shells,
        // blocks, state) reacts to it.
        if (kind === 'user') s.evidenceAt = Math.max(s.evidenceAt, ts);
        break;
      }
      case 'session.execution.started':
        s.executing = true;
        s.started = true;
        // A synthetic item (a finished background job, our mail wake) resumes
        // the session; deriveState lets a block win over it (fact 9).
        s.cause = s.lastInbox === 'synthetic' ? 'resume' : 'prompt';
        break;
      default:
        // Turn activity on a session not executing (midTurn): the turn's
        // execution.started happened before this core existed.
        if (midTurn) {
          s.executing = true;
          s.started = true;
          s.cause = 'prompt';
        }
        break;
      case 'permission.asked': {
        const id = str(data.id);
        if (id) s.blocks.set(id, 'permission');
        break;
      }
      case 'form.created': {
        const id = str(data.form?.id);
        if (id) s.blocks.set(id, data.form?.metadata?.kind === 'question' ? 'question' : 'elicitation');
        break;
      }
      case 'permission.replied':
      case 'form.replied':
      case 'form.cancelled':
        if (key && s.blocks.delete(key) && s.executing) s.cause = 'unblock';
        break;
      case 'shell.created': {
        const id = str(data.info?.id);
        if (id) s.shells.add(id);
        break;
      }
      case 'shell.exited':
        s.shells.delete(key);
        break;
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
      case 'session.execution.failed':
        s.executing = false;
        s.blocks.clear();
        // Like the Claude hook's Stop while background work runs: a turn that
        // ends with a shell still running reads working/prompt, not unblock.
        s.cause = 'prompt';
        break;
    }

    let changed = false;
    for (const id of affected) {
      const cur = sessions.get(id);
      const prev = before.get(id);
      if (!cur) {
        if (prev) changed = true;
        continue;
      }
      const next = deriveState(cur, reducer);
      if (!prev || prev.state !== next.state || prev.cause !== next.cause) {
        cur.ts = ts;
        changed = true;
      }
    }
    return changed;
  }

  return reducer;
}

// ---------------------------------------------------------------------------
// Pane attribution: which tmux session shows which OpenCode session's state.
// ---------------------------------------------------------------------------
//
// One server serves every TUI (fact 1) and no event names a tmux session, so a
// session is attributed by directory: its `dir` against the pane path of each
// tmux session's active pane of its active window, the pane the probe's
// STATUS_FMT reports (a tmux session whose current window runs Claude is never
// touched here). Two TUIs in one directory in two tmux sessions therefore show
// the same folded state, a documented limitation (spec §4.1).
//
// Two notions per tmux session, kept apart on purpose:
// - it HOSTS opencode while any pane in any window runs it; `since` (below)
//   follows hosting, so switching to another window and back neither resets
//   it nor hides a block raised meanwhile;
// - it READS opencode while its active pane of the active window runs it;
//   only then is a marker written, and a marker it no longer reads is deleted.

// The `tmux list-panes -a -F` argument parsePanes reads.
export const PANE_FORMAT = '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_id}';

const PANES_MAX = 500;
const NAME_MAX = 256;
const PATH_MAX = 4096;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
// A tmux pane id, `%` and the pane's number: what `-t` and the mail wait name.
const PANE_ID_RE = /^%\d{1,9}$/;

// tmux output is box output: untrusted. Rows with the wrong field count, any
// C0 control or DEL, an empty or over-long name or path, or a pane id that is
// not `%<digits>` are dropped, never repaired. Every surviving row is kept,
// `active` marking the active pane of the active window (hosting needs the
// others).
export function parsePanes(text) {
  return parsePanesChecked(text).panes;
}

// parsePanes plus whether the listing was read whole: `complete` is false when
// any non-empty line was dropped or the row cap cut the listing short (and for
// input that is not a string). The marker fold works with what survives; mail
// targets need the whole listing (anti-goal 1: a hidden row could be the other
// TUI that makes a target ambiguous), so the sweep gives mail none otherwise.
export function parsePanesChecked(text) {
  if (typeof text !== 'string') return { panes: [], complete: false };
  const out = [];
  let complete = true;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (out.length >= PANES_MAX) { complete = false; break; }
    const f = line.split('\t');
    const row = f.length === 6 ? paneRow(f) : null;
    if (row) out.push(row);
    else complete = false;
  }
  return { panes: out, complete };
}

function paneRow([session, windowActive, paneActive, cmd, path, pane]) {
  if (!session || session.length > NAME_MAX || CONTROL_RE.test(session)) return null;
  if (cmd.length > NAME_MAX || CONTROL_RE.test(cmd)) return null;
  if (!path || path.length > PATH_MAX || CONTROL_RE.test(path)) return null;
  if (!PANE_ID_RE.test(pane)) return null;
  return { session, cmd, path, active: windowActive === '1' && paneActive === '1', pane };
}

// The TUI's #{pane_current_command}; the server's agentKindOf uses the same rule.
export function isOpencodeCmd(cmd) {
  return typeof cmd === 'string' && /^opencode(-|$)/.test(cmd);
}

const trimSlash = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

const bothPaths = (dir, panePath) =>
  typeof dir === 'string' && typeof panePath === 'string' && !!dir && !!panePath;

// The directory OpenCode reports is the pane's own path.
export function dirExact(dir, panePath) {
  return bothPaths(dir, panePath) && trimSlash(dir) === trimSlash(panePath);
}

// The pane is deeper than the directory OpenCode reports (a TUI started in a
// subdirectory of the project it reports). Never the reverse: a pane in a
// parent directory (a TUI in `~`) must not absorb every project below it.
// `/` matches only itself (dirExact), never everything below it.
export function dirUnder(dir, panePath) {
  if (!bothPaths(dir, panePath)) return false;
  const d = trimSlash(dir);
  return d !== '/' && trimSlash(panePath).startsWith(d + '/');
}

// blocked > working > ready/stop > ready/start: a fresh session that has not
// started yet must never hide a finished, possibly unseen turn in the same
// directory (fixture lines 336-342).
const rankOf = (d) => (d.state === 'blocked' ? 4 : d.state === 'working' ? 3
  : d.state === 'ready' ? (d.cause === 'start' ? 1 : 2) : 0);

// tmux session -> { state, cause, ts } for every active opencode pane (a tmux
// session that reads opencode). Candidates are root sessions (children roll
// up into their parent) whose directory is the pane's path (dirExact) or,
// only when no root session has that directory at all, one above it
// (dirUnder); the tier is chosen before the `since` filter, so a pane whose
// own directory has only stale sessions reads ready/start instead of a parent
// project's state. Within the tier, candidates are those whose ts is not
// older than `since` (the moment this tmux session started hosting opencode, seconds),
// which keeps a previous TUI's finished turns from making a relaunch read
// done. blocked > working > ready/stop > ready/start, ties to the newest ts
// within a rank; the written ts is the chosen session's own, not the fold
// time. No candidate: ready/start at `since` (else `now`, seconds).
export function foldForPanes(reducer, panes, since = new Map(), now = Math.floor(Date.now() / 1000)) {
  if (!(since instanceof Map)) since = new Map();
  const roots = [];
  for (const s of reducer.sessions.values()) {
    if (s.parent !== null || !s.dir) continue;
    const d = reducer.derive(s.id);
    if (d && rankOf(d)) roots.push({ dir: s.dir, d, rank: rankOf(d) });
  }
  const out = new Map();
  for (const pane of panes) {
    if (!pane.active || !isOpencodeCmd(pane.cmd)) continue;
    const floor = since.get(pane.session);
    const exact = roots.some((c) => dirExact(c.dir, pane.path));
    const inTier = exact ? dirExact : dirUnder;
    let best = null;
    for (const c of roots) {
      if (c.d.ts < (floor ?? 0) || !inTier(c.dir, pane.path)) continue;
      if (!best || c.rank > best.rank || (c.rank === best.rank && c.d.ts > best.d.ts)) best = c;
    }
    out.set(pane.session, best
      ? { state: best.d.state, cause: best.d.cause, ts: best.d.ts }
      : { state: 'ready', cause: 'start', ts: floor ?? now });
  }
  return out;
}

// Which tmux pane may receive mail for which OpenCode session (spec §6.3,
// rules 1-3; rule 4, that the target reads `ready`, is checked by the waiter
// each time it would hold a request). tmux session -> { pane, sessionID, dir }
// for every tmux session that has exactly one target; one with none, or with
// an ambiguous one, is absent.
//
// - Rule 1: only the active pane of the active window, running opencode.
// - Rule 2: the target is the root session with the newest operator evidence
//   (`evidenceAt`, fact 8) in the pane's directory tier (the same tier as
//   foldForPanes: exact, else one above) not older than `since`, the moment
//   this tmux session started hosting opencode. A session that merely persists
//   in the directory never counts, and neither does a child (it rolls up into
//   its parent). Two sessions tied on the newest second are ambiguous: nothing
//   says which one the operator meant.
// - Rule 3: any OTHER tmux session hosting opencode in any window or pane
//   (hosting, not reading) whose own directory tier reaches the target makes
//   it ambiguous, whoever has evidence: nothing in OpenCode names the TUI that
//   viewed or prompted a session, so neither of two TUIs listens. Panes of the
//   same tmux session never conflict with each other.
//
// Pure, and never throws: input it cannot read yields an empty map.
export function mailTargets(reducer, panes, since = new Map()) {
  const out = new Map();
  try {
    if (!(reducer?.sessions instanceof Map) || !Array.isArray(panes)) return out;
    if (!(since instanceof Map)) since = new Map();
    const roots = [];
    for (const s of reducer.sessions.values()) {
      if (s && s.parent === null && s.dir) roots.push(s);
    }
    const tiers = new Map(); // pane path -> root sessions in its directory tier
    const tierOf = (panePath) => {
      let t = tiers.get(panePath);
      if (!t) {
        t = roots.filter((r) => dirExact(r.dir, panePath));
        if (t.length === 0) t = roots.filter((r) => dirUnder(r.dir, panePath));
        tiers.set(panePath, t);
      }
      return t;
    };
    const hosting = panes.filter((p) => p && typeof p === 'object' && typeof p.session === 'string'
      && typeof p.path === 'string' && isOpencodeCmd(p.cmd));
    for (const pane of hosting) {
      if (pane.active !== true || typeof pane.pane !== 'string' || !PANE_ID_RE.test(pane.pane)) continue;
      const floor = Number.isFinite(since.get(pane.session)) ? since.get(pane.session) : 0;
      let best = null;
      let tied = false;
      for (const c of tierOf(pane.path)) {
        if (!(c.evidenceAt > 0) || c.evidenceAt < floor) continue;
        if (!best || c.evidenceAt > best.evidenceAt) {
          best = c;
          tied = false;
        } else if (c.evidenceAt === best.evidenceAt) {
          tied = true;
        }
      }
      if (!best || tied) continue;
      if (hosting.some((o) => o.session !== pane.session && tierOf(o.path).includes(best))) continue;
      out.set(pane.session, { pane: pane.pane, sessionID: best.id, dir: best.dir });
    }
  } catch (e) {
    debug('mailTargets', e);
    return new Map();
  }
  return out;
}

// The marker the sh hook writes: `<tmux-session>:<state>:<epoch>:<cause>`.
export function markerLine(tmuxSession, fold) {
  return `${tmuxSession}:${fold.state}:${fold.ts}:${fold.cause}\n`;
}

// ---------------------------------------------------------------------------
// The writer: sweep, marker files, the process-wide singleton, the entry point.
// ---------------------------------------------------------------------------
//
// Nothing here may throw into OpenCode: every tmux call, every fs call and the
// parse -> fold -> markerLine pipeline is wrapped; the plugin speaks only
// through one console.error when TMUXIFIER_OPENCODE_DEBUG is set.

const SWEEP_MS = 15000;
const PANE_CACHE_MS = 1000;
const LIST_TIMEOUT_MS = 2000;

function debug(...args) {
  try {
    if (typeof process !== 'undefined' && process.env?.TMUXIFIER_OPENCODE_DEBUG) {
      console.error('[tmuxifier-opencode-agent]', ...args);
    }
  } catch { /* never surface */ }
}

// The marker file name, byte for byte the sh hook's `tr -c 'A-Za-z0-9._-' '_'`
// (tr works on bytes, so every byte of a non-ASCII character becomes one `_`;
// the latin1 view maps each UTF-8 byte to one char). Both writers must name a
// session's file identically. The content keeps the exact tmux session name.
export function safeName(session) {
  return Buffer.from(session, 'utf8').toString('latin1').replace(/[^A-Za-z0-9._-]/g, '_');
}

// What a listPanes resolves when there is no tmux to run at all (ENOENT):
// the core stops sweeping for good (spec §4.1 "Inert conditions").
export const TMUX_MISSING = Symbol.for('tmuxifier.opencode-agent.tmux-missing');

// `tmux list-panes -a` for every pane of every session. TMUX_MISSING on
// ENOENT (no tmux on PATH); null on a timeout, a non-zero exit or non-string
// output (worth retrying next sweep); never rejects. `file`/`timeout` exist
// for tests.
export function defaultListPanes({ file = 'tmux', timeout = LIST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, ['list-panes', '-a', '-F', PANE_FORMAT],
        { timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20, encoding: 'utf8', windowsHide: true },
        (err, stdout) => {
          if (err && err.code === 'ENOENT') resolve(TMUX_MISSING);
          else resolve(!err && typeof stdout === 'string' ? stdout : null);
        });
    } catch (e) {
      resolve(e && e.code === 'ENOENT' ? TMUX_MISSING : null);
    }
  });
}

// ---------------------------------------------------------------------------
// The mail socket client (agent messaging, spec §6.5).
// ---------------------------------------------------------------------------

// `sun_path` is 108 bytes on Linux, NUL included. A copy of
// agentMailListener.js's `MAX_SOCKET_PATH_BYTES` (the asset imports nothing
// from the repo); a test pins the two equal.
export const MAX_SOCKET_PATH_BYTES = 107;

// The most a response may carry: the listener's own request limit
// (`MAX_REQUEST_BYTES`, pinned equal by a test). A wake is at most a few
// thousand characters; anything larger is not ours.
export const MAIL_BODY_CAP = 262144;

// How long a `wait` may hold before the client gives up on the listener: the
// hub's hold for a waiter (`holdMs` in agentMailHub.js, five minutes, pinned
// by a test) plus a margin. The hub answers idle at its hold, so this fires
// only for a listener that is alive but no longer answers.
export const MAIL_WAIT_TIMEOUT_MS = 300000 + 30000;

// An ack is a lookup and a write on the hub; it answers at once.
export const MAIL_ACK_TIMEOUT_MS = 10000;

// A wake's first line: `[tmuxifier-mail m-XXXXXXXX] ...` (agentMailText.js
// `wakeText`). The id is checked with MAIL_MSG_ID_RE, never taken on trust.
const WAKE_TAG_RE = /^\[tmuxifier-mail ([^\]\s]+)\]/;

// A client for the box's mail listener over its unix socket, with `request`
// (http.request, replaceable for a test) as the only way out.
//
//   wait({ session, pane, signal }) -> { kind: 'mail', text, messageId }
//                                    | { kind: 'idle' }
//                                    | { kind: 'down', reason }
//   ack({ session, messageId })     -> boolean (true only for a 200)
//
// Never throws and never rejects: every failure is a resolved value
// (`down`/`false`), because its caller is a loop inside someone else's
// process and a stray rejection there is an unhandled one. `reason` is a
// short word for a debug line: path (a socket path the kernel cannot bind),
// args, aborted, connect (no listener, a refusal, a cut connection),
// status <n>, parse (a 200 that is not a wake), size, timeout.
//
// Each call is its own connection, closed after its answer (`agent: false`,
// so nothing is pooled across a listener restart). An aborted `signal`
// destroys the request, which the listener sees as a closed connection and
// ends the held wait. The wire format is the listener's header: GET
// parameters only in the query, POST parameters only in an urlencoded body.
export function createMailSocketClient({
  sockPath,
  request = http.request,
  waitTimeoutMs = MAIL_WAIT_TIMEOUT_MS,
  ackTimeoutMs = MAIL_ACK_TIMEOUT_MS,
} = {}) {
  const pathOk = typeof sockPath === 'string' && sockPath !== '' && Buffer.byteLength(sockPath) <= MAX_SOCKET_PATH_BYTES;
  const down = (reason) => ({ kind: 'down', reason });

  // One request settled exactly once. `onResponse(res, finish)` reads the answer and calls
  // `finish(value)`; `failure(reason)` is the value of a call that got no answer. Whatever
  // settles it also destroys the request: a held wait must end its connection, and one that
  // already has its answer has nothing left to read.
  function call({ method, urlPath, body, signal, timeoutMs, onResponse, failure }) {
    return new Promise((resolve) => {
      let req = null;
      let timer = null;
      let settled = false;
      const onAbort = () => finish(failure('aborted'));
      function finish(value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { signal.removeEventListener('abort', onAbort); } catch { /* no signal, or not an AbortSignal */ }
        try { if (req) req.destroy(); } catch { /* already gone */ }
        resolve(value);
      }
      try {
        if (signal && typeof signal.addEventListener === 'function') {
          if (signal.aborted) { finish(failure('aborted')); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        const headers = { Accept: 'text/plain' };
        if (body !== undefined) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          headers['Content-Length'] = Buffer.byteLength(body);
        }
        req = request({ socketPath: sockPath, path: urlPath, method, headers, agent: false }, (res) => {
          try { onResponse(res, finish); } catch { finish(failure('connect')); }
        });
        req.on('error', () => finish(failure('connect')));
        timer = setTimeout(() => finish(failure('timeout')), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        if (body !== undefined) req.write(body);
        req.end();
      } catch {
        finish(failure('connect'));
      }
    });
  }

  function wait({ session, pane, signal } = {}) {
    if (!pathOk) return Promise.resolve(down('path'));
    if (typeof session !== 'string' || typeof pane !== 'string') return Promise.resolve(down('args'));
    return call({
      method: 'GET',
      urlPath: `/v1/wait?${new URLSearchParams({ session, pane })}`,
      signal,
      timeoutMs: waitTimeoutMs,
      failure: down,
      onResponse(res, finish) {
        if (res.statusCode === 204) { finish({ kind: 'idle' }); return; }
        if (res.statusCode !== 200) { finish(down(`status ${res.statusCode}`)); return; }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAIL_BODY_CAP) { chunks.length = 0; finish(down('size')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
          const tag = WAKE_TAG_RE.exec(text.split('\n', 1)[0]);
          if (tag && MAIL_MSG_ID_RE.test(tag[1])) finish({ kind: 'mail', text, messageId: tag[1] });
          else finish(down('parse'));
        });
        // An answer cut short; a no-op once `end` has settled the call.
        res.on('error', () => finish(down('connect')));
        res.on('close', () => finish(down('connect')));
      },
    });
  }

  function ack({ session, messageId } = {}) {
    if (!pathOk || typeof session !== 'string' || !(typeof messageId === 'string' && MAIL_MSG_ID_RE.test(messageId))) return Promise.resolve(false);
    return call({
      method: 'POST',
      urlPath: '/v1/ack',
      body: new URLSearchParams({ session, m: messageId }).toString(),
      timeoutMs: ackTimeoutMs,
      failure: () => false,
      onResponse(res, finish) { finish(res.statusCode === 200); },
    });
  }

  return { wait, ack };
}

// ---------------------------------------------------------------------------
// The mail part (agent messaging, spec §6.2-6.4).
// ---------------------------------------------------------------------------
//
// The core's third component, beside the reducer and the marker sweep. After
// every sweep the core calls `sync(targets, derive)` with mailTargets' map
// (tmux session -> { pane, sessionID, dir }: spec rules 1-3, empty when the
// listing was incomplete) and the reducer's `derive`; `handle` passes every
// event to `onEvent`. The hub addresses a tmux session, so the state machine is
// per tmux session (one pane each: mailTargets names the active pane, R15):
//
//   off      Nothing held, nothing in flight. -> waiting when sync() (or a
//            pump after a timer or a settled item) finds: a target, a tmux
//            name the hub accepts (MAIL_SESSION_RE, else the wait is a 400 that
//            would back the whole socket off), derive(target.sessionID).state
//            === 'ready' (rule 4), no socket backoff running, no hold-off for
//            this session, and NO in-flight entry naming this tmux session.
//   waiting  One held GET /v1/wait?session=&pane= with its own AbortController.
//            sync() aborts it (-> off, never a backoff: our own abort is told
//            by our own signal, not by the client's reason) when the target is
//            gone, names another pane or another OpenCode session, or is not
//            ready. Its answer:
//              204 idle -> off; the socket counts as healthy. An idle that came
//                          back within MAIL_IDLE_MIN_MS of arming (a listener
//                          shutting down) holds the session off for the rest of
//                          that second, so no answer can make a request loop.
//              down     -> off; the socket backs off (below). Reason `path`
//                          (a socket path the kernel cannot bind) never heals:
//                          the part goes inert for good, one debug line.
//              200 mail -> the socket counts as healthy; re-check the target
//                          (same pane and session) and `ready` against the
//                          freshest sync and derive. Failed -> off, dropped: no
//                          synthetic, no ack; the message stays `handed` and the
//                          hub re-offers it on the next wait of that pane (or
//                          after REOFFER_MS). A message id already in flight ->
//                          dropped too, and the session held off (never a
//                          second synthetic for one message). Else -> posted.
//   posted   An in-flight entry { messageId, tmuxSession, sessionID, inboxID,
//            postedAt } exists and synthetic({ sessionID, text, delivery:
//            'queue', resume: true, metadata: { tmuxifierMail } }) was called.
//            No wait for this tmux session, whatever sync() says: a new wait of
//            the pane makes the hub put the handed message back in the queue,
//            so the ack would 404 and the message would be handed twice
//            (spec 6.4 step 4). The target vanishing (the TUI exited) does not
//            end it (Review Focus 4). It ends, -> off, by exactly one of:
//              synthetic rejects/throws -> no ack; the session holds off
//                          (30 s doubling to 30 min, reset by a synthetic that
//                          works); the hub re-offers on the next wait.
//              inbox.delivered for its inboxID -> POST /v1/ack, and the entry
//                          is dropped only once the ack has answered (true or
//                          not: a refused ack means the hub already re-queued).
//              inbox.cancelled for its inboxID -> dropped, no ack.
//              MAIL_REOFFER_MS after postedAt (the hub's own REOFFER_MS) ->
//                          dropped, no ack (at-least-once, spec 6.4).
//
// Correlation. The entry learns its inboxID from synthetic's resolved `id`
// (F1), or earlier from `session.inbox.enqueued` whose item metadata names its
// message id (F1: same id). The stream may deliver `inbox.delivered` before
// synthetic resolves: a delivered/cancelled event matching no entry is kept in
// `recent` (MAIL_RECENT_MS, at most MAIL_RECENT_MAX) and matched when the
// entry learns its id. Nothing here reads the reducer's `mailWake` flag.
//
// Restart (F9, ruling R5). A restarted OpenCode server delivers a queued item
// with only `inbox.delivered` for the old inboxID: no enqueued replay, no
// metadata. So every entry with a known inboxID is written to
// ~/.tmuxifier-mail/opencode-inflight.json (0600, tmp + rename, only when that
// directory exists: the forward creates it, we never do; removed when empty)
// and a new part loads the entries younger than REOFFER_MS: it acks such a
// delivery, and because a loaded entry blocks its tmux session's wait, the hub
// never re-queues that message under it, so no second synthetic is posted.
//
// Hand-over (ruling R18). `state` ({ version, inflight, recent }) is the part's
// shared memory; takeOver passes prev.mailState to the next core's part, which
// adopts the same Maps (and merges the file). The aborted part holds nothing,
// arms nothing and runs no timer, but a synthetic or an ack already in flight
// finishes into the shared entries: its id is recorded, a delivery the new part
// already saw is acked, and an entry it settles is dropped from the shared map.
//
// Socket backoff (ruling R19): one for the whole part, 30 s doubling to 30 min;
// a failure while it runs does not double it again (the same outage), any 200
// or 204 (and a 200 ack) resets it. While it runs no wait is armed at all.
//
// Nothing here throws into OpenCode: sync/onEvent/abort catch everything, every
// promise chain ends in a catch, every timer callback is wrapped. Mail times are
// milliseconds on the injected `now`/`setTimeout`/`clearTimeout`.

// The hub's REOFFER_MS (agentMailHub.js; a test pins the two equal).
export const MAIL_REOFFER_MS = 600000;
export const MAIL_BACKOFF_MIN_MS = 30000;
export const MAIL_BACKOFF_MAX_MS = 1800000;
const MAIL_IDLE_MIN_MS = 1000;
const MAIL_RECENT_MS = 120000;
const MAIL_RECENT_MAX = 256;
const MAIL_INFLIGHT_MAX = 64;
const MAIL_FILE_MAX = 65536;
const OC_ID_MAX = 256;
// The shape of `state` a part hands over; bump it when that shape changes.
export const MAIL_STATE_VERSION = 1;
// The hub's SESSION_NAME_RE (sshCommand.js), pinned equal by a test: a tmux
// session the hub cannot address is never armed.
export const MAIL_SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAIL_INFLIGHT_FILE = 'opencode-inflight.json';

// An OpenCode id (`msg_…`, `ses_…`): a short string without controls.
const ocId = (v) => typeof v === 'string' && v.length > 0 && v.length <= OC_ID_MAX && !CONTROL_RE.test(v);

function adoptableMail(state) {
  try {
    return !!state && typeof state === 'object' && state.version === MAIL_STATE_VERSION
      && state.inflight instanceof Map && state.recent instanceof Map;
  } catch {
    return false;
  }
}

const doubling = (failures) => Math.min(MAIL_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1), MAIL_BACKOFF_MAX_MS);

export function createMailPart({
  home,
  client,
  synthetic,
  state = null,
  now = Date.now,
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
} = {}) {
  const shared = adoptableMail(state)
    ? state
    : { version: MAIL_STATE_VERSION, inflight: new Map(), recent: new Map() };
  const file = typeof home === 'string' && home ? path.join(home, '.tmuxifier-mail', MAIL_INFLIGHT_FILE) : null;
  const waits = new Map(); // tmux session -> { session, pane, sessionID, ac, armedAt }
  const holdOff = new Map(); // tmux session -> { until, failures }
  const timers = new Set();
  const entryTimers = new Map(); // message id -> timer
  const backoff = { failures: 0, until: 0 };
  let aborted = false;
  let inert = false;
  let last = { targets: new Map(), derive: () => null };

  const part = { sync, onEvent, abort, state: shared };

  function clock() {
    try {
      const t = now();
      if (Number.isFinite(t)) return t;
    } catch { /* fall through */ }
    return Date.now();
  }

  function timer(ms, fn) {
    if (aborted) return null;
    let handle = null;
    const run = () => {
      timers.delete(handle);
      if (aborted) return;
      try { fn(); } catch (e) { debug('mail timer', e); }
    };
    try {
      handle = setT(run, Math.max(0, ms));
      if (handle && typeof handle.unref === 'function') handle.unref();
      timers.add(handle);
    } catch (e) {
      debug('mail timer', e);
      return null;
    }
    return handle;
  }

  function stopTimer(handle) {
    if (handle === null || handle === undefined) return;
    timers.delete(handle);
    try { clearT(handle); } catch { /* best effort */ }
  }

  // ---- eligibility ----

  function targetOf(session) {
    const t = last.targets.get(session);
    return t && typeof t === 'object' && typeof t.pane === 'string' && PANE_ID_RE.test(t.pane) && ocId(t.sessionID) ? t : null;
  }

  function ready(sessionID) {
    try {
      return last.derive(sessionID)?.state === 'ready';
    } catch {
      return false;
    }
  }

  function stillEligible(rec) {
    const t = targetOf(rec.session);
    return !!t && t.pane === rec.pane && t.sessionID === rec.sessionID && ready(t.sessionID);
  }

  function inflightFor(session) {
    for (const e of shared.inflight.values()) if (e.tmuxSession === session) return true;
    return false;
  }

  // ---- waits ----

  function pump() {
    if (aborted || inert || clock() < backoff.until) return;
    for (const session of last.targets.keys()) {
      if (typeof session !== 'string' || waits.has(session) || !MAIL_SESSION_RE.test(session)) continue;
      const t = targetOf(session);
      if (!t || !ready(t.sessionID) || inflightFor(session)) continue;
      const h = holdOff.get(session);
      if (h && clock() < h.until) continue;
      arm(session, t);
      if (aborted || inert || clock() < backoff.until) return;
    }
  }

  function arm(session, t) {
    const rec = { session, pane: t.pane, sessionID: t.sessionID, ac: new AbortController(), armedAt: clock() };
    waits.set(session, rec);
    let p;
    try {
      p = Promise.resolve(client.wait({ session, pane: rec.pane, signal: rec.ac.signal }));
    } catch {
      p = Promise.resolve({ kind: 'down', reason: 'throw' });
    }
    p.then((r) => onWait(rec, r), () => onWait(rec, { kind: 'down', reason: 'reject' }))
      .catch((e) => debug('mail wait', e));
  }

  function endWait(rec) {
    if (waits.get(rec.session) === rec) waits.delete(rec.session);
    try { rec.ac.abort(); } catch { /* already aborted */ }
  }

  function onWait(rec, r) {
    // Our own abort (sync, abort()) ended it: nothing it says counts.
    if (rec.ac.signal.aborted || waits.get(rec.session) !== rec) return;
    waits.delete(rec.session);
    if (aborted) return;
    const kind = r && typeof r === 'object' ? r.kind : null;
    if (kind === 'idle') {
      socketOk();
      const elapsed = clock() - rec.armedAt;
      if (elapsed < MAIL_IDLE_MIN_MS) holdSession(rec.session, MAIL_IDLE_MIN_MS - elapsed, false);
      pump();
      return;
    }
    if (kind === 'mail' && typeof r.text === 'string' && typeof r.messageId === 'string' && MAIL_MSG_ID_RE.test(r.messageId)) {
      socketOk();
      onMail(rec, r);
      pump();
      return;
    }
    const reason = kind === 'down' && typeof r.reason === 'string' ? r.reason : 'unknown';
    if (reason === 'path') {
      inert = true;
      debug('mail socket path unusable; mail part inert');
      for (const w of [...waits.values()]) endWait(w);
      return;
    }
    socketDown(reason);
  }

  function socketOk() {
    backoff.failures = 0;
    backoff.until = 0;
  }

  function socketDown(reason) {
    const t = clock();
    if (t < backoff.until) return; // the same outage, already being waited out
    backoff.failures += 1;
    const delay = doubling(backoff.failures);
    backoff.until = t + delay;
    debug('mail socket down', reason, `retry in ${delay} ms`);
    timer(delay, pump);
  }

  // Keep `session` from arming for `ms`; `count` makes repeated hold-offs double.
  function holdSession(session, ms, count) {
    const prev = holdOff.get(session);
    const failures = count ? (prev?.failures ?? 0) + 1 : prev?.failures ?? 0;
    const delay = count ? doubling(failures) : ms;
    holdOff.set(session, { until: clock() + delay, failures });
    timer(delay, pump);
  }

  // ---- posting ----

  function onMail(rec, r) {
    if (!stillEligible(rec)) {
      debug('mail dropped: the pane is no longer eligible or not ready', r.messageId);
      return;
    }
    if (shared.inflight.has(r.messageId)) {
      debug('mail dropped: already in flight', r.messageId);
      holdSession(rec.session, 0, true);
      return;
    }
    const entry = { messageId: r.messageId, tmuxSession: rec.session, sessionID: rec.sessionID, inboxID: null, postedAt: clock() };
    shared.inflight.set(entry.messageId, entry);
    armEntryTimer(entry);
    let p;
    try {
      p = Promise.resolve(synthetic({
        sessionID: rec.sessionID,
        text: r.text,
        delivery: 'queue',
        resume: true,
        metadata: { tmuxifierMail: r.messageId },
      }));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then((res) => posted(entry, res), (e) => postFailed(entry, e)).catch((e) => debug('mail post', e));
  }

  function posted(entry, res) {
    if (shared.inflight.get(entry.messageId) !== entry) return; // settled meanwhile
    holdOff.delete(entry.tmuxSession);
    let id = null;
    try { id = res?.id; } catch { /* a throwing getter: no id */ }
    if (entry.inboxID === null && ocId(id)) entry.inboxID = id;
    save();
    matchRecent(entry);
  }

  function postFailed(entry, e) {
    debug('mail synthetic failed', e);
    if (shared.inflight.get(entry.messageId) !== entry) return;
    dropEntry(entry);
    holdSession(entry.tmuxSession, 0, true);
  }

  function armEntryTimer(entry) {
    stopTimer(entryTimers.get(entry.messageId));
    const handle = timer(entry.postedAt + MAIL_REOFFER_MS - clock(), () => {
      entryTimers.delete(entry.messageId);
      if (shared.inflight.get(entry.messageId) !== entry || entry.acking) return;
      debug('mail: no delivery within REOFFER_MS', entry.messageId);
      dropEntry(entry);
      pump();
    });
    if (handle !== null) entryTimers.set(entry.messageId, handle);
  }

  function dropEntry(entry) {
    if (shared.inflight.get(entry.messageId) === entry) shared.inflight.delete(entry.messageId);
    stopTimer(entryTimers.get(entry.messageId));
    entryTimers.delete(entry.messageId);
    save();
  }

  // ---- OpenCode's inbox events ----

  function onEvent(event) {
    try {
      if (aborted || !event || typeof event !== 'object') return;
      const type = event.type;
      if (type !== 'session.inbox.enqueued' && type !== 'session.inbox.delivered' && type !== 'session.inbox.cancelled') return;
      const data = event.data;
      if (!data || typeof data !== 'object' || !ocId(data.inboxID)) return;
      if (type === 'session.inbox.enqueued') {
        const item = data.item;
        const mid = item && item.type === 'synthetic' ? item.payload?.metadata?.tmuxifierMail : null;
        if (typeof mid !== 'string' || !MAIL_MSG_ID_RE.test(mid)) return;
        const entry = shared.inflight.get(mid);
        // Not ours in flight, or already named: an enqueued replay posts nothing, ever.
        if (!entry || entry.inboxID !== null || (ocId(data.sessionID) && data.sessionID !== entry.sessionID)) return;
        entry.inboxID = data.inboxID;
        save();
        matchRecent(entry);
        return;
      }
      const kind = type === 'session.inbox.delivered' ? 'delivered' : 'cancelled';
      const entry = byInbox(data.inboxID);
      if (entry) settle(entry, kind);
      else remember(data.inboxID, kind);
    } catch (e) {
      debug('mail event', e);
    }
  }

  function byInbox(inboxID) {
    for (const e of shared.inflight.values()) if (e.inboxID === inboxID) return e;
    return null;
  }

  function remember(inboxID, kind) {
    const t = clock();
    for (const [id, r] of shared.recent) {
      if (t - r.at < MAIL_RECENT_MS) break;
      shared.recent.delete(id);
    }
    shared.recent.delete(inboxID);
    shared.recent.set(inboxID, { kind, at: t });
    while (shared.recent.size > MAIL_RECENT_MAX) shared.recent.delete(shared.recent.keys().next().value);
  }

  function matchRecent(entry) {
    const r = entry.inboxID === null ? null : shared.recent.get(entry.inboxID);
    if (!r) return;
    shared.recent.delete(entry.inboxID);
    if (clock() - r.at < MAIL_RECENT_MS) settle(entry, r.kind);
  }

  function settle(entry, kind) {
    if (entry.acking) return;
    if (kind === 'cancelled') {
      dropEntry(entry);
      pump();
      return;
    }
    entry.acking = true;
    let p;
    try {
      p = Promise.resolve(client.ack({ session: entry.tmuxSession, messageId: entry.messageId }));
    } catch {
      p = Promise.resolve(false);
    }
    p.then((ok) => ok, () => false).then((ok) => {
      if (ok === true) socketOk();
      else debug('mail ack not confirmed', entry.messageId);
      dropEntry(entry);
      pump();
    }).catch((e) => debug('mail ack', e));
  }

  // ---- the in-flight file (ruling R5) ----

  function save() {
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      let isDir = false;
      try { isDir = statSync(path.dirname(file)).isDirectory(); } catch { isDir = false; }
      if (!isDir) return;
      const entries = [];
      for (const e of shared.inflight.values()) {
        if (e.inboxID !== null) {
          entries.push({ inboxID: e.inboxID, messageId: e.messageId, tmuxSession: e.tmuxSession, sessionID: e.sessionID, postedAt: e.postedAt });
        }
      }
      if (entries.length === 0) {
        try { unlinkSync(file); } catch { /* nothing to remove */ }
        return;
      }
      try { unlinkSync(tmp); } catch { /* no leftover */ }
      writeFileSync(tmp, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    } catch (e) {
      debug('mail save', e);
      try { unlinkSync(tmp); } catch { /* nothing left behind */ }
    }
  }

  // Our own file, but read like box output: every field allowlisted, sizes capped.
  function load() {
    if (!file) return;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > MAIL_FILE_MAX) return;
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      if (!doc || doc.version !== 1 || !Array.isArray(doc.entries)) return;
      const t = clock();
      for (const raw of doc.entries.slice(0, MAIL_INFLIGHT_MAX)) {
        if (!raw || typeof raw !== 'object') continue;
        const { inboxID, messageId, tmuxSession, sessionID, postedAt } = raw;
        if (!ocId(inboxID) || !ocId(sessionID) || typeof messageId !== 'string' || !MAIL_MSG_ID_RE.test(messageId)) continue;
        if (typeof tmuxSession !== 'string' || !MAIL_SESSION_RE.test(tmuxSession)) continue;
        if (!Number.isFinite(postedAt) || t - postedAt >= MAIL_REOFFER_MS) continue;
        if (shared.inflight.has(messageId) || byInbox(inboxID)) continue;
        shared.inflight.set(messageId, { messageId, tmuxSession, sessionID, inboxID, postedAt: Math.min(postedAt, t) });
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') debug('mail load', e);
    }
  }

  // ---- the part's interface ----

  function sync(targets, derive) {
    try {
      if (aborted) return;
      last = {
        targets: targets instanceof Map ? targets : new Map(),
        derive: typeof derive === 'function' ? derive : () => null,
      };
      for (const rec of [...waits.values()]) if (!stillEligible(rec)) endWait(rec);
      pump();
    } catch (e) {
      debug('mail sync', e);
    }
  }

  function abort() {
    if (aborted) return;
    aborted = true;
    try {
      for (const rec of [...waits.values()]) endWait(rec);
      waits.clear();
      for (const handle of [...timers]) stopTimer(handle);
      entryTimers.clear();
    } catch (e) {
      debug('mail abort', e);
    }
  }

  try {
    load();
    for (const entry of shared.inflight.values()) armEntryTimer(entry);
  } catch (e) {
    debug('mail start', e);
  }
  return part;
}

// ---------------------------------------------------------------------------
// The pane tagger (agent messaging, spec §6.9, rulings R7 and R23).
// ---------------------------------------------------------------------------
//
// One per plugin instance (OpenCode fires both hooks only in the instance whose
// project directory owns the session, so calls of different directories never
// meet in one tagger; calls of one directory still can, concurrently). The
// entry point registers `beforeTool` on `tool.execute.before` and `beforeShell`
// on `shell.create.before`.
//
//   beforeTool   For the `shell` tool only, with `input.command` a string:
//                remember { call id, command, pane } where pane is
//                `paneOf(sessionID)` (the pane of the tmux session whose mail
//                target is that OpenCode session, else null) or `none`.
//                A call id seen already is ignored (a hook registered twice).
//   beforeShell  Match the shell's `command` to the oldest pending record with
//                exactly that text (FIFO), use its record, and set
//                `env.TMUXIFIER_MAIL_PANE` to its pane, or `none` when there is
//                none. When several pending records carry that text and name
//                DIFFERENT panes (two sessions ran one command at once, and
//                nothing tells their shells apart) the answer is `none` for all
//                of them, the survivors included: the first shell takes its own
//                record, the others are marked `none`, so a later shell never
//                inherits a pane that may belong to its neighbour. The same
//                pane is that pane.
//
// Every shell it sees is tagged, a stale value already in `env` is overwritten,
// and a payload without an `env` object is left alone. A record lives `ttlMs`
// (a call whose shell is never created, a denied permission for instance, ages
// out; until then it can make an identical command of another pane read
// `none`, which fails closed), and at most TAG_PENDING_MAX are kept.
//
// Nothing here throws into OpenCode.

export const MAIL_PANE_ENV = 'TMUXIFIER_MAIL_PANE';
const TAG_PENDING_MAX = 256;

export function createPaneTagger({ paneOf, now = Date.now, ttlMs = 30000 } = {}) {
  let pending = []; // { id, command, pane, at }, oldest first
  const seen = new Map(); // call id -> at, so a late duplicate of a consumed call is ignored

  function clock() {
    try {
      const t = now();
      if (Number.isFinite(t)) return t;
    } catch { /* fall through to the real clock */ }
    return Date.now();
  }

  function expire(t) {
    pending = pending.filter((r) => t - r.at <= ttlMs);
    for (const [id, at] of seen) if (t - at > ttlMs) seen.delete(id);
  }

  function paneFor(sessionID) {
    try {
      if (typeof paneOf !== 'function' || typeof sessionID !== 'string') return 'none';
      const pane = paneOf(sessionID);
      return typeof pane === 'string' && PANE_ID_RE.test(pane) ? pane : 'none';
    } catch (e) {
      debug('paneOf', e);
      return 'none';
    }
  }

  function beforeTool(payload) {
    try {
      if (!payload || typeof payload !== 'object' || payload.tool !== 'shell') return;
      const command = payload.input?.command;
      if (typeof command !== 'string') return;
      const t = clock();
      expire(t);
      const id = typeof payload.id === 'string' && payload.id ? payload.id : null;
      if (id !== null) {
        if (seen.has(id)) return;
        seen.set(id, t);
        if (seen.size > TAG_PENDING_MAX) seen.delete(seen.keys().next().value);
      }
      pending.push({ id, command, pane: paneFor(payload.sessionID), at: t });
      if (pending.length > TAG_PENDING_MAX) pending.splice(0, pending.length - TAG_PENDING_MAX);
    } catch (e) {
      debug('pane tag tool', e);
    }
  }

  // The pane for a shell running `command`; consumes the record it used.
  function take(command) {
    expire(clock());
    if (typeof command !== 'string') return 'none';
    const same = pending.filter((r) => r.command === command);
    if (same.length === 0) return 'none';
    const first = same[0];
    const ambiguous = same.some((r) => r.pane !== first.pane);
    if (ambiguous) for (const r of same) r.pane = 'none';
    pending.splice(pending.indexOf(first), 1);
    return ambiguous ? 'none' : first.pane;
  }

  function beforeShell(payload) {
    try {
      if (!payload || typeof payload !== 'object') return;
      const env = payload.env;
      if (!env || typeof env !== 'object') return;
      env[MAIL_PANE_ENV] = take(payload.command);
    } catch (e) {
      debug('pane tag shell', e);
    }
  }

  return { beforeTool, beforeShell };
}

export const GLOBAL_KEY = Symbol.for('tmuxifier.opencode-agent');

// One live reporter: a reducer fed by the event stream, and a sweep that
// lists panes and writes the folded markers. `written` (marker name -> the
// content this core last wrote), `since` (tmux session -> epoch seconds it
// started hosting opencode) and `state` (the reducer's, see STATE_VERSION)
// are plain properties so a hand-over can pass them on to the next core;
// `state` (a previous core's) seeds this core's reducer.
//
// The mail part (createMailPart) exists only when `synthetic` (OpenCode's
// ctx.session.synthetic, supplied by the entry point) is a function and `home`
// is set; `mail` replaces it for a test (`null`: none). `mailState` is a
// previous core's `core.mailState` (the part's shared memory, see the part).
// After every sweep's fold the core gives the part mailTargets' map, or an
// empty one when the listing failed or was incomplete (parsePanesChecked).
export function createCore({
  home = os.homedir(),
  listPanes = defaultListPanes,
  now = () => Math.floor(Date.now() / 1000),
  sweepMs = SWEEP_MS,
  paneCacheMs = PANE_CACHE_MS,
  setInterval: startTimer = globalThis.setInterval,
  clearInterval: stopTimer = globalThis.clearInterval,
  state = null,
  synthetic = null,
  mail: mailOption = undefined,
  mailState = null,
} = {}) {
  const reducer = createReducer({ now, state });
  let mail = null;
  if (mailOption !== undefined) {
    mail = mailOption && typeof mailOption === 'object' ? mailOption : null;
  } else if (typeof synthetic === 'function' && typeof home === 'string' && home) {
    try {
      mail = createMailPart({
        home,
        synthetic,
        state: mailState,
        client: createMailSocketClient({ sockPath: path.join(home, '.tmuxifier-mail', 'sock') }),
      });
    } catch (e) {
      debug('mail', e);
      mail = null;
    }
  }
  const controller = new AbortController();
  const dir = path.join(home, '.tmuxifier-agent');
  let aborted = false;
  // The event stream ended on its own: the reducer is frozen, nothing more
  // is written (a hand-over can still take what this core knows).
  let ended = false;
  // listPanes reported no tmux at all: never sweep again (this core).
  let tmuxMissing = false;
  let attached = false;
  let timer = null;
  let inflight = null;
  let rerun = false;
  let cache = null;
  // now() taken just before the last usable listing was requested.
  let lastListAt = null;

  const core = {
    reducer,
    state: reducer.state,
    attach,
    handle,
    sweep,
    abort,
    clear,
    written: new Map(),
    since: new Map(),
    mailState: mail?.state ?? null,
    mailTargetsNow,
    paneOfSession,
    owner: Symbol('tmuxifier.opencode-agent.core'),
  };

  // The targets of the last sweep: tmux session -> { pane, sessionID, dir }.
  // Empty until a complete listing, after an unusable or incomplete one (R17),
  // and once this core stopped. The pane tagger reads them (paneOfSession).
  let targets = new Map();

  // `panes` null: no usable, complete listing, so no mail targets at all.
  function syncMail(panes) {
    targets = panes ? mailTargets(reducer, panes, core.since) : new Map();
    if (!mail) return;
    try {
      mail.sync(targets, reducer.derive);
    } catch (e) {
      debug('mail sync', e);
    }
  }

  // A copy: the part keeps the map it was given.
  function mailTargetsNow() {
    return new Map(targets);
  }

  // R23: the pane of the tmux session whose current mail target is the OpenCode
  // session `sessionID`, else null (a session that is no target, or one that
  // two tmux sessions claim, has no pane to speak for).
  function paneOfSession(sessionID) {
    if (typeof sessionID !== 'string') return null;
    let pane = null;
    for (const t of targets.values()) {
      if (t.sessionID !== sessionID) continue;
      if (pane !== null) return null;
      pane = t.pane;
    }
    return pane;
  }

  function mailCall(name, arg) {
    if (!mail) return;
    try { mail[name](arg); } catch (e) { debug('mail', name, e); }
  }

  // { text, listAt, missing }: the listing (null when unusable), now() taken
  // just before it was requested, and whether tmux is missing altogether.
  async function listing() {
    const t = Date.now();
    if (cache && t >= cache.at && t - cache.at < paneCacheMs) return cache.result;
    const listAt = now();
    let text = null;
    try {
      text = await listPanes();
    } catch (e) {
      debug('listPanes', e);
    }
    const missing = text === TMUX_MISSING;
    if (typeof text !== 'string') text = null;
    const result = { text, listAt, missing };
    cache = { at: Date.now(), result };
    return result;
  }

  function write(name, content) {
    // `.`/`..` cannot be tmux session names (tmux forbids '.'), but the
    // listing is untrusted: never let one name the directory or its parent.
    if (!name || name === '.' || name === '..') return false;
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, content, { mode: 0o644 });
      renameSync(tmp, file);
      return true;
    } catch (e) {
      debug('write', name, e);
      try { unlinkSync(tmp); } catch { /* nothing left behind, or nothing to do */ }
      return false;
    }
  }

  // Delete a marker this core wrote, unless someone (the Claude hook) has
  // rewritten it since; forget it either way.
  function release(name) {
    try {
      const file = path.join(dir, name);
      if (readFileSync(file, 'utf8') === core.written.get(name)) unlinkSync(file);
    } catch { /* already gone or unreadable: nothing of ours to delete */ }
    core.written.delete(name);
  }

  async function sweepOnce() {
    const { text, listAt, missing } = await listing();
    if (missing && !tmuxMissing) {
      tmuxMissing = true;
      debug('tmux not found; sweeps stopped until the next setup');
      stopSweeping();
    }
    if (aborted || ended) return; // handed over or stopped: touch nothing
    if (text === null) { syncMail(null); return; } // tmux unusable: no markers touched, no mail targets
    // A tmux session that starts hosting opencode in this listing did so after
    // the previous listing, the last one that showed it not hosting: that is
    // its `since`. Stamping this sweep's own time instead would exclude a
    // TUI's whole first turn whenever the listing is slower than the turn's
    // start (`ts >= since`). A core's first sweep has no previous listing.
    const sinceFloor = lastListAt ?? listAt - 2;
    lastListAt = listAt;
    let complete = false;
    let panes = [];
    try {
      ({ panes, complete } = parsePanesChecked(text));
      const t = now();
      const hosting = new Set();
      for (const p of panes) if (isOpencodeCmd(p.cmd)) hosting.add(p.session);
      for (const s of hosting) if (!core.since.has(s)) core.since.set(s, sinceFloor);
      for (const s of [...core.since.keys()]) if (!hosting.has(s)) core.since.delete(s);

      const live = new Set();
      for (const [session, fold] of foldForPanes(reducer, panes, core.since, t)) {
        const name = safeName(session);
        const content = markerLine(session, fold);
        live.add(name);
        if (core.written.get(name) !== content && write(name, content)) core.written.set(name, content);
      }
      for (const name of [...core.written.keys()]) if (!live.has(name)) release(name);
    } catch (e) {
      debug('sweep', e);
      complete = false;
    }
    syncMail(complete ? panes : null);
  }

  // At most one sweep in flight; any request made meanwhile reruns it once
  // after. The returned promise settles when the rerun is done too; it never
  // rejects.
  function sweep() {
    if (tmuxMissing) return Promise.resolve();
    if (inflight) {
      rerun = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          rerun = false;
          await sweepOnce();
        } while (rerun && !aborted && !ended && !tmuxMissing);
      } catch (e) {
        debug('sweep', e);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function handle(event) {
    let changed = false;
    try {
      changed = reducer.apply(event);
    } catch (e) {
      debug('apply', e);
    }
    if (!aborted && !ended) mailCall('onEvent', event);
    if (changed && !aborted && !ended) await sweep();
  }

  // Sweep now and every sweepMs, and feed the event stream into handle()
  // until abort(). handle() is not awaited per event: the reducer applies
  // each event synchronously, in order, and the sweeps coalesce.
  async function attach(ctx) {
    if (aborted || attached) return;
    attached = true;
    sweep();
    try {
      timer = startTimer(() => { sweep(); }, sweepMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch (e) {
      debug('timer', e);
    }
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (aborted) break;
        handle(event);
      }
    } catch (e) {
      if (!aborted) debug('subscribe', e);
    }
    // The stream ended or threw on its own. The reducer is frozen from here
    // on, so sweeping would keep republishing a stale working/blocked: stop
    // the timer, never re-subscribe, let an in-flight sweep finish (it writes
    // nothing now), then delete our markers under the content rule. The core
    // stays the global: a later setup takes over since and the reducer state.
    if (!aborted) {
      ended = true;
      debug('event stream ended; markers cleared, sweeps stopped until the next setup');
      stopSweeping();
      targets = new Map();
      // Without events no delivery can be seen: hold nothing (the state stays for a hand-over).
      mailCall('abort');
      try { await inflight; } catch { /* sweeps never reject */ }
      if (!aborted) clear();
    }
  }

  function stopSweeping() {
    if (timer !== null) {
      try { stopTimer(timer); } catch { /* best effort */ }
      timer = null;
    }
  }

  // Stop the subscription and the timer. Markers stay: the next core
  // inherits them, or clear() deletes them.
  function abort() {
    aborted = true;
    try { controller.abort(); } catch { /* already aborted */ }
    stopSweeping();
    targets = new Map();
    mailCall('abort');
  }

  // Delete every marker this core wrote, under the content-equality rule.
  function clear() {
    for (const name of [...core.written.keys()]) release(name);
  }

  return core;
}

// The hand-over every setup performs: abort whichever core `prev` is (a
// foreign or older object is never trusted to have abort()), then build the
// next core inheriting what `prev` wrote, when each tmux session started
// hosting, and everything its reducer knows (a pending block or a mid-turn
// session in another directory must survive OpenCode setting the plugin up
// for a new one; an incompatible STATE_VERSION starts fresh), and the mail
// part's in-flight items (prev.mailState; its abort ended every held wait).
// `opts` are createCore's.
export function takeOver(prev, opts = {}) {
  let written = null;
  let since = null;
  let state = null;
  let mailState = null;
  if (prev && typeof prev === 'object') {
    try { prev.abort(); } catch { /* a foreign or older object */ }
    try {
      if (prev.written instanceof Map) written = prev.written;
      if (prev.since instanceof Map) since = prev.since;
      state = prev.state ?? null;
      mailState = prev.mailState ?? null;
    } catch { /* a throwing getter: inherit nothing more */ }
  }
  const core = createCore({ ...opts, state, mailState });
  if (written) core.written = written;
  if (since) core.since = since;
  return core;
}

// The OpenCode V2 entry point. OpenCode sets the plugin up once per project
// directory in one long-lived server and reloads a rewritten plugin file
// without necessarily cleaning up the old instance (facts 1-3), so the core
// is a process-wide singleton: every setup takes over from whichever core
// holds the global and becomes the owner. A cleanup acts only while its core
// still owns the global.
export default {
  id: 'tmuxifier-agent',
  async setup(ctx) {
    let core = null;
    try {
      core = takeOver(globalThis[GLOBAL_KEY]);
      globalThis[GLOBAL_KEY] = core;
      core.attach(ctx).catch((e) => debug('attach', e));
    } catch (e) {
      debug('setup', e);
    }
    return async function cleanup() {
      try {
        if (!core || globalThis[GLOBAL_KEY] !== core) return;
        core.abort();
        core.clear();
        delete globalThis[GLOBAL_KEY];
      } catch (e) {
        debug('cleanup', e);
      }
    };
  },
};
