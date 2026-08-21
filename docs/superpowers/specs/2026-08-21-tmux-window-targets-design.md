# tmux window targets in the session dropdowns

**Date:** 2026-08-21
**Status:** design approved, unimplemented

## Problem

Both places Tmuxifier offers a tmux session — the pane header's dropdown and the Edit Box
modal — stop at the session. A session is rarely where the work is: a box running `web` with
four windows (`zsh`, `claude`, `vim`, `logs`) presents as one opaque row, and moving between
windows means reaching into the terminal with `prefix-n`. The header also can't answer the
question an operator actually has — *which window am I looking at right now* — because it
renders only the configured session name.

The Edit modal has a second, smaller problem: it carries four controls for one value (a free
text field, a ⟳ probe button, a row of clickable session chips, and a Create row). The chips
are a picker bolted beside a field that is itself a picker.

## Goal

1. Both dropdowns list every **window** on the box, nested under its session.
2. Picking a window switches the pane to it.
3. The Edit modal's chips collapse into the one dropdown.

## Non-goals

Creating, renaming, or killing windows (the Create row still creates *sessions* only).
Persisting a window on the box. Window-level agent chips. Android app changes — it renders
`GET /api/boxes/:id/pane`, which captures the session's active window, so a window switch
shows up there with no work.

## Verified tmux behaviour

Checked against tmux 3.5a on the host before designing:

- `tmux list-windows -a -F …` reports every session's windows in one invocation.
- Window names may contain colons (`we:ird name`) and session names may contain spaces
  (`beta box`). Session names may **not** contain colons — the invariant `STATUS_FMT` already
  relies on. So the window name must be the last field of a `:`-joined format and the parser
  must rejoin the tail.
- `#{window_id}` is `@N`, unique per tmux server, and stable across the renumbering that
  `move-window` and window kills cause. `#{window_index}` is not.
- `select-window -t '@1'` changes the current window of that window's own session and nothing
  else. Clients already attached to that session follow immediately: in tmux the current
  window is **session** state, not client state.

That last fact is what shapes the whole design. A window switch needs no reattach, no PTY
kill, and nothing persisted — unlike a session switch, which today PATCHes `sessionName` and
drops the box's terminal PTYs so every viewer reconnects.

It also has a consequence worth stating plainly: anyone else attached to that session — a
second browser, or an SSH terminal on the box itself — jumps windows too. That is tmux's own
semantics, identical to pressing `prefix-n`, and Tmuxifier does not try to hide it.

## Decisions

**Windows ride the existing probe.** One extra `tmux list-windows -a` inside the probe remote
already being run — no new SSH round trip. `statusChecker.listSessions()` reuses the same
`probe()`, so the Edit modal's ⟳ button and Add-mode probing inherit windows for free.

Rejected: fetching windows on demand when a dropdown is built. A native `<select>` has no
"open" event, so the fetch would have to fire on every repaint or on focus — extra SSH per
box and a list that lags the click.

**Windows are addressed by `@id`, never by `session:index`.** Indexes renumber between the
poll that built the list and the click that uses it; ids do not.

**Nothing is persisted.** `boxes.json` continues to store only `sessionName`. A stored window
would fight live use: switch windows with `prefix-n`, and the next reconnect would yank you
back to the persisted one.

## Data path

`src/server/status.js`, inside the existing `command -v tmux` guard, appends:

```
tmux list-windows -a -F '__WIN__ #{session_name}:#{window_index}:#{window_id}:#{window_active}:#{window_name}' 2>/dev/null || true
```

A new pure `parseTmuxWindows(stdout)` reads those lines with the same input distrust as
`parseAgentMarks` and `parseMeta`'s os-release fields — this is text from the box that reaches
the browser:

- `id` must match `^@\d+$`; `index` and `active` must be numeric; anything else drops the row.
- `name` is the rejoined tail, control characters stripped, length capped (64).
- `session` is matched against the parsed session list; an orphan row drops.

`parseTmuxSessions`'s line filter gains `__WIN__` beside the `__META__` and `__AGENT__` it
already skips.

Each entry of the status snapshot's `sessions[]` gains:

```
windowList: [{ id: '@2', index: 2, name: 'vim', active: false }, …]
```

The existing numeric `windows` count stays — nothing renders it today, but it is in the
published `Status` type and costs nothing. `src/web/api.ts`'s `Status` gains the field.

No other consumer of `sessions[]` changes: `healthHistory.sampleOf` reads `name`, `activity`
and `paneCmd`, and the addition is nested and additive.

## Action path

New route, mounted beside `POST /api/boxes/:id/sessions`:

```
POST /api/boxes/:id/window   { windowId: '@7' }
```

- The id shape is re-validated server-side (`^@\d+$`) rather than trusted from the client —
  the same chokepoint discipline `iconCatalog.js` and `voiceCatalog.js` apply. It is then
  single-quoted into `tmux select-window -t '@7'` and run through
  `boxActions.execCommand` over the shared ControlMaster.
- 404 unknown box; 400 malformed id; **409 while that box's setup job is `running`**, matching
  `/api/boxes/:id/sessions` and `/term`; 502 on a non-zero exit — which is what a window that
  vanished between the poll and the click produces, and the next poll corrects the list.

