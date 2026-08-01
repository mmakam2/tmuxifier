import nodePty from 'node-pty';
import { buildAttachArgv, buildProvisionArgv } from './sshCommand.js';

// The PTY key an interactive setup finish runs under. Shared rather than spelled
// out at each call site: the probe/Fleet guards have to recognise this key, and a
// second spelling of it is how they came to miss it (B8, 2026-07-29 review).
export const provisionKey = (boxId) => `provision:${boxId}`;

// Every viewer of a box gets its OWN key, and therefore its own ssh and its own
// `tmux attach`. Keying by box id alone made Tmuxifier a mirror rather than a
// multiplexer: one screen drawn at one size, fanned out to every browser, with
// whichever client resized last deciding that size. A viewer whose window was
// smaller than it then received cursor moves past its own last row and column,
// which is the smeared and duplicated text a multi-machine setup reports. (The
// other direction is harmless — a viewer wider than the stream shows margin.)
// With one attach per viewer, tmux itself does the sizing, per client.
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// The id only ever becomes a Map key — it never reaches a shell — but it comes
// from the browser, so it is bounded and charset-checked all the same. Anything
// unusable collapses onto one shared id, which is exactly the old behaviour: a
// stale cached bundle that sends no id keeps working (sharing a PTY, as before)
// instead of minting a fresh ssh on every reconnect.
export const safeClientId = (raw) => (CLIENT_ID.test(String(raw ?? '')) ? String(raw) : 'shared');
export const terminalKey = (boxId, clientId) => `term:${boxId}:${safeClientId(clientId)}`;
export const localKey = (clientId) => `local:${safeClientId(clientId)}`;

// The group a PTY belongs to: a box id for terminals and provisions, this
// constant for the host's own shell. Callers act on groups ("drop this box's
// terminals", "is any login live for this box?") because a single box now spans
// several keys.
export const LOCAL_GROUP = '__local__';

