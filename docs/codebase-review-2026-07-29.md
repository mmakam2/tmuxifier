# Codebase Review — Tmuxifier

**Date:** 2026-07-29
**Version reviewed:** v1.22.3 (`main` @ 774c50c, clean tree)
**Scope:** All of `src/server/` (77 modules), `src/web/` (55 modules), `scripts/`, `test/`, and
repository hygiene — a full-codebase pass, not a delta. Roughly two-thirds of the code postdates
the last full audit: passkeys, voice dictation, the standby dashboard, all four service
integrations (Pi-hole, TrueNAS, UniFi, Immich), service icons, and the health/agent-state layer.
**Method:** Eight parallel domain-scoped deep reviews (auth/core platform; SSH/box/terminal;
Proxmox/NetBox/provisioning; service integrations + icons; jobs/health/voice/AI-seed; web client
core; web settings/hub UI; repo hygiene/docs/tests), each reading its files first-hand, followed
by first-hand verification of every High and Medium finding against the source.
**Baseline:** `npm test` green — 1784/1784 across 136 files (71s). `npm run test:e2e` green —
25/25 (29s). Both captured before any finding was written.

Items from `codebase-review-2026-07-04.md` and `codebase-review-2026-07-18.md` are fully
resolved; two residuals of previously-fixed items are re-reported below and marked
`(deferred)` after independent confirmation that they are still real.

> This is a point-in-time review captured for triage. Line numbers reference the reviewed commit
> (774c50c) and have drifted where fixes have landed — see the status notes below.
>
> **The Status column in the tables below is the live fix ledger.** When a fix ships, change its
> entry from `Open` to `✅ vX.Y.Z` (or `Won't fix` with a reason), and add a dated status note
> under this header describing the batch — the same convention the two prior reviews use.

**63 findings: 2 High, 20 Medium, 41 Low.** No Critical. The login gate, WebAuthn stack,
`secretBox`, credential redaction, TLS pinning, command-injection surface, and the read-only
guarantees of all four service integrations were each reviewed end-to-end and are **clean** — see
"What was verified clean" at the end, which is as much a part of this record as the findings.

The two High findings are both *silently non-functional shipped features*, not breakage:
a checkbox that has never done anything, and a documented setup flow that cannot complete.

