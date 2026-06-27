import type { Status, BoxMetrics } from './api';

type DotClass = 'gray' | 'green' | 'amber' | 'red' | 'auth';

// Single source of truth for the box status dot. `needsAuth` wins over a plain
// unreachable result: a password-auth box whose SSH master expired is not dead,
// it just needs the user to re-open the terminal and enter the password.
export function dotClassFor(st: Status | undefined): DotClass {
  if (!st) return 'gray';
  if (st.needsAuth) return 'auth';
  if (!st.reachable) return 'red';
  return st.tmux === false ? 'amber' : 'green';
}

// Turn the raw ssh failure the probe already captured into a short, plain-language
// hint. The fail2ban / port-22 ban case is the high-value one: a banned IP fails
// the SSH banner exchange (`kex_exchange_identification` / connection reset), which
// otherwise reads as an undifferentiated "Unreachable". Unknown errors pass through
// trimmed; a missing error is the generic "Unreachable".
export function classifyError(error?: string): string {
  const raw = (error || '').trim();
  const e = raw.toLowerCase();
  if (!e) return 'Unreachable';
  if (/kex_exchange_identification|connection reset by peer|banner exchange/.test(e)) {
    return 'Port-22 rate-limited or banned (fail2ban?)';
  }
  if (/connection refused/.test(e)) return 'sshd down or wrong port';
  if (/timed out|timeout|no route to host|network is unreachable/.test(e)) return 'Host offline or network down';
  if (/host key|remote host identification has changed/.test(e)) return 'Host key changed — verify the box';
  return raw;
}

export function dotTitleFor(st: Status | undefined): string {
  if (!st) return 'Status unknown';
  if (st.needsAuth) return 'Needs login — click the box (or ↻) to reconnect and enter your password';
  if (!st.reachable) {
    const reason = classifyError(st.error);
    const base = reason && reason !== 'Unreachable' ? `Unreachable — ${reason}` : 'Unreachable';
    return st.paused ? `${base}; retrying every 5m, click the box or ↻ to retry now` : base;
  }
  return st.tmux === false ? 'Reachable (tmux not running)' : 'Connected';
}

// Raw load average is a poor glance-metric: it's a process count, meaningless
// without the core count (4.0 is "full" on a 4-core box, "quarter" on a 16-core
// one). Normalize by cpus to a percent that reads like a fuel gauge — 100% =
// fully busy, >100% = work queuing. Undefined when load or a usable core count
// is missing (caller then falls back to raw load). Note: load counts
// IO-waiting processes too, so this is "how backed-up", not pure CPU utilization.
export function cpuLoadPct(m: BoxMetrics | undefined): number | undefined {
  if (!m || m.load1 == null || !m.cpus) return undefined;
  return Math.round((m.load1 / m.cpus) * 100);
}

export type Level = 'ok' | 'warn' | 'crit';

// Severity for the normalized CPU figure: relaxed < 70%, busy 70–100%, queuing > 100%.
export function cpuLevel(pct: number): Level {
  if (pct > 100) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

// Nerd Font 'fa-microchip' glyph (a square IC with pins). Rendered in the bundled
// Nerd Font (iconClass 'nf'), which styles it a neutral color so the severity
// color stays on the percentage alone.
export const CPU_ICON = '\uF2DB';

export interface MetaSegment { text: string; icon?: string; iconClass?: string; level?: Level; title?: string; }

// The always-visible second line under a box label, as styled segments. Reachable
// → `[cpu, mem, disk]` from the metrics piggybacked on the status probe; only the
// cpu segment is colored (by load severity). Empty when no metrics were collected
// (a box you have a terminal open to, or a non-Linux host). Unreachable / needsAuth
// → a single crit segment carrying the classified reason / "Needs login".
export function metaSegmentsFor(st: Status | undefined): MetaSegment[] {
  if (!st) return [];
  if (st.needsAuth) return [{ text: 'Needs login', level: 'crit' }];
  if (!st.reachable) return [{ text: classifyError(st.error), level: 'crit' }];
  const m = st.metrics;
  if (!m) return [];
  const segs: MetaSegment[] = [];
  const cpuIcon = { icon: CPU_ICON, iconClass: 'nf' };
  // Prefer true cgroup utilization (what Proxmox shows per container). Fall back
  // to load-normalized ONLY when the host has no cgroup counter at all — in an LXC
  // container load average reflects the whole Proxmox host, so we never show it
  // when a (more accurate) cgroup figure is available or merely warming up.
  if (m.cpuPct != null) {
    segs.push({ text: `${m.cpuPct}%`, ...cpuIcon, level: cpuLevel(m.cpuPct), title: `CPU ${m.cpuPct}% utilization (cgroup — matches Proxmox)` });
  } else if (m.cpuUsageUsec == null) {
    const pct = cpuLoadPct(m);
    if (pct != null) {
      segs.push({ text: `${pct}%`, ...cpuIcon, level: cpuLevel(pct), title: `load ${m.load1} ÷ ${m.cpus} cores (${pct}%) — load-based fallback, no cgroup; counts IO-waiting processes` });
    } else if (m.load1 != null) {
      segs.push({ text: m.load1.toFixed(2), ...cpuIcon, title: 'CPU load average (core count unknown)' });
    }
  } // else: cgroup host warming up (one sample) — omit the cpu segment this cycle
  if (m.memTotalKb && m.memAvailKb != null) {
    segs.push({ text: `${Math.round((1 - m.memAvailKb / m.memTotalKb) * 100)}%`, icon: '🧠', title: 'RAM used' });
  }
  const diskPct = m.diskPct != null
    ? m.diskPct
    : (m.diskTotalKb && m.diskUsedKb != null ? Math.round((m.diskUsedKb / m.diskTotalKb) * 100) : undefined);
  if (diskPct != null) segs.push({ text: `${diskPct}%`, icon: '💾', title: 'Disk used (root filesystem /)' });
  return segs;
}

// Plain-text form of the meta line (segments joined, value + icon). Kept for tests/tooltips.
export function metaLineFor(st: Status | undefined): string {
  return metaSegmentsFor(st).map((s) => (s.icon ? `${s.text} ${s.icon}` : s.text)).join(' · ');
}

// The newest tmux session-activity timestamp the probe saw for a box (0 when none).
export function latestActivity(st: Status | undefined): number {
  if (!st || !st.sessions) return 0;
  return st.sessions.reduce((max, s) => (s.activity && s.activity > max ? s.activity : max), 0);
}

// A box has unseen activity when a background session has done something since the
// user last opened it. `seen` is the per-box last-seen activity (undefined = never).
export function hasUnseenActivity(st: Status | undefined, seen: number | undefined): boolean {
  return latestActivity(st) > (seen ?? 0);
}
