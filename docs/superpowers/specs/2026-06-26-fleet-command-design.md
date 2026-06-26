# Fleet Command Design

## Summary

Today the only way to run anything on a box is to open its interactive terminal and type. There is
no way to issue one command to many boxes at once. **Fleet Command** adds a central way to run a
single command across any number of selected boxes and collect each box's result (exit code,
stdout, stderr) in one place.

A run is modeled as a **job** held server-side: the browser creates it, then polls it for live
per-box progress. Because the job lives on the long-running server (the systemd service that
already outlives tab closes and network drops), you can close the tab mid-run, reopen the
dashboard from anywhere, and still inspect that job and recent ones. Jobs are persisted to
`data/`, so a Tmuxifier restart doesn't lose history.

Each box's command runs once in a fresh, non-interactive login shell over the **existing one-shot
SSH path** (`buildProbeArgv` + `sshRun`), so output is captured. This means it works on key-auth
boxes (or boxes with a live ControlMaster); a password-only box with no live connection returns a
per-box error row rather than hanging — the same way the status probe already classifies such
boxes. The fan-out is rate-limited so a fleet run never bursts SSH connections and trips host-side
port-22 bans.

## Behavior

A **Fleet** toggle in the sidebar header enters selection mode:

- Checkboxes appear on every box and on every tag-group header. A group header checkbox is
  **tri-state**: checked / unchecked / indeterminate (some children selected). Toggling a group
  header selects or clears all boxes in that group.
- A **command bar** slides in: a single-line command input, a **recent-history** dropdown (the
  last ~10 fleet commands, stored in `localStorage`), and a **Run on N** button whose label shows
  the live selected-box count.
- Exiting fleet mode clears the selection and restores the normal single-click-to-open sidebar.
  Selection state is separate from `activeBoxId`; the live terminal is untouched by fleet mode.

Clicking **Run on N** opens a **confirmation dialog** showing the exact command and the resolved
list of target boxes (label + host). It always appears — one click can hit the whole fleet.
Confirming creates the job and opens the **jobs panel**.

The jobs panel has two parts:

- **Active/most-recent job** — per-box rows that start `running` and flip to `ok` (green, exit 0),
  `error` (red, non-zero exit, ssh failure, timeout, or needs-auth/unreachable), `cancelled`, or
  `interrupted`. Each row shows the exit code and an expandable stdout/stderr view. While the job
  is `running` the panel polls every **1.5 s**; polling stops when the job is finished. A
  **Cancel** button stops launching not-yet-started boxes.
- **History** — a list of recent jobs (command, target count, status, time). Selecting one shows
  its full results. This is what a reopened browser uses to find a job submitted before the tab
  closed.

A job's overall `status`:

- `running` — at least one target still `pending`/`running`.
- `done` — every target reached a terminal state. `done` even if some boxes errored (per-box
  results carry the detail).
- `cancelled` — the user cancelled; queued targets are `cancelled`, already-finished ones keep
  their result, in-flight ones finish under their own timeout.
- `interrupted` — the server restarted while the job was `running` (see reconciliation below).

## Architecture

Factory functions with injected dependencies, matching the existing server modules.

### Remote exec primitive — `boxActions.execCommand`

`createBoxActions` (`src/server/boxActions.js`) gains a new method:

```
execCommand(box, command, { timeoutMs }) -> Promise<{ code, stdout, stderr }>
```

It builds `buildProbeArgv(box, command, …)` and calls the injected `run` (`sshRun`). This reuses
the established non-interactive path: `BatchMode=yes`, `ConnectTimeout`, ControlMaster reuse, and
`sshRun`'s never-reject `execFile('ssh', argv)` wrapper.

