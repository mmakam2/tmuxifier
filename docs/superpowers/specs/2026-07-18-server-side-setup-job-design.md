# Server-Side Box Setup Jobs (with interactive fallback) — Design

**Date:** 2026-07-18
**Status:** Approved

## Problem

Box "setup" — installing tmux, the selected shell frameworks (Oh My Tmux/Zsh/Bash), and the
curated provision-time tool catalog (curl, git, gh, node/npm, bubblewrap, the Codex/Claude/
Antigravity CLIs) — currently runs over an **interactive SSH PTY tied to the browser
WebSocket**. The flow lives in the `mode=provision` handler in `server.js`, backed by
`sessions.provision` (`sshCommand.buildProvisionArgv`, forced `-tt`) and the generated script
from `boxActions.buildEnsureTmuxRemote`.

Because the remote script is the foreground process of that SSH channel, **anything that drops
the WebSocket kills the setup mid-stream**: closing the provision modal, a tab close, or a
transient network blip. On the server side, `server.js`'s socket-close handler calls
`sessions.closeIfUnwatched`, which — with no other watcher — immediately `pty.kill()`s the ssh
connection; SIGHUP then terminates the remote script partway. There is no grace window for
provision mode (unlike interactive terminals, which get `graceSeconds` + on-box tmux
persistence). The client even documents this: *"Closing mid-run cancels: disposing the WS makes
the server kill the remote script."*

This fragility applies to **both** entry points that run the script: Proxmox-provisioned boxes
(after the LXC is linked) and manually-added boxes (any Add Box with framework/tool checkboxes).

Note the asymmetry motivating this work: the Proxmox **container-creation** phase is already a
durable, server-side, persisted job (`proxmoxProvision.js` → `data/provision-jobs.json`) that
survives modal close and even a Tmuxifier restart (reconciled to `interrupted`). Only the
**on-box setup script** remains browser-coupled.

## Goals

- The on-box setup script runs **server-side**, decoupled from the browser WebSocket, so a WS
  drop (modal close, tab close, network blip) never aborts it.
- Setup is a **persisted, pollable, resumable job**, mirroring the existing
  `proxmoxProvision.js` / `fleet.js` job-manager pattern.
- Boxes that genuinely need a human (sudo asking for a password inside the box) get an
  **interactive fallback** — the existing WS PTY path, on demand.
- One box-agnostic subsystem serves **both** entry points (Proxmox provision and manual Add Box).

## Non-goals

- No change to how SSH itself authenticates. The server's shared ControlMaster is already
  authenticated; child sessions ride it with `BatchMode=yes` and no re-auth. **The only thing
  that genuinely needs a TTY is sudo prompting for a password *inside the box*** (box user ≠
  root, no NOPASSWD). SSH passwords/passphrases and host-key acceptance are not in scope.
- No surfacing of setup jobs in the Proxmox **Activity** tab (deferred — see Out of scope).
- No auto-retry of `interrupted` jobs on restart (deliberate — see Error handling).

## Key decisions

1. **Execution mechanism — streaming `spawn('ssh')`, non-PTY, BatchMode.** A non-interactive job
   is the honest fit; the interactive case has its own home (the WS fallback). Rejected: a
   server-owned detached node-pty (PTY lifecycle for no benefit), and running detached inside
   on-box tmux (reintroduces exit-code-across-reconnect fiddliness and duplicates state).
2. **Interactive fallback trigger — auto-detect + retry.** Always start the server-side job; if
   it fails specifically because sudo needs a password (stderr signature), flip the job to
   `needs-interactive` and offer a one-click **Finish interactively** retry over the live WS PTY.
   Root/NOPASSWD boxes never see it. The script is idempotent (`ensure`-style), so re-running is
   safe. Rejected: a pre-`sudo -n true` probe (extra round-trip every setup), and a per-box
   "needs sudo password" flag (user must set it correctly).
