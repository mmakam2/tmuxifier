# Settings Modal + NetBox API Integration Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ⚙ settings button to the sidebar brand actions that opens a settings modal whose first section configures the NetBox API integration (URL, token, TLS mode, Test Connection), persisted server-side with the token encrypted at rest.

**Architecture:** Mirrors the existing Proxmox integration trio — pure validators (`netboxValidate.js`), a `secretBox`-sealing store (`netboxStore.js`, `data/netbox.json`), and a dependency-free HTTP(S) client (`netboxApi.js`) — exposed as four auth-gated routes under `/api/netbox/*`. Shared TLS-pinning helpers are extracted from `proxmoxApi.js` into `tlsPin.js`. The web client gets a fetch layer (`netbox.ts`), pure form helpers (`settingsForm.ts`), and the modal (`settingsUi.ts`).

**Tech Stack:** Node 20+ ESM, Fastify 5, vitest, `node:http`/`node:https`/`node:tls`, TypeScript web client bundled by Vite.

**Spec:** `docs/superpowers/specs/2026-07-10-settings-modal-netbox-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`); server code plain `.js`, web client `.ts`.
- TDD: write the failing test first. Tests use real code (real temp dirs, real `secretBox`); dependencies are injected via factory arguments, never module-mocked.
- Secrets: sealed with `secretBox` before hitting disk; data files written `0o600` (via `writeJson`'s default); tokens never appear in any HTTP response body.
- Conventional-commit messages (`feat(netbox): …`, `refactor(tls): …`).
- The GitHub repo is public — tests and docs use placeholder hosts (`netbox.example.com`, RFC1918 IPs), never real ones.
- Run tests with `npx vitest run <file>` per task; `npm test` (typecheck + full suite) at the end.

---

### Task 1: `netboxValidate.js` — pure input validators

**Files:**
- Create: `src/server/netboxValidate.js`
- Test: `test/netboxValidate.test.js`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `parseNetboxUrl(value: unknown): string` — returns a normalized URL string (`http(s)://host[:port][/path]`, no trailing slash, no trailing `/api`), throws `Error` on anything else.
  - `assertSettingsInput(spec, { requireToken = true } = {}): { url, tlsMode, fingerprint256 }` — validates `{ url, token?, tlsMode?, fingerprint256? }`; returns the normalized persistable fields (`tlsMode` is `null` for http URLs, `fingerprint256` is non-null only in pin mode); throws `Error` with a user-facing message otherwise.

- [ ] **Step 1: Write the failing test**

```js
// test/netboxValidate.test.js
import { test, expect } from 'vitest';
import { parseNetboxUrl, assertSettingsInput } from '../src/server/netboxValidate.js';

test('parseNetboxUrl normalizes scheme/host/path and strips trailing slash and /api', () => {
  expect(parseNetboxUrl('https://netbox.example.com')).toBe('https://netbox.example.com');
  expect(parseNetboxUrl('https://netbox.example.com/')).toBe('https://netbox.example.com');
  expect(parseNetboxUrl('https://netbox.example.com/api/')).toBe('https://netbox.example.com');
  expect(parseNetboxUrl('http://192.168.1.10:8000')).toBe('http://192.168.1.10:8000');
  expect(parseNetboxUrl('https://example.com/netbox')).toBe('https://example.com/netbox');
});

test('parseNetboxUrl rejects junk', () => {
  expect(() => parseNetboxUrl('')).toThrow(/required/);
  expect(() => parseNetboxUrl('netbox.example.com')).toThrow(/http/);
  expect(() => parseNetboxUrl('ftp://x')).toThrow(/http/);
  expect(() => parseNetboxUrl('https://user:pw@x.example.com')).toThrow(/credentials/);
  expect(() => parseNetboxUrl('https://x.example.com/?a=1')).toThrow(/query/);
});

test('assertSettingsInput returns normalized fields for https + ca (default mode)', () => {
  expect(assertSettingsInput({ url: 'https://netbox.example.com/', token: 'abc123' }))
    .toEqual({ url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null });
});

test('assertSettingsInput: http URLs carry no tlsMode', () => {
  expect(assertSettingsInput({ url: 'http://192.168.1.10:8000', token: 't', tlsMode: 'pin' }))
    .toEqual({ url: 'http://192.168.1.10:8000', tlsMode: null, fingerprint256: null });
});

test('assertSettingsInput: pin mode requires a fingerprint', () => {
  expect(() => assertSettingsInput({ url: 'https://x.example.com', token: 't', tlsMode: 'pin' }))
    .toThrow(/fingerprint/);
  expect(assertSettingsInput({ url: 'https://x.example.com', token: 't', tlsMode: 'pin', fingerprint256: 'AB:CD:12' }))
    .toEqual({ url: 'https://x.example.com', tlsMode: 'pin', fingerprint256: 'AB:CD:12' });
});

test('assertSettingsInput: token rules', () => {
  expect(() => assertSettingsInput({ url: 'https://x.example.com' })).toThrow(/token/);
  expect(() => assertSettingsInput({ url: 'https://x.example.com', token: '  ' })).toThrow(/token/);
  expect(() => assertSettingsInput({ url: 'https://x.example.com', token: 'has space' })).toThrow(/token/);
  // requireToken:false skips the presence check (used for keep-existing-token saves)
  expect(assertSettingsInput({ url: 'https://x.example.com' }, { requireToken: false }).url)
    .toBe('https://x.example.com');
});

test('assertSettingsInput rejects unknown tlsMode', () => {
  expect(() => assertSettingsInput({ url: 'https://x.example.com', token: 't', tlsMode: 'yolo' })).toThrow(/tlsMode/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/netboxValidate.test.js`
Expected: FAIL — `Cannot find module '../src/server/netboxValidate.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/server/netboxValidate.js
const FINGERPRINT = /^[0-9A-Fa-f:]+$/;
// NetBox tokens are 40-char hex by default, but plugins/manual tokens vary — accept
// any run of printable non-space ASCII so we never reject a working token.
const TOKEN = /^[\x21-\x7e]{1,512}$/;
const TLS_MODES = ['ca', 'pin', 'insecure'];

export function parseNetboxUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error('NetBox URL is required');
  let u;
  try { u = new URL(s); } catch { throw new Error('NetBox URL must be a full URL like https://netbox.example.com'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('NetBox URL must use http:// or https://');
  if (u.username || u.password) throw new Error('NetBox URL must not embed credentials');
  if (u.search || u.hash) throw new Error('NetBox URL must not contain a query or fragment');
  // Strip a trailing /api — the client appends API paths itself, and pasting the
  // API root from a browser tab is the most common form of the URL.
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

export function assertSettingsInput(spec, { requireToken = true } = {}) {
  const url = parseNetboxUrl(spec.url);
  if (requireToken && !nonEmpty(spec.token)) throw new Error('an API token is required');
  if (nonEmpty(spec.token) && !TOKEN.test(spec.token.trim())) throw new Error('API token contains invalid characters');
  const https = url.startsWith('https:');
  if (!https) return { url, tlsMode: null, fingerprint256: null };
  const tlsMode = spec.tlsMode || 'ca';
  if (!TLS_MODES.includes(tlsMode)) throw new Error(`invalid tlsMode: ${JSON.stringify(tlsMode)}`);
  if (tlsMode === 'pin' && !FINGERPRINT.test(String(spec.fingerprint256 || ''))) {
    throw new Error('pin mode requires a certificate fingerprint');
  }
  return { url, tlsMode, fingerprint256: tlsMode === 'pin' ? spec.fingerprint256 : null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/netboxValidate.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxValidate.js test/netboxValidate.test.js
git commit -m "feat(netbox): pure validators for NetBox integration settings"
```

---

### Task 2: Extract shared TLS-pinning helpers into `tlsPin.js`

`netboxApi.js` (Task 4) needs the same TLS probe / DER→PEM / fingerprint-normalization helpers `proxmoxApi.js` has as private functions. Move them to a shared module; behavior unchanged.

**Files:**
- Create: `src/server/tlsPin.js`
- Modify: `src/server/proxmoxApi.js` (delete the three local helpers, import them instead)

**Interfaces:**
- Produces (all previously private in `proxmoxApi.js`, code identical apart from the `port` default):
  - `tlsProbe({ host, port, timeoutMs = 15000 }): Promise<{ fingerprint256, raw, chain, authorized, subject, issuer, valid_to }>`
  - `derToPem(der: Buffer): string`
  - `normFp(s: unknown): string`

- [ ] **Step 1: Create `src/server/tlsPin.js`**

Move lines verbatim from `src/server/proxmoxApi.js` (the `tlsProbe`, `derToPem`, `normFp` function bodies and the comments inside them), with one change: `tlsProbe`'s signature drops the `= 8006` port default (both existing call sites pass `port` explicitly; a Proxmox-specific default doesn't belong in a shared module).

