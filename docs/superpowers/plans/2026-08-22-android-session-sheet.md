# Android Long-Press Session Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Android app a bottom sheet — opened by long-pressing a Fleet card or tapping a chip in the Session header — that lists a box's tmux sessions and windows and can switch, kill, or create one.

**Architecture:** A pure Kotlin model (`session/SessionTargets.kt`, JVM-tested) transliterates the web's `paneHeader.ts`/`sessionPicker.ts` row rules; a Compose `ModalBottomSheet` renders it; `ApiClient` gains five calls against routes that already ship. No server change, no new dependency.

**Tech Stack:** Kotlin 2.1.0, Compose BOM 2024.12.01 (material3 1.3.1), kotlinx.serialization, OkHttp, `kotlin-test` on the JVM.

**Spec:** `docs/superpowers/specs/2026-08-22-android-session-sheet-design.md` — read it before Task 1; this plan argues from it.

## Global Constraints

- **The server is the authority on every name and id.** `POST …/kill`, `…/window`, `…/sessions` and `PATCH /api/boxes/:id` all re-validate. Client-side regexes decide only what the sheet OFFERS; they never stand in for validation.
- **The two regexes, copied verbatim from `src/server/sshCommand.js`:** `SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/`, `WINDOW_ID_RE = /^@\d{1,9}$/`.
- **Request bodies are built with `buildJsonObject`, never string concatenation** (`ApiClient.kt`'s header comment promises this — a session name must never need escaping in the client).
- **`windowId` is OMITTED for a session kill, never sent as `null`.** The route branches on its presence and reads an explicit null as present-and-invalid (400).
- **No new dependencies.** There is no MockWebServer and no Compose UI test harness in this module, and none is being added: pure logic gets JVM tests, Compose is validated on the real device (`android/README.md`).
- **Build/test:** `cd android && ./gradlew test` (JVM) and `./gradlew assembleDebug`. The memory caps in `android/gradle.properties` are load-bearing — the build box has ~3 GB RAM. Never raise them to make a build pass.
- **Write literal glyphs (`×`, `▾`, `✓`), not `\uXXXX` escapes.** Generated escapes have landed as raw control bytes in this repo three times. Before any build, run `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' android/app/src/main/java/com/tmuxifier/console/**/*.kt` and expect no output.
- **Public repo:** test fixtures use placeholder ids and labels (`b1`, `web`, `example.com`) — never a real box name or host.
- **Every commit message ends with these two trailers** (shown once here, assumed in every commit step):

  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CrBohNcqkPS18EXwdy8Kq3
  ```

- **A Kotlin test that fails to COMPILE is a valid red.** "Unresolved reference: sessionTargets" is the expected first failure for every task here; do not stub a function just to reach a runtime assertion failure.

## File Structure

| File | Responsibility |
|---|---|
| `api/Models.kt` (modify) | `TmuxWindow`, `TmuxSession`, `BoxStatus.sessions` — the wire shapes only |
| `session/SessionTargets.kt` (create) | The pure row model: ordering, addressability, row action, kill legend. No Android imports |
| `api/ApiClient.kt` (modify) | Five suspend calls + the internal `killBody` seam |
| `ui/SessionSheet.kt` (create) | The `ModalBottomSheet`: rows, arm-then-fire kill, create field, probe-on-open, error line |
| `ui/FleetScreen.kt` (modify) | Long-press entry + the status map the sheet opens on |
| `fleet/FleetModel.kt` (modify) | `BoxCard.sessionName` — the configured session the sheet needs |
| `ui/SessionScreen.kt` (modify) | Header chip entry |
| `docs/android-app.md` (modify) | The Screens section |

Tests mirror the source tree under `app/src/test/java/com/tmuxifier/console/`.

---

### Task 1: Status models carry sessions and windows

**Files:**
- Modify: `android/app/src/main/java/com/tmuxifier/console/api/Models.kt`
- Test: `android/app/src/test/java/com/tmuxifier/console/api/ModelsTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: `TmuxWindow(id: String, index: Int, name: String, active: Boolean)`, `TmuxSession(name: String, windows: Int, attached: Boolean, activity: Long?, paneCmd: String?, windowList: List<TmuxWindow>)`, and `BoxStatus.sessions: List<TmuxSession>` — every field defaulted.

- [ ] **Step 1: Write the failing tests**

Add `import kotlin.test.assertTrue` to `ModelsTest.kt`, then append inside the class:

```kotlin
    @Test fun statusCarriesSessionsAndWindows() {
        // Real /api/status shape: STATUS_FMT fields plus the __WIN__ rows
        // status.js folds on as windowList.
        val m = ApiJson.decodeFromString(statusMapSerializer,
            """{"b1":{"reachable":true,"tmux":true,"sessions":[{"name":"web","windows":2,"attached":true,"activity":1723180000,"paneCmd":"claude","windowList":[{"id":"@0","index":0,"name":"zsh","active":false},{"id":"@3","index":1,"name":"claude","active":true}]}]}}""")
        val s = m["b1"]?.sessions?.single()
        assertEquals("web", s?.name)
        assertEquals(true, s?.attached)
        assertEquals(2, s?.windowList?.size)
        assertEquals("@3", s?.windowList?.last()?.id)
        assertEquals(1, s?.windowList?.last()?.index)
        assertEquals(true, s?.windowList?.last()?.active)
        assertEquals(false, s?.windowList?.first()?.active)
    }

    @Test fun oldServerStatusHasNoSessions() {
        // The falsifying half: without this, a model that hardcoded an empty
        // list would pass the test above just as well.
        val m = ApiJson.decodeFromString(statusMapSerializer, """{"b1":{"reachable":true}}""")
        assertTrue(m["b1"]?.sessions?.isEmpty() == true)
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd android && ./gradlew test --tests '*ModelsTest*'`
Expected: FAIL — "Unresolved reference: sessions".

- [ ] **Step 3: Add the models**

In `Models.kt`, above `BoxStatus`:

```kotlin
// One tmux window. `id` is tmux's own #{window_id} ("@7") — an id names a
// window OBJECT, not a slot: indexes renumber under move-window, and a grouped
// session (`new-session -t web -s webclone`) SHARES window objects, which is why
// every route that takes an id also demands the session.
@Serializable
data class TmuxWindow(
    val id: String,
    val index: Int = 0,
    val name: String = "",
    val active: Boolean = false,
)

@Serializable
data class TmuxSession(
    val name: String,
    val windows: Int = 0,
    val attached: Boolean = false,
    val activity: Long? = null,
    val paneCmd: String? = null,
    val windowList: List<TmuxWindow> = emptyList(),
)
```

And add one field to `BoxStatus`, after `metrics`:

```kotlin
    val sessions: List<TmuxSession> = emptyList(),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd android && ./gradlew test --tests '*ModelsTest*'`
Expected: PASS (all pre-existing ModelsTest cases still green).

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/api/Models.kt android/app/src/test/java/com/tmuxifier/console/api/ModelsTest.kt
git commit -m "feat(android): status models carry tmux sessions and windows"
```

---

### Task 2: The pure target model

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/session/SessionTargets.kt`
- Test: `android/app/src/test/java/com/tmuxifier/console/session/SessionTargetsTest.kt`

**Interfaces:**
- Consumes: `BoxStatus`, `TmuxSession`, `TmuxWindow` (Task 1).
- Produces:
  - `SESSION_NAME_RE: Regex`, `WINDOW_ID_RE: Regex`, `UNSWITCHABLE: String`
  - `enum class TargetKind { SESSION, WINDOW }`
  - `data class SessionTarget(kind, value, label, session, windowId, current, live, addressable, reason)`
  - `data class SessionTargetList(options: List<SessionTarget>, value: String)`
  - `fun sessionTargets(status: BoxStatus?, sessionName: String?): List<SessionTarget>`
  - `fun sessionTargetList(status: BoxStatus?, sessionName: String?): SessionTargetList`
  - `enum class RowAction { SELECTED, SWITCH, RECREATE, NONE }`
  - `fun rowAction(t: SessionTarget): RowAction`
  - `fun canKill(t: SessionTarget): Boolean`
  - `fun isSoleWindow(targets: List<SessionTarget>, t: SessionTarget): Boolean`
  - `fun killLegend(t: SessionTarget, sole: Boolean): String`
  - `fun rowKey(t: SessionTarget): String`

- [ ] **Step 1: Write the failing tests**

Create `android/app/src/test/java/com/tmuxifier/console/session/SessionTargetsTest.kt`:

```kotlin
package com.tmuxifier.console.session

// Every test here names a property AND builds the world where it is false.
// The v1.24.48 web run shipped three tests that passed while proving nothing,
// all by skipping that second half.
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.TmuxSession
import com.tmuxifier.console.api.TmuxWindow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private fun win(id: String, index: Int, name: String, active: Boolean = false) =
    TmuxWindow(id = id, index = index, name = name, active = active)

private fun status(vararg sessions: TmuxSession) =
    BoxStatus(reachable = true, tmux = true, sessions = sessions.toList())

class SessionTargetsTest {
    @Test fun configuredSessionLeadsAndSurvivesWhenTmuxDoesNotListIt() {
        // tmux knows only "other"; the box still points at "web".
        val t = sessionTargets(status(TmuxSession(name = "other")), "web")
        assertEquals("web", t.first().session)
        assertEquals(TargetKind.SESSION, t.first().kind)
        assertFalse(t.first().live)
        assertEquals(RowAction.RECREATE, rowAction(t.first()))
        assertFalse(canKill(t.first()))
    }

    @Test fun configuredSessionIsLiveWhenTmuxListsIt() {
        // The falsifying half of the test above: a model hardcoding live=false
        // would pass that one and fail this one.
        val t = sessionTargets(status(TmuxSession(name = "web")), "web")
        assertTrue(t.first().live)
        assertEquals(RowAction.SELECTED, rowAction(t.first()))
        assertTrue(canKill(t.first()))
    }

    @Test fun absentSessionNameFallsBackToWeb() {
        // store.js defaults an absent name to 'web'.
        assertEquals("web", sessionTargets(null, null).single().session)
        assertEquals("web", sessionTargets(null, "").single().session)
    }

    @Test fun groupedSessionsShareWindowIdsButRowKeysDiffer() {
        // `new-session -t web -s webclone` shares window OBJECTS: the same @7
        // legitimately appears under two names. Keyed by id alone, an arm could
        // migrate onto the other session between the arming and firing taps.
        val shared = listOf(win("@7", 0, "zsh"))
        val t = sessionTargets(
            status(TmuxSession(name = "web", windowList = shared), TmuxSession(name = "webclone", windowList = shared)),
            "web",
        )
        val windows = t.filter { it.kind == TargetKind.WINDOW }
        assertEquals(2, windows.size)
        assertEquals(listOf("w:web:@7", "w:webclone:@7"), windows.map { rowKey(it) })
        assertEquals(2, windows.map { it.value }.toSet().size)
    }

    @Test fun isSoleWindowIsTrueOnlyForASessionsLastWindow() {
        val t = sessionTargets(
            status(
                TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"), win("@1", 1, "claude"))),
                TmuxSession(name = "solo", windowList = listOf(win("@9", 0, "zsh"))),
            ),
            "web",
        )
        val twoOfTwo = t.first { it.value == "w:web:@1" }
        val onlyOne = t.first { it.value == "w:solo:@9" }
        assertFalse(isSoleWindow(t, twoOfTwo))
        assertTrue(isSoleWindow(t, onlyOne))
        assertFalse(isSoleWindow(t, t.first()))  // a session row is never a sole window
    }

    @Test fun killLegendDistinguishesEveryBlastRadius() {
        val t = sessionTargets(
            status(
                TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"), win("@1", 1, "claude"))),
                TmuxSession(name = "other", windowList = listOf(win("@9", 0, "zsh"))),
            ),
            "web",
        )
        val currentSession = t.first { it.value == "s:web" }
        val otherSession = t.first { it.value == "s:other" }
        val plainWindow = t.first { it.value == "w:web:@1" }
        val soleOther = t.first { it.value == "w:other:@9" }
        // Four distinct sentences: the app-view warning, the plain session, the
        // plain window, and the session-goes-too window. Asserting only that
        // each contains its name would pass for one shared string.
        val legends = listOf(
            killLegend(currentSession, isSoleWindow(t, currentSession)),
            killLegend(otherSession, isSoleWindow(t, otherSession)),
            killLegend(plainWindow, isSoleWindow(t, plainWindow)),
            killLegend(soleOther, isSoleWindow(t, soleOther)),
        )
        assertEquals(4, legends.toSet().size)
        assertTrue(legends[0].contains("the app is showing"))
        assertEquals("kill session other?", legends[1])
        assertEquals("kill 1: claude?", legends[2])
        assertTrue(legends[3].contains("last window"))
    }

    @Test fun unaddressableNamesOfferNoAction() {
        // A name outside SESSION_NAME_RE cannot be switched (PATCH would
        // silently rewrite it), killed, or window-selected — all three routes
        // apply the same charset. Offered, disabled, reason attached.
        val t = sessionTargets(
            status(TmuxSession(name = "web"), TmuxSession(name = "my session", windowList = listOf(win("@4", 0, "zsh")))),
            "web",
        )
        val bad = t.first { it.session == "my session" && it.kind == TargetKind.SESSION }
        val badWindow = t.first { it.session == "my session" && it.kind == TargetKind.WINDOW }
        assertFalse(bad.addressable)
        assertEquals(UNSWITCHABLE, bad.reason)
        assertEquals(RowAction.NONE, rowAction(bad))
        assertFalse(canKill(bad))
        assertEquals(RowAction.NONE, rowAction(badWindow))
        assertFalse(canKill(badWindow))
        // Beside it, an ordinary name is addressable — otherwise a model that
        // returned NONE for everything would pass.
        assertTrue(t.first { it.value == "s:web" }.addressable)
    }

    @Test fun windowsOfAnUnaddressableCurrentSessionAreAlsoUnaddressable() {
        // Deliberate deviation from the web, which exempts the current
        // session's windows ("they need no PATCH"). POST /window sends the
        // SESSION too, and 400s on this name — so there is nothing to offer.
        val t = sessionTargets(
            status(TmuxSession(name = "my session", windowList = listOf(win("@4", 0, "zsh")))),
            "my session",
        )
        val window = t.first { it.kind == TargetKind.WINDOW }
        assertFalse(window.addressable)
        assertEquals(RowAction.NONE, rowAction(window))
    }

    @Test fun windowIdOutsideItsCharsetIsUnaddressable() {
        val t = sessionTargets(status(TmuxSession(name = "web", windowList = listOf(win("7", 0, "zsh")))), "web")
        val window = t.first { it.kind == TargetKind.WINDOW }
        assertFalse(window.addressable)
        assertFalse(canKill(window))
    }

    @Test fun windowRowsAreLabelledByIndexAndName() {
        val t = sessionTargets(status(TmuxSession(name = "web", windowList = listOf(win("@0", 0, ""), win("@1", 3, "claude")))), "web")
        val labels = t.filter { it.kind == TargetKind.WINDOW }.map { it.label }
        // No indent in the label: a Compose row indents with padding, unlike an
        // <option>, so the web's WINDOW_INDENT has no counterpart here.
        assertEquals(listOf("0: window", "3: claude"), labels)
    }

    @Test fun selectionIsTheCurrentSessionsActiveWindow() {
        val list = sessionTargetList(
            status(TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"), win("@3", 1, "claude", active = true)))),
            "web",
        )
        assertEquals("w:web:@3", list.value)
    }

    @Test fun selectionFallsBackToTheSessionRowWhenNoWindowIsActive() {
        assertEquals("s:web", sessionTargetList(status(TmuxSession(name = "web")), "web").value)
        assertEquals("s:web", sessionTargetList(null, "web").value)
    }

    @Test fun otherSessionsFollowTheConfiguredOneWithTheirOwnWindows() {
        val t = sessionTargets(
            status(
                TmuxSession(name = "alpha", windowList = listOf(win("@5", 0, "zsh"))),
                TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"))),
            ),
            "web",
        )
        assertEquals(listOf("s:web", "w:web:@0", "s:alpha", "w:alpha:@5"), t.map { it.value })
        assertTrue(t.first { it.value == "w:web:@0" }.current)
        assertFalse(t.first { it.value == "w:alpha:@5" }.current)
        assertEquals(RowAction.SWITCH, rowAction(t.first { it.value == "s:alpha" }))
        assertEquals(RowAction.SWITCH, rowAction(t.first { it.value == "w:web:@0" }))
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd android && ./gradlew test --tests '*SessionTargetsTest*'`
Expected: FAIL — "Unresolved reference: sessionTargets" (a compile failure is the red here).

- [ ] **Step 3: Write the model**

Create `android/app/src/main/java/com/tmuxifier/console/session/SessionTargets.kt`:

```kotlin
package com.tmuxifier.console.session

// The session sheet's pure row model — a Kotlin transliteration of the web's
// sessionTargets/sessionTargetList (paneHeader.ts) and isSoleWindow/killLegend/
// rowKey (sessionPicker.ts), with two app-only additions: `live` (the app never
// attaches, so a killed session stays dead until something recreates it) and
// `addressable` (every route validates the name and id, so a row tmux will not
// let us name is a row with no actions at all).
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.TmuxSession

// Mirrors src/server/sshCommand.js. The server re-validates everything; these
// only decide what the sheet offers.
val SESSION_NAME_RE = Regex("^[A-Za-z0-9_-]{1,64}$")
val WINDOW_ID_RE = Regex("^@\\d{1,9}$")

const val UNSWITCHABLE = "name not usable from here (allowed: letters, digits, _ -)"
const val UNADDRESSABLE_WINDOW = "window id not usable from here"

enum class TargetKind { SESSION, WINDOW }

data class SessionTarget(
    val kind: TargetKind,
    // "s:<session>" | "w:<session>:<@id>". A window value carries its session
    // even though @id looks unique: a grouped session shares window objects, so
    // the same id appears under two names, and an arm keyed by the bare id could
    // migrate between the arming and firing taps.
    val value: String,
    val label: String,
    val session: String,
    val windowId: String? = null,
    val current: Boolean = false,     // belongs to the box's configured session
    val live: Boolean = true,         // tmux lists it right now
    val addressable: Boolean = true,  // the routes can name it
    val reason: String? = null,       // why not
)

data class SessionTargetList(val options: List<SessionTarget>, val value: String)

/** What tapping a row does. The sheet branches on this, never on the fields. */
enum class RowAction { SELECTED, SWITCH, RECREATE, NONE }

fun rowAction(t: SessionTarget): RowAction = when {
    !t.addressable -> RowAction.NONE
    t.kind == TargetKind.SESSION && t.current && !t.live -> RowAction.RECREATE
    t.kind == TargetKind.SESSION && t.current -> RowAction.SELECTED
    else -> RowAction.SWITCH
}

/** A row may be killed only if a route can name it and tmux still has it. */
fun canKill(t: SessionTarget): Boolean = t.addressable && t.live

fun rowKey(t: SessionTarget): String = t.value

/**
 * The rows: the box's configured session first — always, live or not, because
 * it is the selection fallback and, when dead, the only path back — its windows
 * beneath it, then every other live session with its own windows.
 */
fun sessionTargets(status: BoxStatus?, sessionName: String?): List<SessionTarget> {
    val current = sessionName.orEmpty().ifEmpty { "web" } // store.js defaults an absent name to 'web'
    val live = status?.sessions.orEmpty().filter { it.name.isNotEmpty() }
    val currentLive = live.firstOrNull { it.name == current }
    val ordered = listOf(currentLive ?: TmuxSession(name = current)) + live.filter { it.name != current }
    val out = mutableListOf<SessionTarget>()
    for (s in ordered) {
        val isCurrent = s.name == current
        val nameOk = SESSION_NAME_RE.matches(s.name)
        out += SessionTarget(
            kind = TargetKind.SESSION,
            value = "s:${s.name}",
            label = s.name,
            session = s.name,
            current = isCurrent,
            live = !isCurrent || currentLive != null,
            addressable = nameOk,
            reason = if (nameOk) null else UNSWITCHABLE,
        )
        for (w in s.windowList) {
            val idOk = WINDOW_ID_RE.matches(w.id)
            out += SessionTarget(
                kind = TargetKind.WINDOW,
                value = "w:${s.name}:${w.id}",
                label = "${w.index}: ${w.name.ifEmpty { "window" }}",
                session = s.name,
                windowId = w.id,
                current = isCurrent,
                live = true,
                addressable = nameOk && idOk,
                reason = when {
                    !nameOk -> UNSWITCHABLE
                    !idOk -> UNADDRESSABLE_WINDOW
                    else -> null
                },
            )
        }
    }
    return out
}

/**
 * The rows plus the selected one: the current session's ACTIVE window when the
 * snapshot knows it, else the session row. This is what makes the sheet answer
 * "which window am I looking at", not only which session the box points at.
 */
fun sessionTargetList(status: BoxStatus?, sessionName: String?): SessionTargetList {
    val current = sessionName.orEmpty().ifEmpty { "web" }
    val active = status?.sessions.orEmpty()
        .firstOrNull { it.name == current }?.windowList?.firstOrNull { it.active }
    return SessionTargetList(
        options = sessionTargets(status, sessionName),
        value = if (active != null) "w:$current:${active.id}" else "s:$current",
    )
}

/**
 * tmux destroys a session when its last window is killed. Nothing here
 * special-cases that — it just refuses to let it be a surprise, by letting the
 * arm legend say so.
 */
fun isSoleWindow(targets: List<SessionTarget>, t: SessionTarget): Boolean =
    t.kind == TargetKind.WINDOW &&
        targets.count { it.kind == TargetKind.WINDOW && it.session == t.session } == 1

/** What the armed × states before the second tap commits. */
fun killLegend(t: SessionTarget, sole: Boolean): String = when {
    t.kind == TargetKind.SESSION && t.current -> "kill ${t.label}? the app is showing this session"
    t.kind == TargetKind.SESSION -> "kill session ${t.label}?"
    sole && t.current -> "kill ${t.label}? last window — the app's session goes too"
    sole -> "kill ${t.label}? last window — the session goes too"
    else -> "kill ${t.label}?"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd android && ./gradlew test --tests '*SessionTargetsTest*'`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/session/SessionTargets.kt android/app/src/test/java/com/tmuxifier/console/session/SessionTargetsTest.kt
git commit -m "feat(android): pure session/window target model for the sheet"
```

---

### Task 3: The five API calls

**Files:**
- Modify: `android/app/src/main/java/com/tmuxifier/console/api/ApiClient.kt`
- Test: `android/app/src/test/java/com/tmuxifier/console/api/ApiClientBodyTest.kt` (create)

**Interfaces:**
- Consumes: `BoxStatus`, `statusMapSerializer`, `BoxInfo` (Task 1 and existing).
- Produces, on `ApiClient`:
  - `suspend fun probe(boxId: String): Map<String, BoxStatus>`
  - `suspend fun selectWindow(boxId: String, session: String, windowId: String)`
  - `suspend fun killTarget(boxId: String, session: String, windowId: String? = null)`
  - `suspend fun createSession(boxId: String, name: String)`
  - `suspend fun setSession(boxId: String, name: String): BoxInfo`
  - and the testable seam `internal fun killBody(session: String, windowId: String?): String`

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/tmuxifier/console/api/ApiClientBodyTest.kt`:

```kotlin
package com.tmuxifier.console.api

// The one unit-testable part of the HTTP layer: body shaping. There is no
// MockWebServer in this module, so the calls themselves are device-validated.
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientBodyTest {
    @Test fun sessionKillOmitsWindowIdEntirely() {
        // POST /api/boxes/:id/kill branches on the PRESENCE of windowId; an
        // explicit null reads as present-and-invalid and 400s.
        assertEquals("""{"session":"web"}""", killBody("web", null))
    }

    @Test fun windowKillCarriesBothHalves() {
        // Always session-qualified: a grouped session shares window objects, so
        // a bare @3 names two windows and tmux picks whichever it finds first.
        assertEquals("""{"session":"web","windowId":"@3"}""", killBody("web", "@3"))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd android && ./gradlew test --tests '*ApiClientBodyTest*'`
Expected: FAIL — "Unresolved reference: killBody".

- [ ] **Step 3: Add the seam and the calls**

In `ApiClient.kt`, add at file scope (after the `ApiException` class, outside `ApiClient`):

```kotlin
// Split out of killTarget so the presence rule is unit-testable: the route
// branches on whether windowId is there, so a session kill must OMIT it rather
// than send null.
internal fun killBody(session: String, windowId: String?): String = buildJsonObject {
    put("session", session)
    if (windowId != null) put("windowId", windowId)
}.toString()
```

And inside the `ApiClient` class, after `sendWheel`:

```kotlin
    // Re-probe ONE box and hand back its fresh entry, keyed by box id — the
    // same shape GET /api/status answers in. Deliberately un-gated by a running
    // setup job on the server: it only reads what the poller already reads.
    suspend fun probe(boxId: String): Map<String, BoxStatus> =
        parse(statusMapSerializer, request("POST", "/api/boxes/$boxId/probe"))

    // Switch the session's active window. No reattach: the current window is
    // session state in tmux, so every attached client follows on its own.
    suspend fun selectWindow(boxId: String, session: String, windowId: String) {
        request("POST", "/api/boxes/$boxId/window",
            buildJsonObject { put("session", session); put("windowId", windowId) }.toString())
    }

    // Kill a session, or one window inside it. Session-qualified in both forms.
    suspend fun killTarget(boxId: String, session: String, windowId: String? = null) {
        request("POST", "/api/boxes/$boxId/kill", killBody(session, windowId))
    }

    // Create a session detached, WITHOUT switching the box to it — the same
    // ensure-session remote (carrying the box's startupCommand) that the
    // browser's attach path would have run.
    suspend fun createSession(boxId: String, name: String) {
        request("POST", "/api/boxes/$boxId/sessions", buildJsonObject { put("name", name) }.toString())
    }

    // Repoint the box at another session. GLOBAL: the server drops every
    // viewer's PTY so browsers reattach to the new session.
    suspend fun setSession(boxId: String, name: String): BoxInfo =
        parse(BoxInfo.serializer(), request("PATCH", "/api/boxes/$boxId",
            buildJsonObject { put("sessionName", name) }.toString()))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd android && ./gradlew test --tests '*ApiClientBodyTest*'`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/api/ApiClient.kt android/app/src/test/java/com/tmuxifier/console/api/ApiClientBodyTest.kt
git commit -m "feat(android): probe, window, kill, create and session-switch calls"
```

---

### Task 4: The sheet

**Files:**
- Create: `android/app/src/main/java/com/tmuxifier/console/ui/SessionSheet.kt`

**Interfaces:**
- Consumes: everything from Tasks 1–3, plus `keys/Arming.kt`'s `ArmState`/`armReduce`/`ARM_MS` and `AppState`.
- Produces: `@Composable fun SessionSheet(state: AppState, boxId: String, boxLabel: String, sessionName: String, initialStatus: BoxStatus?, onDismiss: () -> Unit, onUnauthorized: () -> Unit)` and `const val OPEN_REFRESH_WAIT_MS = 700L`.

No unit test: this module has no Compose test harness, and adding one is out of scope (Global Constraints). It is covered by Task 7's device checklist. The compile is the only automated gate — which is why Step 2 runs a full build, not just the tests.

- [ ] **Step 1: Write the sheet**

Create `android/app/src/main/java/com/tmuxifier/console/ui/SessionSheet.kt`:

```kotlin
package com.tmuxifier.console.ui

// The session sheet: a box's tmux sessions and windows, with switch, kill and
// create. Opened by a long press on a Fleet card or the Session header's chip.
// The rows come from the pure model in session/SessionTargets.kt; this file
// owns only presentation, the arm-then-fire policy, and the calls.
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.tmuxifier.console.AppState
import com.tmuxifier.console.api.ApiException
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.keys.ARM_MS
import com.tmuxifier.console.keys.ArmState
import com.tmuxifier.console.keys.armReduce
import com.tmuxifier.console.session.RowAction
import com.tmuxifier.console.session.SESSION_NAME_RE
import com.tmuxifier.console.session.SessionTarget
import com.tmuxifier.console.session.TargetKind
import com.tmuxifier.console.session.canKill
import com.tmuxifier.console.session.isSoleWindow
import com.tmuxifier.console.session.killLegend
import com.tmuxifier.console.session.rowAction
import com.tmuxifier.console.session.rowKey
import com.tmuxifier.console.session.sessionTargetList
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// How long the open path waits for a fresh probe before showing the list it
// already has. Long enough for a healthy box over the ControlMaster, short
// enough that a box which has gone away is a slightly-late list, not a dead
// sheet. Mirrors the web's freshProbe.ts cap.
const val OPEN_REFRESH_WAIT_MS = 700L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionSheet(
    state: AppState,
    boxId: String,
    boxLabel: String,
    sessionName: String,
    initialStatus: BoxStatus?,
    onDismiss: () -> Unit,
    onUnauthorized: () -> Unit,
) {
    val client = state.client() ?: return
    var status by remember(boxId) { mutableStateOf(initialStatus) }
    var refreshing by remember(boxId) { mutableStateOf(false) }
    var busy by remember(boxId) { mutableStateOf(false) }
    var error by remember(boxId) { mutableStateOf<String?>(null) }
    var arm by remember(boxId) { mutableStateOf(ArmState()) }
    var creating by remember(boxId) { mutableStateOf(false) }
    var newName by remember(boxId) { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState()

    // quiet: an open-path probe that fails while we already have rows is a
    // slightly-stale list, not something to shout about. After an action it is.
    suspend fun refresh(quiet: Boolean) {
        try {
            client.probe(boxId)[boxId]?.let { status = it }
        } catch (e: ApiException) {
            when {
                e.status == 401 -> onUnauthorized()
                quiet && status != null -> Unit
                else -> error = e.message
            }
        }
    }

    fun act(block: suspend () -> Unit) {
        scope.launch {
            busy = true
            error = null
            arm = ArmState()
            try {
                block()
                // The window and kill routes re-probe server-side, so this
                // reads an authoritative snapshot rather than a 30s cache.
                refresh(quiet = false)
            } catch (e: ApiException) {
                when (e.status) {
                    401 -> onUnauthorized()
                    404 -> { error = e.message; onDismiss() }
                    else -> error = e.message
                }
            } finally {
                busy = false
            }
        }
    }

    // Open on whatever is in hand, then probe — and stop WAITING after the cap,
    // never stop probing: a late answer still lands and repaints the rows.
    LaunchedEffect(boxId) {
        refreshing = true
        scope.launch { refresh(quiet = true) }
        delay(OPEN_REFRESH_WAIT_MS)
        refreshing = false
    }
    LaunchedEffect(arm) {
        if (arm.armed != null) {
            delay(ARM_MS)
            arm = ArmState()
        }
    }

    val list = sessionTargetList(status, sessionName)

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().padding(bottom = 28.dp)) {
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(boxLabel, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                if (refreshing || busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            }
            for (t in list.options) {
                TargetRow(
                    t = t,
                    selected = t.value == list.value,
                    sole = isSoleWindow(list.options, t),
                    armed = arm.armed == rowKey(t),
                    enabled = !busy,
                    onTap = {
                        arm = ArmState()
                        when (rowAction(t)) {
                            RowAction.SWITCH ->
                                if (t.kind == TargetKind.WINDOW) {
                                    act { client.selectWindow(boxId, t.session, t.windowId!!) }
                                } else {
                                    act { client.setSession(boxId, t.session) }
                                }
                            RowAction.RECREATE -> act { client.createSession(boxId, t.session) }
                            RowAction.SELECTED, RowAction.NONE -> Unit
                        }
                    },
                    onKill = {
                        val (next, fire) = armReduce(arm, rowKey(t), armable = true)
                        arm = next
                        if (fire != null) act { client.killTarget(boxId, t.session, t.windowId) }
                    },
                )
            }
            if (creating) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = newName,
                        onValueChange = { newName = it },
                        singleLine = true,
                        label = { Text("session name") },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        modifier = Modifier.weight(1f),
                    )
                    // A courtesy, not a gate: the server rejects rather than
                    // silently renaming, and learning the charset after a round
                    // trip is a worse way to learn it.
                    TextButton(
                        enabled = !busy && SESSION_NAME_RE.matches(newName),
                        onClick = {
                            val name = newName
                            act {
                                client.createSession(boxId, name)
                                newName = ""
                                creating = false
                            }
                        },
                    ) { Text("Create") }
                }
            } else {
                TextButton(onClick = { creating = true }, modifier = Modifier.padding(horizontal = 8.dp)) {
                    Text("+ New session…")
                }
            }
            Text(
                "Switching a session repoints this box everywhere — open browsers reconnect to it.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
            error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
        }
    }
}

