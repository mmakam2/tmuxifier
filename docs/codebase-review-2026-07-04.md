# Codebase Review — Tmuxifier

**Date:** 2026-07-04
**Version reviewed:** v1.4.17 (`main` @ 195ac92)
**Scope:** All of `src/server/`, `src/web/`, `scripts/`, tests, docs, build/config, and dependencies.
**Method:** Five parallel deep reviews (server core, SSH/fleet/status/health, Proxmox/secrets,
web client, docs/dead-code) plus first-hand verification of every HIGH finding. Baseline:
`npm test` is green (443/443 across 45 files, ~23s).

> This is a point-in-time review captured as input for triage, not a spec or a set of applied
> changes. Nothing here has been fixed yet. When an item is picked up, run it through the normal
> flow and land a focused change. Line numbers reference the reviewed commit and will drift.

**Status note, 2026-07-04 (same day):** all six HIGH findings (H1–H6) have since been fixed,
test-first: strict-hex fail-closed `verifyPassword`; a shared `jsonFile.js`
(atomic temp+rename writes, corrupt files quarantined to `<file>.corrupt-<ts>`) adopted by all
five stores — which also makes every data file owner-only 0600, closing L21; full-chain trust
anchoring in pin mode; identity-guarded session eviction with grace timers cleared on exit;
logout now disposes all terminal tabs (and closes the drawers, L18); and the terminal reconnect
timer is cancelled on dispose. Two pre-existing e2e failures were repaired in passing (the fleet
specs still targeted the old "Fleet"/"Jobs" button names from before the 9c851cb rename, and
terminal specs typed before the WebSocket opened). MEDIUM and LOW findings remain open.

**Status note, 2026-07-04 (later the same day):** all eleven MEDIUM findings (M1–M11) have
since been fixed, test-first, in v1.4.20: the fleet manager now honors the mid-login
ControlMaster guard (`skipped: box in use` targets); the session cookie embeds its issue time
and expires server-side after 7 days (legacy constant-`ok` cookies are rejected — everyone
re-logs-in once); the login rate limiter lives in `rateLimit.js` with evict-oldest overflow
(no more global reset) and a new `TMUXIFIER_TRUST_PROXY` knob passes through to Fastify;
PATCHing any connection field (host/user/port/proxyJump) now drops the live PTY like a
session change; `updateHost` whitelists patchable fields; provision polling tolerates up to 5
consecutive `taskStatus` failures; `statusPoller` coalesces overlapping cycles; the web client
has a central 401 handler (dashboard tears down to the login screen with a "session
expired" toast); the provision panel is always dismissible with no timer/listener leaks (and
is closed on logout/expiry); box removal asks `confirm()`; and a replaced provision socket's
close no longer kills the shared PTY its replacement is watching
(`sessions.closeIfUnwatched`). LOW findings remain open.

**Status note, 2026-07-04 (Tier-1 LOW pass):** seven LOW findings shipped in v1.4.21 —
the crash/robustness and chronic-annoyance subset: L5 (malformed persisted fleet jobs are dropped
on load, never a boot failure), L8/L9 (WS upgrade survives malformed cookie percent-encoding with
a clean 1008; non-string input frames and junk resize values are dropped at the boundary), L7
(a reachable user-triggered `listSessions` clears the poll backoff, so a confirmed-up box goes
green on the next tick), L10 (every numeric config knob is clamped — no NaN port, no 0 ms probe
hot-loop), L22 (`killTmuxSession` and `readDefaultPublicKey` are async, with the default key
cached after first read — no more event-loop stalls freezing terminals), and L1 (the default-shell
dedup sed is a real `/…/d` address and only touches `.tmux.conf.local` when it exists). The
remaining LOWs stay open.

**Status note, 2026-07-04 (dead-code + docs pass):** shipped in v1.4.22. All dead code removed:
the four never-wired Proxmox operations were **dropped end-to-end** (routes, web-client methods,
and the backing `updateHost`/`updatePreset`/`cancelProvision` implementations — host/preset edits
are remove+re-add; 'cancelled' stays a terminal status for legacy persisted jobs), plus
`metaLineFor` (its formatting tests now drive `metaSegmentsFor` directly), `opts.controlPath`,
`sessions.provision({opts})`, the `stepSec`/`capSec` injection points, `api.healthEvents(since)`,
`assertPresetInput`'s `keyIds`, provision-job `startedAt`, the `runLocalShellScript` export, and
the redundant `.dot.gray` rule. The `typescript` devDep is now real: `npm run typecheck`
(`tsc --noEmit`) runs as part of `npm test`, and the six `@codemirror/*` packages moved to
devDependencies. Every documentation gap closed: `.env.example` gained `TMUXIFIER_PVE_DEFAULT_PUBKEY`,
DEPLOY.md's ssh-config "import" claim was reworded (ssh resolves aliases; Tmuxifier imports
nothing) and its "what lives where" table gained `config.json` + `health-events.json` rows,
README documents the Host Shell and per-box Reconnect and shows the real `tmux -u` attach
command, CLAUDE.md/AGENTS.md list `fleetEditor.ts` and the typecheck command, the 2025-misdated
security review was renamed to `security-review-2026-06-21.md`, and the vite dev proxy now derives
its target from `loadConfig()` instead of a hardcoded port.