```js
// src/server/tlsPin.js
import tls from 'node:tls';

// Shared TLS fingerprint-pinning helpers (TOFU, like ssh accept-new) used by the
// Proxmox and NetBox API clients.
export function tlsProbe({ host, port, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    // SNI is only valid for hostnames, not IP literals (RFC 6066); omit it for IPs.
    const servername = /[A-Za-z]/.test(host) && !host.includes(':') ? host : undefined;
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate(true);
      const authorized = socket.authorized === true;
      socket.end();
      if (!cert || !cert.raw) { reject(new Error('no peer certificate presented')); return; }
      // Collect the whole presented chain, not just the leaf: a default PVE cert
      // (pve-ssl.pem) is signed by the node's cluster CA, and OpenSSL only anchors
      // trust at a self-signed cert — pinning the leaf alone can never verify the
      // stock Proxmox cert shape. issuerCertificate is self-referential on a
      // self-signed cert, so guard against the cycle.
      const chain = [];
      const seen = new Set();
      for (let c = cert; c && c.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
        seen.add(c.fingerprint256);
        chain.push(c.raw);
      }
      resolve({ fingerprint256: cert.fingerprint256 || null, raw: cert.raw, chain, authorized, subject: cert.subject, issuer: cert.issuer, valid_to: cert.valid_to });
    });
    socket.on('timeout', () => socket.destroy(new Error('TLS connection timed out')));
    socket.on('error', reject);
  });
}

export function derToPem(der) { const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n'); return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`; }

export function normFp(s) { return String(s || '').toUpperCase().replace(/[^0-9A-F]/g, ''); }
```

- [ ] **Step 2: Update `src/server/proxmoxApi.js`**

Delete the local `tlsProbe`, `derToPem`, `normFp` definitions and the now-unused `import tls from 'node:tls';`. Add:

```js
import { tlsProbe, derToPem, normFp } from './tlsPin.js';
```

No other changes — every call site keeps working (`inspectEndpoint` and `resolveTls` already pass `port` explicitly).

- [ ] **Step 3: Run the existing Proxmox tests to prove behavior is unchanged**

Run: `npx vitest run test/proxmoxApi.test.js test/proxmoxApi.integration.test.js test/proxmoxStore.test.js`
Expected: PASS (same counts as before the change)

- [ ] **Step 4: Commit**

```bash
git add src/server/tlsPin.js src/server/proxmoxApi.js
git commit -m "refactor(tls): extract shared fingerprint-pinning helpers from proxmoxApi"
```

---

### Task 3: `netboxStore.js` — persisted, sealed settings

**Files:**
- Create: `src/server/netboxStore.js`
- Test: `test/netboxStore.test.js`

**Interfaces:**
- Consumes: `assertSettingsInput` (Task 1), `readJson`/`writeJson` from `src/server/jsonFile.js`, a `secretBox` from `createSecretBox(cookieSecret)`.
- Produces: `createNetboxStore({ dataDir, secretBox, now = () => new Date().toISOString() })` returning:
  - `getSettings({ withSecret = false } = {}): Promise<null | { url, tlsMode, fingerprint256, updatedAt, hasToken }>` — `withSecret: true` swaps `hasToken` for the decrypted `token` (server-internal only).
  - `setSettings(spec): Promise<RedactedSettings>` — validates; blank/absent `token` keeps the existing sealed token (error if none stored); writes `data/netbox.json` `0o600`.
  - `clearSettings(): Promise<void>`

- [ ] **Step 1: Write the failing test**

```js
// test/netboxStore.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNetboxStore } from '../src/server/netboxStore.js';
import { createSecretBox } from '../src/server/secretBox.js';

let dir;
const secretBox = createSecretBox('test-cookie');
const make = () => createNetboxStore({ dataDir: dir, secretBox });
const SPEC = { url: 'https://netbox.example.com/', token: 'nb-super-secret', tlsMode: 'ca' };

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-nbx-')); });

test('getSettings returns null before anything is saved', async () => {
  expect(await make().getSettings()).toBeNull();
});

