# Passkey Fresh-Assertion Arming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arming "require a passkey" (`passkeyOnly`) demands a fresh, successful WebAuthn assertion, proving a credential works now in the arming browser.

**Architecture:** A new authenticated `POST /api/passkeys/only/begin` issues a challenge of new kind `'arm'` (stored in the authenticated challenge store, immune to anonymous login floods). The `enabled: true` branch of `POST /api/passkeys/only` then requires and verifies the assertion with the exact `verifyAssertion` path login uses. Disarm stays byte-for-byte unconditional. The Settings UI keeps its confirm modal; its Arm button now runs the WebAuthn ceremony.

**Tech Stack:** Node 20+ ESM, Fastify (server plain `.js`), TypeScript web client (Vite), vitest with real WebAuthn fixtures (no mocks).

**Spec:** `docs/superpowers/specs/2026-07-23-passkey-fresh-assertion-arming-design.md`

## Global Constraints

- No new runtime dependencies (the project has exactly 5; keep it that way).
- Server code is plain `.js` under `src/server/`; web client is `.ts` under `src/web/`.
- TDD with real code, not mocks — tests build the real server via `buildServer` and sign with real keypairs from `test/helpers/webauthnFixtures.js`.
- Tests/docs use placeholder hostnames only (`tmux.example.com`) — the repo is public, no real PII.
- Conventional-commit messages (`feat(auth): …`, `test(auth): …`, `docs: …`).
- Disarming (`enabled: false`) must remain possible with no assertion in every state — it is the recovery path.
- All commands run from the repo root `/root/tmuxifier`.

---

### Task 1: Server — `POST /api/passkeys/only/begin`

**Files:**
- Modify: `src/server/server.js` (passkey section; insert the new route directly above the existing `app.post('/api/passkeys/only', …)` at ~line 327)
- Test: `test/passkeyRoutes.test.js` (append new tests at the end)

**Interfaces:**
- Consumes (already in `server.js`, no changes to them): `pkReady(reply)`, `issueChallenge(req, reply, kind)`, `PK_TTL_SECONDS`, `rpId`, `config.passkeyOnlyKillSwitch`, `passkeyStore.listRaw()`, `requireAuth`.
- Produces: route `POST /api/passkeys/only/begin` returning `{ challenge: string(base64url, 32 bytes), rpId: string, timeout: number, userVerification: 'required', allowCredentials: [] }` and setting the signed `tmuxifier_pk` challenge cookie with a kind-`'arm'` challenge. Task 2 finishes this ceremony; Task 3 calls it from the client as `pk.onlyBegin()`.

Note on the challenge store: `challengeStoreFor` in `server.js` is `(kind) => (kind === 'auth' ? pkLoginChallenges : pkChallenges)` — kind `'arm'` therefore already lands in the authenticated store (`pkChallenges`, shared with `'reg'`) with **no change** to that helper. Do not modify `challengeStoreFor` or `passkeyChallenges.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/passkeyRoutes.test.js`:

```js
// --- fresh-assertion arming (spec: 2026-07-23-passkey-fresh-assertion-arming-design.md) ---

test('only/begin requires auth', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/only/begin' })).statusCode).toBe(401);
});

test('only/begin issues an arm challenge with the login-begin shape', async () => {
  await enroll();
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ rpId: RP, userVerification: 'required', allowCredentials: [] });
  expect(Buffer.from(res.json().challenge, 'base64url')).toHaveLength(32);
  expect(pkCookie(res)).toMatch(/^tmuxifier_pk=/);
});

test('only/begin refuses when the kill switch is set', async () => {
  await enroll();
  app = await build({ passkeyOnlyKillSwitch: true });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/TMUXIFIER_PASSKEY_ONLY/);
});

test('only/begin refuses with nothing enrolled', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/enroll a passkey/);
});

test('only/begin reports the same rp-id failures as the other authenticated ceremonies', async () => {
  await enroll(); // pins the store to RP
  app = await build({ rpId: null });
  const noRp = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(noRp.statusCode).toBe(503);
  expect(noRp.json().error).toMatch(/domain name/);
  app = await build({ rpId: 'changed.example.com' });
  const mismatch = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.json().error).toMatch(/enrolled for/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/passkeyRoutes.test.js -t 'only/begin'`