**Quoting:** the user's `command` is passed **verbatim as the final ssh argv element** and is *not*
single-quoted. The whole string is meant to be interpreted by the remote login shell (e.g.
`df -h /`), and because `sshRun` uses `execFile` (no local shell), there is no local
command-injection surface — `command` is one opaque argv element locally regardless of the
metacharacters in it. Box fields (`host`/`user`/`port`/`proxyJump`) remain validated by
`assertBoxSafe` inside `buildProbeArgv`. This differs from `startupCommand`/`buildKillTmuxRemote`,
where a *value* is embedded inside a larger remote command and so must be `shSingleQuote`d; here the
command *is* the whole remote command, so quoting it would wrongly turn it into a single literal
program name.

`runRemote` (currently internal to `createBoxActions`) is the existing combiner of
`buildProbeArgv` + `run`; `execCommand` is a thin public wrapper over the same idea with a
caller-supplied command and timeout. It is added to the object `createBoxActions` returns.

### Job manager — `src/server/fleet.js`

```
createFleetManager({
  store, execCommand, load, save, now,
  concurrency = 4, timeoutMs = 15000, maxJobs = 50, maxOutputBytes = 65536,
}) -> { createJob, getJob, listJobs, cancelJob }
```

- **`createJob({ boxIds, command })`** — resolves each `boxId` via `store.getBox` (snapshotting
  `label`/`host` into the job so it stays meaningful if the box is later renamed/removed), builds
  the job with all targets `pending`, persists it, and starts the async runner. Returns the
  initial job immediately (does **not** await the run).
- **Runner** — fans out across targets through a **bounded-concurrency limiter** (default 4,
  reusing the `mapWithConcurrency` helper that already protects the status poller from SSH bursts).
  The per-target function first checks the job's `cancelled` flag and short-circuits to a
  `cancelled` row if set — so cancellation works *on top of* `mapWithConcurrency` (queued targets
  skip themselves when their slot opens) without modifying that shared helper. Otherwise it marks
  the target `running`, calls `execCommand(box, command, { timeoutMs })`, captures
  `{ code, stdout, stderr }` (each stream capped to `maxOutputBytes`, setting `truncated: true`
  when clipped), classifies `ok` (exit 0) vs `error` (non-zero / thrown / timeout), and persists
  the job. When all targets are terminal, the runner sets the job `status` and `finishedAt` and
  persists. The whole runner is wrapped so that any *unexpected* error finalizes the job (status
  `done`, remaining targets `error`) rather than leaving it stuck `running` — the run is a
  fire-and-forget promise off `createJob`, so it must never leave a job dangling.
- **`getJob(id)` / `listJobs()`** — read from the in-memory registry (authoritative for live
  polling). `listJobs` returns lightweight summaries (no full output).
- **`cancelJob(id)`** — sets a per-job `cancelled` flag the runner checks before launching each
  queued target; queued targets become `cancelled`. In-flight `execCommand` calls finish under
  their own `timeoutMs`. Persists.

The in-memory registry is the source of truth for polling. `save` is called at meaningful
checkpoints — job create, each target completion, and job finish — so durability cost is ~O(targets)
writes per job, not one per status transition.

### Persistence — `data/fleet-jobs.json`

`load`/`save` are injected (tests pass in-memory implementations). The real implementations
read/write **`data/fleet-jobs.json`**, pruned to the most recent `maxJobs` (50) by `createdAt`. The
whole `data/` directory is already gitignored (it holds `boxes.json` and the ControlMaster
sockets), so no new `.gitignore` entry is needed; the file is created at runtime and holds only run
history, so it needs no placeholder counterpart. A one-line mention in the self-contained section
of `CLAUDE.md`/`AGENTS.md` keeps the inventory of `data/` files current.

**Startup reconciliation:** on construction, `createFleetManager` loads persisted jobs; any job
still `running` is set to `interrupted` and its non-terminal targets to `interrupted` (their ssh
children died with the previous process), then the reconciled set is persisted once.

### Wiring — `src/server/index.js`

`index.js` constructs the real `load`/`save` (pointing at `data/fleet-jobs.json`), creates the
fleet manager with config-derived options, and passes it into `buildServer`.

## Job data model