**Status note, 2026-07-04 (fastify 5):** the production dependency chain was upgraded in
v1.4.23 — fastify 4.29 → 5.9, `@fastify/cookie` 9 → 11, `@fastify/static` 7 → 9,
`@fastify/websocket` 10 → 11 — closing all four production advisories (sendWebStream DoS,
content-type bypass, X-Forwarded spoofing, fast-uri traversal). Zero code changes were needed:
the suite and e2e passed as-is. Both flagged seams verified: v9-signed session cookies still
validate under v11 (no forced logout), and `@fastify/websocket` v11 now populates `req.cookies`
on the upgrade, so WS auth rides the normal cookie path (the manual header parse in `isAuthed`
remains as a defensive backstop; comments/docs updated). Remaining dependency debt: the dev-only
vitest/vite chain (5 advisories, none shipped) and the xterm 6 / concurrently 10 / typescript 6
majors.

---

## Findings at a glance

Status reflects `main` as of v1.4.23. Effort is a rough fix-size guess for open items:
**S** = under an hour, **M** = a few hours (design decisions or a protocol/major-version change).

| ID | Area | Finding | Severity | Status | Effort |
|----|------|---------|----------|--------|--------|
| H1 | auth | `verifyPassword` fails open on corrupt stored hash | High | ✅ Fixed v1.4.18 | — |
| H2 | stores | Non-atomic, error-swallowing persistence in all five JSON stores | High | ✅ Fixed v1.4.18 | — |
| H3 | proxmox | TLS pin mode can't connect to cluster-CA-signed (stock) PVE certs | High | ✅ Fixed v1.4.18 | — |
| H4 | sessions | Stale grace timer / `close()` evicts successor session by key | High | ✅ Fixed v1.4.18 | — |
| H5 | web | Stale `tabs` map across logout→login makes boxes unopenable | High | ✅ Fixed v1.4.18 | — |
| H6 | web | Reconnect timer survives `dispose()` — leaked WS + duplicate PTY listener | High | ✅ Fixed v1.4.18 | — |
| M1 | fleet | Fleet exec / `killSession` bypass the mid-login ControlMaster guard | Medium | ✅ Fixed v1.4.20 | — |
| M2 | auth | Session cookie is a constant, non-expiring bearer token | Medium | ✅ Fixed v1.4.20 | — |
| M3 | server | Rate limiter: global `clear()` reset + no `trustProxy` behind a proxy | Medium | ✅ Fixed v1.4.20 | — |
| M4 | sessions | Editing a box's connection fields leaves the terminal on the old host | Medium | ✅ Fixed v1.4.20 | — |
| M5 | proxmox | `updateHost` merges arbitrary patch fields, including `id` | Medium | ✅ Fixed v1.4.20 | — |
| M6 | proxmox | One transient poll error kills a provision job (orphaned LXC) | Medium | ✅ Fixed v1.4.20 | — |
| M7 | status | `statusPoller` has no re-entrancy guard (duplicate/stale snapshots) | Medium | ✅ Fixed v1.4.20 | — |
| M8 | web | No 401/session-expiry handling — dashboard silently freezes | Medium | ✅ Fixed v1.4.20 | — |
| M9 | web | Provision panel can get stuck open with no dismiss/cancel | Medium | ✅ Fixed v1.4.20 | — |
| M10 | web | Box removal is a single unconfirmed click | Medium | ✅ Fixed v1.4.20 | — |
| M11 | sessions | Provision WS close kills a shared entry another socket uses | Medium | ✅ Fixed v1.4.20 | — |
| L1 | boxActions | `default-shell` dedup `sed` is a no-op (`#`-led script is a comment) | Low | ✅ Fixed v1.4.21 | — |
| L2 | fleet | ssh timeout reported as `exited 1` | Low | Open | S |
| L3 | fleet | `prune()` can evict a still-running job | Low | Open | S |
| L4 | fleet | Duplicate `boxIds` run a command twice on one box | Low | Open | S |
| L5 | fleet | Malformed persisted job crashes startup | Low | ✅ Fixed v1.4.21 | — |
| L6 | health | cpu threshold never fires for a box down at seed time | Low | Open | S |
| L7 | status | Successful `listSessions` doesn't clear backoff (stays red) | Low | ✅ Fixed v1.4.21 | — |
| L8 | server | WS auth crashes on malformed cookie percent-encoding | Low | ✅ Fixed v1.4.21 | — |
| L9 | server | Non-string WS input frames throw to the global handler | Low | ✅ Fixed v1.4.21 | — |
| L10 | config | Numeric env values unvalidated (`PORT=7437x` → NaN) | Low | ✅ Fixed v1.4.21 | — |
| L11 | store | `updateBox` can't clear `label` | Low | Open | S |
| L12 | auth | Google token exchange has no timeout | Low | Open | S |
| L13 | secrets | `secretBox.open` accepts truncated GCM auth tags | Low | Open | S |
| L14 | proxmox | Templates route without `?storage` → 502 instead of 400 | Low | Open | S |
| L15 | web | `formatEvent` has no default case — one unknown event bricks the panel | Low | Open | S |
| L16 | web | Fleet job-detail render/poll races between quick clicks | Low | Open | S |
| L17 | web | `refresh()` flashes every status dot gray | Low | Open | S |
| L18 | web | Logout leaves drawers overlaying the login screen | Low | ✅ Fixed v1.4.18 | — |
| L19 | web | Terminal WS URL not `encodeURIComponent`'d (inconsistent) | Low | Open | S |
| L20 | web | Provision exit-sniffing can false-match terminal output | Low | Open | M |
| L21 | store | `boxes.json` not written owner-only 0600 | Low | ✅ Fixed v1.4.18 | — |
| L22 | server | Blocking `execFileSync` calls stall the event loop | Low | ✅ Fixed v1.4.21 | — |
| L23 | scripts | `set-password` leaks the password via argv / echoed prompt | Low | Open | S |
| — | dead code | 4 unreachable Proxmox routes + assorted unused exports/params | Info | ✅ Fixed v1.4.22 | — |
| — | docs | DEPLOY.md ssh-config "import" claim, local-shell undocumented, `.env.example` gap | Info | ✅ Fixed v1.4.22 | — |
| — | tests | Coverage gaps (logout, WS auth, fleet edges; HIGH gaps closed v1.4.18, rate-limit/session-expiry/fleet-guard gaps closed v1.4.20) | Info | Partially closed | M |
| — | deps | fastify 4 HIGH advisories; vitest/vite critical (dev-only); xterm 6 major | Info | Partially closed (fastify 5 ✅ v1.4.23) | M |

