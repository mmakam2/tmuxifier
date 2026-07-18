# Codebase Review — Tmuxifier

**Date:** 2026-07-18
**Version reviewed:** v1.7.3 (`main` @ 2330bcc, working tree)
**Scope:** All of `src/server/`, `src/web/`, scripts, tests, and repository hygiene.
**Method:** Five parallel deep reviews (server core, SSH/session/box layer, Proxmox/NetBox,
fleet/setup/health, web client), followed by first-hand verification of the top findings and a
dead-export sweep. Baseline: `npm test` is green (819/819 tests across 74 files, ~36s).
Items that were still open from the 2026-07-04 review were re-verified against v1.7.3 and are
folded in below with their old IDs noted.

> This is a point-in-time review captured for triage; nothing in it has been fixed yet. Line
> numbers reference the reviewed commit and will drift as fixes land.
>
> **The Status column in the tables below is the live fix ledger.** When a fix ships, change
> its entry from `Open` to `✅ vX.Y.Z` (or `Won't fix` with a reason), and add a dated status
> note under this header describing the batch — the same convention
> `codebase-review-2026-07-04.md` uses.

**Status note, 2026-07-18 (batch 5, v1.7.8):** B4 plus the server-side consolidation set.
B4 (every `boxes.json` mutation is serialized through a per-store promise queue — the RED test
lost 7 of 8 concurrent writes before the fix). Consolidation: C1 (the four byte-identical
debounced stores collapse into one `debouncedJsonStore.js`; each store is now a one-line
wrapper), C4 (the duplicated PVE task poller becomes a shared `pveTask.js`), C5 (the
pin-mode `createConnection` glue moves into `tlsPin.js`'s `pinnedConnectionFactory`), C6
(`proxmoxApi` reuses `parseEndpoint`), C7 (health clamps reference `DEFAULTS.*`), C8
(`buildEnsureLocalShellScript` takes the session name; `createLocalShellActions` threads
`localSession`). Dead code: D1 (the unreachable `/api/status` probing fallback is deleted —
the route serves the poller snapshot only, and the bounded-concurrency property is covered in
statusPoller's own tests), D3 (`writeFileAtomic`/`Sync` fsync the temp file before the rename,
making the module's power-loss claim true). Housekeeping: N1 (terminal WS URL encodes the box
id), N2 (the two long-failing e2e specs asserted the literal string "bash" on a zsh host —
they now wait for a shell prompt, and **the full e2e suite is green for the first time,
12/12**), N3 (~180 stale review-diff scratch files deleted). Suite: 871/871.

**Status note, 2026-07-18 (batch 4, v1.7.7):** the sweep — 23 findings, test-first. Bugs:
B14 (post-removal master teardown skipped when an identical box was re-added), B15
(StringDecoder per ssh stream — no more split-glyph mojibake in setup logs), B16 (a transient
PVE `unknown` no longer closes the stopped-box panel), B17 (NetBox read/decrypt errors surface
as themselves, in both provision and lifecycle release), B19 (Google token exchange gets a 10s
abort signal), B20 (unquoted inline `#` comments stripped from `.env` values), B21 (ssh
timeouts resolve 124/`timedOut` and fleet labels them "timed out"), B22 (fleet de-duplicates
box ids), B23 (an explicit empty label clears to the host default), B24 (templates without
`?storage` is a 400), B25 (`formatEvent` gained a default case). Safety: S3 (logout advances a
persisted revocation watermark in `data/auth-state.json` — a captured cookie dies on logout),
S4 (HSTS follows the Secure-cookie predicate, so local-TLS deployments get it), S5
(`secretBox.open` rejects non-16-byte GCM tags), S6 (`set-password` masks the interactive
prompt and warns on the argv form), S7 (the changed-host-key regex no longer matches jump-host
failures). Efficiency: E2 (NetBox client resolves TLS once per instance), E4 (health events
save once per poll pass), E5 (`refresh()` keeps caches — no gray-dot flash), E6
(`forgetBox` clears backoff/cpu maps on removal), E7 (batch import: one read, one write), E8
(git bootstrap only when a framework needs it), E9 (default-key provider caches the promise).
Suite: 870/870 (24 new tests); full e2e green except the two known zsh-shell assertions.

**Status note, 2026-07-18 (batch 3, v1.7.6):** the job-manager cluster shipped, test-first —
B6 (starting a new setup for a box flips a stale `needs-interactive` job to a terminal
`superseded` status, so parked jobs stop accumulating), B7 (a per-job cancellation flag makes
`cancelForBox` effective during the `waiting-ssh` phase — the install script can no longer run
against a just-deleted box), E1 (streaming setup output coalesces persistence on a 250 ms /
8 KB threshold instead of one full-history save per chunk — was ~104 saves for 100 chunks,
now ~4), B13 (fleet prune skips running jobs), E3 (the provision manager prunes terminal jobs
from memory like the lifecycle manager, never dropping an active job's record; both managers
also drop `settles` entries with the job), and C9 (a shared `jobOrder.js` `newestFirst`
comparator with an id tie-break replaces the invalid-total-order inline sorts in all three
managers). Suite: 846/846 (9 new tests); setup + fleet e2e green.

**Status note, 2026-07-18 (batch 2, v1.7.5):** the web cluster shipped, test-first — B9
(fleet job-detail polling moved into a generation-guarded `fleetPoll.ts`, so a stale response
for a previously selected job can neither paint over nor stop the newer selection's polling),
B10 (the fleet script editor's ⌘/Ctrl+Enter run binding is `Prec.high`, out from under
defaultKeymap's insertBlankLine — verified by a new Playwright test that failed against the old
bundle), B11 (both setup-job viewers route their "Finish interactively" terminal through a new
`interactiveLauncher.ts`, refusing concurrent sessions and disabling the button while one is
live), and B12 (body-mounted modals — the Proxmox hub and settings — register with a new
`modalRegistry.ts` that logout/session-expiry teardown closes). Suite: 837/837 unit tests
(11 new); fleet e2e 4/4 including the new shortcut test; full e2e 10 passed with only the two
known pre-existing zsh-root-shell failures.

**Status note, 2026-07-18 (batch 1, v1.7.4):** the "silent-failure killers" batch shipped,
test-first — B1 (boot failures now exit 1; the keep-alive exception handlers are registered
only after `app.listen` succeeds), B2 (`config.json` is written atomically via
`writeFileAtomicSync`), B3 (the attach resize jiggle captures and restores the original
width), B5 (malformed `setup-jobs.json` rows are dropped on load instead of crashing boot),
B8 (a new `shutdown.js` flushes all four debounced job stores on SIGTERM/SIGINT — which also
closes D2, since `whenIdle()` now has a production caller), B18 (`tmux kill-session` uses the
exact-match `=local` target), S1 (`knownHosts.forget` on a nonstandard-port box now removes
only the bracketed `[host]:port` entry, never the bare-host entry), and S2 (`.agents/`,
`graphify-out/`, and `skills-lock.json` are gitignored). Suite: 826/826 across 77 files
(7 new tests).

---

## Findings and fix tracking

Severity reflects likelihood × blast radius for this single-user tool, not CVSS. Effort is a
rough fix-size guess: **S** = under an hour, **M** = a few hours. Every finding has a detailed
explanation in the sections that follow the tables.

### Bugs

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| B1 | boot | A fatal error during startup makes the process exit with code 0, so systemd (`Restart=on-failure`) never restarts the service | Med | S | Exit 1 from the `uncaughtException` handler, or register the keep-alive handlers only after `app.listen` succeeds | ✅ v1.7.4 |
| B2 | config | `config.json` is written in place (not atomically), so a crash mid-write leaves invalid JSON that prevents every subsequent boot | Med | S | Use the existing `writeFileAtomicSync` from `jsonFile.js` | ✅ v1.7.4 |
| B3 | sessions | The attach-time "resize jiggle" never restores the original width, so provision/setup PTYs shrink by one column per reattach | Med | S | Save the original column count before the jiggle and restore that saved value | ✅ v1.7.4 |
| B4 | store | All `boxes.json` mutations are unserialized read-modify-write cycles, so two concurrent changes silently lose one of them | Med | S | Serialize mutations through a per-store promise queue | ✅ v1.7.8 |
| B5 | setup | A malformed row (for example `null`) in `data/setup-jobs.json` crashes the server at boot | Med | S | Filter loaded rows through a shape check, as `fleet.js` already does | ✅ v1.7.4 |
| B6 | setup | Setup jobs stuck in `needs-interactive` are never superseded or pruned, so they accumulate forever (each carrying up to 64 KB of log) | Med | S | When a new setup job starts for a box, mark older non-running jobs for that box with a terminal `superseded` status | ✅ v1.7.6 |
| B7 | setup | Cancelling a setup job during its `waiting-ssh` phase does nothing, so the install script still runs against a box the user just deleted | Med | S | Add a per-job cancellation flag that the wait loop checks before each probe and before launching ssh | ✅ v1.7.6 |
| B8 | stores | Nothing flushes the debounced job stores on shutdown, so a deploy restart can lose the final save and completed jobs reload as `interrupted` | Med | S | Add a SIGTERM/SIGINT handler that awaits every store's `whenIdle()` before exiting | ✅ v1.7.4 |
| B9 | web | A stale poll response for a finished fleet job can silently stop the polling of a newer job the user has switched to | Med | S | Guard the finished-job branch (and the initial render) with a check that the response still belongs to the selected job | ✅ v1.7.5 |
| B10 | web | The advertised ⌘/Ctrl+Enter "run" shortcut in the fleet script editor never fires — CodeMirror's default keymap intercepts it and inserts a blank line | Med | S | Register the run keybinding ahead of the default keymap (or wrap it in `Prec.high`) | ✅ v1.7.5 |
| B11 | web | Clicking "Finish interactively" more than once opens multiple concurrent setup terminals against the same box and leaks all but the last | Med | S | Disable the button after the first click, and dispose the previous terminal handle before creating a new one | ✅ v1.7.5 |
| B12 | web | Logout / session-expiry teardown misses modals mounted on `document.body`, so an open Proxmox hub stays on top of the login screen, polling forever | Med | S | Give body-mounted modals a registered close hook that the teardown path invokes | ✅ v1.7.5 |
| B13 | fleet | Job history pruning can evict a fleet job that is still running, making it invisible and uncancellable (old L3) | Low | S | Skip `running` jobs when pruning, mirroring the setup manager's retention policy | ✅ v1.7.6 |
| B14 | boxes | The background cleanup after removing a box can tear down the SSH ControlMaster of an identical box the user re-added moments later | Low | S | Before tearing down the master, re-check the store for a box with the same host/user/port and skip if one exists | ✅ v1.7.7 |
| B15 | ssh | SSH output is decoded chunk-by-chunk, so a multi-byte UTF-8 character split across two chunks becomes a � in the setup log | Low | S | Decode each stream with a `string_decoder.StringDecoder` instead of per-chunk `toString` | ✅ v1.7.7 |
| B16 | web | A momentary Proxmox API failure (state `unknown`) is misread as "container restarted": the stopped-box panel closes and the selection is lost | Low | S | Only treat an affirmative `running` state as a restart; keep the panel open on `unknown` | ✅ v1.7.7 |
| B17 | netbox | Errors while reading or decrypting NetBox settings are reported as "NetBox is not configured", hiding the real problem | Low | S | Distinguish "no settings stored" from a read/decrypt error and surface the error message | ✅ v1.7.7 |
| B18 | server | `tmux kill-session -t local` uses tmux's prefix matching, so it can kill an unrelated session such as `local-dev` on the Tmuxifier host | Low | S | Use tmux's exact-match form: `-t =local` | ✅ v1.7.4 |
| B19 | auth | The Google OAuth token exchange has no timeout, so a hung Google endpoint pins the login callback forever (old L12) | Low | S | Pass `signal: AbortSignal.timeout(10000)` and route the abort into the existing error path | ✅ v1.7.7 |
| B20 | config | An inline comment in `.env` (`TMUXIFIER_PORT=8080 # dashboard`) becomes part of the value, and numeric settings then silently fall back to defaults | Low | S | Strip unquoted ` #…` suffixes when parsing, matching dotenv behavior | ✅ v1.7.7 |
| B21 | fleet | An SSH timeout during a fleet run is reported as `exited 1`, indistinguishable from a real exit code 1 (old L2) | Low | S | Detect the killed/timeout case in `sshRun` and report it as `timed out` | ✅ v1.7.7 |
| B22 | fleet | Passing the same box id twice to a fleet job runs the command twice on that box (old L4) | Low | S | De-duplicate the box id list when creating the job | ✅ v1.7.7 |
| B23 | store | A box's label can never be cleared once set — `updateBox` ignores an explicit empty value (old L11) | Low | S | Treat an explicit empty/null label as "clear it", like the existing user/port/proxyJump clearing | ✅ v1.7.7 |
| B24 | proxmox | Requesting the template list without a `?storage` parameter builds the URL `/storage/undefined/content` and returns a confusing 502 (old L14) | Low | S | Validate the parameter and return a 400 when it is missing | ✅ v1.7.7 |
| B25 | web | The health-events formatter has no default case, so a single unknown event type from a newer server breaks the whole events panel (old L15) | Low | S | Add a default branch that renders a generic event line | ✅ v1.7.7 |

### Safety and security

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| S1 | known_hosts | Forgetting the host key of a box on a nonstandard port also deletes the bare-hostname entry — which belongs to whatever machine answers port 22 at that address | Med | S | When the port is nonstandard, remove only the `[host]:port` entry | ✅ v1.7.4 |
| S2 | repo | `.agents/`, `graphify-out/`, and `skills-lock.json` are untracked and not gitignored; the release checklist stages with `git add -A`, so the next release would commit them to the public repository | Med | S | Add all three to `.gitignore` | ✅ v1.7.4 |
| S3 | auth | Logging out only clears the browser cookie — a captured session cookie remains valid for up to 7 days afterward | Low | S | Keep a server-side "sessions issued before X are invalid" watermark that logout advances, or document logout as client-side only | ✅ v1.7.7 |
| S4 | server | The HSTS header is only sent when an external HTTPS URL is configured, so the documented local-TLS deployment never gets it | Low | S | Send HSTS under the same condition that marks the cookie `Secure` (local TLS counts) | ✅ v1.7.7 |
| S5 | secrets | `secretBox.open` accepts truncated GCM authentication tags, weakening forgery resistance (old L13) | Low | S | Pass `{ authTagLength: 16 }` to `createDecipheriv`, or reject tags that are not 16 bytes | ✅ v1.7.7 |
| S6 | scripts | `set-password` still accepts the password as a command-line argument (visible in shell history and `ps`) and echoes it when prompted interactively (old L23) | Low | S | Mask the interactive input and deprecate the argument form | ✅ v1.7.7 |
| S7 | status | The changed-host-key detector also matches jump-host key failures, so the ⚷ "forget key" button can appear for the wrong host on proxyJump boxes (known deferred item from v1.7.1) | Low | S | Drop the over-broad pattern alternation, or add a tooltip caveat | ✅ v1.7.7 |

### Efficiency

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| E1 | setup | The setup manager persists the entire job history to disk on every chunk of SSH output — a chatty install produces thousands of multi-megabyte serializations | Med | S | Coalesce log persistence on a timer or byte threshold; keep immediate persistence for status changes | ✅ v1.7.6 |
| E2 | netbox | In fingerprint-pinning mode, every NetBox API call performs an extra full TLS handshake just to re-probe the certificate | Med | S | Cache the resolved TLS options per client, as the Proxmox client already does | ✅ v1.7.7 |
| E3 | provision | The provision manager's in-memory job map is never pruned, and the on-disk cap can even drop a still-running job's record | Med | S | Adopt the lifecycle manager's terminal-only pruning, and clean up the companion `settles` map | ✅ v1.7.6 |
| E4 | health | Each health event is written to disk with its own synchronous full-file write — a 30-box outage performs 30 back-to-back writes in one poll pass | Low | S | Collect events during the pass and save once at the end | ✅ v1.7.7 |
| E5 | web | Every dashboard refresh wipes the cached status data before repainting, flashing every status dot gray and issuing duplicate status fetches (old L17) | Low | S | Keep the previous caches until the fresh responses arrive, then paint once | ✅ v1.7.7 |
| E6 | status | The status checker's backoff and CPU-tracking maps keep entries for removed boxes forever | Low | S | Add a `forgetBox(id)` cleanup call invoked from box removal | ✅ v1.7.7 |
| E7 | store | Importing N boxes performs N separate full read-and-rewrite cycles of `boxes.json` | Low | S | Add a batch import path: read once, validate all entries in memory, write once | ✅ v1.7.7 |
| E8 | boxActions | The setup script installs git unconditionally, even when nothing the user selected needs it | Low | S | Only include the git bootstrap when oh-my-tmux, oh-my-zsh, or the git tool was selected | ✅ v1.7.7 |
| E9 | index | The default-public-key helper caches the resolved value rather than the promise, so concurrent first calls each spawn their own `ssh-keygen` | Low | S | Cache the promise instead, resetting it if the read fails or returns nothing | ✅ v1.7.7 |

### Complexity and duplication

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| C1 | stores | Four store modules (`fleetStore`, `setupStore`, `provisionStore`, `proxmoxLifecycleStore`) are byte-for-byte copies of each other | Med | M | Extract a shared `createDebouncedJsonStore({ dataDir, filename })` factory; each store becomes a one-line wrapper | ✅ v1.7.8 |
| C2 | web | The modal scaffold (backdrop, click guard, Escape handling, teardown) is copy-pasted eight times and has already drifted — two copies lack Escape handling; `makeRadio` is duplicated too | Med | M | Add an `openModal({ onClose })` helper to `dom.ts` and migrate the eight call sites | Open |
| C3 | web | Two parallel setup-job viewers (the provision panel and the Proxmox hub) re-implement the same poll/render/interactive-fallback state machine | Low | M | Extract one shared setup-job viewer module used by both | Open |
| C4 | proxmox | The PVE task-polling loop and job-manager scaffolding are duplicated between the provision and lifecycle managers | Low | M | Extract a shared `pollPveTask` helper | ✅ v1.7.8 |
| C5 | tls | The pinned-connection wiring is duplicated verbatim between the Proxmox and NetBox HTTP clients | Low | S | Export a `pinnedConnectionFactory` helper from `tlsPin.js` and use it in both | ✅ v1.7.8 |
| C6 | proxmox | `proxmoxApi.js` re-implements endpoint host/port parsing twice instead of reusing the existing `parseEndpoint` | Low | S | Import and reuse `parseEndpoint` from `proxmoxValidate.js` | ✅ v1.7.8 |
| C7 | config | The six health-setting clamps hardcode fallback numbers that duplicate values already defined in `DEFAULTS` | Low | S | Reference `DEFAULTS.*` instead of repeating the literals | ✅ v1.7.8 |
| C8 | local | The local-shell setup script hardcodes the tmux session name `local` while a configurable `localSession` parameter exists elsewhere — the two can silently disagree | Low | S | Thread the session name through, or remove the parameter and commit to the constant | ✅ v1.7.8 |
| C9 | setup | The job-ordering comparator returns −1 for equal timestamps (not a valid total order); the provision manager has the same flaw | Low | S | Use a shared comparator that tie-breaks by job id | ✅ v1.7.6 |

### Dead code

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| D1 | server | The `/api/status` fallback branch for a missing status poller is unreachable in production — `index.js` always provides one | Low | S | Make the poller a required dependency, stub it in tests, and delete the branch | ✅ v1.7.8 |
| D2 | stores | `whenIdle()` exists in all four job stores but is only ever called by tests | Low | S | Wire it into the B8 shutdown flush rather than deleting it | ✅ v1.7.4 |
| D3 | jsonFile | The module's comment claims power-loss safety, but the write path never calls fsync, so that claim doesn't hold | Low | S | fsync the temp file (and optionally the directory) before renaming, or soften the comment to "process crash" | ✅ v1.7.8 |

### Notes and housekeeping

| ID | Area | Finding | Severity | Effort | Proposed fix | Status |
|----|------|---------|----------|--------|--------------|--------|
| N1 | web | The interactive terminal's WebSocket URL doesn't URL-encode the box id, while the provision path does — inconsistent, though harmless today | Info | S | Apply `encodeURIComponent` for consistency | ✅ v1.7.8 |
| N2 | e2e | Two pre-existing end-to-end test failures (zsh root shell), noted in the internal ledger, remain unfixed | Info | — | Fix separately; unrelated to any finding here | ✅ v1.7.8 |
| N3 | repo | Roughly 180 `review-*.diff` scratch files have accumulated in `.superpowers/sdd/` (gitignored, but heavy clutter) | Info | S | Delete or archive them | ✅ v1.7.8 |
| N4 | repo | The working-tree `CLAUDE.md` gained a graphify section; it is a tracked file, so it will be published on the next release | Info | — | User decision: keep it public, or move the rule into the gitignored `.claude/` config | ✅ 2026-07-18 (moved to gitignored `CLAUDE.local.md`) |

Items from the 2026-07-04 review that were re-verified as **fixed** in the meantime: L6 (the
CPU-threshold seeding gap), plus everything already marked fixed in that document. The
`proxmoxUi` `_opt` dead parameter from the internal ledger has also already been cleaned up.

---

## Detailed findings — bugs

### B1 — A fatal boot error exits with code 0, so systemd never restarts the service

`src/server/index.js:35-36` registers blanket `uncaughtException` and `unhandledRejection`
handlers that log the error and let the process continue. They are registered *before*
configuration is loaded and the server is built. If anything throws during startup — a corrupt
`config.json`, an unreadable TLS certificate path — the error is logged and the process then
simply runs out of work and exits with code **0**. The systemd unit uses `Restart=on-failure`,
which treats exit 0 as a deliberate stop, so the service stays down until someone notices.
This was verified empirically with a repro script. Note the inconsistency: the explicit
missing-config check a few lines later correctly calls `process.exit(1)`, so only *some* boot
failures signal failure.

**Fix:** call `process.exit(1)` from the `uncaughtException` handler, or (cleaner) register
the keep-the-server-alive handlers only after `app.listen` succeeds, so that anything thrown
during boot crashes the process with a nonzero code as Node normally would.

### B2 — `config.json` is written in place, so a torn write bricks every subsequent boot

`src/server/configFile.js:30-31` writes `config.json` with a plain `fs.writeFileSync` — no
temp-file-and-rename step. This file is written at runtime by `PATCH /api/local-shell`. If the
process crashes or the machine loses power mid-write, the file is left as truncated, invalid
JSON. On the next boot, `readConfigFile` deliberately throws on invalid JSON (by design, so a
broken file is never silently overwritten), `loadConfig` calls it unguarded — and combined
with B1, the service then dies silently with exit code 0 on **every** start until someone
repairs the file by hand. The repository already contains exactly the right tool:
`writeFileAtomicSync` in `jsonFile.js`.

**Fix:** use `writeFileAtomicSync` in `upsertConfigFile`. (This also gives that export a
production caller — it is currently only used internally.)

### B3 — The attach-time "resize jiggle" never restores the original terminal width

When a client attaches to an existing PTY, `src/server/sessions.js:119-121` nudges the PTY one
column narrower and then "back" to force a repaint:

```js
entry.pty.resize(entry.pty.cols === 1 ? 2 : entry.pty.cols - 1, entry.pty.rows);
entry.pty.resize(entry.pty.cols, entry.pty.rows);
```

The bug: node-pty's `resize()` mutates its stored column count, and the `cols` getter returns
that stored value. So by the time the second line runs, `entry.pty.cols` is already the
*shrunken* value — the second call resizes to the same width and the PTY stays one column
narrower. Interactive terminals mask this because the browser immediately sends its own resize
message after connecting. But provision/setup terminals never send resize (the server ignores
resize frames in provision mode), so the fixed 120-column provision PTY actually runs at 119 —
and every reconnection shrinks it by one more column.

**Fix:** capture the width first (`const c = entry.pty.cols`), then jiggle, then restore to
the captured value.

### B4 — Concurrent `boxes.json` mutations silently lose writes

Every mutator in `src/server/store.js` (add, update, remove, import) follows the same pattern:
`await readAll()`, modify the array in memory, `await writeAll(boxes)` — with no lock or queue
around the sequence. The atomic-rename layer underneath makes each individual *write* safe,
but not the read-modify-write *cycle*. This is not hypothetical: a background provision job
calls `addBox` when a container finishes provisioning, while the user may simultaneously be
editing another box in the UI. Both read the same array; whichever writes second erases the
other's change.

**Fix:** serialize mutations through a per-store promise chain (`queue = queue.then(op)`) —
a small change that the factory structure makes easy.

### B5 — A malformed row in `setup-jobs.json` crashes the server at boot

`src/server/setupManager.js:36-39` iterates the loaded job list and immediately dereferences
`j.status` on each row. The persistence layer's validation only checks that the file contains
*an array* — so a file containing `[null]` (valid JSON, is an array) passes validation and
then throws a `TypeError` inside `createSetupManager()`, which runs during startup in
`index.js`. The server cannot boot until the file is repaired by hand. The fleet manager had
this exact bug fixed earlier (its comment reads "one bad history row must never keep the
server from booting", and there is a test for it) — the setup manager, which mirrors the fleet
manager's design, never got the same guard.

**Fix:** filter loaded rows through the same shape check the fleet manager uses (drop
non-object rows and rows without a string id).

### B6 — `needs-interactive` setup jobs accumulate forever

A setup job that hits the sudo-password wall is parked in the `needs-interactive` status,
which is deliberately not a terminal status (the user can still finish it interactively). The
problem is the combination of three facts in `src/server/setupManager.js`: (1) `start()` only
refuses to create a new job while an existing one is `running`, so Retry happily creates a new
job alongside a parked one; (2) the retention policy keeps every non-terminal job forever;
(3) `markInteractiveResult` only ever resolves the *newest* job for a box. So each Retry that
lands back in the sudo-password path strands one more `needs-interactive` job — in memory, in
`data/setup-jobs.json`, and in the jobs list the UI shows — each carrying up to 64 KB of log,
with no path that ever cleans them up.

**Fix:** when `start()` creates a new job for a box, flip any older non-running job for that
box to a terminal status such as `superseded`, which makes it eligible for normal history
pruning.

### B7 — Cancelling a setup job during `waiting-ssh` does nothing

`cancelForBox` in `src/server/setupManager.js:149-152` works by killing the job's registered
ssh handle — but the handle is only registered *after* the readiness-probe loop completes.
Jobs started by the provisioner use `waitForSsh: true`, which probes the box for up to ~90
seconds before launching the script. If the user deletes the box during that window (the
delete route does call `cancelForBox`), nothing is cancelled: the loop keeps probing, and the
full install script is then streamed into a box that no longer exists in Tmuxifier.

**Fix:** add a per-job `cancelled` flag that `cancelForBox` sets and that `run()` checks
between probe attempts and once more before launching ssh, finishing the job as an error
instead.

### B8 — Nothing flushes the debounced stores on shutdown

The four job stores (fleet, setup, provision, lifecycle) debounce their disk writes, and each
exposes a `whenIdle()` method that resolves when pending writes have landed — but nothing in
production ever calls it, and `index.js` registers no SIGTERM/SIGINT handler at all. The
documented deploy step is `systemctl restart tmuxifier`: if a job finishes just before the
restart, its final debounced save can be lost. On the next boot the stale file still says
`running`, and the reconciliation logic dutifully flips a job that actually *completed* to
`interrupted`. This matches a known recurring annoyance ("deploy restart interrupts setup
jobs") that until now looked like an unavoidable property of restarts — it is actually just a
missing flush.

**Fix:** add a SIGTERM/SIGINT handler that awaits every store's `whenIdle()` before exiting.
This also resolves most of finding D2 (the "dead" `whenIdle` export).

### B9 — A stale fleet-job poll response can freeze the newly selected job's view

The fleet-job detail view polls every 1.5 seconds. In `src/web/main.ts:1756-1763`, the poll
callback correctly checks "is this response still for the job the user is viewing?" before
re-rendering — but only on the still-running branch. The finished-job branch
(`stopFleetPoll(); renderFleetHistory()`) runs unconditionally. Sequence: the user is viewing
running job A; its poll request is in flight; the user clicks job B, which starts B's polling;
A's response then arrives reporting A finished — and the unguarded branch stops *B's* polling.
B's detail view silently freezes at whatever it first rendered. A second, related gap: the
initial render in `showFleetJob` also lacks the guard, so of two quick clicks, the slower
response can paint over the user's newer selection.

**Fix:** apply the same "is this still the selected job?" guard to the finished branch and to
the initial render.

### B10 — The fleet editor's ⌘/Ctrl+Enter shortcut inserts a blank line instead of running

The fleet command modal advertises "⌘/Ctrl+Enter to run". In CodeMirror 6, whichever keymap is
registered *earlier* wins, and `src/web/fleetEditor.ts:145-146` registers the bundled
`defaultKeymap` before the custom run keymap. `defaultKeymap` binds Mod-Enter to
`insertBlankLine` (verified in the installed package), and that handler always claims the key.
The document-level fallback handler in `main.ts` explicitly defers while focus is inside the
editor — which is exactly where focus normally is. Net effect: the advertised shortcut has
never worked from inside the editor; it just inserts a newline.

**Fix:** register the run keymap ahead of the default keymap, or wrap it in `Prec.high`.

### B11 — Clicking "Finish interactively" repeatedly opens concurrent setup terminals

When a setup job needs the user's sudo password, the UI offers a "Finish interactively"
button that opens a terminal running the setup script. In `src/web/main.ts:1030-1045` (and the
same pattern in `proxmoxUi.ts:166-170`), each click creates a fresh terminal and overwrites
the variable holding the previous one without disposing it — and the button is never disabled;
the 2.5-second status poll even keeps re-rendering it. Every extra click therefore launches
another concurrent run of the setup script on the same box (two simultaneous apt runs, for
example), and the earlier WebSocket terminals leak until their scripts exit.

**Fix:** disable or remove the button once clicked, and dispose the previous terminal handle
before assigning a new one.

### B12 — Logout/session-expiry teardown misses modals mounted on `document.body`

The central "session expired" handler (`src/web/main.ts:1821-1831`) closes the terminal tabs
and the three fixed side panels, then re-renders the login screen into `#app`. But the Proxmox
hub and the settings modal are appended to `document.body`, not `#app`, so they survive the
teardown and sit on top of the login form. Worse, the hub's job-polling loop keeps retrying
its (now 401-failing) fetch every 1.5 seconds indefinitely — the Proxmox fetch layer has no
401 hook, and nothing bumps the poll generation counter that would stop it.

**Fix:** give body-mounted modals a registered close hook (the provision panel already has
this pattern) and invoke it from the logout and session-expiry paths.

### B13 — Fleet job pruning can evict a job that is still running (old L3)

`prune()` in `src/server/fleet.js:57-63` evicts strictly the oldest jobs whenever the list
exceeds `maxJobs` (default 50), with no regard for status. Creating the 51st job while job #1
is still running shifts it out of the list: its runner keeps executing against boxes, but the
job is now invisible to `GET /api/fleet/jobs/:id`, absent from history, and uncancellable. The
setup manager's retention policy explicitly documents and avoids this exact hazard; the fleet
manager predates that policy.

**Fix:** make `prune()` skip `running` jobs, capping terminal history only.

### B14 — Post-removal cleanup can kill the ControlMaster of a re-added box

Removing a box triggers a fire-and-forget background cleanup (`src/server/boxRemoval.js:13-20`)
that can take up to ~18 seconds (a 12-second kill-session timeout plus a 6-second master-exit
timeout), and ends by unconditionally deleting the ControlMaster socket. The socket path is
derived only from host/user/port. So if the user removes a box and quickly re-adds the same
machine (a common "start over" flow), the stale cleanup can tear down the *new* box's freshly
authenticated master — flipping it back to needs-auth for no visible reason.

**Fix:** before the master teardown, re-check the store for a box with the same
host/user/port and skip the teardown if one exists.

### B15 — Split UTF-8 characters are garbled in captured SSH output

Both output paths in `src/server/sshRun.js` (`sshRunStdin` at lines 34-35, `sshStream` at
68-69) convert each incoming Buffer chunk to a string independently. A multi-byte UTF-8
character that straddles a chunk boundary — easy to hit with the progress bars and box-drawing
characters installers print — decodes as replacement characters (�) in the persisted setup
log.

**Fix:** decode each stream through a `string_decoder.StringDecoder`, which holds partial
sequences across chunks.

### B16 — A transient Proxmox blip closes the stopped-box panel

When the selected box is a stopped container, the dashboard shows a "stopped box" panel. The
poll reconciliation in `src/web/main.ts:363-379` removes that panel and clears the selection
whenever the box's state is anything other than `stopped` — but the status layer's own
documentation says the `unknown` state means "the Proxmox read failed or is stale and must
never grant display authority". A single failed PVE poll therefore looks like "the container
started", the panel closes, the selection is cleared, and nothing restores it when the next
poll says `stopped` again.

**Fix:** only treat an affirmative `running` state as a restart; keep the panel as-is on
`unknown`.

### B17 — NetBox read/decrypt errors masquerade as "not configured"

`requireNetboxSettings` (`src/server/proxmoxProvision.js:37-42`, same pattern in
`proxmoxLifecycle.js`) wraps the settings read in a catch-all that maps *any* failure to "the
NetBox integration is not configured". But the read can fail for real reasons — the encrypted
token can't be decrypted because the cookie secret rotated, or the file is unreadable. The
user is then told to configure an integration that is already configured, and during
deprovisioning the same pattern hides the fact that an allocated IP was *not* released.

**Fix:** distinguish "no settings stored" (a null return) from a thrown error, and surface
the error's message.

### B18 — `tmux kill-session -t local` can kill the wrong session

tmux's `-t` target resolution falls back to *prefix* matching when there is no exact match.
`killTmuxSession` in `src/server/server.js:57-59` targets `local`; if the Tmuxifier host has
no session named exactly `local` (say the local terminal was never opened) but the operator
has their own session named `local-dev`, the reconnect endpoint kills it. The exact-match
syntax exists precisely for this.

**Fix:** use `tmux kill-session -t =local` (the `=` prefix forces an exact match).

### B19 — The Google token exchange can hang the login callback forever (old L12)

`src/server/googleAuth.js:55-59` calls `fetch` against Google's token endpoint with no
`AbortSignal`, and Node's `fetch` has no default timeout. If the endpoint stalls or egress is
black-holed, the OAuth callback request simply never completes.

**Fix:** pass `signal: AbortSignal.timeout(10000)` and let the abort flow into the existing
catch, which already redirects to `/?error=google`.

### B20 — Inline `#` comments in `.env` corrupt the value silently

`parseEnvFile` (`src/server/envFile.js`) captures everything after `=` to the end of the line,
so `TMUXIFIER_PORT=8080 # dashboard` produces the value `"8080 # dashboard"`. For numeric
settings, the clamp layer then quietly falls back to the default (port 7437) with no warning —
the user set 8080 and got 7437 with nothing in the logs. Non-numeric settings would carry the
comment text into actual use.

**Fix:** strip an unquoted ` #…` suffix during parsing (dotenv-compatible behavior), or
explicitly document that inline comments are unsupported.

### B21 — SSH timeouts in fleet runs are reported as "exited 1" (old L2)

`sshRun` collapses every non-numeric error code to 1, including the killed-by-timeout case.
Fleet job results then show `exited 1` for a box that actually timed out — indistinguishable
from a command that genuinely failed with exit code 1, which sends the user debugging the
wrong thing.

**Fix:** detect the timeout/killed case (`err.killed` / `err.signal`) in `sshRun` and surface
it as `timed out` in the fleet target status.

### B22 — Duplicate box ids in a fleet job run the command twice (old L4)

Neither the fleet route nor `createJob` de-duplicates the incoming `boxIds` array, so a
duplicated id runs the command twice on the same box and shows two target rows for it.

**Fix:** de-duplicate the id list in `createJob`.

### B23 — A box label can never be cleared (old L11)

`updateBox` computes `label: spec.label || base.label || spec.host`, so an explicit empty
string or null keeps the old label. The explicit null-clearing loop a few lines down covers
user/port/proxyJump but not label.

**Fix:** include label in the explicit clearing logic.

### B24 — Missing `?storage` parameter produces a confusing 502 (old L14)

The templates route builds the PVE path with `req.query.storage` unvalidated; omitting the
parameter yields `/storage/undefined/content` and a 502 from PVE, instead of a clear 400 from
Tmuxifier.

**Fix:** validate the parameter and return 400 when missing.

### B25 — One unknown health-event type breaks the whole events panel (old L15)

`formatEvent` in `src/web/healthEvents.ts` is an exhaustive switch over the event kinds known
*at compile time*, with no default case — it returns `undefined` for anything else, and the
panel renderer then dereferences the result. TypeScript can't protect this boundary: the
events come from the server, so a newer server (with a new event kind, as happened when
`key-changed` was added) against a cached older client breaks the entire timeline render.

**Fix:** add a default branch returning a generic line (icon, event name, neutral level).

---

## Detailed findings — safety and security

### S1 — Forgetting a nonstandard-port host key deletes a different machine's key

OpenSSH stores host keys for nonstandard ports under the bracketed form `[host]:2222`; the
bare `host` entry belongs to whatever answers on port 22 at that address. `forget(host, port)`
in `src/server/knownHosts.js:26-28` always removes the bare-host entry and *additionally*
removes the bracketed one for nonstandard ports. In exactly the setups where nonstandard ports
occur — one routable IP with containers behind port forwards — deprovisioning the container on
port 2222 therefore erases the trusted key of the unrelated machine on port 22. This violates
the project's own carefully stated rule that a known_hosts entry is removed only when *that
specific identity* is provably gone.

**Fix:** when the port is nonstandard, remove only the `[host]:port` entry; remove the bare
entry only for port 22 (or no port).

### S2 — Untracked local artifacts will be committed to the public repo by the release flow

Three machine-local artifacts sit in the working tree untracked and **not** gitignored:
`.agents/`, `graphify-out/` (a generated knowledge-graph cache including cost data), and
`skills-lock.json`. The release checklist in CLAUDE.md stages with `git add -A` — so the next
routine release would publish all of them to the public GitHub repository. There is a manual
"review the staged diff" step, but relying on a human catch for known machine-local files is
fragile.

**Fix:** add all three to `.gitignore` now. Related user decision (N4): the tracked
`CLAUDE.md` has gained a graphify section in the working tree; decide whether that should ship
publicly or live in the gitignored `.claude/` config instead.

### S3 — Logout does not invalidate the session server-side

The session cookie is stateless (a signed value embedding its issue time), and `POST
/api/logout` only clears the cookie in the browser. Within the threat model the code itself
documents (a captured cookie), logout therefore gives false assurance: a copied cookie keeps
working until its 7-day TTL expires or the cookie secret is manually rotated.

**Fix:** persist a small "sessions issued before X are invalid" watermark that logout
advances, and check it during validation — or explicitly document logout as client-side only.

### S4 — HSTS is missing exactly in the recommended local-TLS deployment

The HSTS header is sent only when the configured external URL starts with `https://`. The
Secure-cookie decision uses a broader condition: external HTTPS *or* local TLS certificates
configured. A deployment serving TLS directly (the documented self-hosted mode) without an
external URL set gets Secure cookies but never HSTS — missing first-visit downgrade
protection in the exact case the header exists for.

**Fix:** send HSTS under the same condition as the Secure cookie flag.

### S5 — Truncated GCM authentication tags are accepted (old L13)

`secretBox.open` sets the auth tag without specifying `authTagLength` and without checking its
length, so a tag truncated to 4 bytes still decrypts. That reduces forgery resistance from
2⁻¹²⁸ to 2⁻³² per attempt. It only matters to an attacker who can already write the data
files, so the practical risk is low — but the fix is one line.

**Fix:** pass `{ authTagLength: 16 }` to `createDecipheriv` (or reject tags ≠ 16 bytes).

### S6 — `set-password` exposes the password in argv and echoes it (old L23)

`scripts/hash-password.js` still accepts the new password as a command-line argument — which
lands in shell history and is visible in `ps` — and the interactive fallback uses a plain
readline prompt that echoes the password to the terminal.

**Fix:** mask the interactive input and deprecate the argument form.

### S7 — The changed-host-key detector over-matches jump-host failures (known deferred)

The regex that classifies "host key changed" also matches the generic "host key verification
failed" message, which appears when a *jump host's* key fails — so the ⚷ forget-key button can
show up for a proxyJump box whose own key is fine. The action is consent-gated and confirmed,
so harm is low, but the button points at the wrong host. This was a documented deferred item
from the v1.7.1 work.

**Fix:** drop the over-broad alternation, or add a tooltip caveat for proxyJump boxes.

---

## Detailed findings — efficiency

### E1 — The setup manager rewrites its entire history on every chunk of SSH output

In `src/server/setupManager.js`, the streaming `onData` callback appends the chunk to the
job's log and then calls `persist()` — which sorts the full job list and hands it to the
store, whose `save` eagerly `JSON.stringify`s *everything* (up to 50 retained jobs × 64 KB of
log ≈ multiple megabytes) on every call. An apt upgrade emitting thousands of output chunks
therefore causes thousands of multi-megabyte serializations and near-continuous full-file
atomic writes for the duration of the install. The debounce in the store only coalesces
concurrent *disk* writes; the serialization cost is paid every time.

**Fix:** while a job is streaming, persist the log on a timer or byte threshold (say, at most
every 250 ms or 8 KB), keeping immediate persistence for status and phase transitions.

### E2 — NetBox pin mode performs a redundant TLS handshake per API call

`createNetboxClient.call()` re-resolves its TLS options on every request, and in
fingerprint-pinning mode that resolution unconditionally runs a full probe handshake — even
though the pinned request that follows *already* verifies the fingerprint on its own
connection (which is the actual security boundary). Every NetBox call thus costs two
handshakes; an auto-static IP allocation (three API calls) costs six. The Proxmox client
solved this identically-shaped problem already by caching the resolved TLS options per client
instance.

**Fix:** cache the resolved TLS options per client, or skip the probe entirely when a
fingerprint is already pinned.

### E3 — Provision jobs are never pruned from memory

The provision manager caps what it writes to disk (`save(ordered().slice(0, maxJobs))`) but
never deletes anything from its in-memory `jobs` and `settles` Maps — every provision job ever
run stays resident, log and all, for the life of the process. Two knock-on effects: the jobs
list the UI shows diverges from what survives a restart, and the naive disk slice is by
creation date, so it can even drop a *still-running* job's record from the file. The lifecycle
manager next door already has the correct terminal-only `prune()`; it just never made it back
into the provision manager. (The lifecycle manager has its own smaller leak: it prunes `jobs`
but not its `settles` map.)

**Fix:** port the lifecycle manager's terminal-only pruning to the provision manager, and
delete `settles` entries alongside pruned jobs in both.

### E4 — Health events are written to disk one at a time, synchronously

Each health event emission does its own synchronous full-file write of the events log. Events
are emitted inside the per-box loop of a single poll pass — so an outage that downs 30 boxes
performs 30 back-to-back synchronous write-and-rename cycles of the same file, on the event
loop, in one pass.

**Fix:** collect the pass's events and save once at the end; listeners can still be notified
per event.

### E5 — Every dashboard refresh blanks the status dots (old L17)

`refresh()` in `src/web/main.ts:551-559` clears the cached status and setup data *before*
repainting, so every add/edit/remove/import flashes all status dots gray and drops setup
badges until two fresh fetches land — three full sidebar rebuilds and one duplicate `/api/status`
fetch (on top of the 30-second poller) per mutation.

**Fix:** keep the previous caches until the fresh responses arrive, then paint once per
response.

### E6 — Status-checker maps leak entries for removed boxes

The per-box backoff map and the CPU-delta tracking map in `src/server/status.js` only ever
grow. Removing a box deletes it from the store but nothing clears these maps, and box ids are
UUIDs so the entries can never be reused. Slow, unbounded growth on a long-running server.

**Fix:** add a `forgetBox(id)` method to the status checker that clears both maps, called
from box removal.

### E7 — Importing N boxes rewrites `boxes.json` N times

`importBoxes` calls `addBox` per entry, and each `addBox` does a full read-parse-append-write
cycle. Importing a 50-box export therefore performs 50 full-file cycles plus 50 uniqueness
scans over a growing list, where one read, one in-memory validation pass, and one write would
do. (Fixing B4 first makes this batch path trivial to add safely.)

**Fix:** add a batch import path — read once, validate each entry against the in-memory list,
write once.

### E8 — The setup script installs git even when nothing needs it

The generated setup script's fixed preamble includes an "ensure git" block (apt update +
install), originally there for the oh-my-* framework clones — but it runs even for a bare
setup with no frameworks and no git tool selected. That's an unrequested package mutation on
the target box, and it duplicates the explicit git entry in the tool catalog.

**Fix:** include the git bootstrap only when oh-my-tmux, oh-my-zsh, or the git tool was
actually selected.

### E9 — Concurrent first uses of the default public key each spawn `ssh-keygen`

`defaultPublicKey` in `src/server/index.js:110-114` caches the *resolved value*: `if
(!cachedDefaultKey) cachedDefaultKey = await readDefaultPublicKey(...)`. Between the check and
the resolution, every other caller still sees null and starts its own `ssh-keygen` child. A
provision job and the default-key API route racing at startup do exactly this.

**Fix:** cache the promise instead (`cachedDefaultKey ??= readDefaultPublicKey(...)`),
resetting it to null if it resolves null or rejects — preserving the current "a key added
later is picked up without restart" behavior.

---

## Detailed findings — complexity and duplication

### C1 — Four job stores are byte-for-byte copies

`fleetStore.js`, `setupStore.js`, `provisionStore.js`, and `proxmoxLifecycleStore.js` are the
same module four times — `diff` shows only the factory name, filename, and comment wording
differ. All four re-implement the same debounced-write machinery (`pending`/`flushing`/idle
resolvers) around the shared JSON persistence layer. Any fix to that machinery currently has
to be hand-copied to four files.

**Fix:** extract a single `createDebouncedJsonStore({ dataDir, filename })` factory (a natural
neighbor of `jsonFile.js`) and reduce the four stores to one-line wrappers. This also creates
the single obvious place to wire the B8 shutdown flush.

### C2 — The modal scaffold is copy-pasted eight times and drifting

The same backdrop-plus-guard-plus-Escape-plus-teardown block appears verbatim in eight places
across `main.ts`, `settingsUi.ts`, `proxmoxUi.ts`, `proxmoxContainers.ts`, and
`proxmoxPresets.ts` — and the copies have already diverged: two of them (the additional-disk
modal and the Proxmox hub) lack the Escape-to-close handling the others have. A `makeRadio`
helper is separately duplicated within `main.ts`. `dom.ts` exists precisely to hold shared DOM
builders.

**Fix:** add an `openModal({ onClose })` helper to `dom.ts` that returns
`{ backdrop, close }` with the guard and Escape wiring, and migrate the eight call sites.

### C3 — Two parallel setup-job viewers implement the same state machine

The provision panel in `main.ts` and the Provision tab in `proxmoxUi.ts` each implement the
same loop: poll the setup job, render status text and the scrolling log, and offer the
interactive-terminal fallback when the job needs sudo. Only the surrounding chrome differs.
The pure formatting layer (`setupStatus.ts`) is already shared; the stateful loop is not — and
findings B11/B12 had to be reported against *both* copies, which is the cost of this
duplication in miniature.

**Fix:** extract one setup-job viewer module (poll loop plus log/actions rendering, with the
container and callbacks injected) used by both.

### C4 — The PVE task-polling loop is duplicated between two job managers

`pollTask` — task-log tailing, tolerance for consecutive poll failures, the exit-status check,
the deadline — is implemented nearly line-for-line in both `proxmoxProvision.js` and
`proxmoxLifecycle.js`, along with much of the surrounding job-manager scaffolding. The
poll-failure-tolerance lesson (M6 from the previous review) had to be applied to both copies
by hand.

**Fix:** extract a shared `pollPveTask(client, node, upid, options)` helper.

### C5 — The pinned-TLS connection glue is duplicated between the two API clients

The subtle `createConnection` wiring that routes requests through `pinnedSocket` — including
its explanatory comment — is duplicated verbatim in `proxmoxApi.js` and `netboxApi.js`. It is
exactly the kind of security-relevant glue that should exist once.

**Fix:** export a `pinnedConnectionFactory({ host, port, fingerprint256, timeoutMs })` from
`tlsPin.js` and use it in both clients.

### C6 — Endpoint parsing is re-implemented inside `proxmoxApi.js`

Both `createProxmoxClient` and `inspectEndpoint` split `host:port` by hand with the
`lastIndexOf(':')` dance, while `parseEndpoint` in `proxmoxValidate.js` already does this with
validation.

**Fix:** import and reuse `parseEndpoint`.

### C7 — Health-setting clamps hardcode numbers that `DEFAULTS` already defines

The six health-related clamps in `config.js` pass literal fallback values (120, 200, 90, 90,
90, 5) that duplicate the entries in the `DEFAULTS` object, unlike every other clamp in the
file, which references `DEFAULTS.x`. Editing a default would silently diverge from its clamp
fallback.

**Fix:** replace the literals with `DEFAULTS.*` references.

### C8 — The local-shell script hardcodes a session name that is configurable elsewhere

`buildEnsureLocalShellScript` hardcodes tmux session name `local`, while the session manager
and server accept a configurable `localSession` parameter (only ever set to a non-default
value by tests). If the parameter were ever used for real, setup would ensure one session and
the terminal would attach to another. Either the knob is over-general or the hardcode is a
latent bug.

**Fix:** thread the session name through to the script builder, or delete the parameter and
commit to the constant.

### C9 — The job-ordering comparator is not a valid total order (known ledger minor)

`ordered()` in `setupManager.js` (and the same pattern in `proxmoxProvision.js`) sorts with a
comparator that returns −1 when two timestamps are equal. V8's stable sort makes this
deterministic in practice today, but it is formally invalid and a portability hazard.

**Fix:** a shared comparator that tie-breaks by job id, used by both files.

---

## Detailed findings — dead code

### D1 — The status route's "no poller" fallback is unreachable in production

`GET /api/status` in `server.js` contains a fallback branch (probing all boxes on demand) for
the case where no status poller was injected — but `index.js` unconditionally constructs and
injects one, and the branch's own comment admits it exists for unit tests. It is the only
consumer of `mapWithConcurrency` in that file.

**Fix:** make the poller a required dependency, pass a stub in the tests, and delete the
branch.

### D2 — `whenIdle()` has no production caller in any of the four stores

Grep confirms `whenIdle` is called only from the four store test files. It is, however, the
natural graceful-shutdown seam — so rather than deleting it, wire it into the B8 shutdown
flush, which turns it into real production surface.

### D3 — The atomic-write module's power-loss claim is stronger than the code

`jsonFile.js` promises that "a crash or power loss mid-write can never truncate the live
file". The temp-file-plus-rename pattern genuinely guarantees this for *process* crashes, but
not for power loss: without an fsync of the temp file before the rename, the filesystem may
journal the rename before the file's data blocks reach disk (the classic ext4
delayed-allocation hazard), leaving a zero-length file after the machine comes back.

**Fix:** fsync the temp file's descriptor before renaming (and optionally the directory
after), or soften the comment to claim process-crash safety only.

---

## What's solid (calibration)

The review specifically probed these areas and found them sound:

- **SSH command-injection surface.** Every user-controlled box field passes through
  `assertBoxSafe` before reaching an ssh argv; `shSingleQuote` is a correct POSIX quoter;
  upload filenames are allowlist-validated and re-validated at use. No hole found.
- **XSS.** Every dynamic value (box labels, commands, fleet output, server errors, Proxmox
  names) reaches the DOM via `textContent` or text nodes; the only `innerHTML` sinks are
  fully static literals. Terminal echo paths strip control characters.
- **Secrets at rest.** AES-256-GCM sealing, owner-only (0600) file modes, and
  browser-facing redaction all verified (the S5 tag-length nit aside). API error messages
  never include the Authorization header.
- **TLS pinning.** Both API clients verify the pinned fingerprint on each request's own
  connection — the probe is advisory, the per-request check is the enforcement point.
- **Auth paths.** Cookie signing and TTL, the fail-closed scrypt hash check, rate-limiter
  eviction, and origin checks all held up under re-examination.
- **Proxmox inventory re-homing.** The orphan-heal and migration-follow paths' compare-and-swap
  re-reads and active-job guards close the race windows that were probed.
- **Bounded buffers.** The log caps, ring buffers, and threshold streak counters in the
  fleet/setup/health modules are all correct against their tests; no unhandled-rejection
  paths were found in any job manager.

The test-only exports flagged by the dead-export sweep (`PROBE_REMOTE`, `_count`,
`buildKillTmuxRemote`, the pure web helpers, and so on) are deliberate seams consistent with
the repository's TDD convention, not dead code.
