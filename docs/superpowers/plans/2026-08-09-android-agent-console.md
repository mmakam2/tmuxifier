# Android Agent Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Kotlin/Compose Android app that drives Claude Code sessions on fleet boxes — fleet glance, pane snapshot viewer, action row, composer, FCM push — plus the one missing server piece: pairing-code enrollment (the live server runs OAuth mode, where password enrollment 501s).

**Architecture:** Thin app, smart server. The server half (device tokens, `GET /api/boxes/:id/pane`, `POST /api/boxes/:id/keys`, `fcmPush.js`) shipped in v1.24.32; the app is a renderer of those APIs — it never speaks SSH, never emulates a terminal (tmux is the emulator; the app parses SGR spans out of `capture-pane -e` snapshots and renders native styled text). Tasks 1–3 add pairing-code enrollment to the server + web; Tasks 4–13 build the app in `android/`.

**Tech Stack:** Server: Node 20 ESM, Fastify, vitest (existing). App: Kotlin 2.1, Jetpack Compose (BOM 2024.12), single Gradle module, OkHttp 4.12, kotlinx.serialization, EncryptedSharedPreferences, firebase-messaging (conditional). JDK 17, AGP 8.7, compileSdk 35, minSdk 26.

## Global Constraints

- Repo rules: ESM everywhere on the server, TDD with real code (no mocks), factory functions with injected deps, `jsonFile.js` persistence discipline, conventional-commit messages.
- **Public repo — no PII.** Committed code/docs use placeholders only (`tmuxifier.example.com`, `192.168.1.10`). `google-services.json`, the signing keystore, `keystore.properties`, and `local.properties` are gitignored with `.example` counterparts committed in the same change that introduces them. The release checklist stages with `git add -A`, so `android/.gitignore` must exist **before** the first build ever runs.
- Server changes ship through the normal checklist (build, restart gated on no running setup/provision/lifecycle/fleet/voice-install job, health check) and are **validated on the live app before merge**.
- App UI is validated **on the real device** (Z Fold 6 cover screen, ~380dp); JVM unit tests cover pure logic only. No emulator.
- Chokepoint discipline: nothing user-typed reaches tmux as a key *name* (`NAMED_KEYS` is closed); pairing codes are validated server-side against a bounded, single-use, TTL'd store; failed attempts feed the login rate limiter.
- Build box is small: 4 cores, ~3 GB RAM, ~6.7 GB free disk. Gradle/Kotlin memory caps in `gradle.properties` are load-bearing, and the SDK install needs a disk preflight (`vendor/whisper` is ~1.2 GB and reclaimable if short).
- `graphify query "<question>"` before exploring source; raw reads only after orientation (machine-local rule in CLAUDE.local.md — applies to every subagent prompt too).

---

## Shipped server surface the app consumes (reference)

All routes require auth: session cookie **or** `Authorization: Bearer <device token>` (`requireAuth`, src/server/server.js:611).

- `POST /api/devices/enroll` — no auth; body `{password, name, fcmToken?}` (Task 2 adds `{code, name, fcmToken?}`). Returns `{id, name, created, lastSeen, hasFcmToken, notify, token}`. The `token` (43-char base64url) is returned **once**. 501 in OAuth mode (password branch), 403 under armed passkey-only, 429 rate-limited, 400 bad name.
- `PATCH /api/devices/self` — **Bearer-only** (cookie gets 403); body `{fcmToken?, notify?}`; PATCH-merge, `fcmToken: null` clears, notify booleans outright, kinds `agent-input`/`agent-done`. Returns the device public view.
- `GET /api/boxes` — `[{id, label, host, user?, port?, sessionName, tags, source, proxmox?}, …]`.
- `GET /api/status` — `Record<boxId, Status>`; `Status = {reachable, tmux?, needsAuth?, paused?, hostKeyChanged?, sessions?, metrics?, proxmoxState?, error?, nextProbeAt?}`; `metrics = {load1?, cpus?, cpuPct?, memTotalKb?, memAvailKb?, diskTotalKb?, diskUsedKb?, diskPct?, uptimeSec?, osId?, osVer?}`.
- `GET /api/health/series` — `Record<boxId, Sample[]>`; `Sample = {t, up, stopped?, tmux?, needsAuth?, keyChanged?, cpuPct?, memPct?, diskPct?, agent?: 'working'|'waiting', agentPresent?, agentAttached?}`.
- `GET /api/boxes/:id/pane?lines=N` — `{ok: true, width, height, cursorX, cursorY, content, agent: 'working'|'waiting'|null, sessionName}`. `content` = `capture-pane -e` output: scrollback+screen lines joined by `\n`, raw SGR escapes. The **visible screen is the last `height` lines**; `cursorX`/`cursorY` are 0-based within that screen. 502 `{error}` on capture failure (box unreachable, session missing), 404 unknown box.
- `POST /api/boxes/:id/keys` — body exactly one of `{text}` (≤65536 chars; server collapses whitespace runs to single spaces and strips C0/C1 — a newline would be Enter) or `{key}` from `NAMED_KEYS = Enter, Escape, Up, Down, Left, Right, Tab, BSpace, C-c` (src/server/tmuxInject.js:162 — note: **digits and y/n are NOT named keys**; the app sends them as `{text}`). Returns `{ok: true}` (or `{ok: true, skipped: 'empty'}` if the sanitizer ate everything); 400 on both/neither/unknown key, 502 on send failure.
- FCM messages (src/server/fcmPush.js): `notification: {title, body}` + `data: {boxId, kind}`. Sent on `agent-input`/`agent-done` events, suppressed while the session is attached, filtered per device by stored notify toggles. Enabled only when `TMUXIFIER_FCM_CREDENTIALS` points at a service-account JSON.
- `GET /api/devices/apk` / `GET /api/devices/apk/info` (added mid-plan, 2026-08-09): authenticated download of the signed APK published at `data/app/tmuxifier-console.apk`, plus its `{available, size, mtime}` readout. Settings → Devices shows the download link when available; Task 13 publishes the file.

---

### Task 1: Pairing-code store (`pairingCodes.js`)

Server-side single-use pairing codes so a device can enroll on an OAuth-mode (or passkey-only) server: an authenticated browser mints a short-lived code, the app exchanges it for a device token. Modeled on `passkeyChallenges.js` (bounded, TTL, single-use) but simpler — codes are minted only by authenticated sessions, so there is no per-owner flood policy, just a small global cap.

**Files:**
- Create: `src/server/pairingCodes.js`
- Test: `test/pairingCodes.test.js`

**Interfaces:**
- Produces: `createPairingCodes({ ttlMs = 120000, max = 4, now = Date.now })` → `{ mint(): {code, expiresAt}, take(raw): boolean, _size(): number }`. `code` is `XXXX-XXXX` from a 32-char ambiguity-free alphabet (40 bits); `take` normalizes case/dashes/spaces, compares SHA-256 digests with `timingSafeEqual`, deletes on success. Task 2 consumes this from the enroll route.

- [ ] **Step 1: Write the failing test**

```js
// test/pairingCodes.test.js
import { test, expect } from 'vitest';
import { createPairingCodes } from '../src/server/pairingCodes.js';

test('mint returns a XXXX-XXXX code that take() accepts once, in any typed form', () => {
  const pc = createPairingCodes();
  const { code, expiresAt } = pc.mint();
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  expect(expiresAt).toBeGreaterThan(Date.now());
  // lowercase, no dash, stray spaces — all the ways a human types it
  expect(pc.take(` ${code.toLowerCase().replace('-', '')} `)).toBe(true);
  expect(pc.take(code)).toBe(false); // single use
});

test('an unknown code is refused and spends nothing', () => {
  const pc = createPairingCodes();
  pc.mint();
  expect(pc.take('AAAA-AAAA')).toBe(false);
  expect(pc._size()).toBe(1); // a wrong guess must not burn the operator's code
});

test('codes expire at ttlMs', () => {
  let t = 1000;
  const pc = createPairingCodes({ ttlMs: 120000, now: () => t });
  const { code } = pc.mint();
  t += 120001;
  expect(pc.take(code)).toBe(false);
});

test('the store is bounded: minting past max evicts the oldest', () => {
  const pc = createPairingCodes({ max: 4 });
  const first = pc.mint();
  for (let i = 0; i < 4; i++) pc.mint();
  expect(pc._size()).toBe(4);
  expect(pc.take(first.code)).toBe(false);
});

test('degenerate max clamps rather than unbounding', () => {
  const pc = createPairingCodes({ max: 0 });
  pc.mint(); pc.mint();
  expect(pc._size()).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/tmuxifier && npx vitest run test/pairingCodes.test.js`
