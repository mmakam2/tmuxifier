# PWA + Web Push — design

Date: 2026-08-05. Status: approved design, pre-plan.

## Goal

Agent finishes on a box while the phone is in a pocket → the phone buzzes → tapping the
notification opens Tmuxifier focused on that box. Today, `agent-done`/`agent-input`/health
notifications exist only while a tab is open polling `GET /api/health/events` (`main.ts` +
`notifyPrefs.ts`). This feature adds real Web Push delivered with no tab open, plus PWA
installability (home-screen app on Android, installable on desktop Chrome/Edge).

Origin of the idea: feature survey of siteboon/claudecodeui (CloudCLI); this was the one
candidate with the best effort-to-value ratio, and `healthHistory.js` already documents
`onEvent(cb)` as *the* deferred server-push delivery seam.

## Scope

- **Targets:** Android Chrome (primary — Z Fold 6) and desktop Chrome/Edge. iOS is
  explicitly out of scope (untested; may incidentally work from a home-screen install).
- **Crypto:** hand-rolled on `node:crypto`, dependency-free, in the `webauthn.js`/
  `googleAuth.js` mold. No `web-push` npm dependency.
- **Filtering:** server-side, per subscription, per event kind. Rejected alternatives:
  - *Push everything, filter in the service worker* — `userVisibleOnly: true` obliges the SW
    to show a notification per push; client-side filtering would show junk or risk Chrome
    revoking the subscription, and wakes the radio for filtered events.
  - *Hardcoded kinds, no prefs* — diverges from the existing per-kind Settings toggles;
    kept only as a fallback scope cut.
- **Not in scope:** offline support (a terminal app has none; the SW fetch handler is
  pass-through, no caching — cached hashed assets would recreate the blank-app failure mode
  the deploy checklist exists to prevent), iOS, notification actions beyond tap-to-open,
  editing another device's prefs remotely.

## Server

Three new modules, factory-injected like everything else, plus routes.

### `src/server/webPush.js` — dependency-free protocol client (pure + `node:https`)

- `generateVapidKeys()` — P-256 keypair; public key exported uncompressed (65 bytes,
  base64url) for `applicationServerKey`, private key as JWK/raw for signing.
- `buildVapidAuth({ endpoint, publicKey, privateKey, contact, nowSec })` — RFC 8292
  `Authorization: vapid t=<ES256 JWT>, k=<pubkey>`: `aud` = the push endpoint's origin,
  `exp` ≤ 24h, `sub` = contact. Injectable `nowSec` (no `Date.now()` inside — testable).
- `encryptPayload({ p256dh, auth }, plaintextBytes)` — RFC 8291 over RFC 8188
  `aes128gcm`: ephemeral ECDH P-256 → HKDF-SHA256 (auth secret, "WebPush: info", cek/nonce
  derivation) → AES-128-GCM, single record, padding delimiter `0x02`. TDD'd byte-for-byte
  against the complete worked example in RFC 8291 Appendix A (fixed keys/salt injectable).
- `sendPush({ subscription, payload, vapid, ttlSec })` — POST over `node:https` with
  `Content-Encoding: aes128gcm`, `TTL` (default 6h), `Urgency: high`. Returns
  `{ ok, status }`; never throws on HTTP errors. `410`/`404` means the subscription is
  dead (caller prunes it).

### `src/server/pushStore.js` — `data/push.json`

Built on `jsonFile.js` (atomic rename, `0o600`, quarantine-on-corrupt). Holds:

- VAPID keypair: **private key sealed** with `secretBox.js` (key from `cookieSecret`, same
  as `proxmox.json`/`netbox.json`); public key plain. Generated lazily on first use and
  persisted. If unsealing fails (rotated `cookieSecret`), regenerate the keypair and drop
  all subscriptions — they are bound to the old `applicationServerKey` and unusable anyway.
  Logged; devices re-enroll from Settings.
- Subscriptions: `{ id, endpoint, p256dh, auth, label, createdAt, prefs }`. `label` is
  UA-derived (client sends it at subscribe; length-capped, control chars stripped —
  browser input, same distrust as everything else). `prefs` is the per-kind boolean map
  over the `NOTIFY_KINDS` set (`agent-input`, `agent-done`, `down`, `up`, `needs-auth`,
  `key-changed`, `threshold`, `threshold-clear`), defaulting like `notifyPrefs.ts`
  (all on except `up`/`threshold-clear`); unknown kinds in a PATCH are rejected.
  Booleans are stated outright, and the PATCH sends the full map — the
  omitted-key-keeps-stored-value trap is called out in tests (the clearing case is tested).
