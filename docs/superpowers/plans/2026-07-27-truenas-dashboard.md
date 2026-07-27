# TrueNAS Dashboard Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `truenas` service check kind that reads ZFS pool usage, system info, and alerts from a TrueNAS over its JSON-RPC 2.0 WebSocket API and renders them as a double-width card on the standby dashboard.

**Architecture:** The Pi-hole integration is the template throughout. A new `truenasApi.js` owns one persistent WebSocket per NAS; a registry keeps one client per service id; the existing 30-second service sweep calls it; a new `truenasCard.ts` turns the metrics into pool rows. The generic half of `piholeRegistry.js` is extracted first so both integrations share it.

**Tech Stack:** Node 20+ ESM, `ws` (promoted from a transitive dependency of `@fastify/websocket` to a direct one), Fastify, TypeScript + Vite for the web client, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-truenas-dashboard-design.md`

## Global Constraints

- Work happens in the worktree `/root/tmuxifier-truenas` on branch `truenas-integration`. All paths below are relative to it.
- ESM everywhere. Server is plain `.js`; web client is `.ts`.
- TDD: the failing test comes first, and tests use real code, never mocks. Factory functions take their dependencies as arguments.
- The repo is public. No real domains, IPs, hostnames, or emails in code, tests, or docs — use `example.com` and RFC1918 addresses like `192.168.1.10`.
- Conventional-commit messages (`feat(truenas): …`, `refactor(services): …`, `docs(truenas): …`).
- The TrueNAS API key is a secret: it is AES-256-GCM sealed at rest via `secretBox`, redacted on read to the boolean `hasPassword`, and must never appear in an error message, a log line, an API response, or a test snapshot.
- **TrueNAS permanently revokes any user-linked API key presented over plain HTTP.** Every path that accepts a TrueNAS URL from a user — `servicesStore.js` validation and the `POST /api/services/truenas/test` route — must reject `http:` before a client is ever constructed.
- Authentication is `auth.login_ex` with `mechanism: "API_KEY_PLAIN"`. Never `auth.login_with_api_key` (removed in TrueNAS v27). Never negotiate a mechanism with the server.
- The integration is read-only. No TrueNAS method that mutates state is ever called.
- Run `npm test` (typecheck + vitest) before every commit.

---

### Task 1: TrueNAS WebSocket client

**Files:**
- Create: `src/server/truenasApi.js`
- Create: `test/helpers/fakeTruenas.js`
- Create: `test/truenasApi.test.js`
- Modify: `package.json` (add `ws` to `dependencies`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createTruenasClient({ baseUrl, username, apiKey, insecure, timeoutMs, makeSocket })` → `{ fetchMetrics(), fetchVersion(), close() }`
  - `fetchMetrics()` → `{ ok: true, metrics: TruenasMetrics }` or `{ ok: false, kind: 'auth'|'unreachable'|'parse', error: string }`
  - `fetchVersion()` → `{ ok: true, version: string|null, hostname: string|null }` or the same failure shape
  - `close()` → `Promise<void>`, calls `auth.logout` then closes the socket
  - `startFakeTruenas(opts)` → `{ baseUrl, counts, stop() }`, plus `DEFAULT_POOLS`, `DEFAULT_INFO`, `DEFAULT_ALERTS`

**Note on scheme:** the client itself accepts `http:`/`ws:` and maps them to `ws://`, so tests can run a plain fake server on loopback. The https-only rule is enforced at the two boundaries where a user-supplied URL enters the system (Task 3 and Task 5), which is where validation belongs. Every internal caller only ever passes an already-validated stored record.

- [ ] **Step 1: Declare `ws` as a direct dependency**

It is already installed at 8.21.0 as a transitive dependency of `@fastify/websocket`. Declaring it stops a future Fastify major from silently removing it.

```bash
npm install --save --save-exact=false ws@^8.21.0
```

Verify it landed in `dependencies` and that the lockfile changed:

```bash
node -p "require('./package.json').dependencies.ws"
```

Expected: `^8.21.0`

- [ ] **Step 2: Write the fake TrueNAS server**

This is a test helper, not a test — it has no assertions and is written before the tests that use it, in the mold of `test/helpers/fakePihole.js`.

Create `test/helpers/fakeTruenas.js`:

```js
import { WebSocketServer } from 'ws';

// A real WebSocket server speaking JSON-RPC 2.0 the way TrueNAS middleware
// does, so the client tests exercise the actual socket path (no mocks — the
// repo convention). Every knob a test needs to steer is an option; counters let
// tests assert how many times the client authenticated or reconnected.
export async function startFakeTruenas({
  username = 'truenas_admin',
  apiKey = '1-testkey',
  responseType = null,        // force an auth response_type other than SUCCESS
  pools = null,
  info = null,
  alerts = null,
  expireAfterCalls = Infinity, // data calls to answer before the session "dies"
  malformed = false,           // reply with an unparseable frame
  dropAfterCalls = Infinity,   // close the socket after this many data calls
} = {}) {
  const counts = { login: 0, logout: 0, pool: 0, info: 0, alert: 0, connections: 0 };
  let dataCalls = 0;

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api/current' });

  wss.on('connection', (socket) => {
    counts.connections++;
    let authed = false;

    const reply = (id, result) => {
      socket.send(malformed ? '{not json' : JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const replyError = (id, message, code = -32000) => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    };

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const { id, method, params } = msg;

      if (method === 'auth.login_ex') {
        counts.login++;
        const p = params?.[0] ?? {};
        if (responseType) return reply(id, { response_type: responseType });
        if (p.mechanism !== 'API_KEY_PLAIN') return reply(id, { response_type: 'AUTH_ERR' });
        if (p.username !== username || p.api_key !== apiKey) return reply(id, { response_type: 'AUTH_ERR' });
        authed = true;
        dataCalls = 0;
        return reply(id, { response_type: 'SUCCESS' });
      }

      if (method === 'auth.logout') {
        counts.logout++;
        authed = false;
        return reply(id, true);
      }

      if (!authed) return replyError(id, 'Not authenticated');
      if (++dataCalls > expireAfterCalls) { authed = false; return replyError(id, 'Not authenticated'); }
      if (dataCalls > dropAfterCalls) { socket.close(); return undefined; }

      if (method === 'pool.query') { counts.pool++; return reply(id, pools ?? DEFAULT_POOLS); }
      if (method === 'system.info') { counts.info++; return reply(id, info ?? DEFAULT_INFO); }
      if (method === 'alert.list') { counts.alert++; return reply(id, alerts ?? DEFAULT_ALERTS); }
      return replyError(id, `Unknown method ${method}`, -32601);
    });
  });

  await new Promise((resolve) => wss.on('listening', resolve));
  const { port } = wss.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    async stop() {
      for (const c of wss.clients) c.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

export const DEFAULT_POOLS = [
  { name: 'tank', size: 21990232555520, allocated: 14953089105920, free: 7037143449600, healthy: true, status: 'ONLINE', scan: null },
  { name: 'fast', size: 1000204886016, allocated: 310063534080, free: 690141351936, healthy: true, status: 'ONLINE', scan: null },
];
export const DEFAULT_INFO = { version: '25.10.5', uptime_seconds: 3563000, hostname: 'nas' };
export const DEFAULT_ALERTS = [
  { level: 'WARNING', dismissed: false, text: 'Scrub is overdue' },
  { level: 'INFO', dismissed: false, text: 'Informational only' },
  { level: 'CRITICAL', dismissed: true, text: 'Already acknowledged' },
];
```

- [ ] **Step 3: Write the failing client tests**

Create `test/truenasApi.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { createTruenasClient } from '../src/server/truenasApi.js';
import { startFakeTruenas, DEFAULT_POOLS, DEFAULT_INFO } from './helpers/fakeTruenas.js';

let nas = null;
let client = null;
afterEach(async () => {
  if (client) await client.close();
  if (nas) await nas.stop();
  client = null;
  nas = null;
});

const connect = (extra = {}) => createTruenasClient({
  baseUrl: nas.baseUrl, username: 'truenas_admin', apiKey: '1-testkey', timeoutMs: 5000, ...extra,
});

test('logs in once and maps pools, alerts, version and uptime', async () => {
  nas = await startFakeTruenas();
  client = connect();

  const res = await client.fetchMetrics();
  expect(res.ok).toBe(true);
  expect(res.metrics.pools).toHaveLength(2);
  expect(res.metrics.pools[0]).toMatchObject({
    name: 'tank', size: DEFAULT_POOLS[0].size, free: DEFAULT_POOLS[0].free, healthy: true, status: 'ONLINE', scanning: false,
  });
  expect(res.metrics.pools[0].usedPct).toBeCloseTo(68.0, 0);
  // INFO is ignored; the CRITICAL one is dismissed, so only the WARNING counts.
  expect(res.metrics.alerts).toEqual({ critical: 0, warning: 1 });
  expect(res.metrics.version).toBe(DEFAULT_INFO.version);
  expect(res.metrics.hostname).toBe('nas');
  expect(res.metrics.uptimeSec).toBe(DEFAULT_INFO.uptime_seconds);
  expect(nas.counts.login).toBe(1);
});

test('a second sweep reuses the socket and does not log in again', async () => {
  nas = await startFakeTruenas();
  client = connect();
  await client.fetchMetrics();
  await client.fetchMetrics();
  expect(nas.counts.login).toBe(1);
  expect(nas.counts.connections).toBe(1);
  expect(nas.counts.pool).toBe(2);
});

test('concurrent first calls share a single login', async () => {
  nas = await startFakeTruenas();
  client = connect();
  await Promise.all([client.fetchMetrics(), client.fetchMetrics(), client.fetchMetrics()]);
  expect(nas.counts.login).toBe(1);
});

test('a wrong key resolves as auth, not as a throw, and never echoes the key', async () => {
  nas = await startFakeTruenas();
  client = connect({ apiKey: '1-wrongkey' });
  const res = await client.fetchMetrics();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('auth');
  expect(res.error).toMatch(/rejected/i);
  expect(res.error).not.toContain('1-wrongkey');
});

test('an expired key and an OTP-required account report distinct reasons', async () => {
  nas = await startFakeTruenas({ responseType: 'EXPIRED' });
  client = connect();
  expect((await client.fetchMetrics()).error).toMatch(/expired/i);
  await client.close();
  await nas.stop();

  nas = await startFakeTruenas({ responseType: 'OTP_REQUIRED' });
  client = connect();
  expect((await client.fetchMetrics()).error).toMatch(/one-time password/i);
});

test('a mid-session expiry re-logs-in exactly once and replays the calls', async () => {
  // Three data calls per sweep: sweep one succeeds, sweep two finds the session dead.
  nas = await startFakeTruenas({ expireAfterCalls: 3 });
  client = connect();
  expect((await client.fetchMetrics()).ok).toBe(true);
  const second = await client.fetchMetrics();
  expect(second.ok).toBe(true);
  expect(nas.counts.login).toBe(2);
});

test('a socket that closed between sweeps reconnects on the next call', async () => {
  nas = await startFakeTruenas();
  client = connect();
  await client.fetchMetrics();
  for (const c of nas.wssClients ?? []) c.close();
  // Force the server side shut without stopping the listener.
  await new Promise((r) => setTimeout(r, 20));
  const again = await client.fetchMetrics();
  expect(again.ok).toBe(true);
});

test('an unreachable NAS resolves as down', async () => {
  client = createTruenasClient({
    baseUrl: 'http://127.0.0.1:1', username: 'truenas_admin', apiKey: '1-testkey', timeoutMs: 2000,
  });
  const res = await client.fetchMetrics();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unreachable');
});

test('an unparseable frame resolves as a failure rather than throwing', async () => {
  nas = await startFakeTruenas({ malformed: true, timeoutMs: 1000 });
  client = connect({ timeoutMs: 1000 });
  const res = await client.fetchMetrics();
  expect(res.ok).toBe(false);
});

test('close logs out so the session is not leaked', async () => {
  nas = await startFakeTruenas();
  client = connect();
  await client.fetchMetrics();
  await client.close();
  await new Promise((r) => setTimeout(r, 20));
  expect(nas.counts.logout).toBe(1);
  client = null;
});

test('fetchVersion reads system.info only', async () => {
  nas = await startFakeTruenas();
  client = connect();
  const res = await client.fetchVersion();
  expect(res).toMatchObject({ ok: true, version: '25.10.5', hostname: 'nas' });
  expect(nas.counts.pool).toBe(0);
});

test('a pool with a scrub running and a null size is reported without dividing by zero', async () => {
  nas = await startFakeTruenas({
    pools: [{ name: 'odd', size: null, allocated: null, free: null, healthy: false, status: 'DEGRADED', scan: { state: 'SCANNING' } }],
  });
  client = connect();
  const { metrics } = await client.fetchMetrics();
  expect(metrics.pools[0]).toMatchObject({ usedPct: null, healthy: false, status: 'DEGRADED', scanning: true });
});
```

The reconnect test above needs the fake to expose its live sockets. Add this to `startFakeTruenas`'s return object in `test/helpers/fakeTruenas.js`:

```js
    get wssClients() { return [...wss.clients]; },
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/truenasApi.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/truenasApi.js"`

- [ ] **Step 5: Write the client**

Create `src/server/truenasApi.js`:

```js
import { WebSocket } from 'ws';

// TrueNAS JSON-RPC 2.0 client over a single persistent WebSocket. TrueNAS
// deprecated the REST API in 25.04 and removed it in 26, so wss://…/api/current
// is the only forward-compatible surface. Authentication is auth.login_ex with
// API_KEY_PLAIN: auth.login_with_api_key is removed in v27, and SCRAM needs
// TrueNAS 26. The mechanism is never negotiated with the server — the advertised
// mechanism list is unauthenticated, so a downgrade would be strippable.
//
// Nothing here throws out to the caller: every failure resolves as a tagged
// result, the same contract serviceCheck.js already holds, so one bad service
// cannot poison a sweep.
//
// The https-only rule lives at the boundaries where a user-supplied URL enters
// (servicesStore.js validation and the /api/services/truenas/test route), not
// here: TrueNAS revokes any API key sent over plain HTTP, and that check belongs
// where user input is validated. This client maps whatever scheme it is handed.
const DEFAULT_TIMEOUT_MS = 10000;

const AUTH_MESSAGES = {
  AUTH_ERR: 'API key rejected — check the key and the username it belongs to',
  EXPIRED: 'API key has expired — mint a new one on the TrueNAS',
  OTP_REQUIRED: 'this account requires a one-time password — use a user-linked API key on an account without OTP',
  REDIRECT: 'TrueNAS redirected authentication to another server',
};

// The middleware's wording for a session that is gone. Matching it is what lets
// one expiry trigger a single re-login instead of surfacing as an outage.
const EXPIRED_RE = /not authenticated|session (?:has )?(?:expired|is invalid)/i;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function socketUrl(baseUrl) {
  const u = new URL(String(baseUrl));
  const scheme = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws' : 'wss';
  return `${scheme}://${u.host}/api/current`;
}

function mapPool(p) {
  const size = num(p?.size);
  const allocated = num(p?.allocated);
  return {
    name: String(p?.name ?? ''),
    size,
    allocated,
    free: num(p?.free),
    // Derived rather than trusted: pool.query's capacity fields are nullable and
    // its fragmentation field is a string, so nothing here assumes a number.
    usedPct: size && size > 0 && allocated != null ? (allocated / size) * 100 : null,
    healthy: p?.healthy === true,
    status: String(p?.status ?? 'UNKNOWN'),
    scanning: p?.scan?.state === 'SCANNING',
  };
}

function mapAlerts(list) {
  const out = { critical: 0, warning: 0 };
  for (const a of Array.isArray(list) ? list : []) {
    // Dismissed means the operator has already seen it and said so.
    if (a?.dismissed === true) continue;
    const level = String(a?.level ?? '').toUpperCase();
    if (level === 'ERROR' || level === 'CRITICAL' || level === 'ALERT' || level === 'EMERGENCY') out.critical++;
    else if (level === 'WARNING' || level === 'NOTICE') out.warning++;
  }
  return out;
}

function mapMetrics({ pools, info, alerts }) {
  return {
    pools: (Array.isArray(pools) ? pools : []).map(mapPool),
    alerts: mapAlerts(alerts),
    version: typeof info?.version === 'string' ? info.version : null,
    hostname: typeof info?.hostname === 'string' ? info.hostname : null,
    uptimeSec: num(info?.uptime_seconds),
  };
}

export function createTruenasClient({
  baseUrl, username = '', apiKey = '', insecure = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  makeSocket = (url, opts) => new WebSocket(url, opts),
}) {
  const url = socketUrl(baseUrl);
  let socket = null;
  let ready = null;
  let nextId = 0;
  const pending = new Map();

  function teardown(err) {
    const dead = socket;
    socket = null;
    ready = null;
    const reason = err || Object.assign(new Error('connection closed'), { kind: 'unreachable' });
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(reason); }
    pending.clear();
    try { dead?.close(); } catch { /* already gone */ }
  }

  function send(method, params = []) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== 1) {
        reject(Object.assign(new Error('not connected'), { kind: 'unreachable' }));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out`), { kind: 'unreachable' }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; } // unreadable frame: the per-call timeout handles it
    if (msg?.id == null) return;                             // server-initiated event, not a reply
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const message = msg.error?.message || 'call failed';
      p.reject(Object.assign(new Error(message), { kind: EXPIRED_RE.test(message) ? 'expired' : 'call' }));
      return;
    }
    p.resolve(msg.result);
  }

  function open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const s = makeSocket(url, insecure ? { rejectUnauthorized: false } : {});
      socket = s;
      const timer = setTimeout(() => {
        const e = Object.assign(new Error('connection timed out'), { kind: 'unreachable' });
        finish(reject, e);
        teardown(e);
      }, timeoutMs);
      s.on('message', onMessage);
      s.on('error', (err) => {
        clearTimeout(timer);
        const e = Object.assign(new Error(err?.message || 'connection failed'), { kind: 'unreachable' });
        finish(reject, e);
        teardown(e);
      });
      s.on('close', () => { clearTimeout(timer); if (settled) teardown(); });
      s.on('open', () => { clearTimeout(timer); finish(resolve, s); });
    });
  }

  // Single-flight: concurrent calls that find no live session await one login.
  async function ensure() {
    if (ready) return ready;
    ready = (async () => {
      await open();
      const res = await send('auth.login_ex', [{
        mechanism: 'API_KEY_PLAIN', username, api_key: apiKey,
      }]);
      const type = res?.response_type;
      if (type !== 'SUCCESS') {
        // The key itself never enters the message.
        throw Object.assign(new Error(AUTH_MESSAGES[type] || 'authentication failed'), { kind: 'auth' });
      }
      return true;
    })();
    try {
      return await ready;
    } catch (e) {
      teardown(e);
      throw e;
    }
  }

  // One retry, never a loop: an expired session re-authenticates once and
  // replays; a second expiry resolves as an auth failure for this tick.
  async function callAll(methods) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await ensure();
      try {
        return await Promise.all(methods.map((m) => send(m)));
      } catch (e) {
        if (e.kind !== 'expired' || attempt === 1) throw e;
        teardown();
      }
    }
    throw Object.assign(new Error(AUTH_MESSAGES.AUTH_ERR), { kind: 'auth' });
  }

  function fail(e) {
    const kind = e?.kind === 'auth' || e?.kind === 'expired' ? 'auth'
      : e?.kind === 'parse' ? 'parse'
        : 'unreachable';
    return { ok: false, kind, error: e?.message || 'request failed' };
  }

  return {
    async fetchMetrics() {
      try {
        const [pools, info, alerts] = await callAll(['pool.query', 'system.info', 'alert.list']);
        return { ok: true, metrics: mapMetrics({ pools, info, alerts }) };
      } catch (e) {
        return fail(e);
      }
    },

    async fetchVersion() {
      try {
        const [info] = await callAll(['system.info']);
        return { ok: true, version: info?.version ?? null, hostname: info?.hostname ?? null };
      } catch (e) {
        return fail(e);
      }
    },

    // Log out rather than abandon the session, mirroring the Pi-hole client:
    // a restart that leaked one session per configured NAS accumulates them.
    async close() {
      if (!socket) { ready = null; return; }
      try { await send('auth.logout'); } catch { /* best-effort: it expires anyway */ }
      teardown();
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/truenasApi.test.js`
Expected: PASS, all 12 tests.

- [ ] **Step 7: Run the whole suite and commit**

```bash
npm test
git add package.json package-lock.json src/server/truenasApi.js test/helpers/fakeTruenas.js test/truenasApi.test.js
git commit -m "feat(truenas): JSON-RPC WebSocket client with a reused session"
```

---

### Task 2: Extract the shared service-client registry

**Files:**
- Create: `src/server/serviceClientRegistry.js`
- Create: `src/server/truenasRegistry.js`
- Create: `test/truenasRegistry.test.js`
- Modify: `src/server/piholeRegistry.js` (rewrite as a thin wrapper)
- Test: `test/piholeRegistry.test.js` must stay green **unmodified** — it is the proof the extraction changed nothing.

**Interfaces:**
- Consumes: `createTruenasClient` from Task 1.
- Produces:
  - `createServiceClientRegistry({ makeClient, fingerprintOf, buildOptions })` → `{ clientFor(service), retain(ids), closeAll() }`
  - `createTruenasRegistry({ store, makeClient, timeoutMs })` → the same three methods
  - `fingerprintOf(service, secret)` returns a string; `buildOptions(service, secret)` returns the client's constructor options.

- [ ] **Step 1: Write the failing registry test**

Create `test/truenasRegistry.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServicesStore } from '../src/server/servicesStore.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { createTruenasRegistry } from '../src/server/truenasRegistry.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-tnreg-'));
  store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
});

function recorder(built) {
  return (opts) => {
    const client = {
      opts, closed: 0,
      async fetchMetrics() { return { ok: true, metrics: {} }; },
      async close() { this.closed++; },
    };
    built.push(client);
    return client;
  };
}

const spec = {
  name: 'nas',
  url: 'https://nas.example.com',
  check: { kind: 'truenas', username: 'truenas_admin' },
  password: '1-testkey',
};

test('one client per service, reused, built from url + username + key + insecure', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const svc = await store.getService((await store.addService(spec)).id);

  const a = await reg.clientFor(svc);
  const b = await reg.clientFor(svc);
  expect(a).toBe(b);
  expect(built).toHaveLength(1);
  expect(built[0].opts).toMatchObject({
    baseUrl: 'https://nas.example.com', username: 'truenas_admin', apiKey: '1-testkey', insecure: false,
  });
});

test('check.target overrides the tile url as the API base, trailing slash stripped', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService({
    ...spec, check: { kind: 'truenas', username: 'truenas_admin', target: 'https://192.168.1.20/' },
  });
  await reg.clientFor(await store.getService(created.id));
  expect(built[0].opts.baseUrl).toBe('https://192.168.1.20');
});

test('a rotated API key rebuilds the client and closes the old session', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService(spec);
  await reg.clientFor(await store.getService(created.id));

  await store.updateService(created.id, { password: '2-newkey' });
  await reg.clientFor(await store.getService(created.id));

  expect(built).toHaveLength(2);
  expect(built[0].closed).toBe(1);
  expect(built[1].opts.apiKey).toBe('2-newkey');
});

test('a changed username rebuilds the client', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService(spec);
  await reg.clientFor(await store.getService(created.id));
  await store.updateService(created.id, { check: { kind: 'truenas', username: 'admin' } });
  await reg.clientFor(await store.getService(created.id));
  expect(built).toHaveLength(2);
  expect(built[1].opts.username).toBe('admin');
});

test('retain closes clients for services that are gone', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const a = await store.addService(spec);
  const b = await store.addService({ ...spec, name: 'nas2' });
  await reg.clientFor(await store.getService(a.id));
  await reg.clientFor(await store.getService(b.id));

  await reg.retain([a.id]);
  expect(built[0].closed).toBe(0);
  expect(built[1].closed).toBe(1);
});

test('a client whose close throws does not break closeAll', async () => {
  const reg = createTruenasRegistry({
    store,
    makeClient: () => ({ async fetchMetrics() { return { ok: true, metrics: {} }; }, async close() { throw new Error('boom'); } }),
  });
  const a = await store.addService(spec);
  await reg.clientFor(await store.getService(a.id));
  await expect(reg.closeAll()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/truenasRegistry.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/truenasRegistry.js"`. (Several tests will also fail on the `truenas` kind, which Task 3 adds; that is expected — this task's completion gate is Step 6 below, and this test file is re-run at the end of Task 3.)

- [ ] **Step 3: Write the generic registry**

Create `src/server/serviceClientRegistry.js`:

```js
import { createHash } from 'node:crypto';

// Sessions have to outlive a single check, so API clients cannot be constructed
// per sweep — this registry owns one per service id. A client is rebuilt only
// when the inputs that define it change, which is what the fingerprint is for:
// the credential is hashed rather than stored, so the plaintext lives only
// inside the client that needs it.
//
// The Pi-hole and TrueNAS registries differ solely in which inputs form that
// fingerprint and how the client is constructed; everything else — the cache,
// retain, closeAll, and the best-effort close that keeps a dead service from
// stalling shutdown — lives here.
export function createServiceClientRegistry({ store, makeClient, buildOptions }) {
  const clients = new Map(); // serviceId -> { fingerprint, client }

  function closeQuietly(client) {
    // Best-effort: a service that is down at shutdown must not stall the exit.
    return Promise.resolve()
      .then(() => client?.close?.())
      .catch(() => {});
  }

  async function clientFor(service) {
    const secret = (await store.getServiceSecret(service.id)) || '';
    const options = buildOptions(service, secret);
    const fingerprint = createHash('sha256').update(JSON.stringify(options)).digest('hex');

    const cached = clients.get(service.id);
    if (cached && cached.fingerprint === fingerprint) return cached.client;
    if (cached) void closeQuietly(cached.client);

    const client = makeClient(options);
    clients.set(service.id, { fingerprint, client });
    return client;
  }

  async function retain(ids) {
    const keep = new Set(ids);
    const closing = [];
    for (const [id, entry] of clients) {
      if (keep.has(id)) continue;
      clients.delete(id);
      closing.push(closeQuietly(entry.client));
    }
    await Promise.all(closing);
  }

  async function closeAll() {
    const entries = [...clients.values()];
    clients.clear();
    await Promise.all(entries.map((e) => closeQuietly(e.client)));
  }

  return { clientFor, retain, closeAll };
}
```

Note the fingerprint is now taken over the whole options object rather than a hand-listed tuple. That is the same guarantee with less to forget: any new client option automatically participates.

- [ ] **Step 4: Rewrite `piholeRegistry.js` as a wrapper**

Replace the entire body of `src/server/piholeRegistry.js`:

```js
import { createPiholeClient } from './piholeApi.js';
import { createServiceClientRegistry } from './serviceClientRegistry.js';

// One Pi-hole v6 client per service id. See serviceClientRegistry.js for the
// caching and lifetime rules; this file only says what a Pi-hole client is
// built from.
export function createPiholeRegistry({ store, makeClient = createPiholeClient, timeoutMs = 8000 }) {
  return createServiceClientRegistry({
    store,
    makeClient,
    buildOptions: (service, secret) => ({
      baseUrl: String(service.check?.target || service.url || '').replace(/\/+$/, ''),
      password: secret,
      insecure: service.check?.insecure === true,
      timeoutMs,
    }),
  });
}
```

- [ ] **Step 5: Write the TrueNAS registry**

Create `src/server/truenasRegistry.js`:

```js
import { createTruenasClient } from './truenasApi.js';
import { createServiceClientRegistry } from './serviceClientRegistry.js';

// One TrueNAS client per service id. See serviceClientRegistry.js for the
// caching and lifetime rules. A TrueNAS client is defined by its API base, the
// username the key belongs to, the key itself, and the TLS mode — change any of
// those and the live socket is closed and replaced.
export function createTruenasRegistry({ store, makeClient = createTruenasClient, timeoutMs = 10000 }) {
  return createServiceClientRegistry({
    store,
    makeClient,
    buildOptions: (service, secret) => ({
      baseUrl: String(service.check?.target || service.url || '').replace(/\/+$/, ''),
      username: String(service.check?.username || ''),
      apiKey: secret,
      insecure: service.check?.insecure === true,
      timeoutMs,
    }),
  });
}
```

- [ ] **Step 6: Verify the Pi-hole tests still pass, unmodified**

Run: `npx vitest run test/piholeRegistry.test.js`
Expected: PASS, all 7 tests, with no edit to that file. If any fail, the extraction changed behaviour — fix the extraction, not the test.

- [ ] **Step 7: Commit**

`test/truenasRegistry.test.js` still fails at this point (it needs the `truenas` kind from Task 3), so commit only the source and leave that test file uncommitted until Task 3.

```bash
npm test -- test/piholeRegistry.test.js
git add src/server/serviceClientRegistry.js src/server/piholeRegistry.js src/server/truenasRegistry.js
git commit -m "refactor(services): extract the shared client registry, add the TrueNAS one"
```

---

### Task 3: Store — the `truenas` kind, https enforcement, sealed key

**Files:**
- Modify: `src/server/servicesStore.js`
- Test: `test/servicesStore.test.js` (add cases)
- Test: `test/truenasRegistry.test.js` (from Task 2 — passes once this lands)

**Interfaces:**
- Consumes: nothing.
- Produces: service records whose `check` is `{ kind: 'truenas', username: string, target?: string, insecure?: true }`, with the API key sealed into `secret` and redacted to `hasPassword`.

- [ ] **Step 1: Write the failing store tests**

Append to `test/servicesStore.test.js` (keep the file's existing imports and `beforeEach`):

```js
const nasSpec = {
  name: 'nas',
  url: 'https://nas.example.com',
  section: 'infrastructure',
  check: { kind: 'truenas', username: 'truenas_admin' },
  password: '1-testkey',
};

test('truenas: a valid tile stores the username in the clear and seals the key', async () => {
  const svc = await store.addService(nasSpec);
  expect(svc.check).toEqual({ kind: 'truenas', username: 'truenas_admin' });
  expect(svc.hasPassword).toBe(true);
  expect(svc.secret).toBeUndefined();
  expect(await store.getServiceSecret(svc.id)).toBe('1-testkey');
});

test('truenas: a plain-http url is refused, naming the key revocation', async () => {
  await expect(store.addService({ ...nasSpec, url: 'http://192.168.1.20' }))
    .rejects.toThrow(/revokes/i);
});

test('truenas: a plain-http check target is refused even when the tile url is https', async () => {
  await expect(store.addService({
    ...nasSpec, check: { kind: 'truenas', username: 'truenas_admin', target: 'http://192.168.1.20' },
  })).rejects.toThrow(/revokes/i);
});

test('truenas: an http tile url is still fine for an http check kind', async () => {
  const svc = await store.addService({ name: 'app', url: 'http://192.168.1.30:8080', check: { kind: 'http' } });
  expect(svc.url).toBe('http://192.168.1.30:8080');
});

test('truenas: a missing username is refused', async () => {
  await expect(store.addService({ ...nasSpec, check: { kind: 'truenas' } }))
    .rejects.toThrow(/username/i);
});

test('truenas: an untouched key survives an unrelated edit, and null clears it', async () => {
  const svc = await store.addService(nasSpec);
  const renamed = await store.updateService(svc.id, { name: 'storage' });
  expect(renamed.hasPassword).toBe(true);
  expect(await store.getServiceSecret(svc.id)).toBe('1-testkey');

  const cleared = await store.updateService(svc.id, { password: null });
  expect(cleared.hasPassword).toBe(false);
  expect(await store.getServiceSecret(svc.id)).toBe(null);
});

test('truenas: switching the tile to another kind drops the stored key', async () => {
  const svc = await store.addService(nasSpec);
  const switched = await store.updateService(svc.id, { check: { kind: 'http' } });
  expect(switched.hasPassword).toBe(false);
  expect(await store.getServiceSecret(svc.id)).toBe(null);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/servicesStore.test.js`
Expected: FAIL — `check.kind must be http, tcp, pihole, or none`

- [ ] **Step 3: Implement the store changes**

In `src/server/servicesStore.js`:

Widen the kind list and add the secret-kind set at the top of the file:

```js
const KINDS = ['http', 'tcp', 'none', 'pihole', 'truenas'];
const SECTIONS = ['services', 'infrastructure'];
// Kinds whose record can carry a sealed credential; changing to any other kind
// drops it.
const SECRET_KINDS = new Set(['pihole', 'truenas']);
const SAFE_TCP_HOST = /^[A-Za-z0-9_.-]+$/; // same family as sshCommand.js SAFE_HOST
```

Add the https assertion next to `assertHttpUrl`:

```js
// TrueNAS permanently revokes any user-linked API key presented over plain HTTP,
// so an http target is refused outright rather than offered as an opt-out: the
// failure mode destroys the operator's credential, not merely the connection.
function assertHttpsUrl(value, label) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (u.protocol === 'http:') {
    throw new Error(`${label} must be https — TrueNAS permanently revokes any API key sent over plain HTTP`);
  }
  if (u.protocol !== 'https:') throw new Error(`${label} must be https`);
}
```

Update the kind error message in `normalizeCheck`:

```js
  if (!KINDS.includes(kind)) throw new Error('check.kind must be http, tcp, pihole, truenas, or none');
```

Add the `truenas` branch to `normalizeCheck`, immediately after the `pihole` branch:

```js
  if (kind === 'truenas') {
    const out = { kind };
    // The JSON-RPC API base. Empty means "use the tile's own url", which is the
    // common case: the link and the API live on the same host.
    if (target) { assertHttpsUrl(target, 'check.target'); out.target = target; }
    // API keys are user-linked from TrueNAS 25.04, and auth.login_ex needs the
    // account name alongside the key. Not a secret — stored in the clear.
    const username = String(merged.username ?? '').trim();
    if (!username || username.length > 64) throw new Error('truenas check requires a username (1-64 characters)');
    out.username = username;
    // Verified TLS is the default; this is the per-service opt-out for a NAS
    // with a self-signed certificate. It never downgrades the scheme.
    if (merged.insecure === true) out.insecure = true;
    return out;
  }
```

Widen the secret rule in `sealPassword`:

```js
  function sealPassword(spec, base) {
    // Only a pihole or truenas check has anywhere to use one; changing kind drops it.
    if (!SECRET_KINDS.has(spec.check?.kind ?? base.check?.kind)) return undefined;
    if (spec.password === undefined) return base.secret;
    if (spec.password === null || String(spec.password) === '') return undefined;
    if (!secretBox) throw new Error('cannot store a credential: no secret box configured');
    return secretBox.seal(String(spec.password));
  }
```

In `normalize`, after `check` is built, enforce https on the tile url when the check will fall back to it. Replace the `out` construction block with:

```js
    const check = normalizeCheck(spec.check, base.check);
    // A truenas check with no explicit target dials the tile's own url, so that
    // url has to clear the same https bar the target does.
    if (check.kind === 'truenas' && !check.target) assertHttpsUrl(url, 'service url');
    const out = {
      id: base.id || `svc-${randomUUID()}`,
      name,
      url,
      section,
      check,
      createdAt: base.createdAt || new Date().toISOString(),
    };
```

- [ ] **Step 4: Run the store and registry tests**

Run: `npx vitest run test/servicesStore.test.js test/truenasRegistry.test.js`
Expected: PASS — both files, including the six Task 2 registry tests that were red.

- [ ] **Step 5: Commit**

```bash
npm test
git add src/server/servicesStore.js test/servicesStore.test.js test/truenasRegistry.test.js
git commit -m "feat(truenas): truenas check kind with an https-only, sealed API key"
```

---

### Task 4: Sweep — the check branch, symmetric metric fields, server wiring

**Files:**
- Modify: `src/server/serviceCheck.js`
- Modify: `src/server/serviceChecker.js`
- Modify: `src/server/index.js`
- Test: `test/serviceCheck.test.js` (add cases; update the Pi-hole ones for the renamed field)

**Interfaces:**
- Consumes: `createTruenasRegistry` (Task 2), the `truenas` kind (Task 3).
- Produces: `ServiceResult` now carries `pihole?: PiholeMetrics` and `truenas?: TruenasMetrics` instead of a single `metrics`. `checkService(service, { piholeRegistry, truenasRegistry })`.

**Why the rename:** `metrics` is a Pi-hole-shaped payload under a generic name. Adding `truenas` beside it would make the asymmetry permanent; renaming to `pihole` makes both integrations look the same and avoids a union type the web client would have to narrow. It is a five-line change guarded by tests. The same reasoning renames `checkService`'s `registry` option to `piholeRegistry`.

- [ ] **Step 1: Write the failing check tests**

Append to `test/serviceCheck.test.js`:

```js
import { checkService } from '../src/server/serviceCheck.js';

// A registry stand-in: real code on both sides, no mocking library.
const registryReturning = (result) => ({ async clientFor() { return { async fetchMetrics() { return result; } }; } });

const nas = { id: 'svc-1', url: 'https://nas.example.com', check: { kind: 'truenas', username: 'truenas_admin' }, hasPassword: true };

test('truenas: a successful read is up and carries the metrics under `truenas`', async () => {
  const metrics = { pools: [], alerts: { critical: 0, warning: 0 }, version: '25.10.5', hostname: 'nas', uptimeSec: 10 };
  const res = await checkService(nas, { truenasRegistry: registryReturning({ ok: true, metrics }) });
  expect(res.state).toBe('up');
  expect(res.truenas).toBe(metrics);
  expect(typeof res.latencyMs).toBe('number');
});

test('truenas: a rejected key is auth, not down', async () => {
  const res = await checkService(nas, {
    truenasRegistry: registryReturning({ ok: false, kind: 'auth', error: 'API key rejected' }),
  });
  expect(res.state).toBe('auth');
  expect(res.error).toMatch(/rejected/);
});

test('truenas: a tile with no stored key says so instead of repeating the API message', async () => {
  const res = await checkService({ ...nas, hasPassword: false }, {
    truenasRegistry: registryReturning({ ok: false, kind: 'auth', error: 'API key rejected' }),
  });
  expect(res.state).toBe('auth');
  expect(res.error).toMatch(/no API key configured/i);
});

test('truenas: an unreachable NAS is down', async () => {
  const res = await checkService(nas, {
    truenasRegistry: registryReturning({ ok: false, kind: 'unreachable', error: 'connection refused' }),
  });
  expect(res.state).toBe('down');
  expect(res.error).toBe('connection refused');
});

test('truenas: a missing registry degrades to down rather than throwing', async () => {
  const res = await checkService(nas, {});
  expect(res.state).toBe('down');
});
```

Then update the existing Pi-hole cases in the same file: every `res.metrics` becomes `res.pihole`, and every `{ registry }` option becomes `{ piholeRegistry }`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/serviceCheck.test.js`
Expected: FAIL — the truenas cases return the http-check result, and the renamed Pi-hole assertions read `undefined`.

- [ ] **Step 3: Implement the check branch and the rename**

In `src/server/serviceCheck.js`, rename the Pi-hole option and payload field, then add the TrueNAS branch:

```js
export async function checkPihole(service, { piholeRegistry } = {}) {
  if (!piholeRegistry) return { state: 'down', error: 'pi-hole client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await piholeRegistry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'pi-hole client setup failed' };
  }
  const res = await client.fetchSummary();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, pihole: res.metrics };
  if (res.kind === 'auth') {
    const error = service.hasPassword === false
      ? 'no app password configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}

// A TrueNAS check reports storage, not just reachability. As with Pi-hole the
// `auth` state is deliberately distinct from `down`: a rotated or expired API
// key means the NAS is answering perfectly well, and painting it red would cry
// wolf. It maps onto the violet `.dot.auth` lamp boxes already use for failed
// SSH credentials.
export async function checkTruenas(service, { truenasRegistry } = {}) {
  if (!truenasRegistry) return { state: 'down', error: 'truenas client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await truenasRegistry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'truenas client setup failed' };
  }
  const res = await client.fetchMetrics();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, truenas: res.metrics };
  if (res.kind === 'auth') {
    const error = service.hasPassword === false
      ? 'no API key configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}

export async function checkService(service, opts = {}) {
  const kind = service?.check?.kind || 'http';
  if (kind === 'none') return null;
  if (kind === 'pihole') return checkPihole(service, opts);
  if (kind === 'truenas') return checkTruenas(service, opts);
  if (kind === 'tcp') return checkTcp(service.check?.target, opts);
  return checkHttp(service.check?.target || service.url, opts);
}
```

In `src/server/serviceChecker.js`, thread the second registry through:

```js
export function createServiceChecker({
  store, check = checkService, piholeRegistry = null, truenasRegistry = null,
  intervalMs = 30000, concurrency = 8,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
```

and inside `pollOnce`:

```js
      await mapWithConcurrency(services, concurrency, async (s) => {
        next[s.id] = await check(s, { piholeRegistry, truenasRegistry });
      });
      // Close sessions belonging to services that have been deleted or switched
      // to another check kind; a leaked session outlives the tile.
      if (piholeRegistry) {
        await piholeRegistry.retain(services.filter((s) => s.check?.kind === 'pihole').map((s) => s.id));
      }
      if (truenasRegistry) {
        await truenasRegistry.retain(services.filter((s) => s.check?.kind === 'truenas').map((s) => s.id));
      }
```

In `src/server/index.js`, add the import beside the Pi-hole one:

```js
import { createTruenasRegistry } from './truenasRegistry.js';
```

construct and wire it:

```js
const piholeRegistry = createPiholeRegistry({ store: servicesStore });
const truenasRegistry = createTruenasRegistry({ store: servicesStore });
const serviceChecker = createServiceChecker({ store: servicesStore, piholeRegistry, truenasRegistry, intervalMs: config.servicePollMs });
```

pass it to `buildServer` by adding `truenasRegistry` to the existing argument object, and add its shutdown flush next to the Pi-hole one:

```js
        // Revoke Pi-hole and TrueNAS sessions rather than leak one per configured
        // service across every restart.
        () => piholeRegistry.closeAll(),
        () => truenasRegistry.closeAll(),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/serviceCheck.test.js`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. If `test/serviceRoutes.test.js` or `test/dashboard.test.js` reference `result.metrics`, update them to `result.pihole` — that is the intended fallout of the rename.

- [ ] **Step 6: Commit**

```bash
git add src/server/serviceCheck.js src/server/serviceChecker.js src/server/index.js test/serviceCheck.test.js
git commit -m "feat(truenas): sweep branch with per-integration metric fields"
```

---

### Task 5: Test-connection route and the web fetch layer

**Files:**
- Modify: `src/server/server.js`
- Modify: `src/web/api.ts`
- Test: `test/serviceRoutes.test.js` (add cases)

**Interfaces:**
- Consumes: `createTruenasClient` (Task 1).
- Produces:
  - `POST /api/services/truenas/test` accepting `{ url, username, apiKey?, insecure?, id? }` → `{ ok: true, version, hostname }` or `{ ok: false, error }`
  - `api.testTruenas(body)` in `api.ts`
  - `ServiceCheckKind` gains `'truenas'`; `ServiceCheck` gains `username?: string`; `ServiceResult` carries `pihole?`/`truenas?`; new `TruenasPool` and `TruenasMetrics` interfaces.

- [ ] **Step 1: Write the failing route tests**

The existing Pi-hole route tests drive a real `startFakePihole` over plain HTTP. That is not
available here — the route refuses `http:` by design — so these tests inject a stub client
through `buildServer`'s `makeTruenasClient` seam instead. Auth uses the file's existing
`headers()` helper (which logs in and returns a `{ cookie }` header object), **not** a
`cookies:` option.

Append to `test/serviceRoutes.test.js`:

First, add the stub client to the `buildServer(...)` call already in `beforeEach`, as one more
key in its options object:

```js
    makeTruenasClient: ({ apiKey }) => ({
      async fetchVersion() {
        return apiKey === '1-secretkey'
          ? { ok: true, version: '25.10.5', hostname: 'nas' }
          : { ok: false, kind: 'auth', error: 'API key rejected' };
      },
      async close() {},
    }),
```

Then append the tests:

```js
test('POST /api/services/truenas/test refuses a plain-http url before building a client', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test', headers: h,
    payload: { url: 'http://192.168.1.20', username: 'truenas_admin', apiKey: '1-k' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().ok).toBe(false);
  expect(res.json().error).toMatch(/revokes/i);
});

test('POST /api/services/truenas/test requires a username', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test', headers: h,
    payload: { url: 'https://nas.example.com', apiKey: '1-k' },
  });
  expect(res.json().ok).toBe(false);
  expect(res.json().error).toMatch(/username/i);
});

test('POST /api/services/truenas/test reports the version and never echoes the key', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test', headers: h,
    payload: { url: 'https://nas.example.com', username: 'truenas_admin', apiKey: '1-secretkey' },
  });
  expect(res.json()).toMatchObject({ ok: true, version: '25.10.5' });
  expect(res.payload).not.toContain('1-secretkey');
});

test('POST /api/services/truenas/test requires authentication', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test',
    payload: { url: 'https://nas.example.com', username: 'u', apiKey: '1-k' },
  });
  expect(res.statusCode).toBe(401);
});
```

The two refusal tests never reach a client, so the stub is only load-bearing for the version test.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/serviceRoutes.test.js`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 3: Add the route**

In `src/server/server.js`, add the import:

```js
import { createTruenasClient } from './truenasApi.js';
```

add `makeTruenasClient = createTruenasClient, truenasRegistry = null,` to `buildServer`'s destructured options alongside `makePiholeClient`, and add the route directly after the Pi-hole test route:

```js
  // Same rationale as the Pi-hole probe: save-and-pray is a poor way to discover
  // that the key belongs to a different account or lacks READONLY_ADMIN. The
  // probe logs out, so it never leaves a session behind.
  app.post('/api/services/truenas/test', { preHandler: requireAuth }, async (req) => {
    const { url, username, apiKey, insecure, id } = req.body || {};
    const base = typeof url === 'string' ? url.trim() : '';
    let u;
    try { u = new URL(base); } catch { return { ok: false, error: 'enter a valid https URL for the TrueNAS' }; }
    // Refused, not merely discouraged: TrueNAS permanently revokes any API key
    // presented over plain HTTP, so a probe would destroy the credential.
    if (u.protocol === 'http:') {
      return { ok: false, error: 'TrueNAS must be reached over https — it permanently revokes any API key sent over plain HTTP' };
    }
    if (u.protocol !== 'https:') return { ok: false, error: 'enter a valid https URL for the TrueNAS' };
    const user = typeof username === 'string' ? username.trim() : '';
    if (!user) return { ok: false, error: 'enter the username the API key belongs to' };
    // A blank key on an existing service means "use the one already stored", so
    // Test works while editing without retyping the secret.
    let key = typeof apiKey === 'string' ? apiKey : '';
    if (!key && id) key = (await servicesStore.getServiceSecret(id)) || '';
    const client = makeTruenasClient({ baseUrl: base, username: user, apiKey: key, insecure: insecure === true });
    try {
      const res = await client.fetchVersion();
      return res.ok ? { ok: true, version: res.version, hostname: res.hostname } : { ok: false, error: res.error };
    } finally {
      await client.close();
    }
  });
```

- [ ] **Step 4: Update the web types and fetch layer**

In `src/web/api.ts`:

```ts
export type ServiceCheckKind = 'http' | 'tcp' | 'none' | 'pihole' | 'truenas';
export type ServiceSection = 'services' | 'infrastructure';
export interface ServiceCheck {
  kind: ServiceCheckKind;
  target?: string;
  insecure?: boolean;
  // truenas only: the account the user-linked API key belongs to. Not a secret.
  username?: string;
}
```

Add the metrics types beside `PiholeMetrics`:

```ts
export interface TruenasPool {
  name: string;
  size: number | null;
  allocated: number | null;
  free: number | null;
  usedPct: number | null;
  healthy: boolean;
  status: string;
  scanning: boolean;
}
export interface TruenasMetrics {
  pools: TruenasPool[];
  alerts: { critical: number; warning: number };
  version: string | null;
  hostname: string | null;
  uptimeSec: number | null;
}
```

Replace the `ServiceResult` interface. One field per integration rather than a
union keeps both card models free of narrowing:

```ts
export interface ServiceResult {
  state: 'up' | 'down' | 'auth';
  latencyMs?: number;
  error?: string;
  pihole?: PiholeMetrics;
  truenas?: TruenasMetrics;
}
```

Add the fetch wrapper next to `testPihole`:

```ts
  async testTruenas(body: { url: string; username: string; apiKey?: string; insecure?: boolean; id?: string }) {
    return j<{ ok: boolean; version?: string | null; hostname?: string | null; error?: string }>(
      await fetch('/api/services/truenas/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  },
```

In `src/web/dashboard.ts`, `piholeCardModel` reads `r.metrics`; change both references to `r.pihole`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test`
Expected: PASS, including `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js src/web/api.ts src/web/dashboard.ts test/serviceRoutes.test.js
git commit -m "feat(truenas): test-connection route and web types"
```

---

### Task 6: The card

**Files:**
- Create: `src/web/fmt.ts`
- Create: `src/web/truenasCard.ts`
- Create: `test/truenasCard.test.js`
- Modify: `src/web/dashboard.ts` (move formatters into `fmt.ts` and re-export; delegate `truenas` tiles)
- Modify: `src/web/style.css`

**Interfaces:**
- Consumes: `Service`, `ServiceStatusSnapshot`, `TruenasMetrics` from `api.ts` (Task 5).
- Produces:
  - `fmt.ts` exports `fmtCount`, `fmtCompact`, `fmtUptime`, `fmtLatency`, `fmtBytes`
  - `truenasCard.ts` exports `POOL_WARN_PCT` (80), `POOL_CRIT_PCT` (90), `MAX_POOL_ROWS` (6), `truenasLamp(result)`, `truenasCardModel(svc, snap)`, and `buildTruenasCard()` (the DOM layer)
  - `TruenasCard` shape: `{ lamp, chip, rows: TruenasRow[], more, footer, error }`; `TruenasRow` is `{ name, used, free, scanning, level }`.

- [ ] **Step 1: Move the formatters into `fmt.ts`**

Create `src/web/fmt.ts` by cutting `fmtLatency`, `fmtCount`, `fmtCompact`, and `fmtUptime` verbatim out of `dashboard.ts` and adding `fmtBytes`:

```ts
// Shared display formatters. They live outside dashboard.ts so a card module can
// use them without importing the dashboard back — dashboard.ts re-exports them,
// so existing importers are unaffected.

export function fmtLatency(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtCount(n: number | null | undefined): string {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
}

// Gravity lists run to millions; a raw digit run is unreadable at tile size.
export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return fmtCount(n);
}

