# NetBox Auto-Static Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third preset IP mode `auto-static` that reserves the next free IP from the NetBox prefix backing the preset's VLAN at provision time (releasing it if creation fails), and releases it again when the container is deprovisioned.

**Architecture:** `netboxApi.js` gains a shared TLS resolver and a throwing `createNetboxClient` (findPrefixByVlan / allocateIp / releaseIp) beside the resolving `testNetbox`; `proxmoxProvision.js` gains an `allocate-ip` phase + rollback and stamps `netboxIpId` onto the auto-link; `proxmoxLifecycle.js`'s deprovision releases it best-effort; the preset editor and provision tab learn the new mode. Connection settings come exclusively from the sealed `netboxStore`.

**Tech Stack:** Node 20+ ESM, vitest (real code + injected fakes), TypeScript web client, existing `tlsPin.js` transport helpers.

**Spec:** `docs/superpowers/specs/2026-07-09-netbox-auto-static-provisioning-design.md`

## Global Constraints

- No new config keys: NetBox settings come ONLY from `netboxStore.getSettings({ withSecret: true })`; the token never appears in any job log, error message, or HTTP response (client errors carry status/detail only — never headers).
- Never silently fall back to DHCP: every `auto-static` failure is an explicit job `error`; unconfigured NetBox fails fast with `auto-static requires the NetBox integration — configure it in Settings (⚙)` before any container is created.
- `netboxIpId` is written only by server-trusted paths (provision auto-link; job rollback nulls it); the manual link route and imports never accept it; the drift write preserves it via its existing spread.
- A deprovision release failure NEVER fails the job (container already destroyed; local cleanup must complete); it logs `# could not release NetBox ip <id>: <message>` in the job log.
- Existing `testNetbox` behavior is byte-equivalent after the TLS-resolver refactor — the existing `test/netboxApi.test.js` tests must pass UNCHANGED (they are the regression net).
- **NUL-byte protocol:** `src/server/proxmoxLifecycle.js:6` contains a backslash-u-0000 escape (`targetKey`). Task 4 edits that file: use targeted Edits never including line 6; after every write run `node -e "const b=require('fs').readFileSync('src/server/proxmoxLifecycle.js');process.exit(b.includes(0)?1:0)" && echo no-NUL-bytes` (must print `no-NUL-bytes`; `git diff --stat` must show text, not Bin).
- Public repo: placeholders only (`netbox.example.com`, RFC1918).
- Baseline 641 tests + typecheck green; count must only grow. Full suite (`npm test`) in Task 6.

---

### Task 1: `createNetboxClient` + `jsonRequest` method/body support

**Files:**
- Modify: `src/server/netboxApi.js`
- Test: `test/netboxApi.test.js` (append; existing tests unchanged)

**Interfaces:**
- Consumes: `tlsProbe`/`derToPem`/`normFp` from `./tlsPin.js` (already imported).
- Produces:
  - `jsonRequest({ url, method = 'GET', headers, body, timeoutMs, tls })` — `body` (a plain object) is JSON-serialized with `Content-Type: application/json` and a fixed `Content-Length`.
  - Internal `resolveTlsOpts(settings, { connect, timeoutMs })` → `{ mode, tlsOpts }` or `{ mode, failure: { kind, fingerprint256?, error } }` — shared by `testNetbox` (maps `failure` to its result objects, byte-equivalent messages) and the client (throws `failure.error`).
  - `createNetboxClient(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs = 10000 } = {})` →
    - `findPrefixByVlan(vid): Promise<{ id, prefix }>` — `GET {url}/api/ipam/prefixes/?vlan_vid=<vid>`; throws `no NetBox prefix for VLAN <vid>` on 0 results and `VLAN <vid> maps to multiple NetBox prefixes; cannot auto-allocate` on >1.
    - `allocateIp(prefix, fields): Promise<{ id, address }>` — takes the `{ id, prefix }` object from `findPrefixByVlan` (the label feeds the error message); `POST {url}/api/ipam/prefixes/{id}/available-ips/` with `fields` as the JSON body; NetBox returns the created record (object, or array when batching) — missing/empty → throws `prefix <prefix> has no available IPs`.
    - `releaseIp(id): Promise<void>` — `DELETE {url}/api/ipam/ip-addresses/{id}/` (204 tolerated: empty body parses to `json: null`).
  - All client methods send `Authorization: Token <token>` + `Accept: application/json`, resolve TLS per stored mode first (pin mode: token-less probe → mismatch throws BEFORE any authenticated request), and throw on non-2xx with NetBox's `detail` when present.

- [ ] **Step 1: Write the failing tests**

Append to `test/netboxApi.test.js` (reuse its existing settings fixtures/fake-request style — read the file first and match it):

