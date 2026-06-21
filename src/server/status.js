import { buildProbeArgv } from './sshCommand.js';

export const STATUS_FMT = '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}';

export const PROBE_REMOTE =
  `if command -v tmux >/dev/null 2>&1; then tmux ls -F '${STATUS_FMT}' 2>/dev/null || true; else echo __NO_TMUX__; fi`;

// A probe runs with BatchMode=yes, so it can never type a password. When a
// password-auth box's ControlMaster has expired the probe fails with an auth
// error rather than a connection error. Surfacing that distinctly lets the UI
// say "needs login" (re-open the terminal to enter the password) instead of
// showing a dead "unreachable" dot.
const AUTH_FAIL_RE = /permission denied|authentication failed|too many authentication failures|no more authentication methods/i;

// ssh prints this to stderr when it finds a leftover control socket it can't use
// as a master and falls back to a direct connection. The orphan file then keeps
// disabling multiplexing on every connect — for a password box that means the
// dot is stuck red forever. Seeing this is our cue to reap the stale socket.
const MUX_STALE_RE = /disabling multiplexing|ControlSocket .* already exists/i;

export function parseTmuxSessions(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.includes('__NO_TMUX__'))
    .map((line) => {
      const [name, windows, attached, activity] = line.split(':');
      return { name, windows: Number(windows), attached: attached === '1', activity: Number(activity) };
    });
}

export function createStatusChecker({ run, hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist, reapStaleMaster }) {
  const remote = PROBE_REMOTE;
  return {
    async checkBox(box) {
      try {
        const argv = buildProbeArgv(box, remote, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
        const res = await run(argv);
        // A leftover socket disables multiplexing; reap it so the next connect
        // re-establishes a clean master (regardless of this probe's outcome).
        if (reapStaleMaster && MUX_STALE_RE.test(String(res.stderr || ''))) {
          try { await reapStaleMaster(box); } catch {}
        }
        if (res.code !== 0 && !String(res.stdout).trim()) {
          const err = String(res.stderr || '').trim();
          if (AUTH_FAIL_RE.test(err)) {
            return { reachable: false, needsAuth: true, error: err || 'authentication required' };
          }
          return { reachable: false, error: err || 'unreachable' };
        }
        if (String(res.stdout).includes('__NO_TMUX__')) {
          return { reachable: true, tmux: false, sessions: [] };
        }
        return { reachable: true, tmux: true, sessions: parseTmuxSessions(res.stdout) };
      } catch (e) {
        return { reachable: false, error: String((e && e.message) || e) };
      }
    },
  };
}
