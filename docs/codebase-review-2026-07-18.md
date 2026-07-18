# Codebase Review — Tmuxifier

**Date:** 2026-07-18
**Version reviewed:** v1.7.3 (`main` @ 2330bcc, working tree)
**Scope:** All of `src/server/`, `src/web/`, scripts, tests, repo hygiene.
**Method:** Five parallel deep reviews (server core, SSH/session/box, Proxmox/NetBox,
fleet/setup/health, web client) plus first-hand spot verification of the top findings and a
dead-export sweep. Baseline: `npm test` green (819/819 across 74 files, ~36s). Still-open items
from the 2026-07-04 review were re-verified against v1.7.3 and are folded in below with their
old IDs.

> Point-in-time review for triage; nothing here has been fixed yet. Line numbers reference the
> reviewed commit and will drift. The **Status** column in the table below is the live fix
> ledger: flip entries to `✅ vX.Y.Z` as fixes ship and add a dated status note here per batch
> (same convention as `codebase-review-2026-07-04.md`).

## Findings & fix tracking

Severity is likelihood × blast radius for this single-user tool. Effort: **S** < 1h, **M** = a
few hours. **Status is the tracking ledger for this review** — update it in place as fixes land
(`Open` → `✅ vX.Y.Z`, or `Won't fix` with a reason), and add a dated status note under the
header above when a batch ships, mirroring the 2026-07-04 review's convention.

