// Dependency-free WebAuthn verification, in the spirit of googleAuth.js. Scope
// is deliberately bounded: we request attestation "none", so no attestation
// statement is ever parsed — which is what keeps this small enough to own.
//
// Attacker-supplied CBOR appears ONLY in registration (the attestation
// object). The login assertion path decodes CBOR too — coseToKey re-parses the
// stored public key — but only bytes this server already verified and wrote
// itself at enrollment, never bytes from the request being authenticated.

import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

// Only the subset authenticators actually emit: unsigned ints, negative ints,
// byte strings, text strings, arrays, maps. Indefinite lengths, tags, floats
// and simple values are refused rather than guessed at.
function readUint(buf, pos, ai) {
  if (ai < 24) return [ai, pos];
  if (ai === 24) { if (pos + 1 > buf.length) throw new Error('cbor: truncated'); return [buf.readUInt8(pos), pos + 1]; }
  if (ai === 25) { if (pos + 2 > buf.length) throw new Error('cbor: truncated'); return [buf.readUInt16BE(pos), pos + 2]; }
  if (ai === 26) { if (pos + 4 > buf.length) throw new Error('cbor: truncated'); return [buf.readUInt32BE(pos), pos + 4]; }
  if (ai === 27) {
    if (pos + 8 > buf.length) throw new Error('cbor: truncated');
    const n = buf.readBigUInt64BE(pos);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer too large');
    return [Number(n), pos + 8];
  }
  throw new Error(`cbor: unsupported additional info ${ai}`);
}

// Legitimate attestation objects and COSE keys nest 2-3 levels deep at most,
// so this is generous headroom, not a tight fit. Without a bound, a buffer of
// a few thousand repeated single-element-array headers drives readItem's
// recursion past V8's stack limit — an uncontrolled RangeError instead of a
// clean, greppable rejection like every other error in this file.
const MAX_CBOR_DEPTH = 32;

function readItem(buf, pos, depth = 0) {
  if (depth > MAX_CBOR_DEPTH) throw new Error('cbor: nesting too deep');
  if (pos >= buf.length) throw new Error('cbor: truncated');
  const initial = buf[pos];
  const major = initial >> 5;
  const ai = initial & 0x1f;
  if (ai === 31) throw new Error('cbor: indefinite length not supported');
  const start = pos + 1;
  if (major === 0) { const [n, p] = readUint(buf, start, ai); return [n, p]; }
  if (major === 1) { const [n, p] = readUint(buf, start, ai); return [-1 - n, p]; }
  if (major === 2 || major === 3) {
    const [len, p] = readUint(buf, start, ai);
    if (p + len > buf.length) throw new Error('cbor: truncated');
    const slice = buf.subarray(p, p + len);
    return [major === 2 ? slice : slice.toString('utf8'), p + len];
  }
  if (major === 4) {
    const [len, p0] = readUint(buf, start, ai);
    const arr = [];
    let p = p0;
    for (let i = 0; i < len; i++) { const [v, np] = readItem(buf, p, depth + 1); arr.push(v); p = np; }
    return [arr, p];
  }
  if (major === 5) {
    const [len, p0] = readUint(buf, start, ai);
    const map = new Map();
    let p = p0;
    for (let i = 0; i < len; i++) {
      const [k, kp] = readItem(buf, p, depth + 1);
      const [v, vp] = readItem(buf, kp, depth + 1);
      if (map.has(k)) throw new Error('cbor: duplicate map key');
      map.set(k, v);
      p = vp;
    }
    return [map, p];
  }
  throw new Error(`cbor: unsupported major type ${major}`);
}

// `end` lets callers trim trailing bytes — the COSE public key inside attested
// credential data is followed by extension data when the ED flag is set.
export function cborDecodeFirst(buf) {
  const [value, end] = readItem(Buffer.from(buf), 0);
  return { value, end };
}

// COSE algorithm ids we advertise in pubKeyCredParams, in preference order.
export const SUPPORTED_ALGS = [-7, -257, -8];

const b64u = (b) => Buffer.from(b).toString('base64url');

// node:crypto's own JWK import is the last line of defense on key shape, but
// a rejection there surfaces as its own bare error (e.g. `TypeError: Invalid
// JWK EC key` for a syntactically valid but off-curve point) rather than this
// module's `cose: ...` convention. Every branch below imports through this
// helper so a caller only ever sees one error style, regardless of whether
// this module's manual checks or node:crypto's deeper import is what rejects
// the key.
function importCoseKey(label, jwk) {
  try {
    return createPublicKey({ key: jwk, format: 'jwk' });
  } catch (err) {
    throw new Error(`cose: invalid ${label} key material (${err.message})`);
  }
}

