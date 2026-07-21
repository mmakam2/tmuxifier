# Server-side AI-auth seed trigger — design

**Date:** 2026-07-21
**Status:** approved, ready for an implementation plan
**Supersedes (partially):** the browser-coupled seed trigger shipped with
`docs/superpowers/specs/2026-07-18-ai-auth-seeding-design.md`, recorded there as known debt.

## Problem

AI-auth seeding copies the Tmuxifier host's Claude/Codex CLI credentials onto a freshly set-up
box. The copying already runs server-side — `aiAuthSeed.js` sends the secrets stdin-only over the
shared ControlMaster, and nothing about that changes here. What is browser-coupled is the
*trigger*: the seed fires only because a live browser tab is polling the setup job, sees
`status === 'done'`, and then calls `POST /api/boxes/:id/seed-ai-auth` itself.

Two call sites do this today:

- `src/web/main.ts:1110-1130` — the provision panel used by the Add/Edit Box flow.
- `src/web/proxmoxUi.ts:167-173` — the Proxmox hub's Provision tab.

Consequences of the trigger living in the tab:

1. **Silent skip.** Close the tab (or lose the network, or navigate away) before the setup job
   reaches `done` and the seed never runs. Nothing is recorded anywhere — no log line, no field,
   no event. The box simply lacks credentials, and the only way to notice is to SSH in and find
   the CLI asking you to log in.
2. **No record either way.** Even on the happy path the outcome exists only as text painted into
   a panel that auto-closes five seconds later. Nobody can answer "did this box get seeded?"
   afterwards.

This matters more now than when the debt was logged: as of 2026-07-21 both host credentials are
in place on this deployment (`TMUXIFIER_CLAUDE_OAUTH_TOKEN` in `.env`, `~/.codex/auth.json`
present), so seeding actually does something. Before that, every seed reported skips by design
and the missing trigger was invisible.

This is the same move box setup itself already made in v1.7.2: browser-driven → server-side
job. Seeding is the last trigger left over from before that change.

## Goals

- Seeding fires whenever a setup job that asked for it reaches `done`, with no browser involved.
- The per-target outcome is recorded on the job, so it is inspectable after the fact.
- A failed or skipped seed never turns a successfully set-up box into a failure.
- Both routes to `done` seed — including the sudo-password interactive path.

## Non-goals

- Changing how credentials are transported or which credentials exist. `aiAuthSeed.js` is
  untouched.
- Notifications. A seed failure does not become a health event (considered and dropped: it would
  pull in `healthHistory.js` and `notifyPrefs.ts` for a case the job record already answers).
- A "Seed now" button that re-seeds an existing box without re-running setup. Considered; it is
  new UI surface beyond the bug being fixed. The route stays available for it later.
- A generalized post-setup step pipeline. There is exactly one post-setup step and no concrete
  candidate for a second.

## Decisions

| Question | Decision |
|---|---|
| Scope | Reliability **and** a recorded outcome — a new persisted field on the setup job. |
| Interactive path | Seeds too. Both routes to `done` go through one function. |
| Seed failure | Recorded; job stays `done`. No new status, no automatic retry. |
| `POST /api/boxes/:id/seed-ai-auth` | Kept, with no UI caller. |
| Ordering | Seed runs **before** the job flips to `done`, under a new `seeding` phase. |
| Wiring | `seed` and `getBox` injected into `createSetupManager` (approach A of three). |

### Why seed-then-done, rather than done-then-append

`setupPoller.ts` stops polling the moment it reads a terminal status — the panel callbacks return
`null` on `done`. If the job reached `done` first and the seed result landed a few seconds later,
every consumer would have to keep polling *past* a terminal status just to catch it, which
reintroduces a timing race very close to the one being fixed. Seeding first means the poller sees
`done` exactly once, with everything already attached.

The cost is that `done` now means "set up, and the seed was attempted", arriving a few seconds
later than before. That is the honest meaning for a job that was asked to seed.

### Why injection rather than a callback seam

The rejected alternative kept `setupManager` ignorant of AI auth via an `onDone(cb)` seam plus a
`recordSeed(jobId, result)` write-back, with `index.js` owning the seeder. The ignorance is
nominal: the result still has to round-trip back in to be persisted, the `seeding` phase still has
to be driven from outside, and the interactive path still needs someone to own the async
orchestration. Roughly double the plumbing for a boundary that does not actually hold.

Injection matches what the file already does — `sshStream`, `buildScript`, and `probe` are all
injected — and matches `index.js:165`, which already injects `startSetup` into
`proxmoxProvision` in exactly this shape.

## Architecture

`createSetupManager` gains two dependencies, both defaulting to `null`:

```js
createSetupManager({ /* … existing … */ seed = null, getBox = null })
```

`index.js` wires them alongside the existing injections:

```js
seed: (box) => aiAuthSeeder.seed(box),
getBox: (id) => store.getBox(id),
```

Defaulting to `null` means the step is skipped entirely when nothing is wired, so every existing
construction of the manager — including all current tests — behaves exactly as it does today.

