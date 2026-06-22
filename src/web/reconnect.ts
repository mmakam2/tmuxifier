export interface BackoffOpts {
  baseMs?: number;
  capMs?: number;
}

// Delay before the Nth consecutive reconnect attempt (failures = 1, 2, 3, …).
// Exponential from baseMs, capped at capMs — a steady floor that never gives up
// (always returns a finite delay), so a down box settles to a gentle trickle and
// auto-reconnects once it comes back. Reset the failure count on a stable
// connection (see terminal.ts) to return to the base delay.
export function reconnectDelay(failures: number, opts: BackoffOpts = {}): number {
  const base = opts.baseMs ?? 1000;
  const cap = opts.capMs ?? 300000; // 5 minutes
  const n = Math.max(1, Math.floor(failures));
  return Math.min(base * 2 ** (n - 1), cap);
}