Expected: FAIL — `Cannot find module '../src/server/pairingCodes.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/server/pairingCodes.js
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Short-lived, single-use device pairing codes: an authenticated browser
// session mints one (Settings → Devices), the Android app exchanges it for a
// device token (POST /api/devices/enroll { code }). This is the OAuth-mode
// (and passkey-only) enrollment path — there is no password to present there.
//
// A code is typed by a human off another screen, so the alphabet drops the
// ambiguous glyphs (0/O, 1/I/L… — 32 symbols, so a masked byte is unbiased)
// and take() normalizes case and separators. 8 symbols = 40 bits: guessing is
// bounded by the login rate limiter (the enroll route feeds it), a 120s TTL,
// and at most `max` codes outstanding. Only the digest is held, compared with
// timingSafeEqual — same discipline as deviceStore.js.
//
// Bounded by simple oldest-first eviction, unlike passkeyChallenges.js's
// two-layer owner policy: minting requires an authenticated session, so there
// is no anonymous flood to defend against — the cap only keeps an operator
// mashing "Pair" from growing the array.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 chars — no 0/1/I/O
const digest = (s) => createHash('sha256').update(s).digest();
const canon = (raw) => String(raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

export function createPairingCodes({ ttlMs = 120_000, max = 4, now = Date.now } = {}) {
  const boundMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 4;
  const entries = []; // { hash, exp } — oldest first
  const reap = () => {
    const t = now();
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].exp <= t) entries.splice(i, 1);
  };
  return {
    mint() {
      reap();
      while (entries.length >= boundMax) entries.shift();
      const bytes = randomBytes(8);
      let code = '';
      for (let i = 0; i < 8; i++) code += ALPHABET[bytes[i] & 31];
      const exp = now() + ttlMs;
      entries.push({ hash: digest(code), exp });
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: exp };
    },
    // Deletes ONLY on a match: a wrong guess must not burn the operator's
    // in-flight code (the guesser doesn't hold it, so this spends nothing).
    take(raw) {
      reap();
      const d = digest(canon(raw));
      const idx = entries.findIndex((e) => timingSafeEqual(e.hash, d));
      if (idx === -1) return false;
      entries.splice(idx, 1);
      return true;
    },
    _size: () => { reap(); return entries.length; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pairingCodes.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/pairingCodes.js test/pairingCodes.test.js
git commit -m "feat(devices): bounded single-use pairing-code store"
```

---

### Task 2: Pairing routes — mint + enroll-by-code

Wire the store into `buildServer`: a cookie-authed mint route, and a `code` branch on the existing enroll route that works in **both** auth modes (and under armed passkey-only — the code was minted by a session that already passed the passkey gate, so this is exactly the delegation passkey-only intends; the password branch keeps its 403).

**Files:**
- Modify: `src/server/server.js` (imports ~line 29; `buildServer` signature line 118; enroll route lines 703–722; new mint route beside it)
- Test: `test/deviceRoutes.test.js` (append)

**Interfaces:**
- Consumes: `createPairingCodes` from Task 1.
- Produces: `POST /api/devices/pair` (auth required, **browser-session only** — a Bearer device gets 403 `{error: 'browser session required'}`) → `{code, expiresAt}`. `POST /api/devices/enroll` with `{code, name, fcmToken?}` → same response as the password branch; 401 `{error: 'invalid or expired code'}` feeds the login limiter. New `buildServer` param `pairingCodes = null` (tests inject a fake-clock instance; production defaults internally). Task 3 (web) and Task 6 (app) consume these routes.

- [ ] **Step 1: Write the failing tests** (append to `test/deviceRoutes.test.js`; it already builds a password-mode app in `beforeEach` — see its head for the fixtures)

```js
import { Signer } from '@fastify/cookie';
import { sessionValue } from '../src/server/auth.js';

test('pair mints only for a browser session; a device token gets 403', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/devices/pair' })).statusCode).toBe(401);
  const h = await cookieHeaders();
  const minted = (await app.inject({ method: 'POST', url: '/api/devices/pair', headers: h })).json();
  expect(minted.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  expect(minted.expiresAt).toBeGreaterThan(Date.now());
  const { token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  const viaDevice = await app.inject({ method: 'POST', url: '/api/devices/pair', headers: { authorization: `Bearer ${token}` } });
  expect(viaDevice.statusCode).toBe(403);
});

test('a minted code enrolls a device exactly once', async () => {
  const h = await cookieHeaders();
  const { code } = (await app.inject({ method: 'POST', url: '/api/devices/pair', headers: h })).json();
  const ok = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code, name: 'Fold' } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const authed = await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: `Bearer ${ok.json().token}` } });
  expect(authed.statusCode).toBe(200);
  const replay = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code, name: 'Again' } });
  expect(replay.statusCode).toBe(401);
});

test('bad codes feed the login limiter', async () => {
  for (let i = 0; i < 10; i++) {
    await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code: 'AAAA-AAAA', name: 'x' } });
  }
  const h = await cookieHeaders().catch(() => null); // login itself may now be limited — that IS the point
  const limited = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code: 'AAAA-AAAA', name: 'x' } });
  expect(limited.statusCode).toBe(429);
});

test('OAuth mode: password enroll still 501s but a pairing code enrolls', async () => {
  // Google-mode app has no /api/login; forge the session cookie the way the
  // server would sign it (same secret) — the only test in the file needing it.
  const config2 = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    cookieSecret: 'test-secret', dataDir: dir, localShell: 'none',
    configPath: path.join(dir, 'config.json'), authMode: 'google',
    googleClientId: 'id', googleClientSecret: 'secret', allowedEmails: ['a@example.com'],
    baseExternalUrl: 'https://tmuxifier.example.com',
  };
  const sessions2 = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const app2 = buildServer({
    config: config2, store: createStore({ dataDir: dir }), sessions: sessions2,
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    passkeyStore: createPasskeyStore({ dataDir: dir }), deviceStore,
  });
  const signed = new Signer(['test-secret']).sign(sessionValue());
  const h = { cookie: `tmuxifier_session=${encodeURIComponent(signed)}` };
  expect((await app2.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'x' } })).statusCode).toBe(501);
  const { code } = (await app2.inject({ method: 'POST', url: '/api/devices/pair', headers: h })).json();
  const ok = await app2.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code, name: 'Fold' } });
  expect(ok.statusCode).toBe(200);
});
```

Note for the implementer: the limiter is per-IP and `app.inject` requests share one IP, so the "bad codes" test may lock later tests' logins if vitest ever stops isolating files — it doesn't today (each file gets a fresh `beforeEach` app). If `new Signer(['test-secret'])` doesn't exist in the installed `@fastify/cookie` major, check `node -e "console.log(Object.keys(require('@fastify/cookie')))"` for the exported signer and adapt (v9+ exports `Signer`).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/deviceRoutes.test.js`
Expected: existing 6 pass; new 4 FAIL (404 on `/api/devices/pair`, 501/401 on code enroll)

- [ ] **Step 3: Implement the routes**

In `src/server/server.js`:

1. Import beside `createPasskeyChallenges` (~line 29): `import { createPairingCodes } from './pairingCodes.js';`
2. Add `pairingCodes = null,` to the `buildServer` destructured params (line 118, beside `deviceStore = null`).
3. Near the passkey challenge construction (~line 199): `const devicePairing = pairingCodes ?? createPairingCodes();`
4. Replace the enroll route body (lines 707–722) with:

```js
  app.post('/api/devices/enroll', async (req, reply) => {
    if (!deviceStore) return reply.code(501).send({ error: 'devices not supported' });
    const body = req.body || {};
    const ip = req.ip;
    if (loginLimiter.limited(ip)) return reply.code(429).send({ error: 'too many attempts' });
    if (typeof body.code === 'string' && body.code.length > 0) {
      // Pairing branch: mode-independent, and deliberately NOT gated on
      // passkey-only — the code was minted by an authenticated session, which
      // under an armed passkey-only flag was itself passkey-authenticated.
      // Guessing feeds the same limiter as a wrong password.
      if (!devicePairing.take(body.code)) { loginLimiter.fail(ip); return reply.code(401).send({ error: 'invalid or expired code' }); }
    } else {
      // Password branch: unchanged v1 semantics (password mode only).
      if (config.authMode === 'google') return reply.code(501).send({ error: 'device enrollment requires password mode or a pairing code' });
      if (passkeyOnlyArmed(await passkeySnapshot())) return reply.code(403).send({ error: 'passkey required' });
      const ok = await verifyPassword(body.password || '', config.passwordHash);
      if (!ok) { loginLimiter.fail(ip); return reply.code(401).send({ error: 'invalid' }); }
    }
    loginLimiter.succeed(ip);
    try {
      const { device, token } = await deviceStore.enroll({ name: body.name, fcmToken: body.fcmToken });
      return { ...device, token };
    } catch (e) {
      return reply.code(400).send({ error: e?.message || 'invalid device' });
    }
  });

  // Mint a pairing code for the app. Browser-session only: a device must not
  // be able to mint invites for further devices (revoking it would not revoke
  // what it invited). Inverse of /api/devices/self's Bearer-only gate.
  app.post('/api/devices/pair', { preHandler: requireAuth }, async (req, reply) => {
    if (!deviceStore) return reply.code(501).send({ error: 'devices not supported' });
    if (req.deviceId) return reply.code(403).send({ error: 'browser session required' });
    return devicePairing.mint();
  });
```

