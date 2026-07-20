import { test, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { cborDecodeFirst, coseToKey, SUPPORTED_ALGS, verifyAssertion, makeOriginCheck } from '../src/server/webauthn.js';
import { enc } from './helpers/cbor.js';
import { makeAuthenticator, makeAssertion, b64u, FLAG_UP, FLAG_UV } from './helpers/webauthnFixtures.js';

test('decodes unsigned and negative integers across width boundaries', () => {
  for (const n of [0, 23, 24, 255, 256, 65535, 65536, -1, -24, -25, -256]) {
    expect(cborDecodeFirst(enc(n)).value).toBe(n);
  }
});

test('decodes byte strings, text strings, arrays and maps', () => {
  expect(cborDecodeFirst(enc(Buffer.from('abc'))).value.equals(Buffer.from('abc'))).toBe(true);
  expect(cborDecodeFirst(enc('none')).value).toBe('none');
  expect(cborDecodeFirst(enc([1, 2, 3])).value).toEqual([1, 2, 3]);
  const m = cborDecodeFirst(enc(new Map([['fmt', 'none'], [1, 2]]))).value;
  expect(m.get('fmt')).toBe('none');
  expect(m.get(1)).toBe(2);
});

test('reports the offset just past the decoded item so trailing bytes can be trimmed', () => {
  const buf = Buffer.concat([enc(new Map([[1, 2]])), Buffer.from([0xff, 0xff])]);
  const { end } = cborDecodeFirst(buf);
  expect(end).toBe(buf.length - 2);
});

test('rejects indefinite-length items rather than guessing', () => {
  expect(() => cborDecodeFirst(Buffer.from([0x5f, 0xff]))).toThrow(/indefinite/);
});

test('rejects truncated input', () => {
  expect(() => cborDecodeFirst(Buffer.from([0x43, 0x01]))).toThrow(/truncated/);
});

test('rejects duplicate map keys', () => {
  expect(() => cborDecodeFirst(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(/duplicate/);
});

test('rejects unsupported major types (tags, floats, simple values)', () => {
  expect(() => cborDecodeFirst(Buffer.from([0xc0, 0x00]))).toThrow(/major type/);
  expect(() => cborDecodeFirst(Buffer.from([0xf5]))).toThrow(/major type/);
});

// Legitimate attestation objects and COSE keys nest 2-3 levels deep. 50
// repeated single-element-array headers is comfortably past any sane bound
// while still leaving plenty of buffer left over, so a wrong depth check
// would show up as either a missing throw or a "truncated" error instead of
// this one.
test('rejects excessively nested input with a descriptive error instead of overflowing the stack', () => {
  const buf = Buffer.concat([Buffer.alloc(50, 0x81), Buffer.from([0x00])]);
  expect(() => cborDecodeFirst(buf)).toThrow(/cbor: nesting too deep/);
});

// The shared test/helpers/cbor.js encoder tops out at the 4-byte (ai=26)
// length form because no existing fixture needs a value that large; these
// hand-roll the 8-byte (ai=27) header directly instead of growing the shared
// encoder for one edge case.
function u64Item(major, n) {
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

test('decodes a small value in the 8-byte (ai=27) form for both integer major types', () => {
  expect(cborDecodeFirst(u64Item(0, 42)).value).toBe(42);
  expect(cborDecodeFirst(u64Item(1, 42)).value).toBe(-43);
});

test('accepts an unsigned integer exactly at Number.MAX_SAFE_INTEGER in the 8-byte form', () => {
  expect(cborDecodeFirst(u64Item(0, Number.MAX_SAFE_INTEGER)).value).toBe(Number.MAX_SAFE_INTEGER);
});

test('rejects an unsigned integer one past Number.MAX_SAFE_INTEGER in the 8-byte form', () => {
  expect(() => cborDecodeFirst(u64Item(0, Number.MAX_SAFE_INTEGER + 1))).toThrow(/integer too large/);
});

test('the 8-byte integer-too-large guard also fires through the negative-integer major type', () => {
  expect(() => cborDecodeFirst(u64Item(1, Number.MAX_SAFE_INTEGER + 1))).toThrow(/integer too large/);
});

// `end` is what a later task uses to trim trailing extension data following a
// COSE public key. A COSE EC key's 32-byte X/Y coordinates need the
// multi-byte (ai=24) length header decoded correctly *inside a map* — the
// only existing `end` test above uses a flat, all-primitive map.
test('end is correct for a map containing a 32-byte byte string (the COSE coordinate shape)', () => {
  const coords = Buffer.alloc(32, 0xab);
  const encoded = enc(new Map([[-2, coords]]));
  // 1-byte map header + 1-byte key + (2-byte length header + 32 data bytes) value.
  expect(encoded.length).toBe(36);
  expect(cborDecodeFirst(encoded).end).toBe(36);

  const withTrailer = Buffer.concat([encoded, Buffer.from([0xff, 0xff])]);
  expect(cborDecodeFirst(withTrailer).end).toBe(36);
});

test('end is correct for a nested array/map/array structure', () => {
  const encoded = enc([new Map([[1, [2, 3]]])]);
  // outer array(1) header + map(1) header + key + inner array(2) header + 2 elements.
  expect(encoded.length).toBe(6);
  const { value, end } = cborDecodeFirst(encoded);
  expect(end).toBe(6);
  expect(value[0].get(1)).toEqual([2, 3]);

  const withTrailer = Buffer.concat([encoded, Buffer.from([0xff, 0xff])]);
  expect(cborDecodeFirst(withTrailer).end).toBe(6);
});

const b64uToBuf = (s) => Buffer.from(s, 'base64url');

function coseES256(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return enc(new Map([[1, 2], [3, -7], [-1, 1], [-2, b64uToBuf(jwk.x)], [-3, b64uToBuf(jwk.y)]]));
}

test('offers exactly ES256, RS256 and EdDSA', () => {
  expect(SUPPORTED_ALGS).toEqual([-7, -257, -8]);
});

test('imports an ES256 (EC2/P-256) COSE key', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { alg, key } = coseToKey(coseES256(publicKey));
  expect(alg).toBe(-7);
  expect(key.export({ format: 'jwk' }).x).toBe(publicKey.export({ format: 'jwk' }).x);
});

test('imports an RS256 COSE key', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = enc(new Map([[1, 3], [3, -257], [-1, b64uToBuf(jwk.n)], [-2, b64uToBuf(jwk.e)]]));
  expect(coseToKey(cose).alg).toBe(-257);
});

test('imports an EdDSA (OKP/Ed25519) COSE key', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = enc(new Map([[1, 1], [3, -8], [-1, 6], [-2, b64uToBuf(jwk.x)]]));
  expect(coseToKey(cose).alg).toBe(-8);
});

test('refuses an unsupported algorithm', () => {
  const cose = enc(new Map([[1, 2], [3, -36], [-1, 1], [-2, Buffer.alloc(32)], [-3, Buffer.alloc(32)]]));
  expect(() => coseToKey(cose)).toThrow(/unsupported alg/);
});

test('refuses an ES256 key on the wrong curve', () => {
  const cose = enc(new Map([[1, 2], [3, -7], [-1, 2], [-2, Buffer.alloc(32)], [-3, Buffer.alloc(32)]]));
  expect(() => coseToKey(cose)).toThrow(/P-256/);
});

test('refuses ES256 coordinates of the wrong length', () => {
  const cose = enc(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(31)], [-3, Buffer.alloc(32)]]));
  expect(() => coseToKey(cose)).toThrow(/coordinates/);
});

