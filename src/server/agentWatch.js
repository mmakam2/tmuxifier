import fs from 'node:fs';

// Real-time agent state, box -> server.
//
// Agent state lives in marker files on the box (~/.tmuxifier-agent/<session>,
// written by the Claude hook, the OpenCode plugin or the OSC reporter) and the
// server learns it from the status probe, once per statusPollMs. A prompt that
// is answered between two sweeps was never seen, and a push could lag by a
// whole interval. This module closes that gap with one resident ssh channel
// per reachable box, multiplexed over the ControlMaster the probe already
// keeps: a small loop that says "something changed" and nothing else.
//
// The stream is a TRIGGER, not a data path. Its whole vocabulary is two
// one-letter lines — `c` (a marker changed) and `h` (still here) — and a `c`
// only makes the server run its own allowlisting probe (statusPoller.
// refreshAgents). Nothing a box prints here is ever parsed into state, so the
// "box output is untrusted" rule needs no new parser: the worst a hostile box
// can do is ask to be probed, and that is rate-limited below.
//
// Nothing is installed on the box and no setup rerun is needed: the loop is the
// ssh remote command itself, like the probe.
//
// Known cost: the stream holds one session on the box's multiplexed connection
// for as long as it lives, and sshd allows `MaxSessions` (default 10) per
// connection. Terminals, probes, uploads and Fleet runs share that budget, so a
// box with eight viewers attached has one slot less than it used to. When the
// connection is full, ssh does not fail: it says "Session open refused by peer"
// and quietly opens a connection of its own, so a refused stream would sit on
// a private TCP connection for good and every probe behind it would pay a
// fresh handshake. Seeing that message — on the stream's own stderr, or
// reported by the light probe through yield() — drops the box's stream and
// holds it for a few minutes, handing the slot back. Agent state for that box
// rides the sweep meanwhile.

const TICK_MAX = 60;
const BEAT_MAX = 100000;

// The loop, as POSIX sh. It runs under `sh`, not the login shell: an unmatched
// glob is an error in zsh, and zsh does not word-split. Per tick it forks at
// most `head` and `sleep`.
//   - Only regular files directly in the marker directory are read, each capped
//     at 200 bytes: the same files and the same cap as the probe's AGENT_PROBE.
//     `[ -f ]` is load-bearing — reading a FIFO would block the loop forever,
//     and since a blocked loop never writes it would never notice its reader
//     had gone, leaving one stuck process on the box per restart.
//   - The signature is the marker CONTENT, so a rewrite with identical text is
//     not a change, and busy tokens / block owners (subdirectories) are not
//     watched: neither can alter the displayed state.
//   - It reports once at start, so whatever changed while no stream was up is
//     picked up the moment one is.
//   - It beats every `beatTicks` ticks. The beat is what ends an orphan: with no
//     PTY the loop gets no SIGHUP when the ssh channel closes, it only finds out
//     when a write fails. It is also the server's proof the stream is not hung.
// The two numbers are the only interpolation and are integer-checked.
export function buildWatchScript({ tickSec = 1, beatTicks = 20 } = {}) {
  if (!Number.isInteger(tickSec) || tickSec < 1 || tickSec > TICK_MAX) throw new Error('invalid tickSec');
  if (!Number.isInteger(beatTicks) || beatTicks < 1 || beatTicks > BEAT_MAX) throw new Error('invalid beatTicks');
  return [
    'd="$HOME/.tmuxifier-agent"; first=1; last=; n=0;',
    'while :; do',
    'set --; for f in "$d"/*; do [ -f "$f" ] && set -- "$@" "$f"; done;',
    'cur=; if [ "$#" -gt 0 ]; then cur=$(head -c 200 "$@" 2>/dev/null); fi;',
    'if [ "$first" = 1 ] || [ "$cur" != "$last" ]; then first=0; last=$cur; n=0; echo c || exit 0; fi;',
    `n=$((n+1)); if [ "$n" -ge ${beatTicks} ]; then n=0; echo h || exit 0; fi;`,
    `sleep ${tickSec} || exit 0;`,
    'done',
  ].join(' ');
}

// The script contains no single quote (pinned by a test), so one pair wraps it
// for whatever login shell runs the remote command.
export const WATCH_REMOTE = `exec sh -c '${buildWatchScript()}'`;

// Longest partial line kept between chunks. A real line is one character.
const LINE_MAX = 64;