// COSE label numbers are context-dependent: for EC2/OKP keys -1 is the curve,
// -2/-3 are the coordinates; for RSA keys -1 is the modulus and -2 the
// exponent. They are spelled out per branch rather than shared as constants.
export function coseMapToKey(m) {
  if (!(m instanceof Map)) throw new Error('cose: not a map');
  const kty = m.get(1);
  const alg = m.get(3);
  if (!SUPPORTED_ALGS.includes(alg)) throw new Error(`cose: unsupported alg ${alg}`);
  if (alg === -7) {
    if (kty !== 2) throw new Error('cose: ES256 requires an EC2 key');
    if (m.get(-1) !== 1) throw new Error('cose: ES256 requires curve P-256');
    const x = m.get(-2);
    const y = m.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      throw new Error('cose: bad EC coordinates');
    }
    return { alg, key: importCoseKey('EC', { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }) };
  }
  if (alg === -257) {
    if (kty !== 3) throw new Error('cose: RS256 requires an RSA key');
    const n = m.get(-1);
    const e = m.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('cose: bad RSA parameters');
    // A registration attestation is attacker-influenced, and node:crypto's
    // JWK import performs no strength/sanity check of its own: a 1-byte or
    // even empty modulus, and an empty or all-zero exponent, all import
    // without error (confirmed against this project's Node version). Left
    // unchecked, a planted degenerate credential would be a durable backdoor.
    // 2048 bits is the project's floor (matches the modulus size the test
    // suite generates); a genuine RSA modulus of that size always has its top
    // bit set, so this never rejects a legitimate key.
    if (n.length < 256) throw new Error('cose: RSA modulus too small (must be at least 2048 bits)');
    // Buffer#every is vacuously true on an empty exponent, so this one check
    // also covers the empty case, not just all-zero.
    if (e.every((byte) => byte === 0)) throw new Error('cose: RSA exponent must be non-zero');
    return { alg, key: importCoseKey('RSA', { kty: 'RSA', n: b64u(n), e: b64u(e) }) };
  }
  if (kty !== 1) throw new Error('cose: EdDSA requires an OKP key');
  if (m.get(-1) !== 6) throw new Error('cose: EdDSA requires curve Ed25519');
  const x = m.get(-2);
  if (!Buffer.isBuffer(x) || x.length !== 32) throw new Error('cose: bad Ed25519 key');
  // Unlike EC2 above, there is no cheap way to check here that `x` is a valid
  // Ed25519 curve point (no coordinate-recovery-free membership test at this
  // layer, and node:crypto's OKP JWK import accepts any 32 bytes without
  // checking). An invalid point simply fails signature verification later,
  // which is fail-closed — this is a deliberate deferral, not an oversight.
  return { alg, key: importCoseKey('Ed25519', { kty: 'OKP', crv: 'Ed25519', x: b64u(x) }) };
}

export function coseToKey(bytes) {
  return coseMapToKey(cborDecodeFirst(bytes).value);
}

// The Relying Party id must equal the origin's hostname exactly — no wildcard
// or registrable-suffix matching, which a single-user deployment never needs.
// The port is ignored; the scheme is not.
export function makeOriginCheck(rpId) {
  const want = String(rpId).toLowerCase();
  return (origin) => {
    let u;
    try { u = new URL(String(origin)); } catch { return false; }
    const host = u.hostname.toLowerCase();
    if (host !== want) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && host === 'localhost');
  };
}

function parseAuthData(ad) {
  if (!Buffer.isBuffer(ad) || ad.length < 37) throw new Error('authenticator data too short');
  return { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33), rest: ad.subarray(37) };
}

// Real challenges in this project are 32 bytes. An expected challenge shorter
// than this floor is never legitimate — it means the caller lost track of the
// real value (e.g. an expired/missing session challenge defaulted to '' or
// something equally short) rather than that the presented one is merely
// wrong. Rejecting it here, before the byte comparison, closes a vacuous-match
// hole: a zero-length expected challenge would otherwise equal a zero-length
// presented one (including the empty buffer that base64url decoding of junk
// silently produces), which would make this check pass for literally any
// undecodable presented challenge.
const MIN_CHALLENGE_BYTES = 16;

