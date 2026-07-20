# Passkey (WebAuthn) Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a passkey login path alongside the existing password/Google sign-in, enrolled and managed from a new Settings → Passkeys tab.

**Architecture:** Three new dependency-free server modules — `webauthn.js` (pure verification), `passkeyStore.js` (`data/passkeys.json`), `passkeyChallenges.js` (bounded single-use challenge map) — plus routes in `server.js` that mint exactly the same session cookie the other two auth paths already mint. The web client gets a fetch/pure-helper module, a settings tab, and one extra button on the login screen. An opt-in "passkey only" toggle can disable the password/Google routes, guarded against lockout.

**Tech Stack:** Node 20+, ESM, Fastify 5, `node:crypto` (no new dependencies), TypeScript + Vite for the web client, Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-07-19-passkey-auth-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`). Node 20+.
- **No new runtime dependencies.** The repo has five; it keeps five.
- Server code is plain `.js`; web client code is `.ts`.
- TDD: write the failing test first. Tests use **real code, not mocks** — real keypairs, real signatures, real files in temp dirs.
- New modules are factory functions (`createX`) with dependencies injected as arguments.
- `npm test` runs `tsc --noEmit` over `src/web` **then** `vitest run`. Both must pass before any commit.
- The GitHub repo is public: tests and docs use `example.com`, RFC1918 IPs, and `you@example.com` — never real domains, IPs, hostnames, or emails.
- Conventional-commit messages (`feat(auth): …`, `test(webauthn): …`).
- WebAuthn constants used throughout: flag bits `UP = 0x01`, `UV = 0x04`, `AT = 0x40`. COSE algorithm ids: ES256 `-7`, EdDSA `-8`, RS256 `-257`.

## File Structure

**Create (server):**
- `src/server/webauthn.js` — pure verification: CBOR reader, COSE→KeyObject, `verifyAssertion`, `verifyRegistration`, `makeOriginCheck`. No I/O.
- `src/server/passkeyChallenges.js` — bounded, single-use, TTL'd challenge map.
- `src/server/passkeyStore.js` — `data/passkeys.json` CRUD plus the `passkeyOnly` flag.

**Create (web):**
- `src/web/passkeys.ts` — fetch layer, base64url ↔ bytes helpers, pure option/credential converters, `evaluateOrigin`.
- `src/web/settingsPasskeys.ts` — the Settings → Passkeys tab.

**Create (tests):**
- `test/helpers/cbor.js` — minimal CBOR **encoder** for building fixtures.
- `test/helpers/webauthnFixtures.js` — real keypairs, signed assertions, registration responses.
- `test/webauthn.test.js`, `test/passkeyChallenges.test.js`, `test/passkeyStore.test.js`, `test/passkeyRoutes.test.js`, `test/passkeysWeb.test.js`.

**Modify:**
- `src/server/config.js` — `rpId` resolution, `passkeyOnlyKillSwitch`, `requiredConfigError`.
- `src/server/server.js` — the seven new routes, `/api/auth/info` extension, passkey-only gating.
- `src/server/index.js` — construct and inject `passkeyStore`.
- `src/web/settingsUi.ts` — register the new tab.
- `src/web/main.ts` — the login-screen passkey button and the `passkey-only` error code.
- `src/web/style.css` — the passkey button.
- `test/config.test.js` — RP ID and kill-switch cases.
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `.env.example`, `docs/DEPLOY.md`.

---

### Task 1: RP ID resolution and the passkey-only kill switch

**Files:**
- Modify: `src/server/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveRpId({ explicit, publicUrl }) → { rpId: string | null, error: string | null }` exported from `config.js`; `config.rpId` (string or `null`), `config.rpIdError` (string or `null`), `config.passkeyOnlyKillSwitch` (boolean).

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.js`:

```js
test('rpId derives from the base external URL hostname', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_BASE_EXTERNAL_URL: 'https://tmux.example.com' }, cwd: '/app' });
  expect(c.rpId).toBe('tmux.example.com');
  expect(c.rpIdError).toBeNull();
});

test('an explicit TMUXIFIER_RP_ID wins over the derived hostname', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_BASE_EXTERNAL_URL: 'https://tmux.example.com', TMUXIFIER_RP_ID: 'Example.COM' }, cwd: '/app' });
  expect(c.rpId).toBe('example.com');
});

test('rpId falls back to localhost with no external URL', () => {
  expect(loadConfig({}, { env: {}, cwd: '/app' }).rpId).toBe('localhost');
});

// An IP-addressed deployment works today with password/Google sign-in. Passkeys
// are simply unavailable there; refusing to boot would be a regression.
test('an IP-derived rpId disables passkeys without failing configuration', () => {
  const c = loadConfig({}, { env: {
    TMUXIFIER_BASE_EXTERNAL_URL: 'https://192.168.1.10:7437',
    TMUXIFIER_COOKIE_SECRET: 's', TMUXIFIER_PASSWORD_HASH: 'h',
  }, cwd: '/app' });
  expect(c.rpId).toBeNull();
  expect(c.rpIdError).toBeNull();
  expect(requiredConfigError(c)).toBeNull();
});

// An explicit value is a stated intent that cannot work — fail loudly.
test('an explicit IP TMUXIFIER_RP_ID is a configuration error', () => {
  const c = loadConfig({}, { env: {
    TMUXIFIER_RP_ID: '192.168.1.10',
    TMUXIFIER_COOKIE_SECRET: 's', TMUXIFIER_PASSWORD_HASH: 'h',
  }, cwd: '/app' });
  expect(c.rpId).toBeNull();
  expect(c.rpIdError).toMatch(/domain name/);
  expect(requiredConfigError(c)).toMatch(/domain name/);
});

test('TMUXIFIER_PASSKEY_ONLY=off arms the break-glass kill switch', () => {
  expect(loadConfig({}, { env: {}, cwd: '/app' }).passkeyOnlyKillSwitch).toBe(false);
  expect(loadConfig({}, { env: { TMUXIFIER_PASSKEY_ONLY: 'off' }, cwd: '/app' }).passkeyOnlyKillSwitch).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `expected undefined to be 'tmux.example.com'`

- [ ] **Step 3: Implement RP ID resolution**

In `src/server/config.js`, add after the `normalizePublicUrl` function:

```js
// A WebAuthn Relying Party id must be a domain name — never an IP literal. Each
// label is 1-63 chars of letters/digits/hyphen and cannot start or end with a
// hyphen; the whole name is at most 253 chars.
const RP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function isValidRpId(host) {
  if (!host || host.length > 253) return false;
  if (!RP_ID_RE.test(host)) return false;
  // An all-numeric label chain is an IPv4 literal. IPv6 arrives from
  // URL.hostname wrapped in brackets and already fails RP_ID_RE.
  if (/^\d+(\.\d+)*$/.test(host)) return false;
  return true;
}

// The hostname passkeys are bound to. A passkey enrolled under one RP id is
// unusable under another, so this is derived from the URL the browser already
// uses rather than invented. An explicit value that cannot work is a hard
// error; a derived one that cannot work just disables the feature.
export function resolveRpId({ explicit, publicUrl }) {
  const stated = String(explicit ?? '').trim().toLowerCase();
  if (stated) {
    return isValidRpId(stated)
      ? { rpId: stated, error: null }
      : { rpId: null, error: `TMUXIFIER_RP_ID must be a domain name, not an IP address or URL: ${stated}` };
  }
  let host = '';
  try { host = publicUrl ? new URL(publicUrl).hostname.toLowerCase() : ''; } catch { host = ''; }
  if (!host) return { rpId: 'localhost', error: null };
  return { rpId: isValidRpId(host) ? host : null, error: null };
}
```

Add to `DEFAULTS`:

```js
  // WebAuthn passkeys. rpId is resolved below (see resolveRpId); the kill switch
  // is the .env break-glass that forces the stored passkey-only flag off.
  rpId: undefined,
  passkeyOnlyKillSwitch: undefined,
```

Add to the `envCfg` object literal, next to `authMode`:

```js
    rpId: e.TMUXIFIER_RP_ID,
    passkeyOnlyKillSwitch: e.TMUXIFIER_PASSKEY_ONLY,
```

Add immediately after the `merged.publicUrl = normalizePublicUrl(merged.publicUrl);` line:

```js
  // rpId === null means passkeys are unavailable at this deployment (an
  // IP-addressed one). rpIdError is set only for an explicit unusable value.
  const rp = resolveRpId({ explicit: merged.rpId, publicUrl: merged.publicUrl });
  merged.rpId = rp.rpId;
  merged.rpIdError = rp.error;
  merged.passkeyOnlyKillSwitch = /^(off|0|no|false)$/i.test(String(merged.passkeyOnlyKillSwitch ?? '').trim());
```

In `requiredConfigError`, add immediately after the `cookieSecret` check:

```js
  if (config.rpIdError) return config.rpIdError;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.js test/config.test.js
git commit -m "feat(config): resolve the WebAuthn RP id and passkey-only kill switch"
```

---

### Task 2: CBOR reader

**Files:**
- Create: `src/server/webauthn.js`
- Create: `test/helpers/cbor.js`
- Test: `test/webauthn.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `cborDecodeFirst(buf) → { value, end }` from `webauthn.js`, where `value` is a `number | Buffer | string | Array | Map` and `end` is the byte offset just past the decoded item. Test helper `enc(value) → Buffer` from `test/helpers/cbor.js`.

- [ ] **Step 1: Write the test helper (CBOR encoder for fixtures)**

Create `test/helpers/cbor.js`:

```js
// Minimal CBOR encoder, test-fixture use only. Mirrors exactly the subset the
// production reader accepts, so a fixture cannot accidentally exercise a
// feature the reader is supposed to reject.
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}

export function enc(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, val]) => [enc(k), enc(val)])]);
  throw new Error(`cbor fixture: unsupported value ${String(v)}`);
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/webauthn.test.js`:

```js
import { test, expect } from 'vitest';
import { cborDecodeFirst } from '../src/server/webauthn.js';
import { enc } from './helpers/cbor.js';

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/webauthn.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/webauthn.js"`

- [ ] **Step 4: Implement the reader**

Create `src/server/webauthn.js`:

```js
// Dependency-free WebAuthn verification, in the spirit of googleAuth.js. Scope
// is deliberately bounded: we request attestation "none", so no attestation
// statement is ever parsed — which is what keeps this small enough to own.
//
// CBOR appears ONLY in registration (the attestation object). The login
// assertion path below touches none of it.

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

function readItem(buf, pos) {
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
    for (let i = 0; i < len; i++) { const [v, np] = readItem(buf, p); arr.push(v); p = np; }
    return [arr, p];
  }
  if (major === 5) {
    const [len, p0] = readUint(buf, start, ai);
    const map = new Map();
    let p = p0;
    for (let i = 0; i < len; i++) {
      const [k, kp] = readItem(buf, p);
      const [v, vp] = readItem(buf, kp);
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/webauthn.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/webauthn.js test/helpers/cbor.js test/webauthn.test.js
git commit -m "feat(webauthn): minimal CBOR reader for attestation objects"
```

---

### Task 3: COSE public key import

**Files:**
- Modify: `src/server/webauthn.js`
- Test: `test/webauthn.test.js`

**Interfaces:**
- Consumes: `cborDecodeFirst` (Task 2).
- Produces: `SUPPORTED_ALGS = [-7, -257, -8]`, `coseMapToKey(map) → { alg: number, key: KeyObject }`, `coseToKey(bytes) → { alg, key }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/webauthn.test.js` (extend the import line to `import { cborDecodeFirst, coseToKey, SUPPORTED_ALGS } from '../src/server/webauthn.js';`):

```js
import { generateKeyPairSync } from 'node:crypto';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webauthn.test.js`
Expected: FAIL — `coseToKey is not a function`