Also update the stale comment above the route ("v1 is password-mode only; OAuth-mode pairing codes are a recorded v2 item" → "password directly, or a single-use pairing code minted by an authenticated browser session (Settings → Devices) — the OAuth-mode/passkey-only path").

- [ ] **Step 4: Run the suite**

Run: `npx vitest run test/deviceRoutes.test.js && npm test`
Expected: all green (typecheck + full suite — the enroll route is exercised elsewhere too)

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/deviceRoutes.test.js
git commit -m "feat(devices): pairing-code enrollment for OAuth-mode and passkey-only servers"
```

---

### Task 3: Web pairing UI + docs + live deploy of the server half

Settings → Devices grows a "Pair new device" button showing the code with a live countdown. Then the server half deploys to the live app (validate-on-live), because Task 6's device enrollment needs the route live.

**Files:**
- Modify: `src/web/devices.ts` (fetch layer), `src/web/settingsDevices.ts` (button + countdown; also its enrollment copy), `docs/authentication.md` (device section), `CLAUDE.md` + `AGENTS.md` (deviceStore/server.js entries mention pairing)
- Test: `npm run typecheck` + full suite (DOM layers are untested by design — vitest has no DOM; `test/webHttp.test.js` enforces the fetch-layer seam automatically)

**Interfaces:**
- Consumes: `POST /api/devices/pair` (Task 2), `jsonFetch` from `src/web/http.ts` (never hand-roll `res.ok` — webHttp.test.js forbids it outside http.ts).
- Produces: `mintPairingCode(): Promise<{code: string; expiresAt: number}>` in devices.ts.

- [ ] **Step 1: Add the fetch function** (`src/web/devices.ts`)

```ts
export type PairingCode = { code: string; expiresAt: number };

/** Mint a single-use pairing code for enrolling the Android app (2min TTL). */
export function mintPairingCode(): Promise<PairingCode> {
  return jsonFetch<PairingCode>('/api/devices/pair', { method: 'POST' });
}
```

- [ ] **Step 2: Add the button + countdown to `settingsDevices.ts`**

Import `mintPairingCode`. Add module state beside `armTimer`: `let codeTimer: number | undefined;` and clear it in `stopDevicesWatch()` exactly like `armTimer`. Inside `renderDevicesSection`, add above `paint()`:

```ts
  let pairing: { code: string; expiresAt: number } | null = null;

  const pairRow = () => {
    if (!pairing) {
      return el('button', {
        type: 'button',
        onclick: () => {
          void mintPairingCode().then((p) => {
            if (my !== gen || content.isConnected === false) return;
            pairing = p;
            window.clearInterval(codeTimer);
            codeTimer = window.setInterval(() => {
              if (my !== gen || content.isConnected === false) { window.clearInterval(codeTimer); return; }
              if (pairing && pairing.expiresAt <= Date.now()) { pairing = null; window.clearInterval(codeTimer); }
              paint();
            }, 1000);
            paint();
          }).catch(() => paint());
        },
      }, ['Pair new device']);
    }
    const left = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
    return el('div', { class: 'pair-code' }, [
      el('code', {}, [pairing.code]),
      el('span', { class: 'muted' }, [` expires in ${left}s — enter it in the app: Settings → Pair`]),
    ]);
  };
```

Render `pairRow()` in `paint()`'s `content.replaceChildren(...)` between the intro paragraph and the device list. Update the two copy strings: the intro's "it re-enrolls with the password" → "it re-enrolls with a pairing code (or the password, in password mode)", and the empty state "In the app: Settings → server URL + password." → "In the app: Settings → server URL + a pairing code from the button above." Change `window.clearTimeout(armTimer)` in `stopDevicesWatch` to also `window.clearInterval(codeTimer)`. Add a minimal `.pair-code code` style in `src/web/style.css` only if the default `<code>` rendering is illegible in the modal — check visually first; DESIGN.md outranks ad-hoc styling.

- [ ] **Step 3: Typecheck + full suite**

Run: `npm test`
Expected: green (typecheck covers src/web)

- [ ] **Step 4: Update docs**

`docs/authentication.md`'s device-token section: document pairing-code enrollment (minted in Settings → Devices, 2-minute single-use code, works in both auth modes and under passkey-only; wrong codes feed the login rate limiter). `CLAUDE.md` + `AGENTS.md`: extend the `deviceStore.js` bullet and Security notes to mention `pairingCodes.js` and that OAuth-mode enrollment is no longer excluded (the "501s in OAuth mode" claims about enroll now apply to the password branch only). Update the auto-memory note if present.

- [ ] **Step 5: Commit, then validate on live and ship the server half**

```bash
git add -A && git commit -m "feat(ui): pairing-code minting in Settings -> Devices"
```

Then per CLAUDE.md "Shipping": build in the worktree, `rsync -a --delete <worktree>/dist/ /root/tmuxifier/dist/`, **deploy the server files too** (this is a server-touching change — the phone-composer round proved rsync-dist-only validation lies), wait until no setup/provision/lifecycle/fleet/voice-install job is `running`, restart, verify: log into the live web UI, mint a code in Settings → Devices, and `curl -sk -X POST https://<live>/api/devices/enroll -H 'content-type: application/json' -d '{"code":"<code>","name":"curl-test"}'` returns a token; revoke "curl-test" in the UI afterwards. Only then merge to main and run the release checklist (version bump, tag, push, `gh release create`).

---

### Task 4: Android build environment + project scaffold

JDK + SDK on the build box (machine-global, one-time), then `android/` as a single-module Compose app that compiles, runs one JVM unit test, and assembles a debug APK. The `.gitignore` lands **first** — the release checklist stages `git add -A`.

**Files:**
- Create: `android/.gitignore`, `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`, `android/gradle/wrapper/*` (generated), `android/gradlew` (generated), `android/local.properties.example`, `android/app/build.gradle.kts`, `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/java/com/tmuxifier/console/MainActivity.kt`, `android/app/src/test/java/com/tmuxifier/console/SmokeTest.kt`, `android/README.md` (build steps; grows in later tasks)

**Interfaces:**
- Produces: the Gradle module every later task compiles into; package `com.tmuxifier.console`; commands `./gradlew test` and `./gradlew assembleDebug` (run from `android/`).

- [ ] **Step 1: Preflight + install JDK and Android SDK (machine-global, skip what already exists)**

```bash
df -h / | tail -1                     # need ~5 GB free; if short: rm -rf /root/tmuxifier/vendor/whisper reclaims 1.2 GB (re-run npm run setup-voice later)
apt-get update && apt-get install -y openjdk-17-jdk-headless unzip
mkdir -p /opt/android-sdk/cmdline-tools
curl -fL -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q /tmp/clt.zip -d /opt/android-sdk/cmdline-tools && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest && rm /tmp/clt.zip
yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null
/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
curl -fL -o /tmp/gradle.zip https://services.gradle.org/distributions/gradle-8.10.2-bin.zip
unzip -q /tmp/gradle.zip -d /opt && rm /tmp/gradle.zip   # /opt/gradle-8.10.2/bin/gradle — bootstrap only; the wrapper takes over
```

If a download 404s, the pinned version moved — list current ones (`curl -s https://services.gradle.org/versions/current`) and use the nearest, recording the change in android/README.md.

- [ ] **Step 2: Write `android/.gitignore` and `android/local.properties.example` FIRST**

```gitignore
# android/.gitignore — secrets and machine/build state; the repo is public and
# the release checklist stages with `git add -A`, so this file must predate the
# first build. Placeholder counterparts: *.example beside each ignored file.
.gradle/
build/
local.properties
google-services.json
keystore/
keystore.properties
.kotlin/
```

```properties
# android/local.properties.example — copy to local.properties (gitignored)
sdk.dir=/opt/android-sdk
```

- [ ] **Step 3: Write the Gradle build files**

`android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "tmuxifier-console"
include(":app")
```

`android/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.0" apply false
    id("com.google.gms.google-services") version "4.4.2" apply false
}
```

`android/gradle.properties` (the memory caps are load-bearing — the box has ~3 GB RAM):

```properties
org.gradle.jvmargs=-Xmx1280m -XX:MaxMetaspaceSize=384m
kotlin.daemon.jvmargs=-Xmx768m
org.gradle.workers.max=2
android.useAndroidX=true
kotlin.code.style=official
```

`android/app/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.tmuxifier.console"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.tmuxifier.console"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    testImplementation("org.jetbrains.kotlin:kotlin-test:2.1.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
// Firebase joins in Task 12 (conditional google-services plugin).
```

