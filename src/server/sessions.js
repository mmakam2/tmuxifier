import nodePty from 'node-pty';
import { buildAttachArgv, buildProvisionArgv } from './sshCommand.js';

const { spawn } = nodePty;

export function createSessionManager({ hostKeyPolicy = 'accept-new', graceSeconds = 45, spawnEnv = process.env, sshConfigFile, controlDir } = {}) {
  const entries = new Map(); // key -> entry

  function open({ key, box, session, size }) {
    const existing = entries.get(key);
    if (existing && !existing.exited) {
      if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
      return existing;
    }
    const argv = buildAttachArgv(box, session, size, { hostKeyPolicy, sshConfigFile, controlDir });
    const pty = spawn('ssh', argv, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false };
    pty.onData((d) => {
      for (const fn of entry.listeners) {
        try { fn(d); } catch { /* listener error must not break the fan-out */ }
      }
    });
    pty.onExit(() => {
      entry.exited = true;
      entries.delete(key);
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
    const args = ['new-session', '-A', '-D', '-s', 'local'];
    if (shell === 'omz') args.push('exec zsh');
    else if (shell === 'omb') args.push('exec bash');
    const pty = spawn('tmux', args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false };
    pty.onData((d) => {
      for (const fn of entry.listeners) {
        try { fn(d); } catch { /* listener error must not break the fan-out */ }
      }
    });
    pty.onExit(() => {
      entry.exited = true;
      entries.delete(key);
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
    const argv = buildProvisionArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, ...opts });
    const pty = spawn('ssh', argv, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false, exitCode: null };
    pty.onData((d) => {
      for (const fn of entry.listeners) {
        try { fn(d); } catch { /* listener error must not break the fan-out */ }
      }
    });
    pty.onExit(({ exitCode }) => {
      entry.exited = true;
      entry.exitCode = exitCode;
      entries.delete(key);
      for (const cb of entry.exitCbs) cb();
    });
    entries.set(key, entry);
    return entry;
  }

  function attach(entry, onData) {
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
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
    if (!entry.exited) { try { entry.pty.resize(cols, rows); } catch {} }
  }
  function detach(entry) {
    if (entry.exited || entry.graceTimer || entry.listeners.size > 0) return;
    entry.graceTimer = setTimeout(() => {
      try { entry.pty.kill(); } catch {}
      entries.delete(entry.key);
    }, graceSeconds * 1000);
  }
  function close(entry) {
    entry.exited = true;
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
    try { entry.pty.kill(); } catch {}
    entries.delete(entry.key);
  }
  function closeKey(key) {
    const entry = entries.get(key);
    if (entry) close(entry);
  }

  return { open, openLocal, provision, attach, onExit, write, resize, detach, close, closeKey, _count: () => entries.size };
}