- [ ] **Step 3: Implement COSE import**

Append to `src/server/webauthn.js`:

```js
import { createPublicKey } from 'node:crypto';

// COSE algorithm ids we advertise in pubKeyCredParams, in preference order.
export const SUPPORTED_ALGS = [-7, -257, -8];

const b64u = (b) => Buffer.from(b).toString('base64url');

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
    return { alg, key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' }) };
  }
  if (alg === -257) {
    if (kty !== 3) throw new Error('cose: RS256 requires an RSA key');
    const n = m.get(-1);
    const e = m.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('cose: bad RSA parameters');
    return { alg, key: createPublicKey({ key: { kty: 'RSA', n: b64u(n), e: b64u(e) }, format: 'jwk' }) };
  }
  if (kty !== 1) throw new Error('cose: EdDSA requires an OKP key');
  if (m.get(-1) !== 6) throw new Error('cose: EdDSA requires curve Ed25519');
  const x = m.get(-2);
  if (!Buffer.isBuffer(x) || x.length !== 32) throw new Error('cose: bad Ed25519 key');
  return { alg, key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(x) }, format: 'jwk' }) };
}

export function coseToKey(bytes) {
  return coseMapToKey(cborDecodeFirst(bytes).value);
}
```

Move the `import { createPublicKey } from 'node:crypto';` line to the top of the file with the other imports (ESM hoists it either way, but keep imports grouped).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webauthn.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/webauthn.js test/webauthn.test.js
git commit -m "feat(webauthn): import COSE public keys (ES256, RS256, EdDSA)"
```

---

### Task 4: Assertion verification (the login path)

**Files:**
- Modify: `src/server/webauthn.js`
- Create: `test/helpers/webauthnFixtures.js`
- Test: `test/webauthn.test.js`

**Interfaces:**
- Consumes: `coseToKey` (Task 3).
- Produces: `makeOriginCheck(rpId) → (origin: string) => boolean`; `verifyAssertion({ response, expectedChallenge, rpId, originOk, publicKey, storedSignCount }) → { signCount: number }`, throwing on any failure. `publicKey` is the stored base64url COSE key. Test helpers `makeAuthenticator`, `buildAuthData`, `buildClientData`, `makeAssertion`, `b64u` from `test/helpers/webauthnFixtures.js`.

- [ ] **Step 1: Write the fixture helper**

Create `test/helpers/webauthnFixtures.js`:

```js
// Real keypairs and real signatures — no mocks. A fixture authenticator behaves
// like the genuine article, so a verifier bug shows up as a failing test rather
// than a passing one against a hand-waved stub.
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { enc } from './cbor.js';

export const b64u = (b) => Buffer.from(b).toString('base64url');

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

export function makeAuthenticator({ credentialId = Buffer.from('cred-0001') } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = enc(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  return { credentialId, privateKey, publicKey, cose, id: b64u(credentialId) };
}

export function buildAuthData({ rpId, flags, signCount = 0, attested = null }) {
  const head = Buffer.alloc(37);
  createHash('sha256').update(rpId).digest().copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(signCount, 33);
  if (!attested) return head;
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(attested.credentialId.length, 0);
  return Buffer.concat([head, Buffer.alloc(16), idLen, attested.credentialId, attested.cose]);
}

export function buildClientData({ type, challenge, origin }) {
  return Buffer.from(JSON.stringify({ type, challenge: b64u(challenge), origin, crossOrigin: false }), 'utf8');
}

function esSign(privateKey, data) {
  return createSign('sha256').update(data).sign(privateKey);
}

export function makeAssertion({
  authenticator, challenge, origin, rpId,
  signCount = 1, flags = FLAG_UP | FLAG_UV, tamper = null,
}) {
  const authData = buildAuthData({ rpId, flags, signCount });
  const clientDataJSON = buildClientData({ type: 'webauthn.get', challenge, origin });
  const signature = esSign(authenticator.privateKey, Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]));
  if (tamper === 'signature') signature[signature.length - 1] ^= 0xff;
  return {
    id: authenticator.id,
    type: 'public-key',
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authData),
      signature: b64u(signature),
      userHandle: null,
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `test/webauthn.test.js` (extend the production import to also pull in `verifyAssertion, makeOriginCheck`):

```js
import { makeAuthenticator, makeAssertion, b64u, FLAG_UP, FLAG_UV } from './helpers/webauthnFixtures.js';

const RP = 'tmux.example.com';
const ORIGIN = `https://${RP}`;
const originOk = makeOriginCheck(RP);
const CHALLENGE = Buffer.alloc(32, 7);

function verify(assertion, over = {}) {
  const auth = over.authenticator ?? AUTH;
  return verifyAssertion({
    response: assertion.response,
    expectedChallenge: over.expectedChallenge ?? CHALLENGE,
    rpId: over.rpId ?? RP,
    originOk: over.originOk ?? originOk,
    publicKey: b64u(auth.cose),
    storedSignCount: over.storedSignCount ?? 0,
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

test('rejects an untrusted origin', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: 'https://evil.example.net', rpId: RP });
  expect(() => verify(a)).toThrow(/origin/);
});

test('rejects authenticator data signed for a different rp id', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: 'other.example.com' });
  expect(() => verify(a)).toThrow(/rp id/);
});

test('rejects a clientData type of webauthn.create on the login path', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const cd = JSON.parse(Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'));
  cd.type = 'webauthn.create';
  a.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(cd), 'utf8'));
  expect(() => verify(a)).toThrow(/clientData type/);
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

// Plenty of authenticators never increment; zero-to-zero must stay usable.
test('accepts a sign count of zero when the stored count is also zero', () => {
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 0 });
  expect(verify(a, { storedSignCount: 0 })).toEqual({ signCount: 0 });
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/webauthn.test.js`
Expected: FAIL — `verifyAssertion is not a function`

- [ ] **Step 4: Implement assertion verification**

Append to `src/server/webauthn.js` (and extend the `node:crypto` import to `import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';`):

```js
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

function assertChallenge(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'base64url');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('challenge mismatch');
}

function checkClientData(clientDataJSON, { type, expectedChallenge, originOk }) {
  const c = JSON.parse(clientDataJSON.toString('utf8'));
  if (c.type !== type) throw new Error(`unexpected clientData type ${c.type}`);
  assertChallenge(c.challenge, expectedChallenge);
  if (!originOk(c.origin)) throw new Error(`untrusted origin ${c.origin}`);
}

function checkAuthData(ad, { rpId, requireAttested = false }) {
  const parsed = parseAuthData(ad);
  if (!parsed.rpIdHash.equals(createHash('sha256').update(rpId).digest())) throw new Error('rp id mismatch');
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

export function verifyAssertion({ response, expectedChallenge, rpId, originOk, publicKey, storedSignCount = 0 }) {
  const clientDataJSON = Buffer.from(String(response?.clientDataJSON ?? ''), 'base64url');
  checkClientData(clientDataJSON, { type: 'webauthn.get', expectedChallenge, originOk });
  const authData = Buffer.from(String(response?.authenticatorData ?? ''), 'base64url');
  const { signCount } = checkAuthData(authData, { rpId });
  const { alg, key } = coseToKey(Buffer.from(String(publicKey), 'base64url'));
  const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
  const sig = Buffer.from(String(response?.signature ?? ''), 'base64url');
  if (!signatureValid(alg, key, signed, sig)) throw new Error('bad signature');
  // A counter that fails to advance means the credential was cloned. A pair of
  // zeroes is not a regression — many authenticators never implement it.
  if (storedSignCount > 0 && signCount <= storedSignCount) throw new Error('sign count did not increase');
  return { signCount };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/webauthn.test.js`
