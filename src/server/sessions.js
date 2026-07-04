import nodePty from 'node-pty';
import { buildAttachArgv, buildProvisionArgv } from './sshCommand.js';

export function createSessionManager({ hostKeyPolicy = 'accept-new', graceSeconds = 45, spawnEnv = process.env, sshConfigFile, controlDir, controlPersist, localSession = 'local', spawn = nodePty.spawn } = {}) {
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
    const argv = buildAttachArgv(box, session, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
    const pty = spawn('ssh', argv, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false, buffer: '' };
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
    const args = ['-u', 'new-session', '-A', '-D', '-s', localSession];
    if (shell === 'omz') args.push('exec zsh');
    else if (shell === 'omb') args.push('exec bash');
    const pty = spawn('tmux', args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false, buffer: '' };
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

  function provision({ key, box, script, opts = {} }) {
    const existing = entries.get(key);
    if (existing && !existing.exited) {
      if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
      return existing;
    }
    const argv = buildProvisionArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist, ...opts });
    const pty = spawn('ssh', argv, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false, exitCode: null, buffer: '' };
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
      if (replay) { try { onData(replay); } catch { /* ignore */ } }
    }
    entry.listeners.add(onData);
    if (!entry.exited) {
      try { 
        entry.pty.resize(entry.pty.cols === 1 ? 2 : entry.pty.cols - 1, entry.pty.rows); 
        entry.pty.resize(entry.pty.cols, entry.pty.rows); 
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
  // True while a box's ssh/PTY is alive (connecting, attached, or in its grace
  // window). The status checker uses this to avoid probing a box that has an
  // active interactive session on the shared ControlMaster socket.
  function hasLiveSession(key) {
    const entry = entries.get(key);
    return !!(entry && !entry.exited);
  }

  return { open, openLocal, provision, attach, onExit, write, resize, detach, close, closeIfUnwatched, closeKey, hasLiveSession, _count: () => entries.size };
}
