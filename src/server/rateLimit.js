// Per-IP login rate limiting for the crown-jewel endpoint. A pure factory with
// an injectable clock so the lockout/window/eviction rules are testable without
// driving real (scrypt-slow) login requests.
//
// Bounding memory works by evicting the entry with the OLDEST window start —
// never by clearing the whole map. The old `attempts.clear()` overflow reset
// let an attacker who could emit >1000 distinct source IPs (trivial from one
// IPv6 /64) wipe their own lockout along with everyone else's.
export function createLoginRateLimiter({ max = 10, windowMs = 60000, maxEntries = 1000, now = Date.now } = {}) {
  const attempts = new Map(); // ip -> { count, ts } — ts is the window start

  function expired(rec) {
    return now() - rec.ts > windowMs;
  }

  function evictOldest() {
    let oldestKey;
    let oldestTs = Infinity;
    for (const [key, rec] of attempts) {
      if (rec.ts < oldestTs) { oldestTs = rec.ts; oldestKey = key; }
    }
    if (oldestKey !== undefined) attempts.delete(oldestKey);
  }

  return {
    // True while the ip is locked out (max failures within the current window).
    limited(ip) {
      const rec = attempts.get(ip);
      if (!rec) return false;
      if (expired(rec)) { attempts.delete(ip); return false; }
      return rec.count >= max;
    },
    // Record a failed attempt for the ip.
    fail(ip) {
      let rec = attempts.get(ip);
      if (!rec || expired(rec)) rec = { count: 0, ts: now() };
      rec.count += 1;
      if (!attempts.has(ip) && attempts.size >= maxEntries) evictOldest();
      attempts.set(ip, rec);
    },
    // A successful login clears the ip's failure history.
    succeed(ip) {
      attempts.delete(ip);
    },
    _size: () => attempts.size,
  };
}