// A syntactically valid (correct curve id, correct 32-byte lengths) point
// that does not lie on P-256 sails past every manual check above and reaches
// node:crypto's own JWK import, which throws its own bare TypeError rather
// than one of this module's `cose: ...` errors. All-zero coordinates are not
// a point on P-256 (the curve's b parameter is nonzero, so x=0 has no y=0
// solution), so this exercises exactly that gap.
test('refuses an ES256 point of the right shape that is not on the P-256 curve', () => {
  const cose = enc(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32)], [-3, Buffer.alloc(32)]]));
  expect(() => coseToKey(cose)).toThrow(/^cose:/);
});

test('refuses an RSA modulus shorter than 2048 bits', () => {
  const cose = enc(new Map([
    [1, 3], [3, -257],
    [-1, Buffer.alloc(128, 0x01)], // 1024-bit modulus, well under the 256-byte floor
    [-2, Buffer.from([0x01, 0x00, 0x01])],
  ]));
  expect(() => coseToKey(cose)).toThrow(/cose:.*modulus/i);
});

test('refuses an empty RSA exponent', () => {
  const cose = enc(new Map([
    [1, 3], [3, -257],
    [-1, Buffer.alloc(256, 0x01)],
    [-2, Buffer.alloc(0)],
  ]));
  expect(() => coseToKey(cose)).toThrow(/cose:.*exponent/i);
});