test('setSettings seals the token; reads are redacted; file is 0600 and ciphertext-only', async () => {
  const store = make();
  const saved = await store.setSettings(SPEC);
  expect(saved.token).toBeUndefined();
  expect(saved.hasToken).toBe(true);
  expect(saved.url).toBe('https://netbox.example.com'); // normalized
  const got = await store.getSettings();
  expect(got.token).toBeUndefined();
  expect(got.hasToken).toBe(true);
  const raw = await fs.readFile(path.join(dir, 'netbox.json'), 'utf8');
  expect(raw).not.toContain('nb-super-secret');
  expect(raw).toContain('pvebox.v1:'); // secretBox scheme tag
  const stat = await fs.stat(path.join(dir, 'netbox.json'));
  expect(stat.mode & 0o777).toBe(0o600);
});

test('getSettings withSecret decrypts the token', async () => {
  const store = make();
  await store.setSettings(SPEC);
  expect((await store.getSettings({ withSecret: true })).token).toBe('nb-super-secret');
});

test('blank token on save keeps the existing token; other fields update', async () => {
  const store = make();
  await store.setSettings(SPEC);
  const saved = await store.setSettings({ url: 'https://nb2.example.com', token: '', tlsMode: 'insecure' });
  expect(saved.url).toBe('https://nb2.example.com');
  expect(saved.tlsMode).toBe('insecure');
  const full = await store.getSettings({ withSecret: true });
  expect(full.token).toBe('nb-super-secret');
});

test('blank token with nothing stored is rejected', async () => {
  await expect(make().setSettings({ url: 'https://x.example.com', token: '' })).rejects.toThrow(/token/);
});

test('invalid input is rejected before anything is written', async () => {
  const store = make();
  await expect(store.setSettings({ url: 'nope', token: 't' })).rejects.toThrow(/URL/);
  await expect(fs.stat(path.join(dir, 'netbox.json'))).rejects.toThrow(); // no file created
});

test('clearSettings removes the stored settings', async () => {
  const store = make();
  await store.setSettings(SPEC);
  await store.clearSettings();
  expect(await store.getSettings()).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/netboxStore.test.js`
Expected: FAIL — `Cannot find module '../src/server/netboxStore.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/server/netboxStore.js
import path from 'node:path';
import { assertSettingsInput } from './netboxValidate.js';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;

// Persisted NetBox integration settings (data/netbox.json). Single-settings-object
// store, not a list: Tmuxifier talks to one NetBox. The API token is sealed by
// secretBox before it touches disk and redacted to hasToken on every read;
// getSettings({ withSecret: true }) is the only decrypting path (server-internal).
export function createNetboxStore({ dataDir, secretBox, now = () => new Date().toISOString() }) {
  const file = path.join(dataDir, 'netbox.json');
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (!('settings' in v) || v.settings === null || (typeof v.settings === 'object' && !Array.isArray(v.settings)));
  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape });
    return { version: VERSION, settings: null, ...v };
  }
  function redact(s) {
    const { token, ...rest } = s;
    return { ...rest, hasToken: !!token };
  }
  return {
    async getSettings({ withSecret = false } = {}) {
      const s = (await readAll()).settings;
      if (!s) return null;
      return withSecret ? { ...s, token: secretBox.open(s.token) } : redact(s);
    },
    async setSettings(spec) {
      const data = await readAll();
      const existing = data.settings;
      const blankToken = !(typeof spec.token === 'string' && spec.token.trim());
      const keepToken = blankToken && !!(existing && existing.token);
      const norm = assertSettingsInput(spec, { requireToken: !keepToken });
      const token = keepToken ? existing.token : secretBox.seal(spec.token.trim());
      data.settings = { ...norm, token, updatedAt: now() };
      await writeJson(file, data, { mode: 0o600 });
      return redact(data.settings);
    },
    async clearSettings() {
      const data = await readAll();
      data.settings = null;
      await writeJson(file, data, { mode: 0o600 });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/netboxStore.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxStore.js test/netboxStore.test.js
git commit -m "feat(netbox): sealed settings store (data/netbox.json)"
```

---

### Task 4: `netboxApi.js` — `testNetbox` connection probe

**Files:**
- Create: `src/server/netboxApi.js`
- Test: `test/netboxApi.test.js`

**Interfaces:**
- Consumes: `tlsProbe`, `derToPem`, `normFp` from `tlsPin.js` (Task 2). Settings shape `{ url, tlsMode, fingerprint256, token }` (decrypted, from Task 3's `getSettings({ withSecret: true })` or the test route's merge).
- Produces: `testNetbox(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs = 10000 } = {})` resolving (never throwing) to one of:
  - `{ ok: true, version: string }`
  - `{ ok: false, kind: 'unreachable' | 'tls' | 'auth' | 'unexpected', error: string, fingerprint256?: string | null }` — `fingerprint256` is present on `kind: 'tls'` so the UI can offer to pin it.
  - `request` receives `{ url, headers, timeoutMs, tls }` and resolves `{ status, json, text }` (same contract as `proxmoxApi`'s `httpsRequest`).

- [ ] **Step 1: Write the failing test**

```js
// test/netboxApi.test.js
import { test, expect } from 'vitest';
import http from 'node:http';
import { testNetbox } from '../src/server/netboxApi.js';

const CA = { url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 'tok123' };
const ok = { status: 200, json: { 'netbox-version': '4.3.2' }, text: '' };

test('200 /api/status/ resolves ok with the NetBox version', async () => {
  const calls = [];
  const res = await testNetbox(CA, { request: async (o) => { calls.push(o); return ok; } });
  expect(res).toEqual({ ok: true, version: '4.3.2' });
  expect(calls[0].url).toBe('https://netbox.example.com/api/status/');
  expect(calls[0].headers.Authorization).toBe('Token tok123');
});

test('a path-prefixed URL keeps its prefix in the probe URL', async () => {
  const calls = [];
  await testNetbox({ ...CA, url: 'https://example.com/netbox' }, { request: async (o) => { calls.push(o); return ok; } });
  expect(calls[0].url).toBe('https://example.com/netbox/api/status/');
});

test('401/403 map to an auth failure with the allowed-IP hint', async () => {
  const res = await testNetbox(CA, { request: async () => ({ status: 403, json: { detail: 'Invalid token' }, text: '' }) });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('auth');
  expect(res.error).toContain('Invalid token');
  expect(res.error).toContain('::ffff:'); // IPv4-mapped-IPv6 allowed-IP hint
});

test('pin mode: fingerprint mismatch reports tls with the observed fingerprint and never sends the token', async () => {
  const calls = [];
  const res = await testNetbox(
    { ...CA, tlsMode: 'pin', fingerprint256: 'AA:BB' },
    { connect: async () => ({ fingerprint256: 'CC:DD', raw: Buffer.from('x'), chain: [Buffer.from('x')] }),
      request: async (o) => { calls.push(o); return ok; } },
  );
  expect(res).toEqual({ ok: false, kind: 'tls', fingerprint256: 'CC:DD', error: expect.stringMatching(/fingerprint/i) });
  expect(calls).toHaveLength(0);
});

test('pin mode: matching fingerprint (case/sep-insensitive) pins the probed chain as CA trust', async () => {
  const calls = [];
  const res = await testNetbox(
    { ...CA, tlsMode: 'pin', fingerprint256: 'aabb' },
    { connect: async () => ({ fingerprint256: 'AA:BB', raw: Buffer.from('x'), chain: [Buffer.from('x'), Buffer.from('y')] }),
      request: async (o) => { calls.push(o); return ok; } },
  );
  expect(res.ok).toBe(true);
  expect(calls[0].tls.rejectUnauthorized).toBe(true);
  expect(calls[0].tls.ca).toHaveLength(2);
  expect(calls[0].tls.ca[0]).toContain('BEGIN CERTIFICATE');
  expect(typeof calls[0].tls.checkServerIdentity).toBe('function');
});

test('ca mode: a certificate verification error probes and offers the observed fingerprint', async () => {
  const err = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  const res = await testNetbox(CA, {
    request: async () => { throw err; },
    connect: async () => ({ fingerprint256: 'EE:FF', raw: Buffer.from('x'), chain: [] }),
  });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('tls');
  expect(res.fingerprint256).toBe('EE:FF');
});

test('connection errors report unreachable', async () => {
  const res = await testNetbox(CA, { request: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
  expect(res).toEqual({ ok: false, kind: 'unreachable', error: 'connect ECONNREFUSED' });
});

test('a 200 that is not NetBox reports unexpected', async () => {
  const res = await testNetbox(CA, { request: async () => ({ status: 200, json: { hello: 'world' }, text: '' }) });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unexpected');
});

test('insecure mode passes rejectUnauthorized:false', async () => {
  const calls = [];
  await testNetbox({ ...CA, tlsMode: 'insecure' }, { request: async (o) => { calls.push(o); return ok; } });
  expect(calls[0].tls.rejectUnauthorized).toBe(false);
});

test('plain http works end to end against a real local server (default request impl)', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/status/' && req.headers.authorization === 'Token tok123') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ 'netbox-version': '4.1.0' }));
    } else { res.statusCode = 403; res.end(JSON.stringify({ detail: 'Invalid token' })); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    expect(await testNetbox({ url, tlsMode: null, fingerprint256: null, token: 'tok123' }))
      .toEqual({ ok: true, version: '4.1.0' });
    const bad = await testNetbox({ url, tlsMode: null, fingerprint256: null, token: 'wrong' });
    expect(bad.kind).toBe('auth');
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/netboxApi.test.js`
Expected: FAIL — `Cannot find module '../src/server/netboxApi.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/server/netboxApi.js
import http from 'node:http';
import https from 'node:https';
import { tlsProbe, derToPem, normFp } from './tlsPin.js';

// Certificate-verification failure codes OpenSSL/Node surface on the request
// error. Seeing one in ca mode means "the cert exists but isn't CA-trusted" —
// the fixable-by-pinning case, distinct from plain unreachability.
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
]);

// NetBox token allowed-IP lists match the socket's remote address, which on a
// dual-stack listener is the IPv4-mapped form — a plain a.b.c.d entry won't match.
const AUTH_HINT = 'check the token and its allowed-IP list — requests can arrive from an IPv4-mapped IPv6 address like ::ffff:192.168.1.10';

function jsonRequest({ url, headers = {}, timeoutMs = 10000, tls: tlsOpts = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method: 'GET', headers, timeout: timeoutMs,
      ...(secure ? {
        rejectUnauthorized: tlsOpts.rejectUnauthorized !== false,
        ...(tlsOpts.ca ? { ca: tlsOpts.ca } : {}),
        ...(typeof tlsOpts.checkServerIdentity === 'function' ? { checkServerIdentity: tlsOpts.checkServerIdentity } : {}),
      } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch {} resolve({ status: res.statusCode, json, text: data }); });
    });
    req.on('timeout', () => req.destroy(new Error('NetBox request timed out')));
    req.on('error', reject);
    req.end();
  });
}

