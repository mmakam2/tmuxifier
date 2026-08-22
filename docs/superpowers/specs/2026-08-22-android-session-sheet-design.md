# Android long-press session sheet — design

2026-08-22. Status: approved, unimplemented.

Deferred out of [2026-08-21-session-window-kill-design.md](2026-08-21-session-window-kill-design.md):
"Long-press a box in the app's list to open a session sheet with switch and kill, per the
operator's design. Its own spec; the server route here is what it consumes." This is that spec.
It adds no server route — every route it calls already ships.

## What it is

A `ModalBottomSheet` listing a box's live tmux sessions and their windows, from which the
operator can **switch** the box to another session or window, **kill** either, and **create** a
session — the phone's counterpart to the web's `sessionPicker.ts` popup, which phone-width
browsers no longer render at all (v1.24.48 drops the pane header's session control below 720px).

Reachable two ways:

- **Fleet** — long-press a box card. Tap is already the "open this session" gesture, so the
  sheet takes the long press, with a `LongPress` haptic.
- **Session** — an explicit `web ▾` chip in the header, between the box label and the agent
  chip. No hidden gesture here: nothing claims a tap on that header today, and a visible
  control is the same trigger shape the web's pane header uses.

## Why the app needs its own rules

The app is a renderer of the server APIs; it never attaches. Three consequences shape this
feature, and each one is a place where copying the web verbatim would be wrong.

1. **`GET /api/boxes/:id/pane` captures `box.sessionName`** — the box's *stored* session. So
   "switch session" from the phone can only be `PATCH /api/boxes/:id { sessionName }`, which
   repoints the box for every browser too and drops their PTYs so they reattach. A window
   switch costs nothing of the sort: the current window is *session* state in tmux, so every
   attached client follows a `select-window` on its own.
2. **Nothing on the phone recreates a killed session.** The browser's attach path runs
   `new-session -A`, so the web can kill the session its own pane is attached to and get an
   empty one back on reconnect. The app has no attach: kill `web` and `/pane` answers 502 until
   a browser attaches or something creates it again. Hence the recreate row below.
3. **A name tmux will not let us address is a row with no actions.** Both `POST
   /api/boxes/:id/kill` and `POST /api/boxes/:id/window` validate `session` against
   `SESSION_NAME_RE` (`/^[A-Za-z0-9_-]{1,64}$/`) and 400 outside it.

## Decisions

| Question | Decision |
|---|---|
| Entry points | Both — Fleet long-press and a Session-header chip |
| Actions | Switch + kill + create |
| Kill guard | Arm-then-fire on the row (reuses `keys/Arming.kt`) |
| Killing the box's configured session | Allowed, with a recreate row in the sheet afterwards |

Non-goals: renaming a session, moving/renaming windows, multi-select, acting on more than one
box at a time, and anything that would make the app attach.

## Architecture

New:

- `android/app/src/main/java/com/tmuxifier/console/session/SessionTargets.kt` — the pure model,
  JVM-tested. A transliteration of the web's `sessionTargets`/`sessionTargetList` (`paneHeader.ts`)
  and `isSoleWindow`/`killLegend`/`rowKey` (`sessionPicker.ts`), plus the `live`/`addressable`
  additions below.
- `android/app/src/main/java/com/tmuxifier/console/ui/SessionSheet.kt` — the Compose half.
- `android/app/src/test/java/com/tmuxifier/console/session/SessionTargetsTest.kt`.

Changed:

- `api/Models.kt` — `TmuxWindow`, `TmuxSession`, and `BoxStatus.sessions`.
- `api/ApiClient.kt` — five methods (below).
- `ui/FleetScreen.kt` — `BoxCardRow`'s `clickable` becomes `combinedClickable`.
- `ui/SessionScreen.kt` — the header chip; the pane below is untouched and stays inert to touch.
- `docs/android-app.md` — the Screens section.

The split is the app's existing convention and the web's: pure logic gets JVM unit tests,
Compose is validated on the real device only (vitest's Android equivalent has no UI harness
here). It is also what makes the load-bearing rules — the grouped-session value encoding, the
sole-window legend, disabled-not-hidden — arrive as tests rather than as folklore re-derived in
Kotlin.

### The pure model

```kotlin
enum class TargetKind { SESSION, WINDOW }

data class SessionTarget(
    val kind: TargetKind,
    val value: String,        // "s:<session>" | "w:<session>:<@id>"
    val label: String,        // session name, or "1: zsh" for a window
    val session: String,
    val windowId: String? = null,
    val current: Boolean = false,     // belongs to the box's configured session
    val live: Boolean = true,         // tmux lists it right now
    val addressable: Boolean = true,  // the routes can name it (both regexes)
    val reason: String? = null,       // why not
)

data class SessionTargetList(val options: List<SessionTarget>, val value: String)

enum class RowAction { SELECTED, SWITCH, RECREATE, NONE }

fun sessionTargets(status: BoxStatus?, sessionName: String?): List<SessionTarget>
fun sessionTargetList(status: BoxStatus?, sessionName: String?): SessionTargetList
fun rowAction(t: SessionTarget): RowAction        // what a tap does
fun canKill(t: SessionTarget): Boolean            // addressable && live
fun isSoleWindow(targets: List<SessionTarget>, t: SessionTarget): Boolean
fun killLegend(t: SessionTarget, sole: Boolean): String
fun rowKey(t: SessionTarget): String = t.value
```

Rules carried over from the web unchanged:

- **The configured session is always row one**, live or not, and is the fallback selection. The
  web needs this because the row is the select's value; the app needs it because it is the only
  thing the sheet can open with when it has no status yet.
- **`value` carries the session even for a window.** A grouped session (`new-session -t web -s
  webclone`) SHARES window objects, so `@7` legitimately names rows under two sessions. `rowKey`
  is `value` for exactly this reason: an arm keyed by bare id could migrate onto a different
  session between the arming tap and the firing one.
- **Unswitchable names are disabled, not hidden.** The session is real; it is only unreachable
  from here. Its windows inherit the lock — with no exception for the current session's, unlike
  the web (see `addressable` below).
- **`killLegend`** says the quiet part on a sole window: `kill 1: zsh? last window — the
  session goes too`.

One rule deliberately dropped: the web's `WINDOW_INDENT` (`"  → "`, non-breaking spaces).
It exists because an `<option>` cannot be styled, so the web draws the tree in *text* and
`killLegend` then has to strip it back off. A Compose row indents with padding, so a window's
`label` here is plain (`1: zsh`) and nothing needs stripping. `SESSION_NAME_RE` is mirrored as a
Kotlin `Regex` beside the model; the server stays the authority, and every route re-validates.

Two additions the web's model does not carry:

- **`live`** — false when the configured session is not in the status snapshot's session list.
  The web never needed it (a browser's attach recreates the session on reconnect); the app does,
  because of consequence 2 above.
- **`addressable`** — the target's name (and, for a window, its id) matches what the routes
  accept, so `canKill` is `addressable && live` and `rowAction` is `NONE` without it. This is
  ONE predicate rather than a switchable/killable pair, because the two would always be equal
  and could only drift. It also means a window under an unaddressable session name offers
  nothing — including under the CURRENT session, where the web exempts windows ("they need no
  PATCH"): `POST /window` sends the session too, and 400s on that name. The web renders an enabled `×` on
  an unswitchable row for the same reason ("an unswitchable NAME is about PATCH round-tripping,
  which the kill path does not do at all", `sessionPicker.ts:195`) — wrong, because the kill route
  applies the same charset, so on the web that `×` can only ever 400. See Deferred.

### Row states

| Row | Tap | `×` |
|---|---|---|
| Configured session, live | selected (✓), no-op | armed kill, legend naming the app's own view |
| Configured session, not live | **Recreate** → `POST /sessions { name }` | absent (`canKill` false) |
| Other live session, switchable name | `PATCH { sessionName }` | armed kill |
| Any session with an unaddressable name, and its windows | disabled + reason | absent |
| Window of the CURRENT session (indented) | `POST /window { session, windowId }` — no reattach | armed kill, sole-window legend |
| Window of ANOTHER session | `POST /window`, then `PATCH { sessionName }` — window first | armed kill, sole-window legend |
| `+ New session…` | expands a name field + Create | absent |

A window of another session needs BOTH calls. `POST /window` alone changes that session's active
window on the box and nothing else: the box still points elsewhere, so the pane keeps rendering
the old session, the ✓ never moves, and the re-probe repaints an identical list — a silent no-op.
Window FIRST, because the `PATCH` drops every viewer's PTY: selecting the window beforehand means
the forced reattach lands already on the chosen window. This is exactly what the web's
`selectTarget` does (`src/web/main.ts`), and the app inherits the rule rather than re-deriving it.

The ✓ follows `sessionTargetList`: the current session's **active window** when the snapshot
knows one, else the session row — so the sheet answers "which window am I looking at", not only
which session the box points at.

`+ New session…` validates the typed name against `SESSION_NAME_RE` locally before enabling
Create, because the server rejects rather than silently rewriting (`server.js:909`) and a
rejection after the round trip is a worse way to learn the charset. The server stays the
authority; this is a courtesy, not a gate. Creating does **not** switch the box to the new
session — same as the web's Create field, and the same detached `buildEnsureSessionRemote` the
attach path would have run, carrying the box's `startupCommand`.

### API layer

All five routes accept a device-token `Authorization: Bearer` through `requireAuth`; only
`/api/devices/pair` and `/api/devices/apk/build` are browser-session-only, and neither is here.

```kotlin
suspend fun probe(boxId: String): Map<String, BoxStatus>     // POST /api/boxes/{id}/probe
suspend fun selectWindow(boxId: String, session: String, windowId: String)
suspend fun killTarget(boxId: String, session: String, windowId: String? = null)
suspend fun createSession(boxId: String, name: String)
suspend fun setSession(boxId: String, name: String): BoxInfo // PATCH /api/boxes/{id}
```

Bodies stay `buildJsonObject` — never string concatenation — so a session name needs no escaping
in the client, exactly as `ApiClient`'s header comment already promises. `windowId` is omitted
from the kill body for a session kill; the route branches on its presence, and `null` would be
read as present-and-invalid.

### Freshness

The sheet issues no `GET /api/status` call of its own — it reuses whatever the Fleet poll
already holds, and otherwise talks only to `POST /api/boxes/:id/probe`, which both re-probes and returns
that box's entry keyed by id, and is deliberately un-gated by a running setup job (it only reads
what the poller already reads every sweep).

1. **Open immediately** on whatever is in hand: from Fleet, the 10s poll's `BoxStatus`; from
   Session, nothing but `PaneSnapshot.sessionName`. The model always emits the configured-session
   row, so the sheet is never empty and never blocks on the network to appear.
2. **Probe, and wait at most `OPEN_REFRESH_WAIT_MS` (700ms)** — the web's `freshProbe.ts` cap —
   showing a row-level progress indicator. Then stop *waiting*, not probing: a late result still
   lands and repaints. A box that has gone away is a slightly-late list, never a dead sheet.
3. **Re-probe after every successful action.** The `/window` and `/kill` routes already call
   `statusPoller.probeOne` server-side, so this reads a snapshot that is authoritative rather
   than up to 30s stale — without it the ✓ visibly snaps back, which is the exact defect
   v1.24.44 fixed on the web.

While the sheet is open there is no poll of its own: a session list is not a thing that changes
under you the way a pane does, and the app's rule is no polling that the screen does not need.

### Consequences the sheet states plainly

- A **session switch** is global. The sheet says so under the row — "switches this box
  everywhere" — because on the web the same PATCH is issued from a pane the operator is looking
  at, while here it can be fired from a list against a box someone else may be watching.
- A **window switch** is not a reattach and needs none.
- After a switch, the app's **invisible sizing client** is re-ensured against the new session by
  the next `/pane` poll; the old one expires on its ~30s TTL, leaving that window at its last
  size until another client acts. tmux's own rule, worth knowing, nothing to do.
- Killing the **configured** session leaves `/pane` answering 502. The arm legend says it
  ("kill web? this is the session the app is showing"), and the row it leaves behind is the
  recreate row — `POST /sessions` with the same name is exactly what an attach would have made.

## Errors

`ApiException(status, message)` is already the app's one failure shape. The sheet renders the
message inline at its foot, not as a toast, so it survives the recomposition an action triggers.

| Status | Meaning here | Sheet behaviour |
|---|---|---|
| 401 | device revoked | `onUnauthorized()` — the existing path to Settings |
| 404 | box removed since the list was drawn | close the sheet, message on the screen beneath |
| 409 | box setup is still running | keep the sheet, show the server's message. `/sessions`, `/window` and `/kill` are gated this way (as is `/term`); `PATCH /api/boxes/:id` and `probe` are NOT (`src/server/server.js`), so a session switch still succeeds on a box mid-setup |
| 400 | name/id outside the charset — should be unreachable | show the message; it means the model let through a row it should not have |
| 502 | the target vanished between poll and tap, or the box is unreachable | show the message, **keep the row**; the list is a report of what is on the box, not a wish |
| 0 | transport | "offline — retry", the app's existing wording |

A failed kill never removes its row optimistically, and a failed switch never moves the ✓.

## Testing

**JVM unit tests** (`SessionTargetsTest.kt`) — the pure model only. Each of these is written to
FAIL first, and each is written so the property it names has a world where it is false. Three
tests in the v1.24.48 run passed while proving nothing, all three by naming a property without
constructing that world; these are the same rules restated as fixtures:

- **The configured session is emitted when tmux does not list it**, with `live = false` — build
  a status whose sessions are `["other"]` and a `sessionName` of `web`.
- **`live` is true when it IS listed** — the falsifying half of the row above; without it a
  model that hardcoded `live = false` would pass.
- **Grouped sessions**: two sessions whose `windowList` share `@7`. Assert the two rows carry
  DIFFERENT `value`/`rowKey`. A fixture where each session has its own ids cannot fail.
- **`isSoleWindow`** needs both cases in one fixture: a session with exactly one window and a
  session with two, asserting true then false.
- **`killLegend` distinguishes the sole-window case** — assert the two sentences differ on
  the two-window and one-window fixtures above. Asserting only that the string contains the
  window name passes for both and proves nothing.
- **An unswitchable name is not addressable** — fixture name `my session`, i.e. a name that
  actually fails `SESSION_NAME_RE`, with an addressable `web` beside it so a model that answered
  `NONE` for everything would fail. Assert `rowAction` is `NONE` and `canKill` false.
- **Windows of an unaddressable session are unaddressable too, including the CURRENT session's**
  — the deviation from the web, which exempts them. A separate fixture where the configured
  session is itself named `my session`.
- **A window id outside `WINDOW_ID_RE`** makes only that row unaddressable, its session row
  unaffected.
- **`sessionTargetList` selects the active window** when the snapshot marks one, and the session
  row when it does not.

**Not unit-tested, by design:** the sheet composable, the long press, the arm-then-fire timing,
and every route call. The app has no Compose UI harness and the project's Android convention is
device validation for UI.

**Device validation, before merge** — the standing rule, and the only coverage these have:

1. Long-press a Fleet card; the sheet opens with the box's sessions and windows, ✓ on the active
   window.
2. Open a session, tap the header chip; the same sheet, same rows.
3. Switch to another window; the pane changes within a second and the ✓ moves. Confirm a browser
   attached to that session followed it without reconnecting.
4. Switch to another session; the pane follows, and the browser's terminal reconnects onto the
   new session.
5. Create a session from the sheet; it appears as a row and the box does NOT switch to it.
6. Kill a window with two windows present: one tap arms with the plain legend, second kills, the
   row goes.
7. Kill a sole window: the legend says the session goes too, and it does.
8. Kill the configured session: the pane's error appears, the row survives as not-live, Recreate
   brings it back, and the pane recovers with no browser involved.
9. A box mid-setup: the sheet opens (probe is un-gated); the window, kill and create actions
   report the 409 rather than failing silently, while a session switch succeeds — `PATCH
   /api/boxes/:id` is not setup-gated, so that is the correct result, not a failure.
10. Aeroplane mode: opening the sheet still shows the configured-session row and an offline
    message, not a spinner that never resolves.

## Deferred

- **The web's always-400 `×`** on an unswitchable row (`sessionPicker.ts:195`). Its own change on
  the web side: either drop the `×` for those rows or relax the kill route to accept a name it
  can quote exactly. Not folded in here — this spec touches no web file and no server file.
- **Renaming a session** from either client. The server has no route, and `sanitizeSession`'s
  silent-rewrite behaviour makes it a design question rather than a route question.
- **The Edit Box modal's phone ergonomics** (carried over from the kill spec): the `✎` sits in a
  tight icon cluster beside `✕ Remove`. Unchanged by this work, which gives the phone its own
  path and so lowers the pressure on that one.
- **A sheet from the notification** — opening straight onto the session sheet for the box that
  buzzed. Speculative until the app is used this way.
