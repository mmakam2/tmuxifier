# Pi-hole v6 Service Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a service tile whose check kind is `pihole` from a liveness ping into a double-width dashboard card showing blocking status, queries, blocked share, clients, gravity domains, version, and uptime, read from the Pi-hole v6 REST API with a sealed app password.

**Architecture:** A fourth `check.kind` on the existing service record, not a new subsystem. A new session-caching HTTP client (`piholeApi.js`) and a per-service client registry (`piholeRegistry.js`) plug into the existing `serviceChecker` sweep; the result object grows an optional `metrics` field and an `auth` state. The app password is sealed with the existing `secretBox` and redacted to `hasPassword` on every read. Read-only — no write endpoint is ever called.

**Tech Stack:** Node 20+, ESM, Fastify, `node:http`/`node:https` (no HTTP client dependency), Vitest, TypeScript + Vite for the web client.

## Global Constraints

- ESM everywhere, Node 20+. Server is plain `.js`; web client is `.ts`.
- TDD: the failing test comes first, and tests use **real code, not mocks** — a real `http.createServer` fake Pi-hole, a real temp-dir store.
- Modules are factory functions with dependencies injected as arguments.
- Conventional-commit messages (`feat(pihole): …`, `test(pihole): …`).
- **The repo is public.** No real domains, IPs, hostnames, or emails in any committed file. Use `example.com`, `192.168.1.x`, `127.0.0.1`.
- The app password is a secret: sealed at rest via `secretBox`, never returned by any route, never logged, never placed in an error message.
- Pi-hole v6 only. `admin/api.php` (v5) is out of scope.
- Read-only. `POST /api/dns/blocking` is never called.
- Pi-hole v6 REST endpoints used: `POST /api/auth`, `DELETE /api/auth`, `GET /api/stats/summary`, `GET /api/info/version`, `GET /api/info/system`, `GET /api/dns/blocking`.
- Session auth: `POST /api/auth` with `{"password": "…"}` returns `{session:{valid,totp,sid,validity}}`; later requests carry `X-FTL-SID: <sid>`.

## File Structure

**Create:**
- `src/server/piholeApi.js` — the v6 client: session lifecycle + the four reads. One responsibility: speak Pi-hole.
- `src/server/piholeRegistry.js` — one client per service id, rebuilt when config changes, closed on shutdown. One responsibility: own client lifetimes.
- `test/piholeApi.test.js`, `test/piholeRegistry.test.js`
- `test/helpers/fakePihole.js` — the fake Pi-hole server both server-side test files use.

**Modify:**
- `src/server/servicesStore.js` — `pihole` kind, `insecure` flag, sealed password, redaction, `getServiceSecret`.
- `src/server/serviceCheck.js` — `pihole` branch, `auth` state.
- `src/server/serviceChecker.js` — thread the registry through; retain live clients.
- `src/server/server.js` — `POST /api/services/pihole/test`.
- `src/server/index.js` — construct the registry, pass `secretBox` to the services store, close sessions on shutdown.
- `src/web/api.ts` — types + `testPihole`.
- `src/web/settingsServices.ts` — the Pi-hole radio, password/insecure fields, Test button.
- `src/web/dashboard.ts` — `serviceLamp` gains `auth`; `piholeCardModel` + the card DOM.
- `src/web/style.css` — `.dash-tile-wide`.
- `test/servicesStore.test.js`, `test/serviceCheck.test.js`, `test/serviceChecker.test.js`, `test/serviceRoutes.test.js`, `test/dashboard.test.js`, `test/settingsServices.test.js`
- `CLAUDE.md`, `AGENTS.md`, `README.md`

---

### Task 1: Pi-hole v6 API client

**Files:**
- Create: `src/server/piholeApi.js`
- Create: `test/helpers/fakePihole.js`
- Test: `test/piholeApi.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createPiholeClient({ baseUrl, password, insecure = false, timeoutMs = 8000, now = () => Date.now() })` → `{ fetchSummary(), fetchVersion(), close() }`
  - `fetchSummary()` → `Promise<{ ok: true, metrics: PiholeMetrics } | { ok: false, kind: 'auth' | 'unreachable' | 'parse', error: string }>`
  - `fetchVersion()` → `Promise<{ ok: true, version: string | null } | { ok: false, kind, error }>`
  - `close()` → `Promise<void>` (issues `DELETE /api/auth`, never throws)
  - `PiholeMetrics` = `{ blocking, blockingTimer, queriesTotal, queriesBlocked, percentBlocked, clientsActive, clientsTotal, gravityDomains, versionCore, versionWeb, versionFtl, updateAvailable, uptimeSec }`

- [ ] **Step 1: Write the fake Pi-hole helper**

Create `test/helpers/fakePihole.js`:

```js
import http from 'node:http';

// A real HTTP server speaking the Pi-hole v6 envelope, so the client tests
// exercise the actual request path (no mocks — the repo convention). Every
// knob a test needs to steer is an option; counters let tests assert how many
// times the client authenticated.
export async function startFakePihole({
  password = 'app-pw',
  validity = 1800,
  totp = false,
  expireSidAfter = Infinity, // reject this many uses in, forcing a 401 + re-auth
  summary = null,
  version = null,
  system = null,
  blocking = null,
  delayMs = 0,
  malformed = false,
} = {}) {
  const counts = { auth: 0, delete: 0, summary: 0, version: 0, system: 0, blocking: 0 };
  let issued = 0;
  let uses = 0;
  const sids = new Set();

  const send = (res, status, body) => {
    const payload = malformed ? '{not json' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === '/api/auth' && req.method === 'POST') {
      counts.auth++;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let given = null;
        try { given = JSON.parse(raw).password; } catch { /* malformed body */ }
        if (totp) {
          send(res, 401, { session: { valid: false, totp: true, sid: null, validity: -1, message: 'no password or TOTP token supplied' } });
          return;
        }
        if (given !== password) {
          send(res, 401, { session: { valid: false, totp: false, sid: null, validity: -1, message: 'password incorrect' } });
          return;
        }
        const sid = `sid-${++issued}`;
        sids.add(sid);
        send(res, 200, { session: { valid: true, totp: false, sid, csrf: 'csrf', validity, message: 'password correct' } });
      });
      return;
    }

    if (path === '/api/auth' && req.method === 'DELETE') {
      counts.delete++;
      sids.delete(req.headers['x-ftl-sid']);
      res.writeHead(204).end();
      return;
    }

    const sid = req.headers['x-ftl-sid'];
    if (!sid || !sids.has(sid) || ++uses > expireSidAfter) {
      send(res, 401, { error: { key: 'unauthorized', message: 'Unauthorized', hint: null } });
      return;
    }

    const reply = (key, body) => {
      counts[key]++;
      if (delayMs) setTimeout(() => send(res, 200, body), delayMs);
      else send(res, 200, body);
    };

    if (path === '/api/stats/summary') return reply('summary', summary ?? DEFAULT_SUMMARY);
    if (path === '/api/info/version') return reply('version', version ?? DEFAULT_VERSION);
    if (path === '/api/info/system') return reply('system', system ?? DEFAULT_SYSTEM);
    if (path === '/api/dns/blocking') return reply('blocking', blocking ?? DEFAULT_BLOCKING);
    send(res, 404, { error: { key: 'not_found', message: 'Not found' } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    async stop() { await new Promise((resolve) => server.close(resolve)); },
  };
}

export const DEFAULT_SUMMARY = {
  queries: { total: 48132, blocked: 10780, percent_blocked: 22.396, unique_domains: 3412, forwarded: 30012, cached: 7340 },
  clients: { active: 31, total: 54 },
  gravity: { domains_being_blocked: 1284933, last_update: 1753000000 },
};
export const DEFAULT_VERSION = {
  version: {
    core: { local: { version: 'v6.2.1' }, remote: { version: 'v6.2.1' } },
    web: { local: { version: 'v6.2' }, remote: { version: 'v6.2' } },
    ftl: { local: { version: 'v6.2.3' }, remote: { version: 'v6.2.3' } },
  },
};
export const DEFAULT_SYSTEM = { system: { uptime: 1220400, procs: 210 } };
export const DEFAULT_BLOCKING = { blocking: 'enabled', timer: null };
```

- [ ] **Step 2: Write the failing tests**

Create `test/piholeApi.test.js`:

```js
import { test, expect } from 'vitest';
import { createPiholeClient } from '../src/server/piholeApi.js';
import { startFakePihole, DEFAULT_VERSION } from './helpers/fakePihole.js';

test('fetchSummary authenticates once and maps every metric', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();

  expect(res.ok).toBe(true);
  expect(res.metrics).toEqual({
    blocking: 'enabled',
    blockingTimer: null,
    queriesTotal: 48132,
    queriesBlocked: 10780,
    percentBlocked: 22.396,
    clientsActive: 31,
    clientsTotal: 54,
    gravityDomains: 1284933,
    versionCore: 'v6.2.1',
    versionWeb: 'v6.2',
    versionFtl: 'v6.2.3',
    updateAvailable: false,
    uptimeSec: 1220400,
  });
  expect(pi.counts.auth).toBe(1);
});

test('the session is reused across calls — one auth for three sweeps', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  await client.fetchSummary();
  await client.fetchSummary();
  await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(pi.counts.auth).toBe(1);
});

test('concurrent calls share a single authentication', async () => {
  const pi = await startFakePihole({ delayMs: 5 });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const all = await Promise.all([client.fetchSummary(), client.fetchSummary(), client.fetchSummary()]);
  await client.close();
  await pi.stop();
  expect(all.every((r) => r.ok)).toBe(true);
  expect(pi.counts.auth).toBe(1);
});

test('the session is renewed before its advertised validity expires', async () => {
  const pi = await startFakePihole({ validity: 100 });
  let clock = 1_000_000;
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw', now: () => clock });
  await client.fetchSummary();
  clock += 79 * 1000; // still inside the 80% window
  await client.fetchSummary();
  expect(pi.counts.auth).toBe(1);
  clock += 2 * 1000; // now past it
  await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(pi.counts.auth).toBe(2);
});

test('a 401 mid-flight re-authenticates once and retries', async () => {
  const pi = await startFakePihole({ expireSidAfter: 4 }); // first sweep's 4 reads succeed
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  expect((await client.fetchSummary()).ok).toBe(true);
  const second = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(second.ok).toBe(false); // the fake never stops 401ing, so the retry fails too
  expect(second.kind).toBe('auth');
  expect(pi.counts.auth).toBe(2); // exactly one re-auth, no loop
});

test('a rejected password is an auth failure that never leaks the password', async () => {
  const pi = await startFakePihole({ password: 'right' });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'wrong' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res).toMatchObject({ ok: false, kind: 'auth' });
  expect(res.error).toMatch(/app password/i);
  expect(res.error).not.toContain('wrong');
});

test('a TOTP-protected Pi-hole reports the app-password remedy', async () => {
  const pi = await startFakePihole({ totp: true });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.kind).toBe('auth');
  expect(res.error).toMatch(/app password/i);
});

test('an unreachable host is an unreachable failure, not a throw', async () => {
  const pi = await startFakePihole();
  const { baseUrl } = pi;
  await pi.stop();
  const client = createPiholeClient({ baseUrl, password: 'app-pw', timeoutMs: 500 });
  const res = await client.fetchSummary();
  await client.close();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unreachable');
});

test('malformed JSON is a parse failure, not a throw', async () => {
  const pi = await startFakePihole({ malformed: true });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.ok).toBe(false);
  expect(['parse', 'auth']).toContain(res.kind);
});

test('updateAvailable is set when any component has a newer remote version', async () => {
  const version = JSON.parse(JSON.stringify(DEFAULT_VERSION));
  version.version.ftl.remote.version = 'v6.3.0';
  const pi = await startFakePihole({ version });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.metrics.updateAvailable).toBe(true);
});

test('a disabled Pi-hole reports its re-enable timer', async () => {
  const pi = await startFakePihole({ blocking: { blocking: 'disabled', timer: 1680 } });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.metrics.blocking).toBe('disabled');
  expect(res.metrics.blockingTimer).toBe(1680);
});

test('close revokes the session and is safe to call twice', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  await client.fetchSummary();
  await client.close();
  await client.close();
  await pi.stop();
  expect(pi.counts.delete).toBe(1);
});

test('fetchVersion reads only the version endpoint', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchVersion();
  await client.close();
  await pi.stop();
  expect(res).toEqual({ ok: true, version: 'v6.2.1' });
  expect(pi.counts.summary).toBe(0);
});

test('a trailing slash on the base URL does not double up in the path', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: `${pi.baseUrl}/`, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.ok).toBe(true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/piholeApi.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/piholeApi.js"`.

- [ ] **Step 4: Write the implementation**

Create `src/server/piholeApi.js`:

```js
import http from 'node:http';
import https from 'node:https';

// Pi-hole v6 REST client. v6 replaced admin/api.php with a session-authenticated
// API under /api/: POST /api/auth trades an app password for a sid, which every
// later request carries in X-FTL-SID. Sessions are a capped resource on the
// Pi-hole side, so this client holds exactly one and reuses it — minting one per
// 30-second sweep would exhaust the pool within the hour. Nothing here throws
// out to the caller: every failure resolves as a tagged result, the same
// contract serviceCheck.js already holds so one bad service can't poison a sweep.
const DEFAULT_TIMEOUT_MS = 8000;
// Re-authenticate once the session is this far through its advertised validity,
// so a sweep never races an expiry the Pi-hole already told us about.
const RENEW_AT = 0.8;

const AUTH_REJECTED = 'app password rejected — check Settings → Web interface / API on the Pi-hole';
const AUTH_TOTP = 'this Pi-hole requires a two-factor code — create an app password (Settings → Web interface / API) and use that instead';

function jsonRequest({ url, method = 'GET', headers = {}, body, timeoutMs, insecure }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    // Fixed Content-Length, never chunked — same lesson as netboxApi.js: reverse
    // proxies in front of API servers sometimes reject chunked request bodies.
    const payload = body == null ? null : JSON.stringify(body);
    const reqHeaders = payload == null
      ? headers
      : { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: reqHeaders,
      timeout: timeoutMs,
      // Unlike the plain http/tcp service checks — which always tolerate a bad
      // certificate because they send no credentials — this request carries a
      // password, so TLS is verified unless the operator opted out per service.
      ...(secure ? { rejectUnauthorized: !insecure } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        let parseError = false;
        if (data) {
          try { json = JSON.parse(data); } catch { parseError = true; }
        }
        resolve({ status: res.statusCode, json, parseError });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Pi-hole request timed out')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function mapMetrics({ summary, version, system, blocking }) {
  const q = summary?.queries ?? {};
  const c = summary?.clients ?? {};
  const g = summary?.gravity ?? {};
  const v = version?.version ?? {};
  const local = (k) => v?.[k]?.local?.version ?? null;
  const remote = (k) => v?.[k]?.remote?.version ?? null;
  return {
    blocking: blocking?.blocking === 'disabled' ? 'disabled' : 'enabled',
    blockingTimer: num(blocking?.timer),
    queriesTotal: num(q.total),
    queriesBlocked: num(q.blocked),
    percentBlocked: num(q.percent_blocked),
    clientsActive: num(c.active),
    clientsTotal: num(c.total),
    gravityDomains: num(g.domains_being_blocked),
    versionCore: local('core'),
    versionWeb: local('web'),
    versionFtl: local('ftl'),
    updateAvailable: ['core', 'web', 'ftl'].some((k) => local(k) && remote(k) && local(k) !== remote(k)),
    uptimeSec: num(system?.system?.uptime),
  };
}

export function createPiholeClient({
  baseUrl, password = '', insecure = false,
  timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now(), request = jsonRequest,
}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let sid = null;
  let renewAt = 0;
  let authing = null;

  async function authenticate() {
    const res = await request({ url: `${base}/api/auth`, method: 'POST', body: { password }, timeoutMs, insecure });
    const s = res.json?.session;
    if (res.status === 200 && s?.valid && s.sid) {
      sid = s.sid;
      const validity = Number(s.validity) > 0 ? Number(s.validity) : 1800;
      renewAt = now() + validity * RENEW_AT * 1000;
      return sid;
    }
    sid = null;
    renewAt = 0;
    // The password itself never enters the message.
    throw Object.assign(new Error(s?.totp === true ? AUTH_TOTP : AUTH_REJECTED), { kind: 'auth' });
  }

  // Single-flight: concurrent reads that find no live session await one POST.
  function session() {
    if (sid && now() < renewAt) return Promise.resolve(sid);
    if (!authing) authing = authenticate().finally(() => { authing = null; });
    return authing;
  }

  async function get(path, currentSid) {
    const res = await request({ url: `${base}${path}`, headers: { 'X-FTL-SID': currentSid, Accept: 'application/json' }, timeoutMs, insecure });
    if (res.status === 401) throw Object.assign(new Error('session expired'), { kind: 'expired' });
    if (res.parseError) throw Object.assign(new Error(`unreadable response from ${path}`), { kind: 'parse' });
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`http ${res.status} from ${path}`), { kind: 'unreachable' });
    return res.json;
  }

  // One retry, never a loop: an expired session re-authenticates once and
  // replays the reads; a second expiry resolves as an auth failure for this tick.
  async function readAll(paths) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const currentSid = await session();
      try {
        return await Promise.all(paths.map((p) => get(p, currentSid)));
      } catch (e) {
        if (e.kind !== 'expired' || attempt === 1) throw e;
        sid = null;
        renewAt = 0;
      }
    }
    throw Object.assign(new Error(AUTH_REJECTED), { kind: 'auth' });
  }

  function fail(e) {
    const kind = e?.kind === 'auth' ? 'auth'
      : e?.kind === 'expired' ? 'auth'
        : e?.kind === 'parse' ? 'parse'
          : 'unreachable';
    return { ok: false, kind, error: kind === 'auth' && e?.kind === 'expired' ? AUTH_REJECTED : (e?.message || 'request failed') };
  }

  return {
    async fetchSummary() {
      try {
        const [summary, version, system, blocking] = await readAll([
          '/api/stats/summary', '/api/info/version', '/api/info/system', '/api/dns/blocking',
        ]);
        return { ok: true, metrics: mapMetrics({ summary, version, system, blocking }) };
      } catch (e) {
        return fail(e);
      }
    },

    async fetchVersion() {
      try {
        const [version] = await readAll(['/api/info/version']);
        return { ok: true, version: version?.version?.core?.local?.version ?? null };
      } catch (e) {
        return fail(e);
      }
    },

    // Revoke rather than abandon: v6 caps concurrent sessions, so a restart that
    // leaked one per configured Pi-hole would eventually lock the operator out
    // of their own web UI.
    async close() {
      const current = sid;
      sid = null;
      renewAt = 0;
      if (!current) return;
      try {
        await request({ url: `${base}/api/auth`, method: 'DELETE', headers: { 'X-FTL-SID': current }, timeoutMs, insecure });
      } catch { /* best-effort: the session expires on its own */ }
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/piholeApi.test.js`
Expected: PASS — 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/piholeApi.js test/piholeApi.test.js test/helpers/fakePihole.js
git commit -m "feat(pihole): Pi-hole v6 REST client with a reused session"
```

---

### Task 2: Sealed app password and the `pihole` check kind in the services store

**Files:**
- Modify: `src/server/servicesStore.js`
- Test: `test/servicesStore.test.js`

**Interfaces:**
- Consumes: `createSecretBox(cookieSecret)` from `src/server/secretBox.js` — `{ seal(plaintext) → string, open(sealed) → string, isSealed(v) → boolean }`.
- Produces:
  - `createServicesStore({ dataDir, secretBox = null })`
  - `listServices()` / `getService(id)` return records redacted to `hasPassword: boolean`, never `secret`.
  - `getServiceSecret(id)` → `Promise<string | null>` — the decrypted app password; the only decrypting path.
  - Check shape `{ kind: 'pihole', target?: string, insecure?: true }`.
  - Write specs accept `password`: absent keeps, `null`/`''` clears, a string replaces.

- [ ] **Step 1: Write the failing tests**

Append to `test/servicesStore.test.js`:

```js
import { createSecretBox } from '../src/server/secretBox.js';