```js
const NB = { url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 'tok123' };

test('findPrefixByVlan resolves exactly-one and throws on 0/many', async () => {
  const calls = [];
  const mk = (results) => createNetboxClient(NB, { request: async (o) => { calls.push(o); return { status: 200, json: { results }, text: '' }; } });
  await expect(mk([{ id: 7, prefix: '192.168.30.0/24' }]).findPrefixByVlan(30)).resolves.toEqual({ id: 7, prefix: '192.168.30.0/24' });
  expect(calls[0].url).toBe('https://netbox.example.com/api/ipam/prefixes/?vlan_vid=30');
  expect(calls[0].method).toBe('GET');
  expect(calls[0].headers.Authorization).toBe('Token tok123');
  await expect(mk([]).findPrefixByVlan(31)).rejects.toThrow('no NetBox prefix for VLAN 31');
  await expect(mk([{ id: 1 }, { id: 2 }]).findPrefixByVlan(32)).rejects.toThrow(/multiple NetBox prefixes/);
});

test('allocateIp POSTs a JSON body and returns id+address; empty result means prefix full', async () => {
  const calls = [];
  const client = createNetboxClient(NB, { request: async (o) => { calls.push(o); return { status: 201, json: { id: 99, address: '192.168.30.50/24' }, text: '' }; } });
  const res = await client.allocateIp({ id: 7, prefix: '192.168.30.0/24' }, { status: 'active', description: 'tmuxifier: dev-01' });
  expect(res).toEqual({ id: 99, address: '192.168.30.50/24' });
  expect(calls[0].url).toBe('https://netbox.example.com/api/ipam/prefixes/7/available-ips/');
  expect(calls[0].method).toBe('POST');
  expect(calls[0].body).toEqual({ status: 'active', description: 'tmuxifier: dev-01' });
  const full = createNetboxClient(NB, { request: async () => ({ status: 200, json: [], text: '' }) });
  await expect(full.allocateIp({ id: 7, prefix: '192.168.30.0/24' }, {})).rejects.toThrow('prefix 192.168.30.0/24 has no available IPs');
});

test('releaseIp DELETEs the ip-address record and tolerates an empty 204 body', async () => {
  const calls = [];
  const client = createNetboxClient(NB, { request: async (o) => { calls.push(o); return { status: 204, json: null, text: '' }; } });
  await client.releaseIp(99);
  expect(calls[0].url).toBe('https://netbox.example.com/api/ipam/ip-addresses/99/');
  expect(calls[0].method).toBe('DELETE');
});

test('client surfaces NetBox detail on 4xx and never embeds the token', async () => {
  const client = createNetboxClient(NB, { request: async () => ({ status: 403, json: { detail: 'Invalid token' }, text: '' }) });
  const err = await client.findPrefixByVlan(30).catch((e) => e);
  expect(err.message).toContain('403');
  expect(err.message).toContain('Invalid token');
  expect(err.message).not.toContain('tok123');
});

test('client pin mode withholds the authenticated request on fingerprint mismatch', async () => {
  const calls = [];
  const client = createNetboxClient(
    { ...NB, tlsMode: 'pin', fingerprint256: 'AA:BB' },
    { connect: async () => ({ fingerprint256: 'CC:DD', raw: Buffer.from('x'), chain: [Buffer.from('x')] }),
      request: async (o) => { calls.push(o); return { status: 200, json: { results: [] }, text: '' }; } },
  );
  await expect(client.findPrefixByVlan(30)).rejects.toThrow(/fingerprint mismatch/);
  expect(calls).toHaveLength(0);
});

test('jsonRequest POSTs JSON with fixed Content-Length against a real local server', async () => {
  const http = await import('node:http');
  let seen = null;
  const srv = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      seen = { method: req.method, type: req.headers['content-type'], length: req.headers['content-length'], transfer: req.headers['transfer-encoding'] || null, data };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 1, address: '192.168.30.50/24' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const client = createNetboxClient({ url, tlsMode: null, fingerprint256: null, token: 't' });
    const res = await client.allocateIp({ id: 5, prefix: '192.168.30.0/24' }, { status: 'active' });
    expect(res).toEqual({ id: 1, address: '192.168.30.50/24' });
    expect(seen.method).toBe('POST');
    expect(seen.type).toBe('application/json');
    expect(seen.transfer).toBeNull();               // fixed Content-Length, not chunked
    expect(Number(seen.length)).toBe(Buffer.byteLength(seen.data));
    expect(JSON.parse(seen.data)).toEqual({ status: 'active' });
  } finally { srv.close(); }
});
```

Update the file's import line to include `createNetboxClient`.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run test/netboxApi.test.js`
Expected: new tests FAIL (`createNetboxClient` not exported); existing tests still pass.

- [ ] **Step 3: Implement**

In `src/server/netboxApi.js`:

**(a)** Extend `jsonRequest` (signature + body handling; the response handling is unchanged):

```js
function jsonRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 10000, tls: tlsOpts = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    // Fixed Content-Length (never chunked) — same lesson as proxmoxApi.js: some
    // reverse proxies in front of API servers reject chunked request bodies.
    const payload = body == null ? null : JSON.stringify(body);
    const reqHeaders = payload == null ? headers : { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = mod.request({
      hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method, headers: reqHeaders, timeout: timeoutMs,
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
    if (payload != null) req.write(payload);
    req.end();
  });
}
```

