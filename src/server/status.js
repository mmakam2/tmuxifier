import { buildProbeArgv } from './sshCommand.js';

const STATUS_FMT = '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}';

// A compact host-health line emitted *before* the tmux output on the SSH probe
// we already run every poll, so load/mem/disk cost no extra connection. Format is
// space-separated `KEY=VALUE` (not fixed columns) so a source that is unavailable
// drops one field instead of shifting the rest; every source is best-effort
// (`2>/dev/null`, guarded) so a non-Linux or locked-down box still returns normal
// reachability/tmux status with metrics simply absent. Linux /proc + POSIX
// `df -P` keep it portable. This stays a static, non-interpolated string — no box
// field reaches it — so it adds no command-injection surface over the old probe.
// The whole block is wrapped in `{ ...; } 2>/dev/null` so no metric command's
// stderr (a missing `nproc`/`awk`/`df`, an unreadable /proc file) can ever leak
// into the probe's stderr, which the reachability classifier inspects.
const META_PROBE =
  `{ printf '__META__'; ` +
  `{ read a b c rest </proc/loadavg && printf ' load1=%s load5=%s load15=%s' "$a" "$b" "$c"; }; ` +
  `n=$(nproc) && printf ' cpus=%s' "$n"; ` +
  // Cumulative CPU time of *this* cgroup (the container's own scope under lxcfs,
  // or the whole system on a bare host) in microseconds. The server diffs it
  // across polls to get true utilization — unlike /proc/loadavg, which inside an
  // LXC container leaks the Proxmox host's load. cgroup v2 first, then v1.
  `if [ -r /sys/fs/cgroup/cpu.stat ]; then awk '/^usage_usec/{printf " cpuUsageUsec=%s",$2}' /sys/fs/cgroup/cpu.stat; ` +
  `elif [ -r /sys/fs/cgroup/cpuacct/cpuacct.usage ]; then printf ' cpuUsageUsec=%s' "$(( $(cat /sys/fs/cgroup/cpuacct/cpuacct.usage) / 1000 ))"; ` +
  `elif [ -r /sys/fs/cgroup/cpu,cpuacct/cpuacct.usage ]; then printf ' cpuUsageUsec=%s' "$(( $(cat /sys/fs/cgroup/cpu,cpuacct/cpuacct.usage) / 1000 ))"; fi; ` +
  `awk '/^MemTotal:/{printf " memTotalKb=%s",$2} /^MemAvailable:/{printf " memAvailKb=%s",$2}' /proc/meminfo; ` +
  `df -P / | awk 'NR==2{sub(/%/,"",$5); printf " diskTotalKb=%s diskUsedKb=%s diskPct=%s",$2,$3,$5}'; ` +
  `u=$(awk '{printf "%d",$1}' /proc/uptime) && printf ' uptimeSec=%s' "$u"; ` +
  `echo; } 2>/dev/null;`;

export const PROBE_REMOTE =
  `${META_PROBE} if command -v tmux >/dev/null 2>&1; then tmux ls -F '${STATUS_FMT}' 2>/dev/null || true; else echo __NO_TMUX__; fi`;

const META_KEYS = new Set([
  'load1', 'load5', 'load15', 'cpus', 'cpuUsageUsec',
  'memTotalKb', 'memAvailKb', 'diskTotalKb', 'diskUsedKb', 'diskPct', 'uptimeSec',
]);

