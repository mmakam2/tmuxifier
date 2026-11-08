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
    cause: 'prompt',
    blocks: new Map(),
    shells: new Set(),
    lastInbox: null,
    ts: 0,
  };
}

// Derived state of one session (spec §4.1): blocked if it or any child is
// blocked; else working if it is executing, holds a running shell, or has a
// working child; else ready/stop. Children are sessions whose `parent` is
// this one; `visiting` keeps a malformed parent cycle from recursing forever.
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
  return { state: 'ready', cause: 'stop' };
}

export function createReducer({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const sessions = new Map();
  const seenIds = new Set();
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
    if (type === 'session.deleted' && !sessions.has(sid)) return false;

    const ts = typeof event.created === 'number' ? Math.floor(event.created / 1000) : now();
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