**(b)** Extract the TLS resolution `testNetbox` currently inlines (its `mode` computation and the whole `if (mode === 'pin') { … }` block) into:

```js
// Resolve the stored TLS mode to request options. Pin mode does the token-less
// probe first; a blank or mismatched pin comes back as `failure` (never a
// throw) so testNetbox can render it and the client can throw it.
async function resolveTlsOpts(settings, { connect, timeoutMs }) {
  const u = new URL(settings.url);
  const secure = u.protocol === 'https:';
  const mode = secure ? (settings.tlsMode || 'ca') : null;
  if (mode === 'insecure') return { mode, tlsOpts: { rejectUnauthorized: false } };
  if (mode !== 'pin') return { mode, tlsOpts: {} };
  let probe;
  try { probe = await connect({ host: u.hostname, port: Number(u.port) || 443, timeoutMs }); }
  catch (e) { return { mode, failure: { kind: 'unreachable', error: e.message } }; }
  if (!normFp(settings.fingerprint256)) {
    return { mode, failure: { kind: 'tls', fingerprint256: probe.fingerprint256 || null, error: 'no fingerprint pinned yet — pin the certificate below to trust this server' } };
  }
  if (normFp(probe.fingerprint256) !== normFp(settings.fingerprint256)) {
    return { mode, failure: { kind: 'tls', fingerprint256: probe.fingerprint256 || null, error: 'TLS fingerprint mismatch — the NetBox certificate changed; re-pin to accept the new one' } };
  }
  const trust = probe.chain && probe.chain.length ? probe.chain : [probe.raw];
  return { mode, tlsOpts: { ca: trust.map(derToPem), rejectUnauthorized: true, checkServerIdentity: () => undefined } };
}
```

Rewire `testNetbox` to consume it — behavior byte-equivalent:

```js
export async function testNetbox(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs = 10000 } = {}) {
  const u = new URL(settings.url);
  const port = Number(u.port) || 443;
  const { mode, failure, tlsOpts } = await resolveTlsOpts(settings, { connect, timeoutMs });
  if (failure) return { ok: false, ...failure };
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
  // … the 401/403, unexpected, and success branches are UNCHANGED …
}
```

(Note the pin-failure result shape: `{ ok: false, ...failure }` spreads `kind`/`fingerprint256`/`error` exactly as before.)

**(c)** Append the client factory:

```js
// Throwing NetBox client for the provisioning/deprovisioning flows (testNetbox
// stays result-shaped for the settings UI). Same auth header, same TLS modes;
// pin mode verifies the fingerprint via resolveTlsOpts BEFORE any
// authenticated request is sent.
export function createNetboxClient(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs = 10000 } = {}) {
  async function call(method, path, body) {
    const { failure, tlsOpts } = await resolveTlsOpts(settings, { connect, timeoutMs });
    if (failure) throw new Error(failure.error);
    const res = await request({
      url: `${settings.url}/api${path}`, method, body, timeoutMs, tls: tlsOpts,
      headers: { Authorization: `Token ${settings.token}`, Accept: 'application/json' },
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = res.json && res.json.detail ? `: ${res.json.detail}` : '';
      throw new Error(`NetBox API error ${res.status}${detail}`);
    }
    return res.json;
  }
  return {
    async findPrefixByVlan(vid) {
      const data = await call('GET', `/ipam/prefixes/?vlan_vid=${encodeURIComponent(vid)}`);
      const results = (data && data.results) || [];
      if (results.length === 0) throw new Error(`no NetBox prefix for VLAN ${vid}`);
      if (results.length > 1) throw new Error(`VLAN ${vid} maps to multiple NetBox prefixes; cannot auto-allocate`);
      return { id: results[0].id, prefix: results[0].prefix };
    },
    async allocateIp(prefix, fields) {
      const data = await call('POST', `/ipam/prefixes/${encodeURIComponent(prefix.id)}/available-ips/`, fields);
      const item = Array.isArray(data) ? data[0] : data;
      if (!item || !item.address) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
      return { id: item.id, address: item.address };
    },
    async releaseIp(id) { await call('DELETE', `/ipam/ip-addresses/${encodeURIComponent(id)}/`); },
  };
}
```

- [ ] **Step 4: Run to verify GREEN (including the unchanged originals)**

Run: `npx vitest run test/netboxApi.test.js`
Expected: PASS — all previous tests byte-unchanged and green, plus the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxApi.js test/netboxApi.test.js
git commit -m "feat(netbox): allocation client (prefix lookup, next-free IP, release)"
```

---

### Task 2: `auto-static` preset validation + normalize

**Files:**
- Modify: `src/server/proxmoxValidate.js:69-73` (the ipMode block in `assertPresetInput`)
- Modify: `src/server/proxmoxStore.js:16` (the `net:` line in `normalizePreset`)
- Test: `test/proxmoxValidate.test.js`, `test/proxmoxStore.test.js` (append)

**Interfaces:**
- Produces: `assertPresetInput` accepts `net.ipMode === 'auto-static'` (requires `net.vlan` int 1–4094 AND `net.gateway` IP; `cidr` ignored); `normalizePreset` forces `cidr: null` for auto-static.

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxValidate.test.js` (match its existing valid-preset fixture helper — read the file and reuse it; the shape below assumes a `base` valid preset spec you clone):

