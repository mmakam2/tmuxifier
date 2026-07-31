# Fleet Command saved scripts — design

**Date:** 2026-07-31
**Status:** approved, not yet implemented

## Problem

Fleet Command can already run a multi-line bash script across selected boxes: the fleet bar's
`⤢` button opens a CodeMirror modal whose text is sent verbatim to each box's login shell. But
nothing written there survives. The in-progress buffer lives in one module-level variable
(`fleetScriptDraft` in `src/web/main.ts`) that is cleared on run and on leaving fleet mode, and
the only durable memory is `fleetHistory.ts` — the last ten *one-line* commands, in
`localStorage`, unnamed and per-browser.

So a script the operator has tuned over several runs — the one that prunes docker, or collects a
disk report across the fleet — has to be retyped, kept in another window, or reduced to a single
line to survive as a recent command. This design adds named, persisted scripts.

## Scope

In scope: a server-side store of named scripts, CRUD routes, management inside the existing
fleet script modal, and a script-name label on the resulting fleet job.

Explicitly out of scope (considered and cut):

- **Default targets on a script.** A script would remember which boxes it usually runs on. Cut:
  it adds a vanished-box pruning problem for a convenience that box selection already covers.
- **A quick-run dropdown in the fleet bar.** Running a saved script without opening the editor.
  Cut: the editor is one click away and is where the script's text can actually be reviewed
  before it runs on the fleet.
- **Duplicate / Save-as.** Cloning a script under a new name as a starting point. Cut as YAGNI:
  copying the body into a new draft is two keystrokes away, and the alternative is a second
  save verb whose difference from the first is easy to misclick.
- **Categories or grouping.** Cut: a flat list is adequate at the scale a single operator's
  script collection reaches.
- **Replacing the recent-command history.** `fleetHistory.ts` stays exactly as it is. It solves
  a different problem — unnamed, throwaway one-liners typed minutes ago — while saved scripts
  are named and deliberate.

## Data model

New file `data/fleet-scripts.json`, joining the other per-repo runtime state under `data/`
(the self-contained principle: nothing new outside the repo folder).

```js
{ id, name, description, script, createdAt, updatedAt }
```

| Field | Rules |
| --- | --- |
| `id` | `randomUUID()`, server-minted |
| `name` | required, trimmed, ≤ 80 chars, unique case-insensitively |
| `description` | optional, trimmed, ≤ 200 chars |
| `script` | required, non-empty after trim, ≤ 65536 bytes |
| `createdAt` / `updatedAt` | ISO timestamps, server-set |

The 65536-byte body cap is deliberately the same limit `POST /api/fleet/jobs` already enforces
on `command`, so a script that can be saved can always be run. The store holds at most 200
scripts.

Absent file reads as an empty list; there is no migration.

## Server

### `src/server/fleetScriptsStore.js`

`createFleetScriptsStore({ dataDir })`, in the mold of `createServicesStore`:

- persistence through `readJson`/`writeJson` from `jsonFile.js` — atomic temp-file + rename,
  `0o600`, an unparseable file quarantined to `<file>.corrupt-<timestamp>` rather than silently
  read as empty;
- normalize and validate inside the store, so the route layer stays thin;
- mutations through the same `serialize(op)` seam `store.js` and `servicesStore.js` use, so two
  concurrent read-modify-write cycles cannot drop each other's change.

API: `listScripts()`, `addScript(raw)`, `updateScript(id, patch)`, `removeScript(id)`.
`listScripts` returns newest-updated first.

Name uniqueness is checked on both add and rename, case-insensitively, and the check excludes
the record being updated so re-saving a script under its own name is not a conflict.

### Routes (`src/server/server.js`)

All four behind `preHandler: requireAuth`, mirroring the `/api/services` block:

```
GET    /api/fleet/scripts        -> 200, list
POST   /api/fleet/scripts        -> 201, record
PATCH  /api/fleet/scripts/:id    -> 200, record   (name / description / script)
DELETE /api/fleet/scripts/:id    -> 200, { ok: true }
```

Validation errors surface as `400` with the store's message; an unknown id is `404`.

### Job provenance

`POST /api/fleet/jobs` accepts an optional `scriptName` (string, ≤ 80 chars, ignored when blank
or oversized rather than rejected). `fleetManager.createJob` records it on the job and
`summarize` re-exports it, so a Fleet Jobs history row can print `apt upgrade` instead of the
script's raw first line.

It is a **label only**. The server never re-resolves it against the script store, so renaming or
deleting a script cannot change what a past job says it ran — the same reasoning that freezes a
job target's `label` and `host` at creation time.

## Client

Two new modules, keeping the work out of `main.ts` (already 2556 lines):

- **`src/web/fleetScripts.ts`** — the fetch layer (`listScripts`, `createScript`,
  `updateScript`, `removeScript`) in the mold of `netbox.ts` / `voice.ts`, plus the pure helpers
  `sortScripts`, `isDirty(selected, buffer)` and `validateName(name, existing)`.
- **`src/web/fleetScriptRail.ts`** — the rail's DOM layer with an in-place `update()`, the same
  shape as `paneHeader.ts`: it rewrites rows in place so a repaint never disturbs focus in the
  editor beside it.

`main.ts`'s `openFleetScriptEditor` grows a rail mount, name and note fields, and Save/Delete
actions. No new fleet-bar button: `⤢` already opens this modal, and the rail is now always in it.

### Layout

