import { buildProbeArgv } from './sshCommand.js';

const STATUS_FMT = '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}';

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

export function createStatusChecker({
  run, hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist, reapStaleMaster,
  hasLiveSession, masterAlive, now = () => Date.now(), stepSec = 30, capSec = 300,
}) {
  const remote = PROBE_REMOTE;
  const capCount = Math.ceil(capSec / stepSec);
  const backoff = new Map(); // key -> { fails, nextProbeAt, paused, last }
  const inflight = new Map(); // key -> Promise<status> for a probe already running
  const sessInflight = new Map(); // key -> Promise for an in-flight listSessions() fetch
  const keyFor = (box) => box.id || box.host;

  // One real SSH probe (the former checkBox body). Always resolves to a status
  // object and never throws — an unsafe box or thrown error becomes unreachable.
  async function probe(box) {
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
  }

  return {
    async checkBox(box) {
      const key = keyFor(box);
      // A box with a live interactive session is in use right now. A full
      // BatchMode probe would open a second ssh on the *same* ControlMaster
      // socket and collide with the interactive login (mux "disabling
      // multiplexing", socket reaping, garbled prompt). Instead reflect the real
      // connection state via a socket-only liveness check (no network auth, so
      // it can't collide): a live master means the box is authenticated and
      // connected (green); no master means it still needs a login (purple) —
      // never fake a green for a session that is only sitting at the password
      // prompt.
      if (hasLiveSession && hasLiveSession(box)) {
        const alive = masterAlive ? await masterAlive(box) : true;
        return alive
          ? { reachable: true, tmux: true, sessions: [] }
          : { reachable: false, needsAuth: true };
      }
      const s = backoff.get(key);
      const t = now();
      // Inside the current backoff window: return the last-known status without
      // touching SSH, so a failing box is not re-probed on every poll.
      if (s && t < s.nextProbeAt) {
        return s.paused ? { ...s.last, paused: true, nextProbeAt: s.nextProbeAt } : { ...s.last };
      }
      // Coalesce concurrent probes of the same box into one ssh call. Each
      // dashboard tab polls /api/status independently, so without this every open
      // tab would open its own ssh handshake to the same box at the same instant —
      // a burst from one IP that rate-limiters/IPS read as an attack (and that the
      // per-box backoff can't throttle, since it's only set after a probe returns).
      let pending = inflight.get(key);
      if (!pending) {
        pending = (async () => {
          const result = await probe(box);
          if (result.reachable) {
            backoff.delete(key); // recovered: back to the normal poll cadence
            return result;
          }
          // Failure. A needs-login box can never succeed under BatchMode and fast
          // probing only feeds host-side fail2ban, so jump straight to the 5m floor.
          const fails = result.needsAuth ? capCount : ((s?.fails ?? 0) + 1);
          const intervalSec = Math.min(stepSec * fails, capSec);
          const paused = intervalSec >= capSec;
          const nextProbeAt = t + intervalSec * 1000;
          backoff.set(key, { fails, nextProbeAt, paused, last: result });
          return paused ? { ...result, paused: true, nextProbeAt } : result;
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      return pending;
    },
    // On-demand fetch of a box's live tmux sessions for the Add/Edit dialog. User
    // triggered (the ⟳ button), so it ignores the poll backoff — but it still rides
    // the shared ControlMaster and coalesces concurrent fetches, and it is skipped
    // entirely when a live interactive session owns the socket (a BatchMode probe
    // would collide with that login). The dialog keeps its cached pre-fill instead.
    async listSessions(box) {
      if (hasLiveSession && hasLiveSession(box)) {
        return { reachable: true, tmux: true, inUse: true, sessions: [] };
      }
      const key = keyFor(box);
      let pending = sessInflight.get(key);
      if (!pending) {
        pending = probe(box).finally(() => sessInflight.delete(key));
        sessInflight.set(key, pending);
      }
      return pending;
    },
    resetBackoff(box) {
      backoff.delete(typeof box === 'string' ? box : keyFor(box));
    },
  };
}
