# Android agent console — design

Date: 2026-08-09. Status: approved design, pre-plan.

Supersedes the delivery half of `2026-08-05-pwa-web-push-design.md` (approved, never
implemented): lock-screen notification delivery to the phone now arrives via a native
Android app + FCM rather than Web Push + PWA. That spec remains the reference design if
desktop-browser push is ever wanted; nothing here precludes building it later.

## Problem

The mobile web experience is not good enough, despite three shipped rounds of phone-mode
work (v1.24.21–25). The operator's own verdict: text is too small to read, typing into the
terminal gets mangled, small edits to text already sitting in the claude prompt are
impossible without corruption, touches misfire (accidental activations and dead taps), the
composer strip is clunky, and the whole thing feels like a webpage.

The dominant mobile use case, established explicitly: **driving Claude Code sessions** —
check what an agent did, answer its question, send the next prompt — from the **cover
screen of a Samsung Z Fold** (~380dp wide). Real shell work from the phone is rare.

The root cause is structural, not cosmetic: an 80-column TUI rendered by a browser
terminal emulator is the wrong surface for a narrow phone, and round-tripping edits
through a pty means the phone's IME and the TUI fight over every word. No amount of
touch-guard patching fixes that.

## Decision record

Three approaches were weighed:

- **A. Agent console + PWA + Web Push** (recommended in brainstorm): same surface redesign
  as below but in the existing web codebase, PWA shell, Web Push. One codebase, no
  packaging.
- **B. Native Android app**: Kotlin/Compose client of the Tmuxifier API. Best input
  reliability and platform integration; permanent second codebase.
- **C. TWA/Capacitor wrapper**: requires A first; an upgrade path, not an alternative.

