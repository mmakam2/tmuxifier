# Android Agent Console — Server Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the native Android app needs from the Tmuxifier server: device-token auth, pane snapshots, send-keys, FCM push on agent events, and a Settings → Devices tab — per `docs/superpowers/specs/2026-08-09-android-agent-console-design.md`.

**Architecture:** Four new server seams in the existing factory-function style: `deviceStore.js` (token mint/verify over `jsonFile.js`), a Bearer branch in `server.js`'s `requireAuth`, snapshot/keys builders in `tmuxInject.js` surfaced through `boxActions` and two new routes, and `fcmPush.js` subscribed to `healthHistory.onEvent`. The web client grows one settings tab. The Android app itself is a **separate later plan** — nothing here depends on it.

**Tech Stack:** Node 20 ESM, Fastify, vitest, `node:crypto` only (no new dependencies), TS web client.

## Global Constraints

- TDD throughout: failing test first, then code. Tests use real code with injected fakes at process boundaries only (the `run`/`request` DI pattern), never module mocks.
- All new `data/*` files go through `jsonFile.js` (atomic rename, `0o600`, quarantine-on-corrupt).
- No `Date.now()`/`process.env` reads inside factories — inject `now`, pass config.
- Nothing user-supplied is ever interpolated into a shell string except through the existing quoted/validated builders; named tmux keys come from a closed allowlist.
- The web client's fetch code must go through `http.ts` helpers (`test/webHttp.test.js` enforces this).
- Public repo: placeholders only in committed code/docs (`tmuxifier.example.com`, RFC1918 IPs).
- Conventional commits. Run `npm test` (typecheck + vitest) before every commit; `test:e2e` in the final task.
- Execute in a worktree via superpowers:using-git-worktrees.

---

### Task 1: Device store (`deviceStore.js`)

**Files:**
- Create: `src/server/deviceStore.js`
- Test: `test/deviceStore.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson` from `./jsonFile.js` (signatures as used in `passkeyStore.js`).
- Produces: `createDeviceStore({ dataDir, now?, log? })` returning:
  - `enroll({ name, fcmToken? }) → Promise<{ device: PublicDevice, token: string }>`
  - `verify(token) → Promise<PublicDevice | null>`
  - `touch(id) → Promise<void>` (throttled lastSeen)
  - `list() → Promise<PublicDevice[]>`
  - `remove(id) → Promise<{ removed: boolean }>`
  - `updateSelf(id, { fcmToken?, notify? }) → Promise<PublicDevice | null>`
  - `listNotifiable(kind) → Promise<Array<{ id, fcmToken }>>`
  - `clearFcmToken(id) → Promise<void>`
  - `NOTIFY_KINDS` (module export): `['agent-input', 'agent-done']`
  - `PublicDevice = { id, name, created, lastSeen, hasFcmToken, notify }` — never contains `tokenHash` or `fcmToken`.

Model the file on `passkeyStore.js`: same `readAll`/`save`, same `withLock` promise-chain mutex (copy its comment rationale), file `data/devices.json`, shape `{ version: 1, devices: [] }`.

- [ ] **Step 1: Write the failing test**

```js
// test/deviceStore.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceStore, NOTIFY_KINDS } from '../src/server/deviceStore.js';

let dir, store, clock;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-dev-'));
  clock = { t: 1_000_000 };
  store = createDeviceStore({ dataDir: dir, now: () => clock.t });
});

test('enroll returns the token once and never persists it', async () => {
  const { device, token } = await store.enroll({ name: 'Fold' });
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  expect(device).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{16}$/), name: 'Fold', created: 1_000_000,
    lastSeen: null, hasFcmToken: false, notify: { 'agent-input': true, 'agent-done': true },
  });
  const raw = await fs.readFile(path.join(dir, 'devices.json'), 'utf8');
  expect(raw).not.toContain(token);
  const mode = (await fs.stat(path.join(dir, 'devices.json'))).mode & 0o777;
  expect(mode).toBe(0o600);
});

test('verify accepts the minted token and rejects everything else', async () => {
  const { device, token } = await store.enroll({ name: 'Fold' });
  expect((await store.verify(token))?.id).toBe(device.id);
  expect(await store.verify(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(null);
  expect(await store.verify('')).toBe(null);
  expect(await store.verify(null)).toBe(null);
});

test('remove revokes: verify fails afterwards', async () => {
  const { device, token } = await store.enroll({ name: 'Fold' });
  expect(await store.remove(device.id)).toEqual({ removed: true });
  expect(await store.remove(device.id)).toEqual({ removed: false });
  expect(await store.verify(token)).toBe(null);
});

test('touch updates lastSeen at most once a minute', async () => {
  const { device, token } = await store.enroll({ name: 'Fold' });
  clock.t += 5000;
  await store.touch(device.id);
  expect((await store.list())[0].lastSeen).toBe(1_005_000);
  clock.t += 30_000; // within throttle window
  await store.touch(device.id);
  expect((await store.list())[0].lastSeen).toBe(1_005_000);
  clock.t += 31_000; // past it
  await store.touch(device.id);
  expect((await store.list())[0].lastSeen).toBe(1_066_000);
  expect(await store.verify(token)).not.toBe(null); // touch never disturbs auth
});

test('updateSelf merges notify, clears fcmToken on null, ignores unknown ids', async () => {
  const { device } = await store.enroll({ name: 'Fold', fcmToken: 'fcm-abc' });
  expect((await store.list())[0].hasFcmToken).toBe(true);
  const upd = await store.updateSelf(device.id, { notify: { 'agent-done': false } });
  expect(upd.notify).toEqual({ 'agent-input': true, 'agent-done': false });
  // PATCH-merge rule: an omitted key keeps its stored value; the CLEARING case
  // must work explicitly (see memory: patch-merge-omitted-key-keeps-stored-value).
  const cleared = await store.updateSelf(device.id, { fcmToken: null });
  expect(cleared.hasFcmToken).toBe(false);
  expect(await store.updateSelf('feedfeedfeedfeed', {})).toBe(null);
});

test('listNotifiable filters by fcm token and per-kind toggle', async () => {
  const a = await store.enroll({ name: 'A', fcmToken: 'fcm-a' });
  await store.enroll({ name: 'B' }); // no fcm token
  const c = await store.enroll({ name: 'C', fcmToken: 'fcm-c' });
  await store.updateSelf(c.device.id, { notify: { 'agent-input': false } });
  const targets = await store.listNotifiable('agent-input');
  expect(targets).toEqual([{ id: a.device.id, fcmToken: 'fcm-a' }]);
  expect(NOTIFY_KINDS).toEqual(['agent-input', 'agent-done']);
});

test('clearFcmToken drops delivery without revoking auth', async () => {
  const { device, token } = await store.enroll({ name: 'A', fcmToken: 'fcm-a' });
  await store.clearFcmToken(device.id);
  expect(await store.listNotifiable('agent-input')).toEqual([]);
  expect(await store.verify(token)).not.toBe(null);
});

test('enroll validates the name', async () => {
  await expect(store.enroll({ name: '' })).rejects.toThrow(/name/);
  await expect(store.enroll({ name: 'x'.repeat(65) })).rejects.toThrow(/name/);
  await expect(store.enroll({ name: 'bad\u0007bell' })).rejects.toThrow(/name/);
});

test('corrupt store fails open to empty', async () => {
  await fs.writeFile(path.join(dir, 'devices.json'), '{nope', 'utf8');
  const logs = [];
  const s2 = createDeviceStore({ dataDir: dir, now: () => clock.t, log: (m) => logs.push(m) });
  expect(await s2.list()).toEqual([]);
  expect(logs.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/deviceStore.test.js`