// ssh's own words when the multiplexed connection has no session slot left.
export const MUX_REFUSED_RE = /Session open refused by peer/i;
// How much stderr is remembered to match that across chunk boundaries.
const STDERR_TAIL = 512;

// Serialises a box's refreshes: one at a time, starts at least `minGapMs`
// apart, and a request that arrives while one runs is folded into exactly one
// rerun afterwards. The rerun matters — the running probe may have read the
// markers before the change that asked for it.
function createTrigger({ run, minGapMs, now, setTimeoutFn, clearTimeoutFn }) {
  let running = false;
  let pending = false;
  let timer = null;
  let lastStart = -Infinity;
  let dead = false;
  function start() {
    running = true;
    pending = false;
    lastStart = now();
    Promise.resolve()
      .then(run)
      .catch(() => { /* a failed refresh is the sweep's to repair */ })
      .finally(() => {
        running = false;
        if (pending && !dead) fire();
      });
  }
  function fire() {
    if (dead) return;
    if (running || timer) { pending = true; return; }
    const wait = lastStart + minGapMs - now();
    if (wait <= 0) { start(); return; }
    timer = setTimeoutFn(() => { timer = null; if (!dead) start(); }, wait);
    timer?.unref?.();
  }
  return {
    fire,
    stop() {
      dead = true;
      if (timer) { clearTimeoutFn(timer); timer = null; }
    },
  };
}

// What identifies the machine a stream is attached to. A box edited to a new
// address keeps its id, and its old stream would go on reporting for the wrong
// host.
const sigOf = (box) => JSON.stringify([box.host ?? null, box.user ?? null, box.port ?? null, box.proxyJump ?? null]);