```js
test('auto-static requires vlan and gateway; cidr is not required', () => {
  const auto = (net) => ({ ...base, net: { bridge: 'vmbr0', ipMode: 'auto-static', cidr: null, gateway: null, vlan: null, ...net } });
  expect(() => assertPresetInput(auto({ vlan: 30, gateway: '192.168.30.1' }), { hostIds: [base.hostId] })).not.toThrow();
  expect(() => assertPresetInput(auto({ gateway: '192.168.30.1' }), { hostIds: [base.hostId] })).toThrow(/vlan/);
  expect(() => assertPresetInput(auto({ vlan: 30 }), { hostIds: [base.hostId] })).toThrow(/gateway/);
  expect(() => assertPresetInput({ ...base, net: { bridge: 'vmbr0', ipMode: 'yolo' } }, { hostIds: [base.hostId] })).toThrow(/ipMode must be dhcp, static, or auto-static/);
});
```

Append to `test/proxmoxStore.test.js` (reuse its store/host setup):

```js
test('an auto-static preset persists with cidr forced null', async () => {
  const store = make();
  const h = await store.addHost(HOST);
  const p = await store.addPreset({
    name: 'auto', hostId: h.id, template: 'local:vztmpl/x.tar.zst', storage: 'local-lvm',
    diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
    net: { bridge: 'vmbr0', ipMode: 'auto-static', vlan: 30, gateway: '192.168.30.1', cidr: '192.168.30.9/24' },
  });
  expect(p.net.ipMode).toBe('auto-static');
  expect(p.net.vlan).toBe(30);
  expect(p.net.cidr).toBeNull(); // allocated at provision time; never stored
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run test/proxmoxValidate.test.js test/proxmoxStore.test.js`
Expected: new tests FAIL (`ipMode must be dhcp or static`).

- [ ] **Step 3: Implement**

In `src/server/proxmoxValidate.js`, replace the ipMode block:

```js
  if (!['dhcp', 'static', 'auto-static'].includes(net.ipMode)) throw new Error('ipMode must be dhcp, static, or auto-static');
  if (net.ipMode === 'static') {
    if (!isCidr(net.cidr)) throw new Error('static network requires a cidr like 192.168.1.50/24');
    if (!isIp(net.gateway)) throw new Error('static network requires a gateway ip');
  }
  if (net.ipMode === 'auto-static') {
    if (!intInRange(net.vlan, 1, 4094)) throw new Error('auto-static requires a vlan (1..4094) to find the NetBox prefix');
    if (!isIp(net.gateway)) throw new Error('auto-static requires a gateway ip');
  }
```

In `src/server/proxmoxStore.js` `normalizePreset`, change the `net:` line's cidr expression:

```js
    net: { bridge: net.bridge, vlan: net.vlan ?? null, ipMode: net.ipMode, cidr: net.ipMode === 'auto-static' ? null : (net.cidr ?? null), gateway: net.gateway ?? null },
```

- [ ] **Step 4: GREEN**

Run: `npx vitest run test/proxmoxValidate.test.js test/proxmoxStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxValidate.js src/server/proxmoxStore.js test/proxmoxValidate.test.js test/proxmoxStore.test.js
git commit -m "feat(proxmox): auto-static preset mode (vlan + gateway, no stored cidr)"
```

---

### Task 3: `allocate-ip` provision phase, rollback, and `netboxIpId` on the auto-link

**Files:**
- Modify: `src/server/proxmoxProvision.js` (manager signature; `run()`; `createProvision`)
- Modify: `src/server/index.js` (provisionManager construction, ~line 100: add `netboxStore,`)
- Test: `test/proxmoxProvision.test.js` (append)

**Interfaces:**
- Consumes: `createNetboxClient` (Task 1); `netboxStore.getSettings({ withSecret: true })`; auto-static presets (Task 2).
- Produces: `createProvisionManager({ …, netboxStore = null, makeNetboxClient = createNetboxClient })`; job shape gains `netboxIpId: number | null`; phase value `'allocate-ip'`; the auto-link's `proxmox` object gains `netboxIpId` for auto-static provisions.

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxProvision.test.js` (reuse `PRESET_DHCP`/`HOST`/`makeStore`/`fakeBoxStore`/`okClient` — they exist at the top of the file; manager construction there passes `load: () => []`, `save: () => {}` style args — match it):

```js
const PRESET_AUTO = { ...PRESET_DHCP, id: 'p3', net: { bridge: 'vmbr0', ipMode: 'auto-static', cidr: null, gateway: '192.168.30.1', vlan: 30 } };

function fakeNetbox({ full = false, failRelease = false } = {}) {
  const calls = [];
  const client = {
    findPrefixByVlan: async (vid) => { calls.push(['find', vid]); return { id: 7, prefix: '192.168.30.0/24' }; },
    allocateIp: async (prefix, fields) => {
      calls.push(['allocate', prefix.id, fields]);
      if (full) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
      return { id: 99, address: '192.168.30.50/24' };
    },
    releaseIp: async (id) => { calls.push(['release', id]); if (failRelease) throw new Error('netbox down'); },
  };
  return { calls, client };
}
const nbStore = { getSettings: async () => ({ url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 't' }) };

