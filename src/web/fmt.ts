// Shared display formatters. They live outside dashboard.ts so a card module can
// use them without importing the dashboard back — dashboard.ts re-exports them,
// so existing importers are unaffected.

export function fmtLatency(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtCount(n: number | null | undefined): string {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
}

// Gravity lists run to millions; a raw digit run is unreadable at tile size.
export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return fmtCount(n);
}

export function fmtUptime(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Binary units, because that is what ZFS reports and what the TrueNAS UI shows.
// One decimal below 100 of a unit, none above, so column width stays stable.
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