---

## Executive summary

Tmuxifier remains a well-engineered, disciplined codebase: injectable factory modules, real-code
tests, a genuinely tight SSH command-injection surface (`assertBoxSafe` + `shSingleQuote` — I
traced every user-controlled field into the `ssh` argv and found no quoting hole), and clean XSS
hygiene in the web client (everything box-derived reaches the DOM via `textContent`). The prior
security review's "no exploitable vulns" conclusion still broadly holds for the *attacker-facing*
surface.

The findings below are mostly **fail-safe and robustness defects** — code that fails *open* or
*destructively* under corruption, races, or operator error rather than under a remote attacker.
Three deserve immediate attention:

1. **`verifyPassword` fails open on a corrupt stored hash** (accepts *any* password). Verified
   empirically. The login gate is the crown jewel; it must fail closed.
2. **Non-atomic + error-swallowing persistence across all five JSON stores** — a crash mid-write
   or a corrupt file silently reads as empty, and the next mutation overwrites it, destroying the
   box list / Fleet history / **all encrypted Proxmox secrets**.
3. **Proxmox TLS pin mode (the default) can't connect to a stock PVE host** — the trust store is
   built from the leaf cert only, so a default cluster-CA-signed PVE cert fails verification.
   Verified empirically. Fails closed, but the default provisioning path is unusable.

Two web-client HIGH bugs (stale terminal tabs after logout→login; a reconnect timer that outlives
`dispose()`) round out the must-fix list.

Counts: **3 critical/high correctness, 2 high web, ~11 medium, ~20 low**, plus dead code, doc
gaps, and dependency debt. Severity is by *likelihood × blast radius for this single-user tool*,
not by CVSS.

---

## HIGH

### H1 — `verifyPassword` accepts any password against a corrupt-hex stored hash (fails open)
**`src/server/auth.js:17-20`** · verified empirically

`Buffer.from(hashHex, 'hex')` silently stops at the first non-hex character. If the digest
segment of `TMUXIFIER_PASSWORD_HASH` is corrupted to start with a non-hex char (a mis-pasted or
placeholder `.env`, e.g. `scrypt$abcd$zz`), `expected` becomes a **zero-length buffer**,
`scryptAsync(password, salt, 0)` derives a zero-length key, and `timingSafeEqual(empty, empty)`
returns **true** for every input. Confirmed by running the real code path:

```
verifyPassword('literally-anything', 'scrypt$abcd$zz')  → true
verifyPassword('literally-anything', 'scrypt$abcd$abc') → false   (odd length drops a byte)
verifyPassword('wrong', 'scrypt$abcd$<128 hex>')        → false   (control)
```

Not remotely injectable — the hash isn't attacker-controlled — but a corrupted hash should fail
*closed*. The login gate silently becomes accept-all.
**Fix:** validate `/^(?:[0-9a-f]{2})+$/i.test(hashHex)` and enforce a minimum digest length
(≥32 bytes) before comparing; reject otherwise. Add an `auth.test.js` case for the invalid-hex hash.

### H2 — Non-atomic, error-swallowing persistence in every JSON store (data-loss)
**`store.js:37-47` (boxes) · `proxmoxStore.js:28-39` (secrets) · `provisionStore.js` · `fleetStore.js:15` · `healthEventsStore.js:23`** — one systemic pattern

Every store `readAll()`/`load()` catches *all* errors (including `JSON.parse` failures) and
returns an empty list/object, and every `writeAll()`/`save()` does a plain in-place
`fs.writeFile` (no temp-file + `rename`). A crash or power loss mid-write is exactly how the file
gets truncated; the next read then yields empty, and the next mutation persists that empty state —
permanently destroying the prior contents. Blast radius by file:

- `boxes.json` → the entire box inventory (the product's only inventory). A non-array `{}` also
  makes `getBox`/`removeBox` throw `TypeError: .find is not a function` → 500 on every box route.
- `proxmox.json` → **all encrypted secrets**: API token, SSH management keys, root password.
- `fleet-jobs.json`, `provision-jobs.json`, `health-events.json` → history (lower stakes).

This directly contradicts the stated policy in `configFile.js:16-18` ("throw so callers don't
silently overwrite a broken file").
**Fix:** write to `file.tmp` then `fs.rename` (atomic); treat only `ENOENT` as empty and throw /
quarantine on parse failure. This is one shared fix applied across all five stores — worth a small
`atomicWriteJson`/`readJsonStrict` helper.

### H3 — Proxmox TLS pin mode can't connect to a default (cluster-CA-signed) PVE host
**`src/server/proxmoxApi.js:53-55`** · verified empirically

In the default `verifyMode` (fingerprint pinning), the trust store is built as
`ca: [derToPem(probe.raw)]` — but `probe.raw` is only the **leaf** DER. OpenSSL only anchors trust
at a self-signed cert in the `ca` list, so verification succeeds *only* if the endpoint serves a
strictly self-signed leaf. A stock Proxmox install serves `pve-ssl.pem` signed by the node's
cluster CA (`pve-root-ca.pem`) — not self-signed. Reproduced against the real `node:https`
transport with a matching pinned fingerprint:

```
server presents leaf only      → "unable to verify the first certificate"
server presents leaf + CA chain → "self-signed certificate in certificate chain"
```

Both fail *closed* (the token is never sent — good), but the default provisioning path is unusable
against default PVE certs and surfaces a raw OpenSSL 502 instead of the curated
fingerprint-mismatch message. The integration test only mints a self-signed cert
(`proxmoxApi.integration.test.js:20`), which is why this shipped.
**Fix:** in `tlsProbe`, walk `cert.issuerCertificate` (already available via
`getPeerCertificate(true)`) and put the whole chain into `ca` — the self-signed root anchors
verification while the fingerprint still pins the leaf. Alternatively verify the fingerprint on the
live socket via `checkServerIdentity` (also removes the probe/request two-connection split). Add a
CA→leaf chain integration case.

### H4 — Stale grace timer / `onExit` deletes a *successor* session by key (duplicate PTY, probe-collision)
**`src/server/sessions.js:41-45, 130-133, 135-140`**

`pty.onExit` deletes the map entry and fires callbacks but never clears a pending `graceTimer`; the
timer body and `close()` then delete `entries.delete(key)` **by key, not by identity**. Sequence:

1. Client detaches → 45s grace timer armed for `entry1`.
2. The ssh PTY dies on its own (network drop) → `onExit` deletes `box1`; timer stays armed.
3. Client reconnects → `open()` creates `entry2` under the same key.
4. Stale timer fires → `entries.delete('box1')` removes **entry2** while its PTY is alive.

Now `hasLiveSession('box1')` returns false, so the status poller probes the box over the shared
ControlMaster *while an interactive login is live* — the exact probe/terminal collision class this
project has repeatedly fixed (see the memory notes on probe/interactive collisions) — and the next
`open()` spawns a duplicate ssh that kicks the first client's tmux session.
**Fix:** `clearTimeout(entry.graceTimer)` inside every `onExit`, and guard every deletion with
`if (entries.get(entry.key) === entry)`.

### H5 (web) — Stale `tabs` map across logout→login makes boxes unopenable
**`src/web/main.ts:13, 399-403, 713-714`** · verified

`tabs` is module-level and never cleared. Logout clears the poll timers but disposes no terminals;
`renderLogin` wipes `#app`, detaching every terminal element while each terminal's WebSocket and
backoff loop keep running (`terminal.ts:191-199` retries forever against the now-dead session).
After logging back in, clicking a previously-open box hits the early-return at `main.ts:713-714`
(`existing.el.style.display='block'; return`) — but `existing.el` is detached, so the stage stays
stuck on "Select a box to open a terminal." **only a full page reload recovers.**
**Fix:** on logout, dispose every tab (`for (const [id] of tabs) closeTab(id)`) and reset
`activeBoxId`. A central 401 handler in `api.j()` should do the same teardown (see M8).

### H6 (web) — Terminal reconnect timer survives `dispose()` (leaked WebSocket, writes to disposed Terminal)
**`src/web/terminal.ts:199, 213`** · verified

`ws.onclose` schedules `setTimeout(connect, delay)` but never stores the timer id; `dispose()`
cancels only `stableTimer`, and `connect()` has no `closedByUser` guard. Repro: a down box sits in
backoff → user clicks the sidebar ↻ (which disposes then reopens the tab) → the orphaned timer
fires, `term.write` hits a disposed Terminal, and a **second** WebSocket opens for the same box
(an extra server-side PTY listener), living until page reload. Same leak after removing a box
mid-backoff.
**Fix:** store the retry timer, `clearTimeout` it in `dispose`, and `if (closedByUser) return` at
the top of `connect()`.

---

## MEDIUM

### M1 — Fleet exec (and `killSession`) bypass the mid-login ControlMaster guard
**`src/server/index.js` wiring · `fleet.js:88` · `boxActions.js:213`** · confirmed still present

`createStatusChecker` is injected `hasLiveSession` + `masterAlive`, but `createFleetManager` is
injected only `execCommand`. So a Fleet run (or `killSession` on box delete) fires a BatchMode ssh
over the shared `%C` socket even when the user is sitting at an interactive password prompt —
reproducing the documented probe/interactive collision that status probes were fixed for in
v1.4.13. In the worst case the user's password lands in a shell instead of the prompt. (Matches the
known-gap note in memory.)
**Fix:** thread `hasLiveSession`/`masterAlive` into `createFleetManager`; mark mid-login targets
`skipped (in use)` (or wait). Small, on-pattern change mirroring the status checker.

### M2 — Session cookie is a constant, non-expiring bearer token; logout revokes nothing
**`src/server/auth.js:26-28` · `server.js:148, 180-188`**

The signed cookie value is the literal string `ok` — identical for every login, forever, with no
embedded timestamp. `maxAge` is browser-enforced only; a cookie captured once (HAR, backup,
shoulder-surfed devtools) authenticates until `TMUXIFIER_COOKIE_SECRET` is manually rotated.
`/api/logout` only clears the client cookie server-side-nothing is invalidated. This cookie gates
SSH to the whole fleet.
**Fix:** sign `ok.<issuedAtEpoch>` and reject when older than the intended lifetime (~10 lines in
`auth.js`/`isAuthed`), or keep a server-side token set so logout actually invalidates.

### M3 — Login rate limiter is bypassable and mis-buckets behind the documented proxy
**`src/server/server.js:56, 139-150`**

(a) `if (attempts.size > 1000) attempts.clear()` resets *everyone's* counters — an attacker who can
emit >1000 distinct source IPs (trivial from an IPv6 /64) clears their own lockout. Evict oldest
entries instead. (b) Fastify is built without `trustProxy`, so behind the reverse-proxy/tunnel
deployment README/DEPLOY recommend, `req.ip` is the proxy address for *every* client: per-client
limiting is impossible and any remote client can lock the real user out with 10 junk POSTs/min.
**Fix:** a `TMUXIFIER_TRUST_PROXY` config knob passed to `Fastify({ trustProxy })`, and an
evict-oldest map. Note: **login rate limiting currently has zero tests** (see coverage gaps).

### M4 — Editing a box's host/user/port/proxyJump leaves the live terminal on the OLD host
**`src/server/server.js:209-212` · `sessions.js:26-30`**

PATCH only calls `sessions.closeKey(id)` when `sessionName` changed. `open()` reuses any live/in-grace
entry by key and ignores the new `box`. Edit a box's host from `.10` to `.20` while a terminal is
open (or in grace) → the browser silently reattaches to the *old* host, while the status dot probes
the *new* one. UI and terminal disagree with no indication.
**Fix:** compare `host/user/port/proxyJump` alongside `sessionName` in PATCH and drop the PTY on any
connection-field change.

### M5 — `updateHost` merges arbitrary patch fields, including `id`
**`src/server/proxmoxStore.js:84-89` · `server.js:332-334`**

`{ ...data.hosts[i], ...patch }` with the raw request body. `PATCH /api/proxmox/hosts/:id` with
`{"id":"x"}` silently re-identifies the host — breaking presets' `hostId` and boxes'
`proxmox.hostId` provenance, and making `getHost(oldId)` 404. Replaying a redacted GET into PATCH
also persists junk like `hasToken`. `assertHostInput` checks the merged fields but not `id`.
(`updatePreset` is immune — `normalizePreset` rebuilds only known fields.)
**Fix:** whitelist patchable fields. (This route has no UI today — see D-dead-code — but it's
exposed and stub-tested.)

### M6 — Provision job fails on a single transient poll error, orphaning the container
**`src/server/proxmoxProvision.js:35, 41, 99-104`**

`pollTask` guards `taskLog` with `.catch(() => [])` but `client.taskStatus` is unguarded. One
network blip or pveproxy restart during the up-to-10-minute create/start poll throws → the job is
marked `error` while the LXC keeps creating on PVE with no box auto-link (orphaned container,
misleading outcome).
**Fix:** tolerate N consecutive `taskStatus` failures before failing the job.

### M7 — `statusPoller` has no re-entrancy guard (duplicate/out-of-order snapshots)
**`src/server/statusPoller.js:40`**

`pollOnce()` fires on a fixed interval regardless of whether the previous cycle finished. A slow
cycle (cold start with several down/needs-auth boxes at 12s timeout, waves of concurrency=4)
overlaps the next. Consequences: (a) two `history.record()` calls per interval — duplicate samples
defeat the "two consecutive over-samples" cpu debounce in `healthHistory.js:87-89`, firing a
threshold event off one hot interval; (b) out-of-order snapshot swaps — an older poll finishing
later overwrites a newer snapshot with stale data, emitting a spurious down/up event pair.
**Fix:** a one-line `if (polling) return snapshot` latch (skip or chain onto the in-flight poll).

### M8 (web) — No 401 / session-expiry handling: the dashboard silently freezes
**`src/web/api.ts:40-42` · `main.ts:343, 355, 367`**

`j()` throws a generic error on 401 and the pollers swallow everything. When the cookie expires or
the server restarts with a new secret, dots and sparklines freeze at their last values indefinitely
and every action fails with a cryptic toast — no detection, no redirect to login.
**Fix:** central 401 handling in `j()` → tear down tabs (H5) and route to `renderLogin` with a
"session expired" notice. Single seam that fixes H5 and this together.

### M9 (web) — Provision panel can get stuck open with no way to dismiss
**`src/web/main.ts:830, 840-854`**

The close button is hidden until a non-zero exit; while the job runs there's no close/cancel, so a
hung remote (WS open, no exit frame) leaves the full-height panel covering the screen until reload.
The 2s success auto-close also races a second provision started within the window, and the
`{ once:true }` close listener is re-added to the shared static button per invocation and leaks on
the success path (stale listeners fire on the next real click).
**Fix:** always show a close/cancel control; clear the auto-close timeout on re-open; bind the close
listener once at construction.

### M10 (web) — Box removal is a single unconfirmed click
**`src/web/main.ts:562-567`**

The ✕ sits in a tight 3-icon cluster next to ✎; one click calls `api.removeBox` immediately. One
misclick silently destroys the box config — inconsistent with the Proxmox UI, where every
host/key/preset removal calls `confirm()` (`proxmoxUi.ts:121, 185, 224`).
**Fix:** `confirm()` or an undo toast, matching the Proxmox pattern.

### M11 — Provision WS close can kill a shared entry another socket is attached to
**`src/server/server.js:555-559` · `sessions.js:80-83, 135-140`**

Provision mode calls `sessions.close(entry)` on socket close (kills the PTY), but `provision()`
returns the *existing* entry for a second socket with the same key. A network blip that opens a
replacement provision WS (same `provision:<boxId>` key) then lets the old socket's `close` kill the
provisioning script mid-install under the new socket → nonzero exit → the box is rolled back
(`server.js:541-548`) though the user never cancelled.
**Fix:** refcount provision sockets like interactive `detach()`, or key provision entries per-socket.

---

## LOW (grouped)

**Server correctness**
- **L1 — `default-shell` dedup `sed` is a no-op.** `boxActions.js:74,98`:
  `sed -i '#^set-option -g default-shell#d'` — a `#`-led sed script is a *comment*, so nothing is
  deleted (verified). Every omz/omb ensure run appends another `set-option -g default-shell` line to
  `.tmux.conf.local` (last-wins hides it), and it's appended even when oh-my-tmux was never
  installed. Fix: `sed -i '/^set-option -g default-shell/d'`.
- **L2 — Fleet timeout reported as `exited 1`.** `sshRun.js:6` collapses `execFile` timeout
  (`err.code === null`) to `1`; `fleet.js:95` labels the target `error: 'exited 1'`, indistinguishable
  from a real exit-1. Surface `err.killed`/`err.signal` as `timed out`.
- **L3 — `prune()` can evict a still-running fleet job.** `fleet.js:43-49` shifts the oldest job even
  if `running`; its `runJob` keeps executing against a job no longer in `jobs` (uncancellable,
  invisible to `getJob`, dropped from `save`). Prune only settled jobs.
- **L4 — Duplicate `boxIds` run the command twice on one box.** Neither `server.js:276` nor
  `fleet.js:121` dedupes targets. Dedupe in `createJob`.
- **L5 — Malformed persisted fleet job crashes startup.** `fleet.js:29` iterates `job.targets` with
  no shape check; a job missing `targets` throws in `createFleetManager` → boot fails. Validate shape
  on load.
- **L6 — cpu threshold never fires for a box that was down at seed.** `healthHistory.js:54-60,81-86`:
  if `cpuSeeded` is false at restart, the first observed cpu is silently adopted as baseline, so a box
  that boots into a runaway process after a Tmuxifier restart alerts on mem but never cpu.
- **L7 — `listSessions` success doesn't clear backoff.** `status.js:205-217` probes ignoring backoff
  but never `backoff.delete`s on success — a user-confirmed-up box stays red until the pause expires.
- **L8 — WS auth crashes on malformed cookie encoding.** `server.js:124`: `decodeURIComponent` throws
  `URIError` on `%zz` for WS upgrades (no `req.cookies`); @fastify/websocket terminates the socket
  (no leak) but the client gets an RST instead of a clean 1008 and it logs an error. Wrap in try/catch.
- **L9 — Non-string WS input frames throw into the global handler.** `server.js:494,553,586` +
  `sessions.js:124`: `{t:'i',d:123}` reaches `pty.write(123)` and throws; only index.js's
  `uncaughtException` logger keeps the process up (a bare `buildServer` embed would crash). Validate
  `typeof msg.d === 'string'`.
- **L10 — Unvalidated numeric env.** `config.js:79-98`: `TMUXIFIER_PORT=7437x` → `NaN`,
  `statusPollMs=0` → hot loop. Reuse the existing `clampInt` for all numeric knobs and fail fast.
- **L11 — `updateBox` can't clear `label`.** `store.js:52`: `label: spec.label || base.label || spec.host`
  ignores `''`/`null`; the explicit null-clear loop covers only user/port/proxyJump.
- **L12 — Google token exchange has no timeout.** `googleAuth.js:55-59`: `fetch` without
  `AbortSignal` hangs the callback if Google stalls. Use `AbortSignal.timeout(10000)`.
- **L13 — `secretBox.open` accepts truncated GCM auth tags.** `secretBox.js:29-31`: no
  `authTagLength` and no length check — a tag cut to 4 bytes still decrypts (verified), dropping
  forgery resistance to 2^-32/attempt (only matters given file-write access). Pass
  `{ authTagLength: 16 }` or reject tags ≠ 16 bytes.
- **L14 — `updateHost`/templates route param edge cases.** `server.js:347` builds
  `/storage/undefined/content` when `?storage` is omitted → 502 instead of 400.

**Web correctness (lower)**
- **L15 — `formatEvent` has no default case.** `healthEvents.ts:13-28` returns `undefined` for an
  unknown `kind`; `renderEventsPanel` then dereferences `line.level` and one unknown event aborts the
  whole timeline render.
- **L16 — Fleet job-detail races.** `showFleetJob` (`main.ts:1482`) renders unconditionally after its
  await (clicking B while A is in flight paints A over B; no generation guard like `proxmoxUi`'s
  `pollGen`), and a fast A→B click can leave A's poll timer alive so A's tick kills B's live polling.
- **L17 — `refresh()` flashes every dot gray** (`main.ts:497`) — `latestStatus={}` + immediate paint
  before the status fetch lands blinks all dots gray on any add/edit/import.
- **L18 — Logout leaves fleet/events/provision drawers overlaying the login screen** (`main.ts:399-403`
  never closes them).
- **L19 — WS URL not `encodeURIComponent`'d** in `openTerminal` (`terminal.ts:182`) though
  `openProvisionTerminal` is — safe today (ids are `randomUUID`) but inconsistent.
- **L20 — Provision exit-sniffing JSON.parses every frame** (`terminal.ts:252-262`); an output chunk
  that is literally `{"t":"x",…}` would falsely complete the panel.

**Ops / hardening**
- **L21 — `boxes.json` isn't written `0600`** (`store.js:44-47`) — it holds fleet hostnames/users;
  every other `data/` file is owner-only.
- **L22 — Blocking `execFileSync` on the event loop.** `killTmuxSession` (`server.js:47`) and
  `readDefaultPublicKey` when only a private key exists (`defaultKey.js:34-38`, "the common case") run
  synchronous 5s-timeout child processes on every relevant request, stalling all terminals. Make async
  / cache at boot.
- **L23 — `set-password` takes the password as `argv[2]`** (plaintext into shell history / `ps`), and
  the interactive fallback echoes it (`scripts/hash-password.js:22-26`). Mask input; deprecate the argv
  form.

---

## Dead code

- **Four half-wired Proxmox operations** — routes + web-client methods exist, no UI reaches them
  (grep-confirmed zero callers outside `src/web/proxmox.ts`): `PATCH /api/proxmox/hosts/:id`
  (`updateHost`), `PATCH /api/proxmox/presets/:id` (`updatePreset`),
  `POST /api/proxmox/provisions/:id/cancel` (`cancelProvision`), `GET …/nextid` (`nextId`, the
  provision manager gets VMIDs server-side instead). Edit-host and cancel-provision are genuinely
  useful — **wire them into `proxmoxUi.ts`**; otherwise drop the dead methods. (Note M5 must be fixed
  before exposing edit-host.)
- **`metaLineFor`** (`src/web/statusDot.ts:115`) — only `test/statusDot.test.js` uses it; the "for
  tooltips" comment is stale.
- **`opts.controlPath` in `sshCommand.js:10,114,148`** — no caller passes `controlPath`; the `||`
  fallback branches are dead (everyone uses `controlDir`).
- **`sessions.provision({ opts })`** (`sessions.js:79,85`) — no caller passes `opts`.
- **`stepSec`/`capSec` injection points** (`status.js:87`) and **`since` param of `api.healthEvents`**
  (`api.ts:64`, both call sites use default 0) — never overridden.
- **`assertPresetInput` `keyIds`** (`proxmoxValidate.js:57`) — destructured, never used (keys were
  de-scoped from presets); both call sites still compute `data.keys.map(...)` to pass it. Also
  **`startedAt` on provision jobs** (`proxmoxProvision.js:127`) is always `=== createdAt`, never read.
- **`runLocalShellScript` export** (`localShellActions.js:14`) — imported nowhere (used only as the
  same-file default).
- **`.dot.gray`** (`style.css:208`) — identical color to base `.dot`; redundant.
- **`typescript` devDep is never invoked** — no `tsc` in any script; vite/esbuild and vitest strip
  types without checking, so the strict `tsconfig.json` only helps editors. The TS web client is
  **never type-checked anywhere in the pipeline**. Add a `typecheck` script (recommended — real value)
  or drop the dep.
- **`@codemirror/*` (6 pkgs) sit in `dependencies`** while the equally browser-only `@xterm/*` sit in
  `devDependencies` — inconsistent, inflates production installs. Move CodeMirror to devDependencies.

No `TODO`/`FIXME`/`XXX`/`HACK` comments anywhere in the repo. No orphaned exports beyond the above —
the rest of the test-only exports are deliberate DI seams consistent with the repo's TDD convention.

---

## Test-coverage gaps (highest-value first)

1. **Login rate limiting has zero tests** — no test exercises the 429 path, the 60s window reset, or
   `attempts.clear()`. This is the crown-jewel endpoint's only brute-force defence (M3).
2. **`verifyPassword` with a corrupt/odd-length hash** — would have caught H1.
3. **Corrupt / non-array `boxes.json` (and the other stores)** — would have caught H2.
4. **Pin mode vs a CA-signed leaf** — the exact gap that let H3 ship (integration only tests
   self-signed).
5. **Session-manager exit-during-grace race** — reuse-within-grace is tested, but not "PTY exits
   during grace → client reopens → stale timer fires" (H4).
6. **`/api/logout` + cleared-cookie rejection**, and **unauthenticated `/term` WS rejection** (the WS
   test covers cross-origin but not no/invalid cookie).
7. **Fleet mid-login guard** (M1) — not even a `test.todo` keeps the known gap visible.
8. **`statusPoller` overlap** (M7), **fleet edge cases** (prune-while-running, duplicate boxIds,
   cancel-racing-completion, malformed persisted job), **`sshRun` code-mapping** (no unit test exists),
   **`healthHistory` `maxEvents` cap**, **`secretBox` truncated-tag** (L13), **store concurrency** (M5
   lost-update), **`localShellActions.ensureReady` failure path**.
9. **Web: logout→re-login and reconnect-during-backoff** — exactly where H5/H6 live; the e2e suite
   covers neither.

---

## Enhancement ideas (maintainer-plausible)

**Reliability / correctness seams**
1. Shared `atomicWriteJson` + `readJsonStrict` helper adopted by all five stores (H2).
2. Expiring/revocable session cookie (M2); `trustProxy` knob + evict-oldest rate-limit map (M3).
3. Fleet live-session guard + a `skipped (in use)` target status (M1).
4. Clamp/validate every numeric config knob via the existing `clampInt`, fail fast on NaN (L10).
5. Cache the default public key at boot; make `killTmuxSession` async (L22).

**UX**
6. **Keyboard access is the biggest UX gap:** box rows, fleet-history rows, event rows, and the
   local-shell name are clickable `<li>`/`<span>`s with no `tabindex`/role/Enter-Space handler — a
   keyboard user cannot open a terminal at all. Add `tabindex=0` + `role=button` + key handlers. The
   Proxmox hub also has no Escape-to-close and wraps its inputs in `<div>`s (not `<form>`s), so Enter
   doesn't submit.
7. Distinguish **error vs empty** states — Proxmox loaders `catch(() => [])` so an API failure looks
   identical to "you have nothing"; add a box-list loading indicator.
8. **"Press any key to retry"** in a disconnected terminal (cancel the backoff and reconnect on
   `onData`) — a down box otherwise waits up to 5 minutes with no visible way to force a retry.
9. Box-removal confirm/undo (M10); dirty-check before Escape discards a filled Add-box form; allow
   editing a box's host (currently disabled → delete+re-add loses tag/session config).
10. `startupCommand` exists end-to-end but no UI ever sets it (only import) — expose it in the
    Add/Edit box form.
11. Wire the four dead Proxmox operations (edit host/preset, cancel provision) into the UI.
12. Fleet history has `createdAt` but shows no timestamps; clicking an event row could focus/open its
    box (events already carry `boxId`); sparkline hover could show value + time (series is cached).

**Architecture**
13. **Push status/health over a WebSocket** instead of 30s polls — the server already centralizes
    probing in `statusPoller`; a broadcast channel makes dots/sparklines live and removes the
    cache-busting `?t=` fetches.
14. Allow multiple boxes per host (`assertUniqueBox` at `store.js:24` blocks a second session on one
    machine even with a different user/port/sessionName).

---

## Documentation gaps

- **`.env.example` is missing `TMUXIFIER_PVE_DEFAULT_PUBKEY`** (in `config.js:99` and the README table,
  but no commented line) — the file's stated goal is to list every optional knob. *Top doc gap.*
- **DEPLOY.md claims Tmuxifier "reads `~/.ssh/config` and can import those hosts"** (DEPLOY.md:131) —
  **no such import exists** (no route, no UI; the only import is the exported-JSON box list). What's
  true is that an ssh-config `Host` alias passes `SAFE_HOST` and the `ssh` binary resolves it, so you
  can *add a box by its alias* — but Tmuxifier reads/imports nothing itself. Reword. (Also
  README.md's "import from `~/.ssh/config`" phrasing.)
- **The local-shell / "Host Shell" feature is undocumented in README** — a full feature (terminal on
  the Tmuxifier host, omz/omb provisioning, `GET/PATCH /api/local-shell`, WS `box=__local__`) mentioned
  only as a `config.json` key. The per-box **Reconnect** action is also undescribed.
- **CLAUDE.md / AGENTS.md omit `src/web/fleetEditor.ts`** from the web-module list — a real module with
  its own test and the sole consumer of the six `@codemirror/*` deps. (The two files are otherwise in
  sync.)
- **DEPLOY.md "What lives where" table omits `health-events.json`** and has no `config.json` row.
- Minor staleness: README shows the attach command as `tmux new-session -A -D` but the real command is
  `tmux -u new-session -A -D` (the `-u` is the load-bearing UTF-8 fix); `docs/security-review-2025-06-21.md`
  is dated **2025** while all siblings and history are 2026 (year typo); the vite dev proxy hardcodes
  `127.0.0.1:7437`, breaking `npm run dev` under a custom `TMUXIFIER_PORT`.

---

## Dependency health

`npm audit`: **10 vulnerabilities (1 critical, 6 high, 3 moderate)**. Breakdown:

- **Production (fastify 4.29.1 chain):** DoS via unbounded memory in `sendWebStream`; Content-Type
  tab-character body-validation bypass; `request.protocol`/`request.host` spoofable via
  `X-Forwarded-*`; `fast-uri` path-traversal in deps. Fixed in **fastify 5.9.0** (major bump — pulls
  `@fastify/cookie` 9→11, `@fastify/static` 7→9, `@fastify/websocket` 10→11). *Note:* the WS-cookie
  workaround in `server.js` (`isAuthed` re-parses the cookie header because @fastify/websocket v10
  doesn't populate `req.cookies`) may change under v11 — verify during the upgrade.
- **Critical (dev-only):** `vitest 2.1.9` → `vite 5`/`vite-node`/`@vitest/mocker` — "Vitest UI server
  arbitrary file read/execute". Only exploitable while `vitest --ui` is running; still worth the
  vitest 4 / vite 8 bump.
- **High (dev-only):** `vite` path traversal in optimized-deps `.map` handling and `server.fs.deny`
  bypass (dev server only).

Other outdated majors: `concurrently` 8→10, `typescript` 5→6, `@xterm/xterm` 5.5→6, `@xterm/addon-fit`
0.10→0.11. **Recommendation:** schedule the fastify 5 upgrade (production-facing, behind a branch with
the WS-cookie path re-verified) and the vitest/vite dev-tooling bump; the xterm 6 major can follow with
a manual terminal smoke test.

---

## Operational note

The shipped systemd unit runs Tmuxifier as **`User=root`** (`deploy/tmuxifier.service:20`). This is a
design consequence — Tmuxifier needs the running user's SSH setup — but it means every box key is
root-held and any server compromise is root. Not a code bug; worth a hardening note in DEPLOY.md that a
dedicated user with its own `~/.ssh` confines the blast radius. Relatedly, `data/` currently has mixed
`root`/user file ownership; harmless while running as root but would break silently (stores read as
empty — see H2) if the unit's `User=` were ever changed without `chown`-ing `data/`.

---

## What's solid (so the reader has calibration)

- **SSH command-injection surface:** every box field through `assertBoxSafe` (leading-`-` rejected, no
  flag smuggling), session names sanitized, `startupCommand` single-quoted with a correct POSIX
  `shSingleQuote`. Traced end-to-end; no hole.
- **XSS:** all box/event/fleet/Proxmox strings reach the DOM via `textContent`/`append`; the only
  interpolated `innerHTML` uses a closed set of literals.
- **Secrets at rest:** AES-256-GCM with per-value nonces, key via HKDF from `cookieSecret`, files
  `0600`, redacted on read — the tag-length nit (L13) aside, the scheme is sound.
- **Test discipline:** 443 real-code tests, DI factories, no mocks; coverage gaps above are edges, not
  the core.
