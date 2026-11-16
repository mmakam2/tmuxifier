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
//    A session's pane is its mail target's (R23); a subagent (child) session
//    speaks for its root's, found through the reducer's parent chain (R24).
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
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
export const STATE_VERSION = 4;

// A Tmuxifier message id as agentMailStore.js mints it (`MSG_ID_RE` there):
// `m-` and 8 characters of an alphabet without i, l, o, 0, 1. Spelled out here
// because the asset imports nothing from the repo; a test pins the two equal.
export const MAIL_MSG_ID_RE = /^m-[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

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
    // 'user' or 'synthetic': the newest such inbox item. A mail wake is a
    // synthetic item (fact 9), so the turn it starts reads as a resume.
    lastInbox: null,
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
  // sessionID -> { dir, lastInbox, evidenceAt } from inbox items of sessions
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
        if (kind === 'user' || kind === 'synthetic') s.lastInbox = kind;
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
  // already has its answer has nothing left to read. Every emitter has an `error` listener
  // before anything can destroy it (the request's is attached before the timer, the abort or
  // a response can run; the response's before `onResponse` sees it), and a branch that does
  // not read the body drains it (`skip`) before it settles: this runs inside OpenCode's
  // shared server, on Bun's node:http, whose order of events after a destroy is unmeasured,
  // and an unhandled `error` there would take down every TUI's state.
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
          try { res.on('error', () => finish(failure('connect'))); } catch { /* not an emitter */ }
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

  // An answer whose body is not read: let it flow, so nothing waits on it.
  function skip(res) {
    try { res.resume(); } catch { /* already destroyed */ }
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
        if (res.statusCode === 204) { skip(res); finish({ kind: 'idle' }); return; }
        if (res.statusCode !== 200) { skip(res); finish(down(`status ${res.statusCode}`)); return; }
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
      onResponse(res, finish) { skip(res); finish(res.statusCode === 200); },
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
// per tmux session (one pane each: mailTargets names the active pane, R15).
// A target counts only while `hooked(target.dir)` (the entry point's registry:
// an OpenCode instance of that directory carries our pane tagger, R33) says
// true; without a `hooked` function every target counts:
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
//                          after REOFFER_MS). Else -> posted. (A message id
//                          cannot already be in flight here: an entry exists
//                          only for its own tmux session, which arms no wait
//                          while it does, and the hub hands a message only to
//                          the session it is addressed to.)
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
// entry learns its id.
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
  hooked = null,
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
    if (!(t && typeof t === 'object' && typeof t.pane === 'string' && PANE_ID_RE.test(t.pane) && ocId(t.sessionID))) return null;
    return dirHooked(t.dir) ? t : null;
  }

  // R33: a target whose directory has no hooked OpenCode instance gets no
  // wait: its agent's `tmx` would run untagged and speak as the wrong pane.
  function dirHooked(dir) {
    if (typeof hooked !== 'function') return true;
    try {
      return hooked(dir) === true;
    } catch {
      return false;
    }
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
// Every shell it sees is tagged once (a second call on the same `env` object does
// nothing), a stale value already in `env` is overwritten, and a payload without
// an `env` object is left alone. A record lives `ttlMs`
// (a call whose shell is never created, a denied permission for instance, ages
// out; until then it can make an identical command of another pane read
// `none`, which fails closed), and at most TAG_PENDING_MAX are kept.
//
// Nothing here throws into OpenCode.

export const MAIL_PANE_ENV = 'TMUXIFIER_MAIL_PANE';
const TAG_PENDING_MAX = 256;
// How far up the parent chain paneOfSession looks for a mail target.
const MAIL_PARENT_DEPTH_MAX = 32;

export function createPaneTagger({ paneOf, now = Date.now, ttlMs = 30000 } = {}) {
  let pending = []; // { id, command, pane, at }, oldest first
  const seen = new Map(); // call id -> at, so a late duplicate of a consumed call is ignored
  // The env objects already tagged: one shell seen twice (a hook registered twice) keeps its
  // first tag instead of having it overwritten by a second, record-less `none`.
  const tagged = new WeakSet();

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
      if (tagged.has(env)) return;
      env[MAIL_PANE_ENV] = take(payload.command);
      tagged.add(env);
    } catch (e) {
      debug('pane tag shell', e);
    }
  }

  return { beforeTool, beforeShell };
}

// ---------------------------------------------------------------------------
// Permission: plain `tmx` is allowed unless the operator has shell rules
// (agent messaging spec §6.7, rulings R8, R9, R26).
// ---------------------------------------------------------------------------
//
// Claude Code gets `Bash(tmx *)` from setup. OpenCode has no settings entry to
// merge, so the plugin answers `permission.evaluate` itself (the entry point
// registers createPermissionHandler's function). The payload, measured on
// OpenCode 2.3.0 (test/fixtures/README-opencode-2.3-event-trace.md F3):
//
//   { sessionID, agent, action: 'shell', resources: [...], source: { type:
//     'tool', ... }, effect: 'allow' | 'ask' | 'deny' }
//
// `resources` holds one entry per command OpenCode's parser finds (`tmx who; id`
// is `['tmx who', 'id']`, a `$( )` adds the inner command as a second entry),
// and `effect` is mutable.
//
// The handler acts only when action is `shell`, there is exactly ONE resource,
// that resource is a plain tmx command (isPlainTmx) AND is byte for byte the
// command the agent wrote (R29, below), and the current effect is not `deny`;
// then it sets `effect = 'allow'`. It never sets deny, never touches another
// field, and never throws.
//
// The operator's own rules win (operator ruling, 2026-11-16): in Claude Code an
// `ask` rule beats `allow`, and the hook cannot tell OpenCode's default `ask`
// from an operator's rule (`source` only says `{ type: 'tool' }`). So the
// plugin reads the operator's OpenCode configuration itself (createOperatorRules)
// and does nothing when any file OpenCode merges sets a shell rule.