```jsonc
{
  "id": "uuid",
  "command": "df -h /",
  "status": "running",                 // running | done | cancelled | interrupted
  "createdAt": "ISO",
  "startedAt": "ISO",
  "finishedAt": "ISO | null",
  "concurrency": 4,
  "timeoutMs": 15000,
  "targets": [
    {
      "boxId": "uuid",
      "label": "web-01",               // snapshot at run time
      "host": "192.168.1.10",          // snapshot at run time
      "status": "pending",             // pending | running | ok | error | cancelled | interrupted
      "code": null,                    // exit code when known
      "stdout": "",                    // capped to maxOutputBytes
      "stderr": "",                    // capped to maxOutputBytes
      "truncated": false,              // true if either stream was clipped
      "error": null,                   // human-readable reason for error rows (timeout, ssh failure, needs-auth)
      "startedAt": "ISO | null",
      "finishedAt": "ISO | null"
    }
  ]
}
```

## REST API

All routes require auth (`preHandler: requireAuth` → 401). State-changing routes are also covered
by the existing `requireTrustedOrigin` CSRF/Origin hook (→ 403) and the `no-store` `/api/*` header.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/fleet/jobs` | `{ boxIds: string[], command: string }` | the created job (targets `pending`) |
| `GET` | `/api/fleet/jobs` | — | array of job summaries, newest first |
| `GET` | `/api/fleet/jobs/:id` | — | the full job (poll target) |
| `POST` | `/api/fleet/jobs/:id/cancel` | — | the updated job |

**Validation on `POST /api/fleet/jobs`** (→ 400): `command` is required, non-empty after trim, and
within a max length; `boxIds` is a non-empty array and every id resolves via `store.getBox`. A
missing/unknown job id on `GET :id` / cancel → 404.

## Config

New knobs in `src/server/config.js` (env prefix `TMUXIFIER_FLEET_`), documented in `.env.example`
and `README.md`:

| Config key | Env var | Default |
| --- | --- | --- |
| `fleetConcurrency` | `TMUXIFIER_FLEET_CONCURRENCY` | `4` |
| `fleetTimeoutMs` | `TMUXIFIER_FLEET_TIMEOUT_MS` | `15000` |
| `fleetMaxJobs` | `TMUXIFIER_FLEET_MAX_JOBS` | `50` |
| `fleetMaxOutputBytes` | `TMUXIFIER_FLEET_MAX_OUTPUT_BYTES` | `65536` |

`loadConfig` stays pure/injectable — parsed from the injected `env`, never `process.env` directly.

## Web client (`src/web/`)

- **State:** a `fleetMode: boolean` and a `selected: Set<boxId>`, kept separate from
  `activeBoxId`. Entering fleet mode re-renders the sidebar with checkboxes; exiting clears
  `selected`.
- **Selection logic (extracted, pure, unit-tested):** a small module (mirroring `statusDot.ts` /
  `reconnect.ts`) with helpers to toggle a box, toggle a whole group, and derive a group's
  tri-state from its children. `main.ts` wires DOM events to these helpers and reflects results.
- **Command bar:** input + recent-history dropdown + **Run on N** button. The recent-history
  helper (also pure/unit-tested) reads/writes a capped, de-duplicated list in `localStorage`.
- **Confirm dialog:** shows the command and resolved targets; Run / Cancel.
- **Jobs panel:** renders the active job's per-box rows with status badges, exit codes, and
  expandable stdout/stderr; polls `getFleetJob(id)` every 1.5 s while `running` and stops when
  finished; has a Cancel button. A history list (`listFleetJobs`) lets a reopened browser pick any
  recent job and view its results.
- **`api.ts`:** `createFleetJob(boxIds, command)`, `getFleetJob(id)`, `listFleetJobs()`,
  `cancelFleetJob(id)`, plus the `FleetJob`/`FleetTarget` types.

## Data flow

```
Fleet toggle ─▶ sidebar renders checkboxes ─▶ selected: Set<boxId>
Run on N ─▶ confirm dialog ─▶ POST /api/fleet/jobs {boxIds, command}
                                  └─▶ fleetManager.createJob ─▶ persists, returns job (pending)
                                          └─▶ runner: mapWithConcurrency(targets, 4)
                                                  └─▶ execCommand(box, cmd, {timeoutMs})
                                                        └─▶ buildProbeArgv + sshRun ─▶ capture + persist per target