test('auto-static allocates before create, provisions with the allocated CIDR, and stamps netboxIpId on the link', async () => {
  const { calls, client: netbox } = fakeNetbox();
  const boxStore = fakeBoxStore();
  const createCalls = [];
  const client = { ...okClient(), createLxc: async (node, params) => { createCalls.push(params); return 'UPID:create'; } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore, makeClient: () => client,
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  const done = m.getProvision(j.id);
  expect(done.status).toBe('done');
  expect(done.netboxIpId).toBe(99);
  expect(calls[0]).toEqual(['find', 30]);
  expect(calls[1][2]).toEqual({ status: 'active', description: 'tmuxifier: dev-01' });
  expect(createCalls[0].net0).toContain('ip=192.168.30.50/24');
  expect(createCalls[0].net0).toContain('gw=192.168.30.1');
  expect(boxStore.added[0].host).toBe('192.168.30.50');
  expect(boxStore.added[0].proxmox.netboxIpId).toBe(99);
  expect(calls.some((c) => c[0] === 'release')).toBe(false);
});

test('a create failure releases the reserved IP and the job errors', async () => {
  const { calls, client: netbox } = fakeNetbox();
  const client = { ...okClient(), createLxc: async () => { throw new Error('storage full'); } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: () => client,
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  const done = m.getProvision(j.id);
  expect(done.status).toBe('error');
  expect(calls.at(-1)).toEqual(['release', 99]);
  expect(done.log).toContain('released NetBox ip 99');
});

test('a prefix failure aborts before any container is created', async () => {
  const netbox = { findPrefixByVlan: async () => { throw new Error('no NetBox prefix for VLAN 30'); } };
  const createCalls = [];
  const client = { ...okClient(), createLxc: async () => { createCalls.push(1); return 'UPID:create'; } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: () => client,
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('error');
  expect(m.getProvision(j.id).error).toContain('no NetBox prefix');
  expect(createCalls).toHaveLength(0);
});

test('unconfigured NetBox fails fast with the settings-modal message', async () => {
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: okClient,
    netboxStore: { getSettings: async () => null },
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).error).toContain('configure it in Settings');
});

test('dhcp and static presets never touch the NetBox client', async () => {
  let touched = 0;
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_STATIC), boxStore: fakeBoxStore(), makeClient: okClient,
    netboxStore: nbStore, makeNetboxClient: () => { touched += 1; return {}; },
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p2', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('done');
  expect(touched).toBe(0);
});
```

(Adjust `okClient`/manager-arg details to the file's real helpers where they differ — the assertions are the contract.)

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: new tests FAIL; existing ones pass.

- [ ] **Step 3: Implement in `src/server/proxmoxProvision.js`**

**(a)** Import + signature:

```js
import { createNetboxClient } from './netboxApi.js';
```

```js
export function createProvisionManager({
  proxmoxStore, boxStore, makeClient, load, save, defaultPublicKey = () => null,
  netboxStore = null, makeNetboxClient = createNetboxClient,
  now = () => new Date().toISOString(), makeId = randomUUID, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 1500, taskTimeoutMs = 600000, leaseTimeoutMs = 60000, maxJobs = 50, maxLogBytes = 65536,
  maxPollFailures = 5,
}) {
```

**(b)** Settings helper (module-internal, above `run`):

```js
  async function requireNetboxSettings() {
    let settings = null;
    try { settings = netboxStore ? await netboxStore.getSettings({ withSecret: true }) : null; } catch { settings = null; }
    if (!settings) throw new Error('auto-static requires the NetBox integration — configure it in Settings (⚙)');
    return settings;
  }
```

**(c)** In `run()`, insert the allocation between the vmid allocation and `j.phase = 'create'`:

```js
      j.phase = 'allocate'; persist();
      if (!j.vmid) j.vmid = Number(await client.nextId());

      if (preset.net.ipMode === 'auto-static') {
        j.phase = 'allocate-ip'; persist();
        const netbox = makeNetboxClient(await requireNetboxSettings());
        const prefix = await netbox.findPrefixByVlan(preset.net.vlan);
        const res = await netbox.allocateIp(prefix, { status: 'active', description: `tmuxifier: ${j.hostname}` });
        j.ip = res.address; j.netboxIpId = res.id;
        appendLog(j, `# allocated ${res.address} from ${prefix.prefix} (NetBox ip ${res.id})\n`);
        persist();
      }

      j.phase = 'create'; persist();
```

**(d)** Widen the discover guard (replace the `boxHost` derivation):

```js
      j.phase = 'discover'; persist();
      let boxHost = null;
      // Any explicitly-known address (allocated, overridden, or preset-static)
      // wins; only pure DHCP falls back to lease discovery.
      if (j.ip) boxHost = String(j.ip).split('/')[0];
      else if (preset.net.ipMode === 'static') boxHost = String(preset.net.cidr).split('/')[0];
      else if (preset.startAfterCreate) boxHost = await discoverIp(client, j.node, j.vmid);
```

**(e)** Stamp the link (the `addBox` call's `proxmox` object):

```js
          proxmox: { hostId: host.id, node: j.node, vmid: j.vmid, endpoint: host.endpoint, ...(j.netboxIpId ? { netboxIpId: j.netboxIpId } : {}) },
```

**(f)** Rollback in the `catch`:

```js
    } catch (e) {
      if (j.netboxIpId) {
        // Best-effort: the reservation must not leak when the container never
        // materialized. (Documented trade-off: a create-then-start failure
        // releases the address even though a half-built container may exist.)
        try {
          const netbox = makeNetboxClient(await requireNetboxSettings());
          await netbox.releaseIp(j.netboxIpId);
          appendLog(j, `# released NetBox ip ${j.netboxIpId}\n`);
          j.netboxIpId = null;
        } catch (releaseError) {
          appendLog(j, `# could not release NetBox ip ${j.netboxIpId}: ${releaseError.message}\n`);
        }
      }
      j.status = 'error';
      j.error = e.message;
      j.finishedAt = now();
      persist();
    }