`android/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:label="Tmuxifier"
        android:theme="@android:style/Theme.Material.NoActionBar"
        android:usesCleartextTraffic="true">
        <!-- cleartext: LAN/dev servers may be plain http; the live server is https -->
        <activity android:name=".MainActivity" android:exported="true" android:launchMode="singleTop">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

`android/app/src/main/java/com/tmuxifier/console/MainActivity.kt` (scaffold — Task 5+ replaces the body):

```kotlin
package com.tmuxifier.console

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { Surface { Text("Tmuxifier console") } } }
    }
}
```

`android/app/src/test/java/com/tmuxifier/console/SmokeTest.kt`:

```kotlin
package com.tmuxifier.console

import kotlin.test.Test
import kotlin.test.assertEquals

class SmokeTest {
    @Test fun jvmTestsRun() = assertEquals(4, 2 + 2)
}
```

- [ ] **Step 4: Generate the wrapper, build, test**

```bash
cd /root/tmuxifier/android
cp local.properties.example local.properties
/opt/gradle-8.10.2/bin/gradle wrapper --gradle-version 8.10.2
./gradlew test           # expected: BUILD SUCCESSFUL, SmokeTest passes
./gradlew assembleDebug  # expected: app/build/outputs/apk/debug/app-debug.apk exists
```

First build downloads dependencies (~10+ min on this box). If the Kotlin daemon OOMs, lower both `-Xmx` caps rather than raising them.

- [ ] **Step 5: Write `android/README.md` (initial) and commit**

README covers: prerequisites (JDK 17, SDK path in local.properties), the three commands above, the memory caps and why, and a placeholder section "Signing & Firebase — see Tasks 12–13" to be filled later. Then:

```bash
git status --short android/   # VERIFY: no local.properties, no build/, no .gradle/
git add android/ && git commit -m "feat(android): Compose app scaffold with JVM test + debug build"
```

---

### Task 5: App core — server config, API client, response models (JVM-tested)

Pure-Kotlin plumbing every screen uses: URL normalization, the OkHttp client with the Bearer header, kotlinx.serialization models for the five endpoints, and secure token storage. HTTP calls themselves are exercised on-device; JVM tests cover the pure parts (URL rules, JSON parsing of real fixture payloads).

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/api/ServerConfig.kt`, `api/Models.kt`, `api/ApiClient.kt`, `api/TokenStore.kt`
- Test: `android/app/src/test/java/com/tmuxifier/console/api/ServerConfigTest.kt`, `api/ModelsTest.kt` (delete `SmokeTest.kt`)

**Interfaces:**
- Produces (later tasks consume exactly these):
  - `normalizeBaseUrl(raw: String): String?` — trims, prepends `https://` when scheme-less, strips trailing `/`, null on garbage.
  - `@Serializable` models, every optional field defaulted to null: `BoxInfo(id, label, host, sessionName, tags)`, `BoxStatus(reachable, tmux?, needsAuth?, paused?, hostKeyChanged?, metrics?: Metrics, proxmoxState?, error?)`, `Metrics(load1?, cpus?, cpuPct?, memTotalKb?, memAvailKb?, diskTotalKb?, diskUsedKb?, diskPct?, uptimeSec?, osId?, osVer?)`, `Sample(t, up, stopped?, agent?, cpuPct?, memPct?, diskPct?)`, `PaneSnapshot(ok, width, height, cursorX, cursorY, content, agent?, sessionName?)`, `EnrollResponse(id, name, created?, lastSeen?, hasFcmToken, notify: Map<String, Boolean>, token)`, `DeviceView(id, name, hasFcmToken, notify)`.
  - `ApiClient(baseUrl: String, token: String?)`, suspend methods: `enroll(code, name, fcmToken?): EnrollResponse`, `boxes(): List<BoxInfo>`, `status(): Map<String, BoxStatus>`, `series(): Map<String, List<Sample>>`, `pane(boxId, lines = 200): PaneSnapshot`, `sendText(boxId, text)`, `sendKey(boxId, key)`, `updateSelf(fcmToken?, notify?): DeviceView`. All throw `ApiException(status: Int, message)` on non-2xx (`status = 0` for transport errors) — 401 is how screens learn the device was revoked.
  - `TokenStore(context)` — EncryptedSharedPreferences (Android Keystore master key): `var baseUrl: String?`, `var token: String?`, `var deviceName: String?`, `fun clear()`.

- [ ] **Step 1: Write the failing JVM tests**

```kotlin
// ServerConfigTest.kt
package com.tmuxifier.console.api

import kotlin.test.*

class ServerConfigTest {
    @Test fun schemeLessGetsHttps() = assertEquals("https://tmuxifier.example.com", normalizeBaseUrl(" tmuxifier.example.com "))
    @Test fun httpKeptForLan() = assertEquals("http://192.168.1.10:7437", normalizeBaseUrl("http://192.168.1.10:7437/"))
    @Test fun trailingSlashStripped() = assertEquals("https://x.example.com", normalizeBaseUrl("https://x.example.com/"))
    @Test fun garbageIsNull() { assertNull(normalizeBaseUrl("")); assertNull(normalizeBaseUrl("ht tp://x")); assertNull(normalizeBaseUrl("ftp://x.example.com")) }
}
```

```kotlin
// ModelsTest.kt — fixtures are REAL response shapes (see the plan's server-surface
// reference); unknown fields must be ignored (the server adds fields over time).
package com.tmuxifier.console.api

import kotlin.test.*

class ModelsTest {
    @Test fun paneSnapshotParses() {
        val snap = ApiJson.decodeFromString(PaneSnapshot.serializer(),
            """{"ok":true,"width":80,"height":24,"cursorX":3,"cursorY":22,"content":"line1\nline2","agent":"waiting","sessionName":"main","extra":1}""")
        assertEquals(80, snap.width); assertEquals("waiting", snap.agent)
        assertEquals(22, snap.cursorY)
    }
    @Test fun statusMapParses() {
        val m = ApiJson.decodeFromString(statusMapSerializer,
            """{"b1":{"reachable":true,"metrics":{"cpus":4,"memTotalKb":8000000,"memAvailKb":2000000,"osId":"debian","osVer":"12"}},"b2":{"reachable":false,"error":"timeout"}}""")
        assertEquals(4, m["b1"]?.metrics?.cpus); assertEquals(false, m["b2"]?.reachable)
    }
    @Test fun seriesParses() {
        val s = ApiJson.decodeFromString(seriesMapSerializer,
            """{"b1":[{"t":1723180000000,"up":true,"agent":"working","agentPresent":true}]}""")
        assertEquals("working", s["b1"]?.last()?.agent)
    }
    @Test fun enrollParses() {
        val e = ApiJson.decodeFromString(EnrollResponse.serializer(),
            """{"id":"abc123","name":"Fold","created":1,"lastSeen":null,"hasFcmToken":false,"notify":{"agent-input":true,"agent-done":true},"token":"tok"}""")
        assertEquals("tok", e.token); assertEquals(true, e.notify["agent-input"])
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cd android && ./gradlew test` → compile errors (unresolved symbols).

- [ ] **Step 3: Implement**

`ServerConfig.kt`:

```kotlin
package com.tmuxifier.console.api

/** Normalize what the operator typed into a base URL, or null if unusable.
 *  Scheme-less means https (the live server is behind TLS); explicit http is
 *  kept for LAN/dev. Trailing slash stripped so path-joins stay simple. */
fun normalizeBaseUrl(raw: String): String? {
    val t = raw.trim().trimEnd('/')
    if (t.isEmpty() || t.any { it.isWhitespace() }) return null
    val url = when {
        t.startsWith("https://") || t.startsWith("http://") -> t
        t.contains("://") -> return null
        else -> "https://" + t
    }
    val host = url.substringAfter("://")
    return if (host.isNotEmpty() && !host.contains('/')) url else null
}
```

`Models.kt`: the `@Serializable` data classes from Interfaces plus:

```kotlin
val ApiJson = Json { ignoreUnknownKeys = true; explicitNulls = false }
val statusMapSerializer = MapSerializer(String.serializer(), BoxStatus.serializer())
val seriesMapSerializer = MapSerializer(String.serializer(), ListSerializer(Sample.serializer()))
```

`notify` stays `Map<String, Boolean>` — kinds are server-defined, never enumerated client-side. `ApiClient.kt`: one shared `OkHttpClient` (10s call timeout); requests `Request.Builder().url(baseUrl + "/api/...")` with `Authorization: Bearer <token>` when token != null; bodies `ApiJson.encodeToString(...).toRequestBody("application/json".toMediaType())`; non-2xx → `ApiException(code, parsed {error} or "HTTP <code>")`; `IOException` → `ApiException(0, message)`; all methods suspend under `withContext(Dispatchers.IO)`. `sendText`/`sendKey` POST `/api/boxes/<id>/keys` with `{"text": ...}` / `{"key": ...}`. `TokenStore.kt`: `EncryptedSharedPreferences.create(context, "auth", MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(), PrefKeyEncryptionScheme.AES256_SIV, PrefValueEncryptionScheme.AES256_GCM)`.