// Probe {url}/api/status/ with the token. Resolves a result object instead of
// throwing so the /api/netbox/test route (and the UI) get one shape to render.
export async function testNetbox(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs = 10000 } = {}) {
  const u = new URL(settings.url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || 443;
  const mode = secure ? (settings.tlsMode || 'ca') : null;
  let tlsOpts = {};
  if (mode === 'insecure') tlsOpts = { rejectUnauthorized: false };
  if (mode === 'pin') {
    let probe;
    try { probe = await connect({ host: u.hostname, port, timeoutMs }); }
    catch (e) { return { ok: false, kind: 'unreachable', error: e.message }; }
    if (!normFp(settings.fingerprint256) || normFp(probe.fingerprint256) !== normFp(settings.fingerprint256)) {
      return { ok: false, kind: 'tls', fingerprint256: probe.fingerprint256 || null, error: 'TLS fingerprint mismatch — the NetBox certificate changed; re-pin to accept the new one' };
    }
    const trust = probe.chain && probe.chain.length ? probe.chain : [probe.raw];
    tlsOpts = { ca: trust.map(derToPem), rejectUnauthorized: true, checkServerIdentity: () => undefined };
  }
  let res;
  try {
    res = await request({ url: `${settings.url}/api/status/`, headers: { Authorization: `Token ${settings.token}`, Accept: 'application/json' }, timeoutMs, tls: tlsOpts });
  } catch (e) {
    if (mode === 'ca' && TLS_ERROR_CODES.has(e.code)) {
      let fp = null;
      try { fp = (await connect({ host: u.hostname, port, timeoutMs })).fingerprint256; } catch { /* keep null */ }
      return { ok: false, kind: 'tls', fingerprint256: fp, error: `TLS verification failed (${e.message}) — pin the certificate fingerprint to trust this server` };
    }
    return { ok: false, kind: 'unreachable', error: e.message };
  }
  if (res.status === 401 || res.status === 403) {
    const detail = res.json && res.json.detail ? `${res.json.detail} — ` : '';
    return { ok: false, kind: 'auth', error: `NetBox rejected the token (${res.status}): ${detail}${AUTH_HINT}` };
  }
  if (res.status !== 200 || !res.json || typeof res.json['netbox-version'] !== 'string') {
    return { ok: false, kind: 'unexpected', error: `unexpected response from ${settings.url}/api/status/ (HTTP ${res.status}) — is this a NetBox URL?` };
  }
  return { ok: true, version: res.json['netbox-version'] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/netboxApi.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxApi.js test/netboxApi.test.js
git commit -m "feat(netbox): connection test probe with ca/pin/insecure TLS modes"
```

---

### Task 5: `/api/netbox/*` routes + wiring

**Files:**
- Modify: `src/server/server.js` (buildServer signature + new route block after the Proxmox routes)
- Modify: `src/server/index.js` (construct the store, pass it in)
- Test: `test/netboxRoutes.test.js`

**Interfaces:**
- Consumes: `createNetboxStore` (Task 3), `testNetbox` (Task 4), `assertSettingsInput` (Task 1).
- Produces (all `preHandler: requireAuth`):
  - `GET /api/netbox/settings` → `{ settings: RedactedSettings | null }`
  - `PUT /api/netbox/settings` body `{ url, token?, tlsMode?, fingerprint256? }` → `{ settings }` | `400 { error }`
  - `DELETE /api/netbox/settings` → `{ ok: true }`
  - `POST /api/netbox/test` body may carry unsaved form values; blank token falls back to the stored one → `200 TestResult` | `400 { error }` | `502 { error }` (stored token undecryptable)
- `buildServer` gains `netboxStore` and `netboxTest = testNetbox` parameters (the latter injectable for tests).

- [ ] **Step 1: Write the failing test**

```js
// test/netboxRoutes.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createNetboxStore } from '../src/server/netboxStore.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, netboxStore, testCalls;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-nbxr-'));
  netboxStore = createNetboxStore({ dataDir: dir, secretBox: createSecretBox('test-secret') });
  testCalls = [];
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker, netboxStore,
    netboxTest: async (candidate) => { testCalls.push(candidate); return { ok: true, version: '4.3.2' }; },
  });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('netbox routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/netbox/settings' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'PUT', url: '/api/netbox/settings', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'DELETE', url: '/api/netbox/settings' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/netbox/test', payload: {} })).statusCode).toBe(401);
});

test('GET returns null settings before configuration', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'GET', url: '/api/netbox/settings', headers: h })).json()).toEqual({ settings: null });
});

test('PUT round-trip: saved redacted, token never in any response body', async () => {
  const h = await headers();
  const put = await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com/', token: 'nb-secret-token' } });
  expect(put.statusCode).toBe(200);
  expect(put.json().settings).toMatchObject({ url: 'https://netbox.example.com', tlsMode: 'ca', hasToken: true });
  expect(put.body).not.toContain('nb-secret-token');
  const get = await app.inject({ method: 'GET', url: '/api/netbox/settings', headers: h });
  expect(get.json().settings.hasToken).toBe(true);
  expect(get.body).not.toContain('nb-secret-token');
});

test('PUT rejects a bad URL with 400', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'nope', token: 't' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/URL/);
});

test('PUT with blank token keeps the stored token', async () => {
  const h = await headers();
  await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 'nb-secret-token' } });
  const res = await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://nb2.example.com', token: '' } });
  expect(res.statusCode).toBe(200);
  expect((await netboxStore.getSettings({ withSecret: true })).token).toBe('nb-secret-token');
});

test('DELETE clears settings', async () => {
  const h = await headers();
  await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 't0k' } });
  expect((await app.inject({ method: 'DELETE', url: '/api/netbox/settings', headers: h })).json()).toEqual({ ok: true });
  expect((await app.inject({ method: 'GET', url: '/api/netbox/settings', headers: h })).json()).toEqual({ settings: null });
});

test('POST test merges body over stored settings and falls back to the stored token', async () => {
  const h = await headers();
  await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 'stored-tok' } });
  const res = await app.inject({ method: 'POST', url: '/api/netbox/test', headers: h, payload: { url: 'https://nb2.example.com', token: '' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, version: '4.3.2' });
  expect(testCalls[0]).toMatchObject({ url: 'https://nb2.example.com', token: 'stored-tok' });
  expect(res.body).not.toContain('stored-tok');
});

test('POST test with no token anywhere is a 400', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/netbox/test', headers: h, payload: { url: 'https://netbox.example.com' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/token/);
});

test('POST test with a body token needs no stored settings', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/netbox/test', headers: h, payload: { url: 'http://192.168.1.10:8000', token: 'fresh-tok' } });
  expect(res.statusCode).toBe(200);
  expect(testCalls[0]).toMatchObject({ url: 'http://192.168.1.10:8000', token: 'fresh-tok', tlsMode: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/netboxRoutes.test.js`
Expected: FAIL — 404s (routes not registered)

- [ ] **Step 3: Register the routes in `src/server/server.js`**

Add to the imports at the top:

```js
import { assertSettingsInput as assertNetboxSettings } from './netboxValidate.js';
import { testNetbox } from './netboxApi.js';
```

Add the two parameters to the `buildServer` destructuring (after `inspectEndpoint`):

```js
netboxStore, netboxTest = testNetbox,
```

Insert this block after the Proxmox provisioning routes (after the `GET /api/proxmox/provisions/:id` handler):

```js
  // --- NetBox integration settings ---
  app.get('/api/netbox/settings', { preHandler: requireAuth }, async () => ({ settings: await netboxStore.getSettings() }));
  app.put('/api/netbox/settings', { preHandler: requireAuth }, async (req, reply) => {
    try { return { settings: await netboxStore.setSettings(req.body || {}) }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/netbox/settings', { preHandler: requireAuth }, async () => { await netboxStore.clearSettings(); return { ok: true }; });
  // Test may carry unsaved form values; a blank token falls back to the stored one
  // so "test before saving" works without ever echoing the token to the browser.
  app.post('/api/netbox/test', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body || {};
    const bodyToken = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
    let stored = null;
    try { stored = await netboxStore.getSettings({ withSecret: !bodyToken }); }
    catch { return reply.code(502).send({ error: 'could not decrypt the stored NetBox token — re-enter it (was TMUXIFIER_COOKIE_SECRET rotated?)' }); }
    const token = bodyToken || (stored && stored.token) || null;
    if (!token) return reply.code(400).send({ error: 'an API token is required — enter one or save settings first' });
    let candidate;
    try {
      candidate = {
        ...assertNetboxSettings({
          url: body.url ?? (stored && stored.url),
          token,
          tlsMode: body.tlsMode ?? (stored && stored.tlsMode) ?? undefined,
          fingerprint256: body.fingerprint256 ?? (stored && stored.fingerprint256),
        }),
        token,
      };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
    return netboxTest(candidate);
  });
```

- [ ] **Step 4: Wire the store in `src/server/index.js`**

Add the import next to `createProxmoxStore`:

```js
import { createNetboxStore } from './netboxStore.js';
```

Construct it right after `proxmoxStore` (reusing the existing `secretBox`):

```js
const netboxStore = createNetboxStore({ dataDir: config.dataDir, secretBox });
```

Add `netboxStore` to the `buildServer({ … })` argument object.

- [ ] **Step 5: Run the new tests and the existing server tests**

Run: `npx vitest run test/netboxRoutes.test.js test/server.test.js`
Expected: PASS (netboxRoutes: 9 tests; server.test.js unchanged — old tests never hit `/api/netbox`, so the undefined `netboxStore` in their `makeApp` is harmless)

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js src/server/index.js test/netboxRoutes.test.js
git commit -m "feat(netbox): /api/netbox settings + test-connection routes"
```

---

### Task 6: Client data layer — `netbox.ts` + pure `settingsForm.ts`

**Files:**
- Create: `src/web/netbox.ts`
- Create: `src/web/settingsForm.ts`
- Test: `test/settingsForm.test.js`

**Interfaces:**
- Consumes: the Task 5 routes.
- Produces:
  - `netbox.ts`: types `NetboxSettings`, `NetboxTestResult`, `NetboxSettingsInput` and the `nbx` fetch object (`get()`, `save(spec)`, `clear()`, `test(spec)`).
  - `settingsForm.ts`: `isHttps(url)`, `buildSavePayload(state): { payload?: NetboxSettingsInput; error?: string }`, `describeTestResult(result): { text: string; ok: boolean; offerPin: string | null }` — pure, DOM-free, unit-tested.

- [ ] **Step 1: Write the failing test**

```js
// test/settingsForm.test.js
import { test, expect } from 'vitest';
import { isHttps, buildSavePayload, describeTestResult } from '../src/web/settingsForm.ts';

const state = (over = {}) => ({ url: 'https://netbox.example.com', token: 'tok', tlsMode: 'ca', fingerprint256: null, hasToken: false, ...over });

test('isHttps', () => {
  expect(isHttps('https://x.example.com')).toBe(true);
  expect(isHttps('  HTTPS://x')).toBe(true);
  expect(isHttps('http://x.example.com')).toBe(false);
});

test('buildSavePayload: happy path https/ca', () => {
  expect(buildSavePayload(state())).toEqual({ payload: { url: 'https://netbox.example.com', token: 'tok', tlsMode: 'ca' } });
});

test('buildSavePayload: blank token allowed only when one is already saved', () => {
  expect(buildSavePayload(state({ token: '' })).error).toMatch(/token/);
  expect(buildSavePayload(state({ token: '', hasToken: true })).payload).toEqual({ url: 'https://netbox.example.com', tlsMode: 'ca' });
});

test('buildSavePayload: pin mode requires a fingerprint and includes it', () => {
  expect(buildSavePayload(state({ tlsMode: 'pin' })).error).toMatch(/fingerprint/i);
  expect(buildSavePayload(state({ tlsMode: 'pin', fingerprint256: 'AB:CD' })).payload)
    .toEqual({ url: 'https://netbox.example.com', token: 'tok', tlsMode: 'pin', fingerprint256: 'AB:CD' });
});

test('buildSavePayload: http URL omits tlsMode; junk URL errors', () => {
  expect(buildSavePayload(state({ url: 'http://192.168.1.10:8000' })).payload)
    .toEqual({ url: 'http://192.168.1.10:8000', token: 'tok' });
  expect(buildSavePayload(state({ url: '' })).error).toMatch(/URL/);
  expect(buildSavePayload(state({ url: 'netbox.example.com' })).error).toMatch(/http/);
});

test('describeTestResult: success, failure, and the pin offer', () => {
  expect(describeTestResult({ ok: true, version: '4.3.2' })).toEqual({ text: 'Connected — NetBox 4.3.2', ok: true, offerPin: null });
  expect(describeTestResult({ ok: false, kind: 'auth', error: 'no' })).toEqual({ text: 'no', ok: false, offerPin: null });
  expect(describeTestResult({ ok: false, kind: 'tls', error: 'mismatch', fingerprint256: 'AB:CD' }))
    .toEqual({ text: 'mismatch', ok: false, offerPin: 'AB:CD' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/settingsForm.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write both modules**

```ts
// src/web/netbox.ts
export interface NetboxSettings {
  url: string; tlsMode: 'ca' | 'pin' | 'insecure' | null;
  fingerprint256: string | null; hasToken: boolean; updatedAt: string;
}
export interface NetboxSettingsInput {
  url: string; token?: string; tlsMode?: 'ca' | 'pin' | 'insecure'; fingerprint256?: string | null;
}
export type NetboxTestResult =
  | { ok: true; version: string }
  | { ok: false; kind: 'unreachable' | 'tls' | 'auth' | 'unexpected'; error: string; fingerprint256?: string | null };

async function jr<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
  return res.json() as Promise<T>;
}
const jsonBody = (method: string, v: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });

export const nbx = {
  get() { return jr<{ settings: NetboxSettings | null }>(fetch('/api/netbox/settings')); },
  save(spec: NetboxSettingsInput) { return jr<{ settings: NetboxSettings }>(fetch('/api/netbox/settings', jsonBody('PUT', spec))); },
  clear() { return jr<{ ok: boolean }>(fetch('/api/netbox/settings', { method: 'DELETE' })); },
  test(spec: Partial<NetboxSettingsInput>) { return jr<NetboxTestResult>(fetch('/api/netbox/test', jsonBody('POST', spec))); },
};
```

```ts
// src/web/settingsForm.ts
// Pure helpers behind the settings modal (settingsUi.ts) — DOM-free so they are
// unit-testable, mirroring the termFont.ts pattern.
import type { NetboxSettingsInput, NetboxTestResult } from './netbox';

export interface NetboxFormState {
  url: string; token: string; tlsMode: 'ca' | 'pin' | 'insecure';
  fingerprint256: string | null; hasToken: boolean;
}

export function isHttps(url: string): boolean { return /^https:\/\//i.test(url.trim()); }

export function buildSavePayload(s: NetboxFormState): { payload?: NetboxSettingsInput; error?: string } {
  const url = s.url.trim();
  if (!url) return { error: 'NetBox URL is required' };
  if (!/^https?:\/\//i.test(url)) return { error: 'URL must start with http:// or https://' };
  const token = s.token.trim();
  if (!token && !s.hasToken) return { error: 'an API token is required' };
  const payload: NetboxSettingsInput = { url };
  if (token) payload.token = token;
  if (isHttps(url)) {
    payload.tlsMode = s.tlsMode;
    if (s.tlsMode === 'pin') {
      if (!s.fingerprint256) return { error: 'pin mode needs a certificate fingerprint — run Test Connection to fetch it' };
      payload.fingerprint256 = s.fingerprint256;
    }
  }
  return { payload };
}

export function describeTestResult(r: NetboxTestResult): { text: string; ok: boolean; offerPin: string | null } {
  if (r.ok) return { text: `Connected — NetBox ${r.version}`, ok: true, offerPin: null };
  return { text: r.error, ok: false, offerPin: r.kind === 'tls' && r.fingerprint256 ? r.fingerprint256 : null };
}
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `npx vitest run test/settingsForm.test.js && npm run typecheck`
Expected: PASS (6 tests), typecheck clean

- [ ] **Step 5: Commit**

```bash
git add src/web/netbox.ts src/web/settingsForm.ts test/settingsForm.test.js
git commit -m "feat(ui): NetBox settings fetch layer and pure form helpers"
```

---

### Task 7: Settings modal + ⚙ button

**Files:**
- Create: `src/web/settingsUi.ts`
- Modify: `src/web/main.ts` (gear button in `.brand-actions`, click wiring)
- Modify: `src/web/style.css` (settings-modal styles)

**Interfaces:**
- Consumes: `nbx` (Task 6), `buildSavePayload` / `describeTestResult` / `isHttps` (Task 6).
- Produces: `openSettingsModal(): Promise<void>` — the only export; `main.ts` calls it from the gear button.

There are no DOM tests in this repo (vitest runs in node); this task is verified by `npm run typecheck`, `npm run build`, and a manual walkthrough.

- [ ] **Step 1: Write `src/web/settingsUi.ts`**

Follow the `openLocalShellEditModal` modal conventions in `main.ts` (backdrop element, Escape/cancel/backdrop-mousedown close pattern, `.err` paragraph, `.modal-actions`).

```ts
// src/web/settingsUi.ts
// The app-wide settings modal. NetBox is the first section; future sections
// (each backed by its own server-side store) append below it.
import { nbx, type NetboxSettings } from './netbox';
import { buildSavePayload, describeTestResult, isHttps, type NetboxFormState } from './settingsForm';

function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  wrap.append(span, input);
  return wrap;
}

export async function openSettingsModal(): Promise<void> {
  let current: NetboxSettings | null = null;
  try { current = (await nbx.get()).settings; } catch { /* render empty form */ }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal settings-modal';

  const title = document.createElement('h2');
  title.textContent = 'Settings';
  const section = document.createElement('h3');
  section.textContent = 'NetBox API integration';

  const url = document.createElement('input');
  url.type = 'text';
  url.placeholder = 'https://netbox.example.com';
  url.value = current?.url ?? '';
  url.autocomplete = 'off';

  const token = document.createElement('input');
  token.type = 'password';
  token.placeholder = current?.hasToken ? 'token saved — leave blank to keep' : 'NetBox API token';
  token.autocomplete = 'new-password';

  const httpNote = document.createElement('p');
  httpNote.className = 'settings-hint';
  httpNote.textContent = 'http:// — the token travels in cleartext; LAN use only.';

  // TLS mode (https only)
  const tlsGroup = document.createElement('fieldset');
  tlsGroup.className = 'radio-group';
  const tlsLegend = document.createElement('legend');
  tlsLegend.textContent = 'TLS verification';
  tlsGroup.append(tlsLegend);
  let tlsMode: 'ca' | 'pin' | 'insecure' = current?.tlsMode ?? 'ca';
  let fingerprint256: string | null = current?.fingerprint256 ?? null;
  const fpHint = document.createElement('p');
  fpHint.className = 'settings-hint settings-fp';
  function renderFp() {
    fpHint.textContent = tlsMode === 'pin'
      ? (fingerprint256 ? `pinned: ${fingerprint256}` : 'no fingerprint pinned yet — run Test Connection to fetch it')
      : '';
  }
  function makeTls(value: 'ca' | 'pin' | 'insecure', label: string) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'netboxTlsMode';
    input.value = value;
    input.checked = tlsMode === value;
    input.addEventListener('change', () => { if (input.checked) { tlsMode = value; renderFp(); } });
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    return wrap;
  }
  tlsGroup.append(
    makeTls('ca', 'CA-verified (default)'),
    makeTls('pin', 'Pinned fingerprint (self-signed)'),
    makeTls('insecure', 'No verification (not recommended)'),
    fpHint,
  );
  renderFp();

  function syncSchemeUi() {
    const https = isHttps(url.value);
    tlsGroup.hidden = !https;
    httpNote.hidden = https || !/^http:\/\//i.test(url.value.trim());
  }
  url.addEventListener('input', syncSchemeUi);

  // Test Connection
  const testRow = document.createElement('div');
  testRow.className = 'settings-test';
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.textContent = 'Test Connection';
  const testOut = document.createElement('span');
  testOut.className = 'settings-hint';
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.textContent = 'Pin this certificate';
  pinBtn.hidden = true;
  testRow.append(testBtn, pinBtn);

  function formState(): NetboxFormState {
    return { url: url.value, token: token.value, tlsMode, fingerprint256, hasToken: !!current?.hasToken };
  }

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    pinBtn.hidden = true;
    testOut.className = 'settings-hint';
    testOut.textContent = 'Testing…';
    try {
      const body: Record<string, unknown> = { url: url.value.trim() };
      if (token.value.trim()) body.token = token.value.trim();
      if (isHttps(url.value)) { body.tlsMode = tlsMode; if (fingerprint256) body.fingerprint256 = fingerprint256; }
      const result = describeTestResult(await nbx.test(body));
      testOut.textContent = result.text;
      testOut.className = `settings-hint ${result.ok ? 'ok' : 'err'}`;
      if (result.offerPin) {
        pinBtn.hidden = false;
        pinBtn.onclick = () => {
          fingerprint256 = result.offerPin;
          tlsMode = 'pin';
          (tlsGroup.querySelector('input[value="pin"]') as HTMLInputElement).checked = true;
          renderFp();
          pinBtn.hidden = true;
          testOut.textContent = 'fingerprint pinned — run Test Connection again';
          testOut.className = 'settings-hint';
        };
      }
    } catch (ex) {
      testOut.textContent = ex instanceof Error ? ex.message : 'test failed';
      testOut.className = 'settings-hint err';
    } finally { testBtn.disabled = false; }
  });

  const err = document.createElement('p');
  err.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  clearBtn.className = 'settings-clear';
  clearBtn.hidden = !current;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Save';
  actions.append(clearBtn, cancel, submit);

  form.append(title, section, field('NetBox URL', url), httpNote, field('API token', token), tlsGroup, testRow, testOut, err, actions);
  backdrop.appendChild(form);
  document.querySelector('#app')!.appendChild(backdrop);
  syncSchemeUi();

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  // Only close on a genuine backdrop click (see the box modal for why mousedown
  // must also have started on the backdrop).
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  clearBtn.addEventListener('click', async () => {
    if (!window.confirm('Remove the NetBox integration settings (including the stored token)?')) return;
    try { await nbx.clear(); close(); }
    catch (ex) { err.textContent = ex instanceof Error ? ex.message : 'could not clear settings'; }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const { payload, error } = buildSavePayload(formState());
    if (!payload) { err.textContent = error ?? 'invalid settings'; return; }
    submit.disabled = true;
    try { await nbx.save(payload); close(); }
    catch (ex) {
      err.textContent = ex instanceof Error ? ex.message : 'could not save settings';
      submit.disabled = false;
    }
  });
}
```

- [ ] **Step 2: Add the gear button in `src/web/main.ts`**

Add the import near the other feature-module imports at the top of `main.ts`:

```ts
import { openSettingsModal } from './settingsUi';
```

In the `renderDashboard` template, insert the settings button between `#sidebar-toggle` and `#export` inside `.brand-actions`:

```html
<button id="settings" type="button" title="Settings" aria-label="Settings">⚙</button>
```

(The line becomes: `…aria-expanded=…>${sidebarCollapsed ? '›' : '‹'}</button>` `<button id="settings" …>⚙</button>` `<button id="export" …>`.)

Wire it after the `#sidebar-toggle` click handler:

```ts
app.querySelector('#settings')!.addEventListener('click', () => { void openSettingsModal(); });
```

- [ ] **Step 3: Add styles to `src/web/style.css`**

Append after the existing `.modal` rules:

```css
.modal.settings-modal { width: 430px; }
.modal.settings-modal h3 { margin: 4px 0 0; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: #8b949e; }
.modal .settings-hint { margin: 0; font-size: 11px; color: #6e7681; min-height: 1em; }
.modal .settings-hint.err { color: #f85149; }
.modal .settings-hint.ok { color: #3fb950; }
.modal .settings-fp { font-family: ui-monospace, monospace; word-break: break-all; }
.modal .settings-test { display: flex; gap: 8px; align-items: center; }
.modal .settings-test button { padding: 6px 10px; border-radius: 8px; border: 1px solid #232a36; background: #131722; color: #c9d1d9; cursor: pointer; font-size: 12px; }
.modal .settings-clear { margin-right: auto; color: #f85149; }
```