3. **Scope — all box setups, one manager.** Both Proxmox provision and manual Add Box use the
   same box-agnostic setup-job manager. Rejected: Proxmox-only (leaves the same fragility on
   manual adds and forks the code path).
4. **On failure — keep the box + offer retry.** A hard setup failure no longer auto-removes the
   box. This changes today's behavior (manual/non-Proxmox boxes were auto-removed on nonzero
   exit); auto-deletion fights the durable/resumable job model. Box is removed only via the
   explicit **[Remove]** button.

## Architecture

### Job lifecycle & states

```
running ──────► done
   │
   ├──────────► error            (hard nonzero: apt failure, timeout, …)
   │
   ├──────────► needs-interactive (sudo-password stderr signature)
   │                 │
   │                 └── Finish interactively (WS PTY) ── exit 0 ──► done
   │                                                    ── exit ≠0 ─► stays needs-interactive
   │
   └── (Tmuxifier restart mid-run) ─► interrupted  (reconciled on load)
```

- `running` — `spawn('ssh', … BatchMode=yes)` streaming stdout+stderr into the job's rolling log.
- `done` — exit 0.
- `error` — hard nonzero exit or timeout. **Box kept.**
- `needs-interactive` — stderr matched the sudo-password signature; job pauses awaiting the
  interactive finish.
- `interrupted` — a non-terminal job at load time (the ssh child died with the process).

### Two entry points, one job type

- **Manual Add Box:** client creates the box (`POST /api/boxes`), then
  `POST /api/boxes/:id/setup {ohMyTmux, ohMyZsh, ohMyBash, tools}`. Once that request returns,
  the browser is out of the critical path. (A single-request window remains between box-create
  and the setup POST — negligible.)
- **Proxmox provision:** the provision request **carries** the setup options; the provision
  manager, on successful box-link (`proxmoxProvision.js`, `link` phase, right after
  `j.boxId = box.id`), calls the injected `startSetup(box, options)` itself. Setup therefore
  survives the browser closing during *either* phase — fully durable end-to-end.

### Interactive fallback = the existing WS PTY path, on demand

The current `mode=provision` WebSocket handler and `openProvisionTerminal` client flow are kept
and reused. When a job is `needs-interactive`, the viewer shows **[Finish interactively]**, which
opens that live PTY running the same idempotent script. On its exit the WS handler calls
`setupManager.markInteractiveResult(boxId, code)`, setting the job `done`/`error`. The interactive
path is inherently *attended* (a human is present to type the sudo password), so its
non-durability (closing the terminal cancels it, leaving the job `needs-interactive` and
retryable) is by design.

### Viewer = poll-based

The panel polls `GET /api/setup/:id` for `{status, log}`, exactly like the Proxmox phase-1 job
view. Closing/reopening is free; the log is server-persisted. Box cards show a **derived** setup
badge (setting-up / setup-failed / needs-sudo) from the manager's current-job-per-box map — **no
`boxes.json` schema change**.

## Components

### New server modules

#### `src/server/setupStore.js` (new)

```js
export function createSetupStore({ dataDir })
  → { load(), save(jobs) }         // data/setup-jobs.json
```

Debounced JSON persistence over `data/setup-jobs.json`; a direct mirror of `provisionStore.js`
(built on the shared atomic `jsonFile.js`, written `0o600`).

#### `src/server/setupManager.js` (new)

```js
export function createSetupManager({
  boxStore, sshStream, buildSetupArgv, load, save,
  now, makeId, maxJobs = 50, maxLogBytes = 65536, taskTimeoutMs = 600000,
})
  → {
      start(box, options),          // → job summary; one active job per boxId (dedupes)
      getJob(id),                   // → job incl. log
      listJobs(),                   // → summaries
      currentForBox(boxId),         // → summary | null (drives the box badge)
      markInteractiveResult(boxId, code),  // called by the WS handler
    }
```