- [ ] **Step 4: Run** — `./gradlew test` → PASS; `./gradlew assembleDebug` → BUILD SUCCESSFUL.

- [ ] **Step 5: Commit** — `git add android/ && git commit -m "feat(android): api client, models, secure token store"`

---

### Task 6: Enrollment + Settings screen; first on-device validation

The app becomes usable: Settings screen (server URL, device name, pairing code, Enroll, sign-out, font size) and a minimal shell that routes to Settings when unenrolled. **Prerequisite: Task 3's live deploy** — enrollment is validated against the real server with a real pairing code.

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/AppState.kt`, `Prefs.kt` (plain SharedPreferences: fontSize now, drafts in Task 11), `ui/SettingsScreen.kt`
- Modify: `MainActivity.kt` (shell)

**Interfaces:**
- Consumes: `ApiClient.enroll`, `TokenStore`, `normalizeBaseUrl` (Task 5).
- Produces: `AppState(context)` — owns `TokenStore` + `Prefs`, exposes `fun client(): ApiClient?` (null until enrolled), `val enrolled: Boolean`, `fun signOut()`. `sealed class Screen { object Fleet; data class Session(val boxId: String, val boxLabel: String); object Settings }` — Tasks 8–12 navigate these. `Prefs.fontSize: Float` (sp, default 14f, range 8–32).

- [ ] **Step 1: Build the Settings screen**

The app deliberately offers **only** the pairing-code path — it works against both server auth modes (and passkey-only), so a password field would be a second branch with no user. Password enrollment remains a server-side API (curl, tests). Compose column: `OutlinedTextField`s for server URL (prefilled), device name (default `android.os.Build.MODEL`), pairing code (`KeyboardCapitalization.Characters`); Enroll button → normalize URL (inline error on null) → `enroll(code, name)` in a coroutine → on success persist `TokenStore` and navigate to Fleet; on `ApiException` show its message (401 = wrong/expired code; 429 = "rate-limited — wait a minute"). When enrolled: show server + device name, the font-size slider, and Sign out behind a confirm dialog → `TokenStore.clear()` — copy notes the server-side record remains until revoked in web Settings → Devices (there is no self-delete route). Notification toggles arrive in Task 12.

- [ ] **Step 2: Wire the shell in MainActivity**

`rememberSaveable`-held `Screen` (custom Saver serializing to a string like `"session:<id>:<label>"`); start on Fleet if enrolled else Settings; `BackHandler` on Session → Fleet. Fleet/Session render placeholders until Tasks 8–9. On any `ApiException(401)` surfaced by a screen: show "Unauthorized — server revoked this device?" and route to Settings **without clearing the token** (auto-wiping on a middlebox 401 would destroy a working credential; sign-out stays explicit).

- [ ] **Step 3: JVM tests still green** — `./gradlew test`

- [ ] **Step 4: On-device validation (real device, live server)**

`./gradlew assembleDebug`; install on the Fold. Mint a code in web Settings → Devices; enroll. VERIFY: the web Devices tab lists the phone (last seen updates on the next app action); a wrong code shows the server's message; revoke from web → next app action lands on Settings with the unauthorized message; re-pairing works.

- [ ] **Step 5: Commit** — `git add android/ && git commit -m "feat(android): enrollment + settings screen with pairing-code flow"`

---

### Task 7: SGR span parser (pure Kotlin, TDD)

Turns `capture-pane -e` output into styled spans. The app's only "terminal" code — no cursor addressing, no scroll regions, just SGR state carried across a line list, everything else stripped.

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/pane/Sgr.kt`
- Test: `android/app/src/test/java/com/tmuxifier/console/pane/SgrTest.kt`

**Interfaces:**
- Produces (Task 9 consumes):
  - `data class Style(val fg: SgrColor? = null, val bg: SgrColor? = null, val bold: Boolean = false, val dim: Boolean = false, val italic: Boolean = false, val underline: Boolean = false, val inverse: Boolean = false)`
  - `sealed interface SgrColor { data class Ansi(val n: Int) : SgrColor; data class Palette(val n: Int) : SgrColor; data class Rgb(val r: Int, val g: Int, val b: Int) : SgrColor }`
  - `data class Span(val text: String, val style: Style)`
  - `fun parseSgr(content: String): List<List<Span>>` — one inner list per line, style state carried across newlines.
  - `fun xtermColor(c: SgrColor, bold: Boolean): Long` — 0xAARRGGBB; Ansi 0–15 from the standard xterm palette (bold promotes 0–7 to 8–15), Palette 16–231 the 6×6×6 cube, 232–255 grayscale, Rgb direct.

- [ ] **Step 1: Write the failing tests**

