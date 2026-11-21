import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CLAUDE_TOKEN_FILE, CLAUDE_TOKEN_RC_LINE } from '../../src/server/aiAuthSeed.js';

// A throwaway "box" for the agent-worker start script: a real tmux server and a HOME shaped
// like a seeded box, with a stand-in `claude` that records what it was started with.
//
// Isolation, same posture as test/osc7501Tmux.integration.test.js: the server is private, on
// its own socket name (`-L`) under a private TMUX_TMPDIR, with a private HOME and an
// environment built from scratch (never process.env spread, so no TMUX or TMUX_PANE can point
// a command at the operator's server). Every `tmux` the script, the panes and this helper run
// is `bin/tmux`, a wrapper that pins the socket. `cleanup` kills that server only.
//
// The box's shape:
// - `.profile`, `.bashrc`, `.zshrc`, each with the two tagged lines setup writes on a box: the
//   token export (CLAUDE_TOKEN_RC_LINE) and the ~/.local/bin PATH line. ZDOTDIR is not set, so
//   zsh reads the fixture's own `.zshrc` (and never starts zsh-newuser-install).
// - a fake token in ~/.tmuxifier-auth/claude-token.
// - ~/.local/bin/claude, the stand-in: it writes `token=<set|unset> cwd=<pwd> tty=<yes|no>` to
//   <home>/standin/<its tmux session name>, then execs `sleep 600` so the pane stays up.
//
// `run(shell, remote)` runs the script as ssh would, `<shell> -c <remote>`, with
// PATH=<bin>:/usr/bin:/bin: ~/.local/bin is not on it, as on a box, so only the rc files of an
// interactive shell can find the agent. SHELL is the script's own shell, as sshd sets it.
// `run(shell, remote, { path })` replaces only what follows <bin> (a test's farm of chosen
// tools): <bin>, the pinned tmux wrapper, stays first on every PATH the script runs with.
// tmux gives a session the PATH of the client that created it, so the panes the script starts
// get that PATH too: a farm must hold what the rc files and the stand-in run (`cat`, `mv`,
// `sleep`).
//
// The server is started here, before any script runs, with `default-shell` set to
// `defaultShell` and `exit-empty off`: otherwise the script's own new-session would start it
// and tmux would take default-shell from the script's SHELL, and the matrix could not pair a
// script shell with a different default-shell.
//
// A missing shell or tmux FAILS, loudly: a suite that silently skips silently stops protecting
// the code (localBox.js treats a missing sshd the same way).

function requireBinary(name) {
  const r = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
  const found = (r.stdout || '').trim();
  if (r.status !== 0 || !found.startsWith('/')) {
    throw new Error(`${name} is not installed; the agent-worker bench needs a real ${name} (install it, this suite does not skip)`);
  }
  return found;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The box's files, shared with any test that shapes another fixture home like a seeded box
// (test/agentWorkers.integration.test.js writes them into localBox.js's home).

// The two tagged lines setup writes on a box, appended (a fixture's own rc content is kept).
export function writeWorkerRcFiles(home) {
  const rc = `${CLAUDE_TOKEN_RC_LINE}\nexport PATH="$HOME/.local/bin:$PATH" # tmuxifier-local-bin\n`;
  for (const f of ['.profile', '.bashrc', '.zshrc']) appendFileSync(path.join(home, f), rc);
}

export function writeWorkerToken(home) {
  const tokenFile = path.join(home, CLAUDE_TOKEN_FILE);
  mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, 'bench-fake-token\n', { mode: 0o600 });
}

