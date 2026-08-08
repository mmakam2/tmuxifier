# Post-setup script: run a saved Fleet Command script as the last step of setup

**Date:** 2026-08-08
**Status:** design, approved for planning

## Problem

Provisioning a Proxmox container ends with a curated but fixed set of work: tmux,
an optional shell framework, the tool catalog, AI-auth seeding, the Claude
statusline and agent-state hooks. Anything beyond that — the operator's own
bootstrap, whatever it is — has to be done by hand afterwards, or by remembering
to open Fleet Command and target the box that was just created.

The operator already has a place to keep that bootstrap: Fleet Command's saved
scripts (`data/fleet-scripts.json`). They are just not reachable from the one
moment they are most wanted.

## Goal

Select a saved Fleet Command script when provisioning a container, and have it
run on the box after everything else Tmuxifier installs.

## Non-goals

- Running more than one script per setup. One selection; a script that needs to
  do several things is one script.
- Per-preset script defaults. A preset-level default (and a per-run override on
  top of it) is a coherent later addition, but it is not this change — the ask
  is a per-run choice.
- A new script-authoring surface. Scripts are created and edited in Fleet
  Command's existing editor; this feature only *selects* one.
- Editing the selected script from the provision form.

## Key insight

Provisioning already delegates all post-create work to the setup manager.
`proxmoxProvision.js:181` calls `startSetup(box, j.setupOptions, { waitForSsh: true })`
and carries `setupOptions` through as an opaque blob, and
`setupManager.completeDone` runs an ordered post-install chain:

```
seeding → statusline → agent-hooks → ensureSession → done
```

"After all the other installations" is therefore not a new mechanism — it is one
more phase in that chain. The setup manager already has the streaming ssh
transport, the shared ControlMaster, a rolling capped log, a 10-minute timeout,
and a cancel path wired for exactly this shape of work.

Consequence: **`proxmoxProvision.js` needs no change whatsoever.**

## Decisions

Five settled during brainstorming, with the reasoning that settled them.

### 1. The picker lives in the shared setup options form

`setupOptions.ts`'s `createSetupOptionsForm` is rendered by both the Proxmox
hub's Provision tab and the Add/Edit Box modal, and both feed the same
`setupManager`. Putting the picker there is *less* code than a provision-only
field, and manually-added boxes gain the capability for free.

### 2. The script runs after agent-hooks, before `ensureSession`

```
install tools/frameworks
  ↓
seed AI auth
  ↓
push statusline
  ↓
push agent hooks
  ↓
▶ RUN SAVED SCRIPT
  ↓
ensureSession (tmux)
  ↓
done
```

A shell reads its rc files once, at startup. That is why `ensureSession` was
moved to the end of the chain in the first place (v1.13.0, see
`rc-seeding-session-ordering`), and a bootstrap script that touches
`.zshrc`/`.bashrc`/`.tmux.conf` is one of the likeliest things an operator will
put in one. Running the script before session creation means the box's first
shell sees the script's edits. Running it after would silently reintroduce the
exact bug that ordering exists to prevent.

Placing it after seeding likewise matters in the other direction: a script that
configures the Claude or Codex CLIs must not be overwritten by the seed that
follows it.

### 3. A failing script is recorded, never promoted to a job failure

Consistent with `seed`, `statusline` and `agentHooks`, all of which record and
never promote. Setup itself succeeded — tmux and the tools installed, the box is
usable, and marking it broken over the operator's own script would be wrong.
Promoting to `error` would also mean the existing Retry button re-runs the
*entire* setup (tools, frameworks, seeding) just to retry one script.

The mitigation for "easy to miss" is surfacing, not status: the result renders as
its own line in the provision/setup panel alongside the statusline and
agent-hooks lines, and the script's own output is already in the job log the
panel displays live.

### 4. Resolve by id at run time; freeze only the name

The job stores `{ scriptId, scriptName }`. `scriptName` is a frozen display
label — Fleet Command's own rule (`fleet.js`: dropped when blank or oversized,
never re-resolved), so renaming or deleting a script cannot rewrite what a past
job says it ran. The **body** is read from the store when the phase runs.

Rationale: a 64KB body copied into every persisted setup job would roughly
double `data/setup-jobs.json`, which already carries a 64KB log per job, for a
guarantee worth little here — the window between clicking Provision and the
script executing is minutes (create → start → discover → wait-for-ssh →
install), and an operator who edits the script inside that window almost
certainly wants the edit. A script deleted in that window records a skip.

### 5. Transport: a second `sshStream` call, not `execCommand`

The script body becomes the remote command, exactly as the main install script
already is, streamed over the shared ControlMaster via the manager's existing
`sshStream` + `buildSetupArgv`.

Rejected: `boxActions.execCommand` (the Fleet Command call) buffers, so the
operator watches a blank panel and then gets a dump, and its 15s default timeout
is wrong by two orders of magnitude for anything that runs `apt-get`. Also
rejected: enqueueing a one-target Fleet job — it inverts the dependency (setup
manager → fleet manager), settles independently of the setup job so the panel
cannot tell one coherent progress story, and inherits the same 15s problem.

