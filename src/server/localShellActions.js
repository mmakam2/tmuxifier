import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { buildEnsureTmuxRemote } from './boxActions.js';
import { createAgentHooksPusher } from './claudeAgentHooks.js';
import { createVoiceLinkPusher } from './claudeVoiceLink.js';
import { sanitizeSession, shSingleQuote } from './sshCommand.js';
import { sshPipe } from './sshRun.js';
import { buildVoiceWriterRemote } from './voiceWriter.js';

const SETUP_TIMEOUT_MS = 120000;

export function buildEnsureLocalShellScript(shell, sessionName = 'local') {
  if (shell === 'none') return '';
  // Never create or respawn the Host Shell session here: creating it inside
  // the HTTP request lands the tmux server in tmuxifier.service's cgroup
  // (defeating localTmuxScope's systemd-run --scope), and respawning window 1
  // with -k SIGKILLs whatever the operator is running (e.g. a live Claude
  // session while enabling Claude hooks). If =local already exists, update its
  // session-level default-shell for newly opened windows; otherwise leave
  // creation to localTmuxScope.ensure / openLocal on next attach.
  const clean = sanitizeSession(sessionName);
  const exact = shSingleQuote(`=${clean}`);
  // set-option -t takes a target-pane, where a bare `=name` is parsed as a
  // window name; the trailing `:` pins `=name:` to the exact session.
  const exactTarget = shSingleQuote(`=${clean}:`);
  if (shell === 'omz') {
    const base = buildEnsureTmuxRemote(sessionName, undefined, { installOhMyZsh: true, createSession: false });
    return `${base}\n[ -n "\${ZSH_BIN-}" ] && "$TMUX_BIN" has-session -t ${exact} 2>/dev/null && "$TMUX_BIN" set-option -t ${exactTarget} default-shell "$ZSH_BIN" 2>/dev/null || true`;
  }
  if (shell === 'omb') {
    const base = buildEnsureTmuxRemote(sessionName, undefined, { installOhMyBash: true, createSession: false });
    return `${base}\n[ -n "\${BASH_BIN-}" ] && "$TMUX_BIN" has-session -t ${exact} 2>/dev/null && "$TMUX_BIN" set-option -t ${exactTarget} default-shell "$BASH_BIN" 2>/dev/null || true`;
  }
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
// Exported so the default transport — the only production I/O path here that
// dependency injection otherwise hides from the tests — can be exercised
// against a real /bin/sh.
export function runLocalScriptStdin(script, input, { cwd = os.homedir(), env = process.env, timeout = SETUP_TIMEOUT_MS } = {}) {
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
    // Kill AND settle. Waiting for 'close' after the kill is not enough: that
    // event fires on stdio EOF, not on exit, so a grandchild holding the
    // inherited stdout (a shell that forked rather than exec'd) would leave
    // this promise — and the HTTP request awaiting it — pending forever.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(1);
    }, timeout);
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
export function createLocalShellActions({ run = runLocalShellScript, runStdin = runLocalScriptStdin, readHookAsset = readHookAssetDefault, pipe = sshPipe, cwd = os.homedir(), env = process.env, localSession = 'local' } = {}) {
  // The SSH pusher's transport signature is (box, script, bytes); the host has
  // no box, so the local transport drops that argument. Everything else —
  // installer script, result parsing, skip/error mapping — is the pusher's,
  // so the two install paths cannot drift.
  const hooksPusher = createAgentHooksPusher({
    runStdin: (_box, script, bytes) => runStdin(script, bytes, { cwd, env }),
    readAsset: readHookAsset,
  });
  const voiceLinkPusher = createVoiceLinkPusher({
    runStdin: (_box, script, bytes) => runStdin(script, bytes, { cwd, env }),
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
    async installVoiceLink() {
      return voiceLinkPusher.push(null);
    },
    // Host Shell's voice link: the same writer a box runs, spawned locally
    // under /bin/sh (sshPipe's test-only `cmd` injection is exactly the seam
    // a local transport needs). HOME comes from `env`, so the FIFO is this
    // host's own ~/.tmuxifier-voice/mic.
    openAudioSink() {
      return pipe(['-c', buildVoiceWriterRemote()], { cmd: '/bin/sh', env });
    },
  };
}
