# Killing tmux sessions and windows from the session picker

**Date:** 2026-08-21
**Status:** design approved, unimplemented

## Problem

The pane header's session dropdown (v1.24.44/47) can *reach* every session and window
on a box, but it can only ever switch to one. A session left behind by a finished
task, or a window opened by mistake, has to be killed from a shell on the box —
which means attaching to the very session you are trying to be rid of, or leaving
the dashboard for a terminal. The one destructive session action Tmuxifier does
offer, the header's ↻ Reconnect cap, is hardwired to the pane's OWN session and
cannot touch any of the others the dropdown lists.

The obvious fix — a small `×` on each row of the dropdown — is not buildable as the
control stands. Both surfaces that show this list render it as a native `<select>`,
and an `<option>` cannot contain markup, cannot take its own click handler, and
cannot be styled. Per-row anything requires replacing the native picker.

## Scope

**In scope**

- One server route for killing a tmux session or a single window on a box.
- A new `sessionPicker.ts` widget: a trigger button plus an anchored popup listbox
  whose rows each carry a kill `×`.
- Adopting that widget on BOTH surfaces that render this list today — the pane
  header (`paneHeader.ts`) and the Add/Edit Box modal (`main.ts`).
- Dropping the pane header's session control entirely in phone mode (≤720px).

**Out of scope**

- The Android app (`android/`, v1.1.4). It has no session or window picker at all
  today — its `ApiClient` never lists sessions and has no `selectWindow` — so
  giving it one is a build from nothing, not the addition of a `×`. The server
  route this spec adds is what that work would consume, so the follow-up is
  UI-only. Its intended shape, per the operator: long-press a box in the app's
  list to open a session sheet, keeping the terminal view free of chrome.
- Creating sessions from the pane header. Create stays where it is today, in the
  Edit Box modal.
- Renaming sessions or windows, moving windows between sessions, and any other
  tmux administration. Killing is the one verb this adds.

## Decisions

These were settled during brainstorming and the alternatives are recorded so a
later reader does not relitigate them.

**A custom popup replaces the native `<select>`, rather than an `×` sitting beside
it.** A single `×` acting on "whatever the dropdown currently shows" was the
cheaper build and was rejected: the target of a destructive action would then be
held in a *separate* control from the action itself, so what you are about to
destroy is one glance away from the button that destroys it. Per-row kill puts
the verb on the noun.

**The cost of that is accepted explicitly.** The native control is what gives
mobile browsers the OS picker, and `paneHeader.ts` carries real machinery built on
it — the focused-select repopulation guard and the `showPicker()`
prefetch-on-reach from v1.24.47. Phone mode dropping the control entirely (below)
retires the mobile-picker argument, and the guard machinery is replaced by
something narrower, not merely deleted (see "The armed-row invariant").

**Killing the attached session is allowed, under one uniform rule.** Every row
kills; no row is special-cased. Killing the session the pane is attached to drops
the PTY, and the attach path's `new-session -A` recreates it empty on reconnect —
the same observable outcome as the ↻ Reconnect cap, which is what that cap already
does. The alternative (disable `×` on the attached row, point at Reconnect) was
rejected as a second rule to learn in exchange for preventing an action that is
already one click away under a different name.

**Both surfaces adopt the widget, not just the header.** They share only the pure
`sessionTargets` model today; sharing the widget as well means a session behaves
identically wherever you meet it, and the modal's Create key gains a natural home
beside the kills.

**Phone mode drops the header's session control.** The operator's phone use is the
Android app, not the browser under 720px, and the header row is the most contested
real estate in the app. Removing it there reclaims that width AND means the popup
never has to open into a 344px viewport (the Z Fold 6 cover screen this project
already designs against). Session management on a phone is reached from the box
list instead.

## Server

### Route

`POST /api/boxes/:id/kill`, body `{ session, windowId? }`.

`session` is **required in both cases**, including when killing a window. A window
id is unique per window OBJECT, not per session, and a grouped session
(`tmux new-session -t web -s webclone`) shares those objects — so a bare `@7`
names two windows at once and tmux resolves whichever it finds first. This is not
theoretical: it was verified on tmux 3.5a for `buildSelectWindowRemote`, where a
bare id moved the CLONE and exited 0 while the intended session never budged. An
absent session is a 400, never a guess.

`windowId` present kills that one window; absent kills the whole session. One
route rather than two so the "always session-qualified" rule lives at a single
chokepoint.

Validation, in the order the route applies it:

| Condition | Response |
|---|---|
| Box not found | 404 |
| Box's setup job is `running` | 409 `box setup is still running` |
| `session` missing or fails `SESSION_NAME_RE` | 400 |
| `windowId` present and fails `WINDOW_ID_RE` | 400 |
| `boxActions.execCommand` unavailable | 503 |
| Remote exits non-zero | 502, carrying trimmed stderr |
| Otherwise | `{ ok: true }` |

