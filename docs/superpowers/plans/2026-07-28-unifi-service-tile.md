# UniFi Service Tile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `unifi` service check kind that turns a dashboard service tile into a network readout — client census, WAN state, and per-device-class health — sourced from the UniFi Network Integration API v1 with a sealed API key.

**Architecture:** A fifth check kind in the existing service-tile pipeline, not a new subsystem. `servicesStore.js` validates and seals the record; `unifiApi.js` is a dependency-free GET-only HTTPS client that assembles a metrics snapshot behind its own TTL; `unifiRegistry.js` caches one client per service id on top of `serviceClientRegistry.js`; `serviceCheck.js` gains a `unifi` branch; and `unifiCard.ts` renders a double-width card the way `truenasCard.ts` does.

**Tech Stack:** Node 20+ ESM, `node:https`, Fastify, TypeScript + Vite for the web client, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-unifi-service-tile-design.md`

## Global Constraints

- **ESM everywhere** (`"type": "module"`), Node 20+. Server code is plain `.js`; the web client is `.ts`.
- **TDD, real code not mocks.** Dependencies are injected through factory-function parameters (the `{ request = jsonRequest, connect = tlsProbe }` pattern in `netboxApi.js`); that injection *is* the repo's substitute for mocking. Fixtures are real servers (`test/helpers/fakePihole.js`).
- **Conventional commits**: `feat(unifi): …`, `test(unifi): …`, `docs(unifi): …`, `refactor(services): …`.
- **The repo is public. Never commit real PII** — no real domains, public IPs, hostnames, device names, SSIDs, or API keys. Tests and docs use `example.com`, RFC1918 addresses like `192.168.1.10`, and invented device names.
- **The client is read-only by construction.** `unifiApi.js` must expose no code path that issues any HTTP verb other than `GET`.
- **The API key never reaches the browser.** It is sealed via `secretBox`, redacted to `hasPassword` on read, and `getServiceSecret` is the only decrypting path.
- **`https` is required** for a `unifi` tile's URL and probe target.
- **TLS modes are exactly** `'verify' | 'pin' | 'insecure'`, default `'verify'`.
- Run tests with `npx vitest run test/<file>` for one file; `npm test` (typecheck + full vitest) before the final commit.
- **House test style**, which the code blocks below do not always follow — match the repo, not the plan's formatting:
  - Tests are flat `test('…', () => {})` calls, not `describe`/`it` blocks. Where this plan groups tests under a `describe` for readability, write each `it` as a top-level `test()` with the group name folded into its description.
  - Web-module imports in tests carry the explicit extension: `import { x } from '../src/web/unifiCard.ts'`.
  - **`vitest.config.js` sets `environment: 'node'` — there is no DOM.** Nothing in a test may touch `document`. This is why `buildTruenasCard` has no unit test and `buildUnifiCard` will not either; DOM layers are covered by `npm run typecheck` and by live validation (Task 10, Step 6).

---

### Task 1: Probe the live controller and record the real payload shapes

Two of the five endpoints this design depends on could not be confirmed from outside. This task resolves that and turns the answer into the test fixtures every later task uses. It has no unit test of its own — its deliverable is a committed fixture file plus a findings note.

**Files:**
- Create: `test/helpers/unifiSamples.js`
- Modify: `docs/superpowers/plans/2026-07-28-unifi-service-tile.md` (the Probe Findings section below)

**Interfaces:**
- Consumes: nothing.
- Produces: `test/helpers/unifiSamples.js` exporting `SITES`, `DEVICES`, `DEVICE_STATS`, `CLIENTS_PAGE1`, `NETWORKS` — synthetic payloads whose *shape* matches the live controller.

- [ ] **Step 1: Write the probe script**

Create `/tmp/claude-0/-root-tmuxifier/<session>/scratchpad/unifi-probe.mjs` (scratchpad, never committed):

```js
// Read-only probe. Prints which endpoints answer and their top-level keys.
const BASE = process.env.UNIFI_BASE;   // e.g. https://192.168.1.1
const KEY = process.env.UNIFI_KEY;
if (!BASE || !KEY) { console.error('set UNIFI_BASE and UNIFI_KEY'); process.exit(1); }
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // probe only; the shipped client never does this

