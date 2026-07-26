# Standby Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty-stage standby screen with a homepage.dev-style dashboard: service tiles (new entity with server-side HTTP/TCP checks), a fleet overview, and a Proxmox/NetBox readout, in the Bench Instrument visual language.

**Architecture:** A new `services` vertical mirroring the boxes pattern — `servicesStore.js` (atomic JSON CRUD), `serviceCheck.js` (pure check engine), `serviceChecker.js` (interval poller with cached snapshot, modeled on `statusPoller.js`) — plus auth-gated CRUD/status routes, a cached `/api/netbox/summary` route, and a client `dashboard.ts` (pure view-model + in-place-updating DOM) mounted where `emptyStagePanel()` renders today. Spec: `docs/superpowers/specs/2026-07-26-standby-dashboard-design.md`.

**Tech Stack:** Node 20+ ESM, Fastify, dependency-free `node:http/https/net` checks, vitest (node environment — client tests are pure functions only), TypeScript + Vite for `src/web/`, Playwright e2e.

## Global Constraints

- ESM everywhere; server is plain `.js`, web client is `.ts`.
- TDD with real code, not mocks — dependency-injected fakes are the house style (see `test/statusPoller.test.js`).
- vitest `environment: 'node'`: no DOM in unit tests; client DOM work is validated by typecheck, e2e, and live validation.
- Public repo: committed code/docs/tests use placeholders only (`example.com`, RFC1918 like `192.168.1.10`, `you@example.com`).
- Every color/size in new CSS comes from the existing `:root` custom properties in `src/web/style.css` (the DESIGN.md tokens in code). Read the actual `:root` block first and use the real variable names; the CSS below names the intent.
- One conventional-commit per task. Do not bump the version — release happens after live validation per CLAUDE.md's Shipping section.
- New persisted file `data/services.json` is gitignored already via `data/` — verify, never commit it.
- Execute in an isolated worktree (superpowers:using-git-worktrees) branched from `main`.

---

### Task 1: `serviceCheck.js` — pure HTTP/TCP check engine

**Files:**
- Create: `src/server/serviceCheck.js`
- Test: `test/serviceCheck.test.js`

**Interfaces:**
- Consumes: nothing project-internal (`node:http`, `node:https`, `node:net`).
- Produces: `checkHttp(url, { timeoutMs } = {})`, `checkTcp(target, { timeoutMs } = {})`, `checkService(service, opts)` — each resolving `{ state: 'up' | 'down', latencyMs?: number, error?: string }`; `checkService` resolves `null` for `check.kind === 'none'`. Never rejects.

- [ ] **Step 1: Write the failing test**

```js
// test/serviceCheck.test.js
import { test, expect } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkHttp, checkTcp, checkService } from '../src/server/serviceCheck.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('checkHttp: 2xx is up with a latency', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  const r = await checkHttp(`http://127.0.0.1:${port}/`);
  server.close();
  expect(r.state).toBe('up');
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
});

test('checkHttp: 3xx is up without following the redirect', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.writeHead(302, { location: '/elsewhere' }); res.end(); });
  const port = await listen(server);
  const r = await checkHttp(`http://127.0.0.1:${port}/`);
  server.close();
  expect(r.state).toBe('up');
  expect(hits).toBe(1); // no follow
});

test('checkHttp: 5xx is down with the status in the error', async () => {
  const server = http.createServer((_req, res) => { res.statusCode = 503; res.end(); });
  const port = await listen(server);
  const r = await checkHttp(`http://127.0.0.1:${port}/`);
  server.close();
  expect(r).toMatchObject({ state: 'down', error: 'http 503' });
});

test('checkHttp: an unresponsive server times out as down', async () => {
  const server = http.createServer(() => { /* never respond */ });
  const port = await listen(server);
  const r = await checkHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 200 });
  server.close();
  expect(r.state).toBe('down');
  expect(r.error).toMatch(/timeout|socket hang up|aborted/i);
});

test('checkHttp: connection refused is down, not a throw', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await new Promise((r) => server.close(r)); // port now closed
  const r = await checkHttp(`http://127.0.0.1:${port}/`);
  expect(r.state).toBe('down');
});

test('checkHttp: an unparseable URL is down, not a throw', async () => {
  expect((await checkHttp('not a url')).state).toBe('down');
});

test('checkHttp: self-signed HTTPS is up (liveness probe, not a security boundary)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-cert-'));
  try {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1']);
  } catch { return; } // no openssl binary here — the sweep against real self-signed hosts covers this in live validation
  const server = https.createServer({
    key: await fs.readFile(path.join(dir, 'key.pem')),
    cert: await fs.readFile(path.join(dir, 'cert.pem')),
  }, (_req, res) => res.end('ok'));
  const port = await listen(server);
  const r = await checkHttp(`https://127.0.0.1:${port}/`);
  server.close();
  expect(r.state).toBe('up');
});

test('checkTcp: connect succeeds is up', async () => {
  const server = net.createServer(() => {});
  const port = await listen(server);
  const r = await checkTcp(`127.0.0.1:${port}`);
  server.close();
  expect(r.state).toBe('up');
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
});

test('checkTcp: refused port is down', async () => {
  const server = net.createServer(() => {});
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  expect((await checkTcp(`127.0.0.1:${port}`)).state).toBe('down');
});

test('checkTcp: malformed target is down', async () => {
  expect((await checkTcp('nonsense')).state).toBe('down');
});

test('checkService dispatches by kind and skips none', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  const up = await checkService({ url: `http://127.0.0.1:${port}/`, check: { kind: 'http' } });
  const viaTarget = await checkService({ url: 'http://unused.example.com/', check: { kind: 'http', target: `http://127.0.0.1:${port}/` } });
  server.close();
  expect(up.state).toBe('up');
  expect(viaTarget.state).toBe('up');
  expect(await checkService({ url: 'http://x.example.com/', check: { kind: 'none' } })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/serviceCheck.test.js`
Expected: FAIL — cannot find module `../src/server/serviceCheck.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/server/serviceCheck.js
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Liveness probes for the standby dashboard's service tiles. Every failure
// mode resolves to a `down` result — a check never throws, so one bad
// service can't poison a sweep. TLS certificate errors are tolerated on
// purpose: this is a reachability probe, not a security boundary, and it
// shares nothing with the pinned Proxmox/NetBox API clients.
const DEFAULT_TIMEOUT_MS = 5000;

export function checkHttp(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve({ state: 'down', error: 'invalid url' }); return; }
    const started = Date.now();
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const latencyMs = Date.now() - started;
      res.resume(); // discard the body — up/down is decided by the status line
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      done(ok
        ? { state: 'up', latencyMs }
        : { state: 'down', latencyMs, error: `http ${res.statusCode}` });
      req.destroy();
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done({ state: 'down', error: err?.message || 'request failed' }));
  });
}

export function checkTcp(target, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const m = /^(.+):(\d+)$/.exec(String(target || ''));
    if (!m) { resolve({ state: 'down', error: 'invalid target' }); return; }
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host: m[1], port: Number(m[2]) });
    const done = (result) => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done({ state: 'up', latencyMs: Date.now() - started }));
    socket.on('timeout', () => done({ state: 'down', error: 'timeout' }));
    socket.on('error', (err) => done({ state: 'down', error: err?.message || 'connect failed' }));
  });
}

export async function checkService(service, opts = {}) {
  const kind = service?.check?.kind || 'http';
  if (kind === 'none') return null;
  if (kind === 'tcp') return checkTcp(service.check?.target, opts);
  return checkHttp(service.check?.target || service.url, opts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/serviceCheck.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/serviceCheck.js test/serviceCheck.test.js
git commit -m "feat(services): dependency-free HTTP/TCP liveness check engine"
```

---

### Task 2: `servicesStore.js` — service CRUD over `data/services.json`

**Files:**
- Create: `src/server/servicesStore.js`
- Test: `test/servicesStore.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson` from `src/server/jsonFile.js`.
- Produces: `createServicesStore({ dataDir })` → `{ listServices(): Promise<Service[]>, getService(id), addService(spec), updateService(id, patch), removeService(id) }`. A Service is `{ id: 'svc-<uuid>', name, url, glyph?, group?, check: { kind: 'http'|'tcp'|'none', target? }, createdAt }`. `updateService` merges the patch onto the stored service and re-validates the whole result (spec's PATCH semantics); passing `null` for `glyph`/`group` clears the field.

- [ ] **Step 1: Write the failing test**

```js
// test/servicesStore.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServicesStore } from '../src/server/servicesStore.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-svc-'));
  store = createServicesStore({ dataDir: dir });
});