### The single completion path

One new internal function becomes the only place a job becomes `done`:

```js
async function completeDone(j, box) {
  if (seed && j.options.seedAiAuth && box && !j.cancelled) {
    j.phase = 'seeding'; persist();
    try { j.seed = await seed(box); }
    catch { j.seed = [{ target: 'all', ok: false, error: 'seed failed' }]; }
  }
  finish(j, 'done');
}
```

Both routes to `done` call it:

- **`run()`** — replaces the `finish(j, 'done')` on `code === 0` (setupManager.js:138). Already
  holds `box`.
- **`markInteractiveResult(boxId, 0)`** — obtains the box via `await getBox(boxId)`. Fetching
  fresh rather than snapshotting the box onto the job keeps host/user/port out of
  `data/setup-jobs.json` and survives an edit between job start and interactive finish.

`markInteractiveResult` stays fire-and-forget from its caller's perspective: server.js:1288 calls
it from a PTY exit handler that cannot await. The promise is registered in the existing `settles`
map so `_settled(id)` continues to make tests deterministic.

### Re-entrancy guard on the interactive path

`markInteractiveResult` currently guards on `j.status === 'needs-interactive'`. Once it awaits,
that status persists across `getBox()` and `seed()`, so a second PTY exit event arriving in that
window would re-enter and seed twice.

It therefore flips `j.status = 'running'; j.phase = 'seeding'` **synchronously, before the first
await**. That closes the guard and is also the honest status: a seed really is in flight, and the
poller keeps polling rather than stopping early.

### Flag plumbing

Three touch points carry `seedAiAuth` from the client to the job:

1. `normalizeOptions` (setupManager.js:76) keeps `seedAiAuth: !!o.seedAiAuth`. It currently drops
   the flag — this is the layer where the flag dies today.
2. `POST /api/boxes/:id/setup` (server.js:851) adds `seedAiAuth: !!b.seedAiAuth` to the options
   object it builds.
3. The provision path needs **no** change. `createProvision` passes `req.body` through and
   `proxmoxProvision.js:142` already calls `startSetup(box, j.setupOptions, …)` with whatever the
   client sent; only `normalizeOptions` was eating it.

### Reading it back

`summary()` gains `seed`, so `GET /api/setup` carries it. `GET /api/setup/:id` and
`GET /api/boxes/:id/setup` return the raw job object and expose it with no change.

### Client

Both poll callbacks drop their `api.seedAiAuth(...)` call, along with the `seeded` latches and —
in `main.ts` — the generation guards that existed only to protect that in-flight request. They
render `job.seed` instead.

The `claude ✓ · codex skipped (…)` string is currently built by a duplicated inline
`.map().join(' · ')` at both sites. It moves to one pure helper in `setupStatus.ts`, which is
where the other shared pure setup-status helpers already live, and where it can be unit-tested.

`api.seedAiAuth` and its route stay, uncalled by the UI.

## Persistence and redaction

`j.seed` holds the seeder's return value verbatim:

```js
[{ target: 'claude', ok: true },
 { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' }]
```

That array is redacted by construction. Every field in it is a fixed target name, a boolean, one
of three hardcoded skip strings, or the literal `'seed failed'` (aiAuthSeed.js:65-87).
`execScriptStdin` captures ssh stderr into its own `error` field and the seeder discards it,
substituting the constant. So persisting this into `data/setup-jobs.json` introduces no new
secret at rest — the same reasoning the route already relies on to return `{ results }` to the
browser.

The file is already written `0o600` via `jsonFile.js`. Two bounded entries per job, nothing like
the 64 KB log, so `maxLogBytes` and the retention math are untouched. The field lives and dies
with its job; `retainedIds()` needs no change.

Backward compatible in both directions: jobs already in `setup-jobs.json` have no `seed` key,
read back as `undefined`, and render as nothing. The existing load guard (setupManager.js:41)
already skips malformed rows.

### Hang risk is already bounded downstream

`execScriptStdin` defaults `timeoutMs = 60000` (boxActions.js:452) and `sshRunStdin` SIGKILLs at
that deadline and *resolves* with code 124 rather than rejecting (sshRun.js:34-37). Worst case is
roughly 120 s across both targets, after which the seed reports failure and the job reaches `done`
normally. No new timeout is needed in `setupManager`, and no wedged seed can strand a job in the
non-terminal `seeding` phase — which matters, because non-terminal jobs are retained forever by
design.

## Error handling

