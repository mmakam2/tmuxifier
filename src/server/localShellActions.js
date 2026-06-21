import { execFile } from 'node:child_process';
import os from 'node:os';
import { buildEnsureTmuxRemote } from './boxActions.js';

const SETUP_TIMEOUT_MS = 120000;

export function buildEnsureLocalShellScript(shell) {
  if (shell === 'none') return '';
  if (shell === 'omz') return buildEnsureTmuxRemote('local', undefined, { installOhMyZsh: true });
  if (shell === 'omb') return buildEnsureTmuxRemote('local', undefined, { installOhMyBash: true });
  throw new Error('invalid shell');
}

export function runLocalShellScript(script, { cwd = os.homedir(), env = process.env, timeout = SETUP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { cwd, env, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

export function createLocalShellActions({ run = runLocalShellScript, cwd = os.homedir(), env = process.env } = {}) {
  return {
    async ensureReady(shell) {
      const script = buildEnsureLocalShellScript(shell);
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