**The operator chose B with the recurring-cost trade-off stated and understood.** Scope
chosen: **agent console + read-only fleet glance** (not a full client). Push transport:
**FCM** (free; chosen over self-hosted ntfy once FCM's zero cost was established).
Ingress: the cloudflared tunnel serves Tmuxifier directly — no Cloudflare Access layer —
so the app authenticates against Tmuxifier alone.

## Architecture: thin app, smart server

The app is a **renderer of server APIs**. All tmux/ssh intelligence stays in the Node
server: the app never speaks SSH, never parses pty streams, never holds box credentials.
Every future server feature costs at most a small client addition, keeping the
second-codebase tax bounded.

The key move: **tmux is the terminal emulator, not the app.** The server captures the
pane tmux already maintains (`capture-pane -e` over the existing ControlMaster) and ships
a *snapshot* — styled text plus cursor and pane geometry. The app renders it as native
Android text. Consequences, all load-bearing:

- No VT100 emulator in Kotlin (that road leads back to every current pain).
- Native rendering: selectable, zoomable, soft-wrapped, Samsung text stack.
- A snapshot viewer never attaches a tmux client, so the phone **never resizes the tmux
  window** under a desktop session (`window-size latest` makes any attach-based mobile
  client a resize hazard).

## Server additions

All in this repo, existing patterns: factory functions with injected deps, TDD against
real code, `jsonFile.js` persistence (`0o600`, atomic rename, quarantine-on-corrupt).

### Device auth — `deviceStore.js` + Bearer path

- `data/devices.json`: per device — id, name, **scrypt hash of the token** (the token
  itself is returned exactly once at enrollment and never stored), created/lastSeen
  timestamps, FCM registration token, per-event-kind notification toggles.
- `POST /api/devices/enroll` — body: password + device name (+ FCM token). Guarded by the
  same per-IP `rateLimit.js` bucket as login. Mints a 32-byte random token, returns it
  once. Password-mode v1; OAuth-mode enrollment via a pairing code minted from an
  authenticated browser session is a recorded v2 item (not built now).
- Auth check accepts *session cookie or valid device token* (`Authorization: Bearer`).
  Token compare is scrypt-verify against the stored hash, with a small in-memory
  verified-token cache so per-request cost stays flat. No expiry: revocation is the
  lifecycle.
- `GET /api/devices` / `DELETE /api/devices/:id` (cookie-authed) + a **Settings → Devices**
  tab on the web (list, name, last seen, revoke). Revocation takes effect on the device's
  next request.
- Client side: token lives in Android Keystore-backed encrypted storage.

### Pane snapshot — `GET /api/boxes/:id/pane`

- Targets the box's configured session (the same one the web terminal attaches), active
  pane. Runs `tmux capture-pane -e -p` plus cursor/pane-size formats over the shared
  ControlMaster (via `boxActions`, same validated argv discipline as `sshCommand.js`).
- Includes a bounded scrollback window (`-S`, ~200 lines) so the pane view can scroll
  back through recent output, not just the visible screen.
- Response: styled text (raw SGR passthrough — the app's parser handles color/bold/dim),
  cursor x/y, pane width/height, and the session's agent state so the header chip needs no
  second request.
- Polled by the app at ~1s while a session screen is open; nothing background. Cost per
  poll is comparable to the existing status probe.

### Send keys — `POST /api/boxes/:id/keys`

- Body: either `{ text }` (sent literal via `send-keys -l`, so nothing is ever shell- or
  tmux-interpreted) or `{ key }` from a **closed named-key allowlist** (Enter, Esc, Up,
  Down, Tab, C-c, digits, y/n) — the `voiceCatalog.js`/`iconCatalog.js` chokepoint
  discipline. Nothing user-typed reaches tmux as a key name.
- Reuses the existing guarded send-keys machinery (`tmuxInject.js` family) over the
  ControlMaster.

### FCM notifier — `fcmPush.js`

- Subscribes to `healthHistory.onEvent(cb)` — the seam the codebase already documents as
  deferred server-push delivery. v1 kinds: `agent-input`, `agent-done` (already
  edge-triggered, already suppressed while the session is attached), filtered per device
  by its stored toggles.
- Dependency-free in the `googleAuth.js` mold: service-account JWT signed with
  `node:crypto`, exchanged for an OAuth2 access token (cached until expiry), then POST to
  FCM HTTP v1. Notification payload: box name + event kind; data payload: box id for
  tap-through.
- `TMUXIFIER_FCM_CREDENTIALS` in `.env` points at the service-account JSON (gitignored;
  joins the `.env` secret class; placeholder documented in `.env.example`).
- Failures are logged and pruned (an FCM `UNREGISTERED` response clears that device's FCM
  token), never propagated — the "never promoted to a job failure" posture. Unset
  credentials = feature off, everything else unaffected.

## The app

**Stack:** Kotlin + Jetpack Compose, single Gradle module, no DI framework, OkHttp for
REST, `firebase-messaging` for push. Cover-screen-first layouts (~380dp), thumb-zone
controls at the bottom. Lives in `android/` in this repo.

### Screen 1 — Fleet (home)

Vertical list of box cards: name, status dot, agent chip (working/waiting), the two spec
lines the web dashboard cards show (distro + cores, RAM + disk), last-event line
("waiting 4m"). Boxes with a waiting agent sort to the top. Data: `GET /api/status` +
`GET /api/health/series`, 10s poll while foregrounded, stopped in background (push covers
it). Read-only; tap opens the session.

### Screen 2 — Session

Three stacked zones:

- **Pane view** (the bulk): snapshot rendered as native styled text, **soft-wrapped at
  the chosen font size** — never shrunk to fit 80 columns. Pinch adjusts font size
  (persisted). Subtle marker at the real cursor. **Inert to touch by default** — scroll
  and select only; touches structurally have no path to the pty.
- **Action row**: semantic keys for driving Claude — `Esc` `↑` `↓` `Enter` `1` `2` `3`
  `y` `n`, and `^C` behind a two-tap arm (the web `arming.ts` policy). Each is one
  `POST /keys` named key.
- **Composer**: real Android multiline field + Send. All editing local until Send —
  Samsung keyboard, autocorrect, native voice dictation, none of it visible to the pty.
  Send = literal text, then Enter as a named key. Draft persists per box. Empty Send =
  bare Enter. The web pains dissolve rather than get patched: unfinished text never
  enters the session, and nothing is ever edited inside the TUI.

Menu: "Open in browser" (Chrome, the full web app) for the rare real-shell need.

### Screen 3 — Settings

Server URL, device name, enroll/sign-out, per-kind notification toggles, font size.
Nothing else.

**Notification tap-through:** an `agent-input` push opens Screen 2 for that box.

### Deliberately absent

Splits/multi-pane, fleet command, Proxmox, box CRUD, services dashboard, full terminal
keyboard mode, tablet/unfolded-optimized layouts (the phone-web stage remains for that).
Scope discipline is the mitigation for the second-codebase cost.

## Build, distribution, secrets hygiene

- `android/` in this public repo: committed code carries no PII (placeholders only, e.g.
  `tmuxifier.example.com`); `google-services.json` and the signing keystore are
  gitignored with `.example` documentation, per the repo's placeholder-counterpart rule.
- Headless build on the dev box: `sdkmanager` cmdline-tools install (a few GB, one-time),
  Gradle release build.
- Release APK signed with a generated keystore under gitignored `android/keystore/`.
  **Losing the keystore breaks update-in-place installs** — its backup obligation is
  documented where the build steps live.
- Distribution: sideload the APK. Serving it from an authenticated Tmuxifier route is a
  recorded later nicety. No Play Store.

## Testing

- **Server:** normal TDD, real code, no mocks. Device store + Bearer path unit/integration;
  snapshot + keys endpoints against the `localBox` sshd fixture (real tmux, real
  ControlMaster); FCM sender's JWT signing and request shaping against a local stub HTTP
  server (no real Google calls in tests).
- **App:** pure-Kotlin JVM tests for logic that merits them — SGR span parser, snapshot
  diffing, arming state machine, URL/token validation. Compose UI and real FCM delivery
  are verified **on the real device** — the validate-on-live rule; every phone round has
  proven device validation is the only tier that catches the real bugs. No emulator-farm
  pretense.
- Server changes ship through the normal checklist (build, restart gated on no running
  jobs, health check); the app ships by installing the APK.

## Success criteria

1. Locked phone buzzes when a claude session flips to waiting; thumbprint → that box's
   session screen in one tap.
2. Claude's latest output is readable on the cover screen without squinting or horizontal
   panning; font size is the operator's choice.
3. A prompt can be drafted, edited freely (including voice dictation), and sent with zero
   IME-vs-terminal interference; option lists are answered from the action row without
   touching the TUI.
4. No stray touch ever activates anything in the TUI.
5. The desktop tmux window size is never disturbed by phone viewing.
6. Revoking the device from Settings → Devices locks the app out on its next request.

## Recorded v2+ items

- Pairing-code enrollment (OAuth-mode servers without a password).
- ntfy/UnifiedPush sender behind the notifier seam (de-Google option).
- APK served from an authenticated route with update check.
- Desktop-browser Web Push per the 2026-08-05 spec.
- Parsing claude's permission prompts into native Approve/Deny buttons.