test('refuses an all-zero RSA exponent', () => {
  const cose = enc(new Map([
    [1, 3], [3, -257],
    [-1, Buffer.alloc(256, 0x01)],
    [-2, Buffer.from([0x00])],
  ]));
  expect(() => coseToKey(cose)).toThrow(/cose:.*exponent/i);
});

const RP = 'tmux.example.com';
const ORIGIN = `https://${RP}`;
const originOk = makeOriginCheck(RP);
const CHALLENGE = Buffer.alloc(32, 7);

function verify(assertion, over = {}) {
  const auth = over.authenticator ?? AUTH;
  return verifyAssertion({
    response: assertion.response,
    // `??` would coalesce an explicitly-passed `null`/`undefined` right back
    // to CHALLENGE, masking exactly the caller-shaped-expectedChallenge cases
    // this file tests for. Default to CHALLENGE only when the caller omits
    // the field entirely.
    expectedChallenge: 'expectedChallenge' in over ? over.expectedChallenge : CHALLENGE,
    rpId: over.rpId ?? RP,
    originOk: over.originOk ?? originOk,
    publicKey: b64u(auth.cose),
    // `??` would coalesce an explicitly-passed `null`/`NaN` right back to 0,
    // masking exactly the storedSignCount coercion bug this file tests for.
    // Default to 0 only when the caller omits the field entirely, mirroring
    // verifyAssertion's own `storedSignCount = 0` destructuring default.
    storedSignCount: 'storedSignCount' in over ? over.storedSignCount : 0,
  });
}

const AUTH = makeAuthenticator();

test('accepts a well-formed assertion and reports the new sign count', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 4 });
  expect(verify(a)).toEqual({ signCount: 4 });
});

test('rejects a challenge that does not match', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: Buffer.alloc(32, 9), origin: ORIGIN, rpId: RP });
  expect(() => verify(a)).toThrow(/challenge/);
});

// An empty expected challenge must never behave as a wildcard: a route bug such
// as `Buffer.from(session.challenge ?? '', 'base64url')` (missing/expired
// session challenge) must still fail closed instead of accepting anything.
test('rejects an empty expected challenge instead of treating it as a wildcard match', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: Buffer.alloc(0), origin: ORIGIN, rpId: RP });
  expect(() => verify(a, { expectedChallenge: Buffer.alloc(0) })).toThrow(/challenge/);
});

test('rejects an expected challenge shorter than the minimum plausible length, even when it matches exactly', () => {
  const shortChallenge = Buffer.alloc(8, 7);
  const a = makeAssertion({ authenticator: AUTH, challenge: shortChallenge, origin: ORIGIN, rpId: RP });
  expect(() => verify(a, { expectedChallenge: shortChallenge })).toThrow(/challenge/);
});

// `expectedChallenge` normally arrives as a Buffer (what a session challenge
// store would hand back), but a caller can pass this function anything —
// most concretely, an expired/missing session challenge defaulting to
// `null`/`undefined`. `Buffer.from(expected)` used to throw node's own raw
// TypeError for these before the friendly "missing or too short" message
// ever got a chance to run; each of the next four tests pins one
// caller-shaped input to that same friendly message and a plain `Error`
// constructor instead.
test('rejects a null expected challenge with a plain Error, not a raw TypeError', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  let caught;
  try { verify(a, { expectedChallenge: null }); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
  expect(caught.message).toMatch(/challenge/);
});

test('rejects an undefined expected challenge with a plain Error, not a raw TypeError', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  let caught;
  try { verify(a, { expectedChallenge: undefined }); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
  expect(caught.message).toMatch(/challenge/);
});