```
┌─ Fleet script ─────────────────────────────────────┐
│ SAVED           │ [name………] [note……………………]        │
│ ▸ apt upgrade   │ ┌────────────────────────────┐   │
│ ▸ docker prune •│ │ #!/usr/bin/env bash        │   │
│ ▸ disk report   │ │ set -euo pipefail          │   │
│ [+ New]         │ └────────────────────────────┘   │
├─────────────────┴──────────────────────────────────┤
│ box-a • box-b            [Delete] [Save] [Run on 2]│
└────────────────────────────────────────────────────┘
```

The name and note fields are bound to the current selection. One mechanism therefore covers both
naming a new script and renaming an existing one, and there is no separate rename dialog. A `•`
marks a dirty row. With no scripts saved, the rail shows an empty-state line rather than a blank
column.

Styling follows `DESIGN.md` and reuses the existing modal idioms rather than introducing a new
panel treatment.

### Flows

1. **Select** — clicking a row while the buffer is dirty opens a confirm modal ("Discard unsaved
   changes?" / Discard / Cancel). A clean buffer switches with no gate.
2. **Save** — `PATCH` when a saved script is selected, `POST` when the buffer is the unnamed
   draft. An empty name blocks with an inline error; a duplicate name is refused by the store and
   surfaced the same way. Bound to `Mod+S`, which also swallows the browser's save dialog.
3. **Delete** — a per-row control driven by the shared `arming.ts` reducer: first click arms,
   second commits, anything else disarms. This is the same policy the Proxmox lifecycle keys and
   all three Reconnect buttons use, so the destructive control behaves the way the rest of the UI
   has taught the operator to expect. No additional confirm modal.
4. **Run** — the existing path, plus `scriptName` **only when the buffer exactly equals the saved
   body**. A dirty buffer runs nameless rather than claiming to be a script it no longer is.
5. **Draft** — `fleetScriptDraft` keeps its current job: the unnamed buffer, in memory, cleared
   on run or on leaving fleet mode.

The Fleet Jobs panel prints `job.scriptName` when present and falls back to today's first-line
preview otherwise.

## Error handling and edge cases

- **Script deleted in another tab while selected here** — the save returns `404`; the buffer
  demotes to the unnamed draft with an inline message, so the operator's text is never discarded
  by someone else's delete.
- **Concurrent edits from two tabs** — last write wins. No CAS or versioning: this is a
  single-operator tool, and the failure mode (losing one edit to your own second tab) does not
  justify a conflict-resolution UI.
- **Rename after a run** — past jobs keep their frozen label.
- **Oversized or blank `scriptName` on a job** — ignored, not an error. Provenance is a
  convenience and must never be able to fail a run.
- **Corrupt `data/fleet-scripts.json`** — quarantined by `jsonFile.js` and read as empty, the
  same behaviour every other `data/` store has.
- **Box removal** — no interaction; scripts hold no box ids.

## Security

A saved script's body reaches `execCommand` by exactly the path a typed command does today, so
this adds no shell surface: the text was already arbitrary and already ran under the box's login
shell. All four routes are auth-gated like every other `/api/*` route.

`data/fleet-scripts.json` is written `0o600` but is **not** encrypted, unlike `proxmox.json`,
`netbox.json` and a credentialed service tile's secret. It holds no credential class Tmuxifier
manages. A script body is free text, though, so an operator who pastes a token into one has put a
plaintext secret in `data/`. That warrants a README line, not encryption — encrypting it would
imply a guarantee the feature cannot make, since the same token would appear in the fleet job's
persisted command and output as well.

## Testing

Vitest runs with `environment: 'node'` and no jsdom, so the DOM layers are untested by design;
the pure helpers and the server carry the coverage. Tests use real code, not mocks, per the
project's dependency-injection convention.

- `test/fleetScriptsStore.test.js` — add/update/remove round trip; case-insensitive name
  uniqueness on both add and rename, including re-saving under the record's own name; every cap
  (name 80, note 200, body 65536, 200 records); trimming; unknown-id update and remove; absent
  file reads empty; concurrent mutations serialized without losing a write.
- `test/fleetScriptRoutes.test.js` — the auth gate on all four routes, `400` on an invalid body,
  `404` on an unknown id, and the `201` shape.
- `test/fleet.test.js` (extended) — `scriptName` lands on the job and survives `summarize`;
  blank and oversized values are ignored rather than rejected; the name is never re-resolved from
  the store.
- `test/fleetScripts.test.js` — the pure web helpers (`isDirty`, `validateName`, `sortScripts`).
- One Playwright e2e — save a script, reload the page, and assert the rail row actually renders
  and its body loads back into the editor. Server-side green is not evidence a UI works; a
  previous feature shipped with 1698 passing tests and an element that never rendered.

## Build order

1. `fleetScriptsStore.js` + store tests.
2. Routes + route tests.
3. `scriptName` plumbed through `fleet.js` and the job route + tests.
4. `fleetScripts.ts` fetch layer and pure helpers + tests.
5. `fleetScriptRail.ts` and the `openFleetScriptEditor` wiring.
6. Fleet Jobs row label.
7. Styles, following `DESIGN.md`.
8. `npm test` and `npm run typecheck`.
9. Live validation: build in the worktree, rsync `dist/` onto the running app, restart the
   service (no setup/provision/lifecycle/fleet/voice-install job running), operator verifies in
   the browser.
10. Merge to main, then the ship checklist.

## Docs to update

- `README.md` — the Fleet Command section, including the plaintext-body caution.
- `CLAUDE.md` and `AGENTS.md` — architecture bullets for `fleetScriptsStore.js`,
  `fleetScripts.ts`, `fleetScriptRail.ts`, and the new `data/fleet-scripts.json` entry in the
  self-contained-principle list.