## Architecture

```
Provision form (setupOptions.ts)  ──scriptId──▶  POST /api/proxmox/provisions
                                                        │ setupOptions (opaque)
                                                        ▼
                                                 proxmoxProvision.js   ← NO CHANGE
                                                        │ startSetup(box, setupOptions)
                                                        ▼
Add/Edit Box modal ──scriptId──▶ POST /api/boxes/:id/setup ──▶ setupManager.start()
                                                        │
                                          completeDone: seed → statusline → agent-hooks
                                                        │
                                                        ▼
                                            ▶ script phase: getScript(id) → sshStream
                                                        │
                                                        ▼
                                              ensureSession → done
```

## Server components

### `fleetScriptsStore.js`

Add `getScript(id)` → the record or `null`. It is the only read the store
lacks; `listScripts` is the sole current reader. No serialization needed (reads
stay free, per the store's existing rule).

### `setupManager.js`

The substance of the change.

**`normalizeOptions`** gains two fields:

- `scriptId` — a trimmed non-empty string, else `null`. Capped at 128
  characters defensively (an id is `fs-<uuid>`, 39); it is only ever a lookup
  key.
- `scriptName` — a frozen display label, trimmed, dropped when blank or longer
  than `MAX_NAME` (80). Never used for resolution.

**New injected dependency `getScript = null`.** Default `null` means the phase
is skipped entirely — which is what every existing construction in
`setupManager.test.js` already does, so no existing test needs to change. Same
default-null pattern as `seed`, `pushStatusline`, `pushAgentHooks`.

**New `script` phase in `completeDone`,** placed after the `agent-hooks` block
and before the `ensureSession` block, guarded exactly like its siblings:

```js
if (getScript && j.options.scriptId && box && !j.cancelled) {
  j.phase = 'script';
  persist();
  j.postScript = await runSavedScript(j, box);
}
```

**`runSavedScript(j, box)`** resolves the record, streams the body, and returns a
`SeedResult`-shaped object. It never throws — every failure mode below is a
returned value.

**Result shape.** `job.postScript` is a `SeedResult`:
`{ target, ok, skipped?, error? }`, where `target` is the script's name
(resolved record's name, falling back to the frozen `scriptName`, falling back
to `'script'`). This reuses the existing shape deliberately — `setupStatus.ts`'s
`formatStatuslineResult` is already documented as "target-generic", so the UI
formatter comes for free.

**`summary()`** gains `postScript: j.postScript ?? null`.

**Script output** is appended to the existing rolling job log — there is no
second copy of it on the result. The provision panel already renders that log
live.

**Targeted refactor.** The spawn/log-append/coalesced-persist/handle-register/
exit-code block inside `run()` is extracted to a shared
`streamRemote(j, script, box, { onStderr, timeoutMs })` helper that both `run()`
and `runSavedScript()` call. `run()` keeps its sudo/ssh-prompt stderr sniffing by
passing `onStderr`; the script phase passes none — a script hitting a sudo
prompt under BatchMode is a script failure, not a reason to park the job as
`needs-interactive`. Parking would block the box's terminal
(`blocksTerminal`/`setupStatus.ts` gate `running` only, but `needs-interactive`
carries a "needs sudo" badge and a Finish-interactively flow) over the
operator's own script, which is the wrong trade.

This extraction is in scope because it is the same six concerns in both places;
it is not a general refactor of the manager.

### `server.js`

- `POST /api/boxes/:id/setup` builds its `options` object by explicit field
  list, so `scriptId` and `scriptName` must be added there. This is exactly the
  omission class the `setupStartPayload` comment in `setupOptions.ts`
  memorializes (the Add/Edit Box modal's statusline checkbox that silently did
  nothing) — the route is the one remaining hand-written field list on this
  path.
- `NO_FLEET_SCRIPTS` gains `getScript: async () => null`.

### `index.js`

`getScript: (id) => fleetScriptsStore.getScript(id)`, passed to
`createSetupManager`. It must be a late-bound closure: `setupManager` is
constructed at line 131 and `fleetScriptsStore` at line 191. The arrow body only
runs later, after both exist — the same trick the `startSetup:` thunk at line
213 already uses in this file.

### `proxmoxProvision.js`

No change. `setupOptions` is already carried through opaquely and handed to
`startSetup`.

## Error handling

| Case | `job.postScript` | Job status |
|---|---|---|
| Script exits 0 | `{ target: name, ok: true }` | `done` |
| Script exits non-zero | `{ target: name, ok: false, error: 'exited 2' }` | `done` |
| Timed out (`taskTimeoutMs`, 10 min) | `{ target: name, ok: false, error: 'script timed out' }` | `done` |
| Script deleted between select and run | `{ target: frozen name, ok: false, skipped: 'saved script no longer exists' }` | `done` |
| Store read throws | `{ target: frozen name, ok: false, error: 'saved script could not be read' }` | `done` |
| ssh transport error | `{ target: name, ok: false, error: <message> }` | `done` |
| Job cancelled before the phase | phase skipped, field absent | `done` |
| Job cancelled during the phase | in-flight handle killed via `runningHandles`, result records the non-zero exit | `done` |

The two cancel rows are existing behaviour, not new: a cancel arriving during
`completeDone` has no main-script handle left to kill, so it only skips the
remaining `!j.cancelled`-guarded steps and the job still reaches `done`. The
script phase inherits that unchanged.

The whole phase is wrapped so it can never reject: a `try/catch` around
`runSavedScript` in `completeDone` mirrors the `seed`/`statusline`/`agentHooks`
guards, and its catch records a generic failure rather than echoing the
rejection.

## Security

`scriptId` is only ever a **lookup key** against `fleetScriptsStore` — nothing
user-typed reaches a shell through it. A non-matching id resolves to nothing and
records a skip. This is the same chokepoint discipline `iconCatalog.js` and
`voiceCatalog.js` apply to their allowlists: the untrusted string selects from a
closed set rather than being interpolated.

The script **body** rides ssh argv as the final element, exactly as Fleet
Command's `command` already does over the same transport, and `assertBoxSafe`
(inside `buildProbeArgv`, via `buildSetupArgv`) still validates every connection
field. The body cap is `MAX_SCRIPT` (65536), already enforced at save time and
already equal to what `POST /api/fleet/jobs` accepts.

`data/fleet-scripts.json` stays unsealed, unchanged: a script body holds no
credential class Tmuxifier manages, and the same text is already persisted in
Fleet job history.

Note the trust boundary this does *not* move: a saved script already runs on the
whole fleet through Fleet Command. Running one on a box being provisioned grants
no capability the operator did not already have.

## Web components

### `setupOptions.ts`

`SetupOptionsValues` gains `scriptId: string | null` and
`scriptName: string | null`.

A new "Post-setup script" `section(...)`, last in the form after "AI auth
seeding":

- A `<select>` populated from `fleetScripts.list()`, first option "None"
  (value `''`), then one option per script sorted by `sortScripts`.
- Beneath it, the selected script's `description` as muted `.seed-status` text,
  updated on change — reusing the idiom the seed rows already use.
- A one-line hint naming when it runs: after tools, frameworks and AI-auth
  seeding, before the tmux session is created.

Degradation matches the existing seed-status posture (fetch on creation, degrade
in place):

- Fetch fails → the select is disabled and reads "saved scripts unavailable".
- Empty list → the select is disabled and reads "No saved scripts — create one
  in Fleet Command", rather than presenting an empty dropdown.

`values()` returns the selected id and its name (both `null` for "None").
`setupStartPayload` spreads, so `main.ts`'s `openProvisionPanel` and
`proxmoxUi.ts`'s `renderProvision` need **no** call-site change beyond types.

### `setupStatus.ts`

- `setupStatusText`: `phase === 'script'` → `'Running saved script…'`.
- `formatStatuslineResult` is reused verbatim for `postScript` — no new
  formatter.

### Panels

`main.ts`'s provision panel and `proxmoxUi.ts`'s job panel already render the
statusline and agent-hooks result lines; `postScript` gets a line in the same
place, with the error tone when `ok` is false.

### `api.ts`

`SetupJob` gains `postScript: SeedResult | null`.

## Testing

Vitest is node-env with no DOM (`vitest-has-no-dom`), so the new `<select>` is
covered through the pure `values()` seam, not by rendering it.

**`test/setupManager.test.js`**

- The script phase runs after `pushAgentHooks` and strictly before
  `ensureSession` (assert call ordering, the thing decision 2 exists to
  guarantee).
- No `scriptId` → `getScript` is never called and `postScript` stays null.
- `getScript` unwired (default `null`) → phase skipped even with a `scriptId`
  set, so existing constructions are unaffected.
- Deleted script → `skipped` recorded, job reaches `done`, no ssh attempted.
- Non-zero exit → `ok: false` with the exit code, job still reaches `done`, and
  `ensureSession` still runs.
- Script stdout/stderr lands in `job.log`.
- Cancel during the phase kills the handle.
- The phase also runs on the `markInteractiveResult` path (shared
  `completeDone`).

**`test/fleetScriptsStore.test.js`** — `getScript` returns the record, `null` for
an unknown id.

**`test/setupRoutes.test.js`** — `scriptId`/`scriptName` round-trip through
`POST /api/boxes/:id/setup` into the started job's options.

**`test/setupStatus.test.js`** — the `script` phase string.

**`test/setupOptions.test.js`** — `values()` and `setupStartPayload` carry the
new fields.

**Live validation** (per CLAUDE.md's ship workflow): provision a real container
from a preset with a saved script selected, confirm the script's output appears
in the provision panel log, that it ran after the tool installs, and that the
box's first tmux shell reflects an rc edit the script made.

## Out of scope / possible follow-ups

- Preset-level default script with a per-run override.
- Multiple scripts per setup, or an ordered list.
- Re-running just the script from the setup panel (today: run it from Fleet
  Command against that box).
- Surfacing the run in Fleet Jobs history.