// The program is `tmx`, `~/.local/bin/tmx` or `$HOME/.local/bin/tmx`, then a
// subcommand tmx knows (tmuxifier-mail.sh), then a blank or the end.
const PLAIN_TMX_RE = /^[ \t]*(?:tmx|~\/\.local\/bin\/tmx|\$HOME\/\.local\/bin\/tmx)[ \t]+(?:who|send|reply|wait|read|inbox)(?=[ \t]|$)/;
// The arguments after the subcommand, an ALLOWLIST (R28): blank-separated words,
// each one or more of a bare character from a short inert set, a single-quoted
// string, or a double-quoted string without `"`, `$`, backtick, `\` or `!`.
// Everything else is refused, quoted or not: `(`, `)`, `*`, `?`, `[`, `{`, `~`,
// `=`, `#`, `^`, `\` and an unbalanced quote are shell syntax in zsh and bash
// (`=(cmd)`, `*(e:cmd:)`, `f(+cmd)` run code; a glob, a brace or a `~` expands).
// Inside quotes they are inert, so a message may hold them. The single-character
// alternation matters: `(?:[a-z]+|...)+` would backtrack catastrophically.
const TMX_ARGS_RE = /^(?:[ \t]+(?:[A-Za-z0-9_@%+:,.\/-]|'[^']*'|"[^"$`\\!]*")+)*[ \t]*$/;
// On top of the allowlist, kept from the first ruling: no `$` (so no `$(`,
// `${`, `$VAR`: a variable argument would send the agent's own environment to
// the other agent), backtick, `|`, `;`, `&`, `>`, `<`, newline or other control
// byte except tab, even inside quotes. Textual, not a shell parser: a quoted `;`
// makes a command not plain, and OpenCode then decides as it would have (an
// `ask` the operator answers). When in doubt, not plain.
const TMX_UNSAFE_RE = /[$`|;&<>\u0000-\u0008\u000a-\u001f\u007f]/;

// True for exactly one `tmx <subcommand> ...` command with nothing in it that
// could run, redirect or expand into something else.
export function isPlainTmx(command) {
  try {
    if (typeof command !== 'string') return false;
    const m = PLAIN_TMX_RE.exec(command);
    if (!m) return false;
    const rest = command.slice(m[0].length);
    return !TMX_UNSAFE_RE.test(rest) && TMX_ARGS_RE.test(rest);
  } catch {
    return false;
  }
}

// A JSON reader that tolerates what OpenCode's own accepts in `.jsonc`:
// `//` and `/* */` comments and trailing commas, both only OUTSIDE strings
// (a URL in a string holds `//`; an escaped quote does not end a string).
// Returns the parsed plain object, or null for anything else: a parse failure,
// an unterminated comment or string, an array or scalar at the top, a
// non-string input. Never throws.
export function readJsonc(text) {
  try {
    if (typeof text !== 'string') return null;
    const n = text.length;
    const out = [];
    // out[comma] is the last comma written when nothing but blanks and
    // comments followed it (so a `}` or `]` now makes it a trailing comma).
    let comma = -1;
    let last = ''; // the last significant (non-blank) character written
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        let j = i + 1;
        while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        if (j >= n) return null;
        out.push(text.slice(i, j + 1));
        comma = -1;
        last = '"';
        i = j + 1;
      } else if (c === '/' && text[i + 1] === '/') {
        let j = i + 2;
        while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
        out.push(' ');
        i = j;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) return null;
        out.push(' ');
        i = end + 2;
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        out.push(c);
        i++;
      } else if (c === ',') {
        // A comma straight after `{`, `[`, another comma or nothing is never a
        // trailing one: leave it for JSON.parse to refuse.
        comma = last === '' || last === '{' || last === '[' || last === ',' ? -1 : out.length;
        out.push(',');
        last = ',';
        i++;
      } else {
        if ((c === '}' || c === ']') && comma >= 0) out[comma] = '';
        comma = -1;
        out.push(c);
        last = c;
        i++;
      }
    }
    const value = JSON.parse(out.join(''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const OPERATOR_CONFIG_MAX_BYTES = 1024 * 1024;
const OPERATOR_CACHE_MAX = 512;
// A file modified less than this long ago is read again every time: two edits
// inside one filesystem timestamp tick can share (mtime, size, inode).
const OPERATOR_RACY_MS = 2000;
// Most entries looked at under one agent directory, sub-directories included;
// more counts as rules. Deepest sub-directory looked into (the agent directory
// itself is depth 0); a deeper one counts as rules.
const OPERATOR_AGENT_DIR_MAX = 500;
const OPERATOR_AGENT_DEPTH_MAX = 4;
// Environment variables that carry OpenCode configuration or permissions
// themselves: set and non-empty, the operator has rules (not read further).
const OPERATOR_ENV_KEYS = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'];
// config.json is the legacy global name OpenCode still merges.
const OPERATOR_GLOBAL_FILES = ['opencode.json', 'opencode.jsonc', 'config.json'];
const OPERATOR_PROJECT_FILES = [
  'opencode.json',
  'opencode.jsonc',
  path.join('.opencode', 'opencode.json'),
  path.join('.opencode', 'opencode.jsonc'),
];
// Agent definitions in markdown, and modes (the older spelling of the same).
const OPERATOR_AGENT_DIRS = ['agent', 'agents', 'mode', 'modes'];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Does this `permission` value (a config's or an agent's) say anything about
// the shell? A string is a rule for every tool. An object does when it has the
// key `shell` (OpenCode 2.3.0's name), `bash` (the older one) or `*`, or any
// other glob key that could match either. Absent: no. A value of any other
// type is no shape OpenCode documents: fail closed.
function permissionSetsShell(permission) {
  if (permission === undefined) return false;
  if (!isPlainObject(permission)) return true;
  return Object.keys(permission).some((k) => k === 'shell' || k === 'bash' || k.includes('*') || k.includes('?'));
}

// A parsed config: its own `permission`, or that of any `agent.<name>` (and
// `mode.<name>`, the older spelling of the same thing).
function configSetsShell(cfg) {
  if (permissionSetsShell(cfg.permission)) return true;
  for (const group of [cfg.agent, cfg.mode]) {
    if (!isPlainObject(group)) continue;
    for (const entry of Object.values(group)) {
      if (isPlainObject(entry) && permissionSetsShell(entry.permission)) return true;
    }
  }
  return false;
}

// An agent definition in markdown carries its permissions in its frontmatter:
// any mention of the word is treated as rules (fail closed).
const agentFileSetsShell = (text) => text.includes('permission');

// The directories OpenCode may read a global config from, or null when one
// cannot be located (a relative path: fail closed). $OPENCODE_CONFIG_DIR names
// the opencode directory itself (the installer puts plugins/ in it) and is read
// in addition to the default, never instead of it; the default is
// $XDG_CONFIG_HOME/opencode, else ~/.config/opencode.
function globalConfigDirs(home, env) {
  const set = (v) => (typeof v === 'string' && v ? v : null);
  const dirs = [];
  const own = set(env?.OPENCODE_CONFIG_DIR);
  if (own) dirs.push(own);
  const xdg = set(env?.XDG_CONFIG_HOME);
  if (xdg) dirs.push(path.join(xdg, 'opencode'));
  else if (set(home)) dirs.push(path.join(home, '.config', 'opencode'));
  if (dirs.length === 0 || !dirs.every((d) => path.isAbsolute(d))) return null;
  return dirs;
}

// Does the operator have shell/bash permission rules in any config OpenCode
// merges for a session in some directory? (R9, R26, R30, R31)
//
//   hasBashRules(dir)  true when ANY of these sets one: the environment
//                      (OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT or
//                      OPENCODE_PERMISSION non-empty); the global config dir's
//                      opencode.json / opencode.jsonc / config.json (the legacy
//                      name); and, for `dir` and every
//                      parent up to `/`, opencode.json, opencode.jsonc,
//                      .opencode/opencode.json and .opencode/opencode.jsonc. A
//                      file sets one when `permission` is a string or an object
//                      with `shell`, `bash` or `*`, or the same under any
//                      `agent.<name>.permission`. Also any agent markdown file
//                      (*.md) whose text contains `permission` in the global
//                      dir's agent/, agents/, mode/ or modes/ and in each
//                      level's .opencode/ ones of the same names, recursively
//                      (OpenCode names a nested file's agent by its path).
//
// Fail closed: a present file that cannot be stat'ed, read or parsed, one that
// is not a regular file (a FIFO would block OpenCode's one shared server on a
// synchronous read, /dev/zero never ends: checked from the stat before any
// read), one over 1 MiB, an agent directory that cannot be listed, a tree under
// one that holds over 500 entries in all or goes deeper than 4 sub-directories,
// an entry whose kind cannot be stat'ed, a `dir` that is no absolute path, and a
// global dir that cannot be located all answer true. A missing file or directory (ENOENT/ENOTDIR)
// answers false. A file's verdict is cached by (mtime, size, inode), so an edit
// applies to the next command without a restart; a file modified less than 2 s
// before `now()` is never cached (an in-place edit inside one timestamp tick
// would otherwise keep a stale "no rules"), and a read failure never is.
//
// `fs` needs `statSync` and `readFileSync`, and `readdirSync` for the agent
// directories (absent: those are not looked at; the default has it). A residual
// race remains between the stat and the read: a file swapped for a FIFO in that
// instant would block the read.
export function createOperatorRules({
  home = os.homedir(),
  env = process.env,
  fs = { statSync, readFileSync, readdirSync },
  now = Date.now,
} = {}) {
  const cache = new Map(); // file -> { key, rules }

  function clock() {
    try {
      const t = now();
      if (Number.isFinite(t)) return t;
    } catch { /* fall through to the real clock */ }
    return Date.now();
  }

  // `verdict(text)` -> boolean for this kind of file.
  function fileHasRules(file, verdict) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      const code = e && e.code;
      return !(code === 'ENOENT' || code === 'ENOTDIR');
    }
    try {
      if (typeof st.isFile !== 'function' || !st.isFile()) return true;
      if (!(st.size <= OPERATOR_CONFIG_MAX_BYTES)) return true;
      const key = Number.isFinite(st.mtimeMs) && Number.isFinite(st.size) ? `${st.mtimeMs}:${st.size}:${st.ino}` : null;
      const hit = key ? cache.get(file) : null;
      if (hit && hit.key === key) return hit.rules;
      const text = fs.readFileSync(file, 'utf8');
      if (typeof text !== 'string' || text.length > OPERATOR_CONFIG_MAX_BYTES) return true;
      const rules = verdict(text);
      if (key && clock() - st.mtimeMs >= OPERATOR_RACY_MS) {
        cache.delete(file);
        cache.set(file, { key, rules });
        if (cache.size > OPERATOR_CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      return rules;
    } catch (e) {
      debug('operator rules', file, e);
      return true;
    }
  }

  const configVerdict = (text) => {
    const cfg = readJsonc(text);
    return cfg === null ? true : configSetsShell(cfg);
  };

  // Every *.md under `dir`, recursively, through fileHasRules. Another entry is
  // stat'ed (following a symlink, as OpenCode's glob does) and descended into
  // when it is a directory; `budget.left` counts entries across the whole tree.
  function agentDirHasRules(dir, depth = 0, budget = { left: OPERATOR_AGENT_DIR_MAX }) {
    if (typeof fs.readdirSync !== 'function') return false;
    if (depth > OPERATOR_AGENT_DEPTH_MAX) return true;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      const code = e && e.code;
      return !(code === 'ENOENT' || code === 'ENOTDIR');
    }
    if (!Array.isArray(names)) return true;
    budget.left -= names.length;
    if (budget.left < 0) return true;
    for (const name of names) {
      if (typeof name !== 'string') return true;
      const full = path.join(dir, name);
      if (/\.md$/i.test(name)) {
        if (fileHasRules(full, agentFileSetsShell)) return true;
        continue;
      }
      let st;
      try {
        st = fs.statSync(full);
      } catch (e) {
        const code = e && e.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        return true;
      }
      if (!st || typeof st.isDirectory !== 'function') return true;
      if (st.isDirectory() && agentDirHasRules(full, depth + 1, budget)) return true;
    }
    return false;
  }

  function hasBashRules(dir) {
    try {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) return true;
      for (const key of OPERATOR_ENV_KEYS) {
        const v = env?.[key];
        if (v !== undefined && v !== null && v !== '') return true;
      }
      const globals = globalConfigDirs(home, env);
      if (!globals) return true;
      for (const g of globals) {
        for (const name of OPERATOR_GLOBAL_FILES) if (fileHasRules(path.join(g, name), configVerdict)) return true;
        for (const sub of OPERATOR_AGENT_DIRS) if (agentDirHasRules(path.join(g, sub))) return true;
      }
      let d = path.resolve(dir);
      for (;;) {
        for (const rel of OPERATOR_PROJECT_FILES) if (fileHasRules(path.join(d, rel), configVerdict)) return true;
        for (const sub of OPERATOR_AGENT_DIRS) if (agentDirHasRules(path.join(d, '.opencode', sub))) return true;
        const up = path.dirname(d);
        if (up === d) return false;
        d = up;
      }
    } catch (e) {
      debug('operator rules', e);
      return true;
    }
  }

  return { hasBashRules };
}

// The directory a session runs in: its own, else (a subagent) the nearest
// ancestor's, up to MAIL_PARENT_DEPTH_MAX hops. Null for a session the reducer
// does not know, a chain with no directory, a broken or looping chain.
export function dirOfSession(reducer, sessionID) {
  try {
    if (typeof sessionID !== 'string' || !sessionID) return null;
    const sessions = reducer?.sessions;
    if (!(sessions instanceof Map)) return null;
    const seen = new Set();
    let cur = sessionID;
    for (let hops = 0; hops <= MAIL_PARENT_DEPTH_MAX; hops++) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const s = sessions.get(cur);
      if (!s) return null;
      if (typeof s.dir === 'string' && s.dir) return s.dir;
      cur = s.parent;
      if (typeof cur !== 'string' || !cur) return null;
    }
    return null;
  } catch (e) {
    debug('dirOfSession', e);
    return null;
  }
}

