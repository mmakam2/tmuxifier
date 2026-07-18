import { execFile } from 'node:child_process';
import os from 'node:os';
import { buildEnsureTmuxRemote } from './boxActions.js';

const SETUP_TIMEOUT_MS = 120000;

export function buildEnsureLocalShellScript(shell, sessionName = 'local') {
  if (shell === 'none') return '';
  if (shell === 'omz') return buildEnsureTmuxRemote(sessionName, undefined, { installOhMyZsh: true });
  if (shell === 'omb') return buildEnsureTmuxRemote(sessionName, undefined, { installOhMyBash: true });
  throw new Error('invalid shell');
}

function runLocalShellScript(script, { cwd = os.homedir(), env = process.env, timeout = SETUP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { cwd, env, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

// localSession must match the session name the session manager attaches
// (sessions.openLocal) — threading it here keeps the two from silently
// diverging if the knob is ever set to a non-default value.
export function createLocalShellActions({ run = runLocalShellScript, cwd = os.homedir(), env = process.env, localSession = 'local' } = {}) {
  return {
    async ensureReady(shell) {
      const script = buildEnsureLocalShellScript(shell, localSession);
      if (!script) return { ok: true };
      const res = await run(script, { cwd, env, timeout: SETUP_TIMEOUT_MS });
      if (res.code !== 0) {
        const msg = String(res.stderr || res.stdout || '').trim() || 'could not install local shell framework';
        throw new Error(msg);
      }
      return { ok: true };
    },
  };
}