Expected: FAIL — cannot resolve `../src/server/deviceStore.js`.

- [ ] **Step 3: Implement `src/server/deviceStore.js`**

```js
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';

const VERSION = 1;
export const NOTIFY_KINDS = ['agent-input', 'agent-done'];

// Enrolled Android devices (data/devices.json). The token itself is never
// stored — only its SHA-256 digest. A device token is 32 random bytes
// (256-bit entropy), so a fast digest is the right primitive: scrypt's cost
// defends low-entropy passwords, and here it would only tax the app's ~1s
// pane polling. Nothing in the file is secret enough to seal (digests and FCM
// registration tokens), but it is still written 0o600 via jsonFile.js and a
// corrupt file fails open to empty — same posture as passkeyStore.js, and the
// same reasoning: whoever can corrupt this file can already read .env.
const digest = (token) => createHash('sha256').update(String(token)).digest();

const NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;

export function createDeviceStore({ dataDir, now = () => Date.now(), log = (msg) => console.error(msg) }) {
  const file = path.join(dataDir, 'devices.json');
  const validShape = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (!('devices' in v) || Array.isArray(v.devices));

  async function readAll() {
    const v = await readJson(file, { fallback: {}, validate: validShape, onCorrupt: log });
    return { version: VERSION, devices: Array.isArray(v.devices) ? v.devices : [] };
  }
  async function save(data) { await writeJson(file, data, { mode: 0o600 }); return data; }

  const notifyView = (d) => {
    const out = {};
    for (const k of NOTIFY_KINDS) out[k] = d.notify?.[k] !== false;
    return out;
  };
  const publicView = (d) => ({
    id: d.id, name: d.name, created: d.created ?? null, lastSeen: d.lastSeen ?? null,
    hasFcmToken: !!d.fcmToken, notify: notifyView(d),
  });

  // Same in-process read-modify-write mutex as passkeyStore.js: mutators
  // serialize onto one promise chain so a concurrent enroll and revoke cannot
  // clobber each other's write. In-process only — Tmuxifier is one process.
  let queue = Promise.resolve();
  function withLock(fn) {
    const result = queue.then(fn, fn);
    queue = result.then(() => {}, () => {});
    return result;
  }

  return {
    enroll({ name, fcmToken } = {}) {
      return withLock(async () => {
        const trimmed = String(name ?? '').trim();
        if (!NAME_RE.test(trimmed)) throw new Error('device name must be 1-64 printable characters');
        const token = randomBytes(32).toString('base64url');
        const entry = {
          id: randomBytes(8).toString('hex'),
          name: trimmed,
          tokenHash: digest(token).toString('hex'),
          created: now(),
          lastSeen: null,
          fcmToken: typeof fcmToken === 'string' && fcmToken ? fcmToken.slice(0, 4096) : null,
          notify: {},
        };
        const data = await readAll();
        data.devices = [...data.devices, entry];
        await save(data);
        return { device: publicView(entry), token };
      });
    },

    async verify(token) {
      if (typeof token !== 'string' || !token) return null;
      const d = digest(token);
      const { devices } = await readAll();
      for (const dev of devices) {
        const stored = Buffer.from(String(dev.tokenHash ?? ''), 'hex');
        if (stored.length === d.length && timingSafeEqual(stored, d)) return publicView(dev);
      }
      return null;
    },

    // lastSeen is display metadata, so it persists at most once a minute —
    // the app polls the pane every second and each touch is a full-file write.
    touch(id) {
      return withLock(async () => {
        const data = await readAll();
        const dev = data.devices.find((x) => x.id === id);
        if (!dev) return;
        const t = now();
        if (dev.lastSeen != null && t - dev.lastSeen < 60_000) return;
        dev.lastSeen = t;
        await save(data);
      });
    },

    async list() { return (await readAll()).devices.map(publicView); },

    remove(id) {
      return withLock(async () => {
        const data = await readAll();
        const before = data.devices.length;
        data.devices = data.devices.filter((x) => x.id !== id);
        if (data.devices.length === before) return { removed: false };
        await save(data);
        return { removed: true };
      });
    },

    updateSelf(id, { fcmToken, notify } = {}) {
      return withLock(async () => {
        const data = await readAll();
        const dev = data.devices.find((x) => x.id === id);
        if (!dev) return null;
        // PATCH merge: an omitted field keeps its stored value; explicit null
        // clears fcmToken. Booleans only for notify, unknown kinds ignored.
        if (fcmToken === null) dev.fcmToken = null;
        else if (typeof fcmToken === 'string' && fcmToken) dev.fcmToken = fcmToken.slice(0, 4096);
        if (notify && typeof notify === 'object') {
          dev.notify = dev.notify && typeof dev.notify === 'object' ? dev.notify : {};
          for (const k of NOTIFY_KINDS) {
            if (typeof notify[k] === 'boolean') dev.notify[k] = notify[k];
          }
        }
        await save(data);
        return publicView(dev);
      });
    },

    async listNotifiable(kind) {
      const { devices } = await readAll();
      return devices
        .filter((d) => d.fcmToken && d.notify?.[kind] !== false)
        .map((d) => ({ id: d.id, fcmToken: d.fcmToken }));
    },

    clearFcmToken(id) {
      return withLock(async () => {
        const data = await readAll();
        const dev = data.devices.find((x) => x.id === id);
        if (!dev || dev.fcmToken == null) return;
        dev.fcmToken = null;
        await save(data);
      });
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/deviceStore.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/deviceStore.js test/deviceStore.test.js
git commit -m "feat(devices): device-token store for the Android app"
```

---

### Task 2: Bearer auth + device routes (`server.js`)

**Files:**
- Modify: `src/server/server.js` (buildServer signature ~L118; `requireAuth` ~L598; new routes after the `/api/me` route ~L688)
- Test: `test/deviceRoutes.test.js`

**Interfaces:**
- Consumes: Task 1's `createDeviceStore` API; existing `verifyPassword`, `loginLimiter`, `passkeySnapshot()`/`passkeyOnlyArmed()` (already in `buildServer` scope — see the `/api/login` route at ~L623 for usage).
- Produces: `buildServer({ ..., deviceStore = null })`; routes `POST /api/devices/enroll`, `GET /api/devices`, `DELETE /api/devices/:id`, `PATCH /api/devices/self`; every `preHandler: requireAuth` route now also accepts `Authorization: Bearer <token>`; `req.deviceId` set when Bearer-authed.

**Key change — `requireAuth` becomes async.** Fastify picks callback vs promise style by arity, so replace the 3-arg callback form with a 2-arg async and keep the name; every existing route references the same function and needs no edit. `isAuthed` stays sync and cookie-only on purpose: the `/term` WebSocket and `/api/logout` use it directly, and the app never touches either.