| Case | Behavior |
|---|---|
| Seed rejects | Caught. `j.seed = [{ target: 'all', ok: false, error: 'seed failed' }]`, job still `done`. `target: 'all'` means the step died before per-target results existed. In practice `seeder.seed()` does not throw — it catches its own `readLocal` — so this is the unexpected-error net, not a normal path. |
| No seeder wired (`seed === null`) | Step skipped entirely. No `seed` field, `seeding` phase never appears. Mirrors the route's existing 503. |
| `options.seedAiAuth` false | Skipped. This is most jobs. |
| Second `markInteractiveResult(boxId, 0)` during the seed | Ignored — the synchronous status flip closes the guard. Seed runs exactly once. |
| Box deleted between `needs-interactive` and interactive finish | `getBox` returns null or throws; both caught. Seed skipped, job still flips to `done`. A missing box never strands a job. |
| Cancel during seeding | `cancelForBox` sets `j.cancelled` and kills the ssh handle, but `runningHandles` is empty by then (the setup ssh already exited), so the kill reaches nothing. `completeDone` checks `j.cancelled` before starting the seed and skips it — cancel usually means the box is being removed, and seeding a box on its way out is pointless. An already-in-flight seed cannot be killed; it is bounded at ~120 s by the transport. |
| Restart mid-seed | The job is `running`, so the existing load reconciliation flips it to `interrupted`. Slightly pessimistic — setup itself did succeed — but honest, since nobody knows whether the seed landed, and it matches what `running` already means across restarts. The existing Retry re-runs setup and seeds again. No new status, no new reconciliation rule. |
| Non-zero interactive exit | Unchanged: stays `needs-interactive`, no seed. |

## Testing

TDD, real code with injected fakes, no mocks — the DI factory is what makes this testable.

**`test/setupManager.test.js`** (extends the existing file, which already builds managers with
fake `sshStream`/`load`/`save`):

1. `seedAiAuth: true` with an injected `seed` → seed called once with the box; `j.seed` holds its
   return value; final status `done`.
2. Phase ordering — the job is observably `running`/`seeding` while the seed promise is pending,
   and only then `done`. Driven with a deferred `seed` fake. This is the whole point of the
   ordering decision.
3. `seedAiAuth: false` → seed never called, no `seed` field.
4. No seeder wired → `done`, no field, seed never called.
5. Seed rejects → `done` with the `all` failure marker. The job is **not** `error` — this is the
   "a bad seed never reds a good box" guarantee.
6. Interactive path: job reaches `needs-interactive`, `markInteractiveResult(boxId, 0)` →
   `getBox` consulted, seed ran, `done`. Awaited via `_settled(id)`.
7. Re-entrancy: two `markInteractiveResult(boxId, 0)` calls in the same tick → seed called
   **exactly once**. Must fail before the synchronous status flip exists.
8. `getBox` returns null → `done`, seed never called.
9. `j.cancelled` set before the seed starts → seed skipped, job still settles.
10. Round trip: `seed` survives `save()` → `load()` into a fresh manager.

**Routes:**

11. `test/setupRoutes.test.js` — `POST /api/boxes/:id/setup` with `seedAiAuth: true` reaches
    `setupManager.start` in the options. That file already uses a capturing fake manager.
12. `GET /api/setup` — `summary()` carries `seed`.

**Pure client helper:**

13. `test/setupStatus.test.js` — `formatSeedResults()`: all-ok, skip with reason, failure, empty
    array, and `undefined` → `''` (the old-job case).

**Existing coverage that must stay green, untouched:** every current `setupManager.test.js` case
(they construct managers with no `seed`, so they exercise case 4), and the four `seed-ai-auth`
route tests in `server.test.js` — the route survives, uncalled by the UI.

**Not unit-tested, by project convention:** the two client render sites. `main.ts` and
`proxmoxUi.ts` are DOM, and this repo deliberately tests pure helpers rather than adding jsdom.
`npm run typecheck` covers the shape change and the existing provision e2e exercises the panel.

**Manual check before release:** one real provision with the seed checkbox ticked. The last two
real seeding bugs (the `~/.claude.json` onboarding-flag merge, and the pre-existing-shell token
gap) were both found in the field, not by the suite.

## Files touched

| File | Change |
|---|---|
| `src/server/setupManager.js` | `seed`/`getBox` injections; `completeDone()`; `normalizeOptions` keeps `seedAiAuth`; `summary()` carries `seed`; `markInteractiveResult` becomes async with a synchronous status flip. |
| `src/server/index.js` | Wire `seed` and `getBox` into `createSetupManager`. |
| `src/server/server.js` | `POST /api/boxes/:id/setup` accepts `seedAiAuth`. |
| `src/web/setupStatus.ts` | New pure `formatSeedResults()`. |
| `src/web/main.ts` | Provision panel reads `job.seed`; drop the seed call, the `seeded` latch, and its generation guards. |
| `src/web/proxmoxUi.ts` | Same, for the hub's Provision tab. |
| `test/setupManager.test.js`, `test/setupRoutes.test.js`, `test/setupStatus.test.js` | Cases 1-13. |
| `CLAUDE.md` / `AGENTS.md` | `setupManager.js` description gains the seed step; the AI-auth-seeding line drops "browser-coupled". |

## Follow-ups explicitly deferred

- A "Seed now" button in the Edit Box modal, calling the retained route to re-seed without
  re-running setup.
- Back-porting the no-trailing-newline rc-append guard to `LOCAL_BIN_PATH_BLOCK` in
  `boxActions.js`.
- `execScriptStdin` error-branch tests and an ssh-integration test for the seed path.