export function fmtUptime(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Binary units, because that is what ZFS reports and what the TrueNAS UI shows.
// One decimal below 100 of a unit, none above, so column width stays stable.
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
```

In `dashboard.ts`, delete those four function bodies and add the re-export near the top, so `test/dashboard.test.js` keeps importing them from `dashboard.ts` unchanged:

```ts
export { fmtLatency, fmtCount, fmtCompact, fmtUptime } from './fmt';
import { fmtCount, fmtCompact, fmtUptime } from './fmt';
```

- [ ] **Step 2: Write the failing card tests**

Create `test/truenasCard.test.js`:

```js
import { test, expect } from 'vitest';
import {
  truenasLamp, truenasCardModel, POOL_WARN_PCT, POOL_CRIT_PCT, MAX_POOL_ROWS,
} from '../src/web/truenasCard.ts';
import { fmtBytes } from '../src/web/fmt.ts';

const pool = (over = {}) => ({
  name: 'tank', size: 1000, allocated: 100, free: 900,
  usedPct: 10, healthy: true, status: 'ONLINE', scanning: false, ...over,
});
const metrics = (over = {}) => ({
  pools: [pool()], alerts: { critical: 0, warning: 0 },
  version: '25.10.5', hostname: 'nas', uptimeSec: 3563000, ...over,
});
const up = (over = {}) => ({ state: 'up', latencyMs: 12, truenas: metrics(over) });
const svc = { id: 'svc-1', name: 'nas', url: 'https://nas.example.com', check: { kind: 'truenas', username: 'truenas_admin' }, createdAt: '' };
const snap = (result) => ({ checkedAt: 'now', results: { 'svc-1': result } });

test('fmtBytes: binary units, one decimal below 100, none above', () => {
  expect(fmtBytes(null)).toBe('—');
  expect(fmtBytes(512)).toBe('512 B');
  expect(fmtBytes(1536)).toBe('1.5 KB');
  expect(fmtBytes(7037143449600)).toBe('6.4 TB');
});

test('lamp: green when every pool is online, under the warn mark, with no alerts', () => {
  expect(truenasLamp(up())).toBe('green');
});

test('lamp: amber for a degraded pool, a warning alert, or a pool at the warn mark', () => {
  expect(truenasLamp(up({ pools: [pool({ healthy: false, status: 'DEGRADED' })] }))).toBe('amber');
  expect(truenasLamp(up({ alerts: { critical: 0, warning: 1 } }))).toBe('amber');
  expect(truenasLamp(up({ pools: [pool({ usedPct: POOL_WARN_PCT })] }))).toBe('amber');
});

test('lamp: red for a faulted pool, a critical alert, or a pool at the crit mark', () => {
  expect(truenasLamp(up({ pools: [pool({ healthy: false, status: 'FAULTED' })] }))).toBe('red');
  expect(truenasLamp(up({ pools: [pool({ healthy: false, status: 'UNAVAIL' })] }))).toBe('red');
  expect(truenasLamp(up({ alerts: { critical: 1, warning: 0 } }))).toBe('red');
  expect(truenasLamp(up({ pools: [pool({ usedPct: POOL_CRIT_PCT })] }))).toBe('red');
});

test('lamp: red outranks amber, and auth outranks both', () => {
  expect(truenasLamp(up({ pools: [pool({ usedPct: 95 })], alerts: { critical: 0, warning: 3 } }))).toBe('red');
  expect(truenasLamp({ state: 'auth', error: 'API key rejected' })).toBe('auth');
});

test('lamp: down is red, and no result at all is blank', () => {
  expect(truenasLamp({ state: 'down', error: 'refused' })).toBe('red');
  expect(truenasLamp(undefined)).toBe('');
});

test('model: one row per pool, used percent and free space formatted', () => {
  const m = truenasCardModel(svc, snap(up({
    pools: [pool({ name: 'tank', usedPct: 68.02, free: 7037143449600 })],
  })));
  expect(m.rows).toEqual([{ name: 'tank', used: '68%', free: '6.4 TB free', scanning: false, level: '' }]);
  expect(m.error).toBe('');
});

test('model: a pool at or over the warn and crit marks is levelled for styling', () => {
  const m = truenasCardModel(svc, snap(up({
    pools: [pool({ name: 'a', usedPct: 85 }), pool({ name: 'b', usedPct: 95 })],
  })));
  expect(m.rows.map((r) => r.level)).toEqual(['warn', 'crit']);
});

test('model: rows are capped and the overflow is counted, not dropped silently', () => {
  const many = Array.from({ length: MAX_POOL_ROWS + 2 }, (_, i) => pool({ name: `p${i}` }));
  const m = truenasCardModel(svc, snap(up({ pools: many })));
  expect(m.rows).toHaveLength(MAX_POOL_ROWS);
  expect(m.more).toBe('+2 more pools');
});

test('model: the chip carries the worst pool state and the active alert count', () => {
  expect(truenasCardModel(svc, snap(up())).chip).toBe('healthy');
  expect(truenasCardModel(svc, snap(up({ alerts: { critical: 1, warning: 1 } }))).chip).toBe('healthy · 2 alerts');
  expect(truenasCardModel(svc, snap(up({
    pools: [pool(), pool({ name: 'b', healthy: false, status: 'DEGRADED' })],
  }))).chip).toBe('degraded');
  expect(truenasCardModel(svc, snap(up({ alerts: { critical: 0, warning: 1 } }))).chip).toBe('healthy · 1 alert');
});

test('model: a scrubbing pool is marked on its own row, not in the chip', () => {
  const m = truenasCardModel(svc, snap(up({ pools: [pool({ scanning: true })] })));
  expect(m.rows[0].scanning).toBe(true);
  expect(m.chip).toBe('healthy');
});

test('model: the footer is version and uptime', () => {
  expect(truenasCardModel(svc, snap(up())).footer).toBe('25.10.5 · up 41d 5h');
});

test('model: a null-capacity pool shows dashes rather than NaN', () => {
  const m = truenasCardModel(svc, snap(up({ pools: [pool({ size: null, allocated: null, free: null, usedPct: null })] })));
  expect(m.rows[0]).toMatchObject({ used: '—', free: '— free' });
});

test('model: a failed check is one error line, not a grid of dashes', () => {
  const auth = truenasCardModel(svc, snap({ state: 'auth', error: 'API key rejected' }));
  expect(auth).toMatchObject({ lamp: 'auth', rows: [], chip: '', footer: '', error: 'API key rejected' });

  const down = truenasCardModel(svc, snap({ state: 'down', error: 'connection refused' }));
  expect(down).toMatchObject({ lamp: 'red', rows: [], error: 'connection refused' });
});

test('model: before the first sweep there is no lamp and no error', () => {
  expect(truenasCardModel(svc, null)).toMatchObject({ lamp: '', rows: [], error: '' });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/truenasCard.test.js`
Expected: FAIL — `Failed to resolve import "../src/web/truenasCard.ts"`

- [ ] **Step 4: Write the card module**

Create `src/web/truenasCard.ts`:

```ts
// The TrueNAS card: a service tile that reports storage instead of a status
// line. Pure view-model first, DOM second — same split as dashboard.ts, and the
// reason this lives in its own file rather than growing dashboard.ts further.
import type { Service, ServiceResult, ServiceStatusSnapshot, TruenasMetrics } from './api';
import { fmtBytes, fmtUptime } from './fmt';

// A pool this full is the thing a storage tile exists to surface, so capacity
// drives the lamp rather than waiting for TrueNAS to raise its own alert.
export const POOL_WARN_PCT = 80;
export const POOL_CRIT_PCT = 90;
// Beyond this the card would push the rest of the dashboard off screen; the
// remainder is counted on a "+N more pools" line, never silently dropped.
export const MAX_POOL_ROWS = 6;

// A pool in one of these states is not serving data. DEGRADED is deliberately
// not here: it is still serving, and collapsing the two into one colour would
// lose the only distinction the lamp exists to make.
const FAULTED = new Set(['FAULTED', 'UNAVAIL', 'REMOVED']);

export type TruenasLamp = 'green' | 'amber' | 'red' | 'auth' | '';

const degraded = (p: { healthy: boolean; status: string }) => !p.healthy || p.status.toUpperCase() !== 'ONLINE';
const faulted = (p: { status: string }) => FAULTED.has(p.status.toUpperCase());
const atLeast = (p: { usedPct: number | null }, pct: number) => p.usedPct != null && p.usedPct >= pct;

export function truenasLamp(r: ServiceResult | undefined): TruenasLamp {
  if (!r) return '';
  // A rejected key means every other reading is stale rather than bad, so it
  // outranks the metric-derived colours.
  if (r.state === 'auth') return 'auth';
  const m = r.truenas;
  if (r.state === 'down' || !m) return 'red';
  if (m.pools.some(faulted) || m.pools.some((p) => atLeast(p, POOL_CRIT_PCT)) || m.alerts.critical > 0) return 'red';
  if (m.pools.some(degraded) || m.pools.some((p) => atLeast(p, POOL_WARN_PCT)) || m.alerts.warning > 0) return 'amber';
  return 'green';
}

export interface TruenasRow {
  name: string;
  used: string;
  free: string;
  scanning: boolean;
  level: '' | 'warn' | 'crit';
}
export interface TruenasCard {
  lamp: TruenasLamp;
  chip: string;
  rows: TruenasRow[];
  more: string;
  footer: string;
  error: string;
}

function chipFor(m: TruenasMetrics): string {
  const worst = m.pools.find(faulted) ?? m.pools.find(degraded);
  const health = worst ? worst.status.toLowerCase() : 'healthy';
  const n = m.alerts.critical + m.alerts.warning;
  return n ? `${health} · ${n} alert${n === 1 ? '' : 's'}` : health;
}

function rowFor(p: TruenasMetrics['pools'][number]): TruenasRow {
  return {
    name: p.name,
    used: p.usedPct == null ? '—' : `${Math.round(p.usedPct)}%`,
    free: `${fmtBytes(p.free)} free`,
    scanning: p.scanning,
    level: atLeast(p, POOL_CRIT_PCT) ? 'crit' : atLeast(p, POOL_WARN_PCT) ? 'warn' : '',
  };
}

// The card's whole layout decision, kept pure: the DOM layer only writes these
// strings into slots. A degraded NAS shows one error line rather than a grid of
// dashes — blank readings say less than one sentence does.
export function truenasCardModel(svc: Service, snap: ServiceStatusSnapshot | null): TruenasCard {
  const r = snap?.results[svc.id];
  const blank = { chip: '', rows: [] as TruenasRow[], more: '', footer: '' };
  if (!r) return { lamp: '', ...blank, error: '' };
  const lamp = truenasLamp(r);
  if (r.state === 'auth') return { lamp, ...blank, error: r.error || 'authentication failed' };
  if (r.state === 'down' || !r.truenas) return { lamp, ...blank, error: r.error || 'unreachable' };

  const m = r.truenas;
  const hidden = Math.max(0, m.pools.length - MAX_POOL_ROWS);
  return {
    lamp,
    chip: chipFor(m),
    rows: m.pools.slice(0, MAX_POOL_ROWS).map(rowFor),
    more: hidden ? `+${hidden} more pool${hidden === 1 ? '' : 's'}` : '',
    footer: `${m.version ?? '—'} · up ${fmtUptime(m.uptimeSec)}`,
    error: '',
  };
}

// --- DOM layer -------------------------------------------------------------

export interface TruenasCardEls {
  root: HTMLAnchorElement;
  update(svc: Service, snap: ServiceStatusSnapshot | null): void;
}

// Rebuilt only when the row count changes; otherwise written in place, so a
// poll never disturbs hover or text selection (the tile contract).
export function buildTruenasCard(): TruenasCardEls {
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
  const pools = div('dash-pool-rows');
  const more = div('dash-pool-more');
  const footer = div('dash-card-footer');
  const error = div('dash-card-error');
  root.append(top, pools, more, footer, error);

  function update(svc: Service, snap: ServiceStatusSnapshot | null): void {
    const model = truenasCardModel(svc, snap);
    root.href = svc.url;
    name.textContent = svc.name;
    lamp.className = `dot ${model.lamp}`.trim();
    chip.textContent = model.chip;
    chip.hidden = !model.chip;
    footer.textContent = model.footer;
    footer.hidden = !model.footer;
    more.textContent = model.more;
    more.hidden = !model.more;
    error.textContent = model.error;
    error.hidden = !model.error;
    root.title = model.error;

    if (pools.children.length !== model.rows.length) {
      pools.replaceChildren(...model.rows.map(() => {
        const row = div('dash-pool-row');
        row.append(div('dash-pool-name'), div('dash-pool-used'), div('dash-pool-free'));
        return row;
      }));
    }
    model.rows.forEach((row, i) => {
      const el = pools.children[i] as HTMLElement;
      el.className = `dash-pool-row${row.level ? ` ${row.level}` : ''}`;
      (el.children[0] as HTMLElement).textContent = row.scanning ? `${row.name} ⟳` : row.name;
      (el.children[0] as HTMLElement).title = row.scanning ? 'scrub or resilver in progress' : '';
      (el.children[1] as HTMLElement).textContent = row.used;
      (el.children[2] as HTMLElement).textContent = row.free;
    });
    pools.hidden = model.rows.length === 0;
  }

  return { root, update };
}
```

- [ ] **Step 5: Run the card tests**

Run: `npx vitest run test/truenasCard.test.js`
Expected: PASS, all 14 tests.

- [ ] **Step 6: Wire the card into the dashboard**

In `src/web/dashboard.ts`, add the import:

```ts
import { buildTruenasCard, type TruenasCardEls } from './truenasCard';
```

add a cache beside the existing `cardEls`:

```ts
  const truenasEls = new Map<string, TruenasCardEls>();
```

and extend `paintTile`'s dispatch:

```ts
  function paintTile(svc: Service): HTMLElement {
    tilesSeen.add(svc.id);
    // A Pi-hole reports numbers and a TrueNAS reports storage, so both render as
    // cards rather than lamps; everything downstream (grouping, ordering,
    // cleanup) treats them as tiles.
    if (svc.check.kind === 'pihole') return paintPiholeCard(svc);
    if (svc.check.kind === 'truenas') {
      let card = truenasEls.get(svc.id);
      if (!card) { card = buildTruenasCard(); truenasEls.set(svc.id, card); }
      card.update(svc, data.serviceStatus);
      return card.root;
    }
    …
```

Prune the new map alongside `cardEls` so a removed NAS does not leak its DOM. In `repaint`, after
the existing `for (const [id, card] of cardEls)` cleanup loop (around `dashboard.ts:576`):

```ts
    for (const [id, card] of truenasEls) {
      if (!tilesSeen.has(id)) { card.root.remove(); truenasEls.delete(id); }
    }
```

and in `destroy()`, beside `cardEls.clear()` (around `dashboard.ts:604`):

```ts
    truenasEls.clear();
```

- [ ] **Step 7: Style the pool rows**

Append to `src/web/style.css`, after the `.dash-card-error` rule:

```css
/* TrueNAS card: one row per pool under the summary chip. Three columns so the
   percentages and free-space figures line up down the card regardless of pool
   name length. */
.dash-pool-rows { display: flex; flex-direction: column; gap: 3px; margin-top: 10px; }
.dash-pool-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: baseline;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.dash-pool-name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-pool-used { color: var(--amber); min-width: 3.5ch; text-align: right; }
.dash-pool-free { color: var(--dim); min-width: 9ch; text-align: right; }
.dash-pool-row.warn .dash-pool-used { color: var(--warn); }
.dash-pool-row.crit .dash-pool-used { color: var(--crit); }
.dash-pool-more { margin-top: 4px; font-size: 11px; color: var(--dim); }
.dash-card-footer { margin-top: 10px; font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 8: Run the suite and commit**

```bash
npm test
git add src/web/fmt.ts src/web/truenasCard.ts src/web/dashboard.ts src/web/style.css test/truenasCard.test.js
git commit -m "feat(truenas): pool-row dashboard card with a capacity-aware lamp"
```

---

### Task 7: Settings form

**Files:**
- Modify: `src/web/settingsServices.ts`
- Test: `test/settingsServices.test.js` (add cases; the file exists and already imports `buildServicePayload`)

**Interfaces:**
- Consumes: `api.testTruenas` and the widened `ServiceCheck` (Task 5).
- Produces: `buildServicePayload` accepts `username` and emits a `truenas` check.

The Pi-hole credential input, its Clear button, the TLS checkbox, and the Test button are **shared** with TrueNAS rather than duplicated — only one kind is active at a time, and the labels and help text swap with the kind. Only the username field is TrueNAS-specific.

- [ ] **Step 1: Write the failing payload tests**

Append to `test/settingsServices.test.js` (it already imports `buildServicePayload` — do not add a
second import):

```js
const base = {
  name: 'nas', url: 'https://nas.example.com', glyph: '', group: 'Storage',
  section: 'infrastructure', target: '',
};

test('truenas: the username rides in the check and the key rides as password', () => {
  const p = buildServicePayload({ ...base, kind: 'truenas', username: 'truenas_admin', password: '1-key' });
  expect(p.check).toEqual({ kind: 'truenas', username: 'truenas_admin' });
  expect(p.password).toBe('1-key');
});

test('truenas: an untouched key sends no password key at all', () => {
  const p = buildServicePayload({ ...base, kind: 'truenas', username: 'truenas_admin', password: '' });
  expect('password' in p).toBe(false);
});

test('truenas: Clear sends an explicit null', () => {
  const p = buildServicePayload({ ...base, kind: 'truenas', username: 'truenas_admin', password: '', clearPassword: true });
  expect(p.password).toBe(null);
});

test('truenas: target and insecure are carried only when set', () => {
  const bare = buildServicePayload({ ...base, kind: 'truenas', username: 'u' });
  expect(bare.check).toEqual({ kind: 'truenas', username: 'u' });
  const full = buildServicePayload({ ...base, kind: 'truenas', username: 'u', target: 'https://192.168.1.20', insecure: true });
  expect(full.check).toEqual({ kind: 'truenas', username: 'u', target: 'https://192.168.1.20', insecure: true });
});

test('an http tile still builds a plain check with no credential fields', () => {
  const p = buildServicePayload({ ...base, kind: 'http', target: '' });
  expect(p.check).toEqual({ kind: 'http' });
  expect('password' in p).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/settingsServices.test.js`
Expected: FAIL — the `truenas` branch does not exist, so `check` comes back as `{ kind: 'truenas', ... }` without the username.

- [ ] **Step 3: Extend `buildServicePayload`**

In `src/web/settingsServices.ts`:

```ts
const CREDENTIAL_KINDS: ServiceCheckKind[] = ['pihole', 'truenas'];

export function buildServicePayload(f: {
  name: string; url: string; glyph: string; group: string;
  kind: ServiceCheckKind; target: string; section: ServiceSection;
  username?: string; password?: string; clearPassword?: boolean; insecure?: boolean;
}): ServiceSpec {
  const target = f.target.trim();
  let check: ServiceCheck;
  if (f.kind === 'pihole') {
    check = { kind: 'pihole', ...(target ? { target } : {}), ...(f.insecure ? { insecure: true } : {}) };
  } else if (f.kind === 'truenas') {
    check = {
      kind: 'truenas',
      username: (f.username ?? '').trim(),
      ...(target ? { target } : {}),
      ...(f.insecure ? { insecure: true } : {}),
    };
  } else if (f.kind === 'none' || !target) {
    check = { kind: f.kind };
  } else {
    check = { kind: f.kind, target };
  }
  const payload: ServiceSpec = {
    name: f.name.trim(),
    url: f.url.trim(),
    glyph: f.glyph.trim() || null,
    group: f.group.trim() || null,
    section: f.section,
    check,
  };
  if (CREDENTIAL_KINDS.includes(f.kind)) {
    if (f.clearPassword) payload.password = null;
    else if (f.password?.trim()) payload.password = f.password;
  }
  return payload;
}
```

The `check` object with an ordered spread puts `username` before `target`; the store normalizes anyway, and the test above compares by value, not key order.

- [ ] **Step 4: Extend the form**

Still in `src/web/settingsServices.ts`, inside `renderServicesSection`:

Add the username input beside the existing inputs:

```ts
  const usernameIn = el('input', { type: 'text', autocomplete: 'off', placeholder: 'truenas_admin' }) as HTMLInputElement;
```

Add the radio:

```ts
    truenas: makeRadio('svc-check', 'truenas', 'TrueNAS', false),
```

Replace the Pi-hole-only credential block with a shared one. The credential input, Clear button, TLS checkbox, and Test button are the same widgets for both kinds; only the labels and help text swap:

```ts
  // Pi-hole v6 and TrueNAS both read their stats over an authenticated API, so
  // these checks need a credential the others don't — and, because they send
  // one, they verify TLS by default rather than tolerating any certificate the
  // way http/tcp do. Only one kind is active at a time, so the widgets are
  // shared and only their wording swaps.
  // field() builds `<label class="field"><span>…</span>control</label>`, so the
  // label span is reused here directly rather than rebuilt, keeping the markup
  // identical to every other field in the form.
  const passwordField = field('App password', el('div', { class: 'pve-inline' }, [passwordIn, clearPwBtn]));
  const credentialLabel = passwordField.querySelector('span') as HTMLElement;
  const usernameField = field('Username the API key belongs to', usernameIn);
  const insecureField = field('TLS', el('label', { class: 'svc-inline-check' }, [insecureIn, ' Allow a self-signed certificate']));
  const credentialHelp = el('p', { class: 'pve-sub' }, ['']);
  const credentialGroup = el('div', {}, [
    credentialHelp, usernameField, passwordField, insecureField,
    el('div', { class: 'pve-inline' }, [testBtn]),
  ]);

  const PIHOLE_HELP = 'Pi-hole v6 only. Create the credential on the Pi-hole under Settings → Web interface / API → Configure app password; an app password works even when two-factor is enabled, the web login password does not.';
  const TRUENAS_HELP = 'TrueNAS 25.04 or later (it speaks JSON-RPC over WebSocket; the old REST API is gone in TrueNAS 26). Create a user-linked key under Credentials → Users → API Keys and give it the READONLY_ADMIN role. The URL must be https — TrueNAS permanently revokes any API key sent over plain HTTP.';
```

Rewrite `syncTarget` to drive all of it:

```ts
  const targetField = field('Probe URL (optional)', targetIn);
  const syncTarget = () => {
    const k = kind();
    const needsCredential = k === 'pihole' || k === 'truenas';
    targetField.hidden = k === 'none';
    credentialGroup.hidden = !needsCredential;
    usernameField.hidden = k !== 'truenas';
    credentialLabel.textContent = k === 'truenas' ? 'API key' : 'App password';
    credentialHelp.textContent = k === 'truenas' ? TRUENAS_HELP : PIHOLE_HELP;
    (targetField.querySelector('span') as HTMLElement).textContent =
      k === 'tcp' ? 'Host:port'
        : needsCredential ? 'API base URL (optional — defaults to the link URL)'
          : 'Probe URL (optional — defaults to the link URL)';
    targetIn.placeholder = k === 'tcp' ? '192.168.1.10:53'
      : k === 'pihole' ? 'https://pihole.example.com'
        : k === 'truenas' ? 'https://nas.example.com'
          : 'https://192.168.1.10:3000/health';
  };
```

Dispatch the Test button by kind:

```ts
  testBtn.addEventListener('click', async () => {
    setStatus('Testing…');
    const url = targetIn.value.trim() || urlIn.value.trim();
    try {
      if (kind() === 'truenas') {
        const res = await api.testTruenas({
          url, username: usernameIn.value.trim(), apiKey: passwordIn.value,
          insecure: insecureIn.checked, id: editing?.id,
        });
        setStatus(res.ok ? `Connected — TrueNAS ${res.version ?? ''}`.trim() : (res.error || 'Connection failed'), !res.ok);
        return;
      }
      const res = await api.testPihole({
        url, password: passwordIn.value, insecure: insecureIn.checked, id: editing?.id,
      });
      setStatus(res.ok ? `Connected — Pi-hole ${res.version ?? 'v6'}` : (res.error || 'Connection failed'), !res.ok);
    } catch (e) {
      setStatus((e as Error).message, true);
    }
  });
```

In `fillForm`, populate the username and make the stored-credential placeholder kind-aware:

```ts
    usernameIn.value = svc?.check.username ?? '';
    clearPassword = false;
    passwordIn.value = '';
    passwordIn.placeholder = svc?.hasPassword ? '•••••••• (leave blank to keep)' : '';
```

In the save handler, pass the username through:

```ts
    const payload = buildServicePayload({
      name: nameIn.value, url: urlIn.value, glyph: glyphIn.value,
      group: groupIn.value, kind: kind(), target: targetIn.value, section: section(),
      username: usernameIn.value, password: passwordIn.value, clearPassword, insecure: insecureIn.checked,
    });
```

Finally add the radio to the strip and swap `piholeGroup` for `credentialGroup` in `content.replaceChildren`:

```ts
      el('div', { class: 'svc-check-radios' }, [radios.http.wrap, radios.tcp.wrap, radios.pihole.wrap, radios.truenas.wrap, radios.none.wrap]),
      targetField,
      credentialGroup,
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test`
Expected: PASS, including `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/web/settingsServices.ts test/settingsServices.test.js
git commit -m "feat(truenas): settings form with username, API key, and a test probe"
```

---

### Task 8: Documentation and end-to-end verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Document the new server modules in `CLAUDE.md`**

In the `Architecture (src/server/)` list, after the `piholeApi.js` / `piholeRegistry.js` entry, add:

```markdown
- `truenasApi.js` / `truenasRegistry.js` — the `truenas` service check. TrueNAS deprecated its
  REST API in 25.04 and removed it in 26, so this is a dependency-light JSON-RPC 2.0 client over
  a single persistent WebSocket to `wss://<host>/api/current` (the one place the repo uses `ws`
  outside Fastify). It authenticates with `auth.login_ex` / `API_KEY_PLAIN` — never
  `auth.login_with_api_key`, removed in v27 — and never negotiates the mechanism, because the
  server's advertised list is unauthenticated and a downgrade would be strippable. One sweep is
  three concurrent calls on the open socket (`pool.query`, `system.info`, `alert.list`),
  correlated by JSON-RPC id; an expired session re-logs-in exactly once and replays. `close()`
  calls `auth.logout`. Read-only: no mutating method is ever called.
- `serviceClientRegistry.js` — the shared per-service API-client cache behind
  `piholeRegistry.js` and `truenasRegistry.js`: one client per service id, rebuilt when the
  options that define it change (the fingerprint is taken over the whole options object, so a
  new option participates automatically), `retain` closing departed services, and a best-effort
  `closeAll` that a dead service cannot stall.
```

Extend the `servicesStore.js` / `serviceCheck.js` / `serviceChecker.js` entry so the check kinds read `http|tcp|pihole|truenas|none`, and add:

```markdown
  A `truenas` tile carries a sealed API key and a plaintext `username` (TrueNAS API keys are
  user-linked from 25.04, and `auth.login_ex` needs the account name), and renders as a
  pool-row card. Its URL must be **https**: TrueNAS permanently revokes any user-linked API key
  presented over plain HTTP, so an `http:` target is refused at validation time rather than
  offered as an opt-out.
```

In the web-client paragraph, add `truenasCard.ts` and `fmt.ts` next to `dashboard.ts`:

```markdown
`fmt.ts` (the shared display formatters — `fmtCount`/`fmtCompact`/`fmtUptime`/`fmtLatency`/
`fmtBytes` — factored out of `dashboard.ts`, which re-exports them, so a card module can use
them without importing the dashboard back), `truenasCard.ts` (the TrueNAS card: the pure model
plus the pure `truenasLamp` severity function whose 80/90 capacity thresholds are named exported
constants, and an in-place-updating DOM layer; it lives outside `dashboard.ts` rather than
growing it further),
```

- [ ] **Step 2: Add the security note**

In `CLAUDE.md`'s Security notes, after the Pi-hole app-password bullet:

```markdown
- A TrueNAS tile's API key is sealed the same way (AES-256-GCM in `data/services.json`, key from
  `cookieSecret`, file `0o600`) and is never returned to the browser (`hasPassword` only). TLS is
  verified by default with an explicit per-service `insecure` opt-out, as with Pi-hole — but
  unlike Pi-hole there is **no** plain-HTTP path at all: TrueNAS permanently revokes any
  user-linked API key presented over insecure transport, so `http:` is rejected by both
  `servicesStore.js` validation and the `POST /api/services/truenas/test` route before a client
  is constructed. Use a **user-linked API key** (Credentials → Users → API Keys) with the
  READONLY_ADMIN role; the integration is read-only and calls no mutating method.
```

- [ ] **Step 3: Mirror both edits into `AGENTS.md`**

`AGENTS.md` is `CLAUDE.md` adapted for general coding agents and is kept in sync. Apply the same three additions.

- [ ] **Step 4: Document it for users in `README.md`**

In the services/dashboard section, next to the Pi-hole tile description:

```markdown
**TrueNAS tiles.** A service whose check kind is *TrueNAS* reads your NAS over its JSON-RPC
WebSocket API and renders one row per ZFS pool — name, used percentage, free space — under a
chip showing the worst pool health and the active alert count, with the TrueNAS version and
uptime beneath. The lamp turns amber when a pool is degraded, an alert is outstanding, or any
pool passes 80% used, and red when a pool is faulted, an alert is critical, or any pool passes
90%.

Onboarding needs three things: the NAS URL, the username your API key belongs to, and the key
itself. Create a user-linked key under **Credentials → Users → API Keys** with the
**READONLY_ADMIN** role. The URL must be `https://` — TrueNAS permanently revokes any API key
presented over plain HTTP, so Tmuxifier refuses an `http://` TrueNAS URL rather than risk your
credential. A self-signed certificate is fine: tick *Allow a self-signed certificate*.

Requires TrueNAS 25.04 or later. The integration is read-only and never changes anything on the
NAS.
```

- [ ] **Step 5: Full verification**

```bash
npm test
npm run build
```

Expected: all tests pass, typecheck clean, `dist/` builds without warnings.

- [ ] **Step 6: PII scrub and commit**

```bash
git add -A
git diff --cached   # review: no real domains, IPs, hostnames, emails, or API keys
git commit -m "docs(truenas): document the truenas check kind, its card, and its key handling"
```

- [ ] **Step 7: Validate on the live app before merging**

Per `CLAUDE.md`, features are validated on the running instance before they merge, and any restart waits until no setup/provision/lifecycle/fleet/voice-install job is `running`.

```bash
npm run build                                   # in /root/tmuxifier-truenas
rsync -a --delete /root/tmuxifier-truenas/dist/ /root/tmuxifier/dist/
sudo systemctl restart tmuxifier
```

The restart is mandatory even though most of this change is client-side: asset routes are
registered per file at boot, so a freshly-swapped hashed bundle otherwise falls through to the
SPA fallback and the app renders blank. Verify by fetching one hashed asset end-to-end and
confirming its real content-type, not just `GET /`.

Then, in the browser: add a TrueNAS tile with the real URL, username, and key; confirm **Test
connection** reports the version; confirm the card paints pool rows within 30 seconds; confirm
an `http://` URL is refused with the revocation message; and confirm a wrong key paints the
violet auth lamp rather than red.

Only after that does the branch merge to main and the release checklist in `CLAUDE.md` run.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: transport and authentication → Task 1;
registry extraction → Task 2; data model, https enforcement, sealed key → Task 3; API surface,
metrics shape, sweep wiring, shutdown revoke → Tasks 1 and 4; error-handling table → Tasks 1 and
4; card and lamp rules → Task 6; settings form and test route → Tasks 5 and 7; testing section →
distributed across every task; docs → Task 8. The spec's "out of scope" list stays out.

**Type consistency.** `fetchMetrics`/`fetchVersion`/`close` are the client's only surface and are
used under those names in Tasks 4 and 5. `TruenasMetrics` field names (`pools`, `alerts`,
`version`, `hostname`, `uptimeSec`) and `TruenasPool` field names (`name`, `size`, `allocated`,
`free`, `usedPct`, `healthy`, `status`, `scanning`) are identical in `truenasApi.js`'s
`mapPool`/`mapMetrics` (Task 1), `api.ts` (Task 5), and `truenasCard.ts` (Task 6). The
`metrics` → `pihole` rename and the `registry` → `piholeRegistry` rename are both confined to
Task 4 and each has a test that fails until it is done.

**Known ordering note.** `test/truenasRegistry.test.js` is written in Task 2 but only goes green
in Task 3, because it exercises the `truenas` check kind the store does not yet accept. Task 2's
commit deliberately excludes it and Task 3's includes it; Task 2's completion gate is the
unmodified `test/piholeRegistry.test.js` still passing, which is the real proof the extraction
was behaviour-preserving.