const piSpec = {
  name: 'pihole', url: 'https://pihole.example.com', group: 'DNS Filtering',
  check: { kind: 'pihole' }, password: 'app-pw',
};

test('pihole check accepts an optional target and insecure flag', async () => {
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const a = await s.addService(piSpec);
  expect(a.check).toEqual({ kind: 'pihole' });
  const b = await s.addService({ ...piSpec, name: 'pihole2', check: { kind: 'pihole', target: 'http://192.168.1.5/', insecure: true } });
  expect(b.check).toEqual({ kind: 'pihole', target: 'http://192.168.1.5/', insecure: true });
  await expect(s.addService({ ...piSpec, name: 'bad', check: { kind: 'pihole', target: 'nonsense' } })).rejects.toThrow(/URL|http/);
});

test('the app password is sealed on disk, redacted on read, and openable by the store', async () => {
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const svc = await s.addService(piSpec);
  expect(svc.hasPassword).toBe(true);
  expect(svc.secret).toBeUndefined();
  expect(JSON.stringify(await s.listServices())).not.toContain('app-pw');

  const raw = await fs.readFile(path.join(dir, 'services.json'), 'utf8');
  expect(raw).not.toContain('app-pw');
  expect(raw).toContain('pvebox.v1');

  expect(await s.getServiceSecret(svc.id)).toBe('app-pw');
});

test('updating without a password keeps it; null clears it', async () => {
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const svc = await s.addService(piSpec);

  const renamed = await s.updateService(svc.id, { name: 'pihole-renamed' });
  expect(renamed.hasPassword).toBe(true);
  expect(await s.getServiceSecret(svc.id)).toBe('app-pw');

  const rotated = await s.updateService(svc.id, { password: 'new-pw' });
  expect(rotated.hasPassword).toBe(true);
  expect(await s.getServiceSecret(svc.id)).toBe('new-pw');

  const cleared = await s.updateService(svc.id, { password: null });
  expect(cleared.hasPassword).toBe(false);
  expect(await s.getServiceSecret(svc.id)).toBe(null);
});

test('switching a service away from the pihole kind drops the stored password', async () => {
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const svc = await s.addService(piSpec);
  const plain = await s.updateService(svc.id, { check: { kind: 'http' } });
  expect(plain.hasPassword).toBe(false);
  expect(await s.getServiceSecret(svc.id)).toBe(null);
  expect(await fs.readFile(path.join(dir, 'services.json'), 'utf8')).not.toContain('pvebox.v1');
});

test('a legacy record with no secret loads and reports hasPassword false', async () => {
  await fs.writeFile(path.join(dir, 'services.json'), JSON.stringify({
    version: 1,
    services: [{ id: 'svc-legacy', name: 'Grafana', url: 'https://192.168.1.20:3000/', section: 'services', check: { kind: 'http' }, createdAt: '2026-01-01T00:00:00.000Z' }],
  }));
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const [svc] = await s.listServices();
  expect(svc.hasPassword).toBe(false);
  expect(await s.getServiceSecret('svc-legacy')).toBe(null);
});