Expected: 5 tests FAIL — the route does not exist yet, so injected requests return 404 (or 401 assertions mismatch).

- [ ] **Step 3: Implement the route**

In `src/server/server.js`, directly **above** `app.post('/api/passkeys/only', …)`, insert:

```js
  // Arming passkey-only requires proof that a credential works NOW, in the
  // arming browser — not merely that one is enrolled (it may live on a
  // since-lost device). This begins that ceremony; the assertion is verified
  // by POST /api/passkeys/only itself. Kind 'arm' lands in the authenticated
  // challenge store (see challengeStoreFor), so anonymous login floods cannot
  // evict it, and take()'s kind check keeps login challenges unusable here.
  app.post('/api/passkeys/only/begin', { preHandler: requireAuth }, async (req, reply) => {
    if (config.passkeyOnlyKillSwitch) {
      return reply.code(409).send({ error: 'TMUXIFIER_PASSKEY_ONLY=off is set in .env — remove it and restart before arming this' });
    }
    if (!(await pkReady(reply))) return reply;
    if ((await passkeyStore.listRaw()).length === 0) {
      return reply.code(409).send({ error: 'enroll a passkey first' });
    }
    const challenge = issueChallenge(req, reply, 'arm');
    return {
      challenge: challenge.toString('base64url'),
      rpId,
      timeout: PK_TTL_SECONDS * 1000,
      userVerification: 'required',
      allowCredentials: [],
    };
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/passkeyRoutes.test.js`
Expected: all tests in the file PASS (the new 5 plus every pre-existing one).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/passkeyRoutes.test.js
git commit -m "feat(auth): add POST /api/passkeys/only/begin arm-ceremony challenge route"
```

---

### Task 2: Server — require the assertion in `POST /api/passkeys/only`

**Files:**
- Modify: `src/server/server.js` (the `enabled: true` branch of `app.post('/api/passkeys/only', …)`)
- Test: `test/passkeyRoutes.test.js` (new tests + update the existing tests that arm via the route)

**Interfaces:**
- Consumes: the kind-`'arm'` challenge from Task 1's route; existing helpers `takeChallenge(req, 'arm')`, `verifyAssertion`, `passkeyOriginOk`, `passkeyStore.touch`, `PK_COOKIE`.
- Produces: `POST /api/passkeys/only` with `{ enabled: true, id, response }` (the `id` and `response` fields exactly as `login/finish` receives them from `serializeAssertion`) arms only after verification. `{ enabled: false }` unchanged. Task 3's `pk.setOnly(true, assertion)` sends this shape.

- [ ] **Step 1: Add the ceremony helper and new failing tests**

In `test/passkeyRoutes.test.js`, add below the existing `enroll()` helper (~line 152):

```js
// Full arm ceremony: begin, sign the challenge with the fixture
// authenticator, finish. Returns the finish response.
async function armWithAssertion(h, auth, { signCount = 5 } = {}) {
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: h });
  expect(begin.statusCode).toBe(200);
  const assertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount,
  });
  return app.inject({
    method: 'POST', url: '/api/passkeys/only',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { enabled: true, id: assertion.id, response: assertion.response },
  });
}
```

Append at the end of the file:

```js
// The regression this feature exists for: an arm request with no fresh
// assertion must be refused, even with a credential enrolled.
test('arming without a fresh assertion is refused', async () => {
  await enroll();
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: await headers(), payload: { enabled: true } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/fresh passkey assertion/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
});

test('a full arm ceremony arms the flag and persists the sign count', async () => {
  const auth = await enroll();
  const res = await armWithAssertion(await headers(), auth);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ passkeyOnly: true });
  expect((await passkeyStore.listRaw())[0].signCount).toBe(5);
});