- [ ] **Step 4: Typecheck, build, and verify in the running app**

Run: `npm run typecheck && npm run build`
Expected: both clean.

Manual verification (dev server or built bundle):
1. Log in; the ⚙ button appears between ‹ and ⤓ in the sidebar header.
2. Click ⚙ → modal opens with the NetBox section; empty state shows no Clear button.
3. Enter an `http://` URL → cleartext note appears, TLS group hides; `https://` → TLS group shows.
4. Test Connection against a wrong URL → red error line; against a real/stub NetBox → green "Connected — NetBox <version>".
5. Save with a token → reopen → URL prefilled, token field shows "token saved — leave blank to keep", Clear visible.
6. Escape, Cancel, and backdrop click all close the modal.

- [ ] **Step 5: Commit**

```bash
git add src/web/settingsUi.ts src/web/main.ts src/web/style.css
git commit -m "feat(ui): settings gear + modal with NetBox integration section"
```

---

### Task 8: Docs + full suite

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (architecture lists, data/ inventory, security notes)
- Modify: `README.md` (security bullet; brief settings mention if there is a UI features list)

- [ ] **Step 1: Update `CLAUDE.md` (and mirror the same edits in `AGENTS.md`)**

1. **Self-contained principle → `data/` list:** add `netbox.json` — e.g. after the `proxmox.json` entry: `` `netbox.json` (NetBox integration settings with an **encrypted** API token) ``.
2. **Architecture list:** after the `provisionStore.js / proxmoxProvision.js` bullet add:

```markdown
- `tlsPin.js` — shared TLS fingerprint-pinning helpers (`tlsProbe`/`derToPem`/`normFp`) used by
  both the Proxmox and NetBox API clients.
- `netboxValidate.js` / `netboxStore.js` / `netboxApi.js` — NetBox integration settings: pure
  input validators, the sealed `data/netbox.json` store (token AES-256-GCM encrypted, redacted to
  `hasToken` on read), and the `/api/status/` connection probe with ca/pin/insecure TLS modes.
  Settings-only for now — IPAM checks during provisioning are the planned next phase.
```

3. **Web client paragraph:** add `settingsUi.ts`/`settingsForm.ts`/`netbox.ts` to the feature-module list: `settingsUi.ts` (the ⚙ settings modal; NetBox section) with `settingsForm.ts` (pure payload/result helpers) and `netbox.ts` (fetch layer).
4. **Security notes:** extend the Proxmox-secrets bullet (or add a sibling): the NetBox API token is sealed the same way in `data/netbox.json` (`0o600`), never returned to the browser (`hasToken` only), and NetBox TLS supports CA verification, TOFU fingerprint pinning, or explicit insecure mode (off by default).

- [ ] **Step 2: Update `README.md`**

In the security section, add the NetBox token to the encrypted-at-rest description alongside the Proxmox secrets; one sentence in the features/UI area: "A ⚙ settings modal configures the NetBox API integration (URL + token, TLS pinning for self-signed certs, connection test)." Use placeholder hostnames only.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: typecheck clean, all vitest files pass (including the five new/changed test files).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: NetBox integration settings + settings modal"
```