test('rejects a numeric expected challenge with a plain Error, not a raw TypeError', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  let caught;
  try { verify(a, { expectedChallenge: 42 }); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
  expect(caught.message).toMatch(/challenge/);
});

test('rejects an object-valued expected challenge with a plain Error, not a raw TypeError', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  let caught;
  try { verify(a, { expectedChallenge: {} }); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
  expect(caught.message).toMatch(/challenge/);
});

// The accepted type for expectedChallenge is otherwise undocumented: a
// base64url *string* (a plausible session-storage form) was silently read as
// UTF-8 bytes, so it never matched the presented challenge — a permanent,
// wrong-reason "challenge mismatch" instead of a message pointing at the
// real problem (wrong type, not wrong bytes).
test('rejects a base64url string expected challenge rather than silently misreading it as UTF-8', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  let caught;
  try { verify(a, { expectedChallenge: CHALLENGE.toString('base64url') }); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
  // Pinned to the specific "missing or too short" wording, not just any
  // challenge-related message: reading the string as UTF-8 bytes (its old
  // behavior) produces a *different* byte length than the real 32-byte
  // challenge, which already throws a plain-Error "challenge mismatch" on
  // its own — so a loose /challenge/ match would stay green even without
  // this fix and prove nothing about the string case specifically.
  expect(caught.message).toMatch(/missing or too short/);
});

test('rejects an untrusted origin', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: 'https://evil.example.net', rpId: RP });
  expect(() => verify(a)).toThrow(/origin/);
});

test('rejects a missing originOk with a plain Error, not a raw "is not a function" TypeError', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  let caught;
  try {
    verifyAssertion({
      response: a.response,
      expectedChallenge: CHALLENGE,
      rpId: RP,
      // originOk intentionally omitted — a caller wiring bug, not attacker input.
      publicKey: b64u(AUTH.cose),
      storedSignCount: 0,
    });
  } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
  expect(caught.message).toMatch(/originOk/);
});

test('rejects authenticator data signed for a different rp id', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: 'other.example.com' });
  expect(() => verify(a)).toThrow(/rp id/);
});

// makeOriginCheck lowercases both sides of its comparison, but browsers always
// hash whatever hostname they actually navigated to (canonically lowercase)
// into rpIdHash. If a deployer's configured rp id has stray capitals, the
// origin check (already case-insensitive) must not be the only half that
// tolerates it — checkAuthData has to normalize the same way, or a mixed-case
// config permanently fails every real login despite passing the origin check.
test('rp id hashing normalizes case the same way the origin check does', () => {
  const configuredRpId = 'Passkey.Example.COM';
  const realHostname = configuredRpId.toLowerCase();
  const localOriginOk = makeOriginCheck(configuredRpId);
  const a = makeAssertion({
    authenticator: AUTH, challenge: CHALLENGE, origin: `https://${realHostname}`, rpId: realHostname, signCount: 4,
  });
  expect(verifyAssertion({
    response: a.response,
    expectedChallenge: CHALLENGE,
    rpId: configuredRpId,
    originOk: localOriginOk,
    publicKey: b64u(AUTH.cose),
    storedSignCount: 0,
  })).toEqual({ signCount: 4 });
});

test('rejects a clientData type of webauthn.create on the login path', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const cd = JSON.parse(Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'));
  cd.type = 'webauthn.create';
  a.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(cd), 'utf8'));
  expect(() => verify(a)).toThrow(/clientData type/);
});

// Unlike the mutated-signature version above, this response is signed AFTER
// setting type to webauthn.create, so the signature is fully valid over the
// real payload. It proves a genuine, otherwise-perfect registration ceremony
// response is refused on its own terms — not just a tampered assertion whose
// signature would have failed anyway regardless of the type check.
test('rejects a correctly-signed webauthn.create response on the login path', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, type: 'webauthn.create' });
  expect(() => verify(a)).toThrow(/clientData type/);
});

test('rejects malformed (empty) clientDataJSON with a plain Error, not a raw JSON parse error', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  a.response.clientDataJSON = '';
  let caught;
  try { verify(a); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
});