- `start` builds the script via `boxActions.buildEnsureTmuxRemote(sessionName, startupCommand,
  { installOhMyTmux, installOhMyZsh, installOhMyBash, tools })`, builds a non-PTY argv via
  `buildSetupArgv`, spawns via `sshStream`, streams chunks into `appendLog` + debounced
  `persist`, and watches stderr for the sudo-password signature.
- One active job per `boxId`: a second `start` while one is `running` returns the existing job
  (no duplicate ssh). **Retry** on a terminal job mints a fresh id and repoints the box's
  current-job.
- Startup reconciliation: non-terminal jobs → `interrupted`, `persist`.
- Log capped at `maxLogBytes` (rolling), `maxJobs` newest-N retention — both as in
  `proxmoxProvision.js`.

### Modified server files

#### `src/server/sshRun.js`

Add the streaming primitive Approach 1 needs (neither existing helper streams stdout):

```js
export function sshStream(argv, { env, timeout, onData, cmd = 'ssh' })
  → { done: Promise<{ code }>, kill() }   // onData(chunk, 'stdout'|'stderr')
```

`spawn(cmd, argv)`, forward stdout/stderr chunks to `onData` with a stream tag, resolve `{code}`
on close; SIGKILL → resolve `124` on timeout. `cmd` is a test-only injection seam (mirrors
`sshRunStdin`'s existing `cmd` param).

#### `src/server/sshCommand.js`

Add `buildSetupArgv(box, script, opts)`: like `buildProvisionArgv` but **`BatchMode=yes`, no
`-tt`**, same `assertBoxSafe` + ControlMaster args + `StrictHostKeyChecking=accept-new` +
`ConnectTimeout`, script pushed as the final argv element. A separate named builder (not an
`interactive` flag on `buildProvisionArgv`) keeps the injection-safe surface explicit.

#### `src/server/proxmoxProvision.js`

`createProvision` accepts `setupOptions`; `createProvisionManager` accepts an injected
`startSetup(box, options)` callback, invoked right after the box is linked (`j.boxId = box.id`,
`link` phase). Keeps this module decoupled — it just fires the hook.

#### `src/server/server.js`

- Routes (all `requireAuth`):
  - `POST /api/boxes/:id/setup` — validate options with the existing `resolveTools` (throws on
    unknown ids → 4xx) + coerced booleans; `setupManager.start(box, options)`; 201 + summary.
  - `GET /api/setup/:id` — job incl. log; 404 if missing.
  - `GET /api/boxes/:id/setup` — the box's current job (`currentForBox`), incl. log; 204/`null`
    if none. This is how the client discovers the auto-started job after a Proxmox link and how
    the box badge resolves, without threading a job id through the provision flow.
  - `GET /api/setup` — list summaries.
- `mode=provision` WS handler: on exit call `setupManager.markInteractiveResult(boxId, code)`;
  **remove the auto-`store.removeBox` rollback** (per decision 4).

#### `src/server/index.js`

Instantiate `setupStore` + `setupManager` (inject `sshStream`, `buildSetupArgv`), pass
`setupManager` into `buildServer`, and inject `setupManager.start` into `createProvisionManager`
as `startSetup`.

### Client (`src/web`)

- `api.ts` — `startSetup(boxId, options)`, `getSetup(id)`, `getBoxSetup(boxId)`, `listSetups()`.
- `main.ts` — rework `openProvisionPanel` into a **poll-based setup viewer** (status + rolling
  log) with buttons **[Finish interactively]** (`needs-interactive`), **[Retry]** (`error`),
  **[Remove]**, **[Close]**. Manual Add Box submit: create box → `startSetup` → open viewer. Box
  cards gain a derived setup badge.
- `proxmoxUi.ts` — after the provision job links the box, discover the already-auto-started
  setup job via `getBoxSetup(boxId)` and transition to polling it.
- `terminal.ts` — `openProvisionTerminal` unchanged; reused as the interactive-finish PTY.

## Error handling & edge cases

- **sudo-password detection:** case-insensitive stderr match on `sudo: a terminal is required to
  read the password` / `a password is required` / `askpass` → `needs-interactive`. Root/NOPASSWD
  boxes never emit these.
- **Timeout:** per-job `taskTimeoutMs` (~10 min). `sshStream` SIGKILLs; job → `error` with a
  timeout note; idempotent script makes Retry safe.
- **Restart mid-run:** non-terminal jobs reconcile to `interrupted`; box kept; viewer offers
  **Retry**. **No auto-retry on boot** (running installs unattended at startup is surprising, and
  matches how Proxmox jobs just mark `interrupted`).
- **Concurrency:** one active job per `boxId`; a `start` during a `running` job returns the
  existing job. Retry mints a fresh id.
- **Interactive coherence:** job stays `needs-interactive` while the WS PTY is open;
  `markInteractiveResult` finalizes it. Closing the interactive terminal mid-run leaves it
  `needs-interactive` (retryable) — acceptable because that path is attended by design.
- **Rollback removed:** WS handler no longer removes a box on nonzero exit; box removed only via
  **[Remove]**.
- **Log & job caps:** rolling `maxLogBytes` (~64 KB) with debounced persist; `maxJobs` newest-N.
- **Options fail-closed:** `resolveTools` throws on unknown ids; nothing user-typed reaches the
  generated script — identical guarantee to today's WS path.
- **Box removed while a job runs:** manager kills that job's ssh and drops its current-job
  pointer.

## Testing

TDD; real code with injected fakes (no mocks), per the repo's factory-injection convention.

### Unit / integration (vitest)

- **`sshStream`** — inject the test-only `cmd` seam at `/bin/sh` scripts emitting to
  stdout/stderr with a chosen exit code: assert chunks forwarded with the right stream tag and
  `{code}` resolves; a sleeping child hits timeout → `124` + killed.
- **`buildSetupArgv`** — asserts `BatchMode=yes` present, `-tt` **absent**, ControlMaster +
  `accept-new` + `ConnectTimeout` present, script is the final argv element, and `assertBoxSafe`
  rejects unsafe box fields (mirrors existing `sshCommand` tests).
- **`setupManager`** (real manager, injected fake `sshStream`): happy path → `done` + log;
  sudo-password stderr → `needs-interactive`; hard nonzero → `error`, **box not removed**;
  timeout → `error`; load a `running` job → `interrupted`; one-active-per-box dedupe;
  `markInteractiveResult(boxId, 0)` → `done`, `(…, 1)` → stays failed; `save` receives
  capped/newest-N.
- **Routes** (real Fastify via `buildServer`): `POST /api/boxes/:id/setup` → 201 + job;
  `GET /api/setup/:id` → job+log; `GET /api/setup` → list; auth required; invalid `tools` → 4xx.
- **`proxmoxProvision`** — on the `link` phase, injected `startSetup` spy called with the linked
  box + the `setupOptions` from `createProvision`.
- **Client** — any pure helper (e.g., setup-state → badge-label) unit-tested; the rest covered by
  `npm run typecheck`, per repo norms.

### End-to-end (playwright, sshd-backed box in `test/helpers`) — the acceptance test

- Add/provision a box with a framework selected, **close the panel mid-run**, reopen → the job
  continues server-side to `done`. Directly proves the original ask.
- Second e2e: a box whose sudo needs a password → job reaches `needs-interactive` → **Finish
  interactively** completes it. If the sshd harness can't easily model password-sudo, this drops
  to a manager-level integration test plus a lighter e2e asserting the `needs-interactive` UI
  renders.

## Out of scope (deferred)

- Surfacing setup jobs in the Proxmox **Activity** tab (`proxmoxActivity.ts`) alongside provision
  and lifecycle jobs.
- Auto-retry of `interrupted` setup jobs on restart.