| ID | Area | Finding | Sev | Eff | Fix | Status |
|----|------|---------|-----|-----|-----|--------|
| B1 | boot | Fatal boot errors exit code 0 — systemd `Restart=on-failure` never restarts | Med | S | `process.exit(1)` in `uncaughtException` handler, or register swallow handlers only after `app.listen` | Open |
| B2 | config | `upsertConfigFile` writes `config.json` non-atomically; torn write + B1 = silently dead service | Med | S | Use `writeFileAtomicSync` from jsonFile.js | Open |
| B3 | sessions | Attach "resize jiggle" second call is a no-op; provision PTYs ratchet narrower per reattach | Med | S | Capture `const c = pty.cols` before jiggle; restore to `c` | Open |
| B4 | store | boxes.json mutators are unserialized read-modify-write; concurrent writes lost | Med | S | Per-store promise-chain queue (`queue = queue.then(op)`) | Open |
| B5 | setup | `[null]` row in `setup-jobs.json` crashes the server at boot (fleet.js guards this, setupManager doesn't) | Med | S | Same `validJob`-style shape filter fleet.js uses | Open |
| B6 | setup | `needs-interactive` jobs never superseded/pruned — unbounded accumulation incl. 64KB logs | Med | S | On new `start()` for a box, flip older non-running jobs to terminal `superseded` | Open |
| B7 | setup | `cancelForBox` is a no-op during the `waiting-ssh` phase — setup proceeds against a deleted box | Med | S | Per-job `cancelled` flag checked between probe attempts and before `sshStream` | Open |
| B8 | stores | No SIGTERM flush of debounced stores — deploy restart loses final save; done jobs reload `interrupted` | Med | S | SIGTERM/SIGINT handler awaiting all stores' `whenIdle()` (with C1, D2) | Open |
| B9 | web | Stale fleet-job poll response for finished job A kills job B's poll loop (old L16, sharpened) | Med | S | Guard finished branch and `showFleetJob` render with `fleetPollJobId === id` | Open |
| B10 | web | ⌘/Ctrl+Enter in fleet editor shadowed by CM6 `defaultKeymap` `Mod-Enter` — inserts blank line, never runs | Med | S | Put `runKeymap` before combined keymap (or `Prec.high`) | Open |
| B11 | web | "Finish interactively" multi-click opens concurrent setup PTYs on one box; prior handle leaked (also `proxmoxUi.ts` setupTerm) | Med | S | Disable button once clicked; dispose prior `interactiveTerm`/`setupTerm` before reassign | Open |
| B12 | web | 401/logout teardown misses `document.body`-mounted modals — Proxmox hub polls forever atop login screen | Med | S | Registered close hook for body-mounted modals, invoked by `onUnauthorized`/logout | Open |
| B13 | fleet | `prune()` evicts a still-running job (old L3, confirmed open) | Low | S | Skip `running` jobs in prune (mirror setupManager's retention) | Open |
| B14 | boxes | Post-removal background `exitMaster` can tear down the master of a same-host box re-added within ~18s | Low | S | Re-check store for same host/user/port before `exitMaster`, skip if found | Open |
| B15 | ssh | Per-chunk Buffer→string decode garbles UTF-8 split across chunk boundaries in setup logs | Low | S | `string_decoder.StringDecoder` per stream in sshRun.js | Open |
| B16 | web | Transient PVE `unknown` state closes the stopped-box panel and clears selection | Low | S | Only affirmative `running` counts as "restarted"; keep panel on `unknown` | Open |
| B17 | netbox | `requireNetboxSettings` masks decrypt/read errors as "not configured" | Low | S | Distinguish null settings from thrown read/decrypt error; surface the latter | Open |
| B18 | server | `tmux kill-session -t local` prefix-matches — can kill the operator's own `local-*` session | Low | S | Exact-match target `-t =local` | Open |
| B19 | auth | Google token exchange has no timeout (old L12, confirmed open) | Low | S | `signal: AbortSignal.timeout(10000)`, map abort into existing catch | Open |
| B20 | config | `parseEnvFile` folds inline `# comment` into the value; numeric knobs silently fall back to defaults | Low | S | Strip unquoted ` #…` suffix (dotenv-compatible) | Open |
| B21 | fleet | ssh timeout reported as `exited 1` (old L2, confirmed open) | Low | S | Surface `err.killed`/`err.signal` as `timed out` in sshRun/fleet | Open |
| B22 | fleet | Duplicate `boxIds` run a command twice on one box (old L4, confirmed open) | Low | S | Dedupe `boxIds` in `createJob` | Open |
| B23 | store | `updateBox` can't clear `label` (old L11, confirmed open) | Low | S | Honor explicit `''`/`null` label like the user/port/proxyJump clear loop | Open |
| B24 | proxmox | Templates route without `?storage` → `/storage/undefined/content` 502 (old L14, confirmed open) | Low | S | Return 400 when `?storage` missing | Open |
| B25 | web | `formatEvent` has no default case — unknown event kind from a newer server bricks the panel (old L15, confirmed open) | Low | S | Default branch returning a generic event line | Open |
| S1 | known_hosts | `forget(host, port)` on a nonstandard-port box also deletes the bare-host entry — a *different* machine's port-22 identity | Med | S | When `port && port !== 22`, remove only the `[host]:port` form | Open |
| S2 | repo | `.agents/`, `graphify-out/`, `skills-lock.json` un-ignored; shipping flow's `git add -A` would commit them to the public repo | Med | S | Add all three to `.gitignore` | Open |
| S3 | auth | Logout revokes nothing server-side; captured cookie valid up to 7 days after logout | Low | S | "Sessions invalid before <ts>" watermark bumped on logout, or document client-side-only | Open |
| S4 | server | HSTS sent only for `https://` publicUrl — absent in the documented local-TLS mode | Low | S | Use the same predicate as `secureCookie` (local TLS ⇒ HSTS too) | Open |
| S5 | secrets | `secretBox.open` accepts truncated GCM auth tags (old L13, confirmed open) | Low | S | Pass `{ authTagLength: 16 }` (or reject tags ≠ 16 bytes) | Open |
| S6 | scripts | `set-password` accepts the password via argv and echoes the interactive prompt (old L23, confirmed open) | Low | S | Mask interactive input; deprecate the argv form | Open |
| S7 | status | `HOSTKEY_CHANGE_RE` second alternation over-matches jump-host key failures — ⚷ misleads for proxyJump boxes (known deferred, v1.7.1) | Low | S | Drop the alternation or add a tooltip caveat | Open |
| E1 | setup | `persist()` on every ssh output chunk — full-history sort + multi-MB stringify + atomic write per chunk | Med | S | Coalesce log persistence (≥250ms / 8KB); keep immediate persist for status transitions | Open |
| E2 | netbox | Pin mode runs a full `tlsProbe` handshake before **every** API call — 2× handshakes per request | Med | S | Cache resolved TLS options per client (as proxmoxApi does), or skip probe when pin known | Open |
| E3 | provision | In-memory `jobs`/`settles` Maps never pruned; disk slice can drop a still-running job's record | Med | S | Adopt lifecycle's terminal-only `prune()`; delete matching `settles` entries (both managers) | Open |
| E4 | health | One synchronous full-file write per emitted event — 30-box outage = 30 back-to-back writes | Low | S | Collect events during `record()`, `save` once at end of pass | Open |
| E5 | web | `refresh()` wipes status/setup caches before repaint — gray-dot flash + duplicate fetches (old L17) | Low | S | Keep previous caches until fresh responses land; paint once per response | Open |
| E6 | status | `backoff`/`cpuPrev` maps never pruned on box removal | Low | S | `forgetBox(id)` on the checker, called from box removal | Open |
| E7 | store | `importBoxes` does N full read/write cycles for N boxes | Low | S | Batch path: read once, validate against in-memory list, write once | Open |
| E8 | boxActions | Setup installs git unconditionally even when nothing selected needs it | Low | S | Gate git bootstrap on `installOhMyTmux \|\| installOhMyZsh \|\| tools.includes('git')` | Open |
| E9 | index | `defaultPublicKey` caches the value, not the promise — concurrent first calls spawn duplicate ssh-keygen | Low | S | Cache the promise (`??=`); reset to null on null-resolve/reject | Open |
| C1 | stores | Four byte-equivalent debounced store factories | Med | M | Extract `createDebouncedJsonStore({ dataDir, filename })`; four one-line wrappers | Open |
| C2 | web | Modal scaffold copy-pasted ×8 with drift (two sites lack Escape); `makeRadio` ×2 | Med | M | `openModal({ onClose })` helper in dom.ts; migrate the eight sites | Open |
| C3 | web | Two parallel setup-job poll viewers (provision panel vs `proxmoxUi`) | Low | M | Extract one setup-job viewer module (poll loop + log/actions render) | Open |
| C4 | proxmox | `pollTask` + job-manager scaffolding duplicated between provision and lifecycle managers | Low | M | Shared `pollPveTask(client, node, upid, opts)` helper | Open |
| C5 | tls | Pinned-`createConnection` glue duplicated between proxmoxApi and netboxApi | Low | S | `pinnedConnectionFactory(...)` exported from tlsPin.js | Open |
| C6 | proxmox | Endpoint host/port split re-implemented twice in proxmoxApi | Low | S | Reuse `parseEndpoint` from proxmoxValidate.js | Open |
| C7 | config | Health-knob clamps hardcode fallback literals duplicating `DEFAULTS` | Low | S | Replace literals with `DEFAULTS.*` references | Open |
| C8 | local | `buildEnsureLocalShellScript` hardcodes `'local'` while a `localSession` knob exists | Low | S | Thread the session name through, or drop the knob and commit to the constant | Open |
| C9 | setup | `ordered()` comparator not a total order (−1 on equal `createdAt`); same in proxmoxProvision | Low | S | Shared tie-break-by-id comparator used by both | Open |
| D1 | server | `/api/status` `!statusPoller` fallback branch unreachable in production | Low | S | Make `statusPoller` required, stub in tests, delete branch + `mapWithConcurrency` import | Open |
| D2 | stores | `whenIdle()` production-dead in all four stores | Low | S | Wire into B8's shutdown flush (don't delete) | Open |
| D3 | jsonFile | "power loss can never truncate" comment overclaims — no fsync before rename | Low | S | fsync fd (± directory) before rename, or soften claim to process-crash | Open |
| N1 | web | `terminal.ts:260` WS URL unencoded vs encoded provision path (old L19) | Info | S | `encodeURIComponent(boxId)` for consistency | Open |
| N2 | e2e | 2 pre-existing e2e failures (zsh root shell), noted in the sdd ledger | Info | — | Fix separately; not introduced by any pending change | Open |
| N3 | repo | ~180 `review-*.diff` files in `.superpowers/sdd/` (gitignored but heavy clutter) | Info | S | Delete or archive the diff files | Open |
| N4 | repo | Working-tree CLAUDE.md gained a graphify section — tracked file, ships publicly on next release | Info | — | User decision: keep public, or move rule into gitignored `.claude/` | Open |

Old-review items verified **fixed** since 2026-07-04: L6 (cpu threshold seed), plus everything
marked fixed in that doc. `proxmoxUi` `_opt` dead param (ledger minor) already cleaned.

---

## Details — bugs

### B1 — Fatal boot errors exit 0; systemd never restarts
`src/server/index.js:35-36` registers blanket `uncaughtException`/`unhandledRejection` handlers
that log and continue, before `loadConfig()`/`buildServer()` run. A throw during boot (corrupt
`config.json`, bad `TMUXIFIER_TLS_CERT` path) is logged and the process exits **0**;
`deploy/tmuxifier.service` uses `Restart=on-failure`, so the service stays dead. Verified
empirically. Meanwhile `requiredConfigError` correctly exits 1 — only some boot failures signal
failure. **Fix:** `process.exit(1)` in the `uncaughtException` handler, or register the
swallow-and-continue handlers only after `app.listen` succeeds.

### B2 — `config.json` written in place
`src/server/configFile.js:30-31` uses raw `writeFileSync` (no temp+rename). `PATCH
/api/local-shell` writes this file at runtime; a torn write leaves invalid JSON,
`readConfigFile` deliberately throws, `loadConfig` is unguarded at boot — combined with B1 the
service then dies silently on every start. `writeFileAtomicSync` already exists in jsonFile.js
for exactly this. **Fix:** use it (also un-deads that export).

### B3 — Resize jiggle is a no-op on the restore side
`src/server/sessions.js:119-121`:
```js
entry.pty.resize(entry.pty.cols === 1 ? 2 : entry.pty.cols - 1, entry.pty.rows);
entry.pty.resize(entry.pty.cols, entry.pty.rows);
```
node-pty's `resize()` mutates `_cols`, and `get cols()` returns it — the second call re-reads
the already-shrunken value and resizes to the same width. Interactive terminals are masked
because the client sends `{t:'r'}` on open, but provision/setup sockets never send resize and
the server ignores `'r'` in provision mode, so the fixed 120-col PTY runs at 119 and each
replacement-socket reattach ratchets it one more column down. **Fix:** capture `const c =
entry.pty.cols` before the jiggle; restore to `c`.

### B4 — boxes.json read-modify-write races
Every `store.js` mutator does `await readAll()` … `await writeAll(boxes)` with no
serialization. `proxmoxProvision.js:140` calls `addBox` from a background job while the user
PATCHes another box → both read the same array, second write drops the first's change.
**Fix:** per-store promise-chain queue (`queue = queue.then(op)`).

### B5 — Malformed setup-jobs row crashes boot
`src/server/setupManager.js:36-39` iterates `load() || []` and dereferences `j.status`; the
store's `validate: Array.isArray` accepts `[null]`. fleet.js:31-36 filters exactly this
("one bad history row must never keep the server from booting") — setupManager, which mirrors
it, lacks the guard. **Fix:** same shape filter as fleet.

### B6 — `needs-interactive` jobs accumulate forever
`start()` only short-circuits on `running`; `retainedIds()` keeps every non-terminal job;
`markInteractiveResult` resolves only the newest job per box. Each Retry that hits the
sudo-password path strands another `needs-interactive` job (plus its 64KB log) in memory, on
disk, and in `listJobs()` — unboundedly. **Fix:** when `start()` creates a new job for a box,
flip older non-running jobs for that box to a terminal `superseded` status.

### B7 — Cancel is a no-op during `waiting-ssh`
The ssh handle is registered only after the ready-probe loop (`setupManager.js:111`);
`cancelForBox` only kills registered handles and sets no flag the loop checks. Provision
auto-starts setup with `waitForSsh: true` (up to ~90s window); deleting the box in that window
cancels nothing and the full install script then runs against the removed box. **Fix:**
per-job `cancelled` flag checked between probe attempts and before `sshStream`.

### B8 — No shutdown flush for debounced stores
No SIGTERM/SIGINT handler exists; `whenIdle()` is called only by tests. `systemctl restart
tmuxifier` (the documented deploy step) can lose the final debounced save; on boot the stale
file still says `running` and reconciliation flips a completed job to `interrupted` — the
exact recurring symptom recorded in the deploy-restart memory note. **Fix:** SIGTERM handler
awaiting all stores' `whenIdle()` (also resolves D2).

### B9-B12 — web client (see table)
- **B9** `main.ts:1756-1763`: `pollFleetJob`'s finished branch calls `stopFleetPoll()`
  unguarded by `fleetPollJobId === id`; a stale response for finished job A silently freezes
  newly-selected job B's detail view. `showFleetJob`'s initial render is also unguarded (slower
  of two rapid clicks paints over the newer selection).
- **B10** `fleetEditor.ts:145-146`: `defaultKeymap` (contains `Mod-Enter: insertBlankLine`)
  precedes `runKeymap`, so the advertised ⌘/Ctrl+Enter run shortcut inserts a blank line while
  the editor has focus. Put `runKeymap` first or wrap in `Prec.high`.
- **B11** `main.ts:1030-1045` (+ `proxmoxUi.ts:166-170`): "Finish interactively" is never
  disabled and the poll re-creates it every 2.5s; each click overwrites `interactiveTerm`
  without disposing — concurrent interactive setup scripts (e.g. two apts) on one box, leaked
  WS PTYs.
- **B12** `main.ts:1821-1831`: `onUnauthorized` closes `#app` panels but not the
  `document.body`-mounted Proxmox hub / settings modal; the hub's tick loop retries a failing
  fetch every 1.5s forever on top of the login screen (`jr()` has no 401 seam, nothing bumps
  `pollGen`). Register body-mounted modals with a close hook the teardown invokes.

### B13-B25 — smaller bugs
See the table; all confirmed against v1.7.3 source. Notables: **B14** — `boxRemoval.js:13-20`
background cleanup (`killSession` 12s + `exitMaster` 6s timeouts) unconditionally unlinks the
`%C` socket, which can kill the fresh master of an identical box re-added within the window.
**B15** — `sshRun.js` decodes per chunk (`stdout += d`); use `string_decoder`. **B18** —
`tmux kill-session -t local` prefix-matches; `-t =local` is exact. **B20** —
`TMUXIFIER_PORT=8080 # dashboard` yields `"8080 # dashboard"` → NaN → silent default 7437.

---

## Details — safety

### S1 — known_hosts forget removes the wrong identity
`src/server/knownHosts.js:26-28`: `targets = [String(host)]` unconditionally, with
`[host]:port` appended for nonstandard ports. OpenSSH stores a port-2222 box only as
`[host]:2222`; the bare `host` entry is whatever answers port 22 at that address. In the
NAT/port-forward setups where nonstandard ports actually occur, deprovisioning container A
erases the unrelated port-22 host's key — violating the project rule that a key is removed
only when *that* identity is proven gone. **Fix:** when `port && port !== 22`, remove only the
bracketed form.

### S2 — un-ignored local artifacts + `git add -A` shipping flow
`.agents/`, `graphify-out/` (knowledge-graph cache, cost.json, report), and
`skills-lock.json` are untracked and not in `.gitignore`. The CLAUDE.md shipping checklist
stages with `git add -A`, so the next release would commit all of it to the **public** repo.
The PII-scrub step reviews the staged diff, but relying on manual review for machine-local
artifacts is fragile. **Fix:** add the three to `.gitignore`. Related, user decision: the
working-tree CLAUDE.md now contains a graphify section referencing local tooling — keep it
public, or move the rule into gitignored `.claude/` config.

### S3-S7
See table. S3 (logout is client-side only) and S5 (`authTagLength`) are small hardening items
inside the codebase's own stated threat model; S4 aligns HSTS with the `secureCookie`
predicate; S6/S7 are known deferred items re-confirmed open.

---

## Details — efficiency

- **E1** `setupManager.js:100-109`: `onData` → `appendLog` + `persist()` per ssh chunk;
  `persist()` sorts all jobs and `setupStore.save` stringifies the entire history (up to ~50 ×
  64KB) eagerly per call. An apt upgrade emitting thousands of chunks = thousands of multi-MB
  stringifies and near-continuous atomic writes. Coalesce on a timer/byte threshold; keep
  immediate persist for status transitions.
- **E2** `netboxApi.js:59-61`: `call()` re-runs `resolveTlsOpts` per request; pin mode probes
  (full handshake) then `pinnedSocket` verifies again on the real connection. `proxmoxApi.js`
  already caches `tlsPromise` per client. An auto-static allocation costs 6 handshakes instead
  of 3.
- **E3** `proxmoxProvision.js`: `persist()` slices to `maxJobs` on disk only; in-memory
  `jobs`/`settles` grow forever and the disk slice ignores job status (can drop a running
  job's record). Adopt lifecycle's terminal-only `prune()` (and delete `settles` entries —
  lifecycle itself leaks `settles` too, E-minor).
- **E4-E9**: see table.

---

## Details — complexity / dead code

- **C1** Four byte-identical debounced store factories (`diff` confirms only names/comments
  differ). Extract `createDebouncedJsonStore({ dataDir, filename })` next to jsonFile.js;
  four one-line wrappers. Pairs with B8/D2 (single place to wire shutdown flush).
- **C2** Modal scaffold ×8 with drift (`openAddDiskModal` and the hub lack Escape); `makeRadio`
  ×2. `dom.ts` is the designated home — add `openModal({ onClose })`.
- **C3** Provision panel (`main.ts:979-1082`) and `proxmoxUi.ts:146-176` re-implement the same
  setup-job poll/render/interactive-fallback state machine; `setupStatus.ts` is already the
  shared pure layer — extract the stateful loop too.
- **C4-C9**: see table.
- **D1** `server.js:570-586` `!statusPoller` fallback: index.js always passes a poller; branch
  is test-only. Make the dependency required, stub it in tests, delete the branch (removes
  server.js's `mapWithConcurrency` import).
- **D2** `whenIdle()`: production-dead ×4, but it is the natural shutdown-flush seam — wire it
  (B8) rather than delete.
- **D3** jsonFile.js comment claims power-loss safety; no fsync before rename. Either fsync
  (fd + optionally directory) or soften the claim to process-crash safety.
- Dead-export sweep found **no** truly dead exports: the test-only exports
  (`PROBE_REMOTE`, `_count`, `buildKillTmuxRemote`, the pure web helpers, etc.) are deliberate
  TDD seams per repo convention.

---

## What's solid (calibration)

- **SSH injection surface**: all argv builders route through `assertBoxSafe`; `shSingleQuote`
  correct; upload names allowlisted and re-validated. No hole found.
- **XSS**: every dynamic value reaches the DOM via `textContent`/text nodes; the only
  `innerHTML` sinks are static literals. Terminal echo paths strip control chars.
- **Secrets**: sealing, 0600 modes, browser-facing redaction all verified. Pin mode verifies
  the fingerprint on each request's own connection in both API clients.
- **Auth**: cookie signing/TTL, scrypt fail-closed hex check, rate-limiter eviction, origin
  checks verified correct.
- **Inventory re-homing**: the orphan-heal and drift-follow CAS + active-job guards held up
  under targeted race probing.
- Ring buffers, log caps, and threshold streaks in fleet/setup/health: no off-by-ones; no
  unhandled-rejection paths in any job manager.
