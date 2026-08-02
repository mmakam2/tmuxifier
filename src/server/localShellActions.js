import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { buildEnsureTmuxRemote } from './boxActions.js';
import { createAgentHooksPusher } from './claudeAgentHooks.js';

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

// Like runLocalShellScript, but the script reads bytes from stdin — the
// script + stdin contract createAgentHooksPusher expects, over a local
// transport instead of ssh. execFile can't feed stdin, hence spawn.
function runLocalScriptStdin(script, input, { cwd = os.homedir(), env = process.env, timeout = SETUP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', script], { cwd, env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
    // The skipped-no-claude path drains stdin, but guard anyway: a script that
    // exits before reading must not turn into an unhandled EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const readHookAssetDefault = () => fs.promises.readFile(new URL('./assets/tmuxifier-agent-hook.sh', import.meta.url));

// localSession must match the session name the session manager attaches
// (sessions.openLocal) — threading it here keeps the two from silently
// diverging if the knob is ever set to a non-default value.
export function createLocalShellActions({ run = runLocalShellScript, runStdin = runLocalScriptStdin, readHookAsset = readHookAssetDefault, cwd = os.homedir(), env = process.env, localSession = 'local' } = {}) {
  // The SSH pusher's transport signature is (box, script, bytes); the host has
  // no box, so the local transport drops that argument. Everything else —
  // installer script, result parsing, skip/error mapping — is the pusher's,
  // so the two install paths cannot drift.
  const hooksPusher = createAgentHooksPusher({
    runStdin: (_box, script, bytes) => runStdin(script, bytes, { cwd, env }),
    readAsset: readHookAsset,
  });
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
    async installAgentHooks() {
      return hooksPusher.push(null);
    },
  };
}