// One resident watch stream per reachable box.
//   spawnStream(box, { onData }) -> { done: Promise, kill() }   (sshStream)
//   onChange(boxId) -> Promise                                   (the refresh)
// `sync` is called after every status sweep and is the only place streams start
// or stop, so the connection rate is bounded by the sweep the fleet already
// tolerates: at most one extra ssh exec per box per sweep, and none at all
// while the stream is healthy.
export function createAgentWatch({
  spawnStream, onChange,
  // No line for this long means the stream is hung (a black-holed connection
  // that TCP has not noticed): beats come every 20 s.
  staleMs = 75000,
  minGapMs = 1000,
  // A stream that dies young (no `sh`, no `head`, a refused channel) is held
  // off for retryBaseMs, doubling per consecutive failure up to retryCapMs.
  retryBaseMs = 30000, retryCapMs = 30 * 60 * 1000, healthyMs = 60000,
  // How long a box is left alone after its connection was found saturated.
  yieldMs = 5 * 60 * 1000,
  now = () => Date.now(),
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) {
  const watchers = new Map(); // boxId -> entry
  const holds = new Map();    // boxId -> { fails, until }
  let closed = false;         // stopAll() is final: a late sync starts nothing

  function failed(boxId) {
    const fails = (holds.get(boxId)?.fails ?? 0) + 1;
    holds.set(boxId, { fails, until: now() + Math.min(retryBaseMs * 2 ** (fails - 1), retryCapMs) });
  }

  function feed(entry, chunk) {
    if (entry.stopped) return;
    const parts = (entry.buf + chunk).split('\n');
    const tail = parts.pop();
    entry.buf = tail.length > LINE_MAX ? '' : tail;
    let changed = false;
    let alive = false;
    for (const line of parts) {
      if (line === 'c') { changed = true; alive = true; } else if (line === 'h') alive = true;
    }
    if (alive) entry.lastBeat = now();
    if (changed) entry.trigger.fire();
  }

  function stop(boxId, entry) {
    entry.stopped = true;
    entry.trigger.stop();
    if (watchers.get(boxId) === entry) watchers.delete(boxId);
    try { entry.handle?.kill(); } catch { /* already gone */ }
  }

  // Give the box its session slot back and leave it alone for a while.
  function yieldBox(boxId) {
    const entry = watchers.get(boxId);
    if (entry) stop(boxId, entry);
    holds.set(boxId, { fails: holds.get(boxId)?.fails ?? 0, until: now() + yieldMs });
  }

  function start(box) {
    const boxId = box.id;
    const entry = {
      sig: sigOf(box), buf: '', err: '', stopped: false, handle: null,
      startedAt: now(), lastBeat: now(),
      trigger: createTrigger({ run: () => onChange(boxId), minGapMs, now, setTimeoutFn, clearTimeoutFn }),
    };
    try {
      entry.handle = spawnStream(box, {
        onData: (chunk, stream) => {
          if (stream === 'stdout') { feed(entry, String(chunk)); return; }
          // stderr is never a report. It is read for one thing only.
          if (entry.stopped) return;
          entry.err = (entry.err + String(chunk)).slice(-STDERR_TAIL);
          if (MUX_REFUSED_RE.test(entry.err)) yieldBox(boxId);
        },
      });
    } catch {
      entry.trigger.stop();
      failed(boxId);
      return;
    }
    watchers.set(boxId, entry);
    Promise.resolve(entry.handle.done).catch(() => {}).then(() => {
      // A stream we stopped ourselves (box down, removed, re-addressed, hung)
      // is not a failure of the box's ability to run the loop.
      if (entry.stopped) return;
      entry.stopped = true;
      entry.trigger.stop();
      if (watchers.get(boxId) === entry) watchers.delete(boxId);
      if (now() - entry.startedAt < healthyMs) failed(boxId);
      else holds.delete(boxId);
    });
  }

  return {
    // boxes: the store's list; snapshot: the sweep's result keyed by box id.
    sync(boxes, snapshot) {
      if (closed) return;
      const want = new Map();
      for (const b of boxes || []) {
        const s = snapshot?.[b.id];
        if (s && s.reachable && !s.needsAuth) want.set(b.id, b);
      }
      for (const [id, entry] of [...watchers]) {
        const b = want.get(id);
        if (!b || sigOf(b) !== entry.sig || now() - entry.lastBeat > staleMs) stop(id, entry);
      }
      for (const [id, b] of want) {
        if (watchers.has(id)) continue;
        const hold = holds.get(id);
        if (hold && now() < hold.until) continue;
        start(b);
      }
      const known = new Set((boxes || []).map((b) => b.id));
      for (const id of [...holds.keys()]) if (!known.has(id)) holds.delete(id);
    },
    // The light probe saw the box's connection refuse a session.
    yield(boxId) { if (!closed) yieldBox(boxId); },
    stopAll() {
      closed = true;
      for (const [id, entry] of [...watchers]) stop(id, entry);
      holds.clear();
    },
    size: () => watchers.size,
  };
}

// The Host Shell has no ssh channel: its markers are this machine's own files,
// so the directory is watched directly. `ensure()` is called after every sweep
// — the directory does not exist until the hook first runs, and a watch dies
// with the directory it was on. Events are debounced (one marker write is a
// temp file plus a rename) and then serialised like a box's: the Host Shell
// sampler runs a python sweep first and easily outlasts the debounce, so
// without the trigger two refreshes would overlap.
//
// A directory fd is held for as long as the watch lives. It is how `ensure()`
// tells a directory that was removed and recreated — same path, different
// directory, and a watch that will never fire again — from the one it is
// watching: while the fd is open the old inode number cannot be reused.
export function createLocalMarkWatch({
  dir, onChange, debounceMs = 250, minGapMs = 1000, watch = fs.watch,
  now = () => Date.now(),
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) {
  let watcher = null;
  let fd = null;
  let timer = null;
  const trigger = createTrigger({ run: () => onChange(), minGapMs, now, setTimeoutFn, clearTimeoutFn });
  function release() {
    if (timer) { clearTimeoutFn(timer); timer = null; }
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } fd = null; }
  }
  // True while `dir` is still the directory the watch was put on.
  function same() {
    if (!watcher || fd === null) return false;
    try {
      const mine = fs.fstatSync(fd);
      const there = fs.statSync(dir);
      return mine.nlink > 0 && mine.ino === there.ino && mine.dev === there.dev;
    } catch {
      return false;
    }
  }
  function onEvent() {
    if (!same()) { release(); return; }
    if (timer) return;
    timer = setTimeoutFn(() => { timer = null; trigger.fire(); }, debounceMs);
    timer?.unref?.();
  }
  return {
    ensure() {
      if (same()) return true;
      release();
      try {
        fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        const w = watch(dir, { persistent: false }, onEvent);
        w.on('error', () => { if (watcher === w) release(); });
        watcher = w;
        return true;
      } catch {
        release();
        return false;
      }
    },
    close() {
      release();
      trigger.stop();
    },
  };
}