Expected: PASS, 27 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/webauthn.js test/helpers/webauthnFixtures.js test/webauthn.test.js
git commit -m "feat(webauthn): verify login assertions"
```

---

### Task 5: Registration verification

**Files:**
- Modify: `src/server/webauthn.js`
- Modify: `test/helpers/webauthnFixtures.js`
- Test: `test/webauthn.test.js`

**Interfaces:**
- Consumes: `cborDecodeFirst`, `coseMapToKey`, the shared `checkClientData`/`checkAuthData` helpers (Task 4).
- Produces: `verifyRegistration({ response, expectedChallenge, rpId, originOk }) → { credentialId: Buffer, publicKey: Buffer, alg: number, signCount: number }`, throwing on any failure. Test helper `makeRegistration`.

- [ ] **Step 1: Extend the fixture helper**

Append to `test/helpers/webauthnFixtures.js`:

```js
export function makeRegistration({
  authenticator, challenge, origin, rpId,
  fmt = 'none', flags = FLAG_UP | FLAG_UV | FLAG_AT, signCount = 0,
}) {
  const authData = buildAuthData({
    rpId, flags, signCount,
    attested: { credentialId: authenticator.credentialId, cose: authenticator.cose },
  });
  const clientDataJSON = buildClientData({ type: 'webauthn.create', challenge, origin });
  const attestationObject = enc(new Map([['fmt', fmt], ['attStmt', new Map()], ['authData', authData]]));
  return {
    id: authenticator.id,
    type: 'public-key',
    response: {
      clientDataJSON: b64u(clientDataJSON),
      attestationObject: b64u(attestationObject),
      transports: ['internal', 'hybrid'],
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `test/webauthn.test.js` (extend both import lines with `verifyRegistration` and `makeRegistration, FLAG_AT`):

```js
function verifyReg(reg, over = {}) {
  return verifyRegistration({
    response: reg.response,
    expectedChallenge: over.expectedChallenge ?? CHALLENGE,
    rpId: over.rpId ?? RP,
    originOk: over.originOk ?? originOk,
  });
}

test('accepts a well-formed registration and returns the credential and key', () => {
  const r = makeRegistration({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const out = verifyReg(r);
  expect(out.credentialId.equals(AUTH.credentialId)).toBe(true);
  expect(out.publicKey.equals(AUTH.cose)).toBe(true);
  expect(out.alg).toBe(-7);
  expect(out.signCount).toBe(0);
});

// We ask for attestation "none". Any other format would have to be verified to
// be meaningful, so accepting it unverified is worse than refusing it.
test('refuses an attestation format other than none', () => {
  const r = makeRegistration({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, fmt: 'packed' });
  expect(() => verifyReg(r)).toThrow(/attestation format/);
});

test('rejects a registration challenge that does not match', () => {
  const r = makeRegistration({ authenticator: AUTH, challenge: Buffer.alloc(32, 9), origin: ORIGIN, rpId: RP });
  expect(() => verifyReg(r)).toThrow(/challenge/);
});

test('rejects a registration from an untrusted origin', () => {
  const r = makeRegistration({ authenticator: AUTH, challenge: CHALLENGE, origin: 'https://evil.example.net', rpId: RP });
  expect(() => verifyReg(r)).toThrow(/origin/);
});

test('rejects a clientData type of webauthn.get on the registration path', () => {
  const r = makeRegistration({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const cd = JSON.parse(Buffer.from(r.response.clientDataJSON, 'base64url').toString('utf8'));
  cd.type = 'webauthn.get';
  r.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(cd), 'utf8'));
  expect(() => verifyReg(r)).toThrow(/clientData type/);
});

test('rejects a registration without the attested-credential-data flag', () => {
  const r = makeRegistration({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, flags: FLAG_UP | FLAG_UV });
  expect(() => verifyReg(r)).toThrow(/attested credential data/);
});

test('rejects a registration without user verification', () => {
  const r = makeRegistration({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, flags: FLAG_UP | FLAG_AT });
  expect(() => verifyReg(r)).toThrow(/user verification/);
});

// The key it returns must be the one that later verifies logins.
test('the returned public key verifies a subsequent assertion', () => {
  const r = makeRegistration({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP });
  const { publicKey } = verifyReg(r);
  const a = makeAssertion({ authenticator: AUTH, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, signCount: 2 });
  expect(verifyAssertion({
    response: a.response, expectedChallenge: CHALLENGE, rpId: RP, originOk,
    publicKey: b64u(publicKey), storedSignCount: 1,
  })).toEqual({ signCount: 2 });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/webauthn.test.js`
Expected: FAIL — `verifyRegistration is not a function`

- [ ] **Step 4: Implement registration verification**

Append to `src/server/webauthn.js`:

```js
export function verifyRegistration({ response, expectedChallenge, rpId, originOk }) {
  const clientDataJSON = Buffer.from(String(response?.clientDataJSON ?? ''), 'base64url');
  checkClientData(clientDataJSON, { type: 'webauthn.create', expectedChallenge, originOk });

  const { value: att } = cborDecodeFirst(Buffer.from(String(response?.attestationObject ?? ''), 'base64url'));
  if (!(att instanceof Map)) throw new Error('malformed attestation object');
  // We request attestation "none"; anything else would need real verification.
  if (att.get('fmt') !== 'none') throw new Error(`unsupported attestation format: ${att.get('fmt')}`);

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
  // Trim any trailing extension data so the stored key is exactly the COSE key.
  return { credentialId, publicKey: coseBytes.subarray(0, end), alg, signCount };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites green (35 tests in `webauthn.test.js`).

- [ ] **Step 6: Commit**

```bash
git add src/server/webauthn.js test/helpers/webauthnFixtures.js test/webauthn.test.js
git commit -m "feat(webauthn): verify passkey registrations"
```

---

### Task 6: Challenge store

**Files:**
- Create: `src/server/passkeyChallenges.js`
- Test: `test/passkeyChallenges.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createPasskeyChallenges({ ttlMs, max, now }) → { issue(kind) → { token: string, challenge: Buffer }, take(token, kind) → Buffer | null, _size() → number }`.

- [ ] **Step 1: Write the failing tests**

Create `test/passkeyChallenges.test.js`:

```js
import { test, expect } from 'vitest';
import { createPasskeyChallenges } from '../src/server/passkeyChallenges.js';

test('issues a 32-byte challenge with an opaque token', () => {
  const c = createPasskeyChallenges();
  const { token, challenge } = c.issue('auth');
  expect(challenge).toHaveLength(32);
  expect(typeof token).toBe('string');
  expect(token.length).toBeGreaterThan(20);
});

test('round-trips a challenge exactly once', () => {
  const c = createPasskeyChallenges();
  const { token, challenge } = c.issue('auth');
  expect(c.take(token, 'auth').equals(challenge)).toBe(true);
  expect(c.take(token, 'auth')).toBeNull();
});

test('refuses a token issued for a different kind, and burns it', () => {
  const c = createPasskeyChallenges();
  const { token } = c.issue('reg');
  expect(c.take(token, 'auth')).toBeNull();
  expect(c.take(token, 'reg')).toBeNull();
});

test('refuses an unknown token', () => {
  expect(createPasskeyChallenges().take('nope', 'auth')).toBeNull();
});

test('refuses an expired challenge', () => {
  let t = 1000;
  const c = createPasskeyChallenges({ ttlMs: 500, now: () => t });
  const { token } = c.issue('auth');
  t += 501;
  expect(c.take(token, 'auth')).toBeNull();
});

test('reaps expired entries when issuing', () => {
  let t = 1000;
  const c = createPasskeyChallenges({ ttlMs: 500, now: () => t });
  c.issue('auth');
  c.issue('auth');
  expect(c._size()).toBe(2);
  t += 501;
  c.issue('auth');
  expect(c._size()).toBe(1);
});

// These endpoints are unauthenticated, so an unbounded map is a memory lever.
test('stays bounded by evicting the oldest entry', () => {
  let t = 1000;
  const c = createPasskeyChallenges({ max: 3, now: () => { t += 1; return t; } });
  const first = c.issue('auth');
  c.issue('auth');
  c.issue('auth');
  c.issue('auth');
  expect(c._size()).toBe(3);
  expect(c.take(first.token, 'auth')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/passkeyChallenges.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/passkeyChallenges.js"`

- [ ] **Step 3: Implement the challenge store**

Create `src/server/passkeyChallenges.js`:

```js
import { randomBytes } from 'node:crypto';

// Short-lived, single-use WebAuthn challenges. Single use is what stops a
// captured (challenge, assertion) pair from being replayed inside the TTL.
//
// The map is bounded by evicting the entry expiring soonest — never by
// clearing it, which would let one caller wipe everyone else's in-flight
// sign-in. Same rule as rateLimit.js.
export function createPasskeyChallenges({ ttlMs = 120000, max = 64, now = Date.now } = {}) {
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
      while (entries.size >= max) evictOldest();
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/passkeyChallenges.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/passkeyChallenges.js test/passkeyChallenges.test.js
git commit -m "feat(passkeys): bounded single-use challenge store"
```

---

### Task 7: Credential store

**Files:**
- Create: `src/server/passkeyStore.js`
- Test: `test/passkeyStore.test.js`

**Interfaces:**
- Consumes: `readJson`, `writeJson` from `jsonFile.js`.
- Produces: `createPasskeyStore({ dataDir, now, log })` with async methods `list()`, `listRaw()`, `add(cred, { rpId })`, `remove(id) → { removed, disarmed }`, `touch(id, { signCount })`, `getRpId()`, `getUserHandle()`, `getPasskeyOnly()`, `setPasskeyOnly(enabled)`. A stored credential is `{ id, publicKey, alg, signCount, label, transports, created, lastUsed }`; `list()` returns the public view `{ id, label, created, lastUsed, transports }`.

- [ ] **Step 1: Write the failing tests**

Create `test/passkeyStore.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPasskeyStore } from '../src/server/passkeyStore.js';

let dir, store;
const CRED = { id: 'cred-a', publicKey: 'cose-a', alg: -7, signCount: 0, label: 'Laptop', transports: ['internal'] };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pk-'));
  store = createPasskeyStore({ dataDir: dir, now: () => 1700000000000 });
});

test('starts empty and unpinned', async () => {
  expect(await store.list()).toEqual([]);
  expect(await store.getRpId()).toBeNull();
  expect(await store.getPasskeyOnly()).toBe(false);
});

test('adds a credential and returns only the public view', async () => {
  const view = await store.add(CRED, { rpId: 'tmux.example.com' });
  expect(view).toEqual({ id: 'cred-a', label: 'Laptop', created: 1700000000000, lastUsed: null, transports: ['internal'] });
  expect(JSON.stringify(await store.list())).not.toContain('cose-a');
  expect((await store.listRaw())[0].publicKey).toBe('cose-a');
});

test('pins the rp id on the first enrollment and never overwrites it', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.add({ ...CRED, id: 'cred-b' }, { rpId: 'other.example.com' });
  expect(await store.getRpId()).toBe('tmux.example.com');
});

// Re-enrolling the same authenticator must replace, not duplicate.
test('upserts by credential id', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.add({ ...CRED, label: 'Renamed' }, { rpId: 'tmux.example.com' });
  const list = await store.list();
  expect(list).toHaveLength(1);
  expect(list[0].label).toBe('Renamed');
});

test('touch records the new sign count and last-used time', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.touch('cred-a', { signCount: 9 });
  expect((await store.listRaw())[0].signCount).toBe(9);
  expect((await store.list())[0].lastUsed).toBe(1700000000000);
});

// verifyAssertion rejects a non-numeric stored count, so a record whose
// signCount persisted as null must not reach it — that would turn a valid
// passkey into a permanent 401.
test('listRaw normalizes a missing or null sign count to 0', async () => {
  await store.add({ ...CRED, signCount: null }, { rpId: 'tmux.example.com' });
  expect((await store.listRaw())[0].signCount).toBe(0);
  await store.add({ id: 'cred-b', publicKey: 'cose-b', alg: -7, label: 'B', transports: [] }, { rpId: 'tmux.example.com' });
  expect((await store.listRaw()).find((c) => c.id === 'cred-b').signCount).toBe(0);
});

test('remove reports whether anything was removed', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  expect(await store.remove('nope')).toEqual({ removed: false, disarmed: false });
  expect(await store.remove('cred-a')).toEqual({ removed: true, disarmed: false });
  expect(await store.list()).toEqual([]);
});

test('refuses to arm passkey-only with no credential enrolled', async () => {
  await expect(store.setPasskeyOnly(true)).rejects.toThrow(/enroll a passkey/);
});

test('arms passkey-only once a credential exists', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  expect(await store.setPasskeyOnly(true)).toBe(true);
  expect(await store.getPasskeyOnly()).toBe(true);
});

// Anti-lockout guard: deleting the last passkey must not leave the toggle armed
// with nothing able to satisfy it.
test('removing the last credential disarms passkey-only and clears the pin', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  await store.setPasskeyOnly(true);
  expect(await store.remove('cred-a')).toEqual({ removed: true, disarmed: true });
  expect(await store.getPasskeyOnly()).toBe(false);
  expect(await store.getRpId()).toBeNull();
});

test('generates a stable user handle once', async () => {
  const a = await store.getUserHandle();
  expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(await store.getUserHandle()).toBe(a);
});

test('writes the file owner-only', async () => {
  await store.add(CRED, { rpId: 'tmux.example.com' });
  const st = await fs.stat(path.join(dir, 'passkeys.json'));
  expect(st.mode & 0o777).toBe(0o600);
});

// A corrupt store fails OPEN: the armed state is unrecoverable from a
// quarantined file, and failing closed would brick fleet access on a disk
// glitch. See the spec's "corrupt store fails open" section.
test('quarantines a corrupt file and starts empty', async () => {
  const file = path.join(dir, 'passkeys.json');
  await fs.writeFile(file, '{ not json');
  const warnings = [];
  const s = createPasskeyStore({ dataDir: dir, log: (m) => warnings.push(m) });
  expect(await s.list()).toEqual([]);
  expect(await s.getPasskeyOnly()).toBe(false);
  expect(warnings.join(' ')).toMatch(/unreadable/);
  const left = await fs.readdir(dir);
  expect(left.some((f) => f.startsWith('passkeys.json.corrupt-'))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/passkeyStore.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/passkeyStore.js"`

- [ ] **Step 3: Implement the store**

Create `src/server/passkeyStore.js`:

```js
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;
const EMPTY = { version: VERSION, passkeyOnly: false, rpId: null, userHandle: null, credentials: [] };

// Enrolled passkeys (data/passkeys.json). Public keys are not secrets, so
// nothing here is sealed by secretBox — but the file is still written 0o600 and
// inherits jsonFile.js's atomic rename and corrupt-file quarantine.
//
// A corrupt store therefore reads as empty, which also disarms passkeyOnly.
// That is deliberate: see the design doc. Failing closed would brick fleet
// access on a disk glitch, and whoever can corrupt this file can already read
// the password hash from .env on the same disk.
export function createPasskeyStore({ dataDir, now = () => Date.now(), log = (msg) => console.error(msg) }) {
  const file = path.join(dataDir, 'passkeys.json');
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (!('credentials' in v) || Array.isArray(v.credentials));

  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape, onCorrupt: log });
    return { ...EMPTY, ...v, credentials: Array.isArray(v.credentials) ? v.credentials : [] };
  }
  async function save(data) {
    await writeJson(file, data, { mode: 0o600 });
    return data;
  }
  const publicView = (c) => ({
    id: c.id, label: c.label,
    created: c.created ?? null, lastUsed: c.lastUsed ?? null,
    transports: Array.isArray(c.transports) ? c.transports : [],
  });

  return {
    async list() { return (await readAll()).credentials.map(publicView); },
    // Server-internal: includes the public key and sign count.
    // Server-internal: includes the public key and sign count. signCount is
    // normalized to a number here because verifyAssertion rejects a non-numeric
    // stored count (fail closed on a corrupt store) — without this, a record
    // whose signCount persisted as null would turn a valid passkey into a
    // permanent 401. Non-integer and negative values land on 0.
    //
    // Deliberately NOT normalized: an integer above 0xFFFFFFFF. signCount is
    // read from authenticator data as a uint32, so a larger stored value is
    // corruption — and verifyAssertion rejects it, which locks that one
    // credential rather than silently clamping to 0 and disabling clone
    // detection for it. Fail closed on the credential, not open.
    async listRaw() {
      return (await readAll()).credentials.map((c) => ({
        ...c,
        signCount: Number.isInteger(c.signCount) && c.signCount >= 0 ? c.signCount : 0,
      }));
    },
    async getRpId() { return (await readAll()).rpId ?? null; },
    async getPasskeyOnly() { return (await readAll()).passkeyOnly === true; },

    async setPasskeyOnly(enabled) {
      const data = await readAll();
      if (enabled && data.credentials.length === 0) {
        throw new Error('enroll a passkey before requiring passkey sign-in');
      }
      data.passkeyOnly = !!enabled;
      await save(data);
      return data.passkeyOnly;
    },

    // A stable WebAuthn user id, so re-enrolling the same authenticator
    // replaces its credential instead of stacking duplicates in the keychain.
    async getUserHandle() {
      const data = await readAll();
      if (data.userHandle) return data.userHandle;
      data.userHandle = randomBytes(16).toString('base64url');
      await save(data);
      return data.userHandle;
    },

    async add(cred, { rpId }) {
      const data = await readAll();
      data.rpId = data.rpId ?? rpId; // pinned by the first enrollment only
      const entry = { ...cred, created: cred.created ?? now(), lastUsed: null };
      data.credentials = [...data.credentials.filter((c) => c.id !== cred.id), entry];
      await save(data);
      return publicView(entry);
    },

    async remove(id) {
      const data = await readAll();
      const before = data.credentials.length;
      data.credentials = data.credentials.filter((c) => c.id !== id);
      if (data.credentials.length === before) return { removed: false, disarmed: false };
      const disarmed = data.credentials.length === 0 && data.passkeyOnly === true;
      if (data.credentials.length === 0) { data.passkeyOnly = false; data.rpId = null; }
      await save(data);
      return { removed: true, disarmed };
    },

    async touch(id, { signCount }) {
      const data = await readAll();
      const cred = data.credentials.find((c) => c.id === id);
      if (!cred) return;
      cred.signCount = signCount;
      cred.lastUsed = now();
      await save(data);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/passkeyStore.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/passkeyStore.js test/passkeyStore.test.js
git commit -m "feat(passkeys): persist enrolled credentials in data/passkeys.json"
```

---

### Task 8: Enrollment routes

**Files:**
- Modify: `src/server/server.js`
- Modify: `src/server/index.js`
- Test: `test/passkeyRoutes.test.js`

**Interfaces:**
- Consumes: `verifyRegistration`, `makeOriginCheck`, `SUPPORTED_ALGS` (Tasks 3-5); `createPasskeyChallenges` (Task 6); `createPasskeyStore` (Task 7).
- Produces: `buildServer` accepts `passkeyStore`, `passkeyChallenges`, and `log`. Routes `GET /api/passkeys`, `POST /api/passkeys/register/begin`, `POST /api/passkeys/register/finish`, `DELETE /api/passkeys/:id`. Shared internals `pkReady(reply)`, `issueChallenge(reply, kind)`, `takeChallenge(req, kind)`, `passkeyOnlyArmed()` used by Tasks 9 and 10.

- [ ] **Step 1: Write the failing tests**

Create `test/passkeyRoutes.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { hashPassword } from '../src/server/auth.js';
import { makeAuthenticator, makeRegistration, b64u } from './helpers/webauthnFixtures.js';

const RP = 'tmux.example.com';
const ORIGIN = `https://${RP}`;

let app, dir, passkeyStore;

async function build(overrides = {}) {
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', authMode: 'password', secureCookie: false,
    rpId: RP, rpIdError: null, passkeyOnlyKillSwitch: false,
    ...overrides,
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  return buildServer({ config, store: createStore({ dataDir: dir }), sessions, statusChecker, passkeyStore });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pkr-'));
  passkeyStore = createPasskeyStore({ dataDir: dir });
  app = await build();
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}
const pkCookie = (res) => {
  const c = res.cookies.find((x) => x.name === 'tmuxifier_pk');
  return c ? `${c.name}=${c.value}` : '';
};

test('passkey management routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/passkeys' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/register/begin' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/register/finish', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'DELETE', url: '/api/passkeys/x' })).statusCode).toBe(401);
});

test('GET /api/passkeys reports empty state before enrollment', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/passkeys', headers: await headers() })).json())
    .toEqual({ credentials: [], rpId: RP, storedRpId: null, passkeyOnly: false, killSwitch: false });
});