NOTE for the implementer: `E` is the ESC character written as the Kotlin escape `"\u001B"` — never paste a raw ESC byte into source (raw control bytes make git treat the file as binary and break plain grep; see the repo's review discipline). Same for the BEL in the OSC test (`\u0007`).

```kotlin
package com.tmuxifier.console.pane

import kotlin.test.*

private const val E = "\u001B"

class SgrTest {
    @Test fun plainTextIsOneSpanPerLine() {
        val lines = parseSgr("hello\nworld")
        assertEquals(listOf("hello"), lines[0].map { it.text })
        assertEquals(Style(), lines[0][0].style)
        assertEquals("world", lines[1][0].text)
    }
    @Test fun boldAndReset() {
        val l = parseSgr("a$E[1mb$E[0mc")[0]
        assertEquals(listOf("a", "b", "c"), l.map { it.text })
        assertTrue(l[1].style.bold); assertFalse(l[2].style.bold)
    }
    @Test fun ansiAndBrightForeground() {
        val l = parseSgr("$E[31mred $E[91mbright")[0]
        assertEquals(SgrColor.Ansi(1), l[0].style.fg)
        assertEquals(SgrColor.Ansi(9), l[1].style.fg)
    }
    @Test fun palette256AndTruecolor() {
        val l = parseSgr("$E[38;5;208mx$E[48;2;10;20;30my")[0]
        assertEquals(SgrColor.Palette(208), l[0].style.fg)
        assertEquals(SgrColor.Rgb(10, 20, 30), l[1].style.bg)
    }
    @Test fun attributesToggleOff() {
        val l = parseSgr("$E[1;2;3;4;7ma$E[22;23;24;27mb")[0]
        val a = l[0].style; assertTrue(a.bold && a.dim && a.italic && a.underline && a.inverse)
        assertEquals(Style(fg = a.fg, bg = a.bg), l[1].style)
    }
    @Test fun stateCarriesAcrossLines() {
        val lines = parseSgr("$E[32mgreen\nstill")
        assertEquals(SgrColor.Ansi(2), lines[1][0].style.fg)
    }
    @Test fun defaultColors39And49() {
        val l = parseSgr("$E[31;41mx$E[39;49my")[0]
        assertNull(l[1].style.fg); assertNull(l[1].style.bg)
    }
    @Test fun nonSgrSequencesAreStripped() {
        // capture-pane -e emits only SGR, but be defensive: CSI-not-m, OSC, charset
        val l = parseSgr("a$E[2Jb$E]0;title\u0007c$E(Bd")[0]
        assertEquals("abcd", l.joinToString("") { it.text })
    }
    @Test fun emptyParamsMeanReset() {
        val l = parseSgr("$E[1mx$E[my")[0]
        assertEquals(Style(), l[1].style)
    }
    @Test fun xtermColorMapsCubeAndGray() {
        assertEquals(0xFFFF8700L, xtermColor(SgrColor.Palette(208), false))
        assertEquals(0xFF080808L, xtermColor(SgrColor.Palette(232), false))
        assertEquals(0xFF0A141EL, xtermColor(SgrColor.Rgb(10, 20, 30), false))
    }
}
```

- [ ] **Step 2: Run to verify failure** — `./gradlew test` → unresolved references.

- [ ] **Step 3: Implement `Sgr.kt`**

Single scan: on ESC — if next is `[`, consume digits/`;` to a final byte; final `m` applies params to the running `Style` (empty param list → reset; codes 0, 1, 2, 3, 4, 7, 22 clears bold+dim, 23, 24, 27, 30–37, 39, 40–47, 49, 90–97 → Ansi 8–15, 100–107 → bg Ansi 8–15, and 38/48 extended forms consuming `5;n` or `2;r;g;b`); any other final byte discards the sequence. If next is `]` (OSC), consume to BEL or `ESC \`. Any other ESC-prefixed char: drop it with its ESC (covers `ESC ( B` by dropping one following char). Push a span on every style change and at line ends; split on `\n`. `xtermColor`: 16-entry `longArrayOf` of the standard xterm palette; cube `16 + 36r + 6g + b` with channel values `intArrayOf(0, 95, 135, 175, 215, 255)`; grayscale `232 + n` → channel `8 + 10*n`.

- [ ] **Step 4: Run** — `./gradlew test` → PASS.

- [ ] **Step 5: Commit** — `git add android/ && git commit -m "feat(android): SGR span parser with 16/256/truecolor support"`

---

### Task 8: Fleet screen

Home screen: vertical list of box cards, waiting agents on top. The card mapping is a pure function with JVM tests; the Compose layer renders it and polls.

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/fleet/FleetModel.kt` (pure), `ui/FleetScreen.kt`
- Modify: `MainActivity.kt` (route `Screen.Fleet` to the real screen; top-bar gear → Settings)
- Test: `android/app/src/test/java/com/tmuxifier/console/fleet/FleetModelTest.kt`

**Interfaces:**
- Consumes: `ApiClient.boxes/status/series`, models from Task 5, `Screen.Session` from Task 6.
- Produces (pure, in `FleetModel.kt`):
  - `data class BoxCard(val id: String, val label: String, val dot: Dot, val agent: String?, val agentForMin: Long?, val spec1: String, val spec2: String)` with `enum class Dot { OK, DOWN, AUTH, PAUSED, STOPPED }`
  - `fun fleetCards(boxes: List<BoxInfo>, status: Map<String, BoxStatus>, series: Map<String, List<Sample>>, now: Long): List<BoxCard>`
  - `fun fmtBytesKb(kb: Long): String` (e.g. `7.8G`, mirrors the web's fmtBytes but drops trailing `.0` like the fleet cards do)

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tmuxifier.console.fleet

import com.tmuxifier.console.api.*
import kotlin.test.*

private fun box(id: String, label: String) = BoxInfo(id = id, label = label, host = "h", sessionName = "main", tags = emptyList())

class FleetModelTest {
    @Test fun waitingSortsAboveWorkingAboveIdle() {
        val boxes = listOf(box("a", "alpha"), box("b", "beta"), box("c", "gamma"))
        val series = mapOf(
            "b" to listOf(Sample(t = 1000, up = true, agent = "waiting")),
            "c" to listOf(Sample(t = 1000, up = true, agent = "working")),
        )
        val cards = fleetCards(boxes, emptyMap(), series, now = 2000)
        assertEquals(listOf("b", "c", "a"), cards.map { it.id })
    }
    @Test fun agentDurationCountsBackToTheFlip() {
        // waiting for 4 minutes: the streak of samples with the same agent state
        val s = listOf(
            Sample(t = 0, up = true, agent = "working"),
            Sample(t = 240_000, up = true, agent = "waiting"),
            Sample(t = 300_000, up = true, agent = "waiting"),
        )
        val card = fleetCards(listOf(box("a", "alpha")), emptyMap(), mapOf("a" to s), now = 480_000)[0]
        assertEquals("waiting", card.agent)
        assertEquals(4L, card.agentForMin) // (480000 - 240000) / 60000
    }
    @Test fun specLinesFromMetrics() {
        val st = BoxStatus(reachable = true, metrics = Metrics(
            cpus = 4, osId = "debian", osVer = "12",
            memTotalKb = 8_192_000, diskUsedKb = 12_000_000, diskTotalKb = 40_000_000))
        val card = fleetCards(listOf(box("a", "alpha")), mapOf("a" to st), emptyMap(), now = 0)[0]
        assertEquals("debian 12 · 4 cores", card.spec1)
        assertTrue(card.spec2.contains("RAM"))
        assertEquals(Dot.OK, card.dot)
    }
    @Test fun dotPrecedence() {
        assertEquals(Dot.AUTH, fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = true, needsAuth = true)), emptyMap(), 0)[0].dot)
        assertEquals(Dot.DOWN, fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = false)), emptyMap(), 0)[0].dot)
        assertEquals(Dot.STOPPED, fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = false, proxmoxState = "stopped")), emptyMap(), 0)[0].dot)
    }
    @Test fun missingMetricsDegradeToPlaceholders() {
        val card = fleetCards(listOf(box("a", "x")), emptyMap(), emptyMap(), 0)[0]
        assertEquals("—", card.spec1); assertEquals("—", card.spec2)
    }
}
```

- [ ] **Step 2: Run to verify failure** — `./gradlew test`

- [ ] **Step 3: Implement `FleetModel.kt`**

Sort key: `waiting` = 0, `working` = 1, else 2; within a group, label (case-insensitive). Agent + duration from the box's series: last sample's `agent`; walk backwards while `agent` equals it, duration = `now - t(first sample of the streak)`, in whole minutes. Dot: `stopped` (proxmoxState == "stopped") > `AUTH` (needsAuth) > `DOWN` (!reachable) > `PAUSED` (paused) > `OK`. spec1 = `"<osId> <osVer> · <cpus> cores"` (skip missing parts; both missing → `"—"`); spec2 = `"<mem>G RAM · <used>G of <total>G disk"` via `fmtBytesKb`. Pure Kotlin, no Android imports.

- [ ] **Step 4: Run** — `./gradlew test` → PASS.

- [ ] **Step 5: Build `FleetScreen.kt` + wire the shell**

`LaunchedEffect` + `repeatOnLifecycle(STARTED)` loop: fetch boxes/status/series concurrently (`coroutineScope { async {} }`), map through `fleetCards`, delay 10s, repeat — **stopped in background by the lifecycle scope** (push covers it; spec requirement). Errors: keep last data, show a thin banner ("offline — retrying"); `ApiException(401)` → the shell's unauthorized path. Card: label + dot (colored circle) + agent chip ("waiting 4m" amber / "working" green) + the two spec lines, `onClick` → `Screen.Session(id, label)`. Top bar: "Tmuxifier" + gear.

- [ ] **Step 6: On-device check + commit**

Install, verify cards against the web dashboard (same boxes, same distro/cores/RAM/disk figures, waiting box sorts first). `git add android/ && git commit -m "feat(android): fleet screen with waiting-first box cards"`

---

### Task 9: Session screen — pane view

The core surface: 1s-polled snapshot rendered as native styled text, soft-wrapped, pinch-zoomable, inert to touch (scroll/select only — structurally no path to the pty).

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/pane/PaneRender.kt` (pure-ish: spans → AnnotatedString), `ui/SessionScreen.kt`
- Modify: `MainActivity.kt` (route `Screen.Session`)
- Test: `android/app/src/test/java/com/tmuxifier/console/pane/PaneRenderTest.kt`

**Interfaces:**
- Consumes: `ApiClient.pane`, `parseSgr`/`xtermColor`/`Style`/`Span` (Task 7), `Prefs.fontSize` (Task 6).
- Produces: `fun visibleWindow(lines: List<List<Span>>, height: Int): Pair<List<List<Span>>, Int>` — splits scrollback vs screen, returns all lines plus the index of the first screen line (cursor line = that index + cursorY). `SessionScreen(boxId, boxLabel, ...)` with a `bottomBar` slot Tasks 10–11 fill.

- [ ] **Step 1: Write the failing test** (`PaneRenderTest.kt`)

```kotlin
package com.tmuxifier.console.pane

import kotlin.test.*

class PaneRenderTest {
    @Test fun screenStartIsContentMinusHeight() {
        val lines = parseSgr((1..30).joinToString("\n") { "line" + it })
        val (all, screenStart) = visibleWindow(lines, height = 24)
        assertEquals(30, all.size)
        assertEquals(6, screenStart) // 30 - 24
    }
    @Test fun shortContentStartsAtZero() {
        val (_, screenStart) = visibleWindow(parseSgr("a\nb"), height = 24)
        assertEquals(0, screenStart)
    }
}
```

- [ ] **Step 2: Run to verify failure**, implement (`max(0, lines.size - height)`), run to green.

- [ ] **Step 3: Build the pane view in `SessionScreen.kt`**