The 409 is deliberate and matches `/term`, the sizing viewer, and the
session-create and window-select routes: a box mid-setup has no environment worth
steering, and killing the session setup's own ensureSession-last phase is about to
create would leave the box in a state nothing recovers.

On success the route awaits a best-effort `statusPoller.probeOne(box.id)`, exactly
as the window route does. `/api/status` serves a cache that only moves on
`statusPollMs` (30s), which the client then re-reads on its own 30s interval, so
without this a killed session lingers in the list for up to a minute — precisely
when the operator is looking at it. A probe that throws, or a deployment with no
poller wired (tests), still returns 200: a kill that succeeded on the box must
never be reported as a failure because the follow-up read did not land.

### Remote builders

Two new exports in `boxActions.js`, shaped exactly like `buildSelectWindowRemote`
(tmux binary resolution, `set -eu`, validation before quoting):

- `buildKillSessionRemote(session)` → `tmux kill-session -t '=<session>'`
- `buildKillWindowRemote(session, windowId)` → `tmux kill-window -t '=<session>:@<id>'`

The `=` prefix is load-bearing in both. A bare `-t` target PREFIX-matches when no
exact name exists, so killing `web` on a box that has only `web2` kills `web2` —
a stranger's session. This repo has learned that rule three times now
(`killSessionArgs`, `buildEnsureSessionRemote`, `buildSelectWindowRemote`) and the
kill path is where getting it wrong is unrecoverable.

These are NEW builders rather than a reuse of the existing `buildKillTmuxRemote`,
which stays as it is. That one runs `sanitizeSession` (silently REWRITES a name
rather than rejecting it) and ends in `|| true` (reports success whatever
happened). Both behaviours are correct for its caller — best-effort teardown when
a box is being removed, which must not be blocked by an unreachable host — and
both are wrong for an explicit user action whose entire job is to say what it did.
Widening it to serve both callers would mean one of them getting the wrong
semantics silently.

## The widget: `sessionPicker.ts`

A new module owning DOM only. The pure model — `sessionTargets`,
`sessionTargetList`, `SESSION_NAME_RE`, `isSwitchableSession`, `WINDOW_INDENT` —
stays in `paneHeader.ts` untouched: what changes is how the rows are drawn, not
what the rows are.

### Structure

A trigger `<button>` showing the current row's label, and an anchored popup
containing the rows.

Rows are `<li>` carrying TWO buttons — the label and the `×` — and are
deliberately **not** `role="option"` inside a `role="listbox"`. An option must not
contain interactive descendants; a listbox whose options hold buttons is a
composite widget screen readers cannot navigate coherently. The popup is a plain
list with a roving tabindex instead:

- Trigger: `aria-haspopup="true"`, `aria-expanded` tracking open state.
- ↑/↓ move between row label buttons; Home/End jump to the ends.
- Tab or → from a row label reaches that row's `×`.
- Esc closes the popup and returns focus to the trigger.
- `aria-current="true"` marks the row `sessionTargetList` selected — the current
  session's active window when the snapshot knows it, else the session row.
- Rows that `sessionTargets` marks `disabled` (live session names outside
  `SESSION_NAME_RE`) render their LABEL disabled with the existing explanation,
  exactly as the `<option>` did. Their `×` stays ENABLED: an unswitchable name is
  a name that cannot round-trip a PATCH, which has nothing to do with whether the
  session can be killed — and the kill path never PATCHes anything.

### Killing a row

Arm-then-fire through the existing `armReduce` reducer from `arming.ts`, the same
policy the Reconnect caps and the Proxmox lifecycle keys use. First click on a
row's `×` arms it and states the consequence; the second commits; any other click,
Esc, or the 3s `ARM_MS` timeout disarms. Reusing the reducer rather than
re-deriving it is the point of it existing — the disarm cases are the half that is
subtly easy to get wrong.

The legend a sole window's arm shows says that killing it destroys the session.
tmux destroys a session when its last window goes, and this spec does not
special-case that; it just refuses to let it be a surprise.

### What the rewrite simplifies

Because the popup is ours, `onWillOpen` can open it IMMEDIATELY and repopulate the
rows live as the probe lands. That retires two pieces of `<select>`-specific
machinery outright:

- the `pointerdown` + `preventDefault` + `showPicker()` dance, which existed only
  because a native picker can be refreshed solely BEFORE it opens;
- the focused-select guard in `update()`, and the `blur` re-apply that guard made
  necessary.

The `pointerenter` prefetch stays useful and stays, via the existing
`freshProbe.refresh(id, opts)` single-flight/freshness/wait-cap policy.

### The armed-row invariant

Those guards are replaced by one narrower rule, not by nothing: **rows are never
rebuilt while a row is armed.** A status poll landing between the arming click and
the committing click could otherwise reorder or re-key the list and migrate the
arm onto a different session — the arm-then-fire equivalent of the stale-index bug
that made this codebase address windows by `@id` instead of index. Rows are keyed
by `SessionTarget.value`, which already carries its session for exactly this class
of reason.