test('a password without a configured secretBox is refused rather than stored in the clear', async () => {
  const s = createServicesStore({ dataDir: dir });
  await expect(s.addService(piSpec)).rejects.toThrow(/secret/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/servicesStore.test.js`
Expected: FAIL — `check.kind must be http, tcp, or none`, and `s.getServiceSecret is not a function`.

- [ ] **Step 3: Implement the store changes**

In `src/server/servicesStore.js`, replace the `KINDS` constant:

```js
const KINDS = ['http', 'tcp', 'none', 'pihole'];
```

Add a `pihole` branch at the end of `normalizeCheck`, immediately before the `kind === 'none'` handling (i.e. after the `tcp` block):

```js
  if (kind === 'pihole') {
    // The Pi-hole v6 API base. Empty means "use the tile's own url", which is
    // the common case: the link and the API live on the same host.
    const out = { kind };
    if (target) { assertHttpUrl(target, 'check.target'); out.target = target; }
    // Verified TLS is the default; this is the per-service opt-out, because
    // unlike the http/tcp checks this one sends a password.
    if (merged.insecure === true) out.insecure = true;
    return out;
  }
```

Update the error message in the same function:

```js
  if (!KINDS.includes(kind)) throw new Error('check.kind must be http, tcp, pihole, or none');
```

Change the factory signature and add the secret handling:

```js
export function createServicesStore({ dataDir, secretBox = null }) {
```

Inside the factory, after `writeAll`, add:

```js
  // The app password is the only secret a service record can hold. It is sealed
  // before it touches disk (AES-256-GCM, key from cookieSecret) and redacted on
  // every read — getServiceSecret is the sole decrypting path, mirroring
  // netboxStore.getSettings({ withSecret: true }).
  function redact(svc) {
    const { secret, ...rest } = svc;
    return { ...rest, hasPassword: !!secret };
  }

  function sealPassword(spec, base) {
    // Only a pihole check has anywhere to use one; changing kind drops it.
    if ((spec.check?.kind ?? base.check?.kind) !== 'pihole') return undefined;
    if (spec.password === undefined) return base.secret;
    if (spec.password === null || String(spec.password) === '') return undefined;
    if (!secretBox) throw new Error('cannot store an app password: no secret box configured');
    return secretBox.seal(String(spec.password));
  }
```

In `normalize`, after the `group` handling and before `return out`:

```js
    const secret = sealPassword(spec, base);
    if (secret !== undefined) out.secret = secret;
```

Finally, redact on the way out and add the decrypting read. Replace the returned object's read/write methods:

```js
    async listServices() { return (await readAll()).map(redact); },
    async getService(id) {
      const svc = (await readAll()).find((s) => s.id === id);
      return svc ? redact(svc) : undefined;
    },
    async getServiceSecret(id) {
      const svc = (await readAll()).find((s) => s.id === id);
      if (!svc?.secret || !secretBox) return null;
      try { return secretBox.open(svc.secret); } catch { return null; }
    },
    async addService(spec) {
      return serialize(async () => {
        const services = await readAll();
        const svc = normalize(spec || {});
        services.push(svc);
        await writeAll(services);
        return redact(svc);
      });
    },
    async updateService(id, patch) {
      return serialize(async () => {
        const services = await readAll();
        const index = services.findIndex((s) => s.id === id);
        if (index === -1) throw new Error('service not found');
        services[index] = normalize(patch || {}, services[index]);
        await writeAll(services);
        return redact(services[index]);
      });
    },
```

Also make the file owner-only, since it can now hold a sealed secret — change `writeAll`:

```js
  async function writeAll(services) {
    await writeJson(file, { version: 1, services }, { mode: 0o600 });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/servicesStore.test.js`
Expected: PASS — the new tests plus every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add src/server/servicesStore.js test/servicesStore.test.js
git commit -m "feat(pihole): pihole check kind and a sealed app password in the services store"
```

---

### Task 3: Per-service client registry

**Files:**
- Create: `src/server/piholeRegistry.js`
- Test: `test/piholeRegistry.test.js`

**Interfaces:**
- Consumes: `createPiholeClient` (Task 1); `store.getServiceSecret(id)` (Task 2).
- Produces: `createPiholeRegistry({ store, makeClient = createPiholeClient, timeoutMs = 8000 })` → `{ clientFor(service), retain(ids), closeAll() }`
  - `clientFor(service)` → `Promise<client>` — the cached client, rebuilt when base URL, password, or `insecure` changed.
  - `retain(ids)` → `Promise<void>` — closes and forgets clients whose service id is not in `ids`.
  - `closeAll()` → `Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/piholeRegistry.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServicesStore } from '../src/server/servicesStore.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { createPiholeRegistry } from '../src/server/piholeRegistry.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pireg-'));
  store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
});

// A stand-in for createPiholeClient that records how it was built and closed.
function recorder(built) {
  return (opts) => {
    const client = { opts, closed: 0, async fetchSummary() { return { ok: true, metrics: {} }; }, async close() { this.closed++; } };
    built.push(client);
    return client;
  };
}

const spec = { name: 'pihole', url: 'https://pihole.example.com', check: { kind: 'pihole' }, password: 'app-pw' };

test('one client per service, reused across sweeps, built from url + password + insecure', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const svc = await store.getService((await store.addService(spec)).id);

  const a = await reg.clientFor(svc);
  const b = await reg.clientFor(svc);
  expect(a).toBe(b);
  expect(built).toHaveLength(1);
  expect(built[0].opts).toMatchObject({ baseUrl: 'https://pihole.example.com', password: 'app-pw', insecure: false });
});

test('check.target overrides the tile url as the API base, trailing slash stripped', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService({ ...spec, check: { kind: 'pihole', target: 'http://192.168.1.5/' } });
  await reg.clientFor(await store.getService(created.id));
  expect(built[0].opts.baseUrl).toBe('http://192.168.1.5');
});

test('a rotated password rebuilds the client and closes the old session', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService(spec);
  await reg.clientFor(await store.getService(created.id));

  await store.updateService(created.id, { password: 'new-pw' });
  await reg.clientFor(await store.getService(created.id));

  expect(built).toHaveLength(2);
  expect(built[0].closed).toBe(1);
  expect(built[1].opts.password).toBe('new-pw');
});

test('a changed insecure flag rebuilds the client', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService(spec);
  await reg.clientFor(await store.getService(created.id));
  await store.updateService(created.id, { check: { kind: 'pihole', insecure: true } });
  await reg.clientFor(await store.getService(created.id));
  expect(built).toHaveLength(2);
  expect(built[1].opts.insecure).toBe(true);
});

test('retain closes clients for services that are gone', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const a = await store.addService(spec);
  const b = await store.addService({ ...spec, name: 'pihole2' });
  await reg.clientFor(await store.getService(a.id));
  await reg.clientFor(await store.getService(b.id));

  await reg.retain([a.id]);
  expect(built[0].closed).toBe(0);
  expect(built[1].closed).toBe(1);

  // The forgotten service rebuilds from scratch if it comes back.
  await reg.clientFor(await store.getService(b.id));
  expect(built).toHaveLength(3);
});

test('closeAll closes every live client exactly once', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const a = await store.addService(spec);
  await reg.clientFor(await store.getService(a.id));
  await reg.closeAll();
  await reg.closeAll();
  expect(built[0].closed).toBe(1);
});

test('a client whose close throws does not break closeAll', async () => {
  const reg = createPiholeRegistry({
    store,
    makeClient: () => ({ async fetchSummary() { return { ok: true, metrics: {} }; }, async close() { throw new Error('boom'); } }),
  });
  const a = await store.addService(spec);
  await reg.clientFor(await store.getService(a.id));
  await expect(reg.closeAll()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/piholeRegistry.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/piholeRegistry.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/piholeRegistry.js`:

```js
import { createHash } from 'node:crypto';
import { createPiholeClient } from './piholeApi.js';

// Sessions have to outlive a single check, so clients cannot be constructed per
// sweep — this registry owns one per service id. A client is rebuilt only when
// the inputs that define it change (API base, app password, TLS mode), which is
// what the fingerprint is for: the password is hashed rather than stored, so the
// plaintext lives only inside the client that needs it.
export function createPiholeRegistry({ store, makeClient = createPiholeClient, timeoutMs = 8000 }) {
  const clients = new Map(); // serviceId -> { fingerprint, client }

  function closeQuietly(client) {
    // Best-effort: a Pi-hole that is down at shutdown must not stall the exit.
    return Promise.resolve()
      .then(() => client?.close?.())
      .catch(() => {});
  }

  async function clientFor(service) {
    const password = (await store.getServiceSecret(service.id)) || '';
    const baseUrl = String(service.check?.target || service.url || '').replace(/\/+$/, '');
    const insecure = service.check?.insecure === true;
    const fingerprint = createHash('sha256').update(JSON.stringify([baseUrl, password, insecure])).digest('hex');

    const cached = clients.get(service.id);
    if (cached && cached.fingerprint === fingerprint) return cached.client;
    if (cached) void closeQuietly(cached.client);

    const client = makeClient({ baseUrl, password, insecure, timeoutMs });
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/piholeRegistry.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/piholeRegistry.js test/piholeRegistry.test.js
git commit -m "feat(pihole): per-service client registry owning session lifetimes"
```

---

### Task 4: Wire the Pi-hole check into the sweep

**Files:**
- Modify: `src/server/serviceCheck.js`
- Modify: `src/server/serviceChecker.js`
- Test: `test/serviceCheck.test.js`, `test/serviceChecker.test.js`

**Interfaces:**
- Consumes: `registry.clientFor(service)` and `registry.retain(ids)` (Task 3); redacted services carrying `hasPassword` (Task 2).
- Produces:
  - `checkService(service, opts)` where `opts` may carry `{ registry }`; result is `{ state: 'up', latencyMs, metrics }` | `{ state: 'auth', latencyMs, error }` | `{ state: 'down', latencyMs?, error }`.
  - `createServiceChecker({ …, piholeRegistry = null })`; snapshot results carry `metrics` for Pi-hole services.

- [ ] **Step 1: Write the failing tests**

Append to `test/serviceCheck.test.js`:

```js
import { startFakePihole } from './helpers/fakePihole.js';
import { createPiholeClient } from '../src/server/piholeApi.js';

// A minimal registry over one real client — the same interface serviceChecker
// hands in, without needing a store on disk for a check-level test.
function oneClientRegistry(client) {
  return { clientFor: async () => client, retain: async () => {}, closeAll: async () => client.close() };
}

test('checkService: pihole kind returns metrics and an up state', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const r = await checkService(
    { id: 'a', url: pi.baseUrl, hasPassword: true, check: { kind: 'pihole' } },
    { registry: oneClientRegistry(client) },
  );
  await client.close();
  await pi.stop();
  expect(r.state).toBe('up');
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  expect(r.metrics.queriesTotal).toBe(48132);
});

test('checkService: a rejected password is the auth state, not down', async () => {
  const pi = await startFakePihole({ password: 'right' });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'wrong' });
  const r = await checkService(
    { id: 'a', url: pi.baseUrl, hasPassword: true, check: { kind: 'pihole' } },
    { registry: oneClientRegistry(client) },
  );
  await client.close();
  await pi.stop();
  expect(r.state).toBe('auth');
  expect(r.error).toMatch(/app password/i);
  expect(r.metrics).toBeUndefined();
});

test('checkService: no stored password names that as the problem', async () => {
  const pi = await startFakePihole({ password: 'right' });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: '' });
  const r = await checkService(
    { id: 'a', url: pi.baseUrl, hasPassword: false, check: { kind: 'pihole' } },
    { registry: oneClientRegistry(client) },
  );
  await client.close();
  await pi.stop();
  expect(r.state).toBe('auth');
  expect(r.error).toMatch(/no app password/i);
});

test('checkService: an unreachable pihole is down', async () => {
  const pi = await startFakePihole();
  const { baseUrl } = pi;
  await pi.stop();
  const client = createPiholeClient({ baseUrl, password: 'app-pw', timeoutMs: 500 });
  const r = await checkService(
    { id: 'a', url: baseUrl, hasPassword: true, check: { kind: 'pihole' } },
    { registry: oneClientRegistry(client) },
  );
  expect(r.state).toBe('down');
});

test('checkService: a pihole service with no registry is down, not a throw', async () => {
  const r = await checkService({ id: 'a', url: 'http://127.0.0.1:1/', hasPassword: true, check: { kind: 'pihole' } }, {});
  expect(r.state).toBe('down');
});
```

Append to `test/serviceChecker.test.js`:

```js
test('a sweep carries pihole metrics into the snapshot and retains live clients', async () => {
  const retained = [];
  const store = {
    listServices: async () => [
      { id: 'p1', name: 'pihole', url: 'http://127.0.0.1/', check: { kind: 'pihole' }, hasPassword: true },
      { id: 'h1', name: 'web', url: 'http://127.0.0.1/', check: { kind: 'http' } },
      { id: 'n1', name: 'link', url: 'http://127.0.0.1/', check: { kind: 'none' } },
    ],
  };
  const checker = createServiceChecker({
    store,
    piholeRegistry: { clientFor: async () => ({}), retain: async (ids) => { retained.push(ids); }, closeAll: async () => {} },
    check: async (svc) => (svc.check.kind === 'pihole'
      ? { state: 'up', latencyMs: 3, metrics: { queriesTotal: 7 } }
      : { state: 'up', latencyMs: 1 }),
  });
  const snap = await checker.pollOnce();
  expect(snap.results.p1.metrics).toEqual({ queriesTotal: 7 });
  expect(snap.results.h1.metrics).toBeUndefined();
  expect(snap.results.n1).toBeUndefined();
  expect(retained).toEqual([['p1']]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/serviceCheck.test.js test/serviceChecker.test.js`
Expected: FAIL — the pihole checks fall through to `checkHttp` and report `state: 'up'` with no `metrics`; `retained` stays empty.

- [ ] **Step 3: Implement the check branch**

In `src/server/serviceCheck.js`, add before `checkService`:

```js
// A Pi-hole check reports numbers, not just reachability. The `auth` state is
// deliberately distinct from `down`: a rotated app password means the Pi-hole is
// answering perfectly well, and painting it red would cry wolf. It maps onto the
// violet `.dot.auth` lamp boxes already use for failed SSH credentials.
export async function checkPihole(service, { registry } = {}) {
  if (!registry) return { state: 'down', error: 'pi-hole client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await registry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'pi-hole client setup failed' };
  }
  const res = await client.fetchSummary();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, metrics: res.metrics };
  if (res.kind === 'auth') {
    // A Pi-hole with no password configured authenticates on an empty one, so
    // the empty-password attempt is made first and only its failure is reported
    // as the missing credential.
    const error = service.hasPassword === false
      ? 'no app password configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}
```

Then extend `checkService`:

```js
export async function checkService(service, opts = {}) {
  const kind = service?.check?.kind || 'http';
  if (kind === 'none') return null;
  if (kind === 'pihole') return checkPihole(service, opts);
  if (kind === 'tcp') return checkTcp(service.check?.target, opts);
  return checkHttp(service.check?.target || service.url, opts);
}
```

- [ ] **Step 4: Implement the checker wiring**

In `src/server/serviceChecker.js`, add `piholeRegistry = null` to the factory arguments:

```js
export function createServiceChecker({
  store, check = checkService, piholeRegistry = null, intervalMs = 30000, concurrency = 8,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
```

and replace the body of `pollOnce`'s async IIFE:

```js
    inFlight = (async () => {
      const services = (await store.listServices()).filter((s) => s?.check?.kind !== 'none');
      const next = {};
      await mapWithConcurrency(services, concurrency, async (s) => {
        next[s.id] = await check(s, { registry: piholeRegistry });
      });
      // Close sessions belonging to Pi-hole services that have been deleted or
      // switched to another check kind; a leaked session outlives the tile.
      if (piholeRegistry) {
        await piholeRegistry.retain(services.filter((s) => s.check?.kind === 'pihole').map((s) => s.id));
      }
      snapshot = { checkedAt: new Date().toISOString(), results: next };
      return snapshot;
    })().finally(() => { inFlight = null; });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/serviceCheck.test.js test/serviceChecker.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/serviceCheck.js src/server/serviceChecker.js test/serviceCheck.test.js test/serviceChecker.test.js
git commit -m "feat(pihole): pihole branch in the service sweep with a distinct auth state"
```

---

### Task 5: Routes and server wiring

**Files:**
- Modify: `src/server/server.js:785-800` (the standby-dashboard services block)
- Modify: `src/server/index.js:264-265` (store/checker construction) and `:291` (shutdown flush)
- Test: `test/serviceRoutes.test.js`

**Interfaces:**
- Consumes: `createPiholeClient` (Task 1), `createServicesStore({ dataDir, secretBox })` and `getServiceSecret` (Task 2), `createPiholeRegistry` (Task 3).
- Produces: `POST /api/services/pihole/test` accepting `{ url, password, insecure, id }` → `{ ok: true, version }` | `{ ok: false, error }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/serviceRoutes.test.js`:

```js
import { createSecretBox } from '../src/server/secretBox.js';
import { startFakePihole } from './helpers/fakePihole.js';

test('GET /api/services never leaks the sealed password', async () => {
  const h = await headers();
  const pi = await startFakePihole();
  await app.inject({
    method: 'POST', url: '/api/services', headers: h,
    payload: { name: 'pihole', url: pi.baseUrl, check: { kind: 'pihole' }, password: 'app-pw' },
  });
  const res = await app.inject({ method: 'GET', url: '/api/services', headers: h });
  await pi.stop();
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toContain('app-pw');
  expect(res.body).not.toContain('pvebox.v1');
  expect(res.json()[0].hasPassword).toBe(true);
});

test('POST /api/services/pihole/test reports a good password with the version', async () => {
  const h = await headers();
  const pi = await startFakePihole();
  const res = await app.inject({
    method: 'POST', url: '/api/services/pihole/test', headers: h,
    payload: { url: pi.baseUrl, password: 'app-pw' },
  });
  await pi.stop();
  expect(res.json()).toEqual({ ok: true, version: 'v6.2.1' });
  expect(pi.counts.delete).toBe(1); // the probe revokes its own session
});

test('POST /api/services/pihole/test reports a bad password without echoing it', async () => {
  const h = await headers();
  const pi = await startFakePihole({ password: 'right' });
  const res = await app.inject({
    method: 'POST', url: '/api/services/pihole/test', headers: h,
    payload: { url: pi.baseUrl, password: 'wrong' },
  });
  await pi.stop();
  const body = res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/app password/i);
  expect(res.body).not.toContain('wrong');
});

test('POST /api/services/pihole/test falls back to the stored password when none is typed', async () => {
  const h = await headers();
  const pi = await startFakePihole();
  const created = await app.inject({
    method: 'POST', url: '/api/services', headers: h,
    payload: { name: 'pihole', url: pi.baseUrl, check: { kind: 'pihole' }, password: 'app-pw' },
  });
  const res = await app.inject({
    method: 'POST', url: '/api/services/pihole/test', headers: h,
    payload: { id: created.json().id, url: pi.baseUrl, password: '' },
  });
  await pi.stop();
  expect(res.json().ok).toBe(true);
});

test('POST /api/services/pihole/test requires authentication and a url', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'POST', url: '/api/services/pihole/test', payload: { url: 'http://127.0.0.1/' } })).statusCode).toBe(401);
  const bad = await app.inject({ method: 'POST', url: '/api/services/pihole/test', headers: h, payload: { url: 'nonsense' } });
  expect(bad.json().ok).toBe(false);
});
```

Update the `beforeEach` in the same file so the store has a secret box:

```js
  servicesStore = createServicesStore({ dataDir: dir, secretBox: createSecretBox('test-secret') });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/serviceRoutes.test.js`
Expected: FAIL — 404 on `/api/services/pihole/test`.

- [ ] **Step 3: Add the route**

In `src/server/server.js`, add the import next to the other service imports at the top of the file:

```js
import { createPiholeClient } from './piholeApi.js';
```

Add `makePiholeClient = createPiholeClient` to `buildServer`'s destructured arguments (alongside `makeNetboxClient`), then add the route immediately after `app.get('/api/services/status', …)`:

```js
  // Save-and-pray is a poor way to discover that Pi-hole v6 wants an *app*
  // password rather than the web login password, so the form can probe first.
  // The probe revokes its own session — v6 caps concurrent sessions.
  app.post('/api/services/pihole/test', { preHandler: requireAuth }, async (req) => {
    const { url, password, insecure, id } = req.body || {};
    const base = typeof url === 'string' ? url.trim() : '';
    try {
      const u = new URL(base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('must be http(s)');
    } catch {
      return { ok: false, error: 'enter a valid http(s) URL for the Pi-hole' };
    }
    // A blank password on an existing service means "use the one already stored",
    // so Test works while editing without retyping the secret.
    let secret = typeof password === 'string' ? password : '';
    if (!secret && id) secret = (await servicesStore.getServiceSecret(id)) || '';
    const client = makePiholeClient({ baseUrl: base, password: secret, insecure: insecure === true });
    try {
      const res = await client.fetchVersion();
      return res.ok ? { ok: true, version: res.version } : { ok: false, error: res.error };
    } finally {
      await client.close();
    }
  });
```

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `npx vitest run test/serviceRoutes.test.js`
Expected: PASS.

- [ ] **Step 5: Wire it up in `index.js`**

Add the import next to the other service imports:

```js
import { createPiholeRegistry } from './piholeRegistry.js';
```

Replace the services-store construction block (currently lines 264-265) with:

```js
// The standby dashboard's service tiles: one sweep loop, same rationale as the
// status poller — check volume is independent of open tab count. The store takes
// secretBox because a pihole tile carries a sealed app password.
const servicesStore = createServicesStore({ dataDir: config.dataDir, secretBox });
const piholeRegistry = createPiholeRegistry({ store: servicesStore });
const serviceChecker = createServiceChecker({ store: servicesStore, piholeRegistry, intervalMs: config.servicePollMs });
```

Add the registry to the shutdown flush so Pi-hole sessions are revoked rather than leaked across a restart:

```js
    registerShutdownFlush({
      flush: [
        ...[fleetStore, setupStore, provisionStore, lifecycleStore].map((s) => () => s.whenIdle()),
        () => piholeRegistry.closeAll(),
      ],
      voiceEngine: { stop: async () => { if (voiceEngine) await voiceEngine.stop(); } },
    });
```

- [ ] **Step 6: Run the whole server test suite**

Run: `npm test`
Expected: PASS — typecheck plus every vitest file.

- [ ] **Step 7: Commit**

```bash
git add src/server/server.js src/server/index.js test/serviceRoutes.test.js
git commit -m "feat(pihole): test-connection route and server wiring"
```

---

### Task 6: Web types and the settings form

**Files:**
- Modify: `src/web/api.ts:36-48` (service types) and the `api` object
- Modify: `src/web/settingsServices.ts`
- Test: `test/settingsServices.test.js`

**Interfaces:**
- Consumes: `POST /api/services/pihole/test` (Task 5); the `hasPassword` field and `pihole` check kind (Task 2).
- Produces:
  - `ServiceCheckKind` includes `'pihole'`; `ServiceCheck` gains `insecure?: boolean`; `Service` gains `hasPassword?: boolean`; `ServiceSpec` gains `password?: string | null`.
  - `PiholeMetrics` and `ServiceResult['state'] = 'up' | 'down' | 'auth'` with `metrics?: PiholeMetrics`.
  - `api.testPihole({ url, password, insecure, id })` → `Promise<{ ok: boolean; version?: string | null; error?: string }>`
  - `buildServicePayload(f)` accepts `password`, `clearPassword`, `insecure`.

- [ ] **Step 1: Write the failing tests**

Append to `test/settingsServices.test.js`:

```js
test('buildServicePayload builds a pihole check with its optional target and insecure flag', () => {
  expect(buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', glyph: '', group: 'DNS Filtering',
    kind: 'pihole', target: '', section: 'infrastructure', password: 'app-pw',
  })).toEqual({
    name: 'pihole', url: 'https://pihole.example.com', glyph: null, group: 'DNS Filtering',
    section: 'infrastructure', check: { kind: 'pihole' }, password: 'app-pw',
  });

  expect(buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', glyph: '', group: '',
    kind: 'pihole', target: ' http://192.168.1.5/ ', section: 'services', insecure: true,
  }).check).toEqual({ kind: 'pihole', target: 'http://192.168.1.5/', insecure: true });
});

test('buildServicePayload omits an untouched password and sends null to clear it', () => {
  const untouched = buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', glyph: '', group: '',
    kind: 'pihole', target: '', section: 'services', password: '   ',
  });
  expect('password' in untouched).toBe(false);

  const cleared = buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', glyph: '', group: '',
    kind: 'pihole', target: '', section: 'services', password: '', clearPassword: true,
  });
  expect(cleared.password).toBe(null);
});

test('buildServicePayload never attaches a password to a non-pihole check', () => {
  const payload = buildServicePayload({
    name: 'web', url: 'http://192.168.1.20:3000/', glyph: '', group: '',
    kind: 'http', target: '', section: 'services', password: 'leftover',
  });
  expect('password' in payload).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/settingsServices.test.js`
Expected: FAIL — the pihole payload comes back as `{ kind: 'pihole' }` without the extra fields, and `password` is never attached.

- [ ] **Step 3: Update the types in `src/web/api.ts`**

Replace lines 36-48 with:

```ts
export type ServiceCheckKind = 'http' | 'tcp' | 'none' | 'pihole';
export type ServiceSection = 'services' | 'infrastructure';
export interface ServiceCheck { kind: ServiceCheckKind; target?: string; insecure?: boolean }
export interface Service {
  id: string; name: string; url: string; glyph?: string; group?: string;
  section?: ServiceSection;
  check: ServiceCheck; createdAt: string;
  hasPassword?: boolean; // pihole only; the password itself never reaches the browser
}
export type ServiceSpec =
  Partial<Omit<Service, 'id' | 'createdAt' | 'glyph' | 'group' | 'hasPassword'>>
  & { glyph?: string | null; group?: string | null; password?: string | null };
export interface PiholeMetrics {
  blocking: 'enabled' | 'disabled';
  blockingTimer: number | null;
  queriesTotal: number | null;
  queriesBlocked: number | null;
  percentBlocked: number | null;
  clientsActive: number | null;
  clientsTotal: number | null;
  gravityDomains: number | null;
  versionCore: string | null;
  versionWeb: string | null;
  versionFtl: string | null;
  updateAvailable: boolean;
  uptimeSec: number | null;
}
export interface ServiceResult { state: 'up' | 'down' | 'auth'; latencyMs?: number; error?: string; metrics?: PiholeMetrics }
export interface ServiceStatusSnapshot { checkedAt: string | null; results: Record<string, ServiceResult> }
```

Add the fetch method next to `servicesStatus` in the `api` object:

```ts
  async testPihole(body: { url: string; password?: string; insecure?: boolean; id?: string }) {
    return j<{ ok: boolean; version?: string | null; error?: string }>(
      await fetch('/api/services/pihole/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  },
```

- [ ] **Step 4: Update `buildServicePayload` in `src/web/settingsServices.ts`**

Replace the existing function with:

```ts
// Pure so it can be tested without a DOM (the repo's web-test convention).
// null (not undefined) for cleared optionals: the server's PATCH merge treats
// null as "clear this field", while an absent key means "leave it alone" —
// which is exactly what an untouched password field must send.
export function buildServicePayload(f: {
  name: string; url: string; glyph: string; group: string;
  kind: ServiceCheckKind; target: string; section: ServiceSection;
  password?: string; clearPassword?: boolean; insecure?: boolean;
}): ServiceSpec {
  const target = f.target.trim();
  let check: ServiceCheck;
  if (f.kind === 'pihole') {
    check = { kind: 'pihole', ...(target ? { target } : {}), ...(f.insecure ? { insecure: true } : {}) };
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
  if (f.kind === 'pihole') {
    if (f.clearPassword) payload.password = null;
    else if (f.password?.trim()) payload.password = f.password;
  }
  return payload;
}
```

Add `ServiceCheck` to the type import at the top of the file:

```ts
import { api, type Service, type ServiceCheck, type ServiceCheckKind, type ServiceSection, type ServiceSpec } from './api';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/settingsServices.test.js && npm run typecheck`
Expected: PASS on both.

- [ ] **Step 6: Add the Pi-hole form controls**

Still in `src/web/settingsServices.ts`, inside `renderServicesSection`:

Add the inputs next to the existing ones (after `targetIn`):

```ts
  const passwordIn = el('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const insecureIn = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const clearPwBtn = el('button', { type: 'button', class: 'pve-btn' }, ['Clear']);
  const testBtn = el('button', { type: 'button', class: 'pve-btn' }, ['Test connection']);
  let clearPassword = false;
```

Add the fourth radio to the `radios` record:

```ts
  const radios: Record<ServiceCheckKind, { wrap: HTMLElement; input: HTMLInputElement }> = {
    http: makeRadio('svc-check', 'http', 'HTTP', true),
    tcp: makeRadio('svc-check', 'tcp', 'TCP', false),
    pihole: makeRadio('svc-check', 'pihole', 'Pi-hole', false),
    none: makeRadio('svc-check', 'none', 'None (link only)', false),
  };
```

Build the Pi-hole field group and extend `syncTarget` so the right controls show per kind:

```ts
  const passwordField = field('App password', el('div', { class: 'pve-inline' }, [passwordIn, clearPwBtn]));
  const insecureField = field('', el('label', { class: 'svc-inline-check' }, [insecureIn, ' Allow a self-signed certificate']));
  const piholeHelp = el('p', { class: 'pve-sub' }, [
    'Pi-hole v6 only. Create the credential on the Pi-hole under Settings → Web interface / API → Configure app password; an app password works even when two-factor is enabled, the web login password does not.',
  ]);
  const testRow = el('div', { class: 'pve-inline' }, [testBtn]);
  const piholeGroup = el('div', {}, [piholeHelp, passwordField, insecureField, testRow]);

  const targetField = field('Probe URL (optional)', targetIn);
  const syncTarget = () => {
    const k = kind();
    targetField.hidden = k === 'none';
    piholeGroup.hidden = k !== 'pihole';
    (targetField.querySelector('span') as HTMLElement).textContent =
      k === 'tcp' ? 'Host:port'
        : k === 'pihole' ? 'API base URL (optional — defaults to the link URL)'
          : 'Probe URL (optional — defaults to the link URL)';
    targetIn.placeholder = k === 'tcp' ? '192.168.1.10:53'
      : k === 'pihole' ? 'https://pihole.example.com'
        : 'https://192.168.1.10:3000/health';
  };
```

Wire the password-clear affordance and the Test button:

```ts
  passwordIn.addEventListener('input', () => { clearPassword = false; });
  clearPwBtn.addEventListener('click', () => {
    clearPassword = true;
    passwordIn.value = '';
    passwordIn.placeholder = 'will be cleared on save';
  });

  testBtn.addEventListener('click', async () => {
    setStatus('Testing…');
    try {
      const res = await api.testPihole({
        url: (targetIn.value.trim() || urlIn.value.trim()),
        password: passwordIn.value,
        insecure: insecureIn.checked,
        id: editing?.id,
      });
      if (res.ok) setStatus(`Connected — Pi-hole ${res.version ?? 'v6'}`);
      else setStatus(res.error || 'Connection failed', true);
    } catch (e) {
      setStatus((e as Error).message, true);
    }
  });
```

Extend `fillForm` so editing an existing Pi-hole shows the stored-password state rather than a blank field that reads as "no password":

```ts
    clearPassword = false;
    passwordIn.value = '';
    passwordIn.placeholder = svc?.hasPassword ? '•••••••• (leave blank to keep)' : '';
    insecureIn.checked = svc?.check.insecure === true;
```

Pass the new fields through the save handler:

```ts
    const payload = buildServicePayload({
      name: nameIn.value, url: urlIn.value, glyph: glyphIn.value,
      group: groupIn.value, kind: kind(), target: targetIn.value, section: section(),
      password: passwordIn.value, clearPassword, insecure: insecureIn.checked,
    });
```

Add the radio and the group to the rendered form — replace the radios line and add `piholeGroup` right after `targetField`:

```ts
      el('div', { class: 'svc-check-radios' }, [radios.http.wrap, radios.tcp.wrap, radios.pihole.wrap, radios.none.wrap]),
      targetField,
      piholeGroup,
```

- [ ] **Step 7: Verify the typecheck and full suite still pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/api.ts src/web/settingsServices.ts test/settingsServices.test.js
git commit -m "feat(pihole): settings form with app password, TLS opt-out, and a test probe"
```

---

### Task 7: The dashboard card

**Files:**
- Modify: `src/web/dashboard.ts`
- Modify: `src/web/style.css`
- Test: `test/dashboard.test.js`

**Interfaces:**
- Consumes: `PiholeMetrics`, `ServiceResult` with the `auth` state (Task 6).
- Produces:
  - `serviceLamp(svc, snap)` → `'up' | 'down' | 'auth' | 'unknown' | 'none'`
  - `fmtCount(n: number | null)` → `string`, `fmtCompact(n: number | null)` → `string`, `fmtUptime(sec: number | null)` → `string`
  - `piholeCardModel(svc: Service, snap: ServiceStatusSnapshot | null)` → `{ lamp: 'green' | 'red' | 'auth' | ''; chip: string; rows: { label: string; value: string }[]; error: string }`

- [ ] **Step 1: Write the failing tests**

Append to `test/dashboard.test.js` (and add the new names to the import at the top of the file):

```js
const piSvc = { id: 'p', name: 'pihole', url: 'http://x.example.com/', check: { kind: 'pihole' }, createdAt: '' };
const metrics = {
  blocking: 'enabled', blockingTimer: null,
  queriesTotal: 48132, queriesBlocked: 10780, percentBlocked: 22.396,
  clientsActive: 31, clientsTotal: 54, gravityDomains: 1284933,
  versionCore: 'v6.2.1', versionWeb: 'v6.2', versionFtl: 'v6.2.3',
  updateAvailable: false, uptimeSec: 1220400,
};
const snap = (result) => ({ checkedAt: '2026-07-27T00:00:00.000Z', results: { p: result } });

test('fmtCount groups thousands and dashes a missing number', () => {
  expect(fmtCount(48132)).toBe('48,132');
  expect(fmtCount(0)).toBe('0');
  expect(fmtCount(null)).toBe('—');
});

test('fmtCompact abbreviates millions and thousands', () => {
  expect(fmtCompact(1284933)).toBe('1.28M');
  expect(fmtCompact(250000)).toBe('250.0k');
  expect(fmtCompact(9999)).toBe('9,999');
  expect(fmtCompact(null)).toBe('—');
});

test('fmtUptime reads in the largest two units', () => {
  expect(fmtUptime(1220400)).toBe('14d 3h');
  expect(fmtUptime(11520)).toBe('3h 12m');
  expect(fmtUptime(480)).toBe('8m');
  expect(fmtUptime(0)).toBe('0m');
  expect(fmtUptime(null)).toBe('—');
});

test('piholeCardModel lays out all six readings', () => {
  const card = piholeCardModel(piSvc, snap({ state: 'up', latencyMs: 40, metrics }));
  expect(card.lamp).toBe('green');
  expect(card.chip).toBe('blocking on');
  expect(card.error).toBe('');
  expect(card.rows).toEqual([
    { label: 'QUERIES', value: '48,132' },
    { label: 'BLOCKED', value: '22.4%' },
    { label: 'CLIENTS', value: '31/54' },
    { label: 'DOMAINS', value: '1.28M' },
    { label: 'VERSION', value: 'v6.2.1' },
    { label: 'UPTIME', value: '14d 3h' },
  ]);
});

test('piholeCardModel marks an available update on the version row', () => {
  const card = piholeCardModel(piSvc, snap({ state: 'up', metrics: { ...metrics, updateAvailable: true } }));
  expect(card.rows.find((r) => r.label === 'VERSION').value).toBe('v6.2.1 ↑');
});

test('piholeCardModel shows the remaining timer while blocking is disabled', () => {
  const off = piholeCardModel(piSvc, snap({ state: 'up', metrics: { ...metrics, blocking: 'disabled', blockingTimer: 1680 } }));
  expect(off.chip).toBe('blocking off · 28m left');
  const indefinite = piholeCardModel(piSvc, snap({ state: 'up', metrics: { ...metrics, blocking: 'disabled', blockingTimer: null } }));
  expect(indefinite.chip).toBe('blocking off');
});

test('piholeCardModel renders the three degraded states instead of numbers', () => {
  const auth = piholeCardModel(piSvc, snap({ state: 'auth', error: 'app password rejected' }));
  expect(auth).toMatchObject({ lamp: 'auth', rows: [], chip: '', error: 'app password rejected' });

  const down = piholeCardModel(piSvc, snap({ state: 'down', error: 'timeout' }));
  expect(down).toMatchObject({ lamp: 'red', rows: [], error: 'timeout' });

  const pending = piholeCardModel(piSvc, null);
  expect(pending).toMatchObject({ lamp: '', rows: [], error: '' });
});

test('serviceLamp surfaces the auth state', () => {
  expect(serviceLamp(piSvc, snap({ state: 'auth', error: 'x' }))).toBe('auth');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboard.test.js`
Expected: FAIL — `fmtCount is not defined` and the other new exports are missing.

- [ ] **Step 3: Add the pure view-model helpers**

In `src/web/dashboard.ts`, extend the type import:

```ts
import type { Box, Status, Sample, Service, ServiceStatusSnapshot } from './api';
```

(no change needed if `PiholeMetrics` is only referenced through `ServiceResult`).

Replace `serviceLamp` and add the new helpers below it:

```ts
export function serviceLamp(svc: Service, snap: ServiceStatusSnapshot | null): 'up' | 'down' | 'auth' | 'unknown' | 'none' {
  if (svc.check.kind === 'none') return 'none';
  const r = snap?.results[svc.id];
  return r ? r.state : 'unknown';
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

export interface PiholeCard {
  lamp: 'green' | 'red' | 'auth' | '';
  chip: string;
  rows: { label: string; value: string }[];
  error: string;
}

// The card's whole layout decision, kept pure: the DOM layer only writes these
// strings into slots. A degraded Pi-hole shows one error line rather than a grid
// of dashes — six blank readings say less than one sentence does.
export function piholeCardModel(svc: Service, snap: ServiceStatusSnapshot | null): PiholeCard {
  const r = snap?.results[svc.id];
  if (!r) return { lamp: '', chip: '', rows: [], error: '' };
  if (r.state === 'auth') return { lamp: 'auth', chip: '', rows: [], error: r.error || 'authentication failed' };
  if (r.state === 'down' || !r.metrics) return { lamp: 'red', chip: '', rows: [], error: r.error || 'unreachable' };

  const m = r.metrics;
  const timer = m.blocking === 'disabled' && m.blockingTimer != null
    ? ` · ${fmtUptime(m.blockingTimer)} left`
    : '';
  return {
    lamp: 'green',
    chip: `blocking ${m.blocking === 'disabled' ? 'off' : 'on'}${timer}`,
    error: '',
    rows: [
      { label: 'QUERIES', value: fmtCount(m.queriesTotal) },
      { label: 'BLOCKED', value: m.percentBlocked == null ? '—' : `${m.percentBlocked.toFixed(1)}%` },
      { label: 'CLIENTS', value: `${fmtCount(m.clientsActive)}/${fmtCount(m.clientsTotal)}` },
      { label: 'DOMAINS', value: fmtCompact(m.gravityDomains) },
      { label: 'VERSION', value: `${m.versionCore ?? '—'}${m.updateAvailable ? ' ↑' : ''}` },
      { label: 'UPTIME', value: fmtUptime(m.uptimeSec) },
    ],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/dashboard.test.js && npm run typecheck`
Expected: PASS on both.

- [ ] **Step 5: Render the card in the DOM layer**

Still in `src/web/dashboard.ts`, declare the `Card` interface at module scope immediately after the existing `Tile` interface (matching the file's existing style — `Tile` and `FleetRow` both live outside the factory):

```ts
interface Card {
  root: HTMLAnchorElement; name: HTMLElement; lamp: HTMLElement; chip: HTMLElement;
  grid: HTMLElement; error: HTMLElement;
}
```

Then add the element cache inside `createDashboard`, on the line after `const tileEls = new Map<string, Tile>();`:

```ts
  const cardEls = new Map<string, Card>();
```

Add the builder next to `makeTile`:

```ts
  function makeCard(): Card {
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
    const grid = div('dash-card-grid');
    const error = div('dash-card-error');
    root.append(top, grid, error);
    return { root, name, lamp, chip, grid, error };
  }
```

Add the painter and dispatch to it from `paintTile`:

```ts
  function paintPiholeCard(svc: Service): HTMLElement {
    let card = cardEls.get(svc.id);
    if (!card) { card = makeCard(); cardEls.set(svc.id, card); }
    const model = piholeCardModel(svc, data.serviceStatus);
    card.root.href = svc.url;
    card.name.textContent = svc.name;
    card.lamp.className = `dot ${model.lamp}`.trim();
    card.chip.textContent = model.chip;
    card.chip.hidden = !model.chip;
    card.error.textContent = model.error;
    card.error.hidden = !model.error;
    card.root.title = model.error;

    // Rebuild only when the row count changes; otherwise write in place so the
    // poll never disturbs hover or text selection (the tile contract).
    if (card.grid.children.length !== model.rows.length) {
      card.grid.replaceChildren(...model.rows.map(() => {
        const cell = div('dash-card-cell');
        cell.append(div('dash-card-label'), div('dash-card-value'));
        return cell;
      }));
    }
    model.rows.forEach((row, i) => {
      const cell = card!.grid.children[i] as HTMLElement;
      (cell.firstChild as HTMLElement).textContent = row.label;
      (cell.lastChild as HTMLElement).textContent = row.value;
    });
    card.grid.hidden = model.rows.length === 0;
    return card.root;
  }

  function paintTile(svc: Service): HTMLElement {
    tilesSeen.add(svc.id);
    // A Pi-hole reports numbers, so it renders as a card rather than a lamp;
    // everything downstream (grouping, ordering, cleanup) treats it as a tile.
    if (svc.check.kind === 'pihole') return paintPiholeCard(svc);
    let tile = tileEls.get(svc.id);
    if (!tile) { tile = makeTile(); tileEls.set(svc.id, tile); }
    // …the rest of the existing function body is unchanged…
  }
```

Only the two lines above `let tile = …` are new — do not retype the rest of the function.

Extend the repaint cleanup so retired cards are removed too — in `repaint()`, after the existing `tileEls` loop:

```ts
    for (const [id, card] of cardEls) {
      if (!tilesSeen.has(id)) { card.root.remove(); cardEls.delete(id); }
    }
```

and add `cardEls.clear();` to `destroy()`.

Finally, teach the ordinary tile painter about the `auth` lamp so a non-Pi-hole tile can never fall through with an unstyled class — in `paintTile`'s existing body, replace the lamp line:

```ts
    tile.lamp.className = `dot${lampState === 'up' ? ' green' : lampState === 'down' ? ' red' : lampState === 'auth' ? ' auth' : ''}`;
```

- [ ] **Step 6: Add the styles**

In `src/web/style.css`, after the existing `.dash-tile` rules:

```css
/* Pi-hole card: a tile that reports numbers instead of a status line. Two grid
   columns wide, degrading to one on a narrow bay so it never forces a
   horizontal scroll. */
.dash-tile-wide { grid-column: span 2; }
@media (max-width: 640px) { .dash-tile-wide { grid-column: span 1; } }
.dash-card-chip {
  margin-left: auto; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--amber); opacity: 0.85;
}
.dash-card-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 18px; margin-top: 10px;
}
.dash-card-cell { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; }
.dash-card-label { font-size: 10px; letter-spacing: 0.12em; opacity: 0.55; }
.dash-card-value { font-variant-numeric: tabular-nums; font-size: 13px; }
.dash-card-error { margin-top: 10px; font-size: 12px; color: var(--orange); }
```

- [ ] **Step 7: Verify the whole suite and the build**

Run: `npm test && npm run build`
Expected: PASS on both.

- [ ] **Step 8: Commit**

```bash
git add src/web/dashboard.ts src/web/style.css test/dashboard.test.js
git commit -m "feat(pihole): double-width dashboard card with the six readings"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (keep the two in sync — the same edits, adapted)
- Modify: `README.md`

**Interfaces:**
- Consumes: every module built in Tasks 1-7.
- Produces: no code.

- [ ] **Step 1: Update the architecture list**

In both `CLAUDE.md` and `AGENTS.md`, add after the `servicesStore.js` / `serviceCheck.js` / `serviceChecker.js` bullet:

```markdown
- `piholeApi.js` / `piholeRegistry.js` — the `pihole` service check, in the mold of
  `netboxApi.js`: a dependency-free Pi-hole **v6** REST client (`POST /api/auth` trades an app
  password for a session id carried in `X-FTL-SID`) reading `stats/summary`, `info/version`,
  `info/system` and `dns/blocking` in one pass. v6 caps concurrent sessions, so the client holds
  exactly one and reuses it until 80% of its advertised validity — minting one per 30-second sweep
  would exhaust the pool within the hour — single-flighting the authentication, re-authenticating
  exactly once on a mid-flight `401`, and revoking with `DELETE /api/auth` on shutdown.
  `piholeRegistry.js` owns one client per service id, rebuilding it when the API base, app
  password, or TLS mode changes and closing the sessions of services that have gone away.
  Read-only: no write endpoint is ever called.
```

Amend the existing `servicesStore.js` bullet to mention the fourth kind and the sealed password, and the `serviceCheck.js` bullet to mention the `auth` state:

```markdown
  … each tile carries a `section` — services|infrastructure — plus a free-text `group` category
  within it, and a check kind of http|tcp|pihole|none. A `pihole` tile also carries an
  AES-256-GCM-sealed app password (redacted to `hasPassword` on every read; `getServiceSecret`
  is the sole decrypting path) and renders as a double-width stat card rather than a lamp.
  A Pi-hole that answers but rejects the password resolves to a distinct `auth` state on the
  violet `.dot.auth` lamp, not `down` — a rotated password is not an outage.
```

In the self-contained-principle section, move `services.json` into the "can hold a secret" class:

```markdown
`services.json` (standby-dashboard service tiles; a `pihole` tile's app token is **encrypted**,
so unlike the rest of the file it never appears in the clear)
```

- [ ] **Step 2: Update the security notes**

Add to the Security notes section of both files:

```markdown
- A Pi-hole tile's app password is sealed the same way as the Proxmox and NetBox tokens
  (AES-256-GCM in `data/services.json`, key from `cookieSecret`, file `0o600`) and is never
  returned to the browser (`hasPassword` only). Unlike the `http`/`tcp` liveness checks — which
  always set `rejectUnauthorized: false` because they send no credentials — the Pi-hole check
  sends a password, so its TLS is **verified by default** with an explicit per-service
  `insecure` opt-in. The session id lives in memory only, never on disk, and is revoked on
  shutdown. Use a Pi-hole **app password** (Settings → Web interface / API), not the web login
  password: an app password is unaffected by two-factor authentication and is scoped to the API.
```

- [ ] **Step 3: Update `README.md`**

Add to the services/dashboard section:

```markdown
### Pi-hole tiles

A service tile whose check is **Pi-hole** reads the Pi-hole v6 API and renders a card with
blocking status, queries today, blocked share, active/total clients, gravity domain count,
version, and uptime instead of a plain up/down lamp.

1. On the Pi-hole, go to **Settings → Web interface / API → Configure app password** and create
   an app password. (The web login password also authenticates, but an app password is scoped
   to the API and keeps working when two-factor is enabled.)
2. In Tmuxifier, open **Settings → Services**, add or edit the tile, choose the **Pi-hole**
   check, and paste the app password. Leave the API base URL blank unless the API lives
   somewhere other than the tile's link URL.
3. Press **Test connection** to confirm before saving.

The password is encrypted at rest and never sent back to the browser. TLS is verified unless
you tick "Allow a self-signed certificate". Pi-hole v5 (`admin/api.php`) is not supported.
```

- [ ] **Step 4: Verify no real PII entered the docs**

Run: `git diff -- CLAUDE.md AGENTS.md README.md | grep -niE '[0-9]{1,3}(\.[0-9]{1,3}){3}|[a-z0-9.-]+@[a-z0-9.-]+\.[a-z]{2,}|https?://[a-z0-9.-]+'`
Expected: only `example.com` hostnames and RFC1918 addresses (`192.168.1.x`). Any real domain, public IP, or email address is a leak and must be replaced with a placeholder before committing.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs(pihole): document the pihole check kind, its card, and its secret handling"
```

---

## Final verification

- [ ] `npm test` — typecheck plus every unit and integration test passes.
- [ ] `npm run build` — the web bundle builds.
- [ ] Live validation per `CLAUDE.md`'s shipping rules: build in the worktree, `rsync -a --delete <worktree>/dist/ ./dist/`, restart the service (mandatory even for client-only changes), and confirm one hashed asset returns its real content-type. Wait until no setup/provision/lifecycle/fleet/voice-install job is `running` before restarting.
- [ ] In the live app: add the app password to the existing Pi-hole tile, press **Test connection**, save, and confirm the card paints all six readings within one sweep (30s).
- [ ] Confirm `data/services.json` contains no plaintext password and is mode `0600`.
- [ ] Only after live validation: merge to main and run the release checklist in `CLAUDE.md`.
