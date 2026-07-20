import { randomBytes } from 'node:crypto';

// Short-lived, single-use WebAuthn challenges. Single use is what stops a
// captured (challenge, assertion) pair from being replayed inside the TTL.
//
// The map is bounded by evicting the entry expiring soonest — never by
// clearing it, which would let one caller wipe everyone else's in-flight
// sign-in. Same rule as rateLimit.js.
export function createPasskeyChallenges({ ttlMs = 120000, max = 64, now = Date.now } = {}) {
  // Clamp max to a valid positive integer; a degenerate max (0, NaN, negative, etc)
  // would either hang the eviction loop (max <= 0) or void the bounding guarantee (max is NaN).
  const boundMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 64;
  const entries = new Map(); // token -> { kind, challenge, exp }

  function reap() {
    const t = now();
    for (const [token, rec] of entries) if (rec.exp <= t) entries.delete(token);
  }

  function evictOldest() {
    let oldestToken;
    let oldestExp = Infinity;
    for (const [token, rec] of entries) {
      if (rec.exp < oldestExp) { oldestExp = rec.exp; oldestToken = token; }
    }
    if (oldestToken !== undefined) entries.delete(oldestToken);
  }

  return {
    issue(kind) {
      reap();
      while (entries.size >= boundMax) evictOldest();
      const token = randomBytes(24).toString('base64url');
      const challenge = randomBytes(32);
      entries.set(token, { kind, challenge, exp: now() + ttlMs });
      return { token, challenge };
    },
    // Deletes on every lookup, including a kind or expiry mismatch: a token is
    // spent the moment it is presented, however it is presented.
    take(token, kind) {
      const key = String(token ?? '');
      const rec = entries.get(key);
      if (!rec) return null;
      entries.delete(key);
      if (rec.kind !== kind || rec.exp <= now()) return null;
      return rec.challenge;
    },
    _size: () => entries.size,
  };
}