// ~/.local/bin/claude. `tmux` is the absolute tmux the stand-in asks for its own session name
// (the bench's pinned wrapper; a box's own tmux, which reaches the pane's server through the
// pane's $TMUX). Its line goes through a temp file and a rename so a reader never sees half of
// it, into <home>/standin/<session>.
export function writeStandIn(home, { tmux }) {
  const localBin = path.join(home, '.local', 'bin');
  const standinDir = path.join(home, 'standin');
  for (const d of [localBin, standinDir]) mkdirSync(d, { recursive: true });
  const standIn = path.join(localBin, 'claude');
  writeFileSync(standIn, [
    '#!/bin/sh',
    `s="$('${tmux}' display-message -p -t "$TMUX_PANE" '#{session_name}')"`,
    'if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then t=set; else t=unset; fi',
    'if [ -t 0 ]; then y=yes; else y=no; fi',
    `printf 'token=%s cwd=%s tty=%s\\n' "$t" "$(pwd)" "$y" > '${standinDir}/.tmp.'"$s"`,
    `mv '${standinDir}/.tmp.'"$s" '${standinDir}/'"$s"`,
    'exec sleep 600',
    '',
  ].join('\n'));
  chmodSync(standIn, 0o755);
}

// The stand-in's line for `session`, or null while it has not written one.
export function readStandInLog(home, session) {
  const f = path.join(home, 'standin', session);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}

export function createWorkerBench({ defaultShell }) {
  const tmuxBin = requireBinary('tmux');
  const defaultShellBin = requireBinary(defaultShell);
  const tmp = mkdtempSync(path.join(tmpdir(), 'worker-bench-'));
  const home = path.join(tmp, 'home');
  const tmuxTmp = path.join(tmp, 'tmuxtmp');
  const bin = path.join(tmp, 'bin');
  for (const d of [home, tmuxTmp, bin]) mkdirSync(d, { recursive: true });

  const socket = `worker-bench-${randomUUID().slice(0, 8)}`;
  const wrapper = path.join(bin, 'tmux');
  writeFileSync(wrapper, `#!/bin/sh\nexec '${tmuxBin}' -L '${socket}' "$@"\n`);
  chmodSync(wrapper, 0o755);

  writeWorkerRcFiles(home);
  writeWorkerToken(home);
  writeStandIn(home, { tmux: wrapper });

  const env = {
    HOME: home,
    TMUX_TMPDIR: tmuxTmp,
    PATH: `${bin}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
  };

  const tmux = (...args) => execFileSync(wrapper, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  // -f /dev/null: no tmux.conf of any kind.
  tmux('-f', '/dev/null', 'start-server', ';',
    'set-option', '-g', 'exit-empty', 'off', ';',
    'set-option', '-g', 'default-shell', defaultShellBin);
  // tmux falls back to /tmp when TMUX_TMPDIR is unusable (a socket path too long, say), which
  // would put this server beside the operator's. Refuse to go on unless it is where we put it.
  const sock = path.join(tmuxTmp, `tmux-${process.getuid()}`, socket);
  if (!existsSync(sock)) {
    spawnSync(wrapper, ['kill-server'], { env, stdio: 'ignore' });
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`the bench's tmux server is not at ${sock}; refusing to run outside the private TMUX_TMPDIR`);
  }

  return {
    home,
    env,
    tmux,
    run(shell, remote, { path: rest } = {}) {
      const shellBin = requireBinary(shell);
      const PATH = rest === undefined ? env.PATH : `${bin}:${rest}`;
      const r = spawnSync(shellBin, ['-c', remote], {
        env: { ...env, PATH, SHELL: shellBin },
        cwd: home,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
      });
      return { code: r.status, stdout: r.stdout };
    },
    standInLog(session) {
      return readStandInLog(home, session);
    },
    // Kill the private server (its panes get SIGHUP), then make sure every pane process is
    // gone, the stand-ins' `sleep 600` above all, before the temp tree is removed.
    async cleanup() {
      let pids = [];
      try {
        pids = tmux('list-panes', '-a', '-F', '#{pane_pid}').split('\n').filter(Boolean).map(Number);
      } catch { /* no server, no panes */ }
      spawnSync(wrapper, ['kill-server'], { env, stdio: 'ignore' });
      for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(50);
      for (const pid of pids.filter(alive)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