test('rejects a clientData payload that is valid JSON but not an object, with a plain Error', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  a.response.clientDataJSON = b64u(Buffer.from('null', 'utf8'));
  let caught;
  try { verify(a); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
});

// Arrays are `typeof 'object'` in JS, so the `null`/non-object guard above
// does not by itself catch a JSON array payload — that is what the dedicated
// Array.isArray branch is for. Pinned to its specific message so a
// regression that dropped just that branch (falling through to whatever
// `c.type`/`c.challenge` evaluate to on an array) doesn't go unnoticed.
test('rejects a clientData payload that is a JSON array rather than an object, with a plain Error', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  a.response.clientDataJSON = b64u(Buffer.from('[]', 'utf8'));
  let caught;
  try { verify(a); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).toBe(Error);
  expect(caught.message).toMatch(/expected a JSON object/);
});

// A crafted clientData field containing a real newline must not reach a
// thrown message verbatim: a route that logs err.message would otherwise let
// an unauthenticated caller forge extra log lines (log injection).
test('does not let an attacker-controlled clientData type inject a newline into the thrown message', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const cd = JSON.parse(Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'));
  cd.type = 'webauthn.get\nINJECTED LOG LINE: login succeeded for admin';
  a.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(cd), 'utf8'));
  let caught;
  try { verify(a); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.message).not.toContain('\n');
  // Pins this to the clientData-type check specifically — the plain string
  // 'bad signature' (or any other generic error) would also satisfy the two
  // assertions above, silently passing even if a regression dropped the
  // interpolation entirely or moved signature verification ahead of the
  // type/origin checks.
  expect(caught.message).toMatch(/clientData type/);
});

test('does not let an attacker-controlled clientData origin inject a newline into the thrown message', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const cd = JSON.parse(Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'));
  cd.origin = 'https://evil.example.net\nINJECTED LOG LINE: login succeeded for admin';
  a.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(cd), 'utf8'));
  let caught;
  try { verify(a); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.message).not.toContain('\n');
  // Pins this to the origin check specifically, for the same reason as above.
  expect(caught.message).toMatch(/untrusted origin/);
});

// JSON.stringify escapes LF/CR/TAB but leaves U+0085 (NEL), U+2028 (LINE
// SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) raw — JSON permits them
// verbatim inside a string. journald and line-oriented file loggers only
// break on LF, but a terminal `tail -f` or a JS-based log viewer still
// breaks a line on these.
test('does not let U+2028/U+2029/U+0085 line-separator characters survive raw in the thrown message', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const cd = JSON.parse(Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'));
  cd.origin = `https://evil.example.net${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}${String.fromCharCode(0x85)}INJECTED`;
  a.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(cd), 'utf8'));
  let caught;
  try { verify(a); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  // Built via fromCharCode/RegExp rather than a literal character class so
  // this test file itself contains no raw line-separator bytes.
  const lineBreakers = new RegExp(`[${String.fromCharCode(0x0085, 0x2028, 0x2029)}]`);
  expect(caught.message).not.toMatch(lineBreakers);
  expect(caught.message).toMatch(/untrusted origin/);
});

// An object-valued clientData field must not blow up the thrown message:
// JSON.stringify would otherwise recursively re-serialize arbitrary
// attacker-controlled structure (observed: a 10,319-character err.message
// from an object-valued origin) — log amplification on the unauthenticated
// login path.
test('bounds the thrown message length when clientData origin is an object rather than a string', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const cd = JSON.parse(Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'));
  cd.origin = { evil: 'x'.repeat(20000) };
  a.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(cd), 'utf8'));
  let caught;
  try { verify(a); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.message).toMatch(/untrusted origin/);
  expect(caught.message.length).toBeLessThan(300);
});

test('bounds the thrown message length when clientData type is an object rather than a string', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const cd = JSON.parse(Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'));
  cd.type = { evil: 'x'.repeat(20000) };
  a.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(cd), 'utf8'));
  let caught;
  try { verify(a); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.message).toMatch(/clientData type/);
  expect(caught.message.length).toBeLessThan(300);
});

test('rejects a missing user-presence flag', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, flags: FLAG_UV });
  expect(() => verify(a)).toThrow(/user presence/);
});

test('rejects a missing user-verification flag', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, flags: FLAG_UP });
  expect(() => verify(a)).toThrow(/user verification/);
});