```

**(g)** In `createProvision`, the job shape: manual `ip` override is ignored for auto-static, and `netboxIpId` joins the persisted shape:

```js
        ip: preset.net.ipMode === 'auto-static' ? null : (ip || (preset.net.ipMode === 'static' ? preset.net.cidr : null)),
        netboxIpId: null,
```

**(h)** Wire `src/server/index.js`: add `netboxStore,` to the `createProvisionManager({ … })` argument object (after `proxmoxStore,`). (`netboxStore` is constructed above it already; `makeNetboxClient` keeps its module default.)

Behavior note (spec-mandated): the `j.ip`-first discover guard also makes a manual IP override on a **dhcp** provision derive the box host from the override instead of waiting for a lease — the override previously only affected `net0`. This is the spec's "derive from `j.ip` whenever set" rule.

- [ ] **Step 4: GREEN + boot import check**

Run: `npx vitest run test/proxmoxProvision.test.js && node -e "import('./src/server/server.js').then(()=>console.log('imports ok'))"`
Expected: PASS; `imports ok`.

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxProvision.js src/server/index.js test/proxmoxProvision.test.js
git commit -m "feat(proxmox): allocate-ip provision phase with NetBox reservation and rollback"
```

---

### Task 4: Release the IP on deprovision

**Files:**
- Modify: `src/server/proxmoxLifecycle.js` (signature + `runDeprovision` — NUL protocol applies: never touch line 6)
- Modify: `src/server/index.js` (lifecycleManager construction ~line 128: add `netboxStore,`)
- Test: `test/proxmoxLifecycle.test.js`, `test/proxmoxInventory.test.js` (append)