test('register/begin returns creation options bound to the rp id', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: await headers() });
  const body = res.json();
  expect(body.rp).toEqual({ id: RP, name: 'Tmuxifier' });
  expect(body.attestation).toBe('none');
  expect(body.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  expect(body.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257, -8]);
  expect(Buffer.from(body.challenge, 'base64url')).toHaveLength(32);
  expect(pkCookie(res)).toMatch(/^tmuxifier_pk=/);
});

test('a full enrollment round-trip stores the credential', async () => {
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  const auth = makeAuthenticator();
  const reg = makeRegistration({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP,
  });
  const fin = await app.inject({
    method: 'POST', url: '/api/passkeys/register/finish',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { label: 'Laptop', response: reg.response },
  });
  expect(fin.statusCode).toBe(200);
  expect(fin.json().credential).toMatchObject({ label: 'Laptop', transports: ['internal', 'hybrid'] });
  const raw = await passkeyStore.listRaw();
  expect(raw).toHaveLength(1);
  expect(Buffer.from(raw[0].publicKey, 'base64url').equals(auth.cose)).toBe(true);
  expect(await passkeyStore.getRpId()).toBe(RP);
});

test('register/finish rejects a bad label before touching crypto', async () => {
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  const res = await app.inject({
    method: 'POST', url: '/api/passkeys/register/finish',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { label: 'nope;rm -rf /', response: {} },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/label/);
});

test('register/finish without a challenge cookie is rejected', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/passkeys/register/finish', headers: h,
    payload: { label: 'Laptop', response: {} },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/challenge expired/);
});

test('a challenge cannot be replayed', async () => {
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  const challenge = Buffer.from(begin.json().challenge, 'base64url');
  const cookie = `${h.cookie}; ${pkCookie(begin)}`;
  const auth = makeAuthenticator();
  const payload = { label: 'Laptop', response: makeRegistration({ authenticator: auth, challenge, origin: ORIGIN, rpId: RP }).response };
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/register/finish', headers: { ...h, cookie }, payload })).statusCode).toBe(200);
  const again = await app.inject({ method: 'POST', url: '/api/passkeys/register/finish', headers: { ...h, cookie }, payload });
  expect(again.statusCode).toBe(400);
  expect(again.json().error).toMatch(/challenge expired/);
});

test('DELETE removes a credential and 404s on an unknown id', async () => {
  const h = await headers();
  await passkeyStore.add({ id: 'cred-a', publicKey: 'x', alg: -7, signCount: 0, label: 'L', transports: [] }, { rpId: RP });
  expect((await app.inject({ method: 'DELETE', url: '/api/passkeys/nope', headers: h })).statusCode).toBe(404);
  expect((await app.inject({ method: 'DELETE', url: '/api/passkeys/cred-a', headers: h })).json()).toEqual({ ok: true, disarmed: false });
});

// An IP-addressed deployment must still boot and serve everything else.
test('passkey routes report 503 when no rp id is available', async () => {
  app = await build({ rpId: null });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: await headers() });
  expect(res.statusCode).toBe(503);
  expect(res.json().error).toMatch(/domain name/);
});

test('a pinned rp id that no longer matches the configuration is a 409', async () => {
  await passkeyStore.add({ id: 'cred-a', publicKey: 'x', alg: -7, signCount: 0, label: 'L', transports: [] }, { rpId: 'old.example.com' });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: await headers() });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/old\.example\.com/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/passkeyRoutes.test.js`
Expected: FAIL — `Cannot read properties of undefined` / 404s, because the routes do not exist.

- [ ] **Step 3: Add the shared internals and enrollment routes**

In `src/server/server.js`, add to the imports:

```js
import { verifyAssertion, verifyRegistration, makeOriginCheck, SUPPORTED_ALGS } from './webauthn.js';
import { createPasskeyChallenges } from './passkeyChallenges.js';
```

Extend the `buildServer` destructured parameter list with:

```js
passkeyStore = null, passkeyChallenges = null, log = (msg) => console.error(msg),
```

Add immediately after the `const loginLimiter = createLoginRateLimiter();` line:

```js
  // --- passkeys (WebAuthn) ---
  // A third login path alongside password/Google. It mints exactly the same
  // session cookie, so the session TTL, revocation watermark and WebSocket auth
  // all apply unchanged.
  const PK_COOKIE = 'tmuxifier_pk';
  const PK_TTL_SECONDS = 120;
  const LABEL_RE = /^[A-Za-z0-9 ._-]{1,32}$/;
  const pkChallenges = passkeyChallenges ?? createPasskeyChallenges({ ttlMs: PK_TTL_SECONDS * 1000 });
  const rpId = config.rpId || null;
  const passkeyOriginOk = rpId ? makeOriginCheck(rpId) : () => false;

  // Replies with the reason and returns false when passkeys cannot be used.
  async function pkReady(reply) {
    if (!passkeyStore) {
      reply.code(503).send({ error: 'passkeys are not configured' });
      return false;
    }
    if (!rpId) {
      reply.code(503).send({ error: 'passkeys need a domain name — set TMUXIFIER_RP_ID, or point TMUXIFIER_BASE_EXTERNAL_URL at a hostname (an IP address cannot be a WebAuthn relying party)' });
      return false;
    }
    const pinned = await passkeyStore.getRpId();
    if (pinned && pinned !== rpId) {
      reply.code(409).send({ error: `these passkeys were enrolled for ${pinned}, but this server is configured for ${rpId}` });
      return false;
    }
    return true;
  }

  function issueChallenge(reply, kind) {
    const { token, challenge } = pkChallenges.issue(kind);
    reply.setCookie(PK_COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: !!config.secureCookie,
      path: '/', signed: true, maxAge: PK_TTL_SECONDS,
    });
    return challenge;
  }

  function takeChallenge(req, kind) {
    const raw = req.cookies?.[PK_COOKIE];
    if (!raw) return null;
    const unsigned = app.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;
    return pkChallenges.take(unsigned.value, kind);
  }

  // Read per request, never captured at boot, so the toggle takes effect at once.
  async function passkeyOnlyArmed() {
    if (!passkeyStore || config.passkeyOnlyKillSwitch) return false;
    try { return await passkeyStore.getPasskeyOnly(); } catch { return false; }
  }

  app.get('/api/passkeys', { preHandler: requireAuth }, async () => ({
    credentials: passkeyStore ? await passkeyStore.list() : [],
    rpId,
    storedRpId: passkeyStore ? await passkeyStore.getRpId() : null,
    passkeyOnly: passkeyStore ? await passkeyStore.getPasskeyOnly() : false,
    killSwitch: !!config.passkeyOnlyKillSwitch,
  }));

  app.post('/api/passkeys/register/begin', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await pkReady(reply))) return reply;
    const challenge = issueChallenge(reply, 'reg');
    const enrolled = await passkeyStore.listRaw();
    return {
      challenge: challenge.toString('base64url'),
      rp: { id: rpId, name: 'Tmuxifier' },
      user: { id: await passkeyStore.getUserHandle(), name: `tmuxifier@${rpId}`, displayName: 'Tmuxifier' },
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
      // Discoverable so login needs no username; user verification so the
      // passkey is a real second factor on the device itself.
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: PK_TTL_SECONDS * 1000,
      excludeCredentials: enrolled.map((c) => ({ type: 'public-key', id: c.id, transports: c.transports ?? [] })),
    };
  });

  app.post('/api/passkeys/register/finish', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await pkReady(reply))) return reply;
    const label = String(req.body?.label ?? '').trim() || 'passkey';
    if (!LABEL_RE.test(label)) {
      return reply.code(400).send({ error: 'label must be 1-32 characters of letters, digits, space, dot, underscore or hyphen' });
    }
    const challenge = takeChallenge(req, 'reg');
    reply.clearCookie(PK_COOKIE, { path: '/' });
    if (!challenge) return reply.code(400).send({ error: 'challenge expired — start again' });
    let reg;
    try {
      reg = verifyRegistration({ response: req.body?.response ?? {}, expectedChallenge: challenge, rpId, originOk: passkeyOriginOk });
    } catch (e) {
      // This endpoint is authenticated, so a specific reason is safe and useful.
      return reply.code(400).send({ error: `passkey registration failed: ${String(e.message).slice(0, 160)}` });
    }
    const transports = Array.isArray(req.body?.response?.transports)
      ? req.body.response.transports.filter((t) => typeof t === 'string' && /^[a-z-]{1,16}$/.test(t)).slice(0, 8)
      : [];
    const credential = await passkeyStore.add({
      id: reg.credentialId.toString('base64url'),
      publicKey: reg.publicKey.toString('base64url'),
      alg: reg.alg, signCount: reg.signCount, label, transports,
    }, { rpId });
    return { credential };
  });

  app.delete('/api/passkeys/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!passkeyStore) return reply.code(503).send({ error: 'passkeys are not configured' });
    const result = await passkeyStore.remove(req.params.id);
    if (!result.removed) return reply.code(404).send({ error: 'passkey not found' });
    return { ok: true, disarmed: result.disarmed };
  });