test('rejects a tampered signature', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, tamper: 'signature' });
  expect(() => verify(a)).toThrow(/signature/);
});

test('rejects a signature made by a different key', () => {
  const other = makeAuthenticator();
  const a = makeAssertion({ authenticator: other, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  expect(() => verify(a)).toThrow(/signature/);
});

// A counter that fails to advance is the standard cloned-authenticator signal.
test('rejects a sign count that did not increase', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 3 });
  expect(() => verify(a, { storedSignCount: 3 })).toThrow(/sign count/);
});

// storedSignCount round-trips through a JSON store file, where a missing or
// reset numeric field commonly persists as null (or, via other bugs, NaN).
// The `storedSignCount = 0` destructuring default only fires on `undefined`,
// so a stored `null`/`NaN` is ordinary store data, not attacker input — and
// it must not silently disable the mandated cloned-authenticator check by
// coercing into whatever falls out of a bare `> 0` comparison.
test('rejects rather than silently disabling the counter check when the stored sign count is null', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 3 });
  expect(() => verify(a, { storedSignCount: null })).toThrow(/sign count/);
});

test('rejects rather than silently disabling the counter check when the stored sign count is NaN', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 3 });
  expect(() => verify(a, { storedSignCount: NaN })).toThrow(/sign count/);
});

// Plenty of authenticators never increment; zero-to-zero must stay usable.
test('accepts a sign count of zero when the stored count is also zero', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 0 });
  expect(verify(a, { storedSignCount: 0 })).toEqual({ signCount: 0 });
});

// The stored-count validation's individual branches (typeof/Number.isInteger/
// negative/upper-bound) are each pinned to the exact "invalid stored sign
// count" message rather than a generic "sign count" substring — some of
// these inputs also happen to trip the separate did-not-increase check below
// (e.g. `'3' > 0` and `3 <= '3'` both coerce truthy in JS, so a non-numeric
// string that skipped the type guard would still throw, just from the wrong
// check for the wrong reason), so a loose match would not actually prove the
// type guard fired.
test('rejects a negative stored sign count', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 3 });
  expect(() => verify(a, { storedSignCount: -1 })).toThrow(/invalid stored sign count/);
});

test('rejects a non-numeric string stored sign count', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 3 });
  expect(() => verify(a, { storedSignCount: '3' })).toThrow(/invalid stored sign count/);
});

// `signCount` is read from authenticator data with `readUInt32BE`, so a real
// authenticator can never report more than 0xFFFFFFFF. A stored value above
// that ceiling would otherwise make `signCount <= storedSignCount` true
// forever, permanently bricking the credential with "sign count did not
// increase" on every future login — silently mislabeling store corruption as
// a cloned authenticator, exactly the failure mode this validation exists to
// avoid. Pinned to the specific "invalid stored sign count" message: both of
// these inputs are large enough that the pre-fix did-not-increase check would
// *also* throw (just for the wrong reason), so a generic /sign count/ match
// alone would not catch a regression that dropped only the new upper-bound
// guard.
test('rejects a stored sign count above the uint32 max an authenticator counter can ever report', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 3 });
  expect(() => verify(a, { storedSignCount: 4294967296 })).toThrow(/invalid stored sign count/);
});

test('rejects Number.MAX_SAFE_INTEGER as a stored sign count', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 3 });
  expect(() => verify(a, { storedSignCount: Number.MAX_SAFE_INTEGER })).toThrow(/invalid stored sign count/);
});

test('the origin check requires an exact hostname match and https', () => {
  expect(originOk('https://tmux.example.com')).toBe(true);
  expect(originOk('https://tmux.example.com:8443')).toBe(true);
  expect(originOk('http://tmux.example.com')).toBe(false);
  expect(originOk('https://evil.tmux.example.com')).toBe(false);
  expect(originOk('https://tmux.example.com.evil.net')).toBe(false);
  expect(originOk('not a url')).toBe(false);
});

test('the origin check allows plain http only for localhost', () => {
  const local = makeOriginCheck('localhost');
  expect(local('http://localhost:7437')).toBe(true);
  expect(local('https://localhost')).toBe(true);
});