const spec = { name: 'Grafana', url: 'https://192.168.1.20:3000/', glyph: '', group: 'Monitoring' };

test('addService normalizes, defaults check to http, and round-trips', async () => {
  const svc = await store.addService(spec);
  expect(svc.id).toMatch(/^svc-/);
  expect(svc.check).toEqual({ kind: 'http' });
  expect(svc.createdAt).toBeTruthy();
  expect(await store.listServices()).toEqual([svc]);
  expect(await store.getService(svc.id)).toEqual(svc);
});

test('name is required, trimmed, and capped at 64 chars', async () => {
  await expect(store.addService({ ...spec, name: '  ' })).rejects.toThrow(/name/);
  await expect(store.addService({ ...spec, name: 'x'.repeat(65) })).rejects.toThrow(/name/);
  const svc = await store.addService({ ...spec, name: '  Grafana  ' });
  expect(svc.name).toBe('Grafana');
});

test('url must be http(s)', async () => {
  await expect(store.addService({ ...spec, url: 'ftp://example.com/' })).rejects.toThrow(/http/);
  await expect(store.addService({ ...spec, url: 'nonsense' })).rejects.toThrow(/URL/);
});

test('glyph is capped at 4 UTF-16 units; group at 32 chars', async () => {
  await expect(store.addService({ ...spec, glyph: 'abcde' })).rejects.toThrow(/glyph/);
  await expect(store.addService({ ...spec, group: 'g'.repeat(33) })).rejects.toThrow(/group/);
});

test('tcp check requires a validated host:port target', async () => {
  const ok = await store.addService({ ...spec, check: { kind: 'tcp', target: '192.168.1.20:53' } });
  expect(ok.check).toEqual({ kind: 'tcp', target: '192.168.1.20:53' });
  await expect(store.addService({ ...spec, check: { kind: 'tcp' } })).rejects.toThrow(/target/);
  await expect(store.addService({ ...spec, check: { kind: 'tcp', target: 'bad host:53' } })).rejects.toThrow(/host/);
  await expect(store.addService({ ...spec, check: { kind: 'tcp', target: '-evil.example.com:53' } })).rejects.toThrow(/host/);
  await expect(store.addService({ ...spec, check: { kind: 'tcp', target: '192.168.1.20:99999' } })).rejects.toThrow(/port/);
});

test('http check accepts an optional target URL; none refuses a target', async () => {
  const probe = await store.addService({ ...spec, check: { kind: 'http', target: 'http://192.168.1.20:3000/health' } });
  expect(probe.check.target).toBe('http://192.168.1.20:3000/health');
  await expect(store.addService({ ...spec, check: { kind: 'http', target: 'nonsense' } })).rejects.toThrow(/URL/);
  await expect(store.addService({ ...spec, check: { kind: 'none', target: 'http://x.example.com/' } })).rejects.toThrow(/none/);
});

test('updateService merges the patch and re-validates the whole result', async () => {
  const svc = await store.addService(spec);
  const upd = await store.updateService(svc.id, { name: 'Grafana 2' });
  expect(upd).toMatchObject({ id: svc.id, name: 'Grafana 2', url: spec.url, createdAt: svc.createdAt });
  await expect(store.updateService(svc.id, { url: 'nonsense' })).rejects.toThrow(/URL/);
  await expect(store.updateService('svc-missing', { name: 'x' })).rejects.toThrow(/not found/);
});

test('null clears glyph and group', async () => {
  const svc = await store.addService(spec);
  const upd = await store.updateService(svc.id, { glyph: null, group: null });
  expect(upd.glyph).toBeUndefined();
  expect(upd.group).toBeUndefined();
});