// One row: tap the body to act, the trailing × to kill. Windows are indented
// with padding rather than with characters in the label.
@Composable
private fun TargetRow(
    t: SessionTarget,
    selected: Boolean,
    sole: Boolean,
    armed: Boolean,
    enabled: Boolean,
    onTap: () -> Unit,
    onKill: () -> Unit,
) {
    val action = rowAction(t)
    val dim = action == RowAction.NONE
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled && action != RowAction.NONE, onClick = onTap)
            .padding(start = if (t.kind == TargetKind.WINDOW) 40.dp else 16.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (selected) "✓" else " ",
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(end = 8.dp),
        )
        Column(Modifier.weight(1f).padding(vertical = 10.dp)) {
            Text(
                t.label,
                style = MaterialTheme.typography.bodyLarge,
                color = if (dim) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            )
            val note = when {
                t.reason != null -> t.reason
                action == RowAction.RECREATE -> "not running — tap to recreate"
                else -> null
            }
            note?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (canKill(t)) {
            TextButton(enabled = enabled, onClick = onKill) {
                Text(
                    if (armed) killLegend(t, sole) else "×",
                    color = MaterialTheme.colorScheme.error,
                    style = if (armed) MaterialTheme.typography.bodySmall else MaterialTheme.typography.titleMedium,
                )
            }
        }
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' android/app/src/main/java/com/tmuxifier/console/ui/SessionSheet.kt` — expect NO output (no raw control bytes).
Then: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL. If `ModalBottomSheet` or `rememberModalBottomSheetState` reports an opt-in error, the `@OptIn(ExperimentalMaterial3Api::class)` above the composable is missing or misplaced — it must annotate `SessionSheet`, which is where both are used.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/ui/SessionSheet.kt
git commit -m "feat(android): session sheet with switch, kill and create"
```

---

### Task 5: Fleet long-press entry

**Files:**
- Modify: `android/app/src/main/java/com/tmuxifier/console/fleet/FleetModel.kt`
- Modify: `android/app/src/main/java/com/tmuxifier/console/ui/FleetScreen.kt`
- Test: `android/app/src/test/java/com/tmuxifier/console/fleet/FleetModelTest.kt`

**Interfaces:**
- Consumes: `SessionSheet(...)` (Task 4), `BoxStatus` (Task 1).
- Produces: `BoxCard.sessionName: String` — the box's configured session, which the sheet needs and `fleetCards` currently discards.

- [ ] **Step 1: Write the failing test**

Append to `FleetModelTest.kt` (inside the class):

```kotlin
    @Test fun cardsCarryTheConfiguredSessionName() {
        val cards = fleetCards(
            boxes = listOf(
                BoxInfo(id = "b1", label = "alpha", sessionName = "web"),
                BoxInfo(id = "b2", label = "beta"),
            ),
            status = emptyMap(),
            series = emptyMap(),
            now = 0L,
        )
        assertEquals("web", cards.first { it.id == "b1" }.sessionName)
        // An unset name stays empty here; the target model applies store.js's
        // 'web' default in one place rather than two.
        assertEquals("", cards.first { it.id == "b2" }.sessionName)
    }
```

`BoxInfo` and `assertEquals` are already imported in that file; the local `box()` helper is not
used here because this test needs one box with an explicit `sessionName` and one without.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd android && ./gradlew test --tests '*FleetModelTest*'`
Expected: FAIL — "Unresolved reference: sessionName".

- [ ] **Step 3: Add the field**

In `FleetModel.kt`, add to `BoxCard` after `label`:

```kotlin
    val sessionName: String,   // the box's configured tmux session — what the sheet opens on
```

and in `fleetCards`'s `BoxCard(...)` construction, after `label = ...`:

```kotlin
            sessionName = box.sessionName,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd android && ./gradlew test --tests '*FleetModelTest*'`
Expected: PASS.

- [ ] **Step 5: Wire the long press**

In `FleetScreen.kt`:

Add imports:

```kotlin
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import com.tmuxifier.console.api.BoxStatus
```

Keep the raw status map beside the cards. Next to `var cards by remember { ... }` add:

```kotlin
    var statuses by remember { mutableStateOf<Map<String, BoxStatus>>(emptyMap()) }
    var sheetFor by remember { mutableStateOf<BoxCard?>(null) }
```

In the poll, keep the status map the sheet opens on. Replace this block:

```kotlin
                    coroutineScope {
                        val b = async { client.boxes() }
                        val st = async { client.status() }
                        val se = async { client.series() }
                        cards = fleetCards(b.await(), st.await(), se.await(), System.currentTimeMillis())
                    }
```

with:

```kotlin
                    coroutineScope {
                        val boxesJob = async { client.boxes() }
                        val statusJob = async { client.status() }
                        val seriesJob = async { client.series() }
                        // The sheet opens on this snapshot; fleetCards keeps only
                        // what a card draws, and the rows need the sessions.
                        val st = statusJob.await()
                        statuses = st
                        cards = fleetCards(boxesJob.await(), st, seriesJob.await(), System.currentTimeMillis())
                    }
```

Change the row call site to pass both gestures:

```kotlin
            items(cards, key = { it.id }) { card ->
                BoxCardRow(
                    card,
                    onClick = { onOpen(Screen.Session(card.id, card.label)) },
                    onLongClick = { sheetFor = card },
                )
            }
```

And render the sheet at the end of the outer `Column` (after the `LazyColumn`):

```kotlin
        sheetFor?.let { card ->
            SessionSheet(
                state = state,
                boxId = card.id,
                boxLabel = card.label,
                sessionName = card.sessionName,
                initialStatus = statuses[card.id],
                onDismiss = { sheetFor = null },
                onUnauthorized = onUnauthorized,
            )
        }
```

Finally, `BoxCardRow` takes the long press and fires the haptic itself, so every caller gets the same feel:

```kotlin
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BoxCardRow(card: BoxCard, onClick: () -> Unit, onLongClick: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    Surface(
        shape = RoundedCornerShape(10.dp),
        tonalElevation = 2.dp,
        modifier = Modifier.fillMaxWidth().combinedClickable(
            onClick = onClick,
            onLongClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onLongClick()
            },
        ),
    ) {
```

(The rest of `BoxCardRow`'s body is unchanged.)

- [ ] **Step 6: Build and run the whole JVM suite**

Run: `cd android && ./gradlew test assembleDebug`
Expected: BUILD SUCCESSFUL, all tests green. If the compiler reports `@OptIn(ExperimentalFoundationApi::class)` as unnecessary, delete that one annotation — `combinedClickable` is stable in this foundation version and the warning is harmless either way.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/fleet/FleetModel.kt android/app/src/main/java/com/tmuxifier/console/ui/FleetScreen.kt android/app/src/test/java/com/tmuxifier/console/fleet/FleetModelTest.kt
git commit -m "feat(android): long-press a fleet card to open the session sheet"
```

---

### Task 6: Session header chip entry

**Files:**
- Modify: `android/app/src/main/java/com/tmuxifier/console/ui/SessionScreen.kt:152-169` (the header `Row`)

**Interfaces:**
- Consumes: `SessionSheet(...)` (Task 4). The screen already holds `snap: PaneSnapshot?`, whose `sessionName` is the box's configured session.
- Produces: nothing for later tasks.

- [ ] **Step 1: Add the chip and host the sheet**

In `SessionScreen.kt`, add near the other `remember` declarations at the top of the composable:

```kotlin
    var sheetOpen by remember(boxId) { mutableStateOf(false) }
```

In the header `Row`, insert a button between the label `Text` and the agent chip — a `TextButton`, matching the `browser` button already in that row rather than the translucent `PaneChip`, which is styled to overlay the dark pane:

```kotlin
            snap?.sessionName?.takeIf { it.isNotEmpty() }?.let { name ->
                TextButton(onClick = { sheetOpen = true }) { Text("$name ▾") }
            }
```

And at the end of the outer `Column` (after the pane `BoxWithConstraints` and `bottomBar()`):

```kotlin
        if (sheetOpen) {
            SessionSheet(
                state = state,
                boxId = boxId,
                boxLabel = boxLabel,
                sessionName = snap?.sessionName.orEmpty(),
                // This screen polls /pane, never /api/status, so it has no
                // cached sessions: the sheet opens on the configured-session
                // row alone and fills in from its own probe.
                initialStatus = null,
                onDismiss = { sheetOpen = false },
                onUnauthorized = onUnauthorized,
            )
        }
```

- [ ] **Step 2: Build**

Run: `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' android/app/src/main/java/com/tmuxifier/console/ui/SessionScreen.kt` — expect NO output (the `▾` must be a literal glyph, not an escape).
Then: `cd android && ./gradlew test assembleDebug`
Expected: BUILD SUCCESSFUL, all tests green.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/ui/SessionScreen.kt
git commit -m "feat(android): session header chip opens the session sheet"
```

---

### Task 7: Docs, version, and device validation

**Files:**
- Modify: `docs/android-app.md:29-53` (the Screens section)
- Modify: `android/app/build.gradle.kts:17-18` (versionCode/versionName)

**Interfaces:**
- Consumes: the finished feature.
- Produces: a validated, installable build.

- [ ] **Step 1: Document the sheet**

In `docs/android-app.md`, extend the **Fleet** bullet's last sentence and add a sentence to **Session**:

Fleet — after "Tap a card to open its session.":

```markdown
  **Long-press** a card for its session sheet: every tmux session on the box with its windows
  beneath it, a ✓ on the one you're looking at. Tap a row to switch the box to that session or
  window, `×` to kill it (two taps — the first arms and says what it will take, including when a
  window is the session's last), or **+ New session…** to create one without switching to it.
```

Session — after the "browser" mention in that bullet:

```markdown
  The header's `web ▾` chip opens the same session sheet, so you can retarget without leaving
  the pane. Switching the **session** repoints the box everywhere — open browsers reconnect to
  it; switching a **window** needs no reconnect at all. Killing the session the app is showing
  is allowed: the pane goes dark and the row it leaves behind recreates it in one tap.
```

- [ ] **Step 2: Bump the app version**

In `android/app/build.gradle.kts`:

```kotlin
        versionCode = 20
        versionName = "1.2.0"
```

Play's internal-testing track refuses an upload at or below the last one (vc19), so this bump is mandatory, not cosmetic.

- [ ] **Step 3: Build the installable APK**

Run: `cd android && ./gradlew test assembleDebug`
Expected: BUILD SUCCESSFUL; APK at `android/app/build/outputs/apk/debug/app-debug.apk`.

Install it over the previous build (`adb install -r <apk>`); if the install is refused for a signature mismatch, uninstall first — the debug and release keys differ.

- [ ] **Step 4: Run the device checklist**

Against a real box, in order. This is the ONLY coverage the sheet's UI has.

1. Long-press a Fleet card → the sheet opens with the box's sessions and windows, ✓ on the active window.
2. Open a session, tap the header chip → the same sheet, same rows.
3. Switch to another window → the pane changes within a second and the ✓ moves. A browser attached to that session follows it WITHOUT reconnecting.
4. Switch to another session → the pane follows; the browser's terminal reconnects onto the new session.
5. Create a session from the sheet → it appears as a row and the box does NOT switch to it.
6. Kill a window in a session that has two → first tap arms with the plain legend, second kills, the row goes.
7. Kill a sole window → the legend says the session goes too, and it does.
8. Kill the configured session → the pane errors, its row survives marked "not running", tapping it recreates the session, and the pane recovers with no browser involved.
9. A box with a setup job running → the sheet still opens (probe is un-gated) and every action reports the server's 409 rather than failing silently.
10. Aeroplane mode → the sheet still shows the configured-session row plus an error line, not a spinner that never resolves.

Any failure here is fixed on this branch and the checklist re-run from step 1 — not deferred.

- [ ] **Step 5: Commit**

```bash
git add docs/android-app.md android/app/build.gradle.kts
git commit -m "docs(android): session sheet in the app guide; bump to 1.2.0 (vc20)"
```

- [ ] **Step 6: Hand off the release build**

The signed artifacts are the operator's step, not the agent's: `./gradlew assembleRelease` publishes to `data/app/tmuxifier-console.apk` only by the operator's copy, and `./gradlew bundleRelease` produces the AAB they upload to Play's internal testing track. Report both paths and stop — do not copy into `data/app/` or attach anything to a GitHub release.

---

## Self-Review

**Spec coverage:** Entry points → Tasks 5, 6. Row model incl. `live`/`addressable`/`current` → Task 2. Row-state table → `rowAction`/`canKill` (Task 2) rendered in Task 4. Freshness (open-on-cache, 700 ms cap, re-probe after actions) → Task 4. API surface → Task 3. Error table → Task 4's `act`/`refresh`. Consequences copy ("repoints this box everywhere", recreate row) → Task 4. Testing discipline → Task 2's fixtures; device checklist → Task 7. Deferred items are deliberately untouched: no web file, no server file, and no `data/app/` publish appear in any task.

**Deviations from the web, carried by tests (the spec agrees; noting them here because they are
the two places an implementer familiar with `sessionPicker.ts` would "correct" the code back into
a bug):** a row whose session name fails `SESSION_NAME_RE` offers no action at all — including its
windows, and including when it is the CURRENT session, because `POST /window` sends the session
too; and window labels carry no indent characters, because a Compose row indents with padding.
Locked by `unaddressableNamesOfferNoAction`, `windowsOfAnUnaddressableCurrentSessionAreAlsoUnaddressable`
and `windowRowsAreLabelledByIndexAndName` in Task 2.
