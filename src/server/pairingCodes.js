import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Short-lived, single-use device pairing codes: an authenticated browser
// session mints one (Settings → Devices), the Android app exchanges it for a
// device token (POST /api/devices/enroll { code }). This is the OAuth-mode
// (and passkey-only) enrollment path — there is no password to present there.
//
// A code is typed by a human off another screen, so the alphabet drops the
// ambiguous glyphs (0/O, 1/I — 32 symbols, so a masked byte is unbiased) and
// take() normalizes case and separators. 8 symbols = 40 bits: guessing is
// bounded by the login rate limiter (the enroll route feeds it), a 120s TTL,
// and at most `max` codes outstanding. Only the digest is held, compared with
// timingSafeEqual — same discipline as deviceStore.js.
//
// Bounded by simple oldest-first eviction, unlike passkeyChallenges.js's
// two-layer owner policy: minting requires an authenticated session, so there
// is no anonymous flood to defend against — the cap only keeps an operator
// mashing "Pair" from growing the array.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 chars — no 0/1/I/O
const digest = (s) => createHash('sha256').update(s).digest();
const canon = (raw) => String(raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

export function createPairingCodes({ ttlMs = 120_000, max = 4, now = Date.now } = {}) {
  const boundMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 4;
  const entries = []; // { hash, exp } — oldest first
  const reap = () => {
    const t = now();
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].exp <= t) entries.splice(i, 1);
  };
  return {
    mint() {
      reap();
      while (entries.length >= boundMax) entries.shift();
      const bytes = randomBytes(8);
      let code = '';
      for (let i = 0; i < 8; i++) code += ALPHABET[bytes[i] & 31];
      const exp = now() + ttlMs;
      entries.push({ hash: digest(code), exp });
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: exp };
    },
    // Deletes ONLY on a match: a wrong guess must not burn the operator's
    // in-flight code (the guesser doesn't hold it, so this spends nothing).
    take(raw) {
      reap();
      const d = digest(canon(raw));
      const idx = entries.findIndex((e) => timingSafeEqual(e.hash, d));
      if (idx === -1) return false;
      entries.splice(idx, 1);
      return true;
    },
    _size: () => { reap(); return entries.length; },
  };
}