**Cross-session picks stay client-orchestrated.** When the chosen window belongs to a session
other than the box's configured one, `main.ts` calls this route first and then its existing
`switchSession()` PATCH. Order is load-bearing: select-window first means the forced reattach
lands already on the chosen window. Same-session picks skip the PATCH entirely — no PTY kill,
the attached pane follows in place.

This keeps the session half in exactly one place (`switchSession`, with its store validation
and `closeGroup`) instead of duplicating it inside a new route.

## Header dropdown (`src/web/paneHeader.ts`)

`sessionOptions(status, sessionName): string[]` becomes:

```ts
sessionTargets(status, sessionName): SessionTarget[]
interface SessionTarget {
  kind: 'session' | 'window';
  value: string;        // 's:<session>' | 'w:@7'
  label: string;        // 'web' | '  → 1: vim'
  session: string;
  windowId?: string;
  disabled?: boolean;
  title?: string;       // why it is disabled
}
```

Order: the configured session first (still offered when tmux no longer lists it — it is the
selected value), its windows indented beneath it, then every other live session followed by
its own windows.

Window rows render as `→ 1: vim` behind a two-space indent. `<option>` cannot be styled, so
the hierarchy is text — the same concession the existing unswitchable-name rule makes.

**The selected row becomes the current session's active window** when the snapshot knows one,
falling back to the session row. The header then reports what the pane is actually showing
rather than only which session it belongs to.

Switchability extends the existing rule rather than replacing it. A session whose live name
fails `SESSION_NAME_RE` stays offered-but-disabled, because `store.js`'s `sanitizeSession`
would silently rewrite the PATCHed name and the reattach would create a fresh mangled-name
session. Windows inherit their session's verdict — **except** windows of the box's current
session, which need no PATCH and are therefore always selectable.

Both existing guards survive untouched: `update()` never repopulates a focused select (a
status poll landing mid-pick would slam the dropdown shut), and the change handler blurs the
select before acting so a failed switch can snap the value back.

## Edit modal (`src/web/main.ts`)

The `<select>` becomes the field itself. Its rows:

1. every live session, each followed by its indented windows;
2. `web (default)`;
3. the stored `sessionName` when it is not among the live ones;
4. `Custom name…`, which reveals the existing text input.

Save reads the text input in custom mode and the selected row's session otherwise. Picking a
window row sets the session half **and** fires `POST /api/boxes/:id/window` immediately — the
same behaviour as the header, so the two surfaces do not diverge.

Add mode has no box to act on, so window rows appear (after a ⟳ probe) disabled with a reason,
following the disabled-not-hidden precedent: the window is real, just not actionable from a
box that does not exist yet.

The `.session-picker` chip strip and `applySessions()` are deleted. The ⟳ probe button, the
Create row, and the `.session-hint` line stay as they are.

## Testing

- `parseTmuxWindows`: colon-bearing window names, spaced session names, junk lines, the
  length cap, a bad `@id`, and an orphan session.
- `sessionTargets`: ordering, indent labels, active-window selection, the fallback to the
  session row, disabled inheritance, and the current-session exemption.
- `POST /api/boxes/:id/window`: 400 malformed id, 404, 409 mid-setup, 502 on non-zero exit,
  and a happy path asserting the exact remote string reaching `execCommand`.
- `test/paneHeader.test.js` extended for the new model; it keeps locking the client's
  `SESSION_NAME_RE` mirror against `sshCommand.js`.

No new e2e. The split e2e already covers the header DOM, and the new logic is pure and
route-level.

## Documentation

`docs/terminal.md` (header dropdown) and `docs/boxes-and-setup.md` (Edit modal) both describe
the session picker and need the window behaviour added, including the "other attached clients
follow" note.

## Correction, 2026-08-21, found in final review

`#{window_id}` is unique per **window object**, not per session, and the two are not the same
thing. A grouped/linked session (`tmux new-session -t web -s webclone`) SHARES its window
objects, so one id legitimately belongs to several sessions at once. Verified on tmux 3.5a:

```
$ tmux list-windows -a -F '#{session_name}:#{window_id}:active=#{window_active}'
web:@0:active=0
web:@2:active=1
webclone:@0:active=0
webclone:@2:active=1
$ tmux select-window -t '@0'   # exit 0
web:@2:active=1                # web did not move
webclone:@0:active=1           # the CLONE did
```

So `select-window -t '@1'` does not, as stated above, change "that window's own session" —
under a grouped session there is no such single session, and tmux picks one and exits 0
either way. Everything else in this section holds, including the session-state semantics that
shape the design.

Two consequences, both implemented:

- The remote is session-qualified: `select-window -t '=<session>:@<id>'`, and
  `POST /api/boxes/:id/window` takes `{ session, windowId }` with **both** validated
  server-side (`SESSION_NAME_RE`, `WINDOW_ID_RE`). An absent session is a 400, not a fallback
  to the ambiguous bare-id target. The `=` prefix is the repo's existing exact-match rule:
  with only `alpha2` present, `select-window -t 'alpha:@5'` prefix-matches and moves alpha2
  (exit 0), while `-t '=alpha:@5'` fails with `can't find session: alpha`.
- `SessionTarget.value` for a window row is `w:<session>:<@id>`, not `w:<@id>`. Two rows
  sharing an `<option>` value made the second unreachable: resolving a pick by value returned
  the first row, acting on the wrong session — and if the box's own session was the second,
  `selectTarget` then fired a full `switchSession` PATCH (a PTY drop) nobody asked for.