const P = '/proxy/network/integration/v1';
const get = async (path) => {
  const res = await fetch(`${BASE}${P}${path}`, { headers: { 'X-API-KEY': KEY, Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
};

const sites = await get('/sites');
console.log('SITES', sites.status, JSON.stringify(sites.body)?.slice(0, 400));
const siteId = sites.body?.data?.[0]?.id;
if (!siteId) process.exit(1);

for (const path of [`/sites/${siteId}/devices?limit=5`, `/sites/${siteId}/clients?limit=3`, `/sites/${siteId}/networks?limit=5`]) {
  const r = await get(path);
  console.log('\n===', path, r.status);
  console.log('envelope keys:', Object.keys(r.body ?? {}));
  console.log('first item:', JSON.stringify(r.body?.data?.[0] ?? null, null, 1)?.slice(0, 1200));
}

const devId = (await get(`/sites/${siteId}/devices?limit=1`)).body?.data?.[0]?.id;
const stats = await get(`/sites/${siteId}/devices/${devId}/statistics/latest`);
console.log('\n=== statistics/latest', stats.status);
console.log(JSON.stringify(stats.body, null, 1)?.slice(0, 1500));
```

- [ ] **Step 2: Run it**

```bash
UNIFI_BASE=https://<controller-ip> UNIFI_KEY=<key> node /tmp/.../unifi-probe.mjs
```

The controller address and key are in the operator's UniFi MCP server config. If the sandbox classifier blocks the outbound request, **stop and ask the user to run the command themselves** with a leading `!` so the output lands in the conversation. Do not work around the block.

- [ ] **Step 3: Record the findings**

Fill in the **Probe Findings** section at the bottom of this plan document. It must state, for each of the five endpoints: HTTP status, the envelope keys, and the exact field names used later (`state`, `features`, `model`, `id`, `type`, `uplinkDeviceId`, `cpuUtilizationPct`, `memoryUtilizationPct`, `uptimeSec`, `uplink.txRateBps`, `uplink.rxRateBps`, `totalCount`).

If `/networks` or `/statistics/latest` returns 404, write that down explicitly. Later tasks already handle both as optional — the note is what stops a future reader assuming the cells are broken.

- [ ] **Step 4: Write the fixture module**

Create `test/helpers/unifiSamples.js`. Match the *shapes* observed in step 2 but invent every value — no real device names, MACs, IPs, or SSIDs.

```js
// Synthetic UniFi Network Integration API v1 payloads. Shapes mirror a live
// controller (see the plan's Probe Findings); every value is invented, because
// this repo is public.
export const SITES = {
  offset: 0, limit: 25, count: 1, totalCount: 1,
  data: [{ id: 'site-0001', internalReference: 'default', name: 'Default' }],
};

export const DEVICES = {
  offset: 0, limit: 200, count: 4, totalCount: 4,
  data: [
    { id: 'dev-gw', name: 'Border Gateway', model: 'UCGMAX', macAddress: '00:00:5e:00:53:01', ipAddress: '192.168.1.1', state: 'ONLINE', features: ['gateway', 'switching'] },
    { id: 'dev-sw1', name: 'Rack Switch', model: 'USWED37', macAddress: '00:00:5e:00:53:02', ipAddress: '192.168.1.2', state: 'ONLINE', features: ['switching'] },
    { id: 'dev-ap1', name: 'Office AP', model: 'U7PROMAX', macAddress: '00:00:5e:00:53:03', ipAddress: '192.168.1.3', state: 'ONLINE', features: ['accessPoint'] },
    { id: 'dev-ap2', name: 'Barn AP', model: 'UAPA6A6', macAddress: '00:00:5e:00:53:04', ipAddress: '192.168.1.4', state: 'OFFLINE', features: ['accessPoint'] },
  ],
};

// Keyed by device id; the fake server serves these from /devices/{id}/statistics/latest.
export const DEVICE_STATS = {
  'dev-gw': { uptimeSec: 353702, cpuUtilizationPct: 12, memoryUtilizationPct: 48, uplink: { txRateBps: 940000000, rxRateBps: 45000000 } },
  'dev-sw1': { uptimeSec: 7609228, cpuUtilizationPct: 4, memoryUtilizationPct: 31 },
  'dev-ap1': { uptimeSec: 5040105, cpuUtilizationPct: 9, memoryUtilizationPct: 40 },
  'dev-ap2': { uptimeSec: 0, cpuUtilizationPct: null, memoryUtilizationPct: null },
};

export const CLIENTS_PAGE1 = {
  offset: 0, limit: 200, count: 5, totalCount: 5,
  data: [
    { id: 'cli-1', name: 'nas', macAddress: '00:00:5e:00:53:10', ipAddress: '192.168.1.20', type: 'WIRED', uplinkDeviceId: 'dev-sw1' },
    { id: 'cli-2', name: 'workstation', macAddress: '00:00:5e:00:53:11', ipAddress: '192.168.1.21', type: 'WIRED', uplinkDeviceId: 'dev-sw1' },
    { id: 'cli-3', name: 'laptop', macAddress: '00:00:5e:00:53:12', ipAddress: '192.168.1.22', type: 'WIRELESS', uplinkDeviceId: 'dev-ap1' },
    { id: 'cli-4', name: 'phone', macAddress: '00:00:5e:00:53:13', ipAddress: '192.168.1.23', type: 'WIRELESS', uplinkDeviceId: 'dev-ap1' },
    { id: 'cli-5', name: 'sensor', macAddress: '00:00:5e:00:53:14', ipAddress: '192.168.1.24', type: 'WIRELESS', uplinkDeviceId: 'dev-ap2' },
  ],
};

export const NETWORKS = {
  offset: 0, limit: 200, count: 3, totalCount: 3,
  data: [
    { id: 'net-1', name: 'Default' },
    { id: 'net-2', name: 'Servers' },
    { id: 'net-3', name: 'Guest' },
  ],
};
```

- [ ] **Step 5: Verify no PII and commit**

```bash
grep -nE '155\.|Stuxnet|IPVanish|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' test/helpers/unifiSamples.js
```

Every address printed must be RFC1918 (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`). Then:

```bash
git add test/helpers/unifiSamples.js docs/superpowers/plans/2026-07-28-unifi-service-tile.md
git commit -m "test(unifi): synthetic integration-API fixtures from a live probe"
```

---

### Task 2: Validate and seal the `unifi` service record

**Files:**
- Modify: `src/server/servicesStore.js`
- Test: `test/servicesStore.test.js`

**Interfaces:**
- Consumes: `normFp` from `src/server/tlsPin.js`.
- Produces: a normalized check object `{ kind: 'unifi', target?, site?, tls, fingerprint? }`, where `tls` is always present and `fingerprint` is uppercase colon-less hex present only when `tls === 'pin'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/servicesStore.test.js`. Follow the file's existing setup for building a store with a `secretBox` — reuse whatever helper the neighbouring pihole/truenas tests use rather than inventing one.

```js
describe('unifi check kind', () => {
  it('defaults tls to verify and keeps no fingerprint', async () => {
    const store = makeStore();
    const svc = await store.addService({
      name: 'UniFi', url: 'https://unifi.example.com',
      check: { kind: 'unifi' }, password: 'api-key',
    });
    expect(svc.check).toEqual({ kind: 'unifi', tls: 'verify' });
    expect(svc.hasPassword).toBe(true);
    expect(svc.secret).toBeUndefined();
  });

  it('refuses an http url', async () => {
    const store = makeStore();
    await expect(store.addService({
      name: 'UniFi', url: 'http://unifi.example.com', check: { kind: 'unifi' },
    })).rejects.toThrow(/must be https/);
  });

  it('refuses an http probe target', async () => {
    const store = makeStore();
    await expect(store.addService({
      name: 'UniFi', url: 'https://unifi.example.com',
      check: { kind: 'unifi', target: 'http://192.168.1.1' },
    })).rejects.toThrow(/must be https/);
  });

  it('does not mention TrueNAS when a unifi url is refused', async () => {
    const store = makeStore();
    await expect(store.addService({
      name: 'UniFi', url: 'http://unifi.example.com', check: { kind: 'unifi' },
    })).rejects.toThrow(/^(?!.*TrueNAS).*$/s);
  });

  it('rejects an unknown tls mode', async () => {
    const store = makeStore();
    await expect(store.addService({
      name: 'UniFi', url: 'https://unifi.example.com',
      check: { kind: 'unifi', tls: 'whatever' },
    })).rejects.toThrow(/tls must be verify, pin, or insecure/);
  });

  it('requires a fingerprint in pin mode and normalizes it', async () => {
    const store = makeStore();
    await expect(store.addService({
      name: 'UniFi', url: 'https://unifi.example.com',
      check: { kind: 'unifi', tls: 'pin' },
    })).rejects.toThrow(/requires a certificate fingerprint/);

    const svc = await store.addService({
      name: 'UniFi', url: 'https://unifi.example.com',
      check: { kind: 'unifi', tls: 'pin', fingerprint: 'ab:cd:ef:01' },
    });
    expect(svc.check.fingerprint).toBe('ABCDEF01');
  });

  it('drops the fingerprint when the mode leaves pin', async () => {
    const store = makeStore();
    const svc = await store.addService({
      name: 'UniFi', url: 'https://unifi.example.com',
      check: { kind: 'unifi', tls: 'pin', fingerprint: 'ab:cd' },
    });
    const updated = await store.updateService(svc.id, { check: { kind: 'unifi', tls: 'insecure' } });
    expect(updated.check.fingerprint).toBeUndefined();
    expect(updated.check.tls).toBe('insecure');
  });

  it('keeps an optional site and rejects an over-long one', async () => {
    const store = makeStore();
    const svc = await store.addService({
      name: 'UniFi', url: 'https://unifi.example.com',
      check: { kind: 'unifi', site: 'default' },
    });
    expect(svc.check.site).toBe('default');
    await expect(store.addService({
      name: 'UniFi2', url: 'https://unifi.example.com',
      check: { kind: 'unifi', site: 'x'.repeat(65) },
    })).rejects.toThrow(/at most 64 characters/);
  });

  it('drops the sealed key when the kind changes away from unifi', async () => {
    const store = makeStore();
    const svc = await store.addService({
      name: 'UniFi', url: 'https://unifi.example.com',
      check: { kind: 'unifi' }, password: 'api-key',
    });
    const updated = await store.updateService(svc.id, { check: { kind: 'http' } });
    expect(updated.hasPassword).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/servicesStore.test.js`
Expected: FAIL — `check.kind must be http, tcp, pihole, truenas, or none`.

- [ ] **Step 3: Implement**

In `src/server/servicesStore.js`:

Add the import and constants at the top:

```js
import { normFp } from './tlsPin.js';
```

```js
const KINDS = ['http', 'tcp', 'none', 'pihole', 'truenas', 'unifi'];
const SECRET_KINDS = new Set(['pihole', 'truenas', 'unifi']);
const UNIFI_TLS_MODES = ['verify', 'pin', 'insecure'];
// Why each kind refuses plain HTTP differs, so the reason travels with the call.
const TRUENAS_HTTPS_REASON = 'TrueNAS permanently revokes any API key sent over plain HTTP';
const UNIFI_HTTPS_REASON = 'the API key is write-capable and UniFi controllers always serve TLS';
```

Give `assertHttpsUrl` a reason parameter — this is the one pre-existing helper this feature changes:

```js
function assertHttpsUrl(value, label, reason = '') {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (u.protocol === 'http:') {
    throw new Error(`${label} must be https${reason ? ` — ${reason}` : ''}`);
  }
  if (u.protocol !== 'https:') throw new Error(`${label} must be https`);
}
```

Update the two existing truenas call sites to pass `TRUENAS_HTTPS_REASON` (in `normalizeCheck`'s truenas branch and in `normalize`'s `check.kind === 'truenas'` guard), so the message a TrueNAS operator sees is unchanged.

Add the `unifi` branch in `normalizeCheck`, immediately after the `truenas` branch:

```js
  if (kind === 'unifi') {
    const out = { kind };
    // The integration API base. Empty means "use the tile's own url", which is
    // the common case: the link and the API live on the same controller.
    if (target) { assertHttpsUrl(target, 'check.target', UNIFI_HTTPS_REASON); out.target = target; }
    // Optional site selector, matched against the controller's own
    // internalReference/name/id. Empty means the first site it reports, which
    // is right for the single-site case that dominates.
    const site = String(merged.site ?? '').trim();
    if (site) {
      if (site.length > 64) throw new Error('unifi site must be at most 64 characters');
      out.site = site;
    }
    // Unlike pihole/truenas this is a three-way choice, because a controller's
    // self-signed certificate is the norm and the key it guards can write.
    const tls = merged.tls ?? 'verify';
    if (!UNIFI_TLS_MODES.includes(tls)) throw new Error('unifi check tls must be verify, pin, or insecure');
    out.tls = tls;
    if (tls === 'pin') {
      const fp = normFp(merged.fingerprint);
      if (!fp) throw new Error('unifi check with tls "pin" requires a certificate fingerprint');
      out.fingerprint = fp;
    }
    return out;
  }
```

And in `normalize`, beside the existing truenas guard:

```js
    if (check.kind === 'unifi' && !check.target) assertHttpsUrl(url, 'service url', UNIFI_HTTPS_REASON);
```

Also update the `KINDS` error message string to include `unifi`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/servicesStore.test.js`
Expected: PASS, including every pre-existing truenas test (the reason parameter must not have changed their messages).

- [ ] **Step 5: Commit**

```bash
git add src/server/servicesStore.js test/servicesStore.test.js
git commit -m "feat(unifi): validate and seal the unifi service check kind"
```

---

### Task 3: The pure metrics builder and device classifier

Split out from the network client so the shape decisions are testable without any I/O — the same split `truenasCard.ts` uses between model and DOM.

**Files:**
- Create: `src/server/unifiMetrics.js`
- Test: `test/unifiMetrics.test.js`

**Interfaces:**
- Consumes: `test/helpers/unifiSamples.js` from Task 1.
- Produces:
  - `classifyDevice(device) -> 'gateway' | 'switch' | 'ap' | 'other'`
  - `buildMetrics({ devices, statsById, clients, clientsTotal, networks }) -> UnifiMetrics`
  where `statsById` is a `Map<string, object|null>`, `networks` is an array or `null`, and the returned object matches the spec's metrics shape exactly.

- [ ] **Step 1: Write the failing test**

Create `test/unifiMetrics.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { classifyDevice, buildMetrics } from '../src/server/unifiMetrics.js';
import { DEVICES, DEVICE_STATS, CLIENTS_PAGE1, NETWORKS } from './helpers/unifiSamples.js';

const statsById = new Map(Object.entries(DEVICE_STATS));
const build = (over = {}) => buildMetrics({
  devices: DEVICES.data,
  statsById,
  clients: CLIENTS_PAGE1.data,
  clientsTotal: CLIENTS_PAGE1.totalCount,
  networks: NETWORKS.data,
  ...over,
});

describe('classifyDevice', () => {
  it('calls a device with both gateway and switching features a gateway', () => {
    expect(classifyDevice({ features: ['gateway', 'switching'], model: 'UCGMAX' })).toBe('gateway');
  });

  it('classifies switches and access points from their features', () => {
    expect(classifyDevice({ features: ['switching'], model: 'USWED37' })).toBe('switch');
    expect(classifyDevice({ features: ['accessPoint'], model: 'U7PROMAX' })).toBe('ap');
  });

  it('falls back to the model prefix when features are absent', () => {
    expect(classifyDevice({ model: 'UDMPRO' })).toBe('gateway');
    expect(classifyDevice({ model: 'USW-24' })).toBe('switch');
    expect(classifyDevice({ model: 'UAPA6AE' })).toBe('ap');
    expect(classifyDevice({ model: 'WHAT' })).toBe('other');
    expect(classifyDevice(null)).toBe('other');
  });
});

describe('buildMetrics', () => {
  it('counts clients by connection type and attributes wireless ones to their AP', () => {
    const m = build();
    expect(m.clientsTotal).toBe(5);
    expect(m.clientsWired).toBe(2);
    expect(m.clientsWireless).toBe(3);
    expect(m.aps.clients).toBe(3);
  });

  it('reports the gateway by name with its own load', () => {
    const m = build();
    expect(m.gateway).toEqual({ name: 'Border Gateway', cpuPct: 12, memPct: 48, uptimeSec: 353702 });
  });

  it('tallies each device class and takes the worst cpu across it', () => {
    const m = build();
    expect(m.switches).toEqual({ online: 1, total: 1, cpuPct: 4 });
    expect(m.aps.online).toBe(1);
    expect(m.aps.total).toBe(2);
  });

  it('names every offline device rather than only counting them', () => {
    const m = build();
    expect(m.offline).toEqual([{ name: 'Barn AP', model: 'UAPA6A6' }]);
  });

  it('reads the WAN from the gateway uplink', () => {
    const m = build();
    expect(m.wanState).toBe('up');
    expect(m.wanTxBps).toBe(940000000);
    expect(m.wanRxBps).toBe(45000000);
  });

  it('marks the WAN down when the gateway is offline', () => {
    const devices = DEVICES.data.map((d) => (d.id === 'dev-gw' ? { ...d, state: 'OFFLINE' } : d));
    expect(build({ devices }).wanState).toBe('down');
  });

  it('reports an unknown WAN when no gateway is adopted', () => {
    const devices = DEVICES.data.filter((d) => d.id !== 'dev-gw');
    const m = build({ devices });
    expect(m.wanState).toBe('unknown');
    expect(m.gateway).toBeNull();
    expect(m.wanTxBps).toBeNull();
  });

  it('degrades one field at a time when statistics are unavailable', () => {
    const m = build({ statsById: new Map() });
    expect(m.gateway).toEqual({ name: 'Border Gateway', cpuPct: null, memPct: null, uptimeSec: null });
    expect(m.switches.cpuPct).toBeNull();
    expect(m.wanTxBps).toBeNull();
    expect(m.clientsTotal).toBe(5); // unrelated readings survive
  });

  it('reports a null network count when the endpoint is unavailable', () => {
    expect(build({ networks: null }).networks).toBeNull();
    expect(build().networks).toBe(3);
  });

  it('prefers the reported total over the fetched page length', () => {
    expect(build({ clientsTotal: 900 }).clientsTotal).toBe(900);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unifiMetrics.test.js`
Expected: FAIL — `Cannot find module '../src/server/unifiMetrics.js'`.

- [ ] **Step 3: Implement**

Create `src/server/unifiMetrics.js`:

```js
// Pure shaping of UniFi integration-API payloads into the metrics object the
// dashboard card renders. No I/O lives here, so every layout decision the card
// depends on is testable without a controller — the same model/DOM split
// truenasCard.ts uses on the web side.

// A UniFi gateway also switches and often has a radio, so the feature checks
// are ordered rather than exclusive: the most specific role wins.
export function classifyDevice(device) {
  const features = Array.isArray(device?.features)
    ? device.features.map((f) => String(f).toLowerCase())
    : [];
  if (features.includes('gateway') || features.includes('routing')) return 'gateway';
  if (features.includes('switching')) return 'switch';
  if (features.includes('accesspoint')) return 'ap';
  // Firmware that omits `features` still names its hardware.
  const model = String(device?.model || '').toUpperCase();
  if (/^(UCG|UDM|UXG|UGW|UDR)/.test(model)) return 'gateway';
  if (/^(USW|USL|USF)/.test(model)) return 'switch';
  if (/^(UAP|U6|U7|UWB)/.test(model)) return 'ap';
  return 'other';
}

const isOnline = (d) => String(d?.state || '').toUpperCase() === 'ONLINE';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const typeOf = (c) => String(c?.type || '').toUpperCase();

export function buildMetrics({
  devices = [], statsById = new Map(), clients = [], clientsTotal = null, networks = null,
} = {}) {
  const entries = devices.map((d) => ({
    device: d,
    cls: classifyDevice(d),
    online: isOnline(d),
    stats: statsById.get(d?.id) || null,
  }));

  const gatewayEntry = entries.find((e) => e.cls === 'gateway') || null;
  const apIds = new Set(entries.filter((e) => e.cls === 'ap').map((e) => e.device?.id));

  // The worst CPU in a class, not the mean: one pegged switch is the reading
  // the row exists to surface, and averaging it away defeats the point.
  const tally = (cls) => {
    const list = entries.filter((e) => e.cls === cls);
    const cpus = list.map((e) => num(e.stats?.cpuUtilizationPct)).filter((v) => v != null);
    return {
      online: list.filter((e) => e.online).length,
      total: list.length,
      cpuPct: cpus.length ? Math.round(Math.max(...cpus)) : null,
    };
  };

  const uplink = gatewayEntry?.stats?.uplink || null;

  return {
    // totalCount is authoritative; the split is computed from the pages actually
    // fetched, so on a site past the page cap it undercounts while the total
    // stays exact.
    clientsTotal: num(clientsTotal) ?? clients.length,
    clientsWired: clients.filter((c) => typeOf(c) === 'WIRED').length,
    clientsWireless: clients.filter((c) => typeOf(c) === 'WIRELESS').length,
    networks: Array.isArray(networks) ? networks.length : null,
    wanState: gatewayEntry ? (gatewayEntry.online ? 'up' : 'down') : 'unknown',
    wanTxBps: num(uplink?.txRateBps),
    wanRxBps: num(uplink?.rxRateBps),
    gateway: gatewayEntry
      ? {
        name: String(gatewayEntry.device?.name || gatewayEntry.device?.model || 'gateway'),
        cpuPct: num(gatewayEntry.stats?.cpuUtilizationPct),
        memPct: num(gatewayEntry.stats?.memoryUtilizationPct),
        uptimeSec: num(gatewayEntry.stats?.uptimeSec),
      }
      : null,
    switches: tally('switch'),
    aps: { ...tally('ap'), clients: clients.filter((c) => apIds.has(c?.uplinkDeviceId)).length },
    // Named, not merely counted: a tally cannot tell you which AP to go look at.
    offline: entries
      .filter((e) => !e.online)
      .map((e) => ({ name: String(e.device?.name || e.device?.model || 'unknown'), model: String(e.device?.model || '') })),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unifiMetrics.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/unifiMetrics.js test/unifiMetrics.test.js
git commit -m "feat(unifi): pure device classifier and metrics builder"
```

---

### Task 4: The UniFi API client

**Files:**
- Create: `src/server/unifiApi.js`
- Create: `test/helpers/fakeUnifi.js`
- Test: `test/unifiApi.test.js`

**Interfaces:**
- Consumes: `buildMetrics`/`classifyDevice` from `src/server/unifiMetrics.js`; `tlsProbe`, `pinnedConnectionFactory`, `normFp` from `src/server/tlsPin.js`; the fixtures from `test/helpers/unifiSamples.js`.
- Produces:
  - `createUnifiClient({ baseUrl, apiKey, site, tls, fingerprint, timeoutMs, ttlMs, now, request, connect }) -> { probe(), snapshot() }`
  - `snapshot()` resolves `{ ok: true, metrics }` or `{ ok: false, kind: 'auth' | 'unreachable' | 'tls' | 'unexpected', error }` — the same result shape `piholeApi.fetchSummary` and `truenasApi.fetchMetrics` return, so `serviceCheck.js` treats all three alike.
  - `probe()` resolves `{ ok: true, sites: [{ id, name, reference }], fingerprint256 }` or `{ ok: false, kind, error, fingerprint256? }`.

- [ ] **Step 1: Write the fixture server**

Create `test/helpers/fakeUnifi.js`:

```js
import http from 'node:http';
import { SITES, DEVICES, DEVICE_STATS, CLIENTS_PAGE1, NETWORKS } from './unifiSamples.js';

// A real HTTP server speaking the UniFi integration-API envelope, so the client
// tests exercise the actual request path (no mocks — the repo convention).
// Counters let tests assert how often each endpoint was hit, which is how the
// snapshot TTL is verified.
export async function startFakeUnifi({
  apiKey = 'test-key',
  sites = SITES,
  devices = DEVICES,
  deviceStats = DEVICE_STATS,
  clients = CLIENTS_PAGE1,
  networks = NETWORKS,       // null => respond 404, simulating firmware without it
  statsStatus = 200,         // 404 => simulate firmware without /statistics/latest
  unauthorized = false,
  malformed = false,
} = {}) {
  const counts = { sites: 0, devices: 0, stats: 0, clients: 0, networks: 0 };
  const P = '/proxy/network/integration/v1';

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(malformed ? '{not json' : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { send(res, 405, { error: 'read-only fixture' }); return; }
    if (unauthorized || req.headers['x-api-key'] !== apiKey) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === `${P}/sites`) { counts.sites++; send(res, 200, sites); return; }

    const stats = /^\/proxy\/network\/integration\/v1\/sites\/([^/]+)\/devices\/([^/]+)\/statistics\/latest$/.exec(path);
    if (stats) {
      counts.stats++;
      if (statsStatus !== 200) { send(res, statsStatus, { error: 'not found' }); return; }
      send(res, 200, deviceStats[stats[2]] ?? {});
      return;
    }

    const site = /^\/proxy\/network\/integration\/v1\/sites\/([^/]+)\/(devices|clients|networks)$/.exec(path);
    if (site) {
      const which = site[2];
      if (which === 'networks') {
        counts.networks++;
        if (networks === null) { send(res, 404, { error: 'not found' }); return; }
        send(res, 200, networks);
        return;
      }
      if (which === 'devices') { counts.devices++; send(res, 200, devices); return; }
      counts.clients++;
      send(res, 200, clients);
      return;
    }

    send(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    async stop() { await new Promise((resolve) => server.close(resolve)); },
  };
}
```

Note the fixture is plain HTTP. The client's https-only rule lives in `servicesStore.js` validation (Task 2) and the route (Task 6), not in the transport, so the client can be exercised over HTTP here exactly as `piholeApi.js` is. TLS-mode behaviour is tested separately via the injected `request`/`connect` seams.

- [ ] **Step 2: Write the failing tests**

Create `test/unifiApi.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import { createUnifiClient } from '../src/server/unifiApi.js';
import { startFakeUnifi } from './helpers/fakeUnifi.js';
import { SITES } from './helpers/unifiSamples.js';

let fake = null;
afterEach(async () => { await fake?.stop(); fake = null; });

const client = (over = {}) => createUnifiClient({ baseUrl: fake.baseUrl, apiKey: 'test-key', ...over });

describe('createUnifiClient.snapshot', () => {
  it('assembles metrics from the live endpoints', async () => {
    fake = await startFakeUnifi();
    const res = await client().snapshot();
    expect(res.ok).toBe(true);
    expect(res.metrics.clientsTotal).toBe(5);
    expect(res.metrics.gateway.name).toBe('Border Gateway');
    expect(res.metrics.networks).toBe(3);
    expect(res.metrics.offline).toHaveLength(1);
  });

  it('resolves the site once and reuses it', async () => {
    fake = await startFakeUnifi();
    const c = client({ ttlMs: 0 });
    await c.snapshot();
    await c.snapshot();
    expect(fake.counts.sites).toBe(1);
    expect(fake.counts.devices).toBe(2);
  });

  it('serves the cached snapshot until the ttl expires', async () => {
    fake = await startFakeUnifi();
    let t = 1000;
    const c = client({ ttlMs: 30000, now: () => t });
    await c.snapshot();
    const after = fake.counts.devices;
    await c.snapshot();
    expect(fake.counts.devices).toBe(after); // inside the window: no traffic
    t += 30001;
    await c.snapshot();
    expect(fake.counts.devices).toBe(after + 1);
  });

  it('reports auth rather than down when the key is rejected', async () => {
    fake = await startFakeUnifi({ unauthorized: true });
    const res = await client().snapshot();
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('auth');
  });

  it('does not cache a failure', async () => {
    fake = await startFakeUnifi({ unauthorized: true });
    const c = client();
    await c.snapshot();
    await c.snapshot();
    expect(fake.counts.sites).toBe(2);
  });

  it('degrades when the networks endpoint is absent', async () => {
    fake = await startFakeUnifi({ networks: null });
    const res = await client().snapshot();
    expect(res.ok).toBe(true);
    expect(res.metrics.networks).toBeNull();
    expect(res.metrics.clientsTotal).toBe(5);
  });

  it('degrades when the statistics endpoint is absent', async () => {
    fake = await startFakeUnifi({ statsStatus: 404 });
    const res = await client().snapshot();
    expect(res.ok).toBe(true);
    expect(res.metrics.gateway.cpuPct).toBeNull();
    expect(res.metrics.wanTxBps).toBeNull();
    expect(res.metrics.wanState).toBe('up'); // state comes from the device list
  });

  it('selects a site by its internal reference', async () => {
    const sites = {
      ...SITES,
      count: 2, totalCount: 2,
      data: [
        { id: 'site-other', internalReference: 'other', name: 'Other' },
        { id: 'site-0001', internalReference: 'default', name: 'Default' },
      ],
    };
    fake = await startFakeUnifi({ sites });
    const res = await client({ site: 'default' }).snapshot();
    expect(res.ok).toBe(true);
  });

  it('reports unexpected when the named site does not exist', async () => {
    fake = await startFakeUnifi();
    const res = await client({ site: 'nope' }).snapshot();
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('unexpected');
    expect(res.error).toMatch(/nope/);
  });

  it('reports unexpected on a malformed body', async () => {
    fake = await startFakeUnifi({ malformed: true });
    const res = await client().snapshot();
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('unexpected');
  });

  it('reports unreachable when nothing is listening', async () => {
    fake = await startFakeUnifi();
    const base = fake.baseUrl;
    await fake.stop();
    fake = null;
    const res = await createUnifiClient({ baseUrl: base, apiKey: 'test-key' }).snapshot();
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('unreachable');
  });
});

describe('createUnifiClient.probe', () => {
  it('returns the site list for the settings form', async () => {
    fake = await startFakeUnifi();
    const res = await client().probe();
    expect(res.ok).toBe(true);
    expect(res.sites).toEqual([{ id: 'site-0001', name: 'Default', reference: 'default' }]);
  });

  it('reports auth without leaking the key', async () => {
    fake = await startFakeUnifi({ unauthorized: true });
    const res = await client().probe();
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('auth');
    expect(JSON.stringify(res)).not.toContain('test-key');
  });
});

describe('TLS modes', () => {
  // `connect` is always injected: probe() reaches for the served fingerprint on
  // an https base, and an un-injected tlsProbe would make a real network call
  // out of a unit test.
  const capture = (fingerprint256 = null) => {
    const calls = [];
    const request = async (opts) => { calls.push(opts); return { status: 200, json: SITES }; };
    return { calls, request, connect: async () => ({ fingerprint256 }) };
  };

  it('verifies certificates by default', async () => {
    const { calls, request, connect } = capture();
    await createUnifiClient({ baseUrl: 'https://unifi.example.com', apiKey: 'k', request, connect }).probe();
    expect(calls[0].tls).toEqual({});
  });

  it('disables verification only in insecure mode', async () => {
    const { calls, request, connect } = capture();
    await createUnifiClient({ baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'insecure', request, connect }).probe();
    expect(calls[0].tls).toEqual({ rejectUnauthorized: false });
  });

  it('pins the fingerprint after probing the certificate', async () => {
    const { calls, request, connect } = capture('AA:BB:CC');
    await createUnifiClient({
      baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'pin', fingerprint: 'aabbcc', request, connect,
    }).probe();
    expect(calls[0].tls).toEqual({ pin: 'aabbcc' });
  });

  it('fails closed on a fingerprint mismatch and sends no request', async () => {
    const { calls, request } = capture();
    const connect = async () => ({ fingerprint256: 'DD:EE:FF' });
    const res = await createUnifiClient({
      baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'pin', fingerprint: 'aabbcc', request, connect,
    }).snapshot();
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('tls');
    expect(res.error).toMatch(/fingerprint mismatch/i);
    expect(calls).toHaveLength(0); // the key was never written to the wire
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/unifiApi.test.js`
Expected: FAIL — `Cannot find module '../src/server/unifiApi.js'`.

- [ ] **Step 4: Implement**

Create `src/server/unifiApi.js`:

```js
import http from 'node:http';
import https from 'node:https';
import { tlsProbe, pinnedConnectionFactory, normFp } from './tlsPin.js';
import { buildMetrics } from './unifiMetrics.js';

// Dependency-free client for the UniFi Network Integration API v1, in the mold
// of netboxApi.js. GET only: there is deliberately no code path here that
// issues another verb, so the API key's blast radius stays at reads even though
// UniFi's local keys inherit their admin account's role.
const API_PREFIX = '/proxy/network/integration/v1';
const PAGE = 200;
// Bounds one refresh on a very large site. The client total still comes from
// the envelope's totalCount, so only the wired/wireless split is approximate
// past this many clients.
const MAX_CLIENT_PAGES = 5;
const DEFAULT_TTL_MS = 30000;

function jsonRequest({ url, headers = {}, timeoutMs = 10000, tls: tlsOpts = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method: 'GET', headers, timeout: timeoutMs,
      ...(secure ? (tlsOpts.pin ? {
        createConnection: pinnedConnectionFactory({ host: u.hostname, port: Number(u.port) || 443, fingerprint256: tlsOpts.pin, timeoutMs }),
      } : { rejectUnauthorized: tlsOpts.rejectUnauthorized !== false }) : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* reported as unexpected */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('UniFi request timed out')));
    req.on('error', reject);
    req.end();
  });
}

// A thrown ApiError carries the classification serviceCheck.js needs; every
// public method converts it into a result object rather than letting it escape.
class ApiError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const rows = (body) => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null);

export function createUnifiClient({
  baseUrl, apiKey, site = '', tls = 'verify', fingerprint = '',
  timeoutMs = 10000, ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(), request = jsonRequest, connect = tlsProbe,
} = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let siteIdPromise = null;
  let cached = null; // { at, metrics }

  // Pin mode probes the certificate before any authenticated request, so a
  // mismatch is caught while the key is still unsent. Resolved once per client:
  // the request connection re-verifies the pin anyway (pinnedSocket).
  let tlsPromise = null;
  function resolveTls() {
    if (tls === 'insecure') return Promise.resolve({ rejectUnauthorized: false });
    if (tls !== 'pin') return Promise.resolve({});
    tlsPromise ??= (async () => {
      const u = new URL(base);
      if (u.protocol !== 'https:') throw new ApiError('tls', 'certificate pinning requires an https URL');
      let probe;
      try { probe = await connect({ host: u.hostname, port: Number(u.port) || 443, timeoutMs }); }
      catch (e) { throw new ApiError('unreachable', e?.message || 'TLS probe failed'); }
      if (!normFp(fingerprint)) throw new ApiError('tls', 'no fingerprint pinned yet — run Test connection and accept the certificate');
      if (normFp(probe.fingerprint256) !== normFp(fingerprint)) {
        throw new ApiError('tls', 'TLS fingerprint mismatch — the controller certificate changed; re-pin to accept the new one');
      }
      return { pin: fingerprint };
    })().catch((e) => { tlsPromise = null; throw e; });
    return tlsPromise;
  }

  async function get(path, { optional = false } = {}) {
    const tlsOpts = await resolveTls();
    let res;
    try {
      res = await request({
        url: `${base}${API_PREFIX}${path}`,
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
        timeoutMs, tls: tlsOpts,
      });
    } catch (e) {
      throw new ApiError('unreachable', e?.message || 'request failed');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('auth', `the controller rejected the API key (HTTP ${res.status})`);
    }
    // An endpoint this firmware does not implement costs the readings it feeds
    // and nothing else.
    if (optional && (res.status === 404 || res.status === 501)) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError('unexpected', `unexpected response from ${path} (HTTP ${res.status})`);
    }
    if (res.json == null) throw new ApiError('unexpected', `unparseable response from ${path}`);
    return res.json;
  }

  async function listSites() {
    const body = await get('/sites');
    const list = rows(body);
    if (!list) throw new ApiError('unexpected', 'unexpected /sites response — is this a UniFi controller URL?');
    return list.map((s) => ({ id: String(s?.id ?? ''), name: String(s?.name ?? ''), reference: String(s?.internalReference ?? '') }));
  }

  function resolveSiteId() {
    siteIdPromise ??= (async () => {
      const list = await listSites();
      if (list.length === 0) throw new ApiError('unexpected', 'the controller reports no sites');
      if (!site) return list[0].id;
      const match = list.find((s) => s.reference === site || s.name === site || s.id === site);
      if (!match) throw new ApiError('unexpected', `no site named ${JSON.stringify(site)} on this controller`);
      return match.id;
    })().catch((e) => { siteIdPromise = null; throw e; });
    return siteIdPromise;
  }

  async function listClients(siteId) {
    const all = [];
    let total = null;
    for (let page = 0; page < MAX_CLIENT_PAGES; page++) {
      const body = await get(`/sites/${encodeURIComponent(siteId)}/clients?limit=${PAGE}&offset=${page * PAGE}`);
      const list = rows(body) ?? [];
      if (total == null && typeof body?.totalCount === 'number') total = body.totalCount;
      all.push(...list);
      if (list.length < PAGE) break;
    }
    return { clients: all, total };
  }

  async function refresh() {
    const siteId = await resolveSiteId();
    const devicesBody = await get(`/sites/${encodeURIComponent(siteId)}/devices?limit=${PAGE}`);
    const devices = rows(devicesBody) ?? [];
    const { clients, total } = await listClients(siteId);
    const networksBody = await get(`/sites/${encodeURIComponent(siteId)}/networks?limit=${PAGE}`, { optional: true });

    const statsById = new Map();
    for (const d of devices) {
      if (!d?.id) continue;
      const stats = await get(`/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(d.id)}/statistics/latest`, { optional: true });
      statsById.set(d.id, stats);
    }

    return buildMetrics({
      devices, statsById, clients, clientsTotal: total,
      networks: networksBody === null ? null : rows(networksBody),
    });
  }

  const asResult = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof ApiError) return { ok: false, kind: e.kind, error: e.message };
      return { ok: false, kind: 'unexpected', error: e?.message || 'unifi request failed' };
    }
  };

  return {
    // Used by the settings Test button: proves the key works, and hands back the
    // site list plus the served fingerprint so pin mode can be armed.
    probe: () => asResult(async () => {
      const sites = await listSites();
      let fingerprint256 = null;
      const u = new URL(base);
      if (u.protocol === 'https:') {
        try { fingerprint256 = (await connect({ host: u.hostname, port: Number(u.port) || 443, timeoutMs })).fingerprint256 ?? null; }
        catch { /* the probe already succeeded; the fingerprint is a bonus */ }
      }
      return { ok: true, sites, fingerprint256 };
    }),

    // Used by the sweep. Only successes are cached: a transient failure must not
    // pin the tile to an error for the rest of the TTL window.
    snapshot: () => asResult(async () => {
      if (cached && now() - cached.at < ttlMs) return { ok: true, metrics: cached.metrics };
      const metrics = await refresh();
      cached = { at: now(), metrics };
      return { ok: true, metrics };
    }),
  };
}
```

Note: `probe()` reports a fingerprint mismatch as a `tls` failure through `resolveTls`, so arming a bad pin surfaces the same message the sweep would.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/unifiApi.test.js`
Expected: PASS (17 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/unifiApi.js test/helpers/fakeUnifi.js test/unifiApi.test.js
git commit -m "feat(unifi): read-only integration-API client with a snapshot ttl"
```

---

### Task 5: Registry, check branch, and sweep wiring

**Files:**
- Create: `src/server/unifiRegistry.js`
- Modify: `src/server/serviceCheck.js`
- Modify: `src/server/serviceChecker.js`
- Modify: `src/server/index.js`
- Test: `test/unifiRegistry.test.js`, `test/serviceCheck.test.js`

**Interfaces:**
- Consumes: `createUnifiClient` from Task 4; `createServiceClientRegistry` from `src/server/serviceClientRegistry.js`.
- Produces:
  - `createUnifiRegistry({ store, makeClient, timeoutMs }) -> { clientFor, retain, closeAll }`
  - `checkUnifi(service, { unifiRegistry }) -> { state, latencyMs, unifi? , error? }`
  - `checkService(service, { piholeRegistry, truenasRegistry, unifiRegistry })` routes `kind === 'unifi'` to `checkUnifi`.

- [ ] **Step 1: Write the failing tests**

Create `test/unifiRegistry.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createUnifiRegistry } from '../src/server/unifiRegistry.js';

const store = (secret = 'key-1') => ({ getServiceSecret: async () => secret });
const svc = (over = {}) => ({
  id: 'svc-1', url: 'https://unifi.example.com',
  check: { kind: 'unifi', tls: 'verify', ...over },
});

function tracker() {
  const made = [];
  const closed = [];
  return {
    made, closed,
    makeClient: (options) => {
      const client = { options, close: async () => { closed.push(options); } };
      made.push(client);
      return client;
    },
  };
}

describe('createUnifiRegistry', () => {
  it('reuses one client per service while its options are unchanged', async () => {
    const t = tracker();
    const reg = createUnifiRegistry({ store: store(), makeClient: t.makeClient });
    const a = await reg.clientFor(svc());
    const b = await reg.clientFor(svc());
    expect(a).toBe(b);
    expect(t.made).toHaveLength(1);
  });

  it('passes the site and tls mode through to the client', async () => {
    const t = tracker();
    const reg = createUnifiRegistry({ store: store('key-1'), makeClient: t.makeClient });
    await reg.clientFor(svc({ site: 'default', tls: 'pin', fingerprint: 'ABCD' }));
    expect(t.made[0].options).toMatchObject({
      baseUrl: 'https://unifi.example.com', apiKey: 'key-1',
      site: 'default', tls: 'pin', fingerprint: 'ABCD',
    });
  });

  it('rebuilds the client when the tls mode changes', async () => {
    const t = tracker();
    const reg = createUnifiRegistry({ store: store(), makeClient: t.makeClient });
    const a = await reg.clientFor(svc());
    const b = await reg.clientFor(svc({ tls: 'insecure' }));
    expect(a).not.toBe(b);
    expect(t.made).toHaveLength(2);
  });

  it('rebuilds the client when the key rotates', async () => {
    const t = tracker();
    let secret = 'key-1';
    const reg = createUnifiRegistry({ store: { getServiceSecret: async () => secret }, makeClient: t.makeClient });
    await reg.clientFor(svc());
    secret = 'key-2';
    await reg.clientFor(svc());
    expect(t.made).toHaveLength(2);
  });

  it('drops clients for services that have gone away', async () => {
    const t = tracker();
    const reg = createUnifiRegistry({ store: store(), makeClient: t.makeClient });
    await reg.clientFor(svc());
    await reg.retain([]);
    await reg.clientFor(svc());
    expect(t.made).toHaveLength(2);
  });
});
```

Append to `test/serviceCheck.test.js`:

```js
describe('checkService with a unifi kind', () => {
  const service = { id: 'svc-1', url: 'https://unifi.example.com', check: { kind: 'unifi', tls: 'verify' }, hasPassword: true };

  it('returns the metrics on success', async () => {
    const metrics = { clientsTotal: 5 };
    const unifiRegistry = { clientFor: async () => ({ snapshot: async () => ({ ok: true, metrics }) }) };
    const res = await checkService(service, { unifiRegistry });
    expect(res.state).toBe('up');
    expect(res.unifi).toBe(metrics);
    expect(typeof res.latencyMs).toBe('number');
  });

  it('maps an auth failure to the auth state, not down', async () => {
    const unifiRegistry = { clientFor: async () => ({ snapshot: async () => ({ ok: false, kind: 'auth', error: 'rejected' }) }) };
    const res = await checkService(service, { unifiRegistry });
    expect(res.state).toBe('auth');
  });

  it('names the missing credential when none is stored', async () => {
    const unifiRegistry = { clientFor: async () => ({ snapshot: async () => ({ ok: false, kind: 'auth', error: 'rejected' }) }) };
    const res = await checkService({ ...service, hasPassword: false }, { unifiRegistry });
    expect(res.state).toBe('auth');
    expect(res.error).toMatch(/no API key configured/);
  });

  it('maps a tls failure to down', async () => {
    const unifiRegistry = { clientFor: async () => ({ snapshot: async () => ({ ok: false, kind: 'tls', error: 'TLS fingerprint mismatch' }) }) };
    const res = await checkService(service, { unifiRegistry });
    expect(res.state).toBe('down');
    expect(res.error).toMatch(/fingerprint mismatch/);
  });

  it('reports down when no registry is wired', async () => {
    const res = await checkService(service, {});
    expect(res.state).toBe('down');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unifiRegistry.test.js test/serviceCheck.test.js`
Expected: FAIL — missing module, and `checkService` falls through to the HTTP branch.

- [ ] **Step 3: Implement the registry**

Create `src/server/unifiRegistry.js`:

```js
import { createUnifiClient } from './unifiApi.js';
import { createServiceClientRegistry } from './serviceClientRegistry.js';

// One UniFi client per service id. See serviceClientRegistry.js for the caching
// and lifetime rules. A UniFi client is defined by its API base, the API key,
// the selected site, and the TLS mode and its pin — change any of those and the
// cached client (with its resolved site and snapshot) is replaced.
export function createUnifiRegistry({ store, makeClient = createUnifiClient, timeoutMs = 10000 }) {
  return createServiceClientRegistry({
    store,
    makeClient,
    buildOptions: (service, secret) => ({
      baseUrl: String(service.check?.target || service.url || '').replace(/\/+$/, ''),
      apiKey: secret,
      site: String(service.check?.site || ''),
      tls: service.check?.tls || 'verify',
      fingerprint: String(service.check?.fingerprint || ''),
      timeoutMs,
    }),
  });
}
```

- [ ] **Step 4: Implement the check branch**

In `src/server/serviceCheck.js`, add after `checkTruenas`:

```js
// A UniFi check reports the network, not just reachability. As with Pi-hole and
// TrueNAS the `auth` state is deliberately distinct from `down`: a rotated or
// revoked API key means the controller is answering perfectly well, and
// painting it red would cry wolf. A TLS failure is not an auth failure — it is
// a transport the operator must decide about, so it stays `down`.
export async function checkUnifi(service, { unifiRegistry } = {}) {
  if (!unifiRegistry) return { state: 'down', error: 'unifi client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await unifiRegistry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'unifi client setup failed' };
  }
  const res = await client.snapshot();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, unifi: res.metrics };
  if (res.kind === 'auth') {
    const error = service.hasPassword === false
      ? 'no API key configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}
```

And in `checkService`, beside the other kind branches:

```js
  if (kind === 'unifi') return checkUnifi(service, opts);
```

- [ ] **Step 5: Wire the sweep and the entrypoint**

In `src/server/serviceChecker.js`: add `unifiRegistry = null` to the factory options, pass it through in the `check(s, { … })` call, and add the retain block beside the other two:

```js
      if (unifiRegistry) {
        await unifiRegistry.retain(services.filter((s) => s.check?.kind === 'unifi').map((s) => s.id));
      }
```

In `src/server/index.js`: import `createUnifiRegistry`, construct it beside the other two registries (around line 269), pass `unifiRegistry` into `createServiceChecker`, and add `() => unifiRegistry.closeAll()` to the shutdown list (around line 303).

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run test/unifiRegistry.test.js test/serviceCheck.test.js test/serviceChecker.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/unifiRegistry.js src/server/serviceCheck.js src/server/serviceChecker.js src/server/index.js test/unifiRegistry.test.js test/serviceCheck.test.js
git commit -m "feat(unifi): registry, check branch, and sweep wiring"
```

---

### Task 6: The test-connection route

**Files:**
- Modify: `src/server/server.js`
- Modify: `src/web/api.ts`
- Test: `test/serviceRoutes.test.js`

**Interfaces:**
- Consumes: `createUnifiClient` (injected into `buildServer` as `makeUnifiClient`, defaulting to the real one — the pattern `makeTruenasClient` already uses).
- Produces: `POST /api/services/unifi/test` accepting `{ url, apiKey?, site?, tls?, fingerprint?, id? }` and returning `{ ok: true, sites, fingerprint256 }` or `{ ok: false, error, fingerprint256? }`.
- Produces: `api.testUnifi(body)` on the web client.

- [ ] **Step 1: Write the failing test**

`test/serviceRoutes.test.js` builds one `app` in a module-level `beforeEach` and authenticates through a `headers()` helper — read the top of the file before writing. Client seams are injected as `buildServer` options (see how `makeTruenasClient` is stubbed there, and the comment explaining why: the route refuses `http:`, so a loopback fixture cannot be probed through it).

Two changes are needed. First, extend the existing `buildServer({ … })` call in `beforeEach` with a UniFi seam whose behaviour the tests can steer:

```js
    // Set by individual tests; the route refuses http:, so a loopback fixture
    // cannot be reached through it — the client seam is the injection point.
    makeUnifiClient: (options) => ({
      probe: async () => {
        unifiSeen = options;
        return unifiProbeResult;
      },
    }),
```

with `let unifiSeen, unifiProbeResult;` declared beside the other module-level state and reset in `beforeEach`.

Then append the tests, flat-`test` style:

```js
test('POST /api/services/unifi/test refuses a plain-http url before building a client', async () => {
  unifiSeen = null;
  const res = await app.inject({
    method: 'POST', url: '/api/services/unifi/test', headers: await headers(),
    payload: { url: 'http://unifi.example.com' },
  });
  expect(res.json().ok).toBe(false);
  expect(res.json().error).toMatch(/https/);
  expect(unifiSeen).toBeNull(); // never constructed, so the key was never used
});

test('POST /api/services/unifi/test returns the site list and served fingerprint', async () => {
  unifiProbeResult = { ok: true, sites: [{ id: 's1', name: 'Default', reference: 'default' }], fingerprint256: 'AA:BB' };
  const res = await app.inject({
    method: 'POST', url: '/api/services/unifi/test', headers: await headers(),
    payload: { url: 'https://unifi.example.com', apiKey: 'k', site: 'default', tls: 'pin', fingerprint: 'AA:BB' },
  });
  expect(res.json()).toEqual({ ok: true, sites: [{ id: 's1', name: 'Default', reference: 'default' }], fingerprint256: 'AA:BB' });
  expect(unifiSeen).toMatchObject({ baseUrl: 'https://unifi.example.com', apiKey: 'k', site: 'default', tls: 'pin' });
});

test('POST /api/services/unifi/test never echoes the api key back', async () => {
  unifiProbeResult = { ok: false, kind: 'auth', error: 'the controller rejected the API key (HTTP 401)' };
  const res = await app.inject({
    method: 'POST', url: '/api/services/unifi/test', headers: await headers(),
    payload: { url: 'https://unifi.example.com', apiKey: 'super-secret' },
  });
  expect(res.payload).not.toContain('super-secret');
  expect(res.json().ok).toBe(false);
});

test('POST /api/services/unifi/test requires authentication', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/services/unifi/test',
    payload: { url: 'https://unifi.example.com' },
  });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/serviceRoutes.test.js`
Expected: FAIL — 404 on the route.

- [ ] **Step 3: Implement**

In `src/server/server.js`: import `createUnifiClient` from `./unifiApi.js`, add `makeUnifiClient = createUnifiClient` to the `buildServer` destructured options, and add the route beside the TrueNAS one (after line 855):

```js
  // Same rationale as the Pi-hole and TrueNAS probes: save-and-pray is a poor
  // way to discover the key is wrong. This one also hands back the site list
  // and the served certificate fingerprint, which is how pin mode gets armed.
  app.post('/api/services/unifi/test', { preHandler: requireAuth }, async (req) => {
    const { url, apiKey, site, tls, fingerprint, id } = req.body || {};
    const value = typeof url === 'string' ? url.trim() : '';
    let u;
    try { u = new URL(value); } catch { return { ok: false, error: 'enter a valid https URL for the controller' }; }
    // The API key inherits its admin account's role, so it is never sent over a
    // cleartext connection — refused here as well as in the store's validation.
    if (u.protocol !== 'https:') {
      return { ok: false, error: 'the controller must be reached over https — a UniFi API key can write to your network' };
    }
    // A blank key on an existing service means "use the one already stored", so
    // Test works while editing without retyping the secret.
    let key = typeof apiKey === 'string' ? apiKey : '';
    if (!key && id) key = (await servicesStore.getServiceSecret(id)) || '';
    const client = makeUnifiClient({
      baseUrl: value, apiKey: key,
      site: typeof site === 'string' ? site.trim() : '',
      tls: tls === 'pin' || tls === 'insecure' ? tls : 'verify',
      fingerprint: typeof fingerprint === 'string' ? fingerprint : '',
    });
    const res = await client.probe();
    return res.ok
      ? { ok: true, sites: res.sites, fingerprint256: res.fingerprint256 ?? null }
      : { ok: false, error: res.error, ...(res.fingerprint256 ? { fingerprint256: res.fingerprint256 } : {}) };
  });
```

In `src/web/api.ts`, beside `testTruenas`:

```ts
  async testUnifi(body: { url: string; apiKey?: string; site?: string; tls?: string; fingerprint?: string; id?: string }) {
    return j<{ ok: boolean; error?: string; fingerprint256?: string | null; sites?: { id: string; name: string; reference: string }[] }>(
      await fetch('/api/services/unifi/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/serviceRoutes.test.js && npm run typecheck`
Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js src/web/api.ts test/serviceRoutes.test.js
git commit -m "feat(unifi): test-connection route returning sites and the served fingerprint"
```

---

### Task 7: Web types and the pure card model

**Files:**
- Modify: `src/web/api.ts`
- Create: `src/web/unifiCard.ts` (model half only; the DOM half is Task 8)
- Test: `test/unifiCard.test.js`

**Interfaces:**
- Consumes: `Service`, `ServiceResult`, `ServiceStatusSnapshot` from `./api`; `fmtCount`, `fmtUptime`, `fmtBytes` from `./fmt`.
- Produces:
  - `UnifiMetrics` on `ServiceResult['unifi']`, and `'unifi'` in `ServiceCheckKind`
  - `unifiLamp(r: ServiceResult | undefined) -> 'green' | 'amber' | 'red' | 'auth' | ''`
  - `unifiCardModel(svc, snap) -> UnifiCard`
  - exported constants `CPU_WARN_PCT`, `MEM_WARN_PCT`

- [ ] **Step 1: Extend the web types**

In `src/web/api.ts`:

```ts
export type ServiceCheckKind = 'http' | 'tcp' | 'none' | 'pihole' | 'truenas' | 'unifi';
```

Extend `ServiceCheck`:

```ts
export interface ServiceCheck {
  kind: ServiceCheckKind;
  target?: string;
  insecure?: boolean;
  // truenas only: the account the user-linked API key belongs to. Not a secret.
  username?: string;
  // unifi only: the site to read, and the three-way TLS choice with its pin.
  site?: string;
  tls?: 'verify' | 'pin' | 'insecure';
  fingerprint?: string;
}
```

Add the metrics type beside `TruenasMetrics`:

```ts
export interface UnifiDeviceClass { online: number; total: number; cpuPct: number | null }
export interface UnifiMetrics {
  clientsTotal: number;
  clientsWired: number;
  clientsWireless: number;
  networks: number | null;
  wanState: 'up' | 'down' | 'unknown';
  wanTxBps: number | null;
  wanRxBps: number | null;
  gateway: { name: string; cpuPct: number | null; memPct: number | null; uptimeSec: number | null } | null;
  switches: UnifiDeviceClass;
  aps: UnifiDeviceClass & { clients: number };
  offline: { name: string; model: string }[];
}
```

And add `unifi?: UnifiMetrics;` to `ServiceResult`.

- [ ] **Step 2: Write the failing test**

Create `test/unifiCard.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { unifiCardModel, unifiLamp, fmtBitrate, CPU_WARN_PCT } from '../src/web/unifiCard.ts';

const METRICS = {
  clientsTotal: 96, clientsWired: 61, clientsWireless: 35, networks: 16,
  wanState: 'up', wanTxBps: 940000000, wanRxBps: 45000000,
  gateway: { name: 'Border Gateway', cpuPct: 12, memPct: 48, uptimeSec: 353702 },
  switches: { online: 3, total: 3, cpuPct: 4 },
  aps: { online: 3, total: 3, cpuPct: 9, clients: 35 },
  offline: [],
};
const svc = { id: 'svc-1', name: 'UniFi', url: 'https://unifi.example.com', check: { kind: 'unifi' }, createdAt: '' };
const snapOf = (result) => ({ checkedAt: 'now', results: { 'svc-1': result } });
const model = (result) => unifiCardModel(svc, snapOf(result));

describe('fmtBitrate', () => {
  it('reads bit rates in decimal units, not fmtBytes binary ones', () => {
    expect(fmtBitrate(null)).toBe('—');
    expect(fmtBitrate(940000000)).toBe('940 Mbps');
    expect(fmtBitrate(45000000)).toBe('45 Mbps');
    expect(fmtBitrate(2400000000)).toBe('2.4 Gbps');
    expect(fmtBitrate(512000)).toBe('512 Kbps');
    expect(fmtBitrate(0)).toBe('0 bps');
  });
});

describe('unifiLamp', () => {
  it('is blank before the first sweep', () => {
    expect(unifiLamp(undefined)).toBe('');
  });

  it('is green when everything is online', () => {
    expect(unifiLamp({ state: 'up', unifi: METRICS })).toBe('green');
  });

  it('is auth when the key was rejected, outranking the metrics', () => {
    expect(unifiLamp({ state: 'auth', unifi: METRICS })).toBe('auth');
  });

  it('is red when the controller is unreachable', () => {
    expect(unifiLamp({ state: 'down' })).toBe('red');
  });

  it('is red when the WAN is down', () => {
    expect(unifiLamp({ state: 'up', unifi: { ...METRICS, wanState: 'down' } })).toBe('red');
  });

  it('is amber when a device is offline', () => {
    expect(unifiLamp({ state: 'up', unifi: { ...METRICS, offline: [{ name: 'Barn AP', model: 'UAPA6A6' }] } })).toBe('amber');
  });

  it('is amber when the gateway cpu is pegged', () => {
    expect(unifiLamp({ state: 'up', unifi: { ...METRICS, gateway: { ...METRICS.gateway, cpuPct: CPU_WARN_PCT } } })).toBe('amber');
  });
});

describe('unifiCardModel', () => {
  it('summarizes wan state and the adopted-device count in the chip', () => {
    expect(model({ state: 'up', unifi: METRICS }).chip).toBe('wan up · 7/7 online');
  });

  it('renders the six census cells', () => {
    const cells = model({ state: 'up', unifi: METRICS }).cells;
    expect(cells.map((c) => c.label)).toEqual(['CLIENTS', 'WIRED', 'WIRELESS', 'NETWORKS', 'WAN', 'UPTIME']);
    expect(cells[0].value).toBe('96');
    expect(cells[3].value).toBe('16');
  });

  it('reads the WAN in bits per second, sharing one unit label', () => {
    expect(model({ state: 'up', unifi: METRICS }).cells[4].value).toBe('940/45 Mbps');
  });

  it('dashes an unavailable cell without disturbing the others', () => {
    const cells = model({ state: 'up', unifi: { ...METRICS, networks: null, wanTxBps: null, wanRxBps: null } }).cells;
    expect(cells[3].value).toBe('—');
    expect(cells[4].value).toBe('—');
    expect(cells[0].value).toBe('96');
  });

  it('names the gateway and tallies the other classes', () => {
    const rows = model({ state: 'up', unifi: METRICS }).rows;
    expect(rows).toEqual([
      { label: 'GATEWAY', value: 'Border Gateway · cpu 12% · mem 48%' },
      { label: 'SWITCHES', value: '3/3 online · cpu 4%' },
      { label: 'APS', value: '3/3 online · 35 clients' },
    ]);
  });

  it('omits a device class the site does not have', () => {
    const rows = model({ state: 'up', unifi: { ...METRICS, switches: { online: 0, total: 0, cpuPct: null } } }).rows;
    expect(rows.map((r) => r.label)).toEqual(['GATEWAY', 'APS']);
  });

  it('names offline devices rather than counting them', () => {
    const m = model({ state: 'up', unifi: { ...METRICS, offline: [{ name: 'Barn AP', model: 'UAPA6A6' }] } });
    expect(m.exception).toBe('Barn AP offline');
  });

  it('summarizes when several devices are offline', () => {
    const offline = [{ name: 'A', model: '' }, { name: 'B', model: '' }, { name: 'C', model: '' }];
    expect(model({ state: 'up', unifi: { ...METRICS, offline } }).exception).toBe('A, B, C offline');
  });

  it('shows one error line instead of a grid of dashes when unreachable', () => {
    const m = model({ state: 'down', error: 'connect ECONNREFUSED' });
    expect(m.cells).toEqual([]);
    expect(m.rows).toEqual([]);
    expect(m.error).toBe('connect ECONNREFUSED');
  });

  it('reports an auth failure as its own message', () => {
    const m = model({ state: 'auth', error: 'the controller rejected the API key (HTTP 401)' });
    expect(m.lamp).toBe('auth');
    expect(m.error).toMatch(/rejected the API key/);
  });

  it('is blank before the first sweep', () => {
    const m = unifiCardModel(svc, null);
    expect(m).toEqual({ lamp: '', chip: '', exception: '', cells: [], rows: [], error: '' });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/unifiCard.test.js`
Expected: FAIL — cannot resolve `../src/web/unifiCard`.

- [ ] **Step 4: Implement the model half**

Create `src/web/unifiCard.ts`:

```ts
// The UniFi card: a service tile that reports the network instead of a status
// line. Pure view-model first, DOM second — same split as truenasCard.ts, and
// the reason this lives in its own file rather than growing dashboard.ts.
import type { Service, ServiceResult, ServiceStatusSnapshot, UnifiMetrics } from './api';
import { fmtCount, fmtUptime } from './fmt';

// A controller pegged this hard is worth amber before anything has actually
// failed — the same "surface it early" posture the pool thresholds take.
export const CPU_WARN_PCT = 90;
export const MEM_WARN_PCT = 90;
// Beyond this the exception line would wrap the card; the rest is counted.
export const MAX_NAMED_OFFLINE = 3;

export type UnifiLamp = 'green' | 'amber' | 'red' | 'auth' | '';

export interface UnifiCell { label: string; value: string }
export interface UnifiRow { label: string; value: string }
export interface UnifiCard {
  lamp: UnifiLamp;
  chip: string;
  exception: string;
  cells: UnifiCell[];
  rows: UnifiRow[];
  error: string;
}

const pegged = (v: number | null, limit: number) => v != null && v >= limit;

export function unifiLamp(r: ServiceResult | undefined): UnifiLamp {
  if (!r) return '';
  // A rejected key means every other reading is stale rather than bad, so it
  // outranks the metric-derived colours.
  if (r.state === 'auth') return 'auth';
  const m = r.unifi;
  if (r.state === 'down' || !m) return 'red';
  // The WAN being down is the one metric-derived condition worth red: every
  // device can be online and the site still has no internet.
  if (m.wanState === 'down') return 'red';
  if (m.offline.length > 0) return 'amber';
  if (pegged(m.gateway?.cpuPct ?? null, CPU_WARN_PCT) || pegged(m.gateway?.memPct ?? null, MEM_WARN_PCT)) return 'amber';
  return 'green';
}

function deviceTotals(m: UnifiMetrics): { online: number; total: number } {
  const gw = m.gateway ? 1 : 0;
  const gwOnline = m.gateway && m.wanState !== 'down' ? 1 : 0;
  return {
    online: gwOnline + m.switches.online + m.aps.online,
    total: gw + m.switches.total + m.aps.total,
  };
}

// UniFi reports uplink throughput in bits per second, and a network readout is
// read in Mbps by convention. fmtBytes is the wrong tool twice over: it would
// render 940000000 as "896 MiB" — wrong unit and wrong base — so this lives
// here rather than in fmt.ts, where nothing else wants bit rates.
export function fmtBitrate(bps: number | null): string {
  if (bps == null) return '—';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${Math.round(bps / 1e6)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} Kbps`;
  return `${Math.round(bps)} bps`;
}

function wanValue(m: UnifiMetrics): string {
  if (m.wanTxBps == null && m.wanRxBps == null) return '—';
  const tx = fmtBitrate(m.wanTxBps);
  const rx = fmtBitrate(m.wanRxBps);
  // Share one unit label when both sides agree: "940/45 Mbps" beats repeating it.
  const [txN, txU] = tx.split(' ');
  const [rxN, rxU] = rx.split(' ');
  return txU && txU === rxU ? `${txN}/${rxN} ${txU}` : `${tx} / ${rx}`;
}

function cellsFor(m: UnifiMetrics): UnifiCell[] {
  return [
    { label: 'CLIENTS', value: fmtCount(m.clientsTotal) },
    { label: 'WIRED', value: fmtCount(m.clientsWired) },
    { label: 'WIRELESS', value: fmtCount(m.clientsWireless) },
    { label: 'NETWORKS', value: m.networks == null ? '—' : fmtCount(m.networks) },
    { label: 'WAN', value: wanValue(m) },
    { label: 'UPTIME', value: m.gateway?.uptimeSec == null ? '—' : fmtUptime(m.gateway.uptimeSec) },
  ];
}

// A class the site does not have earns no row: "0/0 online" is noise, not news.
function rowsFor(m: UnifiMetrics): UnifiRow[] {
  const rows: UnifiRow[] = [];
  if (m.gateway) {
    const parts = [m.gateway.name];
    if (m.gateway.cpuPct != null) parts.push(`cpu ${m.gateway.cpuPct}%`);
    if (m.gateway.memPct != null) parts.push(`mem ${m.gateway.memPct}%`);
    rows.push({ label: 'GATEWAY', value: parts.join(' · ') });
  }
  if (m.switches.total > 0) {
    const parts = [`${m.switches.online}/${m.switches.total} online`];
    if (m.switches.cpuPct != null) parts.push(`cpu ${m.switches.cpuPct}%`);
    rows.push({ label: 'SWITCHES', value: parts.join(' · ') });
  }
  if (m.aps.total > 0) {
    rows.push({ label: 'APS', value: `${m.aps.online}/${m.aps.total} online · ${fmtCount(m.aps.clients)} clients` });
  }
  return rows;
}

function exceptionFor(m: UnifiMetrics): string {
  if (m.offline.length === 0) return '';
  const named = m.offline.slice(0, MAX_NAMED_OFFLINE).map((d) => d.name).join(', ');
  const hidden = m.offline.length - MAX_NAMED_OFFLINE;
  return hidden > 0 ? `${named} +${hidden} more offline` : `${named} offline`;
}

// The card's whole layout decision, kept pure: the DOM layer only writes these
// strings into slots. A degraded controller shows one error line rather than a
// grid of dashes — blank readings say less than one sentence does.
export function unifiCardModel(svc: Service, snap: ServiceStatusSnapshot | null): UnifiCard {
  const r = snap?.results[svc.id];
  const blank = { chip: '', exception: '', cells: [] as UnifiCell[], rows: [] as UnifiRow[] };
  if (!r) return { lamp: '', ...blank, error: '' };
  const lamp = unifiLamp(r);
  if (r.state === 'auth') return { lamp, ...blank, error: r.error || 'authentication failed' };
  if (r.state === 'down' || !r.unifi) return { lamp, ...blank, error: r.error || 'unreachable' };

  const m = r.unifi;
  const { online, total } = deviceTotals(m);
  return {
    lamp,
    chip: `wan ${m.wanState} · ${online}/${total} online`,
    exception: exceptionFor(m),
    cells: cellsFor(m),
    rows: rowsFor(m),
    error: '',
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/unifiCard.test.js && npm run typecheck`
Expected: PASS on both.

If the chip assertion fails on the device count, check `deviceTotals`: the fixture has 1 gateway + 3 switches + 3 APs = 7 total and 7 online.

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/unifiCard.ts test/unifiCard.test.js
git commit -m "feat(unifi): web types and the pure card model"
```

---

### Task 8: The card DOM layer, dashboard branch, and styles

**Files:**
- Modify: `src/web/unifiCard.ts`
- Modify: `src/web/dashboard.ts`
- Modify: `src/web/style.css`
- Test: none — see the note below

**Interfaces:**
- Consumes: `unifiCardModel` from Task 7.
- Produces: `buildUnifiCard() -> UnifiCardEls` where `UnifiCardEls` is `{ root: HTMLAnchorElement; update(svc: Service, snap: ServiceStatusSnapshot | null): void }` — the same contract `buildTruenasCard` returns, so `paintTile` treats them identically.

**This task has no unit test, and that is deliberate.** `vitest.config.js` runs `environment: 'node'`; there is no DOM, which is why `buildTruenasCard` and the whole DOM half of `dashboard.ts` are untested today. Inventing a jsdom dependency for one card would be scope creep against an established pattern. The safety net here is three-fold: the pure model is fully covered by Task 7, `npm run typecheck` covers the DOM layer's types, and Task 10 Step 6 validates it against a real controller in the live app.

Follow `buildTruenasCard` exactly — it is the reference implementation for this contract, including the rebuild-only-when-the-count-changes rule that keeps a poll from disturbing hover.

- [ ] **Step 1: Implement the DOM layer**

Append to `src/web/unifiCard.ts`:

```ts
// --- DOM layer -------------------------------------------------------------

export interface UnifiCardEls {
  root: HTMLAnchorElement;
  update(svc: Service, snap: ServiceStatusSnapshot | null): void;
}

// Rebuilt only when the cell or row count changes; otherwise written in place,
// so a poll never disturbs hover or text selection (the tile contract).
export function buildUnifiCard(): UnifiCardEls {
  const div = (cls: string) => {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  };
  const root = document.createElement('a');
  root.className = 'dash-tile dash-tile-wide';
  root.target = '_blank';
  root.rel = 'noopener';
  const lamp = document.createElement('span');
  lamp.className = 'dot';
  const name = div('dash-tile-name');
  const chip = document.createElement('span');
  chip.className = 'dash-card-chip';
  const top = div('dash-tile-top');
  top.append(lamp, name, chip);
  const exception = div('dash-card-warn');
  const grid = div('dash-card-grid');
  const rows = div('dash-unifi-rows');
  const error = div('dash-card-error');
  root.append(top, exception, grid, rows, error);

  function update(svc: Service, snap: ServiceStatusSnapshot | null): void {
    const model = unifiCardModel(svc, snap);
    root.href = svc.url;
    name.textContent = svc.name;
    lamp.className = `dot ${model.lamp}`.trim();
    chip.textContent = model.chip;
    chip.hidden = !model.chip;
    exception.textContent = model.exception;
    exception.hidden = !model.exception;
    error.textContent = model.error;
    error.hidden = !model.error;
    root.title = model.error;

    if (grid.children.length !== model.cells.length) {
      grid.replaceChildren(...model.cells.map(() => {
        const cell = div('dash-card-cell');
        cell.append(div('dash-card-label'), div('dash-card-value'));
        return cell;
      }));
    }
    model.cells.forEach((cell, i) => {
      const el = grid.children[i] as HTMLElement;
      (el.firstChild as HTMLElement).textContent = cell.label;
      (el.lastChild as HTMLElement).textContent = cell.value;
    });
    grid.hidden = model.cells.length === 0;

    if (rows.children.length !== model.rows.length) {
      rows.replaceChildren(...model.rows.map(() => {
        const row = div('dash-unifi-row');
        row.append(div('dash-unifi-label'), div('dash-unifi-value'));
        return row;
      }));
    }
    model.rows.forEach((row, i) => {
      const el = rows.children[i] as HTMLElement;
      (el.firstChild as HTMLElement).textContent = row.label;
      (el.lastChild as HTMLElement).textContent = row.value;
    });
    rows.hidden = model.rows.length === 0;
  }

  return { root, update };
}
```

- [ ] **Step 2: Wire the dashboard**

In `src/web/dashboard.ts`:

Import beside the TrueNAS one:

```ts
import { buildUnifiCard, type UnifiCardEls } from './unifiCard';
```

Add the cache beside `truenasEls` (around line 288):

```ts
  const unifiEls = new Map<string, UnifiCardEls>();
```

Extend `paintTile`'s card branches (around line 429) — update the comment above them to name all three kinds:

```ts
    if (svc.check.kind === 'unifi') {
      let card = unifiEls.get(svc.id);
      if (!card) { card = buildUnifiCard(); unifiEls.set(svc.id, card); }
      card.update(svc, data.serviceStatus);
      return card.root;
    }
```

Add the retirement pass in `repaint` beside the other two (around line 568):

```ts
    for (const [id, card] of unifiEls) {
      if (!tilesSeen.has(id)) { card.root.remove(); unifiEls.delete(id); }
    }
```

And `unifiEls.clear();` in `destroy()`.

- [ ] **Step 3: Add the styles**

In `src/web/style.css`, beside the `.dash-pool-*` rules (around line 1355):

```css
.dash-unifi-rows { display: flex; flex-direction: column; gap: 3px; margin-top: 10px; }
.dash-unifi-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  font-size: 11px; font-variant-numeric: tabular-nums;
}
.dash-unifi-label { color: var(--dim); letter-spacing: 0.08em; }
.dash-unifi-value { color: var(--fg); text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-card-warn { margin-top: 8px; font-size: 12px; color: var(--warn); }
```

Confirm `--warn`, `--dim`, and `--fg` exist in the file's variable block; if a name differs, use the one already defined rather than adding a variable.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run test/unifiCard.test.js test/dashboard.test.js`
Expected: typecheck clean, all tests pass (`dashboard.test.js` must still pass — the new branch must not disturb the existing pure-function tests).

Then build once to prove the bundle compiles and the new CSS is picked up: `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/web/unifiCard.ts src/web/dashboard.ts src/web/style.css
git commit -m "feat(unifi): dashboard card with a per-device-class rollup"
```

---

### Task 9: The settings form

**Files:**
- Modify: `src/web/settingsServices.ts`
- Test: `test/settingsServices.test.js`

**Interfaces:**
- Consumes: `api.testUnifi` from Task 6.
- Produces: `buildServicePayload` accepting `site`, `tls`, and `fingerprint` and emitting them on a `unifi` check.

- [ ] **Step 1: Write the failing test**

Append to `test/settingsServices.test.js`:

```js
describe('buildServicePayload for a unifi tile', () => {
  const base = {
    name: 'UniFi', url: 'https://unifi.example.com', glyph: '', group: 'Network',
    kind: 'unifi', target: '', section: 'infrastructure',
  };

  it('defaults the tls mode to verify and omits an empty site', () => {
    const p = buildServicePayload({ ...base });
    expect(p.check).toEqual({ kind: 'unifi', tls: 'verify' });
  });

  it('carries the site and probe target when set', () => {
    const p = buildServicePayload({ ...base, target: 'https://192.168.1.1', site: 'default' });
    expect(p.check).toEqual({ kind: 'unifi', target: 'https://192.168.1.1', site: 'default', tls: 'verify' });
  });

  it('sends the fingerprint only in pin mode', () => {
    expect(buildServicePayload({ ...base, tls: 'pin', fingerprint: 'AA:BB' }).check)
      .toEqual({ kind: 'unifi', tls: 'pin', fingerprint: 'AA:BB' });
    expect(buildServicePayload({ ...base, tls: 'insecure', fingerprint: 'AA:BB' }).check)
      .toEqual({ kind: 'unifi', tls: 'insecure' });
  });

  it('sends the api key through the shared password field', () => {
    const p = buildServicePayload({ ...base, password: 'the-key' });
    expect(p.password).toBe('the-key');
  });

  it('sends an explicit null when the key is cleared', () => {
    const p = buildServicePayload({ ...base, clearPassword: true });
    expect(p.password).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/settingsServices.test.js`
Expected: FAIL — the `unifi` kind falls into the generic branch, producing `{ kind: 'unifi' }` with no `tls`.

- [ ] **Step 3: Implement `buildServicePayload`**

In `src/web/settingsServices.ts`:

```ts
const CREDENTIAL_KINDS: ServiceCheckKind[] = ['pihole', 'truenas', 'unifi'];
export type UnifiTlsMode = 'verify' | 'pin' | 'insecure';
```

Extend the parameter type with `site?: string; tls?: UnifiTlsMode; fingerprint?: string;` and add the branch before the `truenas` one:

```ts
  } else if (f.kind === 'unifi') {
    const tls: UnifiTlsMode = f.tls ?? 'verify';
    check = {
      kind: 'unifi',
      ...(target ? { target } : {}),
      ...((f.site ?? '').trim() ? { site: (f.site ?? '').trim() } : {}),
      tls,
      // The pin is meaningless outside pin mode, so it is dropped rather than
      // carried along to confuse a later read of the record.
      ...(tls === 'pin' && (f.fingerprint ?? '').trim() ? { fingerprint: (f.fingerprint ?? '').trim() } : {}),
    };
```

- [ ] **Step 4: Implement the form**

Still in `src/web/settingsServices.ts`:

Add the widgets beside the existing ones:

```ts
  const siteIn = el('input', { type: 'text', autocomplete: 'off', placeholder: 'default (leave blank for the first site)' }) as HTMLInputElement;
  const fingerprintIn = el('input', { type: 'text', autocomplete: 'off', placeholder: 'run Test connection to capture it' }) as HTMLInputElement;
  const tlsRadios: Record<UnifiTlsMode, { wrap: HTMLElement; input: HTMLInputElement }> = {
    verify: makeRadio('svc-tls', 'verify', 'Verify certificate', true),
    pin: makeRadio('svc-tls', 'pin', 'Pin this certificate', false),
    insecure: makeRadio('svc-tls', 'insecure', 'Accept any certificate', false),
  };
  const tlsMode = (): UnifiTlsMode =>
    (Object.entries(tlsRadios).find(([, r]) => r.input.checked)?.[0] as UnifiTlsMode) ?? 'verify';
  const siteField = field('Site (optional)', siteIn);
  const tlsModeField = field('TLS', el('div', { class: 'svc-check-radios' }, [tlsRadios.verify.wrap, tlsRadios.pin.wrap, tlsRadios.insecure.wrap]));
  const fingerprintField = field('Certificate fingerprint (SHA-256)', fingerprintIn);
```

Add the radio to the kind strip and the help text:

```ts
    unifi: makeRadio('svc-check', 'unifi', 'UniFi', false),
```

```ts
  const UNIFI_HELP = 'UniFi Network 9.0 or later. Create an API key under Control Plane → Integrations. The key inherits its admin account’s role and there is no read-only key scope, so create it under a View Only admin — this integration only ever reads. The URL must be https.';
```

Extend `syncTarget` so the UniFi fields appear only for that kind, and the credential widgets reword:

```ts
    const isUnifi = k === 'unifi';
    const needsCredential = k === 'pihole' || k === 'truenas' || isUnifi;
    // UniFi gets a three-way TLS choice instead of the shared insecure
    // checkbox, because a controller's self-signed certificate is the norm and
    // the key it guards can write.
    insecureField.hidden = isUnifi;
    siteField.hidden = !isUnifi;
    tlsModeField.hidden = !isUnifi;
    fingerprintField.hidden = !isUnifi || tlsMode() !== 'pin';
    credentialLabel.textContent = isUnifi ? 'API key' : k === 'truenas' ? 'API key' : 'App password';
    credentialHelp.textContent = isUnifi ? UNIFI_HELP : k === 'truenas' ? TRUENAS_HELP : PIHOLE_HELP;
```

and give the target field a UniFi placeholder (`'https://192.168.1.1'`). Register `for (const r of Object.values(tlsRadios)) r.input.addEventListener('change', syncTarget);` so switching to pin reveals the fingerprint field.

Extend the Test handler with a UniFi branch that captures the fingerprint:

```ts
      if (kind() === 'unifi') {
        const res = await api.testUnifi({
          url, apiKey: passwordIn.value, site: siteIn.value.trim(),
          tls: tlsMode(), fingerprint: fingerprintIn.value.trim(), id: editing?.id,
        });
        // Arming pin mode means accepting a fingerprint, so a successful probe
        // fills the field rather than making the operator copy it by hand.
        if (res.fingerprint256 && tlsMode() === 'pin' && !fingerprintIn.value.trim()) {
          fingerprintIn.value = res.fingerprint256;
        }
        const names = (res.sites ?? []).map((s) => s.reference || s.name).join(', ');
        setStatus(res.ok ? `Connected — sites: ${names || 'none reported'}` : (res.error || 'Connection failed'), !res.ok);
        return;
      }
```

Extend `fillForm` to restore the new fields:

```ts
    siteIn.value = svc?.check.site ?? '';
    fingerprintIn.value = svc?.check.fingerprint ?? '';
    const mode = svc?.check.tls ?? 'verify';
    for (const [key, r] of Object.entries(tlsRadios)) r.input.checked = key === mode;
```

Extend the `saveBtn` payload call with `site: siteIn.value, tls: tlsMode(), fingerprint: fingerprintIn.value`.

Finally add `radios.unifi.wrap` to the kind radio strip and `siteField, tlsModeField, fingerprintField` into `credentialGroup` (before the Test button row), and add `unifi` to the list section's rendering if it special-cases kinds.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/settingsServices.test.js && npm run typecheck`
Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add src/web/settingsServices.ts test/settingsServices.test.js
git commit -m "feat(unifi): settings form with site, tls mode, and fingerprint capture"
```

---

### Task 10: TLS pinning integration test, documentation, and the full suite

**Files:**
- Create: `test/unifiApi.integration.test.js`
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new code interfaces.

- [ ] **Step 1: Write the pinning integration test**

Create `test/unifiApi.integration.test.js`, modeled directly on `test/netboxApi.integration.test.js` — read that file first and copy its `opensslOk` guard and certificate-generation block verbatim, changing only the served payloads and the assertions.

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createUnifiClient } from '../src/server/unifiApi.js';
import { tlsProbe } from '../src/server/tlsPin.js';
import { SITES } from './helpers/unifiSamples.js';

// Real TLS, real node:https transport — the pinning path cannot be exercised
// through an injected request function, because the pin is enforced by the
// socket factory rather than by the client's own code.
let opensslOk = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { opensslOk = false; }

describe.runIf(opensslOk)('unifiApi TLS pinning (self-signed controller certificate)', () => {
  let server, baseUrl, fingerprint, sawKey;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-tls-'));
    const p = (n) => path.join(dir, n);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', p('key.pem'), '-out', p('cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=unifi-test'], { stdio: 'ignore' });
    server = https.createServer({ cert: fs.readFileSync(p('cert.pem')), key: fs.readFileSync(p('key.pem')) }, (req, res) => {
      sawKey = req.headers['x-api-key'] || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SITES));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `https://127.0.0.1:${server.address().port}`;
    fingerprint = (await tlsProbe({ host: '127.0.0.1', port: server.address().port })).fingerprint256;
  });

  afterAll(async () => { await new Promise((r) => server.close(r)); });

  it('rejects a self-signed certificate in verify mode', async () => {
    const res = await createUnifiClient({ baseUrl, apiKey: 'k' }).probe();
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('unreachable');
  });

  it('accepts it in insecure mode', async () => {
    const res = await createUnifiClient({ baseUrl, apiKey: 'k', tls: 'insecure' }).probe();
    expect(res.ok).toBe(true);
  });

  it('accepts it in pin mode with the matching fingerprint', async () => {
    sawKey = null;
    const res = await createUnifiClient({ baseUrl, apiKey: 'the-key', tls: 'pin', fingerprint }).probe();
    expect(res.ok).toBe(true);
    expect(sawKey).toBe('the-key');
  });

  it('never sends the key when the pin does not match', async () => {
    sawKey = null;
    const res = await createUnifiClient({
      baseUrl, apiKey: 'the-key', tls: 'pin',
      fingerprint: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    }).probe();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/fingerprint mismatch/i);
    expect(sawKey).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/unifiApi.integration.test.js`
Expected: PASS (or skipped where `openssl` is unavailable).

- [ ] **Step 3: Update the documentation**

`CLAUDE.md` and `AGENTS.md` — keep the two in sync, they are the same document in two voices:

- In the architecture list, add `unifiApi.js` / `unifiRegistry.js` / `unifiMetrics.js` entries beside the Pi-hole and TrueNAS ones, and `unifiCard.ts` beside `truenasCard.ts`.
- Update the `servicesStore.js` bullet's check-kind list to `http|tcp|pihole|truenas|unifi|none`.
- Add a Security-notes bullet:

  > A UniFi tile's API key is sealed the same way (AES-256-GCM in `data/services.json`, key from `cookieSecret`, file `0o600`) and is never returned to the browser (`hasPassword` only). Unlike Pi-hole and TrueNAS it offers three TLS modes rather than a verified/insecure pair — CA-verified, TOFU fingerprint pinning via `tlsPin.js`, or explicit insecure — because a controller's self-signed certificate is the norm and, unlike an app password, **a UniFi local API key inherits its admin account's role and can write to the network**. There is no read-only key scope on the local API, so create the key under a **View Only** admin; the integration is read-only and issues no verb but `GET`. `http:` targets are refused outright. A pinned fingerprint that stops matching is a hard failure — Tmuxifier never re-pins automatically, the same posture it takes toward a changed SSH host key.

`README.md` — add UniFi to the service-tile section with the same operator guidance: UniFi Network 9.0+, key created under Control Plane → Integrations on a View Only admin, https required, and the three TLS modes.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: typecheck clean, every test passing. Fix anything that broke — particularly `test/servicesStore.test.js` and `test/serviceCheck.test.js`, whose existing truenas cases must still pass unchanged.

- [ ] **Step 5: Scrub for PII, then commit**

```bash
git diff --cached
grep -rnE '155\.116|Stuxnet|IPVanish|X-API-KEY: [A-Za-z0-9]{20,}' src/ test/ docs/ *.md
```

Expected: no hits. Then:

```bash
git add -A
git commit -m "docs(unifi): document the unifi check kind, its card, and its key handling"
```

- [ ] **Step 6: Validate on the live app before merging**

Per the repo's shipping rule, a server-side feature is validated from a branch checkout, not by rsyncing `dist/`:

1. Confirm no setup, provision, lifecycle, fleet, or voice-install job is `running` — a restart would interrupt it.
2. Build and restart the service from this branch.
3. Add a real UniFi tile through Settings → Services: https URL, API key, pin mode, Test connection to capture the fingerprint, save.
4. Confirm the card paints on the standby dashboard with real numbers, and that the chip, census cells, and rollup rows all populate.
5. Confirm the unverified endpoints from Task 1 behave as recorded — if `NETWORKS` or `WAN` shows `—`, that is expected and documented, not a bug.
6. Report the result to the user before merging to main.

---

## Probe Findings

**Filled in by Task 1. Do not implement Tasks 3–4 before this section is complete.**

| Endpoint | Status | Envelope keys | Notes |
|---|---|---|---|
| `GET /sites` | | | |
| `GET /sites/{id}/devices` | | | |
| `GET /sites/{id}/devices/{id}/statistics/latest` | | | |
| `GET /sites/{id}/clients` | | | |
| `GET /sites/{id}/networks` | | | |

Device object — confirmed field names:

Client object — confirmed field names:

Statistics object — confirmed field names:
