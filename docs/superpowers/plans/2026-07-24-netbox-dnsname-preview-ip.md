# NetBox dns_name Write-back + Next-IP Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp a `dns_name` (hostname + optional global DNS suffix) onto the NetBox IP record at allocation, and show a non-binding next-available-IP preview in the provision form for `auto-static` presets.

**Architecture:** A new optional `dnsSuffix` NetBox setting flows through the existing validate → store → provision path and rides the existing `allocateIp` POST as one extra field. The preview is a new `nextIp` client method sharing the allocator's free-address selection helper, exposed via `GET /api/netbox/next-ip` and rendered by the provision form on preset change. Spec: `docs/superpowers/specs/2026-07-24-netbox-dnsname-preview-ip-design.md`.

**Tech Stack:** Node 20+ ESM server (`.js`), TypeScript web client (Vite), vitest.

## Global Constraints

- Zero new runtime dependencies (the project has exactly 5; keep it that way).
- TDD with real code, no mocks — dependency-injection factories only (existing pattern).
- Server code plain `.js`; web client `.ts`. `npm run typecheck` covers `src/web` only.
- Conventional-commit messages (`feat(netbox): …`, `test(...): …`).
- Public repo: no real PII — placeholders only (`example.com`, RFC1918 IPs like `192.168.30.0/24`).
- The NetBox token must never appear in any HTTP response body or error text (existing invariant; the new route returns client error messages, which already exclude it).
- Never read `process.env`/`process.cwd()` in modules or tests; everything injected.
- Run targeted tests with `npx vitest run <file>`; the final task runs `npm test` (typecheck + all tests) and `npm run build`.

---

### Task 1: `dnsSuffix` validation in `netboxValidate.js`

**Files:**
- Modify: `src/server/netboxValidate.js`
- Test: `test/netboxValidate.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `assertSettingsInput(spec, opts)` now returns an additional `dnsSuffix: string | null` key in **every** return branch (plain-http branch included). Normalization: trimmed, lowercased; empty/absent → `null`; invalid → throw containing "DNS suffix".

- [ ] **Step 1: Write the failing tests**

Append to `test/netboxValidate.test.js`:

```js
test('assertSettingsInput: dnsSuffix normalizes, defaults to null, and rejects junk', () => {
  const base = { url: 'https://x.example.com', token: 't' };
  expect(assertSettingsInput(base).dnsSuffix).toBeNull();
  expect(assertSettingsInput({ ...base, dnsSuffix: '' }).dnsSuffix).toBeNull();
  expect(assertSettingsInput({ ...base, dnsSuffix: '   ' }).dnsSuffix).toBeNull();
  expect(assertSettingsInput({ ...base, dnsSuffix: ' Lan.Example.COM ' }).dnsSuffix).toBe('lan.example.com');
  expect(assertSettingsInput({ ...base, dnsSuffix: 'a' }).dnsSuffix).toBe('a');
  expect(() => assertSettingsInput({ ...base, dnsSuffix: '-bad.example.com' })).toThrow(/DNS suffix/);
  expect(() => assertSettingsInput({ ...base, dnsSuffix: 'bad-.example.com' })).toThrow(/DNS suffix/);
  expect(() => assertSettingsInput({ ...base, dnsSuffix: 'has_underscore.example.com' })).toThrow(/DNS suffix/);
  expect(() => assertSettingsInput({ ...base, dnsSuffix: '.example.com' })).toThrow(/DNS suffix/);
  expect(() => assertSettingsInput({ ...base, dnsSuffix: 'example..com' })).toThrow(/DNS suffix/);
  expect(() => assertSettingsInput({ ...base, dnsSuffix: 'x'.repeat(64) + '.example.com' })).toThrow(/DNS suffix/);
  expect(() => assertSettingsInput({ ...base, dnsSuffix: 'a1234567.'.repeat(29) + 'toolongtail' })).toThrow(/too long/);
});

