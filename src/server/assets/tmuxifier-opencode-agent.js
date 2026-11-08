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
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
export const STATE_VERSION = 1;

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
  // sessionID -> { dir, lastInbox } from inbox items of sessions not (yet)
  // known: a resumed session (`opencode -c`) has no session.created, and its
  // execution.started carries no directory, so its first inbox item is the
  // only place its directory is named (fact 7).
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

  function hint(sid, dir, kind) {
    const prev = hints.get(sid);
    hints.delete(sid);
    hints.set(sid, {
      dir: prev?.dir ?? dir,
      lastInbox: kind === 'user' || kind === 'synthetic' ? kind : prev?.lastInbox ?? null,
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
      if (type === 'session.inbox.enqueued') hint(sid, dir, data.item?.type);
      return false;
    }

    const ts = Number.isFinite(event.created) ? Math.floor(event.created / 1000) : now();
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
        break;
      }
      case 'session.execution.started':
        s.executing = true;
        s.started = true;
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
export const PANE_FORMAT = '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}';

const PANES_MAX = 500;
const NAME_MAX = 256;
const PATH_MAX = 4096;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

// tmux output is box output: untrusted. Rows with the wrong field count, any
// C0 control or DEL, an empty or over-long name or path are dropped, never
// repaired. Every surviving row is kept, `active` marking the active pane of
// the active window (hosting needs the others).
export function parsePanes(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (out.length >= PANES_MAX) break;
    const f = line.split('\t');
    if (f.length !== 5) continue;
    const [session, windowActive, paneActive, cmd, path] = f;
    if (!session || session.length > NAME_MAX || CONTROL_RE.test(session)) continue;
    if (cmd.length > NAME_MAX || CONTROL_RE.test(cmd)) continue;
    if (!path || path.length > PATH_MAX || CONTROL_RE.test(path)) continue;
    out.push({ session, cmd, path, active: windowActive === '1' && paneActive === '1' });
  }
  return out;
}

// The TUI's #{pane_current_command}; the server's agentKindOf uses the same rule.
export function isOpencodeCmd(cmd) {
  return typeof cmd === 'string' && /^opencode(-|$)/.test(cmd);
}

const trimSlash = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

// Same directory, or one under the other (a TUI started in a subdirectory of
// the project it reports). `/` matches only itself, never everything below it.
export function dirMatches(dir, panePath) {
  if (typeof dir !== 'string' || typeof panePath !== 'string' || !dir || !panePath) return false;
  const d = trimSlash(dir);
  const p = trimSlash(panePath);
  return d === p || p.startsWith(d + '/') || d.startsWith(p + '/');
}

// blocked > working > ready/stop > ready/start: a fresh session that has not
// started yet must never hide a finished, possibly unseen turn in the same
// directory (fixture lines 336-342).
const rankOf = (d) => (d.state === 'blocked' ? 4 : d.state === 'working' ? 3
  : d.state === 'ready' ? (d.cause === 'start' ? 1 : 2) : 0);

// tmux session -> { state, cause, ts } for every active opencode pane (a tmux
// session that reads opencode). Candidates are root sessions (children roll
// up into their parent) in the pane's directory whose ts is not older than
// `since` (the moment this tmux session started hosting opencode, seconds),
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
    let best = null;
    for (const c of roots) {
      if (c.d.ts < (floor ?? 0) || !dirMatches(c.dir, pane.path)) continue;
      if (!best || c.rank > best.rank || (c.rank === best.rank && c.d.ts > best.d.ts)) best = c;
    }
    out.set(pane.session, best
      ? { state: best.d.state, cause: best.d.cause, ts: best.d.ts }
      : { state: 'ready', cause: 'start', ts: floor ?? now });
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

// `tmux list-panes -a` for every pane of every session. null on ENOENT (no
// tmux on PATH: the core stays inert), a timeout, a non-zero exit or
// non-string output; never rejects. `file`/`timeout` exist for tests.
export function defaultListPanes({ file = 'tmux', timeout = LIST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, ['list-panes', '-a', '-F', PANE_FORMAT],
        { timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20, encoding: 'utf8', windowsHide: true },
        (err, stdout) => resolve(!err && typeof stdout === 'string' ? stdout : null));
    } catch {
      resolve(null);
    }
  });
}

export const GLOBAL_KEY = Symbol.for('tmuxifier.opencode-agent');

// One live reporter: a reducer fed by the event stream, and a sweep that
// lists panes and writes the folded markers. `written` (marker name -> the
// content this core last wrote), `since` (tmux session -> epoch seconds it
// started hosting opencode) and `state` (the reducer's, see STATE_VERSION)
// are plain properties so a hand-over can pass them on to the next core;
// `state` (a previous core's) seeds this core's reducer.
export function createCore({
  home = os.homedir(),
  listPanes = defaultListPanes,
  now = () => Math.floor(Date.now() / 1000),
  sweepMs = SWEEP_MS,
  paneCacheMs = PANE_CACHE_MS,
  setInterval: startTimer = globalThis.setInterval,
  clearInterval: stopTimer = globalThis.clearInterval,
  state = null,
} = {}) {
  const reducer = createReducer({ now, state });
  const controller = new AbortController();
  const dir = path.join(home, '.tmuxifier-agent');
  let aborted = false;
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
    owner: Symbol('tmuxifier.opencode-agent.core'),
  };

  // { text, listAt }: the listing (null when unusable) and now() taken just
  // before it was requested.
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
    if (typeof text !== 'string') text = null;
    const result = { text, listAt };
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
    const { text, listAt } = await listing();
    if (aborted || text === null) return; // handed over, or tmux unusable: touch nothing
    // A tmux session that starts hosting opencode in this listing did so after
    // the previous listing, the last one that showed it not hosting: that is
    // its `since`. Stamping this sweep's own time instead would exclude a
    // TUI's whole first turn whenever the listing is slower than the turn's
    // start (`ts >= since`). A core's first sweep has no previous listing.
    const sinceFloor = lastListAt ?? listAt - 2;
    lastListAt = listAt;
    try {
      const panes = parsePanes(text);
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
    }
  }

  // At most one sweep in flight; any request made meanwhile reruns it once
  // after. The returned promise settles when the rerun is done too; it never
  // rejects.
  function sweep() {
    if (inflight) {
      rerun = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          rerun = false;
          await sweepOnce();
        } while (rerun && !aborted);
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
    if (changed && !aborted) await sweep();
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
    // the timer, never re-subscribe, and keep written/since for a hand-over.
    if (!aborted) {
      debug('event stream ended; sweeps stopped until the next setup');
      stopSweeping();
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
// for a new one; an incompatible STATE_VERSION starts fresh). `opts` are
// createCore's.
export function takeOver(prev, opts = {}) {
  let written = null;
  let since = null;
  let state = null;
  if (prev && typeof prev === 'object') {
    try { prev.abort(); } catch { /* a foreign or older object */ }
    try {
      if (prev.written instanceof Map) written = prev.written;
      if (prev.since instanceof Map) since = prev.since;
      state = prev.state ?? null;
    } catch { /* a throwing getter: inherit nothing more */ }
  }
  const core = createCore({ ...opts, state });
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