test('removeService deletes; a corrupt file quarantines and reads as empty', async () => {
  const svc = await store.addService(spec);
  await store.removeService(svc.id);
  expect(await store.listServices()).toEqual([]);
  await fs.writeFile(path.join(dir, 'services.json'), '{nope');
  expect(await store.listServices()).toEqual([]); // fail-open per jsonFile contract
  const files = await fs.readdir(dir);
  expect(files.some((f) => f.startsWith('services.json.corrupt-'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/servicesStore.test.js`
Expected: FAIL — cannot find module `../src/server/servicesStore.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/server/servicesStore.js
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';

// CRUD for the standby dashboard's service tiles (data/services.json), in the
// mold of store.js: normalize+validate inside, mutations serialized so two
// concurrent read-modify-write cycles can't drop each other's change.
const KINDS = ['http', 'tcp', 'none'];
const SAFE_TCP_HOST = /^[A-Za-z0-9_.-]+$/; // same family as sshCommand.js SAFE_HOST

function assertHttpUrl(value, label) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${label} must be http(s)`);
}

function normalizeCheck(raw, base) {
  const merged = { ...(base || {}), ...(raw || {}) };
  const kind = merged.kind ?? 'http';
  if (!KINDS.includes(kind)) throw new Error('check.kind must be http, tcp, or none');
  const target = typeof merged.target === 'string' ? merged.target.trim() : '';
  if (kind === 'http') {
    if (!target) return { kind };
    assertHttpUrl(target, 'check.target');
    return { kind, target };
  }
  if (kind === 'tcp') {
    const m = /^(.+):(\d+)$/.exec(target);
    if (!m) throw new Error('tcp check requires a target of the form host:port');
    const host = m[1];
    const port = Number(m[2]);
    if (!SAFE_TCP_HOST.test(host) || host.startsWith('-')) throw new Error(`unsafe tcp host: ${JSON.stringify(host)}`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid tcp port: ${m[2]}`);
    return { kind, target };
  }
  if (target) throw new Error("check.target must be absent for kind 'none'");
  return { kind };
}

function optionalString(value, base, { label, max }) {
  if (value === null) return undefined; // explicit clear
  const raw = value ?? base;
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (s.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return s;
}

export function createServicesStore({ dataDir }) {
  const file = path.join(dataDir, 'services.json');
  const valid = (v) => !!v && typeof v === 'object' && Array.isArray(v.services);

  async function readAll() {
    return (await readJson(file, { fallback: { version: 1, services: [] }, validate: valid })).services;
  }
  async function writeAll(services) {
    await writeJson(file, { version: 1, services });
  }

  function normalize(spec, base = {}) {
    const name = String(spec.name ?? base.name ?? '').trim();
    if (!name || name.length > 64) throw new Error('service name is required (1-64 characters)');
    const url = String(spec.url ?? base.url ?? '').trim();
    assertHttpUrl(url, 'service url');
    const out = {
      id: base.id || `svc-${randomUUID()}`,
      name,
      url,
      check: normalizeCheck(spec.check, base.check),
      createdAt: base.createdAt || new Date().toISOString(),
    };
    const glyph = optionalString(spec.glyph, base.glyph, { label: 'glyph', max: 4 });
    if (glyph !== undefined) out.glyph = glyph;
    const group = optionalString(spec.group, base.group, { label: 'group', max: 32 });
    if (group !== undefined) out.group = group;
    return out;
  }

  // Same serialization seam as store.js: mutations queue, reads stay free.
  let queue = Promise.resolve();
  function serialize(op) {
    const run = queue.then(op, op);
    queue = run.then(() => {}, () => {});
    return run;
  }

  return {
    async listServices() { return readAll(); },
    async getService(id) { return (await readAll()).find((s) => s.id === id); },
    async addService(spec) {
      return serialize(async () => {
        const services = await readAll();
        const svc = normalize(spec || {});
        services.push(svc);
        await writeAll(services);
        return svc;
      });
    },
    async updateService(id, patch) {
      return serialize(async () => {
        const services = await readAll();
        const index = services.findIndex((s) => s.id === id);
        if (index === -1) throw new Error('service not found');
        services[index] = normalize(patch || {}, services[index]);
        await writeAll(services);
        return services[index];
      });
    },
    async removeService(id) {
      return serialize(async () => {
        const services = await readAll();
        await writeAll(services.filter((s) => s.id !== id));
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/servicesStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/servicesStore.js test/servicesStore.test.js
git commit -m "feat(services): services.json store with validated CRUD"
```

---

### Task 3: `serviceChecker.js` — interval poller with cached snapshot

**Files:**
- Create: `src/server/serviceChecker.js`
- Test: `test/serviceChecker.test.js`

**Interfaces:**
- Consumes: a services store (`listServices()`), `checkService` (injected as `check`), `mapWithConcurrency` from `src/server/concurrency.js`.
- Produces: `createServiceChecker({ store, check, intervalMs = 30000, concurrency = 8, setIntervalFn, clearIntervalFn })` → `{ pollOnce(), getSnapshot(), start(), stop() }`. Snapshot: `{ checkedAt: string | null, results: { [id]: { state, latencyMs?, error? } } }`. `intervalMs` clamps to ≥5000.

- [ ] **Step 1: Write the failing test**

```js
// test/serviceChecker.test.js
import { test, expect } from 'vitest';
import { createServiceChecker } from '../src/server/serviceChecker.js';

const fakeStore = (services) => ({ listServices: async () => services });
const upCheck = async () => ({ state: 'up', latencyMs: 5 });

test('pollOnce builds a snapshot keyed by service id and stamps checkedAt', async () => {
  const store = fakeStore([
    { id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'http' } },
    { id: 'svc-b', url: 'http://b.example.com/', check: { kind: 'tcp', target: 'b.example.com:53' } },
  ]);
  const checker = createServiceChecker({ store, check: upCheck });
  expect(checker.getSnapshot()).toEqual({ checkedAt: null, results: {} });
  const snap = await checker.pollOnce();
  expect(Object.keys(snap.results).sort()).toEqual(['svc-a', 'svc-b']);
  expect(snap.results['svc-a']).toEqual({ state: 'up', latencyMs: 5 });
  expect(typeof snap.checkedAt).toBe('string');
  expect(checker.getSnapshot()).toBe(snap);
});

test("kind 'none' services are never probed and absent from results", async () => {
  const calls = [];
  const store = fakeStore([
    { id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'none' } },
    { id: 'svc-b', url: 'http://b.example.com/', check: { kind: 'http' } },
  ]);
  const checker = createServiceChecker({ store, check: async (s) => { calls.push(s.id); return { state: 'up' }; } });
  const snap = await checker.pollOnce();
  expect(calls).toEqual(['svc-b']);
  expect(snap.results['svc-a']).toBeUndefined();
});

test('getSnapshot never triggers checks; a wholesale swap drops removed services', async () => {
  let services = [{ id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'http' } }];
  let calls = 0;
  const checker = createServiceChecker({
    store: { listServices: async () => services },
    check: async () => { calls++; return { state: 'up' }; },
  });
  await checker.pollOnce();
  for (let i = 0; i < 5; i++) checker.getSnapshot();
  expect(calls).toBe(1);
  services = [];
  const snap = await checker.pollOnce();
  expect(snap.results).toEqual({});
});

test('bounded concurrency', async () => {
  let inFlight = 0, peak = 0;
  const services = Array.from({ length: 9 }, (_, i) => ({ id: `svc-${i}`, url: 'http://x.example.com/', check: { kind: 'http' } }));
  const checker = createServiceChecker({
    store: fakeStore(services),
    concurrency: 3,
    check: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; return { state: 'up' };
    },
  });
  await checker.pollOnce();
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(3);
});

test('overlapping pollOnce calls coalesce', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let probes = 0;
  const checker = createServiceChecker({
    store: fakeStore([{ id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'http' } }]),
    check: async () => { probes++; await gate; return { state: 'up' }; },
  });
  const p1 = checker.pollOnce();
  const p2 = checker.pollOnce();
  release();
  const [s1, s2] = await Promise.all([p1, p2]);
  expect(probes).toBe(1);
  expect(s1).toBe(s2);
});

test('start polls immediately then schedules; stop clears; interval clamps to 5000', async () => {
  let calls = 0; const scheduled = []; let cleared = null;
  const checker = createServiceChecker({
    store: fakeStore([{ id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'http' } }]),
    check: async () => { calls++; return { state: 'up' }; },
    intervalMs: 1, // clamps up to 5000
    setIntervalFn: (fn, ms) => { scheduled.push(ms); return 42; },
    clearIntervalFn: (id) => { cleared = id; },
  });
  await checker.start();
  expect(calls).toBe(1);
  expect(scheduled).toEqual([5000]);
  checker.stop();
  expect(cleared).toBe(42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/serviceChecker.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```js
// src/server/serviceChecker.js
import { mapWithConcurrency } from './concurrency.js';
import { checkService } from './serviceCheck.js';

// One server-side sweep loop for service liveness, modeled on statusPoller.js:
// the /api/services/status handler serves the cached snapshot, so check volume
// is independent of how many dashboard tabs are open. Nothing is persisted —
// the dashboard is current-state-only by design.
export function createServiceChecker({
  store, check = checkService, intervalMs = 30000, concurrency = 8,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  const everyMs = Math.max(5000, Number(intervalMs) || 30000);
  let snapshot = { checkedAt: null, results: {} };
  let timer = null;
  let inFlight = null;

  function pollOnce() {
    if (inFlight) return inFlight; // coalesce overlapping sweeps (see statusPoller.js)
    inFlight = (async () => {
      const services = (await store.listServices()).filter((s) => s?.check?.kind !== 'none');
      const next = {};
      await mapWithConcurrency(services, concurrency, async (s) => {
        next[s.id] = await check(s);
      });
      snapshot = { checkedAt: new Date().toISOString(), results: next };
      return snapshot;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    pollOnce,
    getSnapshot: () => snapshot,
    async start() {
      await pollOnce();
      timer = setIntervalFn(() => { pollOnce().catch(() => {}); }, everyMs);
      return timer;
    },
    stop() {
      if (timer != null) { clearIntervalFn(timer); timer = null; }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/serviceChecker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/serviceChecker.js test/serviceChecker.test.js
git commit -m "feat(services): interval check sweep with cached snapshot"
```

---

### Task 4: `servicePollMs` config knob

**Files:**
- Modify: `src/server/config.js` (defaults object: add `servicePollMs: 30000` next to `statusPollMs`; env mapping: add the `TMUXIFIER_SERVICE_POLL_MS` line next to `statusPollMs`'s)
- Modify: `.env.example` (new commented entry, matching the file's existing comment style)
- Test: `test/config.test.js` (append)

**Interfaces:**
- Produces: `loadConfig(...).servicePollMs` — default `30000`, overridable via `TMUXIFIER_SERVICE_POLL_MS` (and `servicePollMs` in `config.json` for free, via the camelCase merge).

- [ ] **Step 1: Write the failing test** — append to `test/config.test.js`, following its existing injected `{ env, cwd }` style (read the top of the file for the exact `cwd` fixture it uses; use the same):

```js
test('servicePollMs defaults to 30000 and reads TMUXIFIER_SERVICE_POLL_MS', () => {
  expect(loadConfig({}, { env: {}, cwd: '/nonexistent' }).servicePollMs).toBe(30000);
  expect(loadConfig({}, { env: { TMUXIFIER_SERVICE_POLL_MS: '12000' }, cwd: '/nonexistent' }).servicePollMs).toBe(12000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `servicePollMs` is `undefined`.

- [ ] **Step 3: Implement** — in `src/server/config.js`, add to the defaults object (beside `statusPollMs: 30000`):

```js
  servicePollMs: 30000,
```

and to the env mapping (beside the `statusPollMs` line):

```js
    servicePollMs: e.TMUXIFIER_SERVICE_POLL_MS ? Number(e.TMUXIFIER_SERVICE_POLL_MS) : undefined,
```

and to `.env.example` (near the status-poll entry, same commented format as its neighbors):

```
# Interval between dashboard service health-check sweeps in ms (min 5000).
# TMUXIFIER_SERVICE_POLL_MS=30000
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.js test/config.test.js .env.example
git commit -m "feat(config): TMUXIFIER_SERVICE_POLL_MS service sweep interval"
```

---

### Task 5: service routes + boot wiring

**Files:**
- Modify: `src/server/server.js` (buildServer deps + a services route block after the boxes routes)
- Modify: `src/server/index.js` (construct store+checker, pass to buildServer, start after listen)
- Test: `test/serviceRoutes.test.js`

**Interfaces:**
- Consumes: `createServicesStore` (Task 2), `createServiceChecker` (Task 3), `checkService` (Task 1).
- Produces routes: `GET /api/services` → `Service[]`; `POST /api/services` → created Service (400 `{error}` on invalid); `PATCH /api/services/:id` → updated Service (400 invalid / 404 unknown); `DELETE /api/services/:id` → `{ok:true}`; `GET /api/services/status` → the checker snapshot. All `preHandler: requireAuth`.
- buildServer signature gains `servicesStore = null, serviceChecker = null` (default null so existing tests keep building).

- [ ] **Step 1: Write the failing test**

```js
// test/serviceRoutes.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createServicesStore } from '../src/server/servicesStore.js';
import { createServiceChecker } from '../src/server/serviceChecker.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, servicesStore, serviceChecker;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-svcr-'));
  servicesStore = createServicesStore({ dataDir: dir });
  serviceChecker = createServiceChecker({
    store: servicesStore,
    check: async () => ({ state: 'up', latencyMs: 7 }),
  });
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({ config, store: createStore({ dataDir: dir }), sessions, statusChecker, servicesStore, serviceChecker });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('service routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/services' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/services', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'PATCH', url: '/api/services/svc-x', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'DELETE', url: '/api/services/svc-x' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/services/status' })).statusCode).toBe(401);
});