- [ ] **Step 1: Write the failing test**

```js
// test/deviceRoutes.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, deviceStore;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-devr-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  deviceStore = createDeviceStore({ dataDir: dir });
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker,
    passkeyStore: createPasskeyStore({ dataDir: dir }), deviceStore,
  });
});

async function cookieHeaders() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('enroll needs the correct password and feeds the login limiter', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'wrong', name: 'Fold' } });
  expect(bad.statusCode).toBe(401);
  const ok = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(ok.json().name).toBe('Fold');
  // 10 bad attempts lock the ip (shared bucket with /api/login)
  for (let i = 0; i < 10; i++) {
    await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'wrong', name: 'x' } });
  }
  const limited = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'x' } });
  expect(limited.statusCode).toBe(429);
});

test('a Bearer token authenticates API routes; a bogus one does not', async () => {
  const { token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  const authed = await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: `Bearer ${token}` } });
  expect(authed.statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/boxes' })).statusCode).toBe(401);
});

test('revocation locks the token out on its next request', async () => {
  const { id, token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  const h = await cookieHeaders();
  const listed = (await app.inject({ method: 'GET', url: '/api/devices', headers: h })).json();
  expect(listed.devices.map((d) => d.id)).toContain(id);
  expect((await app.inject({ method: 'DELETE', url: `/api/devices/${id}`, headers: h })).json()).toEqual({ removed: true });
  expect((await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
});

test('PATCH /api/devices/self is Bearer-only and merges', async () => {
  const { token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold', fcmToken: 'fcm-1' } })).json();
  const viaCookie = await app.inject({ method: 'PATCH', url: '/api/devices/self', headers: await cookieHeaders(), payload: {} });
  expect(viaCookie.statusCode).toBe(403); // a browser session is not a device
  const upd = await app.inject({
    method: 'PATCH', url: '/api/devices/self',
    headers: { authorization: `Bearer ${token}` },
    payload: { notify: { 'agent-done': false } },
  });
  expect(upd.statusCode).toBe(200);
  expect(upd.json().notify).toEqual({ 'agent-input': true, 'agent-done': false });
});

test('device list is never served to an unauthenticated caller', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/devices' })).statusCode).toBe(401);
});

test('enroll refuses when passkey-only is armed', async () => {
  // Arm via the store directly (the HTTP arming path needs a WebAuthn ceremony).
  const pk = createPasskeyStore({ dataDir: dir });
  await pk.add({ id: 'cred1', publicKey: 'pk', signCount: 0 }, { rpId: 'localhost' });
  await pk.setPasskeyOnly(true);
  const res = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } });
  expect(res.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/deviceRoutes.test.js`
Expected: FAIL — enroll route 404s (`statusCode` 404 ≠ 401/200).

- [ ] **Step 3: Implement in `server.js`**

3a. Add `deviceStore = null` to the `buildServer({ ... })` destructured parameters (~L118, anywhere in the list).

3b. Replace the callback `requireAuth` (~L598) with:

```js
  async function deviceAuthed(req) {
    if (!deviceStore) return false;
    const h = String(req.headers?.authorization || '');
    if (!h.startsWith('Bearer ')) return false;
    const device = await deviceStore.verify(h.slice(7).trim());
    if (!device) return false;
    req.deviceId = device.id;
    // lastSeen is cosmetic; a write failure must not fail the request.
    deviceStore.touch(device.id).catch(() => {});
    return true;
  }
  // Async on purpose (Fastify dispatches on arity): cookie first — the common
  // browser case stays synchronous — then the device-token branch.
  async function requireAuth(req, reply) {
    if (isAuthed(req) || (await deviceAuthed(req))) return;
    return reply.code(401).send({ error: 'unauthorized' });
  }
```

3c. After the `/api/me` route (~L688), add the device routes:

```js
  // Device enrollment authenticates with the password directly (not a cookie):
  // the Android app enrolls once and holds a revocable token thereafter. Same
  // rate-limit bucket as /api/login — this is a password oracle otherwise.
  // v1 is password-mode only; OAuth-mode pairing codes are a recorded v2 item.
  app.post('/api/devices/enroll', async (req, reply) => {
    if (!deviceStore) return reply.code(501).send({ error: 'devices not supported' });
    if (config.authMode === 'google') return reply.code(501).send({ error: 'device enrollment requires password mode' });
    if (passkeyOnlyArmed(await passkeySnapshot())) return reply.code(403).send({ error: 'passkey required' });
    const ip = req.ip;
    if (loginLimiter.limited(ip)) return reply.code(429).send({ error: 'too many attempts' });
    const ok = await verifyPassword(req.body?.password || '', config.passwordHash);
    if (!ok) { loginLimiter.fail(ip); return reply.code(401).send({ error: 'invalid' }); }
    loginLimiter.succeed(ip);
    try {
      const { device, token } = await deviceStore.enroll({ name: req.body?.name, fcmToken: req.body?.fcmToken });
      return { ...device, token };
    } catch (e) {
      return reply.code(400).send({ error: e?.message || 'invalid device' });
    }
  });

  app.get('/api/devices', { preHandler: requireAuth }, async (req, reply) => {
    if (!deviceStore) return reply.code(501).send({ error: 'devices not supported' });
    return { devices: await deviceStore.list() };
  });

  app.delete('/api/devices/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!deviceStore) return reply.code(501).send({ error: 'devices not supported' });
    return deviceStore.remove(String(req.params.id));
  });

  // The device updates its own record (FCM token rotation, notify toggles).
  // Bearer-only: a browser session has no deviceId and gets a 403.
  app.patch('/api/devices/self', { preHandler: requireAuth }, async (req, reply) => {
    if (!deviceStore) return reply.code(501).send({ error: 'devices not supported' });
    if (!req.deviceId) return reply.code(403).send({ error: 'device token required' });
    const body = req.body || {};
    const updated = await deviceStore.updateSelf(req.deviceId, { fcmToken: body.fcmToken, notify: body.notify });
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  });
```

- [ ] **Step 4: Run the new test, then the whole suite**

