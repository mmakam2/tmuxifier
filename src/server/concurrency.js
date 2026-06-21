// Map over `items` running at most `limit` async jobs at once, returning results
// in input order. Tmuxifier probes boxes in small batches with this instead of
// opening every box's SSH connection simultaneously: a burst of dozens of
// concurrent SSH handshakes from one host looks like a brute-force/port-scan to
// rate-limiters and IPS on the path (e.g. an inter-VLAN gateway), which then
// temporarily blocks the dashboard host and makes boxes flicker red.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  const workers = Math.max(1, Math.min(Number(limit) || 1, items.length));
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