export function createSessionManager({ hostKeyPolicy = 'accept-new', graceSeconds = 45, spawnEnv = process.env, sshConfigFile, controlDir, controlPersist, localSession = 'local', maxViewersPerBox = 8, spawn = nodePty.spawn } = {}) {
  const entries = new Map(); // key -> entry

  // Bytes of recent PTY output kept per session so a reattaching client gets the
  // current screen (e.g. a password prompt) replayed instead of a blank terminal.
  const REPLAY_MAX = 64 * 1024;
  // Strip terminal *queries* — Device Attributes (CSI … c) and Device Status
  // Report (CSI … n) — from REPLAYED output only. The program that issued the
  // query is long gone, so replaying it just makes the client's emulator answer
  // (e.g. "\x1b[>0;276;0c") and that answer gets injected as keystrokes into the
  // shell. Live output keeps its queries so the asking program still gets a reply.
  const QUERY_RE = /\x1b\[[?>=]?[0-9;]*[cn]/g;
  // Prefixed to the replay so it rebuilds a BLANK screen. A reattaching client
  // is usually a dropped WebSocket coming back inside the grace window, and its
  // emulator was never cleared — it still holds the screen it drew. Writing the
  // buffer over that re-runs the window's scrolls and absolute cursor moves on
  // top of the cells they already produced, which is duplicated lines and
  // characters landing in the wrong columns. It also strands the client's own
  // "[disconnected…]"/"[connecting…]" notices in the pane, which tmux's redraw
  // does not reliably paint over (it only repaints cells tmux thinks changed).
  // The SGR reset leads and is load-bearing: CSI 2J fills with the CURRENT
  // background colour, so clearing while the client still carries a full-screen
  // program's background would flood the terminal instead of blanking it.
  const REPLAY_CLEAR = '\x1b[0m\x1b[H\x1b[2J';
  function pipeOutput(entry) {
    entry.pty.onData((d) => {
      entry.buffer = (entry.buffer + d).slice(-REPLAY_MAX);
      for (const fn of entry.listeners) {
        try { fn(d); } catch { /* listener error must not break the fan-out */ }
      }
    });
  }

  function open({ key, box, session, size }) {
    const existing = entries.get(key);
    if (existing && !existing.exited) {
      if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
      return existing;
    }
    // `|| key` keeps a caller that has no box id (only tests) grouped under its
    // own key, so a missing id can never silently merge two boxes into one
    // group. Every real caller passes a stored box, which always has an id.
    const group = box?.id || key;
    // A viewer id is browser-supplied and each new one costs a real ssh process
    // and a real tmux client, so the count is bounded. Checked only past the
    // reuse branch above: a viewer already holding a PTY must always be able to
    // reconnect, even once the cap is reached.
    assertViewerRoom(group);
    const argv = buildAttachArgv(box, session, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
    const pty = spawn('ssh', argv, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, group, kind: 'terminal', pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false, buffer: '' };
    pipeOutput(entry);
    pty.onExit(() => {
      entry.exited = true;
      if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
      if (entries.get(key) === entry) entries.delete(key);
      for (const cb of entry.exitCbs) cb();
    });
    entries.set(key, entry);
    return entry;
  }

  function openLocal({ key, shell, size }) {
    const existing = entries.get(key);
    if (existing && !existing.exited) {
      if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
      return existing;
    }
    // `-u` forces UTF-8 client output so glyphs survive a C/POSIX locale (see the
    // same flag and rationale in buildAttachArgv).
    // No `-D` — see buildAttachArgv. The host's own shell is viewable from
    // several machines too, and it has the same one-screen-per-viewer need.
    const args = ['-u', 'new-session', '-A', '-s', localSession];
    if (shell === 'omz') args.push('exec zsh');
    else if (shell === 'omb') args.push('exec bash');
    const pty = spawn('tmux', args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, group: LOCAL_GROUP, kind: 'local', pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false, buffer: '' };
    pipeOutput(entry);
    pty.onExit(() => {
      entry.exited = true;
      if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
      if (entries.get(key) === entry) entries.delete(key);
      for (const cb of entry.exitCbs) cb();
    });
    entries.set(key, entry);
    return entry;
  }

  function provision({ key, box, script }) {
    const existing = entries.get(key);
    if (existing && !existing.exited) {
      if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
      return existing;
    }
    const argv = buildProvisionArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
    const pty = spawn('ssh', argv, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, group: box?.id || key, kind: 'provision', pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false, exitCode: null, buffer: '' };
    pipeOutput(entry);
    pty.onExit(({ exitCode }) => {
      entry.exited = true;
      entry.exitCode = exitCode;
      if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
      if (entries.get(key) === entry) entries.delete(key);
      for (const cb of entry.exitCbs) cb();
    });
    entries.set(key, entry);
    return entry;
  }

  function attach(entry, onData) {
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
    // Replay recent output so a (re)attaching client sees the current screen —
    // e.g. a password prompt from a session opened before this client connected —
    // instead of a blank terminal until the next keystroke.
    if (entry.buffer) {
      const replay = entry.buffer.replace(QUERY_RE, '');
      if (replay) { try { onData(REPLAY_CLEAR + replay); } catch { /* ignore */ } }
    }
    entry.listeners.add(onData);
    if (!entry.exited) {
      // node-pty's resize() mutates the size its getters report, so capture the
      // real width first — reading pty.cols again after the shrink would
      // "restore" to the shrunken value and ratchet the PTY narrower forever.
      try {
        const { cols, rows } = entry.pty;
        entry.pty.resize(cols === 1 ? 2 : cols - 1, rows);
        entry.pty.resize(cols, rows);
      } catch {}
    }
    return () => entry.listeners.delete(onData);
  }
  function onExit(entry, cb) { entry.exitCbs.add(cb); return () => entry.exitCbs.delete(cb); }
  function write(entry, data) { if (!entry.exited) entry.pty.write(data); }
  function resize(entry, { cols, rows }) {
    if (!entry.exited) { try { entry.pty.resize(Math.min(cols, 1000), Math.min(rows, 1000)); } catch {} }
  }
  // Deletions below check identity, not just the key: a grace timer (or a
  // straggling close()) can outlive its entry when the PTY exits on its own and
  // the client reopens the box — deleting blindly by key would evict the NEW
  // session, flip hasLiveSession() to false while an interactive login is live
  // (probe/terminal collision), and let the next open spawn a duplicate ssh.
  function detach(entry) {
    if (entry.exited || entry.graceTimer || entry.listeners.size > 0) return;
    entry.graceTimer = setTimeout(() => {
      try { entry.pty.kill(); } catch {}
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
    }, graceSeconds * 1000);
  }
  function close(entry) {
    entry.exited = true;
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
    try { entry.pty.kill(); } catch {}
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  }
  // Close the PTY only when no listener remains attached. Provision sockets use
  // this instead of close(): provision() hands the SAME entry to a second
  // socket with the same key, so a replaced socket's straggling close must not
  // abort the script its replacement is still watching (the nonzero exit would
  // roll the box back as if the user cancelled).
  function closeIfUnwatched(entry) {
    if (!entry.exited && entry.listeners.size > 0) return false;
    close(entry);
    return true;
  }
  function closeKey(key) {
    const entry = entries.get(key);
    if (entry) close(entry);
  }
  function liveInGroup(group, kind) {
    const out = [];
    for (const entry of entries.values()) {
      if (entry.exited || entry.group !== group) continue;
      if (kind && entry.kind !== kind) continue;
      out.push(entry);
    }
    return out;
  }
  function assertViewerRoom(group) {
    if (!(maxViewersPerBox > 0)) return;
    const live = liveInGroup(group, 'terminal');
    let room = live.length;
    if (room < maxViewersPerBox) return;
    // A PTY with no listener is a browser tab that has gone away; its ssh is
    // held only so a reconnect inside the grace window can reclaim it. That
    // reservation yields to a real viewer rather than refusing one — otherwise
    // a handful of opened-and-closed tabs would lock a box out of new viewers
    // for the whole grace window. Oldest first: Map preserves insertion order.
    for (const entry of live) {
      if (room < maxViewersPerBox) break;
      if (entry.listeners.size > 0) continue;
      close(entry);
      room -= 1;
    }
    if (room >= maxViewersPerBox) {
      throw new Error(`too many viewers for this box (max ${maxViewersPerBox})`);
    }
  }
  // Act on every PTY a box owns, since one box now spans a key per viewer.
  // Passing `kind` narrows it: editing a box's connection fields drops its
  // terminals so they reconnect with the new settings, and must NOT abort an
  // interactive setup finish on the same box — that PTY is someone part-way
  // through typing an ssh password.
  function closeGroup(group, kind) {
    for (const entry of liveInGroup(group, kind)) close(entry);
  }
  // True while a box's ssh/PTY is alive (connecting, attached, or in its grace
  // window). The status checker uses this to avoid probing a box that has an
  // active interactive session on the shared ControlMaster socket.
  function hasLiveSession(key) {
    const entry = entries.get(key);
    return !!(entry && !entry.exited);
  }

  // "Is any interactive login live for this box?" — the question the probe and
  // Fleet guards actually mean, so they never fire a BatchMode ssh into a live
  // password prompt. It used to test two literal keys (the box id and the
  // provision key); with a viewer id in a terminal's key that no longer finds
  // anything, so it asks the group instead and covers every viewer at once.
  function hasLiveSessionForBox(boxId) {
    return liveInGroup(boxId).length > 0;
  }

  return { open, openLocal, provision, attach, onExit, write, resize, detach, close, closeIfUnwatched, closeKey, closeGroup, hasLiveSession, hasLiveSessionForBox, _count: () => entries.size };
}