const PERMISSION_PENDING_MAX = 256;

// The `permission.evaluate` handler and the hook that feeds it (R29).
// `evaluate`'s `resources` are what OpenCode's parser made of the command, and
// it may drop what is not a command (a redirect, an assignment prefix such as
// `PATH=/tmp/x tmx who`, a trailing `&`): a plain-looking resource is not proof
// of a plain command. So the entry point also registers `beforeTool` on
// `tool.execute.before` (which fires first, same millisecond, F4): for the
// `shell` tool it remembers the raw `input.command` by call id (a bounded map
// that ages out after `ttlMs`, newest `PERMISSION_PENDING_MAX` kept). `evaluate`
// then allows only when a raw command is remembered for `evaluation.source.id`,
// isPlainTmx(raw), there is exactly one resource, and that resource is `raw`
// exactly. It consumes the record, so a call is answered once; a call with no
// record (no beforeTool, an aged-out one, another action of the same call
// before the shell action) is left to OpenCode.
//
// `rules` is createOperatorRules' result and `dirOf(sessionID)` the session's
// directory (dirOfSession's, bound to a reducer). A session whose directory is
// unknown is treated as having rules: nothing changes. Not registered on
// OpenCode here (the entry point does).
export function createPermissionHandler(options) {
  const {
    rules = null, dirOf = null, now = Date.now, ttlMs = 30000,
  } = options ?? {};
  const pending = new Map(); // call id -> { command, at }, oldest first

  function clock() {
    try {
      const t = now();
      if (Number.isFinite(t)) return t;
    } catch { /* fall through to the real clock */ }
    return Date.now();
  }

  function expire(t) {
    for (const [id, rec] of pending) {
      if (t - rec.at > ttlMs) pending.delete(id);
      else break; // inserted in time order
    }
  }

  function beforeTool(payload) {
    try {
      if (!payload || typeof payload !== 'object' || payload.tool !== 'shell') return;
      const command = payload.input?.command;
      const id = payload.id;
      if (typeof command !== 'string' || typeof id !== 'string' || !id) return;
      const t = clock();
      expire(t);
      pending.delete(id); // a re-announced call is the newest again
      pending.set(id, { command, at: t });
      if (pending.size > PERMISSION_PENDING_MAX) pending.delete(pending.keys().next().value);
    } catch (e) {
      debug('permission tool', e);
    }
  }

  function evaluate(evaluation) {
    try {
      if (!evaluation || typeof evaluation !== 'object') return;
      if (evaluation.action !== 'shell') return;
      const id = evaluation.source?.id;
      if (typeof id !== 'string' || !id) return;
      expire(clock());
      const rec = pending.get(id);
      if (!rec) return;
      pending.delete(id);
      const resources = evaluation.resources;
      if (!Array.isArray(resources) || resources.length !== 1) return;
      if (resources[0] !== rec.command || !isPlainTmx(rec.command)) return;
      if (evaluation.effect === 'deny' || evaluation.effect === 'allow') return;
      const dir = dirOf(evaluation.sessionID);
      if (typeof dir !== 'string' || !dir) return;
      if (rules.hasBashRules(dir)) return;
      evaluation.effect = 'allow';
    } catch (e) {
      debug('permission', e);
    }
  }

  return { beforeTool, evaluate };
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
// `live` and `registry` are the entry point's (see createRegistry), kept on
// the core so the next hand-over finds them. After every sweep's fold the core gives the part mailTargets' map, or an
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
  live = null,
  registry = null,
  pieces = null,
  hooked = null,
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
        hooked,
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
    dirOfSession: (sessionID) => dirOfSession(reducer, sessionID),
    // The live OpenCode ctxs (createRegistry's `live`, handed over), each
    // ctx's process-wide tagger and handler (`pieces`, R32), this core's
    // registry of hooks on them, and the ctx whose event stream feeds it; all
    // the entry point's.
    live: live instanceof Map ? live : new Map(),
    pieces: adoptPieces(pieces),
    registry,
    attachedCtx: null,
    resyncMail,
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

  // The part re-checks the last sweep's targets now (a directory's hooks
  // just settled, so a target the part skipped may count).
  function resyncMail() {
    if (!mail || aborted || ended) return;
    try {
      mail.sync(targets, reducer.derive);
    } catch (e) {
      debug('mail sync', e);
    }
  }

  // Test seam only (nothing in the plugin calls it): the current mail targets,
  // as a copy, since the part keeps the map it was given.
  function mailTargetsNow() {
    return new Map(targets);
  }

  // R23/R24: the pane of the tmux session whose current mail target is the
  // OpenCode session `sessionID`, or, for a child (a subagent runs inside its
  // root's TUI), the one whose target is the root the parent chain leads to.
  // Null for a session whose chain ends at a root that is no target, reaches a
  // parent the reducer does not know, loops back on itself, or is deeper than
  // MAIL_PARENT_DEPTH_MAX hops; and for a target two tmux sessions claim (no
  // pane to speak for).
  function paneOfSession(sessionID) {
    try {
      if (typeof sessionID !== 'string') return null;
      const seen = new Set();
      let cur = sessionID;
      for (let hops = 0; hops <= MAIL_PARENT_DEPTH_MAX; hops++) {
        if (seen.has(cur)) return null;
        seen.add(cur);
        const claims = [...targets.values()].filter((t) => t.sessionID === cur);
        if (claims.length > 0) return claims.length === 1 ? claims[0].pane : null;
        const parent = reducer.sessions.get(cur)?.parent;
        if (typeof parent !== 'string' || !parent) return null;
        cur = parent;
      }
      return null;
    } catch (e) {
      debug('paneOfSession', e);
      return null;
    }
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
    core.attachedCtx = ctx;
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
// It also disposes `prev`'s registry (every hook it registered on OpenCode),
// once `opts.registry`'s own registrations have settled (R34: an overlap, not
// a gap; at once without one), and inherits its list of live ctxs and their
// pieces unless `opts.live` / `opts.pieces` name them. `opts` are createCore's.
export function takeOver(prev, opts = {}) {
  let written = null;
  let since = null;
  let state = null;
  let mailState = null;
  let live = opts.live instanceof Map ? opts.live : null;
  let pieces = opts.pieces ?? null;
  if (prev && typeof prev === 'object') {
    try { prev.abort(); } catch { /* a foreign or older object */ }
    disposeAfter(prev, opts.registry);
    try {
      if (prev.written instanceof Map) written = prev.written;
      if (prev.since instanceof Map) since = prev.since;
      state = prev.state ?? null;
      mailState = prev.mailState ?? null;
      if (!live && prev.live instanceof Map) live = prev.live;
      if (!pieces) pieces = prev.pieces ?? null;
    } catch { /* a throwing getter: inherit nothing more */ }
  }
  const core = createCore({ ...opts, state, mailState, live, pieces });
  if (written) core.written = written;
  if (since) core.since = since;
  return core;
}

// ---------------------------------------------------------------------------
// The hooks on OpenCode, one directory instance at a time (agent messaging
// spec §6.10, rulings R13, R6, R7, R32, R33, R34).
// ---------------------------------------------------------------------------
//
// OpenCode 2.3.0 sets the plugin up once per project directory in one server
// process, and its ctxs are not alike (test/fixtures/README-opencode-2.3-event-
// trace.md F5): every instance's event stream sees every event, and
// `ctx.session.synthetic` reaches a session of any directory, but
// `tool.execute.before`, `shell.create.before` and `permission.evaluate` fire
// ONLY in the instance whose directory owns the session (fixture lines 935-937
// vs 981-983). So the entry point keeps every live ctx (`live`: directory ->
// ctx, newest setup of a directory wins, at most LIVE_MAX, oldest dropped) on
// the core, where a hand-over finds it, and the core's registry puts the three
// hooks on each:
//
//   ctx.tool.hook('execute.before')      -> that ctx's pane tagger and permission handler
//   ctx.shell.hook('create.before')      -> that ctx's pane tagger
//   ctx.permission.hook('evaluate')      -> that ctx's permission handler
//
// One tagger and one handler per ctx (their command/call correlation is per
// instance, R7), and they are PROCESS-WIDE (R32): `pieces` (ctx -> { tagger,
// handler }, a WeakMap) is handed over with `live`, and every registry reuses
// them. A tagger rebuilt at a hand-over would lose the calls announced before
// it, and then hand one session's shell another session's pane. Both read the
// pane and the directory from the CURRENT global core at call time. A new
// PIECES_VERSION (a reload that changes their shape) starts them afresh.
// One registration per ctx per registry; the pieces' own call-id and env
// guards make an overlap of two registries act once.
//
// Each `hook()` returns `Promise<Registration>` with `dispose()`. dispose() and
// remove(ctx) chain onto those promises (a registration still pending is
// disposed when it arrives) and never wait. A hand-over disposes the old
// registry only once the new one's registrations settled (R34: `settled()`),
// so the hooks overlap rather than gap. A disposed registry registers nothing
// more. Every callback, registration and dispose is wrapped: nothing throws or
// rejects into OpenCode.
//
// Mail only for hooked directories (R33). `isHooked(dir)`: the live ctx of
// `dir` has all three of this registry's registrations settled and not
// disposed. The mail part arms a wait only for a target whose directory is
// hooked (createMailPart's `hooked`), and `onSettled` (each ctx's registrations
// settling) has the core re-check its targets. `synthetic(input)` posts through
// the live ctx of the session's directory (core.dirOfSession of
// input.sessionID) when that directory is hooked, and REJECTS when the
// directory is known but not hooked; only a session whose directory is unknown
// falls back to any live ctx that can post. With none it rejects (the part
// holds off).
//
// The version gate: mail needs `ctx.session.synthetic` and OpenCode
// OPENCODE_MAIL_MIN or newer (`ctx.app.version`, fixture line 1: { name: 'cli',
// version: '2.3.0', channel: 'latest' }). The entry point decides once per core,
// over every live ctx: when one fails, the core has no mail part and no hook is
// registered anywhere; the state markers are written all the same.

// Dispose `prev`'s registry once `next`'s registrations settled, or at once.
function disposeAfter(prev, next) {
  try {
    const old = prev.registry;
    if (!old || typeof old.dispose !== 'function') return;
    let after = null;
    try { after = next?.settled?.(); } catch { /* at once */ }
    const run = () => { try { old.dispose(); } catch (e) { debug('registry dispose', e); } };
    if (after && typeof after.then === 'function') Promise.resolve(after).then(run, run).catch((e) => debug('registry dispose', e));
    else run();
  } catch (e) {
    debug('registry dispose', e);
  }
}

export const OPENCODE_MAIL_MIN = '2.3.0';
const LIVE_MAX = 64;
const VERSION_RE = /^\d{1,9}(?:\.\d{1,9}){0,7}$/;
// The shape of a ctx's pieces ({ tagger, handler }); bump it when it changes.
//
// OBLIGATION (R41): the pieces are closures that outlive a reload. A setup
// rerun hands the existing pieces to the new bytes, so the tagger, the
// permission handler and the operator-rules check (createOperatorRules, made
// lazily inside the handler) keep running the code of the bytes that first
// built them until OpenCode restarts. So ANY later change to the tagger, the
// permission handler or the operator-rules logic must (1) bump PIECES_VERSION,
// so the new bytes build fresh pieces, and (2) first make the tagger's
// tagged-env set process-wide (a Symbol.for global, like GLOBAL_KEY), so the
// old and the new tagger do not both tag one shell during the overlap.
// Otherwise the fix does not apply live.
export const PIECES_VERSION = 1;

// Numeric dotted comparison (2.10.1 > 2.3.0; a missing part is 0). Anything
// that is not digits and dots (a pre-release, a `v`, a blank) counts as below.
export function versionAtLeast(version, min) {
  if (typeof version !== 'string' || !VERSION_RE.test(version) || !VERSION_RE.test(min)) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function mailCapable(ctx) {
  try {
    return typeof ctx?.session?.synthetic === 'function' && versionAtLeast(ctx?.app?.version, OPENCODE_MAIL_MIN);
  } catch {
    return false;
  }
}

// A previous core's pieces when their version matches, else a fresh store.
function adoptPieces(pieces) {
  try {
    if (pieces && typeof pieces === 'object' && pieces.version === PIECES_VERSION && pieces.map instanceof WeakMap) return pieces;
  } catch { /* a throwing getter: fresh */ }
  return { version: PIECES_VERSION, map: new WeakMap() };
}

// The key a ctx is listed under: its directory, else the ctx itself.
function liveKey(ctx) {
  try {
    const dir = ctx.location?.directory;
    if (typeof dir === 'string' && dir) return dir;
  } catch { /* a throwing getter: keyed by itself */ }
  return ctx;
}

function liveAdd(live, ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  for (const [k, v] of live) if (v === ctx) live.delete(k);
  const key = liveKey(ctx);
  live.delete(key); // the newest setup of a directory is the newest entry
  live.set(key, ctx);
  while (live.size > LIVE_MAX) live.delete(live.keys().next().value);
}

function liveRemove(live, ctx) {
  for (const [k, v] of live) if (v === ctx) live.delete(k);
}

export function createRegistry({
  live = new Map(),
  mail = true,
  pieces = null,
  current = () => globalThis[GLOBAL_KEY],
  rules = null,
  onSettled = null,
  now = Date.now,
  ttlMs = 30000,
} = {}) {
  const store = adoptPieces(pieces);
  const regs = new Map(); // ctx -> [Promise<Registration | null>]
  const hooked = new Set(); // ctxs whose three registrations all settled
  let disposed = false;
  let operatorRules = rules;

  function core() {
    try { return current(); } catch { return null; }
  }
  function paneOf(sessionID) {
    const c = core();
    return typeof c?.paneOfSession === 'function' ? c.paneOfSession(sessionID) : null;
  }
  function dirOf(sessionID) {
    const c = core();
    return typeof c?.dirOfSession === 'function' ? c.dirOfSession(sessionID) : null;
  }

  // The ctx's process-wide tagger and handler, made on first use (R32).
  function piecesOf(ctx) {
    let p = store.map.get(ctx);
    if (!p) {
      if (!operatorRules) operatorRules = createOperatorRules();
      p = {
        tagger: createPaneTagger({ paneOf, now, ttlMs }),
        handler: createPermissionHandler({ rules: operatorRules, dirOf, now, ttlMs }),
      };
      store.map.set(ctx, p);
    }
    return p;
  }

  function register(ctx, domain, name, cb) {
    let p;
    try {
      p = Promise.resolve(ctx[domain].hook(name, cb));
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(
      (r) => (r && typeof r.dispose === 'function' ? r : null),
      (e) => {
        debug('hook', domain, name, e);
        return null;
      },
    );
  }

  function notify() {
    if (typeof onSettled !== 'function') return;
    try { onSettled(); } catch (e) { debug('registry settled', e); }
  }

  function add(ctx) {
    try {
      if (disposed || !mail || !ctx || typeof ctx !== 'object' || regs.has(ctx)) return;
      const { tagger, handler } = piecesOf(ctx);
      const onTool = (payload) => {
        try { tagger.beforeTool(payload); } catch (e) { debug('hook tool', e); }
        try { handler.beforeTool(payload); } catch (e) { debug('hook tool', e); }
      };
      const onShell = (payload) => {
        try { tagger.beforeShell(payload); } catch (e) { debug('hook shell', e); }
      };
      const onEvaluate = (evaluation) => {
        try { handler.evaluate(evaluation); } catch (e) { debug('hook evaluate', e); }
      };
      const list = [
        register(ctx, 'tool', 'execute.before', onTool),
        register(ctx, 'shell', 'create.before', onShell),
        register(ctx, 'permission', 'evaluate', onEvaluate),
      ];
      regs.set(ctx, list);
      Promise.all(list).then((rs) => {
        if (disposed || regs.get(ctx) !== list) return;
        if (rs.every((r) => r !== null)) {
          hooked.add(ctx);
          notify();
        }
      }).catch((e) => debug('registry settle', e));
    } catch (e) {
      debug('registry add', e);
    }
  }

  function addAll() {
    try {
      for (const ctx of [...live.values()]) add(ctx);
    } catch (e) {
      debug('registry add', e);
    }
  }

  // Resolves once every registration made so far has settled; never rejects.
  function settled() {
    try {
      return Promise.allSettled([...regs.values()].flat()).then(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  function release(list) {
    for (const p of list) {
      p.then((r) => (r ? r.dispose() : undefined)).catch((e) => debug('hook dispose', e));
    }
  }

  function remove(ctx) {
    try {
      hooked.delete(ctx);
      const list = regs.get(ctx);
      if (!list) return;
      regs.delete(ctx);
      release(list);
    } catch (e) {
      debug('registry remove', e);
    }
  }

  function dispose() {
    try {
      disposed = true;
      hooked.clear();
      for (const list of regs.values()) release(list);
      regs.clear();
    } catch (e) {
      debug('registry dispose', e);
    }
  }

  function isHooked(dir) {
    try {
      if (disposed || typeof dir !== 'string' || !dir) return false;
      const ctx = live.get(dir);
      return !!ctx && hooked.has(ctx);
    } catch {
      return false;
    }
  }

  function synthetic(input) {
    try {
      let dir = null;
      try { dir = dirOf(input?.sessionID); } catch { /* unknown */ }
      let ctx;
      if (typeof dir === 'string' && dir) {
        ctx = live.get(dir);
        if (!isHooked(dir) || !mailCapable(ctx)) return Promise.reject(new Error('the session\'s directory has no hooked OpenCode instance'));
      } else {
        ctx = [...live.values()].find(mailCapable);
        if (!ctx) return Promise.reject(new Error('no live OpenCode instance can post a wake'));
      }
      return Promise.resolve(ctx.session.synthetic(input));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  return { live, pieces: store, add, addAll, remove, dispose, settled, isHooked, synthetic };
}

// Build the next core over `live` (which already lists `ctx`), take over from
// `prev`, publish it, and feed it `ctx`'s event stream. The registry registers
// on every live ctx before takeOver, so takeOver can dispose the old one once
// these settled (R34); the hooks read the global core only when they fire,
// and nothing fires before this returns.
function install(prev, live, ctx) {
  let pieces = null;
  try { pieces = prev?.pieces ?? null; } catch { /* a foreign object */ }
  pieces = adoptPieces(pieces);
  const mail = live.size > 0 && [...live.values()].every(mailCapable);
  let core = null;
  const registry = createRegistry({
    live,
    mail,
    pieces,
    onSettled: () => { if (core && globalThis[GLOBAL_KEY] === core) core.resyncMail(); },
  });
  registry.addAll();
  core = takeOver(prev, {
    live,
    pieces,
    registry,
    synthetic: mail ? (input) => registry.synthetic(input) : null,
    hooked: mail ? (dir) => registry.isHooked(dir) : null,
  });
  globalThis[GLOBAL_KEY] = core;
  core.attach(ctx).catch((e) => debug('attach', e));
  return core;
}

// The OpenCode V2 entry point. OpenCode sets the plugin up once per project
// directory in one long-lived server and reloads a rewritten plugin file
// without necessarily cleaning up the old instance (facts 1-3), so the core
// is a process-wide singleton: every setup takes over from whichever core
// holds the global and becomes the owner, attached to its own ctx's stream.
//
// Every setup lists its ctx in the live ctxs it inherits, decides the mail
// gate over all of them, and has the new core register on every live ctx. A
// cleanup takes its ctx off the list and its hooks off OpenCode, whichever
// core owns the global. The cleanup of the ctx the owner is attached to hands
// over to a new core attached to the newest remaining live ctx (R33); only
// when none remains does everything stop.
export default {
  id: 'tmuxifier-agent',
  async setup(ctx) {
    try {
      const prev = globalThis[GLOBAL_KEY];
      let live = null;
      try { if (prev?.live instanceof Map) live = prev.live; } catch { /* a foreign object */ }
      if (!live) live = new Map();
      liveAdd(live, ctx);
      install(prev, live, ctx);
    } catch (e) {
      debug('setup', e);
    }
    return async function cleanup() {
      try {
        const owner = globalThis[GLOBAL_KEY];
        if (!owner || typeof owner !== 'object') return;
        let live = null;
        try { if (owner.live instanceof Map) live = owner.live; } catch { /* a foreign object */ }
        if (live) liveRemove(live, ctx);
        try { owner.registry?.remove?.(ctx); } catch { /* a foreign object */ }
        if (owner.attachedCtx !== ctx || !('attachedCtx' in owner)) return;
        if (live && live.size > 0) {
          install(owner, live, [...live.values()].pop());
          return;
        }
        owner.abort();
        owner.clear();
        try { owner.registry?.dispose(); } catch { /* never surfaces */ }
        delete globalThis[GLOBAL_KEY];
      } catch (e) {
        debug('cleanup', e);
      }
    };
  },
};