Run: `npx vitest run test/deviceRoutes.test.js` → PASS.
Run: `npm test` → PASS (the async `requireAuth` must not break any existing route test; if anything fails here, the failure is in the conversion, not the old tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/deviceRoutes.test.js
git commit -m "feat(devices): bearer device-token auth + enroll/list/revoke/self routes"
```

---

### Task 3: Snapshot and named-key builders (`tmuxInject.js`)

**Files:**
- Modify: `src/server/tmuxInject.js` (add after `buildSendKeysRemote`, ~L131)
- Test: `test/tmuxInject.test.js` (append)

**Interfaces:**
- Consumes: the module-local `sess(session)` exact-match quoter and `shSingleQuote` already used by `buildSendKeysRemote`.
- Produces:
  - `buildPaneSnapshotRemote(session, { lines = 200 }) → string` (sh script)
  - `parsePaneSnapshot(stdout) → { width, height, cursorX, cursorY, content } | null`
  - `NAMED_KEYS: Set<string>` — exactly `Enter, Escape, Up, Down, Left, Right, Tab, BSpace, C-c`
  - `buildSendNamedKeyRemote(session, key) → string` (throws on a key outside `NAMED_KEYS`)
  - `sanitizeSendText(text) → string` — whitespace runs (incl. newlines — a raw newline through send-keys IS Enter) collapse to single spaces, remaining C0/C1 controls stripped, trimmed; mirrors the composer's `sendTextOf`.

- [ ] **Step 1: Write the failing tests** (append to `test/tmuxInject.test.js`)

```js
import {
  buildPaneSnapshotRemote, parsePaneSnapshot, NAMED_KEYS,
  buildSendNamedKeyRemote, sanitizeSendText,
} from '../src/server/tmuxInject.js';

test('buildPaneSnapshotRemote: geometry line, then bounded capture, atomic on failure', () => {
  const s = buildPaneSnapshotRemote('main', { lines: 200 });
  expect(s).toContain("display-message -p -t '=main' '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}'");
  expect(s).toContain("capture-pane -e -p -t '=main' -S -200");
  expect(s).toContain(' && '); // one failure fails the whole script (non-zero exit)
});

test('buildPaneSnapshotRemote clamps lines and quotes the session', () => {
  expect(buildPaneSnapshotRemote('a b', { lines: 999999 })).toContain('-S -2000');
  expect(buildPaneSnapshotRemote('a b', { lines: -5 })).toContain('-S -0');
  expect(buildPaneSnapshotRemote("a'b", {})).toContain("'=a'\\''b'");
});

test('parsePaneSnapshot splits geometry from content', () => {
  expect(parsePaneSnapshot('80 24 5 23\nline1\nline2\n')).toEqual({
    width: 80, height: 24, cursorX: 5, cursorY: 23, content: 'line1\nline2',
  });
  expect(parsePaneSnapshot('80 24 5 23')).toEqual({ width: 80, height: 24, cursorX: 5, cursorY: 23, content: '' });
  expect(parsePaneSnapshot('garbage\nstuff')).toBe(null);
  expect(parsePaneSnapshot('')).toBe(null);
  expect(parsePaneSnapshot(null)).toBe(null);
});

test('named keys are a closed allowlist', () => {
  expect([...NAMED_KEYS].sort()).toEqual(['BSpace', 'C-c', 'Down', 'Enter', 'Escape', 'Left', 'Right', 'Tab', 'Up']);
  expect(buildSendNamedKeyRemote('main', 'Enter')).toBe("tmux send-keys -t '=main' Enter");
  expect(() => buildSendNamedKeyRemote('main', 'C-d')).toThrow(/unknown key/);
  expect(() => buildSendNamedKeyRemote('main', 'Enter; rm -rf /')).toThrow(/unknown key/);
});

test('sanitizeSendText: newlines collapse (a newline IS Enter), controls stripped', () => {
  expect(sanitizeSendText('  hello\n  world\t!  ')).toBe('hello world !');
  expect(sanitizeSendText('a\u0007b\u001b[31mc')).toBe('ab[31mc');
  expect(sanitizeSendText('\r\n\r\n')).toBe('');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/tmuxInject.test.js`
Expected: FAIL — the new exports don't exist.

- [ ] **Step 3: Implement** (in `src/server/tmuxInject.js`, after `buildSendKeysRemote`)

```js
// One script, one round trip: geometry first (a single parseable line), then
// the styled capture. `&&` makes failure atomic — a missing session exits
// non-zero instead of shipping half a snapshot. -e keeps SGR sequences; the
// Android client renders them as styled spans. -S bounds scrollback.
export function buildPaneSnapshotRemote(session, { lines = 200 } = {}) {
  const q = sess(session);
  const n = Math.max(0, Math.min(2000, Math.trunc(Number(lines) || 0)));
  return [
    `tmux display-message -p -t ${q} '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}'`,
    `tmux capture-pane -e -p -t ${q} -S -${n}`,
  ].join(' && ');
}

export function parsePaneSnapshot(raw) {
  const txt = String(raw ?? '');
  const nl = txt.indexOf('\n');
  const head = (nl === -1 ? txt : txt.slice(0, nl)).trim();
  const m = /^(\d+) (\d+) (\d+) (\d+)$/.exec(head);
  if (!m) return null;
  return {
    width: Number(m[1]), height: Number(m[2]), cursorX: Number(m[3]), cursorY: Number(m[4]),
    content: nl === -1 ? '' : txt.slice(nl + 1).replace(/\n$/, ''),
  };
}

// Closed allowlist — these are the ONLY strings that ever reach send-keys as a
// key NAME (everything else goes literal via -l). Same chokepoint discipline
// as voiceCatalog.js/iconCatalog.js: the route validates against this set and
// the builder throws rather than trusting its caller.
export const NAMED_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BSpace', 'C-c']);

export function buildSendNamedKeyRemote(session, key) {
  if (!NAMED_KEYS.has(key)) throw new Error(`unknown key: ${String(key).slice(0, 32)}`);
  return `tmux send-keys -t ${sess(session)} ${key}`;
}

// Mirror of the phone composer's sendTextOf (src/web/composer.ts): whitespace
// runs — including newlines, which send-keys would deliver as Enter — collapse
// to single spaces; remaining C0/C1 controls are stripped. Server-side because
// the client cannot be trusted to have done it.
export function sanitizeSendText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/tmuxInject.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tmuxInject.js test/tmuxInject.test.js
git commit -m "feat(pane): snapshot + named-key builders and text sanitizer"
```

---

### Task 4: `boxActions` snapshot/sendKeys + pane and keys routes

**Files:**
- Modify: `src/server/boxActions.js` (imports at top; new methods beside `injectText`, ~L564)
- Modify: `src/server/server.js` (routes after the box routes, e.g. after `/api/boxes/:id/seed-ai-auth` ~L806; import `NAMED_KEYS`, `sanitizeSendText` from `./tmuxInject.js` at top)
- Test: `test/paneRoutes.test.js` (route level, DI ssh runner)
- Test: `test/paneSnapshot.integration.test.js` (real sshd + tmux via `test/helpers/localBox.js`)

**Interfaces:**
- Consumes: Task 3's builders; `runRemote(box, remote, timeout)` inside `createBoxActions`; `store.getBox(id)`; `history.getSeries(boxId)` (last sample's `agent` field, may be `undefined`).
- Produces:
  - `boxActions.paneSnapshot(box, session, { lines?, timeoutMs? }) → { ok, width, height, cursorX, cursorY, content } | { ok: false, error }`
  - `boxActions.sendKeys(box, session, { text?, key? }, { timeoutMs? }) → { ok } | { ok: false, error }`
  - `GET /api/boxes/:id/pane?lines=N` → `{ ok: true, width, height, cursorX, cursorY, content, agent, sessionName }` (agent: `'working' | 'waiting' | null`)
  - `POST /api/boxes/:id/keys` body `{ text }` XOR `{ key }` → `{ ok: true }`

- [ ] **Step 1: Write the failing route tests**

```js
// test/paneRoutes.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, calls, boxId;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pane-'));
  calls = [];
  // Real createBoxActions over a fake ssh transport (the run seam) — the argv
  // building, quoting, and parsing under test are the real code.
  const run = async (argv) => {
    calls.push(argv);
    const remote = argv[argv.length - 1];
    if (remote.includes('capture-pane')) return { code: 0, stdout: '80 24 3 10\nhello\nworld\n', stderr: '' };
    if (remote.includes('send-keys')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const boxActions = createBoxActions({ run, runStdin: run, hostKeyPolicy: 'accept-new', controlDir: dir });
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ label: 'b1', host: '192.168.1.10', user: 'u', sessionName: 'main' });
  boxId = box.id;
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const history = { getSeries: () => [{ t: 1, up: true, agent: 'waiting' }], getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {} };
  app = buildServer({ config, store, sessions, statusChecker, boxActions, history });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('GET pane returns parsed snapshot plus agent state', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane`, headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    ok: true, width: 80, height: 24, cursorX: 3, cursorY: 10,
    content: 'hello\nworld', agent: 'waiting', sessionName: 'main',
  });
});

test('POST keys: named key goes unquoted from the allowlist, text goes literal and sanitized', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { key: 'Enter' } })).statusCode).toBe(200);
  expect(calls.some((argv) => argv[argv.length - 1] === "tmux send-keys -t '=main' Enter")).toBe(true);
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'hi\nthere' } })).statusCode).toBe(200);
  expect(calls.some((argv) => argv[argv.length - 1] === "tmux send-keys -t '=main' -l -- 'hi there'")).toBe(true);
});

test('POST keys validates: exactly one of text/key, allowlisted key, bounded text', async () => {
  const h = await headers();
  const both = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'x', key: 'Enter' } });
  expect(both.statusCode).toBe(400);
  const neither = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: {} });
  expect(neither.statusCode).toBe(400);
  const badKey = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { key: 'C-d' } });
  expect(badKey.statusCode).toBe(400);
  const huge = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'x'.repeat(65537) } });
  expect(huge.statusCode).toBe(400);
});

test('both routes 404 an unknown box and 401 without auth', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'GET', url: '/api/boxes/nope/pane', headers: h })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane` })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, payload: { key: 'Enter' } })).statusCode).toBe(401);
});
```

(`store.addBox(spec)` is the verified API — `src/server/store.js:99`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/paneRoutes.test.js`
Expected: FAIL — `/pane` 404s (route missing).

- [ ] **Step 3: Implement `boxActions` methods** (in `createBoxActions`'s returned object, beside `injectText`; add `buildPaneSnapshotRemote, parsePaneSnapshot, buildSendNamedKeyRemote` to the existing `./tmuxInject.js` import)

```js
    // Read-only snapshot of the box session's active pane: tmux is the
    // terminal emulator, this just ships its screen. Never attaches a client,
    // so it can never resize the window under a desktop viewer.
    async paneSnapshot(box, session, { lines = 200, timeoutMs = 8000 } = {}) {
      const res = await runRemote(box, buildPaneSnapshotRemote(session, { lines }), timeoutMs);
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, error: msg || 'capture failed' };
      }
      const snap = parsePaneSnapshot(res.stdout);
      if (!snap) return { ok: false, error: 'unparseable snapshot' };
      return { ok: true, ...snap };
    },
    // Text goes literal (-l) via the same builder dictation uses; a named key
    // must already be validated against NAMED_KEYS by the route — the builder
    // throws on anything else as the second line of defence.
    async sendKeys(box, session, { text, key } = {}, { timeoutMs = 8000 } = {}) {
      const remote = key != null
        ? buildSendNamedKeyRemote(session, key)
        : buildSendKeysRemote(session, String(text ?? ''));
      const res = await runRemote(box, remote, timeoutMs);
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, error: msg || 'send-keys failed' };
      }
      return { ok: true };
    },
```

(`buildSendKeysRemote` is already exported from `tmuxInject.js`; add it to the import list if absent.)

3b. Routes in `server.js` (import `NAMED_KEYS, sanitizeSendText` from `./tmuxInject.js`):

```js
  // App-facing pane snapshot: read-only, bounded scrollback, agent state from
  // the health series so the client needs no second request.
  app.get('/api/boxes/:id/pane', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'not found' });
    const lines = req.query?.lines != null ? Number(req.query.lines) : 200;
    const snap = await boxActions.paneSnapshot(box, box.sessionName, { lines });
    if (!snap.ok) return reply.code(502).send({ error: snap.error });
    const last = history ? (history.getSeries(box.id).at(-1) || null) : null;
    return { ...snap, agent: last?.agent ?? null, sessionName: box.sessionName };
  });

  app.post('/api/boxes/:id/keys', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'not found' });
    const { text, key } = req.body || {};
    const hasText = typeof text === 'string' && text.length > 0;
    const hasKey = typeof key === 'string' && key.length > 0;
    if (hasText === hasKey) return reply.code(400).send({ error: 'exactly one of text or key' });
    if (hasText && text.length > 65536) return reply.code(400).send({ error: 'text too long' });
    if (hasKey && !NAMED_KEYS.has(key)) return reply.code(400).send({ error: 'unknown key' });
    const payload = hasKey ? { key } : { text: sanitizeSendText(text) };
    if (payload.text === '') return { ok: true, skipped: 'empty' }; // sanitizer ate it all
    const res = await boxActions.sendKeys(box, box.sessionName, payload);
    if (!res.ok) return reply.code(502).send({ error: res.error });
    return { ok: true };
  });
```

- [ ] **Step 4: Run route tests**

Run: `npx vitest run test/paneRoutes.test.js` → PASS.

- [ ] **Step 5: Write the integration test (real sshd + tmux)**

The fake-transport lesson (memory: 2143 green tests over a fake `sshStream` proved nothing about the real transport) is why this task doesn't stop at Step 4. `setupLocalBox()` from `test/helpers/localBox.js` returns `{ tmp, home, port, env, box, session, sshConfigFile, cleanup }` — an isolated sshd, fixture HOME, and its own `TMUX_TMPDIR`; pass its `sshConfigFile` into `createBoxActions` so ssh resolves against the fixture, and call `cleanup()` in `afterAll`. Follow `test/localBox.integration.test.js`'s idioms for timeouts and teardown.

```js
// test/paneSnapshot.integration.test.js
import { test, expect, beforeAll, afterAll } from 'vitest';
import { setupLocalBox } from './helpers/localBox.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { sshRun, sshRunStdin } from '../src/server/sshRun.js';

let lb, boxActions;
beforeAll(async () => {
  lb = await setupLocalBox();
  boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, opts),
    runStdin: (argv, input, opts) => sshRunStdin(argv, input, opts),
    hostKeyPolicy: 'accept-new',
    sshConfigFile: lb.sshConfigFile,
  });
  // A detached session with a predictable pane. cat keeps the pane open.
  const mk = await boxActions.execCommand(lb.box, "tmux new-session -d -s snap 'printf snapshot-marker\\\\n; exec cat'");
  expect(mk.code).toBe(0);
}, 60_000);
afterAll(async () => {
  if (boxActions && lb) await boxActions.execCommand(lb.box, 'tmux kill-session -t =snap').catch(() => {});
  if (lb) await lb.cleanup();
});

test('paneSnapshot reads real tmux content and geometry', async () => {
  const snap = await boxActions.paneSnapshot(lb.box, 'snap');
  expect(snap.ok).toBe(true);
  expect(snap.width).toBeGreaterThan(0);
  expect(snap.height).toBeGreaterThan(0);
  expect(snap.content).toContain('snapshot-marker');
});

test('sendKeys text lands in the pane; a named key is accepted', async () => {
  expect((await boxActions.sendKeys(lb.box, 'snap', { text: 'typed-by-test' })).ok).toBe(true);
  expect((await boxActions.sendKeys(lb.box, 'snap', { key: 'Enter' })).ok).toBe(true);
  // cat echoes the line back, so it appears twice (input + echo) — either
  // occurrence proves delivery end-to-end.
  await new Promise((r) => setTimeout(r, 500));
  const snap = await boxActions.paneSnapshot(lb.box, 'snap');
  expect(snap.content).toContain('typed-by-test');
});

test('a missing session is an error, not a half-snapshot', async () => {
  const snap = await boxActions.paneSnapshot(lb.box, 'no-such-session');
  expect(snap.ok).toBe(false);
});
```

Adapt the `setupLocalBox` return-shape usage (`lb.box`, `lb.close`, control dir) to what the helper actually exports — read `test/localBox.integration.test.js` first and mirror its idioms exactly.

- [ ] **Step 6: Run the integration test, then the whole suite**

Run: `npx vitest run test/paneSnapshot.integration.test.js` → PASS.
Run: `npm test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/boxActions.js src/server/server.js test/paneRoutes.test.js test/paneSnapshot.integration.test.js
git commit -m "feat(pane): GET /api/boxes/:id/pane snapshot + POST /api/boxes/:id/keys"
```

---

### Task 5: FCM notifier (`fcmPush.js`) + config knob + wiring

**Files:**
- Create: `src/server/fcmPush.js`
- Modify: `src/server/config.js` (DEFAULTS ~L16 area; env map ~L167 area; validation ~L282 area)
- Modify: `src/server/index.js` (deviceStore beside `passkeyStore` ~L204; FCM wiring after `history` ~L278; `deviceStore` into the `buildServer` call ~L323)
- Modify: `.env.example`
- Test: `test/fcmPush.test.js`

**Interfaces:**
- Consumes: Task 1's `deviceStore.listNotifiable(kind)` / `clearFcmToken(id)`; `history.onEvent(cb)` (`healthHistory.js:247`) — events shaped `{ boxId, label, host, t, kind, seq }`.
- Produces:
  - `buildServiceJwt({ clientEmail, privateKeyPem, tokenUri, nowSec }) → string` (RS256 JWT)
  - `buildFcmMessage({ projectId, fcmToken, event }) → { url, body }`
  - `createFcmPush({ credentialsPath, deviceStore, request?, now?, log? })` → `{ notify(event): Promise<void> }` — never rejects.
  - Config: `fcmCredentials` from `TMUXIFIER_FCM_CREDENTIALS` (string path, undefined when unset).

- [ ] **Step 1: Write the failing tests**

```js
// test/fcmPush.test.js
import { test, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServiceJwt, buildFcmMessage, createFcmPush } from '../src/server/fcmPush.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('buildServiceJwt: verifiable RS256, correct claims', () => {
  const jwt = buildServiceJwt({ clientEmail: 'svc@p.iam.gserviceaccount.com', privateKeyPem: pem, tokenUri: 'https://oauth2.example.com/token', nowSec: 1000 });
  const [h, c, s] = jwt.split('.');
  expect(JSON.parse(Buffer.from(h, 'base64url'))).toEqual({ alg: 'RS256', typ: 'JWT' });
  expect(JSON.parse(Buffer.from(c, 'base64url'))).toEqual({
    iss: 'svc@p.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.example.com/token', iat: 1000, exp: 4600,
  });
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).end().verify(publicKey, Buffer.from(s, 'base64url'));
  expect(ok).toBe(true);
});

test('buildFcmMessage: v1 shape with data payload for tap-through', () => {
  const { url, body } = buildFcmMessage({
    projectId: 'proj-1', fcmToken: 'tok-1',
    event: { boxId: 'b1', label: 'workbox', kind: 'agent-input', t: 5 },
  });
  expect(url).toBe('https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
  expect(body.message.token).toBe('tok-1');
  expect(body.message.notification.title).toContain('workbox');
  expect(body.message.data).toEqual({ boxId: 'b1', kind: 'agent-input' });
  expect(body.message.android.priority).toBe('HIGH');
});

async function credsFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fcm-'));
  const p = path.join(dir, 'sa.json');
  await fs.writeFile(p, JSON.stringify({
    project_id: 'proj-1', client_email: 'svc@p.iam.gserviceaccount.com',
    private_key: pem, token_uri: 'https://oauth2.example.com/token',
  }));
  return p;
}

function fakeDeviceStore(targets) {
  const cleared = [];
  return {
    cleared,
    listNotifiable: async () => targets,
    clearFcmToken: async (id) => { cleared.push(id); },
  };
}

test('notify: token exchange once, one send per target, UNREGISTERED clears the token', async () => {
  const requests = [];
  const request = async (url, opts) => {
    requests.push({ url, opts });
    if (url.includes('oauth2')) return { status: 200, json: { access_token: 'at-1', expires_in: 3600 } };
    if (opts.body.includes('dead-token')) return { status: 404, json: { error: { status: 'NOT_FOUND' } } };
    return { status: 200, json: {} };
  };
  const ds = fakeDeviceStore([{ id: 'd1', fcmToken: 'live-token' }, { id: 'd2', fcmToken: 'dead-token' }]);
  const push = createFcmPush({ credentialsPath: await credsFile(), deviceStore: ds, request, now: () => 1_000_000 });
  await push.notify({ boxId: 'b1', label: 'workbox', kind: 'agent-input', t: 1 });
  const tokenCalls = requests.filter((r) => r.url.includes('oauth2'));
  const sends = requests.filter((r) => r.url.includes('fcm.googleapis.com'));
  expect(tokenCalls.length).toBe(1); // cached across the fan-out
  expect(sends.length).toBe(2);
  expect(sends[0].opts.headers.authorization).toBe('Bearer at-1');
  expect(ds.cleared).toEqual(['d2']);
});

test('notify ignores non-agent kinds and never rejects on transport failure', async () => {
  const ds = fakeDeviceStore([{ id: 'd1', fcmToken: 't' }]);
  const boom = async () => { throw new Error('network down'); };
  const push = createFcmPush({ credentialsPath: await credsFile(), deviceStore: ds, request: boom, now: () => 1 });
  await expect(push.notify({ kind: 'down', boxId: 'b', label: 'x', t: 1 })).resolves.toBeUndefined();
  await expect(push.notify({ kind: 'agent-input', boxId: 'b', label: 'x', t: 1 })).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/fcmPush.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/server/fcmPush.js`**

```js
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';

// FCM HTTP v1 sender, dependency-free in the googleAuth.js mold: sign the
// service-account JWT with node:crypto, trade it for an OAuth2 access token
// (cached until near expiry), POST the message. Subscribed to
// healthHistory.onEvent — the seam that module documents as deferred
// server-push delivery. Failure posture: log and continue, never reject —
// a push must not disturb the poll loop (same rule as every side-channel).

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const KINDS = new Set(['agent-input', 'agent-done']);
const TITLES = { 'agent-input': 'Claude is waiting', 'agent-done': 'Agent finished' };

const b64uJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function buildServiceJwt({ clientEmail, privateKeyPem, tokenUri, nowSec }) {
  const input = `${b64uJson({ alg: 'RS256', typ: 'JWT' })}.${b64uJson({
    iss: clientEmail, scope: SCOPE, aud: tokenUri, iat: nowSec, exp: nowSec + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(input).end().sign(privateKeyPem).toString('base64url');
  return `${input}.${sig}`;
}

export function buildFcmMessage({ projectId, fcmToken, event }) {
  return {
    url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    body: {
      message: {
        token: fcmToken,
        notification: {
          title: `${event.label} — ${TITLES[event.kind] || event.kind}`,
          body: event.kind === 'agent-input' ? 'A Claude session wants your input.' : 'A Claude session finished its turn.',
        },
        data: { boxId: String(event.boxId), kind: String(event.kind) },
        android: { priority: 'HIGH' },
      },
    },
  };
}

// Minimal https JSON POST; injectable in tests via the `request` seam.
function httpsRequest(url, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('fcm request timeout')));
    req.end(body);
  });
}