// Pull the `__META__` health line out of probe stdout into a numbers-only object.
// Positional parsing is avoided on purpose: a missing source omits its token
// rather than shifting columns. Empty (`cpus=`) and non-numeric (`load1=NaN`)
// values are dropped — note Number('') === 0, which is why the empty guard
// matters. Returns null when the line is absent or yields no numeric fields.
export function parseMeta(stdout) {
  const line = String(stdout).split(/\r?\n/).find((l) => l.startsWith('__META__'));
  if (!line) return null;
  const out = {};
  for (const tok of line.slice('__META__'.length).trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    const raw = tok.slice(eq + 1);
    if (raw === '' || !META_KEYS.has(key)) continue;
    const val = Number(raw);
    if (Number.isFinite(val)) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

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
    .filter((l) => l.trim() && !l.includes('__NO_TMUX__') && !l.startsWith('__META__'))
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
  const cpuPrev = new Map(); // key -> { usageUsec, atMs } last cgroup CPU sample
  const keyFor = (box) => box.id || box.host;

  // Turn the cumulative cgroup CPU counter into a true utilization percent by
  // diffing it against the previous poll's sample: Δcpu-time ÷ Δwall-time ÷ cores.
  // This is what Proxmox shows per container; raw load average is not (in an LXC
  // it reflects the whole host). First sample yields nothing (no rate yet); a
  // counter that went backwards (container restart) is skipped. Mutates `metrics`.
  function deriveCpuPct(box, metrics) {
    if (!metrics || metrics.cpuUsageUsec == null) return;
    const key = keyFor(box);
    const nowMs = now();
    const prev = cpuPrev.get(key);
    cpuPrev.set(key, { usageUsec: metrics.cpuUsageUsec, atMs: nowMs });
    if (!prev) return;
    const dUsageUsec = metrics.cpuUsageUsec - prev.usageUsec;
    const dWallMs = nowMs - prev.atMs;
    if (dUsageUsec < 0 || dWallMs <= 0 || !metrics.cpus) return;
    // dUsageUsec/1000 = ms of CPU time; / dWallMs = fraction of one core; / cpus = of allocation.
    metrics.cpuPct = Math.max(0, Math.round((dUsageUsec / 1000 / dWallMs) * 100 / metrics.cpus));
  }

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
      const metrics = parseMeta(res.stdout);
      deriveCpuPct(box, metrics);
      const base = String(res.stdout).includes('__NO_TMUX__')
        ? { reachable: true, tmux: false, sessions: [] }
        : { reachable: true, tmux: true, sessions: parseTmuxSessions(res.stdout) };
      return metrics ? { ...base, metrics } : base;
    } catch (e) {
      return { reachable: false, error: String((e && e.message) || e) };
    }
  }

  return {
    async checkBox(box) {
      const key = keyFor(box);
      // A box with a live interactive session is in use right now. The shared %C
      // master is only established after auth completes, so a socket-only liveness
      // check (no network auth, can't collide) distinguishes "authenticated &
      // connected" from "still sitting at the password prompt".
      if (hasLiveSession && hasLiveSession(box)) {
        const alive = masterAlive ? await masterAlive(box) : true;
        // No live master: mid-login or needs-auth. Don't probe — a BatchMode probe
        // racing the login is what garbles the password prompt — just report
        // needs-login (purple), never a fake green.
        if (!alive) return { reachable: false, needsAuth: true };
        // Master is up: a probe multiplexes over it as a separate channel without
        // disturbing the terminal (same as listSessions), so the box you're working
        // in still gets live metrics. Bypasses backoff — an in-use box is reachable.
        return probe(box);
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
    // triggered (the ⟳ button), so it ignores the poll backoff, rides the shared
    // ControlMaster, and coalesces concurrent fetches. When a terminal is open we
    // still refresh: once that session's ControlMaster is established, `tmux ls`
    // multiplexes over it as a separate channel without disturbing the terminal.
    // We skip the probe only in the narrow mid-login window — session open but the
    // master not up yet — where a BatchMode probe would race the login; then we
    // report inUse and the dialog keeps its cached pre-fill. A socket-only
    // `masterAlive` check (no network/auth) tells the two apart; if it isn't wired
    // we can't confirm the master is up, so we skip conservatively.
    async listSessions(box) {
      if (hasLiveSession && hasLiveSession(box)) {
        const alive = masterAlive ? await masterAlive(box) : false;
        if (!alive) return { reachable: true, tmux: true, inUse: true, sessions: [] };
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