**Status note, 2026-07-29 (batch 1, v1.22.4): every High and Medium bug is
resolved — the Bugs table is clear down to its Low rows.** Test-first, 28 new
tests. B1 (the setup route forwards `claudeStatusline`, so the box modal's
checkbox works for the first time since v1.13.2) and B2 (the trust-on-first-use
refusal carries the fingerprint the probe observed, so pin mode can be armed; a
mismatch still refuses to hand one back, and a test locks that asymmetry) were
the two High findings. B3 (startup reconciliation releases an interrupted job's
orphaned NetBox reservation; a job that linked a box keeps its address). B4
(`target` is stated outright, so emptying the Probe URL clears it; kind `none`
drops an inherited target instead of refusing it — nine existing assertions moved
to the new contract). B5 (401 teardown and logout share one `teardownWorkspace()`;
the drifted hand-rolled copies were the bug). B6 (the install watch has one owner,
bounded retries, and a `dispose` seam in `settingsUi`'s Section type). B7
(`refreshUntil` clears the target's backoff each sweep). B8 (`provisionKey` is
shared and `hasLiveSessionForBox` covers both keys). B9 (an *inactivity* timeout
on the download — a slow 540 MB model is legitimate, a stall is not — plus a
20-minute step timeout on `execFile`). B10 (the shape guard reaches the provision,
lifecycle and voice-install managers). B11 (five modals registered).

**S4 is closed as a side effect:** B9's harness needed `voiceDownload.js` under
test, so the digest-verified-before-rename properties went from zero direct
coverage to seven tests, including that a mismatched digest leaves nothing at the
real path and that a mid-stream error cleans up the `.part` file.

B5 and B11 carry no unit tests — they are DOM teardown paths, which this suite
cannot exercise (`environment: 'node'`). Note for future batches that voice
rendering *is* covered, by `test/voiceSettingsRender.test.js` against a
hand-rolled DOM stand-in: a defensive `content.isConnected` check added during
this batch broke it, since the stand-in has no such property. Suites: unit
1812/1812 across 137 files (baseline 1784/136); e2e 25/25; typecheck clean.

**Status note, 2026-07-30 (v1.23.0): S5, reframed.** The original row proposed removing
`killSession`; triage with the operator established that the destructive behaviour is
deliberately used (a wedged shell or config is fixed by getting a fresh session), so the fix
is a guard rather than a removal — the row and its detail paragraph are corrected in place
rather than silently reinterpreted. Reconnect now arms on the first click and fires on the
second at all three sites (sidebar row, host shell, pane header), reusing the arm-then-fire
policy the pane-header lifecycle keys already had, now shared as `arming.ts`.

The same pass fixed a defect this review had missed: the pane header renders the lifecycle
`↺` (reboot container) beside the actions `↻` (reconnect terminal) — mirror-image glyphs, one
power-cycling an LXC and the other destroying a tmux session, both dim and unbordered. The
lifecycle keys are now words (`START`/`SHUTDOWN`/`REBOOT`/`STOP`, armed adding `?`), which also
retired a font-fallback workaround (U+25A0 standing in for U+23F9, absent from the bundled Meslo
face) and four per-glyph optical-size corrections in `style.css`. Not back-filled as a numbered
finding: it was found after the audit, and the audit is a point-in-time record.

Suites: unit 1824/1824 across 138 files (+7). E2e carries four tests for the guard
(arm-then-fire, disarm on outside click, Escape, one-armed-control-at-a-time), all passing —
but the suite as a whole is **red for an unrelated environmental reason**: this host's root zsh
blocks on an `[oh-my-zsh] Would you like to update?` prompt, so the 9 tests that wait for a live
shell prompt time out. Verified to reproduce on the pre-change tree. Insulating the e2e boxes
from the host's interactive rc files is unfiled work.

**Status note, 2026-07-30 (batch 2, v1.23.3): the Medium security tier is clear.**
Test-first, 10 new tests. S3 (a sealed secret no longer survives a change between
credential kinds — `sealPassword` returned `base.secret` whenever the *new* kind was also
a secret kind, so pihole→immich without retyping sent the Pi-hole app password to Immich as
`x-api-key`, in plaintext when the target is http; a kind change now invalidates the
credential, while an update that leaves the kind alone still keeps it). S1 (`/api/logout`
stays reachable unauthenticated and still clears the caller's own cookie — that harms nobody —
but only a caller holding a valid session may advance the fleet-wide revocation watermark;
unauthenticated it was a lockout lever, since the route can enforce no Origin against curl).
S2 (`assertPresetInput` now covers `features`, `dns`, `node` and `boxDefaults`: feature keys
are allowlisted, because `buildCreateParams` composes them as `${key}=1` so the KEY is PVE
syntax and `mount=nfs;cifs,keyctl` composed into real capabilities the UI never offers;
`mount` is deliberately excluded from the allowlist as it takes a filesystem list, not a
boolean; and validating `boxDefaults.user` at save turns a link-phase job failure — which for
an auto-static preset also released a NetBox address the new container was already using —
into a form error).

DOC8 closes with it: all three stale "only the app password is sealed" claims
(`servicesStore.js`, `api.ts`, the CLAUDE.md/AGENTS.md data/ bullet) now name the four
credential kinds, and the data/ bullet records the new drop-on-kind-change behaviour.

Suites: unit 1843/1843 across 139 files; e2e 28/28. One flake observed: `split.spec.ts:15`
failed once in a full run and passed both in isolation and on a full re-run — order- or
timing-dependent, unrelated to this batch, and not yet filed.

**Status note, 2026-07-30 (v1.23.4): E1.** `scripts/setup-voice.mjs` now calls the shared
`downloadVerified` instead of hand-rolling its own download, so the CLI no longer holds the
whole model in memory — `Buffer.from(await res.arrayBuffer())` kept the arrayBuffer *and* its
copy, roughly 2x 540 MB for the largest catalog entry, which is the ~1 GB peak on a 4 GB host
that `voiceDownload.js` was written to avoid. The script had always been able to call it: it
already imported `voiceCatalog` and `voiceStore` from `src/server/`. It also inherits the
properties the hand-rolled copy lacked — a stall timeout (added in v1.22.4) and `.part` cleanup
on mid-stream failure — and the duplicated digest check is gone, so verification lives at one
tested chokepoint.

The script is a CLI with no functional coverage (running it builds whisper.cpp), so
`test/setupVoiceScript.test.js` pins the wiring in the mold of `claudeStatuslineAsset.test.js`:
the downloader is imported and called with a digest, nothing buffers, no second digest
implementation, and a failure is still a clean CLI error rather than an unhandled rejection.
Those negative assertions run against the file with comments stripped — the retained comment
quotes the buffering call it replaced, which would otherwise satisfy them.

Suites: unit 1847/1847 across 140 files.

**Status note, 2026-07-30 (batch 9, v1.24.0): the efficiency tier is clear.**

**E2** — per-device UniFi statistics now go through `mapWithConcurrency` at a bound of 6 rather
than a serial `for` loop with an await inside. `mapWithConcurrency` returns in input order, so the
zip back onto device ids stays positional and a slow device cannot end up wearing another's
readings. The bound is deliberate and small: a controller is often a consumer gateway, and 200
simultaneous sockets is a burst rather than a read — the same reasoning that put SSH probes behind
that helper. A request *count* cannot tell a serial loop from a parallel one, so `fakeUnifi.js`
grew a `maxConcurrentStats` high-water mark and a `statsDelayMs` option, and the test asserts on
that instead.

Measured honestly, this changes nothing on the operator's own fleet: that controller reports seven
devices (one gateway, three switches, three APs), and serial versus concurrent snapshots came out
at 245–310ms versus 216–494ms across three runs each — entirely inside the noise. The finding's
premise was a site with up to 200 devices, where serial means 200 sequential round trips in front
of the snapshot every tile waits on. The fix is right at that scale and free at this one; it is
not a speedup anyone here will see.

The row's `and/or` second half — an aggregate `refresh()` deadline — was **not** done. Per-request
timeouts already bound each call, the client's own 30s snapshot TTL already bounds how often the
work happens, and an overall deadline would mean deciding what a half-collected snapshot renders
as. That is a design question, not a cleanup, and it belongs in its own change if a slow
controller ever actually stales a tile.

**E3** — the fast track probes one box instead of sweeping the fleet. `probeOne` keeps everything
`pollOnce` does per box: the PVE gate first, so a container PVE reports stopped still costs no
SSH at all rather than a full ConnectTimeout per 5s attempt, and the enricher's merge after, so
the patched entry still carries its proxmox fields. The snapshot is replaced with a new object
rather than mutated, preserving the invariant that a reader holding the previous one never sees it
change underneath.

History is deliberately not recorded on the fast path, and that is the load-bearing detail:
`history.record(snapshot, boxes)` **deletes the series of every box absent from `boxes`**, so
recording a single box would have wiped the rest of the fleet's health history. Leaving it to the
regular sweep is also the more honest cadence — a lifecycle action on one box has no business
densifying another's series. The cost is that the box's own up-event now lands on the next 30s
poll rather than within 5s; the snapshot the UI reads is still patched immediately, which is what
made the fast track worth having.

**E4** — the viewer did `.catch(() => null)` and rescheduled on every null, collapsing "this job
was pruned" and "this request failed" into one answer: poll forever behind an empty log. The fix
starts in `http.ts`, which now stamps the HTTP status onto the thrown error — one place, so every
fetch layer gets it, which is a dividend of C2's consolidation rather than a fifth hand-rolled
special case. The decision itself is `lifecyclePoll.ts`, pure so it is testable in the node
environment the suite runs in: a 404 gives up at once with a message naming pruning, a 401 gives
up because the shared seam is already tearing the workspace down, and anything else retries but
is capped at five consecutive failures.

Suites: unit 1898/1898 across 143 files, e2e 31/31. Verified live: a real UniFi snapshot returns
ok in ~419ms with 95 clients and 10 networks across 7 devices.

**Status note, 2026-07-30 (batch 8, v1.23.9): the dead-code tier is clear — but only two of the
three were dead.**

D1 was exactly as described. `provisionPanelGen` had a generation counter's shape — initialised
once, bumped on panel open and on run teardown — but nothing ever read it. Its consumer was a
fire-and-forget seed-AI-auth callback that went away when seeding moved into the setup job, and
the comment above it still explained a race that no longer had two sides. Variable, both
increments and the comment are gone.

D3 was an inverted dependency rather than an unused function. `seedStatusLine` was exported from
production code, and the only callers were in `test/setupOptions.test.js`; production renders the
row from `seedStatusParts` so the dot alone can be coloured. The export is removed and the tests
compose the line locally, which keeps every wording assertion while leaving one source of truth.
It also retires an assertion that could not fail: the suite checked `before + dot + after ===
seedStatusLine(...)`, which was that function's definition.

**D2 is annotated, not deleted, and that is the finding's second option taken on purpose.** The
`throw` after the retry loop in `piholeApi.js` and `truenasApi.js` is unreachable *by
construction* — every path inside the loop returns or throws — which is precisely what makes it
worth keeping. It backstops the loop bound and the `attempt === 1` guard drifting apart: raise the
bound without raising the guard and the last attempt falls out of the loop. With the throw, that
edit still reports an auth failure. Without it, the function returns `undefined`, the caller's
`res.ok` read throws a TypeError, and `fail()` reports it as `unreachable` — a rotated session
silently downgraded from "your credential expired" to "the service is down", which is the exact
auth-vs-down distinction four integrations were built around. Both sites now say so.

Both D1 and D3 were confirmed dead by the strongest available evidence: building the tree with and
without the two deletions produces a **byte-identical** bundle (`index-DEgGtlur.js` either way).
Vite had already dropped them — a module-scope variable that is only ever written is removed by the
minifier, and an export nothing imports is tree-shaken — so the shipped artifact never contained
either one. The deletions are provably behaviour-neutral, and v1.23.9 changes source hygiene only.

Suites: unit 1880/1880 across 142 files, e2e 31/31.

**Status note, 2026-07-30 (batch 7, v1.23.8): C1's first half done, its second half was a
misread.** The four credentialed check wrappers are one `CREDENTIALED_CHECKS` table plus a single
`checkCredentialed`, and `checkService` dispatches by table lookup. The four named exports are
gone — nothing outside the module ever imported them, so the module's real surface was always
`checkHttp`/`checkTcp`/`checkService`. What the table makes explicit is the semantics the four
copies each re-stated: `auth` is distinct from `down` (a rotated credential means the service is
answering, and red would cry wolf), a missing stored credential is named rather than echoing the
API's message, TLS failures stay `down` because a transport is not an authentication problem, and
a missing registry degrades instead of throwing.

The tests moved the same way and this is where the row actually paid. Fifteen hand-written
per-kind tests became one loop over the table, so a fifth integration inherits all six assertions
instead of re-transcribing five of them. That loop is strictly stronger than what it replaced: the
`tls`-is-down rule was previously asserted for UniFi alone though it binds every kind, and a
registry that throws during `clientFor` was covered for none of them. The Pi-hole block was kept
as-is — it drives a real client against a fake Pi-hole server, so it is an integration test rather
than a fourth copy.

**The `fail()` half of this row is withdrawn, not deferred.** The finding claimed four duplicated
kind-mappers; there are two. `piholeApi.js` and `truenasApi.js` each have one, and `unifiApi.js`
and `immichApi.js` have none — they build their results inline (UniFi propagates `e.kind` plus a
fingerprint and defaults to `unexpected`; Immich derives its kinds from settled promises). The two
that do exist differ in a load-bearing way: Pi-hole substitutes `AUTH_REJECTED` for an `expired`
session where TrueNAS reports the raw message. Sharing them would mean a parameterized helper
spanning an HTTPS client and a WebSocket JSON-RPC client — two modules with nothing else in
common — to save roughly six lines. Left alone deliberately.

Suites: unit 1880/1880 across 142 files. Net −60 lines of source and test.

**Status note, 2026-07-30 (batch 6, v1.23.7): C2 closed, and B28 with it.** The 401 seam moved
out of `api.ts` into a new `src/web/http.ts`, and all five fetch layers now route through its
`jsonFetch`/`jsonOf`/`jsonBody`; `api.ts` re-exports `onUnauthorized` so `main.ts`'s single
registration keeps working against the same handler slot. B28's `getBoxSetup` was the fifth
hand-rolled copy and went with it, keeping only its genuine special case (204 means "no setup
job for this box", which cannot go through a JSON parse). The unified error message gained a
last-resort `HTTP <status>`: `statusText` is `''` over HTTP/2, which carries no reason phrase,
so three of the four old copies would have thrown an empty message there — `voice.ts`'s
fallback was the one right answer and is now everyone's.

Two things are worth recording about the verification, because the first attempt was wrong.
`test/webHttp.test.js` asserts the seam fires from each of the five layers and that no module
outside `http.ts` hand-rolls an `if (!res.ok)` check — the mechanism by which the seam got
bypassed four times over. The e2e test added to `teardown.spec.ts` (an expired session detected
by opening the settings modal, which loads NetBox) initially **passed with the bug deliberately
reintroduced**, because the dashboard's own 10s poll goes through `api.ts`, which has had the
seam all along, and tore the workspace down anyway — 10.7s instead of 355ms. It only became
proof once `/api/status` and the two `/api/services` endpoints were stubbed healthy, leaving the
settings tab as the only possible source of a 401 inside the assertion window. Re-verified by
mutation: with the hand-rolled bypass restored, the test fails; with the fix in place it passes
in ~365ms.

Suites: unit 1866/1866 across 142 files, e2e 31/31.

**Status note, 2026-07-30 (batch 3, v1.23.5): the documentation tier is clear — every DOC row
is resolved.** DOC1 (README described a rollback that has not happened since v1.7.2; it now
describes the server-side setup job, Retry, the needs-interactive path, the terminal gate while
running, and that removal does not forget a host key). DOC2 (DEPLOY.md's inventory was missing
`services.json` — the file holding all four sealed service credentials — plus `voice.json`,
`voice-jobs.json` and `data/icons/`; a paragraph now states outright that three `data/` files
plus `.env` hold secrets and that rotating `TMUXIFIER_COOKIE_SECRET` makes all three
undecryptable, which a file list left to be inferred). DOC3 (`paneLifecycle.ts`, `arming.ts` and
`immichCard.ts` were absent from the web inventory and `paneHeader.ts` predated its
`lifecycleSlot`/`wantRefresh` seams — and rather than patch the two known gaps, both inventories
were audited against the actual file lists: every module in `src/server` and `src/web` is now
named). DOC4 (the fleet-overview bullet still described the pre-v1.22.2 card). DOC5 (six tabs →
seven, Services added). DOC6 (`.env.example` said the default was 45 and described the signal as
session silence; it is 20, and since v1.22.3 the clock is pane OUTPUT — a pane thinking silently
is working). DOC7 (the camelCase list omitted eight real keys and read as exhaustive; it now
notes `config.json` is merged wholesale rather than allowlisted). DOC9 (`DESIGN.md` and
`PRODUCT.md` added to the Docs index — an agent following that index could not previously learn
the visual authority existed). DOC10 (the stray NetBox sentence moved off the
`serviceClientRegistry` bullet; the debounced-store count corrected).

**B13 came along with DOC10, out of its Low tier**, because the honest fix for "four persisted
job managers" was to stop the count being a lie: `voiceInstallStore` was a genuine fifth wrapper
that the shutdown flush could not await, since it was constructed inline rather than held in a
named binding. Hoisted and flushed, so a SIGTERM during a finished install's final write no
longer reloads it as `interrupted`. Documenting a known gap was the alternative and the worse
one. No test: the flush list is entrypoint wiring in `index.js`, which has no unit harness — the
same reason the other four have none.

Suites: unit 1847/1847 across 140 files.

**Status note, 2026-07-30 (v1.23.6): the verification debt is closed — and it found a live
bug.** B5, B11 and the four-pane header width were all shipped without a browser pass. Verified
now, as tests rather than an eyeball.

B5 holds: an expired session preserves the split and its ratios, polls nothing from the login
screen, and restores the layout on re-login (`test/e2e/teardown.spec.ts`). The first assertion
was too strict — it compared the whole persisted blob, including `focusedId`, which legitimately
changed because the click that triggered the 401 focused that pane; the layout is the invariant.

B11 is pinned at the source level instead (`test/modalRegistration.test.js`): every `openModal`
call site must either pass an explicit `mount:` (living inside `#app`, dying with it) or register
its `close()` nearby. No e2e path exists — the passkey dialogs are disabled in the fixture
because passkeys pin to `localhost` while the e2e origin is `127.0.0.1`, and the deprovision and
add-disk dialogs need a Proxmox host profile with a linked container. Covering every call site
suits the bug better anyway: it was five sites forgetting the same line. Mutation-tested by
reintroducing the bug in `proxmoxContainers.ts`, which the detector named by file and line.

**The header width was genuinely broken, and v1.23.0 shipped it.** At three panes on a 1440px
window the word caps printed over the state chip and the mic button — `SHUTD[RECONNECTING]S TOP`,
with `STOP` clipped to `OP`. Cause: `.pane-life` had no `flex: 0 0 auto`, so flexbox squeezed the
caps below their text width, and a nowrap flex item under its content spills rather than clips.
`.pane-title` had neither a shrink floor nor an ellipsis either, so the identity group already
overflowed by 12-19px before the words existed — the caps only made a latent bug visible. Fixed
three ways: caps never shrink; the header is a `container-type: inline-size` query context so the
lifecycle slot drops out below 400px (operator's choice — power actions stay in the Proxmox hub)
rather than overlapping; and the host address hides below 520px so the label stays whole, because
shrinking both produced "L… tm…", two stubs instead of one usable identity.

Suites: unit 1850/1850 across 141 files; e2e 30/30.

---

## Findings and fix tracking

Severity reflects likelihood × blast radius for this single-user tool, not CVSS. Effort is a
rough fix-size guess: **S** = under an hour, **M** = a few hours. High and Medium findings have a
detailed explanation in the sections after the tables; Lows are described fully in their row.

### Bugs

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| B1 | setup | `POST /api/boxes/:id/setup` never forwards `claudeStatusline`, so the box modal's "Push Claude Code statusline" checkbox has been a no-op since it shipped (v1.13.2) | **High** | S | Add `claudeStatusline: !!b.claudeStatusline` to the options literal, plus a route test | ✅ v1.22.4 |
| B2 | unifi | UniFi pin-mode arming is a dead loop: Test connection cannot return a fingerprint in the one mode that needs it, so self-signed controllers get pushed to `insecure` | **High** | S | Attach the probed `fingerprint256` to the pin-mode `ApiError` and return it through `asResult`/the route | ✅ v1.22.4 |
| B3 | provision | A restart between `allocate-ip` and completion permanently leaks the NetBox reservation — reconciliation only flips status, never releases | Med | S | Best-effort release `j.netboxIpId` for non-terminal jobs during startup reconciliation | ✅ v1.22.4 |
| B4 | services | Emptying the Probe URL field can never clear a stored `check.target`; switching a target-bearing tile to "None" 400s with no way out | Med | S | Always state `target` (empty string clears); let the `none` branch ignore rather than refuse an inherited target | ✅ v1.22.4 |
| B5 | web | Session-expiry (401) teardown routes through `closeTab`/`undock`, destroying the persisted stage layout that explicit logout deliberately preserves — and restarts the dashboard poll on the login screen | Med | S | Mirror the logout handler's direct teardown: dispose tabs, clear maps, null `stageRoot` without repaint/persist | ✅ v1.22.4 |
| B6 | voice | The install-watch poller has no owner: it repaints whichever settings tab is open when the install finishes, survives modal close, and 401-polls forever after logout | Med | M | One poller handle per section render, stopped on tab switch/modal close; guard `settle` on `content.isConnected` | ✅ v1.22.4 |
| B7 | status | `refreshUntil`'s 5s fast-track is silently throttled by the status checker's own failure backoff, so a just-started container recovers on the 30/60/90s schedule instead of its boot time | Med | S | Reset backoff before each fast-track sweep (or add an ignore-backoff option to `checkBox`) | ✅ v1.22.4 |
| B8 | status | The "don't probe a box with a live interactive login" guard misses provision PTYs (keyed `provision:<id>`), so probes collide with the password prompt during an interactive setup finish | Med | S | Have the adapters also consult `sessions.hasLiveSession('provision:' + box.id)` | ✅ v1.22.4 |
| B9 | voice | No timeout anywhere in the install pipeline: a stalled download or clone wedges the single-flight job `running` forever, with no cancel route and a ship checklist that gates restarts on exactly that state | Med | S | `AbortSignal.timeout` on the fetch and a timeout on `defaultRun`/per-phase deadline | ✅ v1.22.4 |
| B10 | jobs | A malformed row (e.g. `null`) in `provision-jobs.json`, `proxmox-lifecycle-jobs.json`, or `voice-jobs.json` crashes the server at boot — the bug class fixed as B5 in the 2026-07-18 review, never retrofitted to these three managers | Med | S | Copy `setupManager`'s `if (!j \|\| typeof j !== 'object' \|\| typeof j.id !== 'string') continue;` | ✅ v1.22.4 |
| B11 | web | Five body-mounted modals never call `registerModal`, so teardown misses them — a deprovision confirm can float over the login screen with a live, 401-ing Deprovision button | Med | S | Register each, mirroring `settingsServices`' `confirmRemove` | ✅ v1.22.4 |
| B12 | services | A rejected first sweep permanently kills the service polling loop: the interval is scheduled only after `await pollOnce()` succeeds | Low | S | Schedule the interval before (or regardless of) the first sweep's outcome | Open |
| B13 | stores | `voice-jobs.json` is the only debounced job store excluded from the shutdown flush, so SIGTERM during its final write reloads a finished install as `interrupted` | Low | S | Hoist the store to a named binding and add its `whenIdle()` to the flush array | ✅ v1.23.5 |
| B14 | stores | After a failed write with a newer payload queued, `debouncedJsonStore` never retries and `whenIdle()` dangles — shutdown burns the full 5s flush timeout and loses the state | Low | S | On the error path, re-run the loop when `pending !== null` before resolving idle waiters | Open |
| B15 | voice | Two concurrent `POST /api/voice` calls across a model change can each build an engine; the loser is returned to its caller but is unreachable by the shutdown hook (~0.85 GB RSS until its idle timer reaps it) | Low | S | Cache the in-flight rebuild promise, as `createDefaultKeyProvider` already does | Open |
| B16 | setup | Removing a box whose setup job is parked `needs-interactive` leaks that job and its ≤64 KB log forever — it can never be resolved or superseded once the box is gone | Low | S | Have `cancelForBox` flip a non-running current job to `superseded` | Open |
| B17 | voice | Install job history is unbounded — every sibling job manager prunes; each retry adds up to 64 KB, reloaded into memory and rewritten on every save | Low | S | Cap terminal history like the setup manager (always keep a running job) | Open |
| B18 | icons | An edited service URL never re-scrapes the favicon: the skip-guard treats a stale `data/icons/` cache hit the same as a catalog hit, so a repointed tile keeps the old app's logo | Low | S | On a save that changed `url`, forget + rescrape (or record the URL the cache was scraped from) | Open |
| B19 | web | A changed service icon never repaints on the dashboard: `serviceIcon.update()` guards refetch on `svc.id` alone, and the tile element outlives every mount | Low | S | Include `svc.icon` (or a server-provided version) in the guard key | Open |
| B20 | web | Any stage repaint destroys an in-flight lifecycle job's chip and its `onSettled` fast-poll, so the outcome is never shown and the pane waits out the 30s tick | Low | M | Keep in-flight lifecycle controls alive across repaints, or re-adopt the running job id into the rebuilt control | Open |
| B21 | web | The provision terminal refits locally on window resize but the provision WS has no `'r'` branch, so an interactive sudo session garbles after a resize | Low | S | Add the resize branch to the provision WS handler and send resize, or don't refit | Open |
| B22 | web | Divider drag never handles `pointercancel`, leaving live `pointermove` listeners that resize the split on bare hover with no button held | Low | S | Also remove listeners on `pointercancel`/`lostpointercapture` | Open |
| B23 | web | `stageLayout.restore()` guards `JSON.parse` but not its own recursion, so a pathologically deep payload throws out of `renderDashboard` — the exact invariant the module exists to uphold | Low | S | Wrap the whole `restore` body in try/catch returning `fallback` | Open |
| B24 | web | Rounding-boundary artifacts: `fmtCompact(999_960)` renders "1000.0k" rather than "1.00M"; same family in `fmtBytes` and `fmtBitrate` | Low | S | Promote to the next unit when the rounded mantissa reaches the base | Open |
| B25 | web | On a plain-http origin the passkey verdict says "This browser does not support passkeys" instead of naming the HTTPS requirement (`PublicKeyCredential` is `[SecureContext]`-exposed) | Low | S | Check `!isSecureContext` before the `hasWebAuthn` branch, as `evaluateVoice` already orders it | Open |
| B26 | web | A saved vmid missing from the container list silently re-drafts the association to the first listed container, so Save Box can commit a link the user never chose | Low | S | Keep the draft at the saved values when `selected` matches no option, or insert an "unavailable (saved)" placeholder | Open |
| B27 | web | Settings and hub tab switches have no generation guard, so a slow section's render paints over the newer tab | Low | S | A render generation counter checked before each section's final `replaceChildren` | Open |
| B28 | web | `getBoxSetup` hand-rolls its response check and bypasses the central 401 seam, so an expired session churns 401s at 1.5s instead of triggering teardown | Low | S | Call `unauthorizedHandler` on 401 inside `getBoxSetup` | ✅ v1.23.7 |
| B29 | web | The hub's setup viewer renders seed results but drops the statusline outcome the provision panel shows, so a failed push is invisible in the panel being watched | Low | S | Append the statusline line beside the seed line | Open |
| B30 | voice | Voice control error paths leave the UI contradicting the server: a failed save leaves the checkbox flipped (unhandled rejection); a failed install start leaves the radio selected and the button disabled | Low | S | Catch and repaint via `refresh()` on failure | Open |
| B31 | scripts | Pasting a password into `hash-password`'s hidden prompt embeds the terminating newline into the hash, so every later login 401s with no clue why | Low | S | Iterate the chunk character-by-character inside `onData` | Open |

### Safety and security

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| S1 | auth | `POST /api/logout` is unauthenticated, so any network client can loop it to advance the revocation watermark and keep the operator locked out of their own fleet | Med | S | Advance the watermark only for a request carrying a valid session; clear the cookie unconditionally | ✅ v1.23.3 |
| S2 | proxmox | Preset `features`, `dns.*`, `node`, and `boxDefaults` bypass validation, contradicting "all provision input is validated" — a crafted `features` key composes into PVE syntax enabling mount/keyctl the UI never offers | Med | S | Allowlist feature keys, validate `dns`, apply `SAFE_NODE` to preset `node`, run `boxDefaults` through the box validators at preset save | ✅ v1.23.3 |
| S3 | services | A sealed secret survives a switch between credential kinds, so a Pi-hole app password is replayed as another product's API key — over plain http if the new kind is Immich | Med | S | Drop the secret whenever the kind changes at all, and test it | ✅ v1.23.3 |
| S4 | voice | The stream-hash-verify-rename chokepoint (`downloadVerified`) has **zero** direct test coverage — its security-critical properties are enforced only by unexecuted code | Med | S | Test good-digest rename, bad-digest unlink + throw, and mid-stream error cleanup against a local fixture | ✅ v1.22.4 |
| S5 | boxes | The "Reconnect" (↻) button kills the on-box tmux session on a single unguarded click, so one misclick destroys a running agent — while the adjacent and *less* destructive ⚷ is confirm-gated | Med | S | Arm-then-fire (two clicks), matching the pane-header lifecycle keys. **Not** removal: killing the session is used deliberately to get a fresh one when a shell or config is wedged | ✅ v1.23.0 |
| S6 | web | CSP `connect-src 'self' ws: wss:` whitelists the entire ws/wss schemes — the one hole in an otherwise tight `script-src 'self'` policy | Low | S | Drop `ws: wss:` (`'self'` covers same-origin upgrades in all evergreen browsers) and verify the terminal still connects | Open |
| S7 | services | The four test routes are a credential-forwarding oracle: `{id, url:<arbitrary>}` sends the stored decrypted secret to any URL, with no requirement that it match the stored service | Low | S | When falling back to the stored secret, use (or require a host match with) the stored service's own URL | Open |
| S8 | statusline | `printf '%b'` expands backslash escapes from `VERSION`/`BASE`, so a cloned repo with a crafted `package.json` version emits arbitrary terminal escapes into the operator's statusline | Low | S | Strip control chars/backslashes from both, or assemble untrusted segments with `%s` | Open |
| S9 | status | A *jump host's* changed key still classifies the target box as `hostKeyChanged`, so ⚷ discards the target's pinned key while the real error persists **(deferred from 2026-07-18)** | Low | S | Suppress the classification when `proxyJump` is set, or verify the banner's host line names `box.host` | Open |
| S10 | boxes | The forget-hostkey route ignores `ssh-keygen -R`'s result and always reports `{ ok: true }`, so a failed removal is reported as success **(deferred from v1.7.1 work)** | Low | S | Surface `results.some(r => r.code !== 0)` as an error in the response | Open |

### Efficiency

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| E1 | voice | `setup-voice.mjs` buffers the whole model in RAM (~1.1 GB peak for `medium.en-q5_0`) instead of reusing `downloadVerified` — the exact failure that module's header warns about | Med | S | `await downloadVerified({ url, dest, sha256 })` and drop the hand-rolled block | ✅ v1.23.4 |
| E2 | unifi | Per-device statistics are fetched serially with no aggregate deadline — up to 200 sequential requests, and one slow controller stales every other tile's readings | Low | S | Fetch stats concurrently (bounded), and/or give `refresh()` an overall deadline | ✅ v1.24.0 (concurrency; no deadline) |
| E3 | status | The post-lifecycle fast-track re-sweeps the entire fleet every 5s for up to 3 minutes when only one box's recovery matters (~300 extra probes per container start on a 10-box fleet) | Low | S | Probe only the target and patch that snapshot entry — composes with the B7 fix | ✅ v1.24.0 |
| E4 | web | `showLifecycleJob` cannot distinguish 404 from a transient failure, so a pruned job id polls forever behind an empty log | Low | S | Give up with a message after N consecutive nulls, or treat 404 distinctly | ✅ v1.24.0 |

### Consolidation

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| C1 | services | `checkPihole`/`checkTruenas`/`checkUnifi`/`checkImmich` are four structurally identical wrappers (~80 lines) differing only in registry, method, metrics key and message; the `fail()` kind-mappers duplicate too | Low | M | One parameterized helper, so the next integration inherits `auth`-vs-`down` semantics rather than re-transcribing them | ✅ v1.23.8 (wrappers; `fail()` claim corrected below) |
| C2 | web | Four fetch layers (`proxmox`, `netbox`, `passkeys`, `voice`) re-implement the same `jr()`/`jsonBody()` pair, and none is wired to `onUnauthorized` — the root cause behind B6 and B28 | Low | M | One shared `jsonFetch` with the 401 hook, reused by all five layers | ✅ v1.23.7 |
| C3 | ssh | `gitBootstrap` is a verbatim inline copy of `installPackagesBlock('git', samePkg('git'), 'git')` — the six-package-manager ladder now exists twice | Low | S | `const gitBootstrap = needsGit ? installPackagesBlock(...) : []` | Open |
| C4 | voice | `voiceInstall.js` reimplements `newestFirst` instead of importing the shared `jobOrder.js` comparator its header says is shared by the persisted job managers | Low | S | Import it | Open |

### Dead code

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| D1 | web | `provisionPanelGen` is written twice and read never — its consumer was removed when seeding moved server-side, as the adjacent comment already admits | Low | S | Delete the variable, both increments, and the stale rationale comment | ✅ v1.23.9 |
| D2 | services | The terminal `throw` after the retry loop in `piholeApi`/`truenasApi` is unreachable (attempt 1's catch always throws) | Low | S | Delete, or annotate as intentionally unreachable so a future loop edit can't silently change auth semantics | ✅ v1.23.9 (annotated, deliberately not deleted) |
| D3 | web | `seedStatusLine` is exported but only tests call it; production uses `seedStatusParts` directly | Low | S | Fold the test onto `seedStatusParts`, or keep deliberately | ✅ v1.23.9 |

### Hygiene

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| N1 | provision | `POST /api/proxmox/provisions` stores and echoes client-supplied `setupOptions` verbatim, so an invalid tool id surfaces only after the container is built | Low | S | Run the same normalize/`resolveTools` shape check the setup route uses | Open |
| N2 | deps | `ws` appears in both `dependencies` (^8.21.0) and `devDependencies` (^8.21.1); the runtime use is real, so the dev entry is dead but misleading about which pin wins | Low | S | Delete the devDependencies entry | Open |

### Documentation

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| DOC1 | README | Still claims a failed box setup rolls the new box back from the list — pre-v1.7.2 behavior; setup now keeps the box (Retry / explicit Remove) | Med | S | Rewrite the add-a-box paragraph around the server-side setup job, its actions, and the terminal gate while `running` | ✅ v1.23.5 |
| DOC2 | DEPLOY | The "What lives where" data inventory omits `services.json` — which holds four kinds of sealed API credentials — plus `voice.json`, `voice-jobs.json`, and `data/icons/` | Med | S | Sync the row with CLAUDE.md's data/ list | ✅ v1.23.5 |
| DOC3 | CLAUDE/AGENTS | The `src/web` module inventory omits `immichCard.ts` and `paneLifecycle.ts` entirely; the `paneHeader.ts` entry predates the lifecycle-slot seam | Med | S | Add both modules and the slot note to both files | ✅ v1.23.5 |
| DOC4 | README | The fleet-overview bullet still describes the pre-v1.22.2 card ("session count, and the CPU sparkline") rather than the spec sheet that replaced it | Med | S | Update to the spec-sheet content; the sidebar-row sparkline prose stays correct | ✅ v1.23.5 |
| DOC5 | README | The settings modal is described as "six tabs", omitting Services — which four later sections direct users to | Low | S | "Seven tabs", and add Services to the list | ✅ v1.23.5 |
| DOC6 | .env.example | The `TMUXIFIER_AGENT_IDLE_SEC` comment says "Default 45"; the real default is 20 (config.js and the README table agree on 20) | Low | S | Correct the comment | ✅ v1.23.5 |
| DOC7 | README | The `config.json` camelCase key list reads as complete but omits eight accepted keys (`uploadMaxMb`, `claudeOauthToken`, the five voice knobs, `voiceOff`) | Low | S | Complete the list, or state it as a sample | ✅ v1.23.5 |
| DOC8 | CLAUDE/code | Three stale claims that only a Pi-hole password is sealed — CLAUDE.md's data/ bullet, `servicesStore.js:152/166`, and `api.ts:62` — contradicted by the same files' own security notes since v1.21.2 | Low | S | Generalize all three to the credential kinds | ✅ v1.23.3 |
| DOC9 | CLAUDE/AGENTS | The Docs index lists neither `DESIGN.md` (the declared visual authority) nor `PRODUCT.md`, so agents following the index never learn the visual authority exists | Low | S | Add both lines to both files | ✅ v1.23.5 |
| DOC10 | CLAUDE/AGENTS | The `serviceClientRegistry.js` bullet ends with a sentence about `GET /api/netbox/summary` that belongs to the NetBox bullet; `debouncedJsonStore.js` still says "four persisted job managers" (there are five) | Low | S | Move the stray sentence; correct the count | ✅ v1.23.5 |

---

## Detail — High findings

### B1 — the statusline checkbox has never done anything

`server.js:1104` builds the setup options literal:

```js
const options = { ohMyTmux: !!b.ohMyTmux, ohMyZsh: !!b.ohMyZsh, ohMyBash: !!b.ohMyBash, tools, seedAiAuth: !!b.seedAiAuth };
```

`claudeStatusline` is absent. The client sends it (`setupOptions.ts:115`, typed in `api.ts:175`),
and `normalizeOptions` (`setupManager.js:108`) then coerces the missing key to `false`, so the
`statusline` phase at `setupManager.js:146` never runs. The Proxmox provision path is unaffected —
it stores `req.body.setupOptions` verbatim — which is why the feature appears to work when
provisioning and silently doesn't from the Add/Edit Box modal. The v1.13.2 commit that added the
checkbox touched only web files. No route test covers the flag.

### B2 — UniFi pin-mode arming cannot be completed

`probe()` runs `listSites()` **before** capturing the fingerprint (`unifiApi.js:171-180`). In pin
mode with an empty fingerprint, `resolveTls()` throws *"no fingerprint pinned yet — run Test
connection and accept the certificate"* before any fingerprint is attached, and `asResult`
returns only `{ ok, kind, error }`. So the route's error-path spread
`...(res.fingerprint256 ? { fingerprint256 } : {})` (`server.js:953`) never fires. Meanwhile the
UI's auto-fill guard `res.fingerprint256 && tlsMode() === 'pin'` (`settingsServices.ts:275`)
discards the fingerprint in the only modes that *do* return one (verify/insecure success).

Every sequence dead-ends, and both the error text and the field placeholder tell the operator to
run the thing that just failed. The practical outcome is that self-signed controllers — the
default — get configured as `insecure`, which is exactly what the documented pin flow exists to
prevent. `unifiApi.test.js:173` asserts the refusal but never the fingerprint round-trip.

## Detail — Medium findings

**B3 — NetBox reservation leaks on restart.** Startup reconciliation (`proxmoxProvision.js:27`)
only sets `j.status = 'interrupted'`; the release logic lives solely in `run()`'s catch. An
auto-static job that allocated an IP and was interrupted by a deploy restart leaves the address
reserved with no box linked (so deprovision can never reclaim it) and no UI reference to the
leaked `netboxIpId`. Contradicts CLAUDE.md's "released again on failure or deprovision".

**B4 / S3 — the services store's merge semantics, twice.** `normalizeCheck` merges
`{...base, ...raw}`, so an omitted key means "keep stored". `buildServicePayload` omits an empty
`target`, so clearing the Probe URL silently keeps probing the old one; switching a tile with a
target to "None" hits `if (target) throw` and 400s with no way to clear it from the form; and
http→pihole carries a stale health URL over as the new API base. Separately (S3), `sealPassword`
returns `base.secret` whenever the new kind is *also* a secret kind, so pihole→immich without
typing a key replays the Pi-hole app password as `x-api-key` on the very next 30s sweep — over
plain http if the Immich target is http. Both contradict comments in the same files. This is the
documented PATCH-merge bug class recurring; the standing fix convention is to state fields
outright and test the clearing case.

**B5 — 401 teardown clobbers the layout.** The logout handler tears terminals down directly and
says why: *"NOT via closeTab/undock — so the persisted layout survives logout and re-login
restores it."* `onUnauthorized` (`main.ts:2461`) instead calls `closeTab(id)` per tab, which
reaches `undockBox → repaintStage → persistStage()` and overwrites the saved split. When the last
tab goes, `repaintStage`'s `stageRoot == null` branch calls `ensureDash()` + `startDashPolling()`
*after* `teardownDash()` — a 10s interval firing 401'd requests on the login screen until
re-login, violating the "polls run only while mounted" invariant.

**B6 — the voice install poller has no owner.** `watch()` creates a poller nothing ever stops,
and its `settle()` repaints the shared settings content unconditionally: finish an install while
on the Notifications tab and that tab is silently replaced by the Voice UI. After logout,
`voice.ts`'s fetch layer never reaches the `onUnauthorized` seam (see C2), so the loop 401s every
2s indefinitely. Re-opening the tab mid-install spawns a second poller.

**B7 / B8 — two status-probe guards that don't hold.** `refreshUntil` loops every 5s, but each
sweep goes through `checkBox`, whose failure backoff (30→60→90s) returns the cached failure
without touching SSH — so a container whose sshd answers at t=35s isn't seen up until t=90s, and a
~100s boot exhausts the 180s fast-track. Separately, the "don't probe a box with a live
interactive session" guard consults `sessions.hasLiveSession(box.id)`, but the interactive-finish
PTY is keyed `provision:<boxId>` — so during a `needs: 'ssh'` finish, BatchMode probes fire into
the password prompt the guard exists to protect, and stamp a 5-minute needsAuth backoff mid-finish.

**B9 — the voice install has no timeout anywhere.** Neither the fetch, the stream loop, nor
`defaultRun`'s `execFile` carries a deadline. A TCP stall mid-download hangs `execute()`
indefinitely; `runningJob()` then rejects every new attempt, there is no cancel route, and the
ship checklist gates restarts on "no voice-install job is `running`" — so the stuck job argues
against the only action that clears it. Compare `setupManager`'s `taskTimeoutMs = 600000`.

**B10 — one bad row still crashes boot, in three managers.** `provisionStore`/`lifecycleStore`/
`voiceInstallStore` load loops dereference `j.status` with no shape guard, and
`debouncedJsonStore.load()` validates only `Array.isArray` — so `[null]` parses, passes, is never
quarantined, and throws a TypeError at module top level. `fleet.js:31` and `setupManager.js:71`
both carry the guard with the stated invariant that one bad history row must never keep the
server from booting; these three predate or postdate the fix and were never retrofitted.

**B11 — five modals outside the registry.** The add-passkey, remove-passkey, arm-confirm,
deprovision-confirm, and add-disk dialogs all `openModal({ modal })` with the default body mount
and never `registerModal`. CLAUDE.md states the invariant plainly. On session expiry,
`closeAllModals()` closes the hub underneath while the deprovision confirm floats over the login
screen with a still-clickable, 401-ing Deprovision button.

**S1 — unauthenticated logout is a lockout lever.** The route carries no `requireAuth`, and
`requireTrustedOrigin` passes any request without an Origin header. An anonymous client looping it
advances `sessionsInvalidBeforeMs` continuously, so the operator's freshly minted cookie dies
within a second of every login — plus one atomic `auth-state.json` write per request. The existing
test only exercises the authenticated case.

**S2 — the provision-input validation invariant has holes.** `assertPresetInput` never checks
`spec.features`, `spec.dns`, `spec.node`, or `spec.boxDefaults`, and `normalizePreset` stores them
raw. `buildCreateParams` then does ``map(([k]) => `${k}=1`).join(',')``, so a crafted key composes
into valid PVE syntax enabling mount/keyctl capabilities the UI never offers. A second, more
likely path: an invalid `boxDefaults.user` passes preset save and throws at the link phase —
after the container exists — erroring the job and releasing an IP a live container is using.

**S4 — the download chokepoint is untested.** `grep -rl downloadVerified test/` matches nothing;
`voiceInstall.test.js` always injects a stub. The properties CLAUDE.md relies on — digest verified
before `renameSync`, no unverified blob at the real path, `.part` cleanup — would survive being
reordered without a single test failing.

**S5 — Reconnect kills the session.** `POST /api/boxes/:id/reconnect` runs
`boxActions.killSession(box)` after `exitMaster`/`closeKey`. It is deliberate and test-locked, but
both UI buttons are labeled only "Reconnect" with no confirm, while the adjacent and *less*
destructive ⚷ forget-hostkey action is confirm-gated. One misclick kills a claude mid-task.

*Corrected on triage (2026-07-30).* This row originally proposed dropping `killSession`, reasoning
from CLAUDE.md's "the work survives" premise. That was wrong about how the button is used: killing
the session is the point — it is how the operator gets a fresh session when a shell or config is
wedged, and `exitMaster`/`closeKey` alone would not deliver that. The defect is only the missing
guard, so the fix is arming, not removal. Resolved in v1.23.0 together with a second problem the
finding missed entirely: the pane header renders `↺` (reboot container) and `↻` (reconnect
terminal) side by side — mirror-image glyphs with very different blast radius — which is why the
lifecycle keys became words in the same change.

**E1 — the voice CLI buffers what the server streams.** `setup-voice.mjs:86` does
`Buffer.from(await res.arrayBuffer())`, holding both the arrayBuffer and its copy (~2× 540 MB).
`voiceDownload.js`'s header exists precisely because buffering "would peak near 1 GB on a 4 GB
host". The script already imports from `src/server/`, so the fix is a one-line substitution.

**DOC1–DOC4** are the user-facing drift: README describes a rollback that no longer happens and a
fleet card that no longer renders, DEPLOY.md's backup/secret inventory misses the file holding
four sealed credentials, and the agent-facing module inventory omits two shipped modules.

---

## What was verified clean

Recorded deliberately: these areas were read end-to-end this pass and found sound, which is what
makes the findings above the exceptions rather than a sample.

- **Route authentication.** Every `/api/*` route read end-to-end; all carry `requireAuth` (or
  `onRequest: requireAuth` correctly placed before body buffering on the two raw-body routes)
  except the five deliberate exceptions and S1's logout. `/term` checks origin then cookie auth,
  applies the revocation watermark on both the primary and fallback cookie paths, and is covered
  by cross-origin, malformed-cookie, and setup-gate integration tests.
- **WebAuthn.** Bounded CBOR (depth cap, duplicate-key refusal, no indefinite lengths), COSE
  import with degenerate-RSA rejection, attestation `none`-only, rpId hash + origin + UP/UV flag
  checks, timing-safe challenge comparison with a 16-byte floor, sign-count stall vs corrupt-store
  disambiguation, single-use per-owner-bounded challenges, and all four passkey-only lockout
  guards — each covered by the 794-line and 699-line test files.
- **Cryptography and secrets at rest.** `secretBox` AES-256-GCM with random IV, HKDF-derived key,
  full-16-byte tag enforced. Every Proxmox/NetBox/service read path redacts (`hasToken`/
  `hasPassword`/`set`); `getServiceSecret` and `getHost(id,{withSecret})` are the sole decrypting
  paths; no secret reaches the browser, job records, or logs — traced through error paths.
- **Command injection.** Every ssh argv builder calls `assertBoxSafe`; host/user/port/proxyJump
  allowlists intact with leading-`-` rejection; session names sanitized before interpolation;
  `startupCommand` single-quoted everywhere; no box field bypasses the closed field set;
  flag-smuggling tests lock all seven builders. Uploads, tmux injection, and the `__META__`
  os-release allowlist all hold exactly as CLAUDE.md describes.
- **TLS pinning.** Pin mode verifies on the request's own connection before headers are written;
  the probe socket is compare-only; `normFp` fails closed; CA mode never falls back. Integration
  tests assert the token is never sent on mismatch across three chain shapes.
- **Service integrations' read-only guarantees.** Grepped per client: Pi-hole issues only GET plus
  its sanctioned auth login/revoke; TrueNAS calls only the five documented JSON-RPC methods and
  never negotiates the mechanism; UniFi and Immich contain no verb but GET. Session/socket
  lifecycles (one-session reuse, single-flight auth, exactly-one re-auth, identity-guarded
  teardown, snapshot TTLs) all behave as documented.
- **Icons.** Slug validated at the store and re-checked with containment before every read
  (traversal tests at both levels); scrape capped at 256 KB / 3 redirects / 5s with a content-type
  allowlist; both routes auth-gated; `<img>`-only rendering holds at every call site.
- **XSS.** Every server- and box-derived string across all 88 web modules lands via
  `textContent`/`title`/`append`; the only `innerHTML` templates interpolate fixed strings and the
  bundled logo URL. No inline handlers or external references in `index.html`.
- **Agent-state derivation (v1.22.3).** Both timestamps are box-clock (no cross-clock skew),
  missing clock/timestamp yields `unknown` on neither edge, attach suppression and the
  `stopped`/`up` guards verified, events capped.
- **Repo hygiene.** PII scan of all tracked files found only sanctioned placeholders; every secret
  path is gitignored with zero tracked files under any; the systemd unit sets `HOME`, carries no
  secrets, and matches its README copy; zero `.only`/`.skip` across the suite; no orphan modules;
  every runtime dependency is imported; version fields agree across `package.json` and both
  lockfile entries.