```

- [ ] **Step 4: Wire the store in the entrypoint**

In `src/server/index.js`, add to the imports:

```js
import { createPasskeyStore } from './passkeyStore.js';
```

Add next to the other store constructions (near `const netboxStore = ...`):

```js
const passkeyStore = createPasskeyStore({ dataDir: config.dataDir });
```

Add `passkeyStore` to the `buildServer({ ... })` argument object.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/passkeyRoutes.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js src/server/index.js test/passkeyRoutes.test.js
git commit -m "feat(auth): enroll, list and remove passkeys"
```

---

### Task 9: Passkey login routes

**Files:**
- Modify: `src/server/server.js`
- Test: `test/passkeyRoutes.test.js`

**Interfaces:**
- Consumes: everything from Task 8, plus `verifyAssertion` (Task 4).
- Produces: `POST /api/auth/passkey/login/begin`, `POST /api/auth/passkey/login/finish`, and the `passkey` object on `GET /api/auth/info`.

- [ ] **Step 1: Write the failing tests**

Append to `test/passkeyRoutes.test.js` (extend the fixture import with `makeAssertion`):

```js
async function enroll(store = passkeyStore) {
  const auth = makeAuthenticator();
  await store.add({
    id: auth.id, publicKey: b64u(auth.cose), alg: -7, signCount: 0, label: 'Laptop', transports: ['internal'],
  }, { rpId: RP });
  return auth;
}

test('auth/info reports passkey state without authentication', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json())
    .toEqual({ mode: 'password', passkey: { enrolled: 0, rpId: RP, only: false } });
  await enroll();
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json().passkey.enrolled).toBe(1);
});

test('login/begin refuses before any passkey is enrolled', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  expect(res.statusCode).toBe(503);
  expect(res.json().error).toMatch(/no passkey enrolled/);
});

test('login/begin sends no allowCredentials, so credential ids stay private', async () => {
  await enroll();
  const res = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  expect(res.statusCode).toBe(200);
  expect(res.json().allowCredentials).toEqual([]);
  expect(res.json()).toMatchObject({ rpId: RP, userVerification: 'required' });
});

test('a full passkey login mints a session cookie that authenticates', async () => {
  const auth = await enroll();
  const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const assertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5,
  });
  const fin = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish',
    headers: { cookie: pkCookie(begin) }, payload: assertion,
  });
  expect(fin.statusCode).toBe(200);
  const session = fin.cookies.find((c) => c.name === 'tmuxifier_session');
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${session.name}=${session.value}` } });
  expect(me.statusCode).toBe(200);
  expect((await passkeyStore.listRaw())[0].signCount).toBe(5);
});

test('an unknown credential and a bad signature are indistinguishable', async () => {
  const auth = await enroll();
  const begin1 = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const stranger = makeAuthenticator({ credentialId: Buffer.from('cred-zzzz') });
  const unknown = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin1) },
    payload: makeAssertion({ authenticator: stranger, challenge: Buffer.from(begin1.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP }),
  });
  const begin2 = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const forged = makeAssertion({ authenticator: auth, challenge: Buffer.from(begin2.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, tamper: 'signature' });
  const bad = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin2) }, payload: forged });
  expect(unknown.statusCode).toBe(401);
  expect(bad.statusCode).toBe(401);
  expect(unknown.json()).toEqual(bad.json());
});

test('an assertion from a foreign origin is rejected', async () => {
  const auth = await enroll();
  const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const res = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin) },
    payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: 'https://evil.example.net', rpId: RP }),
  });
  expect(res.statusCode).toBe(401);
});

// Passkey login shares the password lockout bucket rather than bypassing it.
test('failed passkey logins count toward the per-ip lockout', async () => {
  const auth = await enroll();
  for (let i = 0; i < 10; i++) {
    const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
    await app.inject({
      method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin) },
      payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, tamper: 'signature' }),
    });
  }
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(429);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/passkeyRoutes.test.js`
Expected: FAIL — 404 on `/api/auth/passkey/login/begin`

- [ ] **Step 3: Give the unauthenticated login flow its own challenge store**

Enrollment and login must not share one bounded map. `createPasskeyChallenges` evicts the
soonest-expiring entry when full, and at a uniform TTL that is the earliest issued — so with a
single 64-slot store, 64 unauthenticated `login/begin` calls flush an authenticated operator's
in-flight enrollment challenge and they can never enroll a passkey. Verified: with one shared
store, the enrolling user's challenge does not survive 64 anonymous issues.

In `src/server/server.js`, alongside the existing `pkChallenges`:

```js
  // Separate bounded stores per ceremony. login/begin is unauthenticated, so a
  // flood of anonymous challenges must not be able to evict the enrollment
  // challenge of an authenticated operator mid-ceremony.
  const pkLoginChallenges = createPasskeyChallenges({ ttlMs: PK_TTL_SECONDS * 1000 });
  const challengeStoreFor = (kind) => (kind === 'auth' ? pkLoginChallenges : pkChallenges);
```

and route both helpers through it — in `issueChallenge`, replace `pkChallenges.issue(kind)` with
`challengeStoreFor(kind).issue(kind)`; in `takeChallenge`, replace `pkChallenges.take(...)` with
`challengeStoreFor(kind).take(...)`.

Add a test proving the isolation:

```js
test('a flood of anonymous login challenges cannot evict an enrollment challenge', async () => {
  const h = await headers();
  await enroll();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  // More than the 64-entry default bound, all unauthenticated.
  for (let i = 0; i < 70; i++) await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const auth = makeAuthenticator({ credentialId: Buffer.from('cred-late') });
  const fin = await app.inject({
    method: 'POST', url: '/api/passkeys/register/finish',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { label: 'Laptop', response: makeRegistration({
      authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP,
    }).response },
  });
  expect(fin.statusCode).toBe(200);
});
```

- [ ] **Step 4: Implement the login routes**

In `src/server/server.js`, replace the existing `/api/auth/info` route with:

```js
  app.get('/api/auth/info', async () => ({
    mode: config.authMode === 'google' ? 'google' : 'password',
    // Unauthenticated on purpose: the login screen needs to know whether to
    // draw the passkey button. It exposes only the hostname the client is
    // already talking to, plus a count.
    passkey: {
      enrolled: passkeyStore ? (await passkeyStore.list()).length : 0,
      rpId,
      only: await passkeyOnlyArmed(),
    },
  }));
```

Add after the `DELETE /api/passkeys/:id` route:

```js
  app.post('/api/auth/passkey/login/begin', async (req, reply) => {
    if (loginLimiter.limited(req.ip)) return reply.code(429).send({ error: 'too many attempts' });
    if (!(await pkReady(reply))) return reply;
    if ((await passkeyStore.listRaw()).length === 0) return reply.code(503).send({ error: 'no passkey enrolled' });
    const challenge = issueChallenge(reply, 'auth');
    return {
      challenge: challenge.toString('base64url'),
      rpId,
      timeout: PK_TTL_SECONDS * 1000,
      userVerification: 'required',
      // Discoverable credentials identify the user themselves; an empty list
      // also avoids handing out credential ids before authentication.
      allowCredentials: [],
    };
  });

  app.post('/api/auth/passkey/login/finish', async (req, reply) => {
    const ip = req.ip;
    if (loginLimiter.limited(ip)) return reply.code(429).send({ error: 'too many attempts' });
    if (!(await pkReady(reply))) return reply;
    const challenge = takeChallenge(req, 'auth');
    reply.clearCookie(PK_COOKIE, { path: '/' });
    if (!challenge) return reply.code(400).send({ error: 'challenge expired — start again' });
    const credential = (await passkeyStore.listRaw()).find((c) => c.id === req.body?.id);
    let result;
    try {
      if (!credential) throw new Error('unknown credential');
      result = verifyAssertion({
        response: req.body?.response ?? {},
        expectedChallenge: challenge, rpId, originOk: passkeyOriginOk,
        // NOT `credential.signCount ?? 0`: verifyAssertion rejects a non-numeric
        // stored count on purpose, and `??` would launder a null straight past
        // that guard, silently disabling the cloned-authenticator check.
        // passkeyStore.listRaw() guarantees a number — see Task 7.
        publicKey: credential.publicKey, storedSignCount: credential.signCount,
      });
    } catch (e) {
      loginLimiter.fail(ip);
      // A stalled counter is the one failure worth naming in the log; the
      // response stays generic so a caller cannot enumerate credential ids.
      // Match the stall message specifically, NOT /sign count/ — that would also
      // match 'invalid stored sign count', logging a corrupt-store lockout as a
      // cloned authenticator, the exact mislabel this log line exists to avoid.
      if (credential && /did not increase/.test(e.message)) {
        log(`[tmuxifier] passkey "${credential.label}" sign count did not increase — possible cloned authenticator`);
      }
      return reply.code(401).send({ error: 'passkey verification failed' });
    }
    loginLimiter.succeed(ip);
    await passkeyStore.touch(credential.id, { signCount: result.signCount });
    reply.setCookie(COOKIE_NAME, sessionValue(), cookieOptions(config.secureCookie));
    return { ok: true };
  });
```

- [ ] **Step 5: Update the two existing `/api/auth/info` assertions**

Both use exact equality and will now fail, since the response carries a `passkey` object.

In `test/server.test.js:122`, replace:

```js
  expect(res.json()).toEqual({ mode: 'password' });
```

with:

```js
  expect(res.json()).toMatchObject({ mode: 'password' });
  expect(res.json().passkey).toEqual({ enrolled: 0, rpId: null, only: false });
