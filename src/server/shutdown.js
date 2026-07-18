// Graceful-shutdown seam: on SIGTERM/SIGINT, flush the debounced job stores
// before exiting so the final save of a just-finished job is not lost — a lost
// save is why a completed setup/fleet job could reload as 'interrupted' after
// a deploy restart. Injectable (proc/exit/log) so tests drive it with a fake
// process; flushers are `() => Promise` (the stores' whenIdle()).
export function registerShutdownFlush({
  proc = process,
  flush = [],
  exit = (code) => process.exit(code),
  log = (...args) => console.error(...args),
  timeoutMs = 5000,
} = {}) {
  const handler = async () => {
    try {
      await Promise.race([
        Promise.all(flush.map((fn) => fn())),
        // A wedged flusher must not block shutdown; the timer is unref'd so it
        // never keeps the real process alive on its own.
        new Promise((resolve) => {
          const t = setTimeout(resolve, timeoutMs);
          t.unref?.();
        }),
      ]);
    } catch (e) {
      log('shutdown flush failed:', e?.message || e);
    }
    exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT']) proc.once(sig, handler);
}
