import { execFile } from 'node:child_process';

// The Host Shell's tmux server used to be auto-started by the attaching pty
// client, which left it inside tmuxifier.service's cgroup — daemonizing
// reparents to pid 1 but never leaves a cgroup, so systemd's default
// KillMode=control-group killed the server (and every pane in it) on every
// service restart, including the deploy recipe's own restart step. Ensuring
// the session exists *detached* under `systemd-run --scope` before the pty
// attaches puts the server in its own transient scope: the restart still
// kills the pty client, but the session survives and the next viewer
// reattaches — exactly the remote-box model, where ssh dies and the box's
// tmux lives on.
//
// Everything here is best-effort. A host without systemd-run (or a transient
// failure) falls back to the old auto-start path: the terminal always opens,
// only restart-survival is lost.

export function buildHasSessionArgv(session) {
  // `=` pins the target to an exact name; a bare name prefix-matches.
  return ['tmux', ['has-session', '-t', `=${session}`]];
}

export function buildScopedNewSessionArgv(session, shell) {
  // --scope keeps the caller's environment and only moves the cgroup — the
  // move is the entire point. --collect reaps a failed or emptied scope.
  const args = [
    '--scope', '--collect', '--quiet',
    '--description=tmuxifier host-shell tmux server',
    '--',
    // -u and the shell command mirror openLocal's attach argv (sessions.js),
    // so the session ensure() creates is byte-identical to the one the pty
    // would have created via new-session -A.
    'tmux', '-u', 'new-session', '-d', '-s', session,
  ];
  if (shell === 'omz') args.push('exec zsh');
  else if (shell === 'omb') args.push('exec bash');
  return ['systemd-run', args];
}

const defaultExec = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, opts, (err) => (err ? reject(err) : resolve()));
});

export function createLocalTmuxScope({ session = 'local', exec = defaultExec, env = process.env, log = (msg) => console.error(msg) } = {}) {
  let disabled = false; // systemd-run proven absent — stop probing per viewer
  let inflight = null; // concurrent viewers share one ensure

  async function run(shell) {
    const [hasCmd, hasArgs] = buildHasSessionArgv(session);
    try {
      await exec(hasCmd, hasArgs, { env });
      return { created: false };
    } catch {
      // No session (or no server yet) — create it inside its own scope.
    }
    if (disabled) return { created: false };
    const [cmd, args] = buildScopedNewSessionArgv(session, shell);
    try {
      await exec(cmd, args, { env });
      return { created: true };
    } catch (err) {
      if (err?.code === 'ENOENT') disabled = true;
      log(`local tmux scope unavailable (${err?.message || err}); host-shell sessions will not survive restarts`);
      return { created: false };
    }
  }

  function ensure(shell) {
    if (!inflight) {
      inflight = run(shell).finally(() => { inflight = null; });
    }
    return inflight;
  }

  return { ensure };
}