```

In `test/server.google.test.js:56`, replace:

```js
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json()).toEqual({ mode: 'google' });
```

with:

```js
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json()).toMatchObject({ mode: 'google' });
```

(Neither suite passes a `config.rpId`, so `rpId` reads as `null` there — passkeys are simply inert in those fixtures.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/passkeyRoutes.test.js test/server.test.js test/server.google.test.js`
Expected: PASS, all three suites.

- [ ] **Step 7: Commit**

```bash
git add src/server/server.js test/passkeyRoutes.test.js test/server.test.js test/server.google.test.js
git commit -m "feat(auth): sign in with a passkey"
```

---

### Task 10: Passkey-only toggle and gating

**Files:**
- Modify: `src/server/server.js`
- Test: `test/passkeyRoutes.test.js`

**Interfaces:**
- Consumes: `passkeyOnlyArmed()` (Task 8).
- Produces: `POST /api/passkeys/only` taking `{ enabled: boolean }` and returning `{ passkeyOnly: boolean }`; `403` gating on `POST /api/login` and redirect gating on both Google routes.

- [ ] **Step 1: Write the failing tests**

Append to `test/passkeyRoutes.test.js`:

```js
test('arming passkey-only is refused with nothing enrolled', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: await headers(), payload: { enabled: true } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/enroll a passkey/);
});

test('arming passkey-only makes password login 403', async () => {
  await enroll();
  const h = await headers();
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: true } })).json())
    .toEqual({ passkeyOnly: true });
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  expect(res.statusCode).toBe(403);
  expect(res.json().error).toMatch(/passkey required/);
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json().passkey.only).toBe(true);
});

test('disarming passkey-only restores password login', async () => {
  await enroll();
  const h = await headers();
  await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: true } });
  await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: false } });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
});

// Without this, a flow started before the toggle was armed still issues a session.
test('arming passkey-only blocks both Google routes, callback included', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pkg-'));
  passkeyStore = createPasskeyStore({ dataDir: dir });
  const google = { authorizationUrl: () => 'https://accounts.google.com/x', exchangeCodeForEmail: async () => ({ email: 'you@example.com', emailVerified: true }), isAllowed: () => true };
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    cookieSecret: 'test-secret', dataDir: dir, localShell: 'none', authMode: 'google',
    secureCookie: false, publicUrl: 'https://tmux.example.com',
    rpId: RP, rpIdError: null, passkeyOnlyKillSwitch: false,
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const gapp = buildServer({ config, store: createStore({ dataDir: dir }), sessions, statusChecker, passkeyStore, googleAuth: google });
  await enroll(passkeyStore);
  await passkeyStore.setPasskeyOnly(true);
  const login = await gapp.inject({ method: 'GET', url: '/api/auth/google/login' });
  const callback = await gapp.inject({ method: 'GET', url: '/api/auth/google/callback?code=c&state=s' });
  expect(login.headers.location).toBe('/?error=passkey-only');
  expect(callback.headers.location).toBe('/?error=passkey-only');
});

// The .env break-glass for a lost authenticator.
test('the kill switch overrides the stored flag', async () => {
  await enroll();
  await passkeyStore.setPasskeyOnly(true);
  app = await build({ passkeyOnlyKillSwitch: true });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: await headers(), payload: { enabled: true } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/TMUXIFIER_PASSKEY_ONLY/);
});

test('removing the last passkey disarms passkey-only', async () => {
  const auth = await enroll();
  const h = await headers();
  await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: true } });
  expect((await app.inject({ method: 'DELETE', url: `/api/passkeys/${encodeURIComponent(auth.id)}`, headers: h })).json())
    .toEqual({ ok: true, disarmed: true });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/passkeyRoutes.test.js`
Expected: FAIL — 404 on `/api/passkeys/only`

- [ ] **Step 3: Implement the toggle and gating**

In `src/server/server.js`, add after the `DELETE /api/passkeys/:id` route:

```js
  app.post('/api/passkeys/only', { preHandler: requireAuth }, async (req, reply) => {
    if (!passkeyStore) return reply.code(503).send({ error: 'passkeys are not configured' });
    if (config.passkeyOnlyKillSwitch) {
      return reply.code(409).send({ error: 'TMUXIFIER_PASSKEY_ONLY=off is set in .env — remove it and restart before arming this' });
    }
    try {
      return { passkeyOnly: await passkeyStore.setPasskeyOnly(req.body?.enabled === true) };
    } catch (e) {
      return reply.code(409).send({ error: e.message });
    }
  });
```

In the `POST /api/login` handler, insert as the **first** statement — before the rate-limit check, so a disabled mode does not consume login attempts:

```js
      if (await passkeyOnlyArmed()) return reply.code(403).send({ error: 'passkey required' });
```

In the `GET /api/auth/google/login` handler, insert as the first statement:

```js
      if (await passkeyOnlyArmed()) return reply.redirect('/?error=passkey-only');
```

In the `GET /api/auth/google/callback` handler, insert as the first statement (guarding the callback too, so a flow started before the toggle was armed cannot complete):

```js
      if (await passkeyOnlyArmed()) return reply.redirect('/?error=passkey-only');
```

- [ ] **Step 4: Run the whole server suite**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/passkeyRoutes.test.js
git commit -m "feat(auth): opt-in passkey-only mode with anti-lockout guards"
```

---

### Task 11: Web fetch layer and pure helpers

**Files:**
- Create: `src/web/passkeys.ts`
- Test: `test/passkeysWeb.test.js`

**Interfaces:**
- Consumes: the routes from Tasks 8-10.
- Produces: `b64uToBytes`, `bytesToB64u`, `toCreationOptions`, `toRequestOptions`, `serializeRegistration`, `serializeAssertion`, `evaluateOrigin`, and the `pk` fetch object (`state`, `registerBegin`, `registerFinish`, `remove`, `setOnly`, `loginBegin`, `loginFinish`). Types `PasskeyCredential`, `PasskeyState`, `OriginVerdict`.

- [ ] **Step 1: Write the failing tests**

Create `test/passkeysWeb.test.js`:

```js
import { test, expect } from 'vitest';
import { b64uToBytes, bytesToB64u, evaluateOrigin, toRequestOptions } from '../src/web/passkeys.ts';

const base = { rpId: 'tmux.example.com', storedRpId: null, hostname: 'tmux.example.com', protocol: 'https:', hasWebAuthn: true };

test('base64url round-trips, including unpadded input', () => {
  const bytes = new Uint8Array([0, 1, 250, 255, 66]);
  expect(b64uToBytes(bytesToB64u(bytes.buffer))).toEqual(bytes);
  expect(b64uToBytes('AQID')).toEqual(new Uint8Array([1, 2, 3]));
});

test('accepts a matching secure origin', () => {
  const v = evaluateOrigin(base);
  expect(v.ok).toBe(true);
  expect(v.reason).toMatch(/tmux\.example\.com/);
});

test('reports an unsupported browser first', () => {
  const v = evaluateOrigin({ ...base, hasWebAuthn: false });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/does not support/);
});

test('reports an IP-addressed deployment with the fix', () => {
  const v = evaluateOrigin({ ...base, rpId: null });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/domain name/);
  expect(v.hint).toMatch(/TMUXIFIER_RP_ID/);
});

test('reports a store pinned to a different hostname', () => {
  const v = evaluateOrigin({ ...base, storedRpId: 'old.example.com' });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/old\.example\.com/);
  expect(v.hint).toMatch(/old\.example\.com/);
});

test('reports a hostname mismatch', () => {
  const v = evaluateOrigin({ ...base, hostname: 'localhost' });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/bound to tmux\.example\.com/);
});

test('reports an insecure context, but allows plain http on localhost', () => {
  const insecure = evaluateOrigin({ ...base, protocol: 'http:' });
  expect(insecure.ok).toBe(false);
  expect(insecure.reason).toMatch(/secure connection/);
  const local = evaluateOrigin({ rpId: 'localhost', storedRpId: null, hostname: 'localhost', protocol: 'http:', hasWebAuthn: true });
  expect(local.ok).toBe(true);
});

test('converts request options into the browser shape', () => {
  const opts = toRequestOptions({ challenge: 'AQID', rpId: 'tmux.example.com', timeout: 120000, userVerification: 'required' });
  expect(new Uint8Array(opts.challenge)).toEqual(new Uint8Array([1, 2, 3]));
  expect(opts.rpId).toBe('tmux.example.com');
  expect(opts.allowCredentials).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/passkeysWeb.test.js`
Expected: FAIL — `Failed to resolve import "../src/web/passkeys"`

- [ ] **Step 3: Implement the module**

Create `src/web/passkeys.ts`:

```ts
// Passkey fetch layer plus the pure helpers around the WebAuthn browser API.
// Everything that can be a pure function is one, so the five readiness states
// and the byte conversions are testable without a browser.

export interface PasskeyCredential {
  id: string; label: string; created: number | null; lastUsed: number | null; transports: string[];
}
export interface PasskeyState {
  credentials: PasskeyCredential[];
  rpId: string | null;
  storedRpId: string | null;
  passkeyOnly: boolean;
  killSwitch: boolean;
}
export interface OriginVerdict { ok: boolean; reason: string; hint: string }

export function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + (b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToB64u(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Ordered most-fundamental first: a browser that cannot do WebAuthn makes every
// later check moot, and a store pinned elsewhere explains a hostname mismatch
// better than the generic message would.
export function evaluateOrigin(
  { rpId, storedRpId, hostname, protocol, hasWebAuthn }:
  { rpId: string | null; storedRpId: string | null; hostname: string; protocol: string; hasWebAuthn: boolean },
): OriginVerdict {
  const host = hostname.toLowerCase();
  if (!hasWebAuthn) {
    return { ok: false, reason: 'This browser does not support passkeys.', hint: 'Use a current version of Chrome, Safari, Firefox or Edge.' };
  }
  if (!rpId) {
    return {
      ok: false,
      reason: 'Passkeys need a domain name, and this server is reached by IP address.',
      hint: 'Set TMUXIFIER_RP_ID in .env (or point TMUXIFIER_BASE_EXTERNAL_URL at a hostname) and restart.',
    };
  }
  if (storedRpId && storedRpId !== rpId) {
    return {
      ok: false,
      reason: `The enrolled passkeys belong to ${storedRpId}, but this server is configured for ${rpId}.`,
      hint: `Reach Tmuxifier at ${storedRpId}, or remove every passkey here and enroll again.`,
    };
  }
  if (host !== rpId) {
    return { ok: false, reason: `Passkeys are bound to ${rpId}, but you are on ${hostname}.`, hint: `Open Tmuxifier at https://${rpId}.` };
  }
  if (protocol !== 'https:' && host !== 'localhost') {
    return { ok: false, reason: 'Passkeys require a secure connection.', hint: `Open Tmuxifier at https://${rpId}.` };
  }
  return { ok: true, reason: `Passkeys are bound to ${rpId}.`, hint: '' };
}

export function toRequestOptions(o: { challenge: string; rpId: string; timeout: number; userVerification: string }): PublicKeyCredentialRequestOptions {
  return {
    challenge: b64uToBytes(o.challenge),
    rpId: o.rpId,
    timeout: o.timeout,
    userVerification: o.userVerification as UserVerificationRequirement,
    allowCredentials: [],
  };
}

interface CreationOptionsJson {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  authenticatorSelection: AuthenticatorSelectionCriteria;
  attestation: AttestationConveyancePreference;
  timeout: number;
  excludeCredentials: { id: string; transports?: string[] }[];
}

export function toCreationOptions(o: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    challenge: b64uToBytes(o.challenge),
    rp: o.rp,
    user: { id: b64uToBytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams,
    authenticatorSelection: o.authenticatorSelection,
    attestation: o.attestation,
    timeout: o.timeout,
    excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({
      type: 'public-key' as const,
      id: b64uToBytes(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };
}

export function serializeRegistration(c: PublicKeyCredential) {
  const r = c.response as AuthenticatorAttestationResponse;
  return {
    id: c.id,
    type: c.type,
    response: {
      clientDataJSON: bytesToB64u(r.clientDataJSON),
      attestationObject: bytesToB64u(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    },
  };
}

export function serializeAssertion(c: PublicKeyCredential) {
  const r = c.response as AuthenticatorAssertionResponse;
  return {
    id: c.id,
    type: c.type,
    response: {
      clientDataJSON: bytesToB64u(r.clientDataJSON),
      authenticatorData: bytesToB64u(r.authenticatorData),
      signature: bytesToB64u(r.signature),
      userHandle: r.userHandle ? bytesToB64u(r.userHandle) : null,
    },
  };
}

async function jr<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
  return res.json() as Promise<T>;
}
const jsonBody = (method: string, v: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });

export const pk = {
  state() { return jr<PasskeyState>(fetch('/api/passkeys')); },
  registerBegin() { return jr<CreationOptionsJson>(fetch('/api/passkeys/register/begin', { method: 'POST' })); },
  registerFinish(label: string, response: unknown) {
    return jr<{ credential: PasskeyCredential }>(fetch('/api/passkeys/register/finish', jsonBody('POST', { label, response })));
  },
  remove(id: string) { return jr<{ ok: boolean; disarmed: boolean }>(fetch(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })); },
  setOnly(enabled: boolean) { return jr<{ passkeyOnly: boolean }>(fetch('/api/passkeys/only', jsonBody('POST', { enabled }))); },
  loginBegin() {
    return jr<{ challenge: string; rpId: string; timeout: number; userVerification: string }>(
      fetch('/api/auth/passkey/login/begin', { method: 'POST' }));
  },
  loginFinish(assertion: unknown) { return jr<{ ok: boolean }>(fetch('/api/auth/passkey/login/finish', jsonBody('POST', assertion))); },
};

// Thin wrappers so callers never touch navigator.credentials directly.
export async function createPasskey(options: CreationOptionsJson): Promise<PublicKeyCredential> {
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) });
  if (!cred) throw new Error('passkey creation was cancelled');
  return cred as PublicKeyCredential;
}

export async function getPasskey(options: { challenge: string; rpId: string; timeout: number; userVerification: string }): Promise<PublicKeyCredential> {
  const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) });
  if (!cred) throw new Error('passkey sign-in was cancelled');
  return cred as PublicKeyCredential;
}