test('CRUD round-trip with validation errors as 400 and unknown id as 404', async () => {
  const h = await headers();
  const bad = await app.inject({ method: 'POST', url: '/api/services', headers: h, payload: { name: 'X', url: 'nonsense' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/URL/);

  const created = await app.inject({ method: 'POST', url: '/api/services', headers: h, payload: { name: 'Grafana', url: 'http://192.168.1.20:3000/', group: 'Mon' } });
  expect(created.statusCode).toBe(200);
  const svc = created.json();

  const listed = await app.inject({ method: 'GET', url: '/api/services', headers: h });
  expect(listed.json()).toEqual([svc]);

  const patched = await app.inject({ method: 'PATCH', url: `/api/services/${svc.id}`, headers: h, payload: { name: 'Grafana 2' } });
  expect(patched.json()).toMatchObject({ id: svc.id, name: 'Grafana 2', url: svc.url });

  expect((await app.inject({ method: 'PATCH', url: '/api/services/svc-missing', headers: h, payload: { name: 'x' } })).statusCode).toBe(404);

  const removed = await app.inject({ method: 'DELETE', url: `/api/services/${svc.id}`, headers: h });
  expect(removed.json()).toEqual({ ok: true });
  expect((await app.inject({ method: 'GET', url: '/api/services', headers: h })).json()).toEqual([]);
});

test('status route serves the cached snapshot without triggering checks', async () => {
  const h = await headers();
  await app.inject({ method: 'POST', url: '/api/services', headers: h, payload: { name: 'A', url: 'http://a.example.com/' } });
  const before = await app.inject({ method: 'GET', url: '/api/services/status', headers: h });
  expect(before.json()).toEqual({ checkedAt: null, results: {} }); // nothing swept yet
  await serviceChecker.pollOnce();
  const after = await app.inject({ method: 'GET', url: '/api/services/status', headers: h });
  expect(Object.values(after.json().results)).toEqual([{ state: 'up', latencyMs: 7 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/serviceRoutes.test.js`
Expected: FAIL — routes 404 (`/api/services` not registered).

- [ ] **Step 3: Implement** — in `src/server/server.js`:

Add to the buildServer destructured parameter list (anywhere among the existing deps): `servicesStore = null, serviceChecker = null`.

Add this block directly after the `/api/import` route (the end of the boxes block):

```js
  // --- Standby dashboard services (tiles + cached liveness snapshot) ---
  app.get('/api/services', { preHandler: requireAuth }, async () => servicesStore.listServices());
  app.post('/api/services', { preHandler: requireAuth }, async (req, reply) => {
    try { return await servicesStore.addService(req.body || {}); }
    catch (e) { reply.code(400); return { error: e.message }; }
  });
  app.patch('/api/services/:id', { preHandler: requireAuth }, async (req, reply) => {
    try { return await servicesStore.updateService(req.params.id, req.body || {}); }
    catch (e) { reply.code(/not found/.test(e.message) ? 404 : 400); return { error: e.message }; }
  });
  app.delete('/api/services/:id', { preHandler: requireAuth }, async (req) => {
    await servicesStore.removeService(req.params.id);
    return { ok: true };
  });
  // Served purely from the sweep cache — a dashboard poll never triggers checks.
  app.get('/api/services/status', { preHandler: requireAuth }, async () => serviceChecker.getSnapshot());
```

In `src/server/index.js`: add imports

```js
import { createServicesStore } from './servicesStore.js';
import { createServiceChecker } from './serviceChecker.js';
```

construct beside the statusPoller construction:

```js
const servicesStore = createServicesStore({ dataDir: config.dataDir });
const serviceChecker = createServiceChecker({ store: servicesStore, intervalMs: config.servicePollMs });
```

add `servicesStore, serviceChecker` to the buildServer call's deps, and in the `.then()` after `statusPoller.start()`:

```js
    serviceChecker.start().catch((err) => console.error('service check sweep failed to start:', err));
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/serviceRoutes.test.js test/server.test.js test/bootExit.test.js`
Expected: PASS (including the pre-existing server tests — the new deps default to null).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js src/server/index.js test/serviceRoutes.test.js
git commit -m "feat(services): auth-gated CRUD + status routes, boot wiring"
```

---

### Task 6: NetBox summary helpers in `netboxApi.js`

**Files:**
- Modify: `src/server/netboxApi.js`
- Test: `test/netboxApi.test.js` (append)

**Interfaces:**
- Consumes: the existing `createNetboxClient(settings, { request, connect })` factory, `testNetbox`.
- Produces: `usableHostCount(prefixCidr)` (exported; `/24`→254, `/31`→2, `/32`→1); a new client method `countIpsInPrefix(prefixCidr)` (GET `/ipam/ip-addresses/?parent=<cidr>&limit=1`, returns the response's `count`); and `netboxSummary(settings, vids, { makeClient = createNetboxClient, test = testNetbox } = {})` → `{ configured: true, ok: boolean, error?: string, prefixes: { prefix, used, total }[] }`. With no vids it only runs `test` for reachability; with vids it resolves each unique vid via `findPrefixByVlan` + `countIpsInPrefix`.

- [ ] **Step 1: Write the failing tests** — append to `test/netboxApi.test.js`, following its existing injected-`request` style (read the file's existing `createNetboxClient(settings, { request })` tests first and mirror the settings fixture they use — TLS mode and URL — exactly):

```js
test('usableHostCount: standard, /31 and /32 prefixes', () => {
  expect(usableHostCount('192.168.50.0/24')).toBe(254);
  expect(usableHostCount('10.0.0.0/16')).toBe(65534);
  expect(usableHostCount('10.0.0.0/31')).toBe(2);
  expect(usableHostCount('10.0.0.0/32')).toBe(1);
  expect(() => usableHostCount('nonsense')).toThrow(/unparseable/);
});

test('netboxSummary with no vids only tests reachability', async () => {
  const summary = await netboxSummary({ url: 'https://netbox.example.com', token: 't' }, [], {
    test: async () => ({ ok: true, version: '4.3.2' }),
    makeClient: () => { throw new Error('must not build a client'); },
  });
  expect(summary).toEqual({ configured: true, ok: true, prefixes: [] });
});

test('netboxSummary resolves each unique vid to prefix utilization', async () => {
  const calls = [];
  const client = {
    findPrefixByVlan: async (vid) => { calls.push(vid); return { id: 9, prefix: '192.168.50.0/24' }; },
    countIpsInPrefix: async () => 12,
  };
  const summary = await netboxSummary({ url: 'https://netbox.example.com', token: 't' }, [50, 50], { makeClient: () => client });
  expect(calls).toEqual([50]); // deduplicated
  expect(summary).toEqual({ configured: true, ok: true, prefixes: [{ prefix: '192.168.50.0/24', used: 12, total: 254 }] });
});

test('netboxSummary reports a failure as ok:false, never throws', async () => {
  const summary = await netboxSummary({ url: 'https://netbox.example.com', token: 't' }, [50], {
    makeClient: () => ({ findPrefixByVlan: async () => { throw new Error('NetBox API error 502'); } }),
  });
  expect(summary).toMatchObject({ configured: true, ok: false, prefixes: [] });
  expect(summary.error).toMatch(/502/);
});

test('countIpsInPrefix queries ip-addresses by parent and returns count', async () => {
  const urls = [];
  const client = createNetboxClient(
    { url: 'https://netbox.example.com', token: 't', tlsMode: 'insecure' },
    { request: async ({ url }) => { urls.push(url); return { status: 200, json: { count: 37, results: [] } }; } },
  );
  expect(await client.countIpsInPrefix('192.168.50.0/24')).toBe(37);
  expect(urls[0]).toContain('/ipam/ip-addresses/?parent=192.168.50.0%2F24&limit=1');
});
```

Add `usableHostCount, netboxSummary` to the file's import from `../src/server/netboxApi.js`. If the file's existing client tests build settings differently (e.g. a helper or a different tlsMode that avoids the TLS probe), use that exact shape for the `countIpsInPrefix` test so no real connection is attempted.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/netboxApi.test.js`
Expected: FAIL — `usableHostCount`/`netboxSummary` not exported.

- [ ] **Step 3: Implement** — in `src/server/netboxApi.js`:

Next to `firstUsableIp`, add:

```js
// Usable host count for a v4 prefix — the denominator of the dashboard's
// utilization readout. /31 and /32 follow RFC 3021 semantics.
export function usableHostCount(prefixCidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(prefixCidr));
  if (!m) throw new Error(`unparseable prefix: ${prefixCidr}`);
  const len = Number(m[5]);
  if (len >= 31) return len === 31 ? 2 : 1;
  return 2 ** (32 - len) - 2;
}
```

Inside `createNetboxClient`'s returned object, add:

```js
    // Used-address count for the utilization readout: NetBox list responses
    // carry a total `count`, so limit=1 keeps the payload tiny.
    async countIpsInPrefix(prefixCidr) {
      const data = await call('GET', `/ipam/ip-addresses/?parent=${encodeURIComponent(prefixCidr)}&limit=1`);
      return data && typeof data.count === 'number' ? data.count : 0;
    },
```

At the end of the file, add:

```js
// The dashboard's NetBox readout: reachability plus per-prefix utilization for
// the VLANs the auto-static presets provision into. Result-shaped — a failing
// NetBox degrades the readout, it must never throw into the route.
export async function netboxSummary(settings, vids, { makeClient = createNetboxClient, test = testNetbox } = {}) {
  const unique = [...new Set((vids || []).filter((v) => v != null))];
  if (unique.length === 0) {
    const probe = await test(settings);
    return probe.ok
      ? { configured: true, ok: true, prefixes: [] }
      : { configured: true, ok: false, error: probe.error, prefixes: [] };
  }
  try {
    const client = makeClient(settings);
    const prefixes = [];
    for (const vid of unique) {
      const found = await client.findPrefixByVlan(vid);
      prefixes.push({ prefix: found.prefix, used: await client.countIpsInPrefix(found.prefix), total: usableHostCount(found.prefix) });
    }
    return { configured: true, ok: true, prefixes };
  } catch (e) {
    return { configured: true, ok: false, error: e?.message || 'summary failed', prefixes: [] };
  }
}
```

(If `testNetbox` is declared below this point in the file, place `netboxSummary` after it — it must close over the real `testNetbox`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/netboxApi.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/netboxApi.js test/netboxApi.test.js
git commit -m "feat(netbox): prefix-utilization summary helpers"
```

---

### Task 7: `GET /api/netbox/summary` route with 60s cache

**Files:**
- Modify: `src/server/server.js`
- Test: `test/netboxRoutes.test.js` (append)

**Interfaces:**
- Consumes: `netboxSummary` (Task 6), `netboxStore.getSettings({ withSecret: true })`, `proxmoxStore.listPresets()` (presets carry `net.ipMode` / `net.vlan`), the existing `netboxTest` dep.
- Produces: `GET /api/netbox/summary` → `{ configured: false }` when NetBox is unset, else the Task 6 summary; results cached in-process for 60s. buildServer gains dep `netboxSummaryFn = netboxSummary`.

- [ ] **Step 1: Write the failing tests** — append to `test/netboxRoutes.test.js` (its fixture already builds `netboxStore` and injectable deps — reuse `baseDeps`):

```js
test('summary requires auth and reports unconfigured without settings', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/netbox/summary' })).statusCode).toBe(401);
  const h = await headers();
  expect((await app.inject({ method: 'GET', url: '/api/netbox/summary', headers: h })).json()).toEqual({ configured: false });
});

test('summary is served from the injected builder and cached for 60s', async () => {
  let calls = 0;
  const fresh = buildServer({
    ...baseDeps,
    netboxSummaryFn: async () => { calls++; return { configured: true, ok: true, prefixes: [{ prefix: '192.168.50.0/24', used: 12, total: 254 }] }; },
  });
  const h = await headers(fresh);
  await fresh.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 't0k' } });
  const first = await fresh.inject({ method: 'GET', url: '/api/netbox/summary', headers: h });
  expect(first.json().prefixes).toEqual([{ prefix: '192.168.50.0/24', used: 12, total: 254 }]);
  await fresh.inject({ method: 'GET', url: '/api/netbox/summary', headers: h });
  expect(calls).toBe(1); // second hit came from the cache
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/netboxRoutes.test.js`
Expected: FAIL — 404 on `/api/netbox/summary`.

- [ ] **Step 3: Implement** — in `src/server/server.js`:

Extend the netboxApi import: `import { testNetbox, createNetboxClient, netboxSummary } from './netboxApi.js';` and add `netboxSummaryFn = netboxSummary` to the buildServer deps.

Add after the `/api/netbox/next-ip` route:

```js
  // Dashboard readout. Cached in-process: the dashboard polls this once a
  // minute per tab, and the summary itself costs NetBox API calls.
  let netboxSummaryCache = { at: 0, value: null };
  app.get('/api/netbox/summary', { preHandler: requireAuth }, async () => {
    if (netboxSummaryCache.value && Date.now() - netboxSummaryCache.at < 60000) return netboxSummaryCache.value;
    let settings = null;
    try { settings = await netboxStore.getSettings({ withSecret: true }); } catch { /* corrupt store reads as absent */ }
    if (!settings) return { configured: false };
    const presets = proxmoxStore ? await proxmoxStore.listPresets() : [];
    const vids = presets
      .filter((p) => p?.net?.ipMode === 'auto-static' && p.net.vlan != null)
      .map((p) => p.net.vlan);
    const value = await netboxSummaryFn(settings, vids, { test: netboxTest });
    netboxSummaryCache = { at: Date.now(), value };
    return value;
  });
```

(Check where the existing netbox routes destructure their deps; `proxmoxStore` may be undefined in netbox-only tests — the `proxmoxStore ?` guard covers that.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/netboxRoutes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/netboxRoutes.test.js
git commit -m "feat(netbox): cached /api/netbox/summary readout route"
```

---

### Task 8: client types + fetch helpers

**Files:**
- Modify: `src/web/api.ts` (types + `api` methods)
- Modify: `src/web/netbox.ts` (summary type + `nbx.summary()`)

**Interfaces:**
- Produces (used by Tasks 9–11): types `ServiceCheckKind`, `ServiceCheck`, `Service`, `ServiceSpec`, `ServiceResult`, `ServiceStatusSnapshot`, `NetboxPrefixSummary`, `NetboxSummary`; methods `api.services()`, `api.addService(spec)`, `api.updateService(id, patch)`, `api.removeService(id)`, `api.servicesStatus()`, `nbx.summary()`.

- [ ] **Step 1: Implement** — in `src/web/api.ts`, next to the Box/Status types:

```ts
export type ServiceCheckKind = 'http' | 'tcp' | 'none';
export interface ServiceCheck { kind: ServiceCheckKind; target?: string }
export interface Service {
  id: string; name: string; url: string; glyph?: string; group?: string;
  check: ServiceCheck; createdAt: string;
}
export type ServiceSpec = Partial<Omit<Service, 'id' | 'createdAt'>>;
export interface ServiceResult { state: 'up' | 'down'; latencyMs?: number; error?: string }
export interface ServiceStatusSnapshot { checkedAt: string | null; results: Record<string, ServiceResult> }
```

and in the `api` object, next to the box methods:

```ts
  async services() { return j<Service[]>(await fetch('/api/services')); },
  async addService(spec: ServiceSpec) { return j<Service>(await fetch('/api/services', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) })); },
  async updateService(id: string, patch: ServiceSpec) {
    return j<Service>(await fetch(`/api/services/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
  },
  async removeService(id: string) { return j(await fetch(`/api/services/${id}`, { method: 'DELETE' })); },
  async servicesStatus() { return j<ServiceStatusSnapshot>(await fetch(`/api/services/status?t=${Date.now()}`)); },
```

In `src/web/netbox.ts`, next to the existing types and inside `nbx` (mirror its existing fetch style — it has its own `j`-like helper; use it):

```ts
export interface NetboxPrefixSummary { prefix: string; used: number; total: number }
export type NetboxSummary =
  | { configured: false }
  | { configured: true; ok: boolean; error?: string; prefixes: NetboxPrefixSummary[] };
```

```ts
  summary() { return /* the file's json-fetch helper */<NetboxSummary>(fetch(`/api/netbox/summary?t=${Date.now()}`)); },
```

(Replace the comment with the helper the file actually uses — it is visible at the top of `netbox.ts`, e.g. the same `jr`/`j` pattern `proxmox.ts` uses.)

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/web/api.ts src/web/netbox.ts
git commit -m "feat(web): service + netbox-summary types and fetch helpers"
```

---

### Task 9: `dashboard.ts` — pure view-model + DOM layer

**Files:**
- Create: `src/web/dashboard.ts`
- Test: `test/dashboard.test.js` (pure functions only — vitest runs in node, no DOM)

**Interfaces:**
- Consumes: types from Task 8, `Box`/`Status`/`Sample` from `api.ts`, `sparkline` from `sparkline.ts`, `dotClassFor`/`dotTitleFor` from `statusDot.ts`, `PveLinkedContainer` from `proxmox.ts`.
- Produces (used by Task 10):

```ts
export interface DashboardData {
  boxes: Box[]; status: Record<string, Status>; series: Record<string, Sample[]>;
  services: Service[]; serviceStatus: ServiceStatusSnapshot | null;
  containers: PveLinkedContainer[] | null; netbox: NetboxSummary | null;
}
export interface DashboardHooks { onOpenBox(id: string): void; onAddBox(): void; onAddService(): void }
export function createDashboard(hooks: DashboardHooks): { el: HTMLElement; update(patch: Partial<DashboardData>): void; destroy(): void }
// pure, exported for tests:
export function groupServices(services: Service[]): { name: string | null; services: Service[] }[]
export function fmtLatency(ms?: number): string
export function serviceLamp(svc: Service, snap: ServiceStatusSnapshot | null): 'up' | 'down' | 'unknown' | 'none'
export function dashboardMode(boxCount: number, serviceCount: number): 'standby' | 'dash'
export function pveHostRollup(containers: PveLinkedContainer[]): { hostName: string; running: number; stopped: number; other: number }[]
```

- [ ] **Step 1: Write the failing test**

```js
// test/dashboard.test.js
import { test, expect } from 'vitest';
import { groupServices, fmtLatency, serviceLamp, dashboardMode, pveHostRollup } from '../src/web/dashboard.ts';

const svc = (id, group, kind = 'http') => ({ id, name: id, url: 'http://x.example.com/', group, check: { kind }, createdAt: '' });

test('groupServices: ungrouped first, then groups in order of first appearance, stored order within', () => {
  const groups = groupServices([svc('a', 'Media'), svc('b', undefined), svc('c', 'Mon'), svc('d', 'Media')]);
  expect(groups.map((g) => g.name)).toEqual([null, 'Media', 'Mon']);
  expect(groups[1].services.map((s) => s.id)).toEqual(['a', 'd']);
});

test('fmtLatency: dash for missing, ms under a second, seconds above', () => {
  expect(fmtLatency(undefined)).toBe('—');
  expect(fmtLatency(12)).toBe('12ms');
  expect(fmtLatency(1234)).toBe('1.2s');
});

test('serviceLamp: none has no lamp, unknown before first sweep, else the result state', () => {
  const s = svc('a', undefined);
  expect(serviceLamp(svc('n', undefined, 'none'), null)).toBe('none');
  expect(serviceLamp(s, null)).toBe('unknown');
  expect(serviceLamp(s, { checkedAt: null, results: {} })).toBe('unknown');
  expect(serviceLamp(s, { checkedAt: 't', results: { a: { state: 'up', latencyMs: 5 } } })).toBe('up');
  expect(serviceLamp(s, { checkedAt: 't', results: { a: { state: 'down', error: 'http 503' } } })).toBe('down');
});

test('dashboardMode: standby only when there is nothing at all to show', () => {
  expect(dashboardMode(0, 0)).toBe('standby');
  expect(dashboardMode(1, 0)).toBe('dash');
  expect(dashboardMode(0, 1)).toBe('dash');
});

test('pveHostRollup groups containers per host with running/stopped counts', () => {
  const c = (hostName, state) => ({ hostName, state, boxId: 'b', boxLabel: 'b', hostId: 'h', node: 'n', vmid: 1, containerName: null, fetchedAt: 0, error: null, activeJob: null });
  expect(pveHostRollup([c('pve1', 'running'), c('pve1', 'stopped'), c('pve2', 'running'), c('pve1', 'unknown')])).toEqual([
    { hostName: 'pve1', running: 1, stopped: 1, other: 1 },
    { hostName: 'pve2', running: 1, stopped: 0, other: 0 },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `dashboard.ts`**

Pure helpers exactly as tested:

```ts
export function groupServices(services: Service[]): { name: string | null; services: Service[] }[] {
  const order: (string | null)[] = [];
  const byName = new Map<string | null, Service[]>();
  for (const s of services) {
    const name = s.group?.trim() || null;
    if (!byName.has(name)) { byName.set(name, []); order.push(name); }
    byName.get(name)!.push(s);
  }
  // Ungrouped first; the rest keep first-appearance order (stable sort).
  return order
    .sort((a, b) => (a === null ? -1 : b === null ? 1 : 0))
    .map((name) => ({ name, services: byName.get(name)! }));
}

export function fmtLatency(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function serviceLamp(svc: Service, snap: ServiceStatusSnapshot | null): 'up' | 'down' | 'unknown' | 'none' {
  if (svc.check.kind === 'none') return 'none';
  const r = snap?.results[svc.id];
  return r ? r.state : 'unknown';
}

export function dashboardMode(boxCount: number, serviceCount: number): 'standby' | 'dash' {
  return boxCount === 0 && serviceCount === 0 ? 'standby' : 'dash';
}

export function pveHostRollup(containers: PveLinkedContainer[]) {
  const order: string[] = [];
  const acc = new Map<string, { hostName: string; running: number; stopped: number; other: number }>();
  for (const c of containers) {
    const key = c.hostName ?? '(unnamed host)';
    if (!acc.has(key)) { acc.set(key, { hostName: key, running: 0, stopped: 0, other: 0 }); order.push(key); }
    const row = acc.get(key)!;
    if (c.state === 'running') row.running++;
    else if (c.state === 'stopped') row.stopped++;
    else row.other++;
  }
  return order.map((k) => acc.get(k)!);
}
```

DOM layer — the same in-place update contract as `paneHeader.ts` (poll ticks mutate, never rebuild wholesale). Structure:

```ts
export function createDashboard(hooks: DashboardHooks) {
  const data: DashboardData = { boxes: [], status: {}, series: {}, services: [], serviceStatus: null, containers: null, netbox: null };
  const el = document.createElement('div');
  el.className = 'dash';
  // Section containers created once; each repaint targets one section.
  const head = section('dash-head');       // standby prompt masthead (aria-hidden ~ $ + breathing cursor, reusing the .empty-prompt/.empty-cursor classes) + 'FLEET STANDBY' legend
  const standby = section('dash-standby'); // the degenerate hero: large prompt, 'No terminal attached', '+ Add box' keycap (click → hooks.onAddBox) — shown only in 'standby' mode
  const fleet = section('dash-fleet');     // legend 'FLEET' + one <button class="dash-box"> per box → hooks.onOpenBox(id)
  const services = section('dash-services'); // per group: legend + <a class="dash-tile" target="_blank" rel="noopener"> tiles; '+ add service' key → hooks.onAddService
  const infra = section('dash-infra');     // legend 'INFRASTRUCTURE' + PVE host modules + NetBox module
  el.append(head, standby, fleet, services, infra);

  // Per-entity element caches so update() mutates in place: hover and tooltips
  // survive poll repaints (the "never rebuilds whole rows" contract).
  const boxEls = new Map<string, HTMLElement>();
  const tileEls = new Map<string, HTMLElement>();
  ...
  function update(patch: Partial<DashboardData>) { Object.assign(data, patch); repaint(); }
  function destroy() { el.remove(); boxEls.clear(); tileEls.clear(); }
  return { el, update, destroy };
}
```

Rendering rules (implement in full):
- Mode from `dashboardMode(data.boxes.length, data.services.length)`: `standby` shows only `head`+`standby`; `dash` hides `standby`.
- **Fleet row per box:** lamp span with class from `dotClassFor(status[box.id])` and title from `dotTitleFor`; name; agent chip from the last sample of `series[box.id]` (`sample.agent === 'working'` → amber chip `WORKING`, `'waiting'` → orange chip `WAITING`, else no chip); session count from `status[box.id]?.sessions?.length`; an inline `<svg><path d={sparkline(series[box.id] ?? [], 'cpuPct')}/></svg>`. Reconcile: add missing rows, update existing in place, remove rows for vanished boxes.
- **Service tile:** `href` = `svc.url`, `target="_blank"`, `rel="noopener"`; glyph span (`svc.glyph ?? ''`); name; lamp class `dash-lamp-{up|down|unknown}` (no lamp element when `'none'`); latency text `fmtLatency(snap?.results[svc.id]?.latencyMs)`; on `down`, `title` = the result's `error`. Groups re-render via `groupServices`; tiles reconcile through `tileEls` keyed by id.
- **Services section header:** when a `servicesStatus` fetch has failed (Task 10 passes `serviceStatus: null` after a failure while keeping old tile paint), the section legend gets class `stale` — dimmed via CSS.
- **Infra:** hidden entirely when `containers === null` and `(netbox === null || !netbox.configured)`. PVE modules from `pveHostRollup(containers ?? [])` (`N running / M stopped`, `+K other` only when nonzero); when containers is an empty array, one dim module `no linked containers`. NetBox module when `netbox?.configured`: green lamp + one `prefix · used/total` readout line per entry when `ok`, red lamp + `—` figures when `!ok`.
- All text nodes/classes update in place (`textContent`, `classList.toggle`) — never `innerHTML` on poll ticks.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run test/dashboard.test.js && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/dashboard.ts test/dashboard.test.js
git commit -m "feat(web): standby dashboard view-model and DOM module"
```

---

### Task 10: `main.ts` integration — mount, polling lifecycle, teardown

**Files:**
- Modify: `src/web/main.ts`

**Interfaces:**
- Consumes: `createDashboard` (Task 9), `api.services`/`api.servicesStatus` (Task 8), `nbx.summary`, `pve.hosts`/`pve.linkedContainers`, existing `openPane`, `openBoxDialog`, `openSettingsModal`, `allBoxes`, `latestStatus`, `latestSeries`, `repaintStage`, `emptyStagePanel`.
- Produces: the dashboard mounted whenever `stageRoot == null`; a 10s services poll + 60s infra poll running only while mounted; `emptyStagePanel()` deleted (its standby content now lives in the dashboard's standby section).

- [ ] **Step 1: Implement.** All edits in `main.ts`:

1. Imports: `import { createDashboard } from './dashboard';` (plus `nbx` from `./netbox` and `pve` from `./proxmox` if not already imported).
2. Module-level state near the other stage state:

```ts
let dash: ReturnType<typeof createDashboard> | null = null;
let dashTimer: ReturnType<typeof setInterval> | null = null;
let dashTick = 0;

function ensureDash() {
  if (!dash) {
    dash = createDashboard({
      onOpenBox: (id) => openPane(id),
      onAddBox: () => openBoxDialog(),           // the same function the sidebar '#add' click handler calls — verify its exact name there
      onAddService: () => openSettingsModal('services'),
    });
  }
  return dash;
}

function startDashPolling() {
  if (dashTimer) return;
  dashTick = 0;
  const tick = async () => {
    try {
      const [services, snap] = await Promise.all([api.services(), api.servicesStatus()]);
      dash?.update({ services, serviceStatus: snap });
    } catch { dash?.update({ serviceStatus: null }); } // stale marker; last tiles stay painted
    if (dashTick % 6 === 0) { // infra readout every 60s
      try { dash?.update({ netbox: await nbx.summary() }); } catch {}
      try {
        const hosts = await pve.hosts();
        dash?.update({ containers: hosts.length ? await pve.linkedContainers() : null });
      } catch {}
    }
    dashTick++;
  };
  void tick();
  dashTimer = setInterval(tick, 10000);
}

function stopDashPolling() {
  if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
}
```

3. In `repaintStage()`, replace `grid.append(emptyStagePanel());` with:

```ts
    const d = ensureDash();
    grid.append(d.el);
    d.update({ boxes: allBoxes, status: latestStatus, series: latestSeries });
    startDashPolling();
```

and in the `else` branch (panes exist) add `stopDashPolling();` as its first line.

4. In `pollStatus()`, after `updatePaneHeaders();` add:

```ts
      if (dashTimer) dash?.update({ boxes: allBoxes, status, series: latestSeries });
```

and in `pollHealth()` after `repaintSparklines();` add:

```ts
    if (dashTimer) dash?.update({ series: latestSeries });
```

5. Teardown: everywhere the dashboard-wide teardown clears `pollInterval` (the logout click handler and the `onUnauthorized` session-expiry path), add:

```ts
    stopDashPolling();
    dash?.destroy();
    dash = null;
```

6. Delete the `emptyStagePanel()` function and move its exact DOM (prompt with `.empty-prompt`/`.empty-tilde`/`.empty-dollar`/`.empty-cursor`, `.empty-title` "No terminal attached", `.empty-hint` with the `.empty-kbd` "+ Add box") into `dashboard.ts`'s standby section, with the `+ Add box` kbd now a `<button>` wired to `hooks.onAddBox`. Update the comment above the old function's call sites accordingly.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all existing tests still pass (nothing imports `emptyStagePanel`).

- [ ] **Step 3: Commit**

```bash
git add src/web/main.ts src/web/dashboard.ts
git commit -m "feat(web): mount standby dashboard in the empty stage"
```

---

### Task 11: Settings → Services tab

**Files:**
- Create: `src/web/settingsServices.ts`
- Modify: `src/web/settingsUi.ts` (register the tab)
- Test: `test/settingsServices.test.js` (pure payload helper only)

**Interfaces:**
- Consumes: `api.services`/`addService`/`updateService`/`removeService`, `el`/`field`/`err`/`group`/`makeRadio`/`openModal` from `dom.ts`.
- Produces: `renderServicesSection(content: HTMLElement): Promise<void>`; pure `buildServicePayload(fields: { name: string; url: string; glyph: string; group: string; kind: ServiceCheckKind; target: string }): ServiceSpec`; `SettingsTab` union gains `'services'`.

- [ ] **Step 1: Write the failing test**

```js
// test/settingsServices.test.js
import { test, expect } from 'vitest';
import { buildServicePayload } from '../src/web/settingsServices.ts';

test('buildServicePayload trims fields and omits empties', () => {
  expect(buildServicePayload({ name: ' Grafana ', url: ' http://192.168.1.20:3000/ ', glyph: '', group: '  ', kind: 'http', target: '' }))
    .toEqual({ name: 'Grafana', url: 'http://192.168.1.20:3000/', glyph: null, group: null, check: { kind: 'http' } });
});

test('buildServicePayload carries the target for tcp and http-with-probe', () => {
  expect(buildServicePayload({ name: 'DNS', url: 'http://192.168.1.2/', glyph: '', group: '', kind: 'tcp', target: ' 192.168.1.2:53 ' }).check)
    .toEqual({ kind: 'tcp', target: '192.168.1.2:53' });
  expect(buildServicePayload({ name: 'App', url: 'http://a.example.com/', glyph: '', group: '', kind: 'none', target: 'ignored' }).check)
    .toEqual({ kind: 'none' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/settingsServices.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement.**

`buildServicePayload` (`null` for cleared optionals — the store's explicit-clear contract):

```ts
export function buildServicePayload(f: { name: string; url: string; glyph: string; group: string; kind: ServiceCheckKind; target: string }): ServiceSpec {
  const target = f.target.trim();
  const check: ServiceCheck = f.kind === 'none' || !target ? { kind: f.kind } : { kind: f.kind, target };
  return {
    name: f.name.trim(),
    url: f.url.trim(),
    glyph: (f.glyph.trim() || null) as unknown as string | undefined,
    group: (f.group.trim() || null) as unknown as string | undefined,
    check,
  };
}
```

(If the `null`-through-`ServiceSpec` cast reads poorly, widen `ServiceSpec`'s `glyph`/`group` to `string | null` in `api.ts` instead — the server treats `null` as "clear".)

`renderServicesSection(content)` — master-detail in the mold of the Proxmox presets tab, scaled down:
- Fetch `api.services()`; left list: one row per service (lamp-less here — just name + dim group chip), an `+ Add service` function key on top.
- Right form (for add or the selected service): `field('Name', ...)`, `field('URL', ...)`, `field('Glyph', ...)` followed by a `dash-glyph-palette` row of clickable starter glyphs that fill the input — Nerd Font codepoints: `` (server), `` (database), `` (globe), `` (home), `` (cloud), `` (film), `` (music), `` (key), `` (chart), `` (code) — `field('Group', ...)`, check-kind radios via `makeRadio('svc-check', ...)` for HTTP / TCP / None, and a target input whose visibility follows the kind (label "Probe URL (optional)" for http, "Host:port" for tcp, hidden for none).
- Save via `api.addService(buildServicePayload(...))` or `api.updateService(id, buildServicePayload(...))`; paint server-side validation errors with `err(message)`; re-render the section on success.
- Delete: confirm modal via `openModal` (same pattern as the passkey-remove confirm), then `api.removeService(id)` and re-render.

Register in `settingsUi.ts`: extend the union — `export type SettingsTab = 'boxes' | 'services' | 'netbox' | ...` — and add to `SECTIONS` right after `boxes`:

```ts
  services: { label: 'Services', render: (content) => renderServicesSection(content) },
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/settingsServices.test.js && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/settingsServices.ts src/web/settingsUi.ts test/settingsServices.test.js src/web/api.ts
git commit -m "feat(web): Settings → Services CRUD tab"
```

---

### Task 12: styles + DESIGN.md signature rewrite

**Files:**
- Modify: `src/web/style.css`
- Modify: `DESIGN.md`

- [ ] **Step 1: CSS.** Read the `:root` block of `style.css` first and use its real custom-property names (the DESIGN.md tokens in code). Add a `.dash` block near the existing `.empty` rules. Intent, per the approved design (dashboard = display content on screen-well glass — flat, no extruded keycaps on the glass):

```css
/* Standby dashboard: what the display shows when no terminal is docked.
   Content on the recessed screen-well glass — readout typography, lamps,
   engraved legends; interactivity signals by legend brightening and an
   amber border glow, never by extrusion (keys live on the chassis, not
   on the glass). */
.dash { /* fills the screen well; inherits the stage's recessed glass */ 
  display: flex; flex-direction: column; gap: 24px; padding: 24px;
  overflow-y: auto; height: 100%; box-sizing: border-box;
}
.dash-legend { /* engraved section legend: legend type, legend-dim, tracked wide */ }
.dash-legend.stale { opacity: .45; }
.dash-fleet-grid, .dash-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.dash-box, .dash-tile { /* flat cell: 1px bezel-line border, 6px radius, screen-well fill; hover: name brightens to bone, border lights amber with a soft glow */ }
.dash-lamp { /* 8px true circle; off-state 1px bezel ring so a dark lamp still reads as a lamp */ }
.dash-lamp-up { /* LED green fill */ }
.dash-lamp-down { /* LED red fill */ }
.dash-lamp-unknown { /* dark lamp: transparent fill, bezel ring */ }
.dash-glyph { /* 16px Nerd Font glyph cell, putty at rest */ }
.dash-latency { /* readout type: 11px tabular-nums, amber */ }
.dash-chip-working { /* amber lit chip, legend type */ }
.dash-chip-waiting { /* safety-orange lit chip */ }
.dash-infra-row { display: flex; flex-wrap: wrap; gap: 8px; }
.dash-mod { /* infra module: same flat cell as .dash-tile, non-interactive */ }
@media (prefers-reduced-motion: reduce) { /* the masthead cursor holds solid — reuse the existing .empty-cursor rule's reduced-motion treatment */ }
```

Fill each `/* ... */` with concrete declarations built from the real tokens (amber glow per DESIGN.md: `0 0 12px rgba(255,176,0,0.15)`-class values; the existing `.empty-*` and `.box`/lamp rules show the house technique — crib from them). The reused `.empty-prompt`/`.empty-cursor`/`.empty-title`/`.empty-hint`/`.empty-kbd` rules stay as they are; add a `.dash-head .empty-prompt { font-size: 20px; }` masthead scale-down.

- [ ] **Step 2: DESIGN.md.** Two edits:

Replace the components bullet:

```
- **Empty stage (signature)**: the display in standby — the recessed glass holding a 42px
  `~ $` prompt with a breathing amber block cursor, the `NO TERMINAL ATTACHED` legend, and
  a keycap-drawn `+ Add box` hint. Reduced motion holds the cursor solid.
```

with:

```
- **Standby dashboard (signature)**: the display in standby — the recessed glass showing
  the instrument's home readout: a shrunken `~ $` masthead with the breathing amber block
  cursor, a fleet strip (lamps, agent chips, amber sparklines), grouped service tiles
  (Nerd Font glyph, LED lamp, amber latency readout), and an infrastructure readout row
  (Proxmox counts, NetBox prefix utilization). Everything on the glass is flat display
  content — legends engrave, lamps light, hover brightens and edges glow amber; nothing
  extrudes. On a fresh install (no boxes, no services) it collapses to the original
  standby prompt: the 42px `~ $`, the `NO TERMINAL ATTACHED` legend, and a keycap-drawn
  `+ Add box` hint. Reduced motion holds the cursor solid.
```

And in Typography → Hierarchy, change the Display line to:

```
- **Display** (400, 42px): the standby dashboard's fresh-install prompt only (the masthead
  prompt runs ~20px).
```

- [ ] **Step 3: Verify**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add src/web/style.css DESIGN.md
git commit -m "feat(ui): standby dashboard styles; DESIGN.md signature rewrite"
```

---

### Task 13: docs

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `AGENTS.md`

- [ ] **Step 1: README.** Add a short "Standby dashboard" subsection where features are described: when no terminal is docked the stage shows service tiles (add/edit under Settings → Services; HTTP or TCP liveness checks run server-side on `TMUXIFIER_SERVICE_POLL_MS`, default 30s), a fleet overview, and Proxmox/NetBox readouts. Note `data/services.json` holds the tiles and that check URLs are probed with TLS verification disabled (liveness only). Use placeholder hosts in examples.

- [ ] **Step 2: CLAUDE.md and AGENTS.md** (keep the two in sync). In the self-contained file list, extend the `data/` bullet with: `` `services.json` (standby-dashboard service tiles — no secrets) ``. In the Architecture section add, after the `statusPoller.js` entry:

```
- `servicesStore.js` / `serviceCheck.js` / `serviceChecker.js` — the standby dashboard's
  service tiles: validated CRUD over `data/services.json`, the dependency-free HTTP/TCP
  liveness engine (TLS errors tolerated — reachability probe, not a security boundary),
  and the interval sweep (`TMUXIFIER_SERVICE_POLL_MS`, min 5s) whose cached snapshot
  `GET /api/services/status` serves — check volume is independent of open tabs.
  `GET /api/netbox/summary` (60s cache) feeds the dashboard's NetBox utilization readout.
```

In the web-client paragraph add, in the style of the neighboring entries: `dashboard.ts` (the standby dashboard replacing the empty stage: pure view-model helpers + an in-place-updating DOM layer; mounted by `main.ts` when no pane is docked, with a 10s services poll and 60s infra poll that run only while mounted) and `settingsServices.ts` (the Settings → Services CRUD tab).

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: standby dashboard — services store, checks, dashboard modules"
```

---

### Task 14: e2e smoke + full verification

**Files:**
- Modify: `test/e2e/tmuxifier.spec.ts`

- [ ] **Step 1: e2e smoke.** Read `test/e2e/tmuxifier.spec.ts` first. Add one test using the file's existing login flow (reuse its helper or mirror the first test's login steps exactly):

```ts
test('standby dashboard renders when no terminal is docked', async ({ page }) => {
  // <the file's login steps here>
  await expect(page.locator('.dash')).toBeVisible();
  await expect(page.locator('.dash .empty-prompt')).toBeVisible(); // the masthead prompt
});
```

If the suite's other tests leave a docked pane in localStorage between tests, follow the file's existing isolation pattern (fresh context/page per test) so the empty-stage state is real.

- [ ] **Step 2: Full verification**

Run: `npm test` (typecheck + all unit/integration), then `npm run test:e2e`, then `npm run build`.
Expected: all pass, clean build.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/tmuxifier.spec.ts
git commit -m "test(e2e): standby dashboard smoke"
```

---

## After the plan

Per the standing workflow (CLAUDE.md → Shipping): rsync the candidate `dist/` to the live app, restart the service (only when no setup/provision/lifecycle/fleet/voice-install job is running), validate by using the dashboard against the real fleet — degenerate state, tiles up/down/latency, group order, fleet strip click-through, infra readouts, Settings → Services CRUD, glyph palette — then merge to main and run the release checklist. Version bump happens there, not in this plan.
