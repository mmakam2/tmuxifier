import { randomBytes } from 'node:crypto';

// Short-lived, single-use WebAuthn challenges. Single use is what stops a
// captured (challenge, assertion) pair from being replayed inside the TTL.
//
// The map is bounded by a two-layer eviction policy, never by clearing it
// (which would let one caller wipe everyone else's in-flight sign-in):
//
//   1. Per-owner quota (maxPerOwner, default 3): an owner already at quota
//      evicts its OWN soonest-expiring entry before a new one is issued for
//      it. A caller retrying rapidly degrades only itself, never a stranger.
//   2. Global bound (max, default 64): once the map is actually full, evict
//      from whichever owner currently holds the MOST outstanding entries
//      (ties broken by soonest-expiring). A victim holding only one
//      challenge is the last thing evicted, not the first — the pre-fix
//      behavior (evict the single globally-soonest-expiring entry) meant
//      that at a uniform TTL the soonest-expiring entry is whichever was
//      issued first, i.e. the victim's, the moment an anonymous flood filled
//      the map.
//
// Residual limit, same as rateLimit.js: an attacker able to present enough
// distinct owner identities (e.g. source IPs) can still, in the limit, cause
// an eviction that reaches a specific victim. This raises the cost of
// evicting a chosen victim's challenge from "a single anonymous flood" to
// "sustained traffic from many distinct sources" — it does not make it
// impossible for a well-resourced attacker.
export function createPasskeyChallenges({ ttlMs = 120000, max = 64, maxPerOwner = 3, now = Date.now } = {}) {
  // Clamp both bounds to valid positive integers; a degenerate value (0,
  // NaN, negative, etc) would either hang an eviction loop (<= 0) or void
  // the bounding guarantee (NaN).
  const boundMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 64;
  const boundMaxPerOwner = Number.isFinite(maxPerOwner) && maxPerOwner > 0 ? Math.floor(maxPerOwner) : 3;
  const entries = new Map(); // token -> { kind, challenge, exp, owner }

  // A missing/empty owner is normalized to one shared bucket rather than
  // thrown on or given an unbounded bucket of its own — a caller with
  // nothing to attribute still gets quota-limited, just alongside every
  // other attributionless caller.
  function ownerKeyOf(owner) {
    return typeof owner === 'string' && owner.length > 0 ? owner : '';
  }

  function reap() {
    const t = now();
    for (const [token, rec] of entries) if (rec.exp <= t) entries.delete(token);
  }

  function countForOwner(ownerKey) {
    let n = 0;
    for (const rec of entries.values()) if (rec.owner === ownerKey) n++;
    return n;
  }

  // Evicts the single soonest-expiring entry belonging to one owner.
  function evictSoonestFor(ownerKey) {
    let target;
    let targetExp = Infinity;
    for (const [token, rec] of entries) {
      if (rec.owner === ownerKey && rec.exp < targetExp) { targetExp = rec.exp; target = token; }
    }
    if (target !== undefined) entries.delete(target);
  }

  // Evicts one entry from whichever owner currently holds the most
  // outstanding entries; ties go to the soonest-expiring among that group.
  function evictFromBusiestOwner() {
    const counts = new Map();
    for (const rec of entries.values()) counts.set(rec.owner, (counts.get(rec.owner) ?? 0) + 1);
    let busiest = 0;
    for (const n of counts.values()) if (n > busiest) busiest = n;
    let target;
    let targetExp = Infinity;
    for (const [token, rec] of entries) {
      if (counts.get(rec.owner) === busiest && rec.exp < targetExp) { targetExp = rec.exp; target = token; }
    }
    if (target !== undefined) entries.delete(target);
  }

  return {
    // `owner` is an opaque string the caller attributes this issuance to
    // (server.js passes req.ip). See the two-layer eviction policy above.
    issue(kind, { owner } = {}) {
      reap();
      const ownerKey = ownerKeyOf(owner);
      while (countForOwner(ownerKey) >= boundMaxPerOwner) evictSoonestFor(ownerKey);
      while (entries.size >= boundMax) evictFromBusiestOwner();
      const token = randomBytes(24).toString('base64url');
      const challenge = randomBytes(32);
      entries.set(token, { kind, challenge, exp: now() + ttlMs, owner: ownerKey });
      return { token, challenge };
    },
    // Deletes on every lookup, including a kind or expiry mismatch: within
    // this store, a token is spent the moment it is presented, however it is
    // presented. (Enrollment and login now run on separate store instances —
    // see server.js — so presenting a token from one ceremony's store to the
    // other doesn't spend anything here; it's simply absent from this map.)
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