export function createFcmPush({ credentialsPath, deviceStore, request = httpsRequest, now = () => Date.now(), log = (msg) => console.error(msg) }) {
  let creds = null;
  let cached = null; // { accessToken, expiresAtMs }

  async function loadCreds() {
    if (!creds) creds = JSON.parse(await readFile(credentialsPath, 'utf8'));
    return creds;
  }
  async function accessToken() {
    if (cached && cached.expiresAtMs - 60_000 > now()) return cached.accessToken;
    const c = await loadCreds();
    const jwt = buildServiceJwt({ clientEmail: c.client_email, privateKeyPem: c.private_key, tokenUri: c.token_uri, nowSec: Math.floor(now() / 1000) });
    const res = await request(c.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent(GRANT)}&assertion=${jwt}`,
    });
    if (res.status !== 200 || !res.json?.access_token) throw new Error(`token exchange failed (${res.status})`);
    cached = { accessToken: res.json.access_token, expiresAtMs: now() + Number(res.json.expires_in || 3600) * 1000 };
    return cached.accessToken;
  }

  return {
    async notify(event) {
      if (!KINDS.has(event?.kind)) return;
      let targets;
      try { targets = await deviceStore.listNotifiable(event.kind); } catch { return; }
      for (const d of targets) {
        try {
          const at = await accessToken();
          const { url, body } = buildFcmMessage({ projectId: (await loadCreds()).project_id, fcmToken: d.fcmToken, event });
          const res = await request(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          // FCM reports a gone registration as 404/NOT_FOUND or 400/UNREGISTERED:
          // drop that device's delivery, never its auth.
          const detail = JSON.stringify(res.json || {});
          if (res.status === 404 || (res.status === 400 && detail.includes('UNREGISTERED'))) {
            await deviceStore.clearFcmToken(d.id);
          } else if (res.status !== 200) {
            log(`fcm send to ${d.id} failed (${res.status})`);
          }
        } catch (e) {
          log(`fcm push failed: ${e?.message || e}`);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/fcmPush.test.js` → PASS.

- [ ] **Step 5: Config knob + wiring + .env.example**

`src/server/config.js` — three one-liners following the `termFont` pattern exactly:
- DEFAULTS: `fcmCredentials: undefined,`
- env map: `fcmCredentials: e.TMUXIFIER_FCM_CREDENTIALS,`
- validation section: `{ const p = String(merged.fcmCredentials ?? '').trim(); merged.fcmCredentials = p || undefined; }`

`src/server/index.js`:
- `import { createDeviceStore } from './deviceStore.js';` and `import { createFcmPush } from './fcmPush.js';`
- beside `passkeyStore` (~L204): `const deviceStore = createDeviceStore({ dataDir: config.dataDir });`
- after `history` is created (~L278):

```js
// FCM push to enrolled Android devices: agent-input/agent-done events become
// lock-screen notifications. Unset credentials = feature off; a send failure
// is logged inside notify() and can never disturb the poll loop.
if (config.fcmCredentials) {
  const fcmPush = createFcmPush({ credentialsPath: config.fcmCredentials, deviceStore });
  history.onEvent((e) => { fcmPush.notify(e).catch(() => {}); });
}
```

- add `deviceStore` to the `buildServer({ ... })` call (~L323).

`.env.example` — append under the existing optional knobs:

```
# Android app push notifications: path to a Firebase service-account JSON
# (Firebase console -> Project settings -> Service accounts). Free. Keep the
# file under data/ (gitignored). Unset = push disabled; the app still works.
#TMUXIFIER_FCM_CREDENTIALS=./data/fcm-service-account.json
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/fcmPush.js src/server/config.js src/server/index.js .env.example test/fcmPush.test.js
git commit -m "feat(push): FCM notifier on the health-event seam + TMUXIFIER_FCM_CREDENTIALS"
```

---

### Task 6: Settings → Devices tab (web)

**Files:**
- Create: `src/web/devices.ts` (fetch layer)
- Create: `src/web/settingsDevices.ts`
- Modify: `src/web/settingsUi.ts` (type union L14, SECTIONS L26–38)

**Interfaces:**
- Consumes: `jsonFetch<T>(input, init?)` from `./http` (never raw `fetch` — `test/webHttp.test.js` enforces it); `el()` from `./dom`; `armReduce, IDLE, ARM_MS` from `./arming` (types at `src/web/arming.ts:9-27`); Task 2's routes.
- Produces: `renderDevicesSection(content: HTMLElement): Promise<void>`; tab id `'devices'`.

No DOM tests (vitest has no jsdom — established project rule); `npm run typecheck` gates the types and the tab is browser-verified at validation time.

- [ ] **Step 1: `src/web/devices.ts`**

```ts
// Fetch layer for enrolled Android devices (Settings → Devices).
import { jsonFetch } from './http';

export type DeviceInfo = {
  id: string;
  name: string;
  created: number | null;
  lastSeen: number | null;
  hasFcmToken: boolean;
  notify: Record<string, boolean>;
};

export async function listDevices(): Promise<DeviceInfo[]> {
  const res = await jsonFetch<{ devices: DeviceInfo[] }>('/api/devices');
  return res.devices;
}

export function revokeDevice(id: string): Promise<{ removed: boolean }> {
  return jsonFetch<{ removed: boolean }>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
```

- [ ] **Step 2: `src/web/settingsDevices.ts`**

```ts
// Settings → Devices: enrolled Android devices — list, last-seen, revoke.
// Enrollment happens in the app itself (URL + password), so this tab only
// reads and revokes. Revoke is irreversible for the device (it must re-enroll
// with the password), so it goes through the shared arm-then-fire reducer.
import { el } from './dom';
import { listDevices, revokeDevice, type DeviceInfo } from './devices';
import { armReduce, IDLE, ARM_MS, type ArmState } from './arming';

function when(t: number | null): string {
  if (!t) return 'never';
  const d = new Date(t);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export async function renderDevicesSection(content: HTMLElement): Promise<void> {
  content.replaceChildren(el('p', { class: 'muted' }, ['Loading…']));
  let devices: DeviceInfo[];
  try {
    devices = await listDevices();
  } catch {
    content.replaceChildren(el('p', { class: 'muted' }, ['Could not load devices.']));
    return;
  }

  let arm: ArmState = IDLE;
  let armTimer: number | undefined;

  const paint = () => {
    const rows = devices.map((d) => {
      const armed = arm.armed === d.id;
      const revoke = el('button', {
        type: 'button',
        class: armed ? 'danger armed' : 'danger',
        onclick: () => {
          const out = armReduce(arm, { type: 'click', id: d.id, armable: true });
          arm = out.state;
          window.clearTimeout(armTimer);
          if (out.fire) {
            void revokeDevice(out.fire).then(() => {
              devices = devices.filter((x) => x.id !== out.fire);
              paint();
            }).catch(() => paint());
          } else {
            armTimer = window.setTimeout(() => { arm = IDLE; paint(); }, ARM_MS);
          }
          paint();
        },
      }, [armed ? 'Really revoke?' : 'Revoke']);
      return el('div', { class: 'device-row' }, [
        el('div', { class: 'device-id' }, [
          el('strong', {}, [d.name]),
          el('span', { class: 'muted' }, [` · enrolled ${when(d.created)} · last seen ${when(d.lastSeen)}${d.hasFcmToken ? ' · push on' : ''}`]),
        ]),
        revoke,
      ]);
    });
    content.replaceChildren(
      el('h3', {}, ['Devices']),
      el('p', { class: 'muted' }, ['Android devices enrolled with the Tmuxifier app. Revoking a device signs it out on its next request; it re-enrolls with the password.']),
      devices.length ? el('div', { class: 'device-list' }, rows)
        : el('p', { class: 'muted' }, ['No devices enrolled. In the app: Settings → server URL + password.']),
    );
  };
  paint();
}
```

Add minimal styles to `src/web/style.css` beside the settings styles: `.device-row` (flex, space-between, padding block), `.device-list` (column gap). Follow DESIGN.md tokens — plain `var(--text)`/`var(--muted)` colors only, no new literals.

- [ ] **Step 3: Register the tab in `settingsUi.ts`**

- Type: `export type SettingsTab = 'boxes' | 'services' | 'netbox' | 'proxmox' | 'passkeys' | 'devices' | 'voice' | 'notifications' | 'appearance';`
- Import: `import { renderDevicesSection } from './settingsDevices';`
- SECTIONS, after `passkeys`: `devices: { label: 'Devices', render: (content) => renderDevicesSection(content) },`

- [ ] **Step 4: Typecheck + suite**

Run: `npm run typecheck` → clean. Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/devices.ts src/web/settingsDevices.ts src/web/settingsUi.ts src/web/style.css
git commit -m "feat(ui): Settings -> Devices tab (list + revoke enrolled app devices)"
```

---

### Task 7: Documentation sync

**Files:**
- Modify: `CLAUDE.md` (self-contained `data/` list; architecture module list; Security notes)
- Modify: `AGENTS.md` (same content — kept in sync with CLAUDE.md)
- Modify: `docs/authentication.md` (device-token section)

- [ ] **Step 1: CLAUDE.md / AGENTS.md**

Self-contained list: add `devices.json` to the `data/` enumeration — "`devices.json` (Android app device tokens — SHA-256 digests only, the token itself is never stored; FCM registration tokens; per-device notification toggles)".

Architecture list — two entries, in the established one-paragraph style:

- `deviceStore.js` — device-token auth for the Android app: `data/devices.json` CRUD in the `passkeyStore.js` mold (withLock mutex, `0o600`, corrupt-fails-open). Stores SHA-256 digests of 32-byte random tokens — fast digest on purpose: the entropy is the defence, and scrypt would tax the app's ~1s pane polling. `verify` compares with `timingSafeEqual`; `touch` throttles lastSeen writes to once a minute. Enrollment is password-authenticated through the same `rateLimit.js` bucket as login; revocation (Settings → Devices) takes effect on the device's next request.
- `fcmPush.js` — the first subscriber the `healthHistory.onEvent` seam ever had: agent-input/agent-done events become FCM HTTP v1 pushes to enrolled devices. Dependency-free in the `googleAuth.js` mold (RS256 JWT via `node:crypto`, cached OAuth2 token). `TMUXIFIER_FCM_CREDENTIALS` unset = feature off. Failures are logged, never propagated; an UNREGISTERED response clears that device's FCM token, never its auth.

Also update the `healthHistory.js` entry's "nothing subscribes to it" clause to note `fcmPush.js` now does (when configured).

Server.js route notes: mention `GET /api/boxes/:id/pane` (read-only tmux snapshot, never attaches, bounded `-S`), `POST /api/boxes/:id/keys` (literal text via `send-keys -l` + `NAMED_KEYS` closed allowlist), and Bearer device tokens accepted by `requireAuth`.

Security notes: device tokens join the credential story — password-gated enrollment, rate-limited, digest-at-rest, Bearer accepted alongside the cookie, revocation immediate on next request, `TMUXIFIER_FCM_CREDENTIALS` joins the `.env` secret class.

- [ ] **Step 2: docs/authentication.md**

Add a "Device tokens (Android app)" section: what they are, how enrollment works (app: URL + password + device name), that passkey-only mode blocks enrollment, revocation in Settings → Devices, the `.env` break-glass unaffected, v1 password-mode-only note.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/authentication.md
git commit -m "docs: device tokens, pane/keys routes, FCM push"
```

---

### Task 8: Whole-suite verification

- [ ] **Step 1:** `npm test` → PASS (typecheck + unit + integration).
- [ ] **Step 2:** `npm run test:e2e` → PASS (no e2e touches these routes, but the suite guards regressions in login/settings rendering — the settings modal gained a tab).
- [ ] **Step 3:** `npm run build` → clean.
- [ ] **Step 4:** Manual curl pass against a dev server (document output in the PR/branch notes):

```bash
node src/server/index.js &  # dev config
TOKEN=$(curl -s -X POST localhost:7437/api/devices/enroll -H 'content-type: application/json' \
  -d '{"password":"<dev pw>","name":"curl-test"}' | jq -r .token)
curl -s localhost:7437/api/boxes -H "Authorization: Bearer $TOKEN" | jq length
curl -s "localhost:7437/api/boxes/<id>/pane?lines=50" -H "Authorization: Bearer $TOKEN" | jq '.width, .agent'
curl -s -X POST localhost:7437/api/boxes/<id>/keys -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"key":"Enter"}'
```

- [ ] **Step 5:** Note for live validation (the operator's step, per the shipping checklist): this is a **server-touching** change — deploy the branch checkout or copy the changed server files, not just `dist/` (memory: the rsync-dist-only shortcut shipped a live bug in v1.24.25). Restart only when no jobs are running.

---

## Not in this plan

- The Android app itself (Kotlin/Compose, `android/`, Firebase client setup, keystore) — **separate plan**, written once these endpoints exist.
- OAuth-mode pairing codes, ntfy sender, APK-serving route — recorded v2 items in the spec.
