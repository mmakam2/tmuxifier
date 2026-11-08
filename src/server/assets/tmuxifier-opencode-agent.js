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
//    names the directory before `execution.started`.
//
// Clock: an event's own `created` (ms) when present, else the injected
// `now()`; every `ts` here is epoch SECONDS, the sh hook's unit.

// ---------------------------------------------------------------------------
// The pure reducer: OpenCode events -> per-OpenCode-session derived state.
// ---------------------------------------------------------------------------

const SEEN_MAX = 5000;
const HINT_MAX = 500;

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

export function createReducer({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const sessions = new Map();
  const seenIds = new Set();
  // sessionID -> { dir, lastInbox } from inbox items of sessions not (yet)
  // known: a resumed session (`opencode -c`) has no session.created, and its
  // execution.started carries no directory, so its first inbox item is the
  // only place its directory is named (fact 7).
  const hints = new Map();
  const reducer = { sessions, seenIds, apply, derive };

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

    if (!RELEVANT.has(type)) {
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

// The `tmux list-panes -a -F` argument parsePanes reads.
export const PANE_FORMAT = '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}';

const PANES_MAX = 500;
const NAME_MAX = 256;
const PATH_MAX = 4096;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

// tmux output is box output: untrusted. Rows with the wrong field count, any
// C0 control or DEL, an empty or over-long name or path are dropped, never
// repaired; only the active pane of the active window survives.
export function parsePanes(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (out.length >= PANES_MAX) break;
    const f = line.split('\t');
    if (f.length !== 5) continue;
    const [session, windowActive, paneActive, cmd, path] = f;
    if (windowActive !== '1' || paneActive !== '1') continue;
    if (!session || session.length > NAME_MAX || CONTROL_RE.test(session)) continue;
    if (cmd.length > NAME_MAX || CONTROL_RE.test(cmd)) continue;
    if (!path || path.length > PATH_MAX || CONTROL_RE.test(path)) continue;
    out.push({ session, cmd, path });
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

const RANK = { blocked: 3, working: 2, ready: 1 };

// tmux session -> { state, cause, ts } for every opencode pane. Candidates are
// root sessions (children roll up into their parent) in the pane's directory
// whose ts is not older than `since` (the moment this tmux session's active
// pane became opencode, seconds), which keeps a previous TUI's finished turns
// from making a relaunch read done. blocked > working > ready, ties to the
// newest ts; the written ts is the chosen session's own, not the fold time.
// No candidate: ready/start at `since` (else `now`, seconds).
export function foldForPanes(reducer, panes, since = new Map(), now = Math.floor(Date.now() / 1000)) {
  const roots = [];
  for (const s of reducer.sessions.values()) {
    if (s.parent !== null || !s.dir) continue;
    const d = reducer.derive(s.id);
    if (d && RANK[d.state]) roots.push({ dir: s.dir, d });
  }
  const out = new Map();
  for (const pane of panes) {
    if (!isOpencodeCmd(pane.cmd)) continue;
    const floor = since.get(pane.session);
    let best = null;
    for (const { dir, d } of roots) {
      if (d.ts < (floor ?? 0) || !dirMatches(dir, pane.path)) continue;
      if (!best || RANK[d.state] > RANK[best.state] || (RANK[d.state] === RANK[best.state] && d.ts > best.ts)) best = d;
    }
    out.set(pane.session, best
      ? { state: best.state, cause: best.cause, ts: best.ts }
      : { state: 'ready', cause: 'start', ts: floor ?? now });
  }
  return out;
}

// The marker the sh hook writes: `<tmux-session>:<state>:<epoch>:<cause>`.
export function markerLine(tmuxSession, fold) {
  return `${tmuxSession}:${fold.state}:${fold.ts}:${fold.cause}\n`;
}