export const hasWebAuthn = () => typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
```

- [ ] **Step 4: Run tests and the type check**

Run: `npm test`
Expected: PASS, all suites green including `tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/web/passkeys.ts test/passkeysWeb.test.js
git commit -m "feat(web): passkey fetch layer and origin-readiness helpers"
```

---

### Task 12: Settings → Passkeys tab

**Files:**
- Create: `src/web/settingsPasskeys.ts`
- Modify: `src/web/settingsUi.ts`

**Interfaces:**
- Consumes: `pk`, `evaluateOrigin`, `createPasskey`, `serializeRegistration`, `hasWebAuthn`, `PasskeyState` (Task 11); `el`, `input`, `openModal` from `dom.ts`.
- Produces: `renderPasskeysSection(content: HTMLElement): Promise<void>`; `SettingsTab` gains `'passkeys'`.

- [ ] **Step 1: Write the tab**

Create `src/web/settingsPasskeys.ts`:

```ts
import { el, input, openModal } from './dom';
import { pk, evaluateOrigin, createPasskey, serializeRegistration, hasWebAuthn, type PasskeyState } from './passkeys';

const when = (t: number | null) => (t ? new Date(t).toLocaleString() : 'never');

// Settings → Passkeys. A passkey is an additional way in; the password/Google
// path stays available unless "passkey only" is explicitly armed.
export async function renderPasskeysSection(content: HTMLElement): Promise<void> {
  content.replaceChildren(el('div', { class: 'pve-sub' }, ['Loading…']));
  let state: PasskeyState;
  try {
    state = await pk.state();
  } catch (e) {
    content.replaceChildren(el('div', { class: 'pve-err' }, [(e as Error).message]));
    return;
  }
  const verdict = evaluateOrigin({
    rpId: state.rpId, storedRpId: state.storedRpId,
    hostname: location.hostname, protocol: location.protocol, hasWebAuthn: hasWebAuthn(),
  });
  const reload = () => { void renderPasskeysSection(content); };
  const errLine = el('div', { class: 'pve-err' });
  const fail = (e: unknown) => { errLine.textContent = (e as Error).message; };

  // --- readiness ---
  const readiness = el('div', { class: verdict.ok ? 'pve-sub' : 'pve-err' }, [verdict.reason]);
  const hint = verdict.hint ? el('div', { class: 'pve-sub' }, [verdict.hint]) : null;

  // --- enrolled list ---
  const rows = state.credentials.map((c) => el('div', { class: 'pve-row' }, [
    el('div', {}, [
      el('strong', {}, [c.label]),
      el('div', { class: 'pve-sub' }, [`added ${when(c.created)} · last used ${when(c.lastUsed)}${c.transports.length ? ` · ${c.transports.join(', ')}` : ''}`]),
    ]),
    el('button', {
      type: 'button', class: 'danger',
      onclick: () => confirmRemove(c.id, c.label, state, reload, fail),
    }, ['Remove']),
  ]));
  const list = state.credentials.length
    ? el('div', {}, rows)
    : el('div', { class: 'pve-sub' }, ['No passkeys enrolled yet.']);

  // --- add ---
  const addBtn = el('button', { type: 'button', class: 'pve-primary', onclick: () => addPasskey(reload) }) as HTMLButtonElement;
  addBtn.textContent = 'Add passkey';
  if (!verdict.ok) { addBtn.disabled = true; addBtn.title = verdict.reason; }

  // --- passkey-only toggle ---
  const onlyBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  onlyBox.checked = state.passkeyOnly;
  const onlyReason = state.killSwitch
    ? 'TMUXIFIER_PASSKEY_ONLY=off is set in .env — remove it and restart to use this.'
    : state.credentials.length === 0
      ? 'Enroll a passkey first.'
      : '';
  if (onlyReason) { onlyBox.disabled = true; onlyBox.title = onlyReason; }
  onlyBox.onchange = () => {
    if (!onlyBox.checked) { void pk.setOnly(false).then(reload).catch((e) => { onlyBox.checked = true; fail(e); }); return; }
    // Arming is the one action here that can lock the user out of the fleet.
    confirmArm(() => void pk.setOnly(true).then(reload).catch((e) => { onlyBox.checked = false; fail(e); }),
      () => { onlyBox.checked = false; });
  };

  content.replaceChildren(
    el('h3', {}, ['Passkeys']),
    el('p', { class: 'pve-sub' }, ['A passkey signs you in with your device’s fingerprint, face or PIN instead of a password. It is phishing-resistant: it only works on this exact hostname.']),
    readiness,
    ...(hint ? [hint] : []),
    el('div', { class: 'pve-eyebrow' }, ['Enrolled passkeys']),
    list,
    addBtn,
    el('div', { class: 'pve-eyebrow' }, ['Sign-in policy']),
    el('label', { class: 'check-field' }, [onlyBox, el('span', {}, ['Require a passkey (disable password and Google sign-in)'])]),
    ...(onlyReason ? [el('div', { class: 'pve-sub' }, [onlyReason])] : []),
    el('p', { class: 'pve-sub' }, ['If you lose your authenticator, set TMUXIFIER_PASSKEY_ONLY=off in .env and restart Tmuxifier to sign in the old way.']),
    errLine,
  );
}

// Errors from this flow surface inside its own modal, not on the tab behind it.
function addPasskey(reload: () => void): void {
  const nameField = input('', { placeholder: 'Laptop Touch ID', maxlength: 32 }) as HTMLInputElement;
  const errLine = el('div', { class: 'pve-err' });
  const modal = el('div', { class: 'modal' });
  const { close } = openModal({ modal });
  const save = el('button', { type: 'button', class: 'pve-primary' }, ['Create']) as HTMLButtonElement;
  save.onclick = async () => {
    save.disabled = true;
    errLine.textContent = '';
    try {
      const options = await pk.registerBegin();
      const credential = await createPasskey(options);
      await pk.registerFinish(nameField.value.trim() || 'passkey', serializeRegistration(credential));
      close();
      reload();
    } catch (e) {
      save.disabled = false;
      // A cancelled browser prompt is not an error worth shouting about.
      if ((e as Error).name === 'NotAllowedError') { errLine.textContent = 'Cancelled.'; return; }
      errLine.textContent = (e as Error).message;
    }
  };
  modal.append(
    el('h2', {}, ['Add a passkey']),
    el('label', { class: 'field' }, [el('span', {}, ['Name']), nameField]),
    el('p', { class: 'pve-sub' }, ['Your browser will ask you to confirm with your fingerprint, face, PIN or security key.']),
    errLine,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: close }, ['Cancel']), save]),
  );
  nameField.focus();
}

function confirmRemove(id: string, label: string, state: PasskeyState, reload: () => void, fail: (e: unknown) => void): void {
  const last = state.credentials.length === 1;
  const modal = el('div', { class: 'modal' });
  const { close } = openModal({ modal });
  modal.append(
    el('h2', {}, ['Remove passkey']),
    el('p', {}, [`Remove “${label}”? The passkey stays on your device but will no longer sign you in here.`]),
    ...(last && state.passkeyOnly
      ? [el('p', { class: 'pve-sub' }, ['This is the last passkey, so “require a passkey” will be turned off and password sign-in re-enabled.'])]
      : []),
    el('div', { class: 'modal-actions' }, [
      el('button', { type: 'button', onclick: close }, ['Cancel']),
      el('button', {
        type: 'button', class: 'danger',
        onclick: () => { close(); void pk.remove(id).then(reload).catch(fail); },
      }, ['Remove']),
    ]),
  );
}

// onClose fires on Escape, backdrop click and the Cancel button alike, so the
// checkbox has to be un-ticked from there — guarded by a flag so confirming
// does not also run the cancel path.
function confirmArm(onConfirm: () => void, onCancel: () => void): void {
  let confirmed = false;
  const modal = el('div', { class: 'modal' });
  const { close } = openModal({ modal, onClose: () => { if (!confirmed) onCancel(); } });
  modal.append(
    el('h2', {}, ['Require a passkey?']),
    el('p', {}, ['Password and Google sign-in will be refused. Only an enrolled passkey will get you in.']),
    el('p', { class: 'pve-sub' }, ['If you lose your authenticator: set TMUXIFIER_PASSKEY_ONLY=off in .env and restart Tmuxifier.']),
    el('div', { class: 'modal-actions' }, [
      el('button', { type: 'button', onclick: close }, ['Cancel']),
      el('button', {
        type: 'button', class: 'pve-primary',
        onclick: () => { confirmed = true; close(); onConfirm(); },
      }, ['Require a passkey']),
    ]),
  );
}
```

- [ ] **Step 2: Register the tab**

In `src/web/settingsUi.ts`:

```ts
import { renderPasskeysSection } from './settingsPasskeys';
```

```ts
export type SettingsTab = 'netbox' | 'proxmox' | 'passkeys' | 'notifications';
```

Add to `SECTIONS`, between `proxmox` and `notifications`:

```ts
  passkeys: { label: 'Passkeys', render: (content) => renderPasskeysSection(content) },
