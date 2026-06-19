import nodePty from 'node-pty';
import { buildAttachArgv } from './sshCommand.js';

const { spawn } = nodePty;

export function createSessionManager({ hostKeyPolicy = 'accept-new', graceSeconds = 45, spawnEnv = process.env } = {}) {
  const entries = new Map(); // key -> entry

  function open({ key, box, session, size }) {
    const existing = entries.get(key);
    if (existing && !existing.exited) {
      if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
      return existing;
    }
    const argv = buildAttachArgv(box, session, size, { hostKeyPolicy });
    const pty = spawn('ssh', argv, {
      name: 'xterm-color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false };
    pty.onData((d) => { for (const fn of entry.listeners) fn(d); });
    pty.onExit(() => {
      entry.exited = true;
      entries.delete(key);
      for (const cb of entry.exitCbs) cb();
    });
    entries.set(key, entry);
    return entry;
  }

  function attach(entry, onData) {
    entry.listeners.add(onData);
    return () => entry.listeners.delete(onData);
  }
  function onExit(entry, cb) { entry.exitCbs.add(cb); return () => entry.exitCbs.delete(cb); }
  function write(entry, data) { if (!entry.exited) entry.pty.write(data); }
  function resize(entry, { cols, rows }) {
    if (!entry.exited) { try { entry.pty.resize(cols, rows); } catch {} }
  }
  function detach(entry) {
    if (entry.exited || entry.graceTimer) return;
    entry.graceTimer = setTimeout(() => {
      try { entry.pty.kill(); } catch {}
      entries.delete(entry.key);
    }, graceSeconds * 1000);
  }
  function close(entry) {
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
    try { entry.pty.kill(); } catch {}
    entries.delete(entry.key);
  }

  return { open, attach, onExit, write, resize, detach, close, _count: () => entries.size };
}