- Endpoint/`auth` are capability-ish values but not in the sealed credential class
  (misuse ceiling: sending junk notifications to the operator's own phone); stored plain
  in the `0o600` file, like `passkeys.json` stores public keys.

CRUD: `list()` (redacts `auth`, truncates `endpoint` for display), `upsert()` (keyed by
endpoint — re-subscribing the same browser updates in place rather than duplicating),
`updatePrefs(id, prefs)`, `remove(id)`, `removeByEndpoint(endpoint)` (dispatcher pruning).

### `src/server/pushDispatcher.js` — first real subscriber to the seam

`createPushDispatcher({ store, send, log })`; `index.js` wires
`healthHistory.onEvent(dispatcher.onEvent)`.

- Per event `{ boxId, label, host, t, kind, metric?, value?, reason? }`: for each
  subscription whose `prefs[kind]` is true, build a compact JSON payload
  (`kind`, `boxId`, `label`, `t`, plus `metric`/`value`/`reason` when present; well under
  the 4KB push cap) and send.
- **Fire-and-forget with catch** — a push failure must never disturb the status poll loop
  (the same rule `localAgent.sample()` follows). Failures are logged; `410`/`404` prunes
  the dead subscription.
- Sends are sequential per event (single-user tool, a handful of devices — no concurrency
  machinery needed).
- Existing suppression is inherited for free: agent events for an attached session never
  reach `onEvent`, so they can't push either.

### Routes (`server.js`, all auth-gated)

- `GET  /api/push/vapid-key` → `{ key }` (the `applicationServerKey`).
- `GET  /api/push/subscriptions` → redacted list for Settings.
- `POST /api/push/subscriptions` `{ endpoint, keys: { p256dh, auth }, label }` → upsert,
  returns `{ id }`. Input validated (URL shape — https only; base64url key shapes; label cap).
- `PATCH /api/push/subscriptions/:id` `{ prefs }` → full-map prefs update.
- `DELETE /api/push/subscriptions/:id`.

### Config

- `TMUXIFIER_PUSH_CONTACT` (optional) — the VAPID `sub` claim; defaults to
  `mailto:tmuxifier@example.com`. Documented in `.env.example`.
- No enable flag: the feature is inert until a device subscribes, like passkeys.

## Client

### `src/web/public/sw.js` — service worker (root scope, stable URL)

Lives in Vite's `public/` dir so it is copied verbatim to `dist/sw.js` — a service worker's
URL must be stable and root-scoped, so the content-hashed `?url` pattern used for
`voiceWorklet.js` does **not** apply. CSP stays `script-src 'self'` (same-origin static
asset).

- `push` handler: parse the JSON payload; if any window client is
  `visibilityState === 'visible'`, show nothing (the open tab's existing polling
  notifications handle it — this is the double-notification guard, and it is the one
  exception Chrome sanctions to the `userVisibleOnly` obligation, unlike the rejected
  pref-filtering-in-SW approach); otherwise
  `showNotification` with kind-appropriate title/body (reuses the wording of
  `healthEvents.ts` formatters, duplicated into the SW — the SW cannot import app modules).
- `notificationclick`: focus an existing client if present (and `postMessage` the boxId),
  else `clients.openWindow('/?box=<id>')`.
- `fetch` handler: pass-through (`return` without `respondWith`) — present for
  installability, deliberately no caching.

### `manifest.webmanifest` + icons (also in `public/`)

`name`/`short_name` "Tmuxifier", `display: standalone`, `start_url: /`, `theme_color`/
`background_color` from the DESIGN.md palette, 192 and 512 PNG icons (maskable variants).
The icon source is decided at plan time: derived from the existing favicon/brand mark if
one scales, else a simple monogram in the DESIGN.md palette. `index.html` gains
`<link rel="manifest" href="/manifest.webmanifest">`.

### `src/web/push.ts` — fetch layer + subscribe flow

Through `http.ts` helpers (inherits the 401 seam; no hand-rolled `res.ok`). `evaluatePush()`
readiness verdict in the `evaluateOrigin`/`evaluateVoice` mold, ordered: SW support →
`PushManager` support → secure context → permission state. Subscribe flow:
`Notification.requestPermission()` → `registration.pushManager.subscribe({
userVisibleOnly: true, applicationServerKey })` → `POST /api/push/subscriptions`.
Unsubscribe: local `subscription.unsubscribe()` + `DELETE`.

### Settings → Notifications (`settingsNotifications.ts`)

Grows a device-push section under the existing per-kind toggles:

- Readiness row (from `evaluatePush()`, same reason/hint rendering as passkeys/voice).
- "Enable push on this device" button → subscribe flow; once subscribed the row becomes
  this-device status (matched by `pushManager.getSubscription()` endpoint).
- Enrolled-device list (label, created date, "this device" marker) with per-row remove;
  removing this device also unsubscribes locally. Remove is confirm-gated like passkey
  removal.
- The existing per-kind toggles now write **both** localStorage (tab behavior, unchanged)
  and — when this device has a subscription — `PATCH` its server-side prefs. Other
  devices' prefs are edited from those devices.

### `main.ts`

- Registers `/sw.js` at boot (no-op where unsupported).
- Deep link: on boot after auth, a `?box=<id>` param (or SW `postMessage`) docks that box's
  terminal if the box exists, then strips the param.

## Failure modes

- Push service unreachable / send fails → logged, poll loop unaffected, next event tries
  again. No retry queue (notifications are ephemeral; a missed one is superseded by the
  events log, which remains the source of truth).
- Dead subscription (`410`/`404`) → pruned server-side; the device's Settings shows it
  gone; re-enabling re-subscribes.
- `cookieSecret` rotation → VAPID keypair regenerated, subscriptions dropped (logged),
  devices re-enroll.
- Corrupt `data/push.json` → quarantined by `jsonFile.js`, feature returns to inert.
- Browser revokes permission → `pushManager.getSubscription()` returns null; Settings
  shows not-enrolled; server prunes on next failed send.

## Security notes (to be added to CLAUDE.md/docs)

- Push payloads transit Google/Mozilla's relays **end-to-end encrypted** (RFC 8291): box
  names/hosts/event text are never cleartext to the vendor. This is the app's first
  runtime outbound connection (beyond user-configured integrations) — the endpoints are
  whatever the browser minted at subscribe time (FCM/Mozilla autopush).
- The VAPID private key joins the sealed-at-rest class (AES-256-GCM via `cookieSecret`).
- All push routes are auth-gated; a subscription can only be minted from a logged-in
  session.

## Testing

- **Unit (vitest, real code no mocks):** `webPush.js` encryption byte-for-byte against RFC
  8291 Appendix A (injected keys/salt); VAPID JWT verified with `crypto.verify` against
  the public key, `aud`/`exp`/`sub` asserted; `pushStore` CRUD, sealing, prefs defaulting,
  the prefs-clearing case (PATCH-merge trap), upsert-by-endpoint dedup, unseal-failure
  regeneration; dispatcher filtering, pruning on 410, and never-rejects (injected failing
  `send`).
- **Integration:** routes auth-gated; subscribe → emit event via a real `healthHistory` →
  injected fake `send` observed called with a decryptable payload (decrypt with the test's
  own keys — proves the whole pipe).
- **Playwright:** SW registers, manifest served and valid, Settings flow renders; real
  push delivery is not e2e-testable against vendor endpoints.
- **On-device ship gate (browser-verify lesson):** before release, a real push must land
  on the actual phone through cloudflared with the tab closed, and tapping it must open
  the app on the right box.

## Docs

- README: one paragraph in the notifications feature area.
- `docs/fleet-and-health.md`: the push section (enable flow, per-device prefs, deep link).
- `docs/DEPLOY.md`: outbound reachability note (server → FCM/Mozilla endpoints).
- CLAUDE.md: module map entries (`webPush.js`, `pushStore.js`, `pushDispatcher.js`,
  `push.ts`, `sw.js`), the `data/push.json` line in the self-contained list, security
  notes above, and `healthHistory.js`'s `onEvent` description updated from "deferred
  seam — nothing subscribes" to naming the dispatcher.