```

- [ ] **Step 3: Type-check and build**

Run: `npm run typecheck && npm run build`
Expected: no type errors; `dist/` rebuilt.

- [ ] **Step 4: Commit**

```bash
git add src/web/settingsPasskeys.ts src/web/settingsUi.ts
git commit -m "feat(web): Settings > Passkeys tab"
```

---

### Task 13: Login-screen passkey button

**Files:**
- Modify: `src/web/main.ts`
- Modify: `src/web/api.ts`
- Modify: `src/web/style.css`

**Interfaces:**
- Consumes: `pk`, `getPasskey`, `serializeAssertion`, `hasWebAuthn` (Task 11); the `passkey` object on `/api/auth/info` (Task 9).
- Produces: no new exports — the login screen gains a passkey button and the `passkey-only` error message.

- [ ] **Step 1: Widen the authInfo type**

In `src/web/api.ts`, replace the `authInfo` line with:

```ts
  async authInfo() {
    return j<{ mode: 'password' | 'google'; passkey?: { enrolled: number; rpId: string | null; only: boolean } }>(
      await fetch('/api/auth/info'));
  },
```

- [ ] **Step 2: Add the login button**

In `src/web/main.ts`, add to the imports:

```ts
import { pk, getPasskey, serializeAssertion, hasWebAuthn } from './passkeys';
```

Extend `readLoginError` with the new code:

```ts
  return code === 'forbidden' ? 'This Google account is not allowed.'
    : code === 'google' ? 'Google sign-in failed. Please try again.'
    : code === 'state' ? 'Login session expired. Please try again.'
    : code === 'passkey-only' ? 'This Tmuxifier requires a passkey. Password and Google sign-in are disabled.'
    : 'Sign-in failed. Please try again.';
```

Replace `renderLogin` with:

```ts
async function renderLogin() {
  let mode: 'password' | 'google' = 'password';
  let passkey = { enrolled: 0, rpId: null as string | null, only: false };
  try {
    const info = await api.authInfo();
    mode = info.mode;
    if (info.passkey) passkey = info.passkey;
  } catch {}
  const err = readLoginError();
  const canPasskey = passkey.enrolled > 0 && hasWebAuthn();
  const brand = `<div class="login-brand">
        <img class="login-logo" src="${logoUrl}" alt="" />
        <h1>tmuxifier</h1>
        <p>persistent remote terminals for your boxes</p>
      </div>`;
  const footer = '<footer class="login-footer">Babendums Engineering &amp; Fabrication, Llc.</footer>';
  const passkeyBtn = canPasskey
    ? '<button id="pkbtn" type="button" class="pkbtn">Sign in with a passkey</button>'
    : '';

  // passkey-only with no usable passkey here would otherwise be a dead end.
  if (passkey.only && !canPasskey) {
    app.innerHTML = `<div class="login">${brand}
        <p id="err" class="err">${err || 'This Tmuxifier requires a passkey, and this browser cannot use one.'}</p>
        <p class="login-note">Open Tmuxifier on the device holding your passkey, or set
          <code>TMUXIFIER_PASSKEY_ONLY=off</code> in <code>.env</code> and restart to sign in with a password.</p>
        ${footer}
      </div>`;
    return;
  }

  if (passkey.only || mode === 'google') {
    const google = passkey.only ? '' : `<a id="gsignin" class="gbtn" href="/api/auth/google/login">
          <svg class="google-mark" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285f4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/>
            <path fill="#34a853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.8.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z"/>
            <path fill="#fbbc05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z"/>
            <path fill="#ea4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.65 8.65 0 0 0 9 0 9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/>
          </svg>
          <span>Sign in with Google</span>
        </a>`;
    app.innerHTML = `<div class="login">${brand}${google}${passkeyBtn}<p id="err" class="err">${err}</p>${footer}</div>`;
    wirePasskeyButton();
    return;
  }

  app.innerHTML = `<form id="login" class="login">${brand}
      <input id="pw" type="password" placeholder="Password" autofocus />
      <button>Unlock</button>
      ${passkeyBtn}
      <p id="err" class="err">${err}</p>
      ${footer}
    </form>`;
  app.querySelector('#login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.login((app.querySelector('#pw') as HTMLInputElement).value); renderDashboard(); }
    catch { (app.querySelector('#err') as HTMLElement).textContent = 'Invalid password'; }
  });
  wirePasskeyButton();
}

function wirePasskeyButton() {
  const btn = app.querySelector('#pkbtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const errEl = app.querySelector('#err') as HTMLElement;
    btn.disabled = true;
    errEl.textContent = '';
    try {
      const options = await pk.loginBegin();
      const credential = await getPasskey(options);
      await pk.loginFinish(serializeAssertion(credential));
      renderDashboard();
    } catch (e) {
      btn.disabled = false;
      errEl.textContent = (e as Error).name === 'NotAllowedError' ? 'Passkey sign-in cancelled.' : 'Passkey sign-in failed.';
    }
  });
}
```

- [ ] **Step 3: Style the button**

Append to `src/web/style.css`, next to the existing `.gbtn` rules:

```css
/* Passkey sign-in: same footprint as the Google button so a login screen
   offering both reads as one stack of equal options. */
.pkbtn {
  display: flex; align-items: center; justify-content: center; gap: .5rem;
  width: 100%; padding: .6rem 1rem; margin-top: .5rem;
  border: 1px solid var(--border, #3a3a3a); border-radius: 6px;
  background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.pkbtn:hover:not(:disabled) { background: rgba(127, 127, 127, .12); }
.pkbtn:disabled { opacity: .5; cursor: default; }
.login-note { font-size: .85em; opacity: .75; text-align: center; }
.login-note code { font-family: ui-monospace, monospace; }
```

- [ ] **Step 4: Type-check, build, run the suite**

Run: `npm test && npm run build`
Expected: PASS, all suites green; `dist/` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/api.ts src/web/style.css
git commit -m "feat(web): passkey button on the login screen"
```

---

### Task 14: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `AGENTS.md`, `.env.example`, `docs/DEPLOY.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Document the two new environment variables**

Append to `.env.example`:

```bash
# --- Passkeys (WebAuthn) ---
# The hostname passkeys are bound to. Defaults to the hostname of
# TMUXIFIER_BASE_EXTERNAL_URL, or "localhost" when that is unset. Must be a
# domain name — an IP address cannot be a WebAuthn relying party, and a
# deployment reached by IP simply has passkeys unavailable.
# CHANGING THIS INVALIDATES EVERY ENROLLED PASSKEY.
#TMUXIFIER_RP_ID=tmux.example.com

# Break-glass for the "require a passkey" toggle. Set to "off" and restart to
# re-enable password/Google sign-in after losing your authenticator.
#TMUXIFIER_PASSKEY_ONLY=off
```

- [ ] **Step 2: Document the feature for users**

Add to `README.md`, in the authentication section:

```markdown
### Passkeys

A passkey is an additional way in, available in either auth mode. Enroll one from
**Settings → Passkeys** while signed in; afterwards the login screen offers
**Sign in with a passkey** alongside your password or Google button.

Passkeys are bound to one hostname (the "relying party id"), which Tmuxifier takes
from `TMUXIFIER_BASE_EXTERNAL_URL` unless you set `TMUXIFIER_RP_ID`. Two consequences:

- The browser must reach Tmuxifier over `https://<hostname>` or `http://localhost`.
  **An IP address cannot be used** — a deployment reached by IP shows passkeys as
  unavailable, with everything else working as before.
- Changing that hostname invalidates every enrolled passkey. The Settings tab
  detects this and tells you which hostname the existing passkeys belong to.

Optionally, **Require a passkey** disables password and Google sign-in entirely.
It refuses to arm until at least one passkey is enrolled, and removing your last
passkey turns it back off. If you lose your authenticator, set
`TMUXIFIER_PASSKEY_ONLY=off` in `.env` and restart.
```

- [ ] **Step 3: Update the agent-facing docs**

Add to the module list in **both** `CLAUDE.md` and `AGENTS.md` (keep the two in sync):

```markdown
- `webauthn.js` — dependency-free WebAuthn verification: a minimal CBOR reader (registration
  only), COSE→`KeyObject` import (ES256/RS256/EdDSA), `makeOriginCheck`, `verifyAssertion`
  (the login path — no CBOR involved) and `verifyRegistration`. Attestation `none` only:
  any other format is refused rather than accepted unverified.
- `passkeyChallenges.js` — `createPasskeyChallenges`: bounded, single-use, 120s WebAuthn
  challenge store (oldest-first eviction, same rule as `rateLimit.js`). The token rides an
  httpOnly `SameSite=strict` `tmuxifier_pk` cookie.
- `passkeyStore.js` — `data/passkeys.json` CRUD plus the `passkeyOnly` flag. Public keys are
  not secrets, so nothing is sealed, but the file is `0o600` via `jsonFile.js`. The RP id is
  pinned by the first enrollment and cleared when the last credential is removed; removing
  the last credential also disarms `passkeyOnly`. A corrupt store fails **open** by design.
```

Add `data/passkeys.json` to the `data/` file list in the "Self-contained principle" section of both files:

```markdown
`passkeys.json` (enrolled WebAuthn credentials and the passkey-only flag),
```

Add to the security notes in both files:

```markdown
- Passkeys are a third login path, not a replacement: password/Google remains the bootstrap
  (you must be signed in to enroll) and the recovery route. The opt-in "require a passkey"
  toggle disables the other paths, guarded three ways — arming is refused with zero
  credentials enrolled, removing the last credential auto-disarms it, and
  `TMUXIFIER_PASSKEY_ONLY=off` in `.env` overrides the stored flag as the break-glass.
- Passkey login shares the per-IP `rateLimit.js` bucket with password login, so it is not a
  way around the lockout. Assertion failures return one generic 401 whether the credential
  is unknown or the signature is bad, so credential ids cannot be enumerated.
```

Add to the web-client module list in both files:

```markdown
`passkeys.ts` (passkey fetch layer, base64url ↔ bytes helpers, the pure WebAuthn option/credential
converters, and `evaluateOrigin` — the five-state readiness verdict the settings tab renders),
`settingsPasskeys.ts` (the Settings → Passkeys tab: readiness row, enrolled list, and the
confirm-gated passkey-only toggle),
```

- [ ] **Step 4: Document the deployment requirement**

Add to `docs/DEPLOY.md`:

```markdown
## Passkeys and the relying party id

Passkeys bind to the hostname in the browser's address bar. Tmuxifier derives it from
`TMUXIFIER_BASE_EXTERNAL_URL`, or you can set `TMUXIFIER_RP_ID` explicitly.

- Serve over `https://<hostname>`. Plain `http` works only for `localhost`.
- An IP address cannot be a relying party id. Reaching Tmuxifier at `https://192.168.1.10`
  leaves passkeys unavailable; everything else is unaffected.
- Changing the hostname invalidates every enrolled passkey. Remove them from
  Settings → Passkeys and enroll again on the new hostname.
```

- [ ] **Step 5: Verify and commit**

Run: `npm test`
Expected: PASS.

Run: `git diff --cached` after staging and confirm no real domains, IPs, hostnames or emails appear.

```bash
git add README.md CLAUDE.md AGENTS.md .env.example docs/DEPLOY.md
git diff --cached
git commit -m "docs: passkey sign-in setup, security model and deployment requirements"
```

---

## Done criteria

- `npm test` passes (typecheck + all vitest suites).
- `npm run build` succeeds.
- A passkey can be enrolled from Settings → Passkeys and used to sign in from the login screen.
- Arming "require a passkey" makes `POST /api/login` return 403 and both Google routes redirect to `/?error=passkey-only`.
- `TMUXIFIER_PASSKEY_ONLY=off` restores password/Google sign-in after a restart.
- An IP-addressed deployment still boots, still signs in by password/Google, and reports passkeys as unavailable.
- `package.json` still lists exactly five runtime dependencies.