- Poll: `repeatOnLifecycle(STARTED)` loop calling `pane(boxId)` every 1s; on failure keep the last snapshot and show a slim "reconnecting…" strip; three consecutive failures → keep trying but dim the pane. 401 → shell's unauthorized path.
- Render: `SelectionContainer { LazyColumn { itemsIndexed(lines) { i, spans -> Text(annotated(spans, cursor if i == cursorLine)) } } }`. `annotated()` builds an `AnnotatedString` applying per-span `SpanStyle(color = Color(xtermColor(fg, bold)), background, fontWeight, fontStyle, textDecoration)`; inverse swaps fg/bg; dim lowers alpha to 0.6; default fg/bg come from `MaterialTheme.colorScheme` (dark surface — pick a near-black background so ANSI colors read like a terminal). Cursor: a `SpanStyle(background = accent)` over the single character at `cursorX` on the cursor line (append a space first if the line is shorter). `FontFamily.Monospace`, `softWrap = true` — **never** shrink to fit 80 columns.
- Pinch: `Modifier.pointerInput(Unit) { detectTransformGestures { _, _, zoom, _ -> fontSize = (fontSize * zoom).coerceIn(8f, 32f) } }` on the pane container, persisted to `Prefs.fontSize` (shared with Settings' slider).
- Follow-bottom: `LazyListState`; if the list was at the last item before a snapshot update, `scrollToItem(last)` after it; a scrolled-back view stays put and shows a small "▼ latest" chip that jumps down.
- Header: box label + agent chip from the snapshot's `agent` (same colors as Fleet), overflow menu with "Open in browser" → `Intent(ACTION_VIEW, Uri.parse(baseUrl))`.
- Touch inertness is structural: the pane composables simply have **no** click/key handlers wired to the API — selection and scroll are the only gestures that do anything.

- [ ] **Step 4: On-device validation**

Open a session with claude running (drive it from the desktop). VERIFY: output readable at the chosen size on the cover screen with no horizontal panning; colors/bold match the web terminal for the same pane; pinch persists across screens; scrollback reaches ~200 lines; stray taps in the pane do nothing (success criteria 2 and 4); the desktop tmux window never resizes while viewing (criterion 5 — watch `tmux display -p '#{window_width}'` on the box before/during/after).

- [ ] **Step 5: Commit** — `git add android/ && git commit -m "feat(android): session pane view with SGR rendering, pinch zoom, follow-bottom"`

---

### Task 10: Action row + arming (^C)

Semantic keys for driving Claude, with the destructive one behind a two-tap arm — a Kotlin port of the web's `arming.ts` policy (first tap arms, second commits, anything else disarms, 3s timeout).

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/keys/Arming.kt` (pure), `ui/ActionRow.kt`
- Modify: `ui/SessionScreen.kt` (mount in the bottomBar slot, above the composer)
- Test: `android/app/src/test/java/com/tmuxifier/console/keys/ArmingTest.kt`

**Interfaces:**
- Consumes: `ApiClient.sendKey/sendText` (Task 5), the bottomBar slot (Task 9).
- Produces: `data class ArmState(val armed: String?)`; `fun armReduce(state: ArmState, clickedId: String, armable: Boolean): Pair<ArmState, String?>` (second = id to fire, or null); `const val ARM_MS = 3000L`. Key catalog `ACTION_KEYS: List<ActionKey>` where `data class ActionKey(val label: String, val send: SendSpec, val armed: Boolean = false)` and `sealed interface SendSpec { data class Named(val key: String); data class Text(val text: String) }`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tmuxifier.console.keys

import kotlin.test.*

class ArmingTest {
    @Test fun plainKeyFiresImmediately() {
        val (s, fire) = armReduce(ArmState(null), "Enter", armable = false)
        assertEquals(null, s.armed); assertEquals("Enter", fire)
    }
    @Test fun armableArmsThenFires() {
        val (s1, f1) = armReduce(ArmState(null), "C-c", armable = true)
        assertEquals("C-c", s1.armed); assertNull(f1)
        val (s2, f2) = armReduce(s1, "C-c", armable = true)
        assertNull(s2.armed); assertEquals("C-c", f2)
    }
    @Test fun anythingElseDisarmsAndFiresItself() {
        val (s1, _) = armReduce(ArmState(null), "C-c", armable = true)
        val (s2, f2) = armReduce(s1, "Enter", armable = false)
        assertNull(s2.armed); assertEquals("Enter", f2)
    }
    @Test fun catalogSendsDigitsAsTextNotNamedKeys() {
        // NAMED_KEYS server-side has no digits/y/n — they must go as {text}
        val one = ACTION_KEYS.first { it.label == "1" }
        assertEquals(SendSpec.Text("1"), one.send)
        val esc = ACTION_KEYS.first { it.label == "Esc" }
        assertEquals(SendSpec.Named("Escape"), esc.send)
    }
}
```

- [ ] **Step 2: Run to verify failure**, implement `Arming.kt`:

Catalog (labels → sends): `Esc→Named("Escape")`, `↑→Named("Up")`, `↓→Named("Down")`, `Tab→Named("Tab")`, `⏎→Named("Enter")`, `1/2/3→Text`, `y/n→Text`, `^C→Named("C-c"), armed=true`. `armReduce` exactly as the web reducer: armable + not armed → arm, fire null; armable + armed with same id → disarm, fire id; anything else → disarm, fire its own id (non-armable always fires). Run to green.

- [ ] **Step 3: Build `ActionRow.kt`**

Single horizontal row of compact buttons (min touch target 40dp, monospace labels), thumb zone at the bottom. Armed ^C renders highlighted with label "sure?"; a 3s `LaunchedEffect` timeout resets to idle. Each fire → `sendKey`/`sendText` in a coroutine; a 502 shows a snackbar with the server's error. Mount above the composer slot in SessionScreen.

- [ ] **Step 4: On-device validation**

Drive a claude option list: answer with `1`/`2`/`y`/`⏎` from the row without touching the TUI (criterion 3, option-list half); `^C` needs two taps; `↑` recalls history in a shell pane.

- [ ] **Step 5: Commit** — `git add android/ && git commit -m "feat(android): action row with armed interrupt"`

---

### Task 11: Composer

The reason the app exists: a real Android multiline field where all editing is local until Send. Send = literal text, then Enter as a named key. Draft persists per box.

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/keys/Composer.kt` (pure), `ui/ComposerBar.kt`
- Modify: `ui/SessionScreen.kt` (bottom of the bottomBar slot), `Prefs.kt` (per-box drafts: `draft(boxId): String` / `setDraft(boxId, text)` on plain SharedPreferences keys `draft.<boxId>`)
- Test: `android/app/src/test/java/com/tmuxifier/console/keys/ComposerTest.kt`

**Interfaces:**
- Consumes: `ApiClient.sendText/sendKey`, `Prefs`.
- Produces: `fun sendTextOf(draft: String): String` — the client-side mirror of the server's `sanitizeSendText` (and of web `composer.ts`): whitespace runs (including newlines — a newline through send-keys IS Enter) collapse to single spaces, remaining C0/C1 controls stripped, trimmed.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.tmuxifier.console.keys

import kotlin.test.*

class ComposerTest {
    @Test fun newlinesCollapseToSpaces() = assertEquals("a b c", sendTextOf("a\nb\n\nc"))
    @Test fun whitespaceRunsCollapse() = assertEquals("a b", sendTextOf("  a \t b  "))
    @Test fun controlsStripped() = assertEquals("ab", sendTextOf("a\u0007\u009Bb"))
    @Test fun emptyStaysEmpty() = assertEquals("", sendTextOf("   \n  "))
}
```

- [ ] **Step 2: Run to verify failure**, implement: collapse `Regex("\s+")` matches to a single space, strip `Regex("[\u0000-\u0008\u000B-\u001F\u007F-\u009F]")`, trim. Run to green.

- [ ] **Step 3: Build `ComposerBar.kt`**

Multiline `OutlinedTextField` (max ~4 visible lines, grows from one) + a Send icon button. State: `draft` initialized from `Prefs.draft(boxId)`, persisted on every change (cheap; survives process death and pane switches). Send:

1. `val text = sendTextOf(draft)`
2. `text.isEmpty()` → `sendKey("Enter")` only (empty Send = bare Enter).
3. Else `sendText(text)`; on success clear the draft + `Prefs`, then `sendKey("Enter")`; if Enter fails, snackbar "sent — Enter failed, tap ⏎" (the action row recovers). If `sendText` itself fails, keep the draft and show the error — **Send never destroys a draft the pane didn't accept** (the web composer's rule).

Voice dictation needs no code: the Samsung keyboard's mic types into the field like any IME — nothing reaches the pty until Send.

- [ ] **Step 4: On-device validation**

Draft a multi-sentence prompt using autocorrect + voice dictation, edit it freely mid-draft, send: it lands in claude's input intact, zero IME-vs-terminal interference (criterion 3). Draft survives: switch to Fleet and back, kill the app and reopen. Empty Send submits claude's pending input.

- [ ] **Step 5: Commit** — `git add android/ && git commit -m "feat(android): per-box composer with local-until-send editing"`

---

### Task 12: FCM push + tap-through + notification toggles

Lock-screen delivery: Firebase config (conditional — the public repo builds without it), the messaging service, tap-through to the box's session, and per-kind toggles in Settings. Server side already ships (`fcmPush.js`); this task also sets up the operator's Firebase project and turns the live server's sender on.

