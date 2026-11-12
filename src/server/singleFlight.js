// Coalesces concurrent async work by key: while a call for `key` is pending,
// later calls get the same promise and `fn` is not invoked again. The key is
// freed when the promise settles, fulfilled or rejected, so nothing is cached.
// Why: a browser abort does not stop the server's ssh run (up to 8 s), so
// repeated pane previews of one box and session would otherwise pile up ssh.
export function createSingleFlight() {
  const pending = new Map();
  return function flight(key, fn) {
    const running = pending.get(key);
    if (running) return running;
    const p = (async () => fn())().finally(() => {
      if (pending.get(key) === p) pending.delete(key);
    });
    pending.set(key, p);
    return p;
  };
}