// expectedChallenge must be the raw challenge bytes as a Buffer — the shape a
// server-side challenge store hands back. Every other shape is rejected here
// rather than guessed at, INCLUDING a base64url *string* (a plausible
// session-storage form): silently reading a string as UTF-8 used to produce
// a permanent, wrong-reason "challenge mismatch" (the decoded byte length
// never matches) instead of a message pointing at the real problem — the
// caller passed the wrong type. Buffer.from(x) itself throws a raw TypeError
// for null/undefined/number/plain-object input before the friendly message
// below ever runs — and null/undefined here is exactly the "expired or
// missing session challenge" scenario called out below — so every
// non-Buffer shape is folded into that same friendly "missing or too short"
// message instead of letting node:crypto's bare TypeError escape first.
function coerceChallengeBytes(expected) {
  return Buffer.isBuffer(expected) ? expected : null;
}

function assertChallenge(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'base64url');
  const b = coerceChallengeBytes(expected);
  if (!b || b.length < MIN_CHALLENGE_BYTES) throw new Error('expected challenge missing or too short');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('challenge mismatch');
}

// Single choke point for interpolating attacker-controlled clientData fields
// (type/origin) into a thrown message on this unauthenticated login path.
// Three independent hardenings, applied in order:
//   1. String(v) first, so a non-string value collapses to a short, fixed
//      representation (e.g. `[object Object]`) instead of JSON.stringify
//      recursively re-serializing an arbitrary attacker-controlled
//      structure — an object-valued `origin` was observed to produce a
//      10,319-character err.message this way (log amplification on this
//      unauthenticated path).
//   2. JSON.stringify the resulting string, which quotes it and escapes
//      embedded quotes/backslashes/LF/CR/TAB — then additionally escape
//      U+0085/U+2028/U+2029 as \uXXXX. JSON permits those three Unicode
//      line-breaking code points verbatim inside a string, so
//      JSON.stringify alone leaves them raw: a crafted value could still
//      split the message across two lines under Unicode line-breaking in a
//      terminal `tail -f` or a JS-based log viewer, even though \n/\r are
//      already closed by step 2 itself.
//   3. Truncate to a fixed bound, so no single field can blow up log size
//      regardless of the above — String() alone doesn't fully bound an
//      array (Array.prototype.toString joins elements rather than
//      collapsing to a fixed placeholder), so truncation is the actual
//      guarantee, not just a backstop for the plain-object case.
const MAX_LOGGED_FIELD = 120;
function sanitizeForLog(value) {
  const s = JSON.stringify(String(value))
    .replace(new RegExp(`[${String.fromCharCode(0x0085, 0x2028, 0x2029)}]`, 'g'), (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return s.length > MAX_LOGGED_FIELD ? `${s.slice(0, MAX_LOGGED_FIELD)}…(truncated)` : s;
}

function checkClientData(clientDataJSON, { type, expectedChallenge, originOk }) {
  let c;
  try {
    c = JSON.parse(clientDataJSON.toString('utf8'));
  } catch {
    throw new Error('malformed clientData: invalid JSON');
  }
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    throw new Error('malformed clientData: expected a JSON object');
  }
  if (c.type !== type) throw new Error(`unexpected clientData type ${sanitizeForLog(c.type)}`);
  assertChallenge(c.challenge, expectedChallenge);
  // A missing/non-function originOk is a caller wiring bug (e.g. an omitted
  // dependency-injection argument), not attacker input — but failing closed
  // here with a plain, greppable Error keeps this module's one-error-style
  // convention instead of letting `originOk(c.origin)` below throw node's own
  // bare `TypeError: originOk is not a function`.
  if (typeof originOk !== 'function') throw new Error('originOk must be a function');
  if (!originOk(c.origin)) throw new Error(`untrusted origin ${sanitizeForLog(c.origin)}`);
}

function checkAuthData(ad, { rpId, requireAttested = false }) {
  const parsed = parseAuthData(ad);
  // Normalized the same way makeOriginCheck normalizes the origin's hostname:
  // browsers hash whatever hostname they actually navigated to (canonically
  // lowercase) into rpIdHash, so a configured rp id with stray capitals must
  // be lowercased here too — otherwise it would pass the (already
  // case-insensitive) origin check and then permanently fail this one.
  const normalizedRpId = String(rpId).toLowerCase();
  if (!parsed.rpIdHash.equals(createHash('sha256').update(normalizedRpId).digest())) throw new Error('rp id mismatch');
  if (!(parsed.flags & 0x01)) throw new Error('user presence flag not set');
  if (!(parsed.flags & 0x04)) throw new Error('user verification flag not set');
  if (requireAttested && !(parsed.flags & 0x40)) throw new Error('no attested credential data');
  return parsed;
}

function signatureValid(alg, key, data, sig) {
  // Ed25519 signs the message directly; ES256/RS256 prehash with SHA-256. The
  // ECDSA signature is DER-encoded, which is node's default dsaEncoding.
  return cryptoVerify(alg === -8 ? null : 'sha256', data, key, sig);
}

export function verifyRegistration({ response, expectedChallenge, rpId, originOk }) {
  const clientDataJSON = Buffer.from(String(response?.clientDataJSON ?? ''), 'base64url');
  checkClientData(clientDataJSON, { type: 'webauthn.create', expectedChallenge, originOk });

  const { value: att } = cborDecodeFirst(Buffer.from(String(response?.attestationObject ?? ''), 'base64url'));
  if (!(att instanceof Map)) throw new Error('malformed attestation object');
  // We request attestation "none"; anything else would need real verification.
  // `fmt` is decoded straight from the untrusted attestationObject CBOR before
  // any other validation runs — exactly as attacker-controlled as clientData
  // type/origin below, which routes through the same sanitizeForLog for
  // precisely this reason (unsanitized, a crafted fmt can inject raw newlines
  // into a logged err.message, or blow it up to tens of thousands of chars).
  if (att.get('fmt') !== 'none') throw new Error(`unsupported attestation format: ${sanitizeForLog(att.get('fmt'))}`);

  const { rest, signCount } = checkAuthData(att.get('authData'), { rpId, requireAttested: true });
  // Attested credential data: 16-byte AAGUID, 2-byte id length, credential id,
  // then the COSE key (optionally followed by extension data).
  if (rest.length < 18) throw new Error('attested credential data too short');
  const idLen = rest.readUInt16BE(16);
  if (idLen === 0 || rest.length < 18 + idLen) throw new Error('attested credential data too short');
  const credentialId = rest.subarray(18, 18 + idLen);
  const coseBytes = rest.subarray(18 + idLen);
  const { value: coseMap, end } = cborDecodeFirst(coseBytes);
  const { alg } = coseMapToKey(coseMap);
  // Trim any bytes after the COSE key (present when the authenticator returns
  // extension data). This is NOT required for a later login to work: CBOR is
  // self-delimiting, so coseToKey/cborDecodeFirst decodes the same leading
  // COSE map either way and simply never notices an untrimmed trailer — an
  // untrimmed key still verifies signatures identically. The actual reason to
  // trim is bounded storage: without it, an attacker-supplied registration
  // could make the credential store persist arbitrary "extension data" after
  // the key forever.
  return { credentialId, publicKey: coseBytes.subarray(0, end), alg, signCount };
}

export function verifyAssertion({ response, expectedChallenge, rpId, originOk, publicKey, storedSignCount = 0 }) {
  const clientDataJSON = Buffer.from(String(response?.clientDataJSON ?? ''), 'base64url');
  checkClientData(clientDataJSON, { type: 'webauthn.get', expectedChallenge, originOk });
  const authData = Buffer.from(String(response?.authenticatorData ?? ''), 'base64url');
  const { signCount } = checkAuthData(authData, { rpId });
  const { alg, key } = coseToKey(Buffer.from(String(publicKey), 'base64url'));
  const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
  const sig = Buffer.from(String(response?.signature ?? ''), 'base64url');
  if (!signatureValid(alg, key, signed, sig)) throw new Error('bad signature');
  // storedSignCount round-trips through a JSON store file, where a missing or
  // reset numeric field commonly persists as null (or, via other bugs, NaN) —
  // ordinary store data, not attacker input. The `= 0` destructuring default
  // above only fires on `undefined`, so anything else non-numeric must be
  // rejected explicitly here rather than silently folded into a bare `> 0`
  // comparison: `null > 0` and `NaN > 0` are both false in JS, which would
  // otherwise disable the mandated cloned-authenticator check exactly as if
  // no count had ever been stored, letting a replayed (stalled) count through.
  //
  // The upper bound guards a different failure mode: `signCount` above is
  // read from authenticator data with `readUInt32BE`, so a genuine
  // authenticator can never report more than 0xFFFFFFFF. A stored value
  // above that ceiling (store corruption, or a future bug elsewhere) would
  // otherwise make `signCount <= storedSignCount` true forever, permanently
  // bricking the credential with "sign count did not increase" on every
  // future login attempt — silently mislabeling store corruption as a
  // cloned authenticator, exactly the failure mode this validation exists to
  // avoid. Rejecting it here reports it as what it is instead.
  if (
    typeof storedSignCount !== 'number' ||
    !Number.isInteger(storedSignCount) ||
    storedSignCount < 0 ||
    storedSignCount > 0xffffffff
  ) {
    throw new Error('invalid stored sign count');
  }
  // A counter that fails to advance means the credential was cloned. A pair of
  // zeroes is not a regression — many authenticators never implement it.
  if (storedSignCount > 0 && signCount <= storedSignCount) throw new Error('sign count did not increase');
  return { signCount };
}