test('assertSettingsInput: dnsSuffix survives the plain-http branch', () => {
  expect(assertSettingsInput({ url: 'http://192.168.1.10:8000', token: 't', dnsSuffix: 'lan.example.com' }))
    .toEqual({ url: 'http://192.168.1.10:8000', tlsMode: null, fingerprint256: null, dnsSuffix: 'lan.example.com' });
});
```

Also update the **seven existing** `toEqual({ url: …` whole-object assertions in this file to include `dnsSuffix: null` (they will otherwise fail once the key exists). They are at:
- the https+ca default test (`{ url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null }`)
- the plain-http test (`{ url: 'http://192.168.1.10:8000', tlsMode: null, fingerprint256: null }`)
- the pin-with-fingerprint assertion (`{ url: 'https://x.example.com', tlsMode: 'pin', fingerprint256: 'AB:CD:12' }`)
- the three assertions in the `requirePinFingerprint:false` test
Each becomes e.g. `{ url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, dnsSuffix: null }`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/netboxValidate.test.js`
Expected: the two new tests FAIL (`dnsSuffix` is `undefined`, not `null`); updated old tests also FAIL until the key exists.

- [ ] **Step 3: Implement**

In `src/server/netboxValidate.js`, add below the `TLS_MODES` constant:

```js
// RFC-1035-shaped label: alnum, optional inner hyphens, 1-63 chars.
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Optional global suffix appended to the provision hostname to form the
// NetBox record's dns_name. Settings-save is the validation chokepoint:
// the allocation path trusts the stored value.
function normalizeDnsSuffix(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.length > 253) throw new Error('DNS suffix is too long (max 253 characters)');
  if (s.split('.').some((label) => !DNS_LABEL.test(label))) {
    throw new Error('DNS suffix must be dot-separated DNS labels like lan.example.com');
  }
  return s;
}
```

In `assertSettingsInput`, compute the suffix once after the token checks and include it in **both** return branches:

```js
  const dnsSuffix = normalizeDnsSuffix(spec.dnsSuffix);
  const https = url.startsWith('https:');
  if (!https) return { url, tlsMode: null, fingerprint256: null, dnsSuffix };
```

and change the two later returns to end with `, dnsSuffix }`:

```js
    if (!requirePinFingerprint) return { url, tlsMode, fingerprint256: null, dnsSuffix };
    throw new Error('pin mode requires a certificate fingerprint');
  }
  return { url, tlsMode, fingerprint256: tlsMode === 'pin' ? spec.fingerprint256 : null, dnsSuffix };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/netboxValidate.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxValidate.js test/netboxValidate.test.js
git commit -m "feat(netbox): validate an optional global dnsSuffix setting"
```

---

### Task 2: `dnsSuffix` persistence through `netboxStore.js`

**Files:**
- Modify (expected: none — `setSettings` spreads the normalized object; tests prove the flow-through): `src/server/netboxStore.js`
- Test: `test/netboxStore.test.js`

**Interfaces:**
- Consumes: Task 1's `assertSettingsInput` returning `dnsSuffix`.
- Produces: `netboxStore.getSettings()` (redacted **and** `withSecret`) returns `dnsSuffix: string | null`. Omitting `dnsSuffix` on a save clears it (settings are rebuilt from the normalized input, not merged — matching every other non-token field).

- [ ] **Step 1: Write the failing tests**

Append to `test/netboxStore.test.js`:

```js
test('dnsSuffix persists, is normalized, and survives the redacted read', async () => {
  const store = make();
  await store.setSettings({ ...SPEC, dnsSuffix: ' Lan.Example.COM ' });
  expect((await store.getSettings()).dnsSuffix).toBe('lan.example.com');
  expect((await store.getSettings({ withSecret: true })).dnsSuffix).toBe('lan.example.com');
});

test('omitting dnsSuffix on a later save clears it (rebuilt, not merged)', async () => {
  const store = make();
  await store.setSettings({ ...SPEC, dnsSuffix: 'lan.example.com' });
  await store.setSettings(SPEC);
  expect((await store.getSettings()).dnsSuffix).toBeNull();
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/netboxStore.test.js`
Expected: PASS already — `setSettings` spreads the normalized object (`{ ...norm, token, updatedAt }`), so Task 1 made this work. If either FAILS, the spread has drifted; fix `setSettings` to spread the full normalized result before proceeding.

- [ ] **Step 3: Commit**

```bash
git add test/netboxStore.test.js
git commit -m "test(netbox): pin dnsSuffix persistence through the settings store"
```

---

### Task 3: shared free-IP pick + `nextIp` in `netboxApi.js`

**Files:**
- Modify: `src/server/netboxApi.js` (the `createNetboxClient` return block)
- Test: `test/netboxApi.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `client.nextIp(vid)` → `Promise<{ address: string, prefix: string }>` (address in CIDR form as NetBox reports it, prefix is the CIDR string). Throws the same errors as the allocation path: `no NetBox prefix for VLAN <vid>`, `VLAN <vid> maps to multiple NetBox prefixes; cannot auto-allocate`, `prefix <cidr> has no available IPs`. `allocateIp`'s observable behavior is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/netboxApi.test.js` (the `NB` settings const already exists there):

```js
test('nextIp previews the same pick allocateIp would make, without reserving', async () => {
  const calls = [];
  const client = createNetboxClient(NB, { request: async (o) => {
    calls.push(o);
    if (o.url.includes('/ipam/prefixes/?vlan_vid=')) {
      return { status: 200, json: { results: [{ id: 7, prefix: '192.168.30.0/24' }] }, text: '' };
    }
    return { status: 200, json: [{ address: '192.168.30.1/24' }, { address: '192.168.30.50/24' }], text: '' };
  } });
  await expect(client.nextIp(30)).resolves.toEqual({ address: '192.168.30.50/24', prefix: '192.168.30.0/24' });
  expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']); // never a POST — nothing reserved
  expect(calls[1].url).toBe('https://netbox.example.com/api/ipam/prefixes/7/available-ips/');
});

test('nextIp: gateway-only availability means prefix full', async () => {
  const client = createNetboxClient(NB, { request: async (o) => {
    if (o.url.includes('vlan_vid')) return { status: 200, json: { results: [{ id: 7, prefix: '192.168.30.0/24' }] }, text: '' };
    return { status: 200, json: [{ address: '192.168.30.1/24' }], text: '' };
  } });
  await expect(client.nextIp(30)).rejects.toThrow('prefix 192.168.30.0/24 has no available IPs');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/netboxApi.test.js`
Expected: the two new tests FAIL (`client.nextIp is not a function`); all existing tests PASS.

- [ ] **Step 3: Implement**

In `src/server/netboxApi.js`, restructure `createNetboxClient`'s method block: keep `resolveOnce` and `call` exactly as they are, then replace the current `return { … }` (everything from `return {` through the closing `};`) with named local functions plus the return object:

```js
  async function findPrefixByVlan(vid) {
    const data = await call('GET', `/ipam/prefixes/?vlan_vid=${encodeURIComponent(vid)}`);
    const results = (data && data.results) || [];
    if (results.length === 0) throw new Error(`no NetBox prefix for VLAN ${vid}`);
    if (results.length > 1) throw new Error(`VLAN ${vid} maps to multiple NetBox prefixes; cannot auto-allocate`);
    return { id: results[0].id, prefix: results[0].prefix };
  }
  // Shared free-address selection for the preview and the allocator — one code
  // path, so the preview can never show an address allocateIp would not pick.
  // GET available-ips instead of NetBox's atomic next-free POST: the atomic
  // endpoint happily hands out an unregistered gateway address (bit us in
  // production). A concurrent duplicate reservation makes NetBox reject the
  // later POST -> the job errors cleanly and a retry succeeds; acceptable for
  // a single-user tool.
  async function findFreeIp(prefix) {
    const gateway = firstUsableIp(prefix.prefix);
    const avail = await call('GET', `/ipam/prefixes/${encodeURIComponent(prefix.id)}/available-ips/`);
    const list = Array.isArray(avail) ? avail : [];
    const pick = list.find((item) => item && item.address && String(item.address).split('/')[0] !== gateway);
    if (!pick) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
    return { address: String(pick.address), gateway };
  }
  return {
    findPrefixByVlan,
    // Non-binding preview: same selection as allocateIp, no reservation.
    async nextIp(vid) {
      const prefix = await findPrefixByVlan(vid);
      const { address } = await findFreeIp(prefix);
      return { address, prefix: prefix.prefix };
    },
    async allocateIp(prefix, fields) {
      const { address, gateway } = await findFreeIp(prefix);
      const created = await call('POST', '/ipam/ip-addresses/', { address, ...fields });
      if (!created || !created.address) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
      return { id: created.id, address: created.address, gateway };
    },
    // A mask-less ?address= filter matches on host address regardless of the
    // record's prefix length, so one query catches /24 and /32 twins.
    async findIpsByAddress(address) {
      const data = await call('GET', `/ipam/ip-addresses/?address=${encodeURIComponent(address)}`);
      return ((data && data.results) || []).map((rec) => ({ id: rec.id, address: rec.address }));
    },
    async releaseIp(id) { await call('DELETE', `/ipam/ip-addresses/${encodeURIComponent(id)}/`); },
  };
```

(The old GET-then-POST rationale comment moves onto `findFreeIp`; delete it from its old spot so it isn't duplicated.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/netboxApi.test.js test/netboxApi.integration.test.js`
Expected: PASS (all — including the untouched `allocateIp` regression tests, proving the extraction changed nothing).

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxApi.js test/netboxApi.test.js
git commit -m "feat(netbox): add nextIp preview sharing the allocator's free-IP selection"
```

---

### Task 4: compose `dns_name` at allocation in `proxmoxProvision.js`

**Files:**
- Modify: `src/server/proxmoxProvision.js` (the `auto-static` branch of `run()`)
- Test: `test/proxmoxProvision.test.js`

**Interfaces:**
- Consumes: `settings.dnsSuffix` from Task 2's store flow-through (the fake `nbStore` in tests mirrors it).
- Produces: the `allocateIp` fields object gains `dns_name: string` — `<hostname>.<dnsSuffix>` when a suffix is configured, bare hostname otherwise.

- [ ] **Step 1: Write the failing tests**

In `test/proxmoxProvision.test.js`, the existing assertion in the test `auto-static allocates before create, provisions with the allocated CIDR, and stamps netboxIpId on the link`:

```js
  expect(calls[1][2]).toEqual({ status: 'active', description: 'tmuxifier: dev-01' });
```

becomes (the shared `nbStore` fake has no `dnsSuffix`, so the bare hostname is expected):

```js
  expect(calls[1][2]).toEqual({ status: 'active', description: 'tmuxifier: dev-01', dns_name: 'dev-01' });
```

Then append a new test after the `auto-static allocates before create…` test:

```js
test('a configured dnsSuffix lands on the allocated record as hostname.suffix', async () => {
  const { calls, client: netbox } = fakeNetbox();
  const suffixStore = { getSettings: async () => ({ url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 't', dnsSuffix: 'lan.example.com' }) };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: () => okClient(),
    netboxStore: suffixStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('done');
  expect(calls[1][2]).toEqual({ status: 'active', description: 'tmuxifier: dev-01', dns_name: 'dev-01.lan.example.com' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: both the updated assertion and the new test FAIL (no `dns_name` key yet); everything else PASSES.

- [ ] **Step 3: Implement**

In `src/server/proxmoxProvision.js`, the `auto-static` branch of `run()` currently reads:

```js
      if (preset.net.ipMode === 'auto-static') {
        j.phase = 'allocate-ip'; persist();
        const netbox = makeNetboxClient(await requireNetboxSettings());
        const prefix = await netbox.findPrefixByVlan(preset.net.vlan);
        const res = await netbox.allocateIp(prefix, { status: 'active', description: `tmuxifier: ${j.hostname}` });
```

Replace those middle lines with:

```js
      if (preset.net.ipMode === 'auto-static') {
        j.phase = 'allocate-ip'; persist();
        const settings = await requireNetboxSettings();
        const netbox = makeNetboxClient(settings);
        const prefix = await netbox.findPrefixByVlan(preset.net.vlan);
        // dns_name: suffix validated at settings save, hostname at request
        // time — the composed value needs no re-validation. Write-once: a
        // later box rename never updates the NetBox record (by design).
        const dnsName = settings.dnsSuffix ? `${j.hostname}.${settings.dnsSuffix}` : j.hostname;
        const res = await netbox.allocateIp(prefix, { status: 'active', description: `tmuxifier: ${j.hostname}`, dns_name: dnsName });
```

(The rest of the branch — `j.netboxIpId = res.id;` onward — is unchanged. The error-path release in the same function calls `requireNetboxSettings()` independently and is unaffected.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxProvision.js test/proxmoxProvision.test.js
git commit -m "feat(provision): stamp dns_name on the allocated NetBox record"
```

---

### Task 5: `GET /api/netbox/next-ip` route

**Files:**
- Modify: `src/server/server.js` (import, `buildServer` signature, one route after the `/api/netbox/test` block)
- Test: `test/netboxRoutes.test.js`

**Interfaces:**
- Consumes: Task 3's `client.nextIp(vid)`.
- Produces: `GET /api/netbox/next-ip?vlan=<digits>` (auth-gated). Responses: 400 `{ ok: false, error }` for a non-numeric `vlan`; otherwise HTTP 200 with `{ ok: true, address, prefix }` or `{ ok: false, error }` (unconfigured, undecryptable, unreachable, prefix full, …). New injectable `makeNetboxClient = createNetboxClient` on `buildServer` (mirrors the existing `netboxTest = testNetbox` seam).

- [ ] **Step 1: Write the failing tests**

In `test/netboxRoutes.test.js`, restructure `beforeEach` to keep the deps object reusable, and parameterize `headers`:

```js
let app, dir, netboxStore, testCalls, baseDeps;

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
  baseDeps = {
    config, store: createStore({ dataDir: dir }), sessions, statusChecker, netboxStore,
    netboxTest: async (candidate) => { testCalls.push(candidate); return { ok: true, version: '4.3.2' }; },
  };
  app = buildServer(baseDeps);
});

async function headers(a = app) {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}
```

Add to the existing `netbox routes require auth` test:

```js
  expect((await app.inject({ method: 'GET', url: '/api/netbox/next-ip?vlan=30' })).statusCode).toBe(401);
```

Append new tests:

```js
test('next-ip: non-numeric vlan is a 400', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'GET', url: '/api/netbox/next-ip?vlan=abc', headers: h });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/vlan/i) });
});

test('next-ip: unconfigured NetBox reports ok:false without touching the client', async () => {
  let made = 0;
  const a = buildServer({ ...baseDeps, makeNetboxClient: () => { made += 1; return {}; } });
  const h = await headers(a);
  const res = await a.inject({ method: 'GET', url: '/api/netbox/next-ip?vlan=30', headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/not configured/i) });
  expect(made).toBe(0);
});

test('next-ip: previews via the client and never leaks the token', async () => {
  const nextIpCalls = [];
  const a = buildServer({ ...baseDeps, makeNetboxClient: (settings) => ({
    nextIp: async (vid) => { nextIpCalls.push([vid, settings.token]); return { address: '192.168.30.50/24', prefix: '192.168.30.0/24' }; },
  }) });
  const h = await headers(a);
  await a.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 'nb-secret-token' } });
  const res = await a.inject({ method: 'GET', url: '/api/netbox/next-ip?vlan=30', headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, address: '192.168.30.50/24', prefix: '192.168.30.0/24' });
  expect(nextIpCalls).toEqual([[30, 'nb-secret-token']]); // decrypted settings reach the client, vlan is numeric
  expect(res.body).not.toContain('nb-secret-token');
});

test('next-ip: a client error (e.g. prefix full) is ok:false with the message', async () => {
  const a = buildServer({ ...baseDeps, makeNetboxClient: () => ({
    nextIp: async () => { throw new Error('prefix 192.168.30.0/24 has no available IPs'); },
  }) });
  const h = await headers(a);
  await a.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 't0k' } });
  const res = await a.inject({ method: 'GET', url: '/api/netbox/next-ip?vlan=30', headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: false, error: 'prefix 192.168.30.0/24 has no available IPs' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/netboxRoutes.test.js`
Expected: the auth addition and all four new tests FAIL (404 route not found / wrong shapes); existing tests PASS.

- [ ] **Step 3: Implement**

In `src/server/server.js`:

1. Extend the import: `import { testNetbox, createNetboxClient } from './netboxApi.js';`
2. In the `buildServer({ … })` parameter list, immediately after `netboxTest = testNetbox,` add `makeNetboxClient = createNetboxClient,`.
3. After the `/api/netbox/test` route's closing `});` (and before the `/api/status` route), add:

```js
  // Next-IP preview for auto-static provisioning. Read-only and result-shaped
  // (the testNetbox pattern): expected states — unconfigured, unreachable,
  // prefix full — are ok:false payloads, never 500s, so the provision form can
  // render them inline. Non-binding: allocation happens at job time.
  app.get('/api/netbox/next-ip', { preHandler: requireAuth }, async (req, reply) => {
    const vlan = String((req.query && req.query.vlan) ?? '');
    if (!/^\d{1,4}$/.test(vlan)) return reply.code(400).send({ ok: false, error: 'vlan must be a VLAN id (1..4094)' });
    let settings = null;
    try { settings = await netboxStore.getSettings({ withSecret: true }); }
    catch { return { ok: false, error: 'could not decrypt the stored NetBox token — re-enter it (was TMUXIFIER_COOKIE_SECRET rotated?)' }; }
    if (!settings) return { ok: false, error: 'NetBox is not configured — set it up in Settings (⚙)' };
    try {
      const { address, prefix } = await makeNetboxClient(settings).nextIp(Number(vlan));
      return { ok: true, address, prefix };
    } catch (e) { return { ok: false, error: e.message }; }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/netboxRoutes.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/netboxRoutes.test.js
git commit -m "feat(api): GET /api/netbox/next-ip auto-static preview route"
```

---

### Task 6: web data layer + settings form field

**Files:**
- Modify: `src/web/netbox.ts`, `src/web/settingsForm.ts`, `src/web/settingsNetbox.ts`
- Test: `test/settingsForm.test.js`

**Interfaces:**
- Consumes: Task 5's route.
- Produces: `nbx.nextIp(vlan: number): Promise<NetboxNextIp>` with `type NetboxNextIp = { ok: true; address: string; prefix: string } | { ok: false; error: string }` (Task 7 uses this). `NetboxSettings.dnsSuffix: string | null`; `NetboxSettingsInput.dnsSuffix?: string`; `NetboxFormState.dnsSuffix: string` (required — update the test helper).

- [ ] **Step 1: Write the failing tests**

In `test/settingsForm.test.js`, add `dnsSuffix: ''` to the `state()` helper's returned object (whatever its current shape — it builds a `NetboxFormState`). Then append:

```js
test('buildSavePayload: a non-blank dnsSuffix is trimmed into the payload', () => {
  expect(buildSavePayload({ ...state(), dnsSuffix: ' lan.example.com ' }).payload.dnsSuffix).toBe('lan.example.com');
});

test('buildSavePayload: a blank dnsSuffix is omitted (server clears the stored one)', () => {
  expect(buildSavePayload({ ...state(), dnsSuffix: '  ' }).payload.dnsSuffix).toBeUndefined();
  expect(buildSavePayload(state()).payload.dnsSuffix).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/settingsForm.test.js`
Expected: the first new test FAILS (`dnsSuffix` undefined in payload); the second passes vacuously — fine.

- [ ] **Step 3: Implement**

`src/web/netbox.ts` — extend both interfaces and add the result type + fetcher:

```ts
export interface NetboxSettings {
  url: string; tlsMode: 'ca' | 'pin' | 'insecure' | null;
  fingerprint256: string | null; dnsSuffix: string | null; hasToken: boolean; updatedAt: string;
}
export interface NetboxSettingsInput {
  url: string; token?: string; tlsMode?: 'ca' | 'pin' | 'insecure'; fingerprint256?: string | null; dnsSuffix?: string;
}
export type NetboxNextIp = { ok: true; address: string; prefix: string } | { ok: false; error: string };
```

and in the `nbx` object:

```ts
  nextIp(vlan: number) { return jr<NetboxNextIp>(fetch(`/api/netbox/next-ip?vlan=${vlan}`)); },
```

`src/web/settingsForm.ts` — add `dnsSuffix: string;` to `NetboxFormState`, and in `buildSavePayload`, after the `token` handling:

```ts
  // Blank omits the key: the server rebuilds settings from the payload, so an
  // absent dnsSuffix clears a stored one — which is what an emptied field means.
  const dnsSuffix = s.dnsSuffix.trim();
  if (dnsSuffix) payload.dnsSuffix = dnsSuffix;
```

`src/web/settingsNetbox.ts` — after the `token` input declaration, add:

```ts
  const dnsSuffix = document.createElement('input');
  dnsSuffix.type = 'text';
  dnsSuffix.placeholder = 'lan.example.com (optional)';
  dnsSuffix.value = current?.dnsSuffix ?? '';
  dnsSuffix.autocomplete = 'off';
  const suffixHint = document.createElement('p');
  suffixHint.className = 'settings-hint';
  suffixHint.textContent = 'Appended to the hostname as the NetBox record’s dns_name when provisioning (auto-static).';
```

In `formState()`, add `dnsSuffix: dnsSuffix.value,` to the returned object. In the `form.append(…)` call, insert `field('DNS suffix', dnsSuffix), suffixHint,` between `field('API token', token)` and `tlsGroup`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/settingsForm.test.js && npm run typecheck`
Expected: tests PASS; typecheck clean (the required `NetboxFormState.dnsSuffix` forces the `settingsNetbox.ts` wiring to exist).

- [ ] **Step 5: Commit**

```bash
git add src/web/netbox.ts src/web/settingsForm.ts src/web/settingsNetbox.ts test/settingsForm.test.js
git commit -m "feat(ui): DNS suffix setting field and nextIp fetch layer"
```

---

### Task 7: next-IP preview in the provision form

**Files:**
- Modify: `src/web/proxmoxUi.ts` (`renderProvision` only)

**Interfaces:**
- Consumes: `nbx.nextIp` from Task 6; `PvePreset.net` (`ipMode`, `vlan`) from `proxmox.ts`.
- Produces: user-visible preview line; no exports.

- [ ] **Step 1: Implement**

In `src/web/proxmoxUi.ts`:

1. Add the import: `import { nbx } from './netbox';`
2. In `renderProvision`, after the `const summary = el('div', { class: 'pve-sub' });` line, add:

```ts
    // Non-binding next-IP preview for auto-static presets. Generation-guarded:
    // a response landing after the user switched presets must not paint
    // (same stale-response discipline as fleetPoll.ts / setupPoller.ts).
    const preview = el('div', { class: 'pve-sub' });
    let previewGen = 0;
    async function syncPreview(p: PvePreset | undefined) {
      const gen = ++previewGen;
      if (!p || p.net.ipMode !== 'auto-static' || p.net.vlan == null) { preview.textContent = ''; return; }
      preview.textContent = 'next IP: …';
      try {
        const r = await nbx.nextIp(p.net.vlan);
        if (gen !== previewGen) return;
        preview.textContent = r.ok
          ? `next IP: ${r.address.split('/')[0]} (from ${r.prefix}, non-binding)`
          : `next IP unavailable: ${r.error}`;
      } catch (e) {
        if (gen !== previewGen) return;
        preview.textContent = `next IP unavailable: ${(e as Error).message}`;
      }
    }
```

3. Extend `syncPreset` with one line so it reads:

```ts
    const syncPreset = () => {
      const p = curPreset();
      summary.textContent = p ? presetSummary(p) : '';
      ipField.style.display = p?.net.ipMode === 'static' ? '' : 'none';
      void syncPreview(p);
    };
```

4. In the `box.append(…)` fieldset children, insert `preview,` immediately after `summary,` (so the line renders under the preset description).

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean. (The preview is render-only glue over tested seams — route, client, fetch layer — matching the project's convention that DOM composition is covered by typecheck + build, not unit tests.)

- [ ] **Step 3: Commit**

```bash
git add src/web/proxmoxUi.ts
git commit -m "feat(ui): show the next available IP when an auto-static preset is selected"
```

---

### Task 8: docs + full verification

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (kept in sync), `README.md`

- [ ] **Step 1: Update the architecture docs**

In `CLAUDE.md` and `AGENTS.md`, find the `netboxValidate.js / netboxStore.js / netboxApi.js` bullet (both files carry the same text). At its end, the sentence:

> `createNetboxClient` also serves provisioning: `auto-static` presets reserve the next free IP from the VLAN's NetBox prefix (released again on failure or deprovision).

becomes:

> `createNetboxClient` also serves provisioning: `auto-static` presets reserve the next free IP from the VLAN's NetBox prefix (released again on failure or deprovision), stamping the record's `dns_name` from the hostname plus the optional global DNS suffix setting; `nextIp` (same free-IP selection as the allocator, no reservation) powers the provision form's non-binding next-IP preview via `GET /api/netbox/next-ip`.

In `README.md`, locate the NetBox integration section (`grep -n -i netbox README.md`) and append this sentence to the settings description:

> An optional **DNS suffix** (e.g. `lan.example.com`) is appended to the hostname and written to the allocated record's `dns_name`; the provision form also previews the next available IP for auto-static presets (non-binding).

- [ ] **Step 2: Full verification**

Run: `npm test && npm run build`
Expected: typecheck clean, all vitest suites PASS, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: NetBox dns_name write-back and next-IP preview"
```

---

## Not in this plan

Shipping (version bump, service restart, tag, GitHub release) follows the CLAUDE.md "Shipping" checklist as a separate, user-approved step.
