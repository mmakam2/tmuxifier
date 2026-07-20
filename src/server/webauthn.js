// Dependency-free WebAuthn verification, in the spirit of googleAuth.js. Scope
// is deliberately bounded: we request attestation "none", so no attestation
// statement is ever parsed — which is what keeps this small enough to own.
//
// CBOR appears ONLY in registration (the attestation object). The login
// assertion path below touches none of it.

import { createPublicKey } from 'node:crypto';

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