## The two surfaces

### Pane header

`paneHeaderModel` gains a `phone` input and returns `targets: null` when it is set,
so the header renders no session control at all under 720px. `main.ts` already
knows the flag (`phone.matches()`) and already repaints the stage on flip.

`buildPaneHeader` mounts the picker where the `<select>` was, inside the same
`.pane-header-id` identity group — which session a pane shows is part of what the
pane IS, and that placement does not change. `PaneHeaderActions` gains
`onKillTarget(target)`; `main.ts` wires it to the new route, then re-probes and
repaints. `update()`'s existing contract holds: it rewrites text and classes in
place and never rebuilds the slots that own their own update cycle.

### Add/Edit Box modal

The `.session-select` is replaced by the same widget. Create New Session… stays a
ROW in the list, as it is today, and the text field it reveals (`customRow`) stays
BELOW the control rather than inside the popup: a field mounted in the popup would
vanish the moment picking the row closed the popup, which is precisely when the
operator starts typing into it. The widget's one surface-specific hook is
therefore `canKill`, which the modal uses to exempt that synthetic row — it names
no session on the box, so it has nothing to kill.

The modal's existing logic survives, re-pointed at the widget's callbacks rather
than rewritten:

- `lastPick` — the last selection Save is allowed to treat as committed. A
  session-row pick commits immediately (pure form state); a window-row pick commits
  only once `api.selectWindow` succeeds, so a failed live switch snaps back rather
  than leaving Save to persist a switch that never happened.
- `windowPending` — true between firing a switch and its settling, so a refresh
  landing mid-flight cannot commit the pending pick as `lastPick`.
- `sessionFieldValue()` — the single reader both Save branches use.

A kill in the modal additionally re-runs `probeAndApply()` so the hint line's
session/window counts stay honest, and clears `lastPick` if the killed row was the
selection.

## Failure behaviour

| Case | Behaviour |
|---|---|
| Kill fails (502) | The row stays, the surface shows the server's message. Nothing local is optimistically removed — the list is a report of the box, not a wish. |
| Killed the attached session | PTY drops; reconnect's `new-session -A` recreates it empty. Same as ↻ Reconnect. |
| Killed a session's last window | tmux destroys the session; the next probe simply does not list it. |
| Row vanished between poll and click | 502 from tmux ("can't find session/window"); the next probe rebuilds the list without it. |
| Probe after kill fails | Kill still reports success. The list is stale until the next sweep, which is a late list, not a wrong one. |

## Testing

`vitest` runs `environment: 'node'` with no jsdom, so the widget's DOM layer is
e2e territory by repo convention — the same split `paneHeader.ts` and
`stagePanes.ts` already use. Planning DOM-rendering unit tests here would be
planning tests that cannot run.

**Unit**
- `buildKillSessionRemote` / `buildKillWindowRemote`: exact `=` targets, session
  qualification on the window form, and a throw (not a rewrite) on a name or id
  outside the regexes.
- Route tests in `windowSelectRoute.test.js`'s style: the 404/409/400/503/502
  table above, and that `probeOne` is called on success and cannot fail the
  response.

**Integration, against real tmux** — not a fake transport. The `=` exact-match rule
is exactly the kind of claim a mocked `sshStream` certifies while it is broken;
this repo has been burned by that twice, most recently with 2143 green tests over
a fake transport proving nothing about the real one. Following
`sessionCreate.integration.test.js`: create `web` and `web2` on the isolated test
box, kill `web`, assert `web2` SURVIVED. That single assertion is the whole reason
the `=` prefix is in the builder.

**e2e** (`sessionDropdown.spec.ts`)
- Open the picker, kill a window, assert it leaves the list.
- Kill a session, assert the same.
- One click on `×` does NOT kill (arm-then-fire holds).
- A poll landing while a row is armed does not move the arm.

**e2e** (`phone.spec.ts`)
- Under 720px the pane header renders no session control.

**Manual, on the live app before merge** — per the project's standing rule, and
because two of this feature's risks are invisible to every suite above: the
keyboard contract of a hand-rolled popup, and what killing the attached session
actually looks like from a browser watching that pane.

## Deferred

- **The Android app.** Long-press a box in the app's list to open a session sheet
  with switch and kill, per the operator's design. Its own spec; the server route
  here is what it consumes.
- **The Edit Box modal on phone** as the session-management path, now that the
  header control is gone there. It already works — `✎` on a box row opens the
  modal at every width — but the pencil sits in a tight icon cluster beside
  `✕ Remove`, which is a misfire hazard on a touch screen. Enlarging those targets
  or adding a long-press to the row was raised and deliberately not folded in
  here.
- **Create from the pane header.** Only the modal offers it.