browser ◀─ poll every 1.5s ─ GET /api/fleet/jobs/:id ◀─ in-memory registry (live)
Cancel ─▶ POST /api/fleet/jobs/:id/cancel ─▶ stop launching queued targets
server restart ─▶ load data/fleet-jobs.json ─▶ running jobs/targets ─▶ interrupted
reopened browser ─▶ GET /api/fleet/jobs ─▶ history list ─▶ GET :id ─▶ results
```

## Error handling

- **Per-box failure is normal, not fatal.** A thrown/failed `execCommand`, a non-zero exit, a
  timeout, or a needs-auth/unreachable box all become an `error` target row with a readable
  `error` string and (when available) `code`. The job still reaches `done`.
- **No SSH bursts.** Fan-out is capped at `fleetConcurrency` and reuses each box's ControlMaster
  socket. Fleet exec is non-interactive `BatchMode`, like the status probe, so it does not collide
  with the status poller the way an interactive login does.
- **Output is bounded.** Each stream is capped at `maxOutputBytes` (`truncated` flagged), keeping
  `data/fleet-jobs.json` from growing without limit; pruning to `maxJobs` bounds it further.
- **Restart safety.** Running jobs become `interrupted` on startup; their orphaned ssh children
  are already dead with the old process.
- **Unknown ids** are 404; **bad input** is 400; **cancel on an already-finished job** is a no-op
  returning the job as-is.

## Testing

TDD, real code + dependency injection, no mocking library (per repo convention).

- **`test/fleet.test.js`** — `createFleetManager` with a scripted `execCommand` stub (records call
  order/args, returns sequenced results) and injected `now` / in-memory `load`+`save`:
  - fan-out respects `concurrency` and captures `{ code, stdout, stderr }` per box;
  - non-zero exit / thrown call / timeout produce `error` rows; job still reaches `done`;
  - output beyond `maxOutputBytes` is clipped with `truncated: true`;
  - pruning keeps only the most recent `maxJobs`;
  - `cancelJob` stops launching queued targets (they become `cancelled`); already-finished targets
    keep results;
  - `save` is called at create / per-target-completion / finish;
  - startup reconciliation turns a persisted `running` job (and its non-terminal targets) into
    `interrupted`.
- **`test/server.test.js`** — routes via `makeApp` + `login` + `app.inject`, with a fleet-manager
  stub recording calls: 401 unauth and 403 bad-Origin on the POST/cancel routes; 400 on empty
  command and on unknown `boxId`; happy-path create returns a `pending` job; `GET` list/detail; 404
  on unknown id; cancel forwards to the manager.
- **`test/boxActions.test.js`** (or `test/sshCommand.test.js`) — `execCommand` builds argv with the
  command as the verbatim final element and `assertBoxSafe` enforced (unsafe box rejected).
- **`test/fleet.integration.test.js`** — real ssh to localhost via the `localBox` helper and a real
  `createBoxActions({ run: sshRun })`: `echo hi` → stdout `hi`, exit 0; `false` → exit 1 `error`
  row.
- **E2E (`test/e2e`)** — toggle fleet mode, select boxes (incl. a group header), run, confirm, see
  results fill in; reload the page and find the job in history with its results.

## Out of scope (deferred)

- Saved/named command presets (server-side library). Recent-history in `localStorage` covers the
  common case; presets can be layered on later without changing the job model.
- Streaming results (SSE/WebSocket). Polling the job at 1.5 s gives live-enough progress for a
  small fleet at concurrency 4; the job model already supports adding a stream later without
  changing the client contract.
- Running the command *inside* each box's existing tmux session (`tmux send-keys`). This is a
  different product (no captured output, shares the live session); the chosen one-shot exec model
  captures output, which was the requirement.