**Interfaces:**
- Consumes: `createNetboxClient` (Task 1); `box.proxmox.netboxIpId` (Task 3).
- Produces: `createProxmoxLifecycleManager({ …, netboxStore = null, makeNetboxClient = createNetboxClient })`; deprovision job logs `# released NetBox ip <id>` / `# could not release NetBox ip <id>: <message>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/proxmoxLifecycle.test.js` (reuse its `fixture` helper — overrides spread last; give the fixture's box link a `netboxIpId` via override and inject `netboxStore`/`makeNetboxClient`):

```js
const nbSettings = { url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 't' };

test('deprovision releases the NetBox IP after destroy and logs it', async () => {
  const released = [];
  const f = fixture({
    boxStore: fixtureBoxStore({ proxmox: { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006', netboxIpId: 99 } }),
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({ releaseIp: async (id) => { released.push(id); } }),
  });
  const job = await f.manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await f.manager._settled(job.id);
  const done = f.manager.getJob(job.id);
  expect(done.status).toBe('done');
  expect(released).toEqual([99]);
  expect(done.log).toContain('released NetBox ip 99');
});

test('deprovision without a netboxIpId or without NetBox configured skips the release silently', async () => {
  let touched = 0;
  const f = fixture({
    netboxStore: { getSettings: async () => null },
    makeNetboxClient: () => { touched += 1; return {}; },
  });
  const job = await f.manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await f.manager._settled(job.id);
  expect(f.manager.getJob(job.id).status).toBe('done');
  expect(touched).toBe(0);
  expect(f.manager.getJob(job.id).log).not.toContain('NetBox');
});

test('a failing release never fails the deprovision job', async () => {
  const f = fixture({
    boxStore: fixtureBoxStore({ proxmox: { hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006', netboxIpId: 99 } }),
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({ releaseIp: async () => { throw new Error('netbox down'); } }),
  });
  const job = await f.manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await f.manager._settled(job.id);
  expect(f.manager.getJob(job.id).status).toBe('done');
  expect(f.manager.getJob(job.id).log).toContain('could not release NetBox ip 99: netbox down');
});
```

(Names `fixture`/`fixtureBoxStore` are illustrative — read the file's actual helpers first and adapt; the missing-container deprovision path already has a test — extend one variant of it with a `netboxIpId` link + release assertion so the local-cleanup path is covered too.)

Append to `test/proxmoxInventory.test.js`:

```js
test('the drift write preserves netboxIpId on the link', async () => {
  const writes = [];
  const box = linked('b1', 'proxmox02', 165);
  box.proxmox.netboxIpId = 99;
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: { getBox: async () => box, setProxmoxLink: async (id, link) => writes.push([id, link]) },
  });
  await inventory.refreshLinked([box]);
  expect(writes[0][1].netboxIpId).toBe(99);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run test/proxmoxLifecycle.test.js test/proxmoxInventory.test.js`
Expected: new lifecycle tests FAIL (manager doesn't accept/use the new deps); the inventory test may already PASS (the spread preserves it) — that one is a pin, not a change.

- [ ] **Step 3: Implement in `src/server/proxmoxLifecycle.js` (targeted Edits; never include line 6)**

Import + signature (line 10 region):

```js
import { createNetboxClient } from './netboxApi.js';
```

```js
export function createProxmoxLifecycleManager({
  boxStore, proxmoxStore, inventory, makeClient, removeLinkedBox,
  netboxStore = null, makeNetboxClient = createNetboxClient,
  …rest of the existing parameter list unchanged…
```

Helper (near `runDeprovision`):

```js
  // Best-effort IPAM cleanup: only auto-static provisions carry netboxIpId on
  // the link, and a release failure must never fail a deprovision whose
  // container is already destroyed — log it and let local cleanup finish.
  async function releaseNetboxIp(job, box) {
    const ipId = box?.proxmox?.netboxIpId;
    if (!ipId || !netboxStore) return;
    let settings = null;
    try { settings = await netboxStore.getSettings({ withSecret: true }); } catch { settings = null; }
    if (!settings) return;
    try {
      await makeNetboxClient(settings).releaseIp(ipId);
      appendLog(job, `# released NetBox ip ${ipId}\n`); persist();
    } catch (error) {
      appendLog(job, `# could not release NetBox ip ${ipId}: ${error.message}\n`); persist();
    }
  }
```

In `runDeprovision`, both exit paths gain the release before `removeLinkedBox`:

```js
    if (current.state === 'missing') {
      job.phase = 'unlink'; persist();
      await releaseNetboxIp(job, box);
      await removeLinkedBox(job.boxId);
      return;
    }
```

```js
    job.phase = 'unlink'; persist();
    await releaseNetboxIp(job, box);
    await removeLinkedBox(job.boxId);
```

Wire `src/server/index.js`: add `netboxStore,` to the `createProxmoxLifecycleManager({ … })` argument object.

- [ ] **Step 4: NUL check + GREEN**

Run: `node -e "const b=require('fs').readFileSync('src/server/proxmoxLifecycle.js');process.exit(b.includes(0)?1:0)" && echo no-NUL-bytes && git diff --stat -- src/server/proxmoxLifecycle.js && npx vitest run test/proxmoxLifecycle.test.js test/proxmoxInventory.test.js`
Expected: `no-NUL-bytes`, text diff, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxLifecycle.js src/server/index.js test/proxmoxLifecycle.test.js test/proxmoxInventory.test.js
git commit -m "feat(proxmox): release the NetBox IP on deprovision"
```

---

### Task 5: UI — preset editor mode, provision-tab note, types

**Files:**
- Modify: `src/web/proxmox.ts:6` (`PvePresetNet.ipMode`) and `:17` (`ProvisionPhase`)
- Modify: `src/web/proxmoxPresets.ts` (~lines 131-146: ipMode select, cidr/gateway layout, hint; the network `group(…)` assembly)
- Modify: `src/web/proxmoxUi.ts` `renderProvision` (~lines 71-101: `ipField`/`syncStatic`)

**Interfaces:**
- Consumes: `nbx.get()` from `./netbox` (already exported); Task 2's validation (server enforces).
- Produces: no new exports — UI only.

- [ ] **Step 1: Types in `src/web/proxmox.ts`**

```ts
export interface PvePresetNet { bridge: string; vlan: number | null; ipMode: 'dhcp' | 'static' | 'auto-static'; cidr: string | null; gateway: string | null; }
```

```ts
export type ProvisionPhase = 'allocate' | 'allocate-ip' | 'create' | 'start' | 'discover' | 'link' | 'done';
```

- [ ] **Step 2: Preset editor in `src/web/proxmoxPresets.ts`**

Add the option and restructure the cidr/gateway toggles (replacing the current `cidrGateway` block and `syncNetwork`):

```ts
    const ipMode = el('select', {}, [
      el('option', { value: 'dhcp' }, ['dhcp']), el('option', { value: 'static' }, ['static']),
      el('option', { value: 'auto-static' }, ['auto-static (NetBox)']),
    ]) as HTMLSelectElement;
    ipMode.value = editing?.net.ipMode ?? 'dhcp';
    const cidr = input(editing?.net.cidr ?? '', { placeholder: '192.168.1.50/24' });
    const gateway = input(editing?.net.gateway ?? '', { placeholder: '192.168.1.1' });
    const vlan = input(editing?.net.vlan == null ? '' : String(editing.net.vlan), {
      placeholder: 'vlan (optional)', type: 'number',
    });
    const cidrField = field('CIDR', cidr);
    const gatewayField = field('Gateway', gateway);
    const cidrGateway = el('div', { class: 'pve-grid' }, [cidrField, gatewayField]);
    const autoHint = el('div', { class: 'pve-sub' });
    let netboxConfigured = true;
    const syncNetwork = () => {
      const mode = ipMode.value;
      cidrGateway.style.display = mode === 'static' || mode === 'auto-static' ? '' : 'none';
      cidrField.style.display = mode === 'static' ? '' : 'none';
      vlan.placeholder = mode === 'auto-static' ? 'vlan (required)' : 'vlan (optional)';
      autoHint.textContent = mode === 'auto-static'
        ? `IP auto-allocated from the NetBox prefix for VLAN ${vlan.value || 'N'}.${netboxConfigured ? '' : ' — configure NetBox in Settings first'}`
        : '';
    };
    ipMode.addEventListener('change', syncNetwork);
    vlan.addEventListener('input', syncNetwork);
    void nbx.get().then(({ settings }) => { netboxConfigured = !!settings; syncNetwork(); }).catch(() => {});
```

Add `import { nbx } from './netbox';` to the file's imports, append `autoHint` right after `cidrGateway` in the network `group(…)` assembly (find the `group('Network', …)` call and insert it after the element that contains `cidrGateway`), and call `syncNetwork()` once where the current code does. `buildSpec` is unchanged (validation ignores `cidr` for auto-static and the store normalizes it to null).

- [ ] **Step 3: Provision tab in `src/web/proxmoxUi.ts`**

Extend the existing toggle (currently `const syncStatic = () => { ipField.style.display = curPreset()?.net.ipMode === 'static' ? '' : 'none'; };`):

```ts
    const ipAutoNote = el('div', { class: 'pve-sub' }, ['IP: auto-allocated from NetBox']);
    const syncStatic = () => {
      const mode = curPreset()?.net.ipMode;
      ipField.style.display = mode === 'static' ? '' : 'none';
      ipAutoNote.style.display = mode === 'auto-static' ? '' : 'none';
    };
```

Insert `ipAutoNote` immediately after `ipField` in the `box.append(…)` assembly (`field('Preset', sel), field('Hostname', hostname), ipField, ipAutoNote,`) and keep the existing initial `syncStatic()` call.

- [ ] **Step 4: Gate + scripted browser check**

Run: `npm run typecheck && npm run build && npx vitest run test/proxmoxWebClient.test.js test/webIndex.test.js`
Expected: clean/green.

Throwaway Playwright script (mock APIs; established pattern; delete after): open the hub → Presets → New preset with hosts/nodes mocked; select `auto-static (NetBox)` → assert CIDR field hidden, Gateway visible, vlan placeholder reads `vlan (required)`, hint text present (and shows the configure-NetBox suffix when `/api/netbox/settings` mocks `{ settings: null }`); switch to Provision tab with a mocked auto-static preset → assert the IP input is hidden and the `IP: auto-allocated from NetBox` note is visible; with a static preset the input returns. Print assertions; screenshot once and inspect.

- [ ] **Step 5: Commit**

```bash
git add src/web/proxmox.ts src/web/proxmoxPresets.ts src/web/proxmoxUi.ts
git commit -m "feat(ui): auto-static preset mode and provision-tab NetBox note"
```

---

### Task 6: Docs + full suite

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (identical edits), `README.md`

- [ ] **Step 1: CLAUDE.md + AGENTS.md**

1. The netbox bullet's closing sentence changes from "Settings-only for now — IPAM checks during provisioning are the planned next phase." to: "`createNetboxClient` also serves provisioning: `auto-static` presets reserve the next free IP from the VLAN's NetBox prefix (released again on failure or deprovision)."
2. The `provisionStore.js` / `proxmoxProvision.js` bullet's flow gains the phase: "create→poll→start→discover→auto-link-box" → "create→poll→start→discover→auto-link-box (with an `allocate-ip` NetBox phase first for `auto-static` presets)".
3. The lifecycle bullet gains: "deprovision releases the box's NetBox-allocated IP (best-effort)".

- [ ] **Step 2: README**

In the Proxmox provisioning section: document the third IP mode (`auto-static` — pick a VLAN + gateway on the preset; Tmuxifier reserves the next free address from the NetBox prefix for that VLAN at provision time, stamps it into the container, and releases it if creation fails or when the container is deprovisioned; requires the NetBox integration in Settings (⚙)). In the NetBox settings paragraph, drop any "settings-only"/"next phase" phrasing. Placeholders only.

- [ ] **Step 3: Full suite + PII scan**

Run: `npm test`
Expected: typecheck clean; ≥ 641 + all new tests green.
Run: `git diff main | grep -E '^\+' | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | sort -u` — RFC1918/placeholders only.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: auto-static NetBox IP allocation and release"
```