**Files:**
- Create: `android/app/google-services.json.example` (placeholder with `com.tmuxifier.console` package + dummy ids), `android/app/src/main/java/com/tmuxifier/console/push/PushService.kt`, `push/Push.kt` (helpers)
- Modify: `android/build.gradle.kts` + `android/app/build.gradle.kts` (conditional plugin + deps), `AndroidManifest.xml` (service + POST_NOTIFICATIONS), `ui/SettingsScreen.kt` (toggles), `AppState.kt` (FCM token sync), `android/README.md` (Firebase setup section)

**Interfaces:**
- Consumes: `ApiClient.updateSelf`, `ApiClient.enroll(fcmToken)`, `Screen.Session` routing, FCM `data: {boxId, kind}` + `notification: {title, body}` (see the server-surface reference).
- Produces: `pushAvailable(context): Boolean` (`FirebaseApp.getApps(context).isNotEmpty()` behind try/catch — false when built without google-services.json); notification channel id `"agent"`.

- [ ] **Step 1: Conditional Firebase wiring**

`android/app/build.gradle.kts` bottom:

```kotlin
// Firebase only when the operator's config exists — the public repo must build
// without it (placeholder-counterpart rule); push is simply off then.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
```

Dependency `implementation("com.google.firebase:firebase-messaging:24.1.0")` stays unconditional (harmless without init). Commit the `.example` with dummy project ids and a comment pointing at README. VERIFY the build stays green with no real file present: `./gradlew assembleDebug`.

- [ ] **Step 2: Operator-side setup (manual, documented in android/README.md)**

Firebase console: create project, add Android app with package `com.tmuxifier.console`, download `google-services.json` into `android/app/` (gitignored). Project settings → Service accounts → generate the service-account JSON, copy to the server box outside the repo or as a gitignored path, set `TMUXIFIER_FCM_CREDENTIALS=<path>` in the live `.env` (it joins the `.env` secret class). Restart the live server per the deploy gate. Document the keystore-grade warning: the service-account JSON can send push as your project.

- [ ] **Step 3: PushService + manifest**

```kotlin
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // Fire-and-forget: if enrolled, PATCH /api/devices/self {fcmToken}.
        // Enrollment itself passes the current token via enroll(fcmToken).
    }
    override fun onMessageReceived(msg: RemoteMessage) {
        val boxId = msg.data["boxId"] ?: return
        val kind = msg.data["kind"] ?: ""
        // Channel "agent"; tap intent = MainActivity with extras boxId/kind,
        // FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE; notification id = boxId.hashCode()
        // so a newer event for the same box replaces the older one.
    }
}
```

Manifest: `<service android:name=".push.PushService" android:exported="false"><intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT"/></intent-filter></service>` + `<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>`. MainActivity: request POST_NOTIFICATIONS once on first enrolled launch (API 33+); `onCreate`/`onNewIntent` read the `boxId` extra → `Screen.Session(boxId, label from last-known boxes or boxId)`. Background-delivered notification taps carry `msg.data` as launcher-intent extras automatically — read the same key in both paths.

- [ ] **Step 4: Token sync + Settings toggles**

On app start when enrolled and `pushAvailable()`: fetch `FirebaseMessaging.getInstance().token` and `updateSelf(fcmToken)` if it differs from a locally cached copy. Enrollment (Task 6 flow) now passes the token when available. Settings: two switches "Agent needs input" / "Agent finished" reflecting `notify` from `updateSelf`'s response (fetch current state by sending an empty PATCH `{}` — it returns the device view), each change PATCHing `{notify: {<kind>: bool}}` — booleans outright, the server merges (the PATCH-merge rule: an omitted key keeps its stored value).

- [ ] **Step 5: On-device validation (criterion 1 + 6, end-to-end)**

Phone locked. From the desktop, give the claude session on a box a task that ends in a question; detach the web terminal (events are suppressed while attached). VERIFY: lock-screen buzz on `agent-input`; thumbprint → tap → that box's session screen in one tap. Toggle "Agent finished" off → no push on done, still one on input. Web Settings → Devices shows "push on". Revoke the device → next app request 401s (criterion 6) and pushes stop (the server clears the FCM token on UNREGISTERED; re-check devices.json after a day if curious).

- [ ] **Step 6: Commit** — `git add android/ && git commit -m "feat(android): FCM push with tap-through and per-kind toggles"`

---

### Task 13: Release build, signing, docs, ship

Signed APK, the keystore-backup obligation where the build steps live, user + repo docs, and the final walk of the spec's success criteria.

**Files:**
- Create: `android/keystore.properties.example`, `android/keystore/` (gitignored; generated locally), `docs/android-app.md`
- Modify: `android/app/build.gradle.kts` (release signing), `android/README.md` (final), `README.md` (feature section linking docs/android-app.md), `CLAUDE.md` + `AGENTS.md` (android/ section + pairing notes), `docs/authentication.md` (if not finished in Task 3)

- [ ] **Step 1: Generate the keystore (local, never committed)**

```bash
mkdir -p android/keystore
keytool -genkeypair -v -keystore android/keystore/release.jks -alias tmuxifier \
  -keyalg RSA -keysize 4096 -validity 10000 -storepass "$(read -s -p 'store pass: ' p; echo $p)"
cp android/keystore.properties.example android/keystore.properties  # then fill in
```

`android/keystore.properties.example`:

```properties
storeFile=keystore/release.jks
storePassword=CHANGE_ME
keyAlias=tmuxifier
keyPassword=CHANGE_ME
```

- [ ] **Step 2: Wire release signing (conditional, like Firebase)**

```kotlin
val ksProps = rootProject.file("keystore.properties")
android {
    signingConfigs {
        if (ksProps.exists()) {
            create("release") {
                val p = java.util.Properties().apply { load(ksProps.inputStream()) }
                storeFile = rootProject.file(p.getProperty("storeFile"))
                storePassword = p.getProperty("storePassword")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = p.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (ksProps.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }
}
```

`./gradlew assembleRelease` → `app/build/outputs/apk/release/app-release.apk`; `git status --short android/` must show no keystore/properties files.

- [ ] **Step 3: Document**

`android/README.md` (complete): toolchain install, memory caps, build/test commands, Firebase setup, signing, and — **bold, top of the signing section** — the keystore backup obligation: losing `android/keystore/release.jks` breaks update-in-place installs forever (uninstall/reinstall loses app data); back it up off-box now (e.g. alongside whatever already backs up `.env`). `docs/android-app.md`: operator guide — what the app is (agent console, not a terminal), pairing walkthrough (web Settings → Devices → Pair new device → code into the app), screens, push setup, revocation, "Open in browser" for real shell work. README.md: short section linking it. CLAUDE.md/AGENTS.md: an `android/` paragraph (thin-client architecture, JVM-tests-only-for-logic, on-device validation rule, the build lives outside `npm test`) and the Security-notes pairing update if Task 3 left any.

- [ ] **Step 4: Final validation — walk all six success criteria on the real device**

1. Locked-phone buzz on waiting → one tap to that session. 2. Cover-screen readability at chosen font. 3. Draft/edit/dictate/send with zero interference; option lists answered from the action row. 4. No stray touch activates anything in the TUI. 5. Desktop tmux window size undisturbed by phone viewing. 6. Web revoke locks the app out on its next request. Record pass/fail per criterion in the task report; a failure is a bug to fix before shipping, not a footnote.

- [ ] **Step 5: Ship**

Publish the APK to the live server so Settings → Devices offers it (the primary distribution path — the routes shipped with Tasks 1–3):

```bash
mkdir -p /root/tmuxifier/data/app
cp android/app/build/outputs/apk/release/app-release.apk /root/tmuxifier/data/app/tmuxifier-console.apk
```

No restart needed — the route stats the file per request. Verify the link appears in Settings → Devices and installs on the phone from the signed-in browser. Then merge the branch to main; run the repo release checklist (version bump, build, restart gate, health check, PII scrub of `git diff --cached` — android/ adds new file classes to eyeball: no real hostnames in committed Kotlin/docs, no google-services.json, no keystore). Tag + `gh release create`. Do **not** attach the APK to the GitHub release — it embeds the Firebase project id, and the authenticated route already distributes it; docs/android-app.md records that.

---

## Execution notes

- **Order:** Tasks 1→3 (server+web, one branch, live-validated, shipped) unblock Task 6's enrollment; Tasks 4–5 can start in parallel with the Task 3 deploy. Within the app, 7 (SGR) is independent of 6 and can precede it; 8–12 are sequential on their predecessors; 13 last.
- **Worktrees:** server tasks follow the repo's worktree + validate-on-live flow. App tasks build in-repo (`android/`); the SDK/JDK install (Task 4 Step 1) is machine-global and done once.
- **`npm test` never sees Kotlin** — Gradle is the app's test runner; don't wire it into the Node suite. The graphify Stop hook re-indexes `android/` like any source; nothing to do there.
- **Device validation is a hard gate**, not a nicety: every phone round in this repo's history found real bugs only on the device. A task whose validation step fails is not done.