test('a login challenge cannot finish an arm ceremony, nor an arm challenge a login', async () => {
  const auth = await enroll();
  const h = await headers();
  // login-issued challenge presented to the arm finish
  const loginBegin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const loginAssertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(loginBegin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5,
  });
  const crossArm = await app.inject({
    method: 'POST', url: '/api/passkeys/only',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(loginBegin)}` },
    payload: { enabled: true, id: loginAssertion.id, response: loginAssertion.response },
  });
  expect(crossArm.statusCode).toBe(400);
  expect(crossArm.json().error).toMatch(/fresh passkey assertion/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
  // arm-issued challenge presented to login/finish
  const armBegin = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: h });
  const armAssertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(armBegin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 6,
  });
  const crossLogin = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish',
    headers: { cookie: pkCookie(armBegin) }, payload: armAssertion,
  });
  expect(crossLogin.statusCode).toBe(400);
  expect(crossLogin.json().error).toMatch(/challenge expired/);
});

test('an arm assertion with a bad signature is refused and the flag stays off', async () => {
  const auth = await enroll();
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: h });
  const forged = makeAssertion({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5, tamper: 'signature',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/passkeys/only',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { enabled: true, id: forged.id, response: forged.response },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/arming failed/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
});

test('an unknown credential id on the arm finish is refused', async () => {
  await enroll();
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: h });
  const stranger = makeAuthenticator({ credentialId: Buffer.from('cred-zzzz') });
  const assertion = makeAssertion({
    authenticator: stranger, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5,
  });
  const res = await app.inject({
    method: 'POST', url: '/api/passkeys/only',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { enabled: true, id: assertion.id, response: assertion.response },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/arming failed/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
});

test('a stalled sign count on the arm finish is refused and logged like login', async () => {
  const logs = [];
  app = await build({}, { log: (msg) => logs.push(msg) });
  const auth = await enroll();
  const h = await headers();
  // Establish stored signCount=5 via a real login first.
  const loginBegin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(loginBegin) },
    payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(loginBegin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, signCount: 5 }),
  });
  expect(login.statusCode).toBe(200);
  const res = await armWithAssertion(h, auth, { signCount: 3 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/arming failed/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
  expect(logs.some((m) => /passkey "Laptop" sign count did not increase — possible cloned authenticator/.test(m))).toBe(true);
});

// The rpId guards fire BEFORE the assertion requirement, so a misconfigured
// deployment still gets the specific 409 rather than a misleading
// "assertion missing" — this pins the guard order.
test('the rpId-usable 409 still precedes the assertion requirement', async () => {
  await enroll();
  const h = await headers();
  app = await build({ rpId: 'changed.example.com' });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: true } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/enrolled for/);
});
```

- [ ] **Step 2: Update the existing tests that arm via the route**

These currently arm with a bare `{ enabled: true }` and will 400 once the assertion is required. Each keeps its own subject; only the arming step changes to the ceremony helper. The `enroll()` helper already returns the fixture authenticator.

1. `test('arming passkey-only is refused with nothing enrolled', …)` (~line 305): **unchanged** — the route-level zero-credential 409 (`enroll a passkey first`) now answers before the challenge check, same status and message pattern.
2. `test('arming passkey-only makes password login 403', …)` (~line 311) — replace the arm call:

```js
test('arming passkey-only makes password login 403', async () => {
  const auth = await enroll();
  const h = await headers();
  expect((await armWithAssertion(h, auth)).json()).toEqual({ passkeyOnly: true });
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  expect(res.statusCode).toBe(403);
  expect(res.json().error).toMatch(/passkey required/);
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json().passkey.only).toBe(true);
});
```

3. `test('disarming passkey-only restores password login', …)` (~line 322):

```js
test('disarming passkey-only restores password login', async () => {
  const auth = await enroll();
  const h = await headers();
  await armWithAssertion(h, auth);
  await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: false } });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
});
```

4. `test('removing the last passkey disarms passkey-only', …)` (~line 363):

```js
test('removing the last passkey disarms passkey-only', async () => {
  const auth = await enroll();
  const h = await headers();
  await armWithAssertion(h, auth);
  expect((await app.inject({ method: 'DELETE', url: `/api/passkeys/${encodeURIComponent(auth.id)}`, headers: h })).json())
    .toEqual({ ok: true, disarmed: true });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
});
```

5. `test('POST /api/passkeys/only rejects a missing or non-boolean enabled with 400, and never disarms', …)` (~line 489) — replace only the first arm:

```js
test('POST /api/passkeys/only rejects a missing or non-boolean enabled with 400, and never disarms', async () => {
  const auth = await enroll();
  const h = await headers();
  expect((await armWithAssertion(h, auth)).json()).toEqual({ passkeyOnly: true });
  const badBodies = [undefined, {}, [], { enabled: 'true' }, { enabled: 1 }, { enabled: null }];
  for (const payload of badBodies) {
    const res = payload === undefined
      ? await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h })
      : await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload });
    expect(res.statusCode).toBe(400);
  }
  // None of the malformed attempts above disarmed the flag.
  expect(await passkeyStore.getPasskeyOnly()).toBe(true);
});
```

6. `test('arming and disarming passkey-only each write one audit log line', …)` (~line 518):

```js
test('arming and disarming passkey-only each write one audit log line', async () => {
  const logs = [];
  app = await build({}, { log: (msg) => logs.push(msg) });
  const auth = await enroll();
  const h = await headers();
  await armWithAssertion(h, auth);
  await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: false } });
  expect(logs).toContain('[tmuxifier] passkey-only mode armed');
  expect(logs).toContain('[tmuxifier] passkey-only mode disarmed');
});
```

Leave untouched: the kill-switch test (~line 353), both Finding-1 rpId-guard tests (~lines 438/456 — the 409 fires before the challenge check), and the disarm-with-mismatched-rpId test (~line 477).

- [ ] **Step 3: Run the tests to verify the new ones fail**

Run: `npx vitest run test/passkeyRoutes.test.js`
Expected: the Task 2 additions FAIL (bare `{enabled:true}` still arms, ceremony finishes are rejected as unknown fields are ignored); the updated pre-existing tests FAIL where they now expect ceremony success paths that don't exist yet.

- [ ] **Step 4: Implement the assertion requirement**

In `src/server/server.js`, replace the `if (enabled) { … }` block inside `app.post('/api/passkeys/only', …)` (the block containing the `rpIdCurrentlyUsable` check) with:

```js
    if (enabled) {
      const pinned = await passkeyStore.getRpId();
      if (!rpIdCurrentlyUsable(pinned)) {
        return reply.code(409).send({
          error: !rpId
            ? 'passkeys need a domain name — set TMUXIFIER_RP_ID (or TMUXIFIER_BASE_EXTERNAL_URL) before requiring passkey sign-in'
            : `these passkeys were enrolled for ${pinned}, but this server is configured for ${rpId} — fix the configuration before requiring passkey sign-in`,
        });
      }
      const enrolled = await passkeyStore.listRaw();
      if (enrolled.length === 0) {
        return reply.code(409).send({ error: 'enroll a passkey first' });
      }
      // Enrolled months ago is not usable today: arming demands a fresh
      // assertion, verified exactly like login/finish — same crypto, same
      // sign-count semantics, same cloned-authenticator audit line. The
      // failure responses stay specific (register/finish's disclosure
      // policy): this route is authenticated, unlike login/finish.
      const challenge = takeChallenge(req, 'arm');
      reply.clearCookie(PK_COOKIE, { path: '/' });
      if (!challenge) {
        return reply.code(400).send({ error: 'arming requires a fresh passkey assertion — start again' });
      }
      const credential = enrolled.find((c) => c.id === req.body?.id);
      let verified;
      try {
        if (!credential) throw new Error('unknown credential');
        verified = verifyAssertion({
          response: req.body?.response ?? {},
          expectedChallenge: challenge, rpId, originOk: passkeyOriginOk,
          // NOT `credential.signCount ?? 0` — same reason as login/finish:
          // `??` would launder a corrupt stored count past verifyAssertion's
          // own guard, silently disabling the cloned-authenticator check.
          publicKey: credential.publicKey, storedSignCount: credential.signCount,
        });
      } catch (e) {
        // Same stall-specific match as login/finish — 'did not increase',
        // NOT /sign count/, so a corrupt-store rejection is never mislabelled
        // as a cloned authenticator.
        if (credential && /did not increase/.test(e.message)) {
          log(`[tmuxifier] passkey "${credential.label}" sign count did not increase — possible cloned authenticator`);
        }
        return reply.code(400).send({ error: `arming failed: ${String(e.message).slice(0, 160)}` });
      }
      await passkeyStore.touch(credential.id, { signCount: verified.signCount });
    }
```

No other part of the route changes; the trailing `try { const result = await passkeyStore.setPasskeyOnly(enabled); … }` block stays as is.

- [ ] **Step 5: Run the full test file, then the whole suite**

Run: `npx vitest run test/passkeyRoutes.test.js`
Expected: PASS, all tests.
Run: `npm test`
Expected: PASS (typecheck + full unit/integration suite — nothing else in the codebase calls the arming route).

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js test/passkeyRoutes.test.js
git commit -m "feat(auth): require a fresh passkey assertion to arm passkey-only mode"
```

---

### Task 3: Client — arm ceremony in the Settings UI

**Files:**
- Modify: `src/web/passkeys.ts` (the `pk` object: `setOnly` signature, new `onlyBegin`)
- Modify: `src/web/settingsPasskeys.ts` (arm flow in `renderPasskeysSection` + `confirmArm` modal copy; checkbox gating on the origin verdict)

**Interfaces:**
- Consumes: Task 1's `POST /api/passkeys/only/begin` (login-begin-shaped JSON) and Task 2's `POST /api/passkeys/only` `{ enabled: true, id, response }` contract; existing helpers `getPasskey`, `serializeAssertion`, `evaluateOrigin`, `openModal`.
- Produces: `pk.onlyBegin(): Promise<{ challenge: string; rpId: string; timeout: number; userVerification: string }>` and `pk.setOnly(enabled: boolean, assertion?: SerializedAssertion)`. No new exports elsewhere.

- [ ] **Step 1: Update `src/web/passkeys.ts`**

Replace the `setOnly` line in the `pk` object and add `onlyBegin` beside it:

```ts
  setOnly(enabled: boolean, assertion?: SerializedAssertion) {
    return jr<{ passkeyOnly: boolean }>(fetch('/api/passkeys/only', jsonBody('POST',
      assertion ? { enabled, id: assertion.id, response: assertion.response } : { enabled })));
  },
  onlyBegin() {
    return jr<{ challenge: string; rpId: string; timeout: number; userVerification: string }>(
      fetch('/api/passkeys/only/begin', { method: 'POST' }));
  },
```

(`SerializedAssertion` is already declared in this file, above the `pk` object.)

- [ ] **Step 2: Update `src/web/settingsPasskeys.ts`**

Extend the import from `./passkeys` to include the assertion helpers:

```ts
import { pk, evaluateOrigin, createPasskey, serializeRegistration, getPasskey, serializeAssertion, hasWebAuthn, type PasskeyState } from './passkeys';
```

Replace the `onlyReason` computation (the checkbox stays enabled while armed so disarm always works; a browser that cannot assert cannot arm):

```ts
  const onlyReason = state.killSwitch
    ? 'TMUXIFIER_PASSKEY_ONLY=off is set in .env — remove it and restart to use this.'
    : state.credentials.length === 0
      ? 'Enroll a passkey first.'
      : !armed && !verdict.ok
        ? verdict.reason
        : '';
```

Replace the `onlyBox.onchange` handler (arming now runs the WebAuthn ceremony after the confirm modal; a cancelled browser prompt is a quiet "Cancelled.", matching `addPasskey`):

```ts
  onlyBox.onchange = () => {
    if (!onlyBox.checked) { void pk.setOnly(false).then(() => reload()).catch((e) => { onlyBox.checked = true; fail(e); }); return; }
    // Arming is the one action here that can lock the user out of the fleet:
    // confirm intent first, then prove a passkey works right now in this
    // browser — the assertion is verified server-side before the flag flips.
    const armCeremony = async () => {
      try {
        const options = await pk.onlyBegin();
        const credential = await getPasskey(options);
        await pk.setOnly(true, serializeAssertion(credential));
        reload();
      } catch (e) {
        onlyBox.checked = false;
        if (e instanceof Error && e.name === 'NotAllowedError') { errLine.textContent = 'Cancelled.'; return; }
        fail(e);
      }
    };
    confirmArm(() => { void armCeremony(); }, () => { onlyBox.checked = false; });
  };
```

In `confirmArm`, add the ceremony hint below the break-glass line (same copy as `addPasskey`):

```ts
    el('p', { class: 'pve-sub' }, ['If you lose your authenticator: set TMUXIFIER_PASSKEY_ONLY=off in .env and restart Tmuxifier.']),
    el('p', { class: 'pve-sub' }, ['Your browser will ask you to confirm with your fingerprint, face, PIN or security key.']),
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck`
Expected: clean exit, no errors.
Run: `npm run build`
Expected: Vite build succeeds.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/passkeys.ts src/web/settingsPasskeys.ts
git commit -m "feat(ui): run the passkey assertion ceremony when arming passkey-only"
```

---

### Task 4: Docs sync

**Files:**
- Modify: `CLAUDE.md` (Security notes bullet on the passkey-only guards; the `server.js` architecture bullet's passkey-route list)
- Modify: `AGENTS.md` (same content, kept in sync with CLAUDE.md)
- Modify: `README.md` only if `grep -n 'passkey' README.md` shows it documents the arming guards; mirror the same one-sentence addition there.

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–3.
- Produces: docs that state arming requires a fresh assertion (the guard count changes from three to four).

- [ ] **Step 1: Update the guard description**

In `CLAUDE.md` Security notes, the bullet beginning `Passkeys' opt-in "require a passkey" toggle …` currently says arming `is guarded three ways against locking the operator out`. Change to four ways and insert the new guard first in the list, so the sentence reads (keeping everything after the existing first guard unchanged):

> …so arming it is guarded four ways against locking the operator out: it demands a fresh, successful WebAuthn assertion in the arming browser (`POST /api/passkeys/only/begin` starts the ceremony; the assertion is verified with the same machinery as login, so arming proves a credential works *now*, not merely that one is enrolled); it is refused with a 409 unless at least one credential is enrolled **and** the configured relying party id is actually usable against them (…unchanged…); removing the last credential auto-disarms it; and `TMUXIFIER_PASSKEY_ONLY=off` in `.env` overrides the stored flag as the break-glass (…unchanged…).

Also extend the passkey route list in the `server.js` architecture bullet: `(GET/POST/DELETE /api/passkeys*, POST /api/auth/passkey/login/begin|finish)` → add `POST /api/passkeys/only/begin`.

Apply the same two edits to `AGENTS.md` (it mirrors CLAUDE.md).

- [ ] **Step 2: Check README**

Run: `grep -n 'passkey' README.md`
If the arming guards are described there, add the same one-sentence "fresh assertion" guard; otherwise no README change.

- [ ] **Step 3: Full suite one last time**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: passkey-only arming now requires a fresh assertion"
```

---

## Verification checklist (post-plan)

- `npm test` green (typecheck + unit/integration).
- `npm run build` succeeds.
- Manual smoke (deployment step, not part of this plan): Settings → Passkeys → tick "Require a passkey" → confirm modal → browser prompt → flag arms; cancel path leaves the flag off. Release/deploy follows the standard Shipping flow in CLAUDE.md when the user asks for it.
