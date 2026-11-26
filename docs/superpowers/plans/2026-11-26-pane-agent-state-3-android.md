# Pane-Level Agent State, Plan 3 of 3: Android App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Android app reads agent state per tmux pane: one row per agent under each fleet card, the on-screen pane's own chip, a jump to an agent from a row or a push, one notification per agent, and acknowledgement of a finished turn the app is showing.

**Architecture:** The app stays a renderer of the server APIs. A new pure package `agent/` holds the row naming and ordering, the acknowledgement reducer and the jump planner; a pure `push/PushTarget.kt` parses push data. The Compose screens and `MainActivity` only call them. `ApiClient` gains two request bodies and one new call.

**Tech Stack:** Kotlin 2.1.0, Jetpack Compose (BOM 2024.12.01), kotlinx.serialization-json 1.7.3, OkHttp 4.12.0, kotlin-test and kotlinx-coroutines-test on the JVM, Gradle wrapper 8.10.2 (AGP 8.7.3).

**Spec:** `docs/superpowers/specs/2026-11-26-pane-level-agent-state-design.md`. This plan implements section 8.4 with the shapes of sections 4.3, 4.4, 4.5, 5, 7.1 and 8.2. Read those, the "Android app (`android/`)" section of `CLAUDE.md`, and `android/README.md` before any task. Plan 1 of 3 (`docs/superpowers/plans/2026-11-26-pane-agent-state-1-core.md`: server, browser, mail, MCP) builds the server side of the contract below; this plan never touches `src/`.

## Global Constraints

- Work only in the `pane-agent-state` worktree (branch `pane-agent-state`), never in the main checkout. Touch only `android/` and the documentation files a task names. No server or web code.
- The app never speaks SSH or tmux. Every session name, window id and pane id is checked in the app before it goes into a request (`SESSION_NAME_RE`, `WINDOW_ID_RE`, `PANE_ID_RE = ^%\d{1,9}$`), always with `Regex.matches`; a value that fails is dropped, never rewritten. The server validates again.
- States on the wire: `working`, `blocked`, `done`, `idle`. Precedence, worst first: `blocked`, `done`, `working`, `idle`. Chip text: the state word, except `blocked` with a cause reads `blocked · <cause>` (U+00B7 between spaces).
- Row name, identical to the browser's: `<windowIndex>:<windowName>` (`window` when the name is empty); `.<paneIndex>` appended only when the box has more than one agent entry with the same `session` and `windowId`; `<session> › ` (U+203A between spaces) prefixed only when the box's agent entries span more than one session. Both counts are over agent **entries**; only entries with a `state` become rows. Order: session (plain `String.compareTo`, no lowercasing), then `windowIndex`, then `paneIndex`. Only the newest sample's `agents` counts.
- The app tolerates both server generations for this release: a sample with no `agents` key, and today's server whose `agents` is keyed by **session name** with entries of another shape. Both render no agent rows and never crash.
- Acknowledgement: only from the session screen, only while it is in front, only for the pane it rendered, only when the capture reads `done` and carries `pane` and `agentTs`; once per `(boxId, pane, agentTs)`.
- The Host Shell gets no rows in the app (its routes are browser-only); `fleetCards` keeps iterating `GET /api/boxes` only.
- App version: `versionCode = 23`, `versionName = "1.3.0"`.
- TDD: the failing test first. Pure logic is JVM-tested with real code (the module has no mocking library and no MockWebServer). Compose and `MainActivity` wiring is validated on a real device only: a UI task ends with a device checklist for the operator. An agent executing the plan stops at that step and reports the checklist as pending; it never ticks it. The operator may walk several checklists on one build.
- Gradle, from `android/`, exactly as `android/README.md` gives it: `./gradlew test` (JVM tests) and `./gradlew assembleDebug`. The memory caps in `android/gradle.properties` are load-bearing: never raise them. One Gradle run at a time; on the host that also runs the live server add `--no-daemon`, as the server's own build job does.
- The source writes `›` and `·` as the literal UTF-8 characters (as `FleetModel.kt` already does for `·`); the tests spell them `›` and `·`, so a mangled byte on either side fails a test. After writing any file that holds either form, run from `android/`: `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' app/src` and expect no output.
- Public repo: placeholders only in code, tests and docs (`b1`, `box.example.com`, `192.168.1.10`).
- Commits: conventional messages (`feat(android): …`), ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Commit only the files a task names; never a build output.

## Review Focus

1. **A server of the current generation** (`agents` keyed by session name, entries holding `present`), and one with no `agents` key. Expected: no rows, the fleet list and session screen work as before, no crash. Tests in Tasks 1, 2 and 3; device item in Task 3.
2. **A push tapped after its session or window was killed.** Expected: the box opens on whatever it points at now; it is never repointed at a session the server does not list. Test in Task 5 (`targetListed`), wiring and device item in Task 7.
3. **The activity recreated with the push intent still attached** (fold or unfold, rotation, reopening from recents). Expected: no second jump; windows the operator has since switched stay where they are. Rule and device items in Task 7.
4. **An acknowledgement that fails or is refused while captures keep arriving every second.** Expected: never two posts in flight; a transport or 5xx failure is retried on a later capture; a 4xx refusal is not posted again. Test in Task 4.
5. **One window holding two agents of which one has no marker; two sessions holding agents of which one has no marker.** Expected: the lone row still carries `.paneIndex`, respectively `session ›`, exactly as the browser names it. Test in Task 2.

---

## Server contract (built by plan 1; fixed)

- `GET /api/health/series` → `{ [boxId]: Sample[] }`. A sample has no `agent`. It has `agents`, an object keyed by pane id (`"%12"`); each value is `{ session, windowId, windowIndex, windowName, paneIndex, agent, state?, cause?, ts?, visible, focused, attached }`. Only panes running an agent appear; `state` is absent without a marker.
- `GET /api/boxes/:id/pane` → the existing fields plus `agent` (state of the captured pane, or null), `agentCause`, `pane` (the captured pane's id, when known) and `agentTs` (its marker's `ts`, when it has one). A device token cannot pass `session` or `pane`.
- `POST /api/boxes/:id/agent-seen` body `{ "pane": "%12", "ts": <agentTs> }` → 200, or 400 when there is nothing to acknowledge.
- `POST /api/boxes/:id/window` body `{ "session", "windowId", "paneId"? }`: selects the window and, with `paneId`, focuses that pane. 409 while setup runs, 502 on failure.
- FCM data: `boxId`, `kind` (`agent-blocked` | `agent-input` | `agent-done`), `session`, and new `pane` and `windowId`. The last two may be absent (older server).

## File structure

| File (under `android/app/src/`) | Change | Responsibility |
|---|---|---|
| `main/…/api/Models.kt` | modify | `AgentEntry`, `Sample.agents`, three new `PaneSnapshot` fields; `Sample.agent` removed (Task 3) |
| `main/…/api/ApiClient.kt` | modify | `decodeResponse`, `agentSeenBody`/`agentSeen`, `windowBody`/`selectWindow(paneId)` |
| `main/…/session/SessionTargets.kt` | modify | `PANE_ID_RE` beside `WINDOW_ID_RE` |
| `main/…/agent/AgentRows.kt` | create | states, chip text, validation of the newest sample, row naming and order |
| `main/…/agent/AgentAck.kt` | create | the acknowledgement reducer |
| `main/…/agent/AgentJump.kt` | create | jump target, planner, the "does the server still list it" check, the step runner |
| `main/…/push/PushTarget.kt` | create | push data → target; notification id |
| `main/…/fleet/FleetModel.kt` | modify | `BoxCard.agents`/`worst`, the card sort |
| `main/…/ui/AgentChip.kt` | create | the one chip composable both screens use |
| `main/…/ui/FleetScreen.kt`, `ui/SessionScreen.kt`, `MainActivity.kt`, `push/Push.kt`, `push/PushService.kt` | modify | wiring |
| `test/…/agent/AgentRowsTest.kt`, `AgentAckTest.kt`, `AgentJumpTest.kt`, `test/…/push/PushTargetTest.kt` | create | JVM tests |
| `test/…/api/ModelsTest.kt`, `api/ApiClientBodyTest.kt`, `fleet/FleetModelTest.kt`, `session/SessionTargetsTest.kt` | modify | JVM tests |

`…` is `java/com/tmuxifier/console`. Below, `./gradlew` and `grep` run from `android/`; `git` and `npx` run from the worktree root.

---

### Task 1: Wire shapes

**Files:**
- Modify: `app/src/main/java/com/tmuxifier/console/api/Models.kt:72-100`
- Modify: `app/src/main/java/com/tmuxifier/console/api/ApiClient.kt:74`
- Modify: `app/src/main/java/com/tmuxifier/console/session/SessionTargets.kt:14-15`
- Test: `app/src/test/java/com/tmuxifier/console/api/ModelsTest.kt`, `api/ApiClientBodyTest.kt`, `session/SessionTargetsTest.kt`

**Interfaces:**
- Produces:
  - `@Serializable data class AgentEntry(val session: String? = null, val windowId: String? = null, val windowIndex: Int? = null, val windowName: String? = null, val paneIndex: Int? = null, val state: String? = null, val cause: String? = null)`. Exactly these seven fields: the server's `agent`, `ts`, `visible`, `focused` and `attached` are deliberately not read (nothing in the app renders them), and every field is nullable so today's session-keyed entries decode.
  - `Sample.agents: Map<String, AgentEntry> = emptyMap()` (added; `Sample.agent` stays until Task 3 removes its last reader).
  - `PaneSnapshot.agentCause: String? = null`, `PaneSnapshot.pane: String? = null`, `PaneSnapshot.agentTs: Long? = null`.
  - `val PANE_ID_RE = Regex("^%\\d{1,9}$")` in `SessionTargets.kt`.
  - `internal fun <T> decodeResponse(s: DeserializationStrategy<T>, text: String): T` in `ApiClient.kt`: decodes with `ApiJson`; a `SerializationException` becomes `ApiException(0, "unexpected response from the server")`. `ApiClient.parse` calls it. Status 0 is what every screen already treats as "retry", so a response this build cannot read shows "offline — retrying" instead of killing the process (today a decode failure escapes every `catch (e: ApiException)`).

- [ ] **Step 1: Write the failing tests**

`ModelsTest.kt` (add; keep the existing tests, `seriesParses` included):

```kotlin
@Test fun seriesCarriesPaneKeyedAgents() {
    val s = ApiJson.decodeFromString(seriesMapSerializer,
        """{"b1":[{"t":1723180000000,"up":true,"agents":{"%12":{"session":"main","windowId":"@3","windowIndex":2,"windowName":"frontend","paneIndex":1,"agent":"claude","state":"blocked","cause":"permission","ts":1723180000,"visible":true,"focused":false,"attached":true},"%14":{"session":"main","windowId":"@4","windowIndex":3,"windowName":"","paneIndex":0,"agent":"codex","visible":false,"focused":false,"attached":true}}}]}""")
    val agents = s["b1"]!!.last().agents
    assertEquals(setOf("%12", "%14"), agents.keys)
    assertEquals(
        AgentEntry(session = "main", windowId = "@3", windowIndex = 2, windowName = "frontend", paneIndex = 1, state = "blocked", cause = "permission"),
        agents["%12"],
    )
    assertNull(agents["%14"]?.state) // an agent pane with no marker carries no state
}

@Test fun olderServerSampleHasNoAgentsKey() {
    val s = ApiJson.decodeFromString(seriesMapSerializer, """{"b1":[{"t":1,"up":true,"agent":"working","agentPresent":true}]}""")
    assertTrue(s["b1"]!!.last().agents.isEmpty())
}

@Test fun sessionKeyedAgentsOfTheCurrentServerDecode() {
    // What the server sends before plan 1: keyed by SESSION name, another entry shape.
    val s = ApiJson.decodeFromString(seriesMapSerializer,
        """{"b1":[{"t":1,"up":true,"agent":"working","agentPresent":true,"agentAttached":false,"agents":{"main":{"present":true,"attached":false,"agent":"claude","state":"working","cause":"prompt","ts":1723180000},"logs":{"present":false,"attached":true}}}]}""")
    assertEquals(setOf("main", "logs"), s["b1"]!!.last().agents.keys)
    assertNull(s["b1"]!!.last().agents["main"]?.windowId)
}

@Test fun paneSnapshotCarriesItsPaneAndMarkerTs() {
    val snap = ApiJson.decodeFromString(PaneSnapshot.serializer(),
        """{"ok":true,"width":80,"height":24,"cursorX":0,"cursorY":0,"content":"x","agent":"blocked","agentCause":"permission","pane":"%12","agentTs":1723180000,"sessionName":"main"}""")
    assertEquals("blocked", snap.agent)
    assertEquals("permission", snap.agentCause)
    assertEquals("%12", snap.pane)
    assertEquals(1723180000L, snap.agentTs)
}

@Test fun olderServerPaneSnapshotHasNeitherPaneNorTs() {
    val snap = ApiJson.decodeFromString(PaneSnapshot.serializer(),
        """{"ok":true,"width":80,"height":24,"cursorX":0,"cursorY":0,"content":"x","agent":null,"agentCause":null,"sessionName":"main"}""")
    assertNull(snap.pane)
    assertNull(snap.agentTs)
    assertNull(snap.agentCause)
}
```

`ApiClientBodyTest.kt` (add):

```kotlin
@Test fun aResponseThatDoesNotDecodeIsAnApiException() {
    val e = assertFailsWith<ApiException> { decodeResponse(seriesMapSerializer, """{"b1":[{"t":"soon","up":true}]}""") }
    assertEquals(0, e.status)
}

@Test fun aResponseThatDecodesIsReturned() {
    assertEquals(1L, decodeResponse(seriesMapSerializer, """{"b1":[{"t":1,"up":true}]}""")["b1"]!!.single().t)
}
```

`SessionTargetsTest.kt` (add):

```kotlin
@Test fun paneIdsAreAPercentSignAndOneToNineDigits() {
    for (ok in listOf("%0", "%12", "%123456789")) assertTrue(PANE_ID_RE.matches(ok), ok)
    for (bad in listOf("", "%", "12", "@3", "%1a", " %1", "%1 ", "%1234567890", "%-1")) assertFalse(PANE_ID_RE.matches(bad), bad)
}
```

- [ ] **Step 2: Run** `./gradlew test` — FAIL at test compilation: unresolved references `AgentEntry`, `agents`, `agentCause`, `pane`, `agentTs`, `decodeResponse`, `PANE_ID_RE`.
- [ ] **Step 3: Implement the Produces list.** Extend the `Models.kt` header comment with one line: `agents` is keyed by tmux pane id, and an entry that does not fit is dropped by `agent/AgentRows.kt`, never here.
- [ ] **Step 4: Run** `./gradlew test` — PASS.
- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/api/Models.kt android/app/src/main/java/com/tmuxifier/console/api/ApiClient.kt android/app/src/main/java/com/tmuxifier/console/session/SessionTargets.kt android/app/src/test/java/com/tmuxifier/console/api/ModelsTest.kt android/app/src/test/java/com/tmuxifier/console/api/ApiClientBodyTest.kt android/app/src/test/java/com/tmuxifier/console/session/SessionTargetsTest.kt
git commit -m "feat(android): pane-keyed agent entries on the wire models"
```

### Task 2: Agent rows (pure)

**Files:**
- Create: `app/src/main/java/com/tmuxifier/console/agent/AgentRows.kt`
- Test: `app/src/test/java/com/tmuxifier/console/agent/AgentRowsTest.kt`

**Interfaces:**
- Consumes: Task 1's `AgentEntry`, `Sample.agents`, `PANE_ID_RE`; `SESSION_NAME_RE`, `WINDOW_ID_RE` from `session/SessionTargets.kt`.
- Produces (package `com.tmuxifier.console.agent`, no Android imports):
  - `enum class AgentState(val wire: String) { BLOCKED("blocked"), DONE("done"), WORKING("working"), IDLE("idle") }`. Declaration order is the precedence, worst first; `ordinal` is the rank.
  - `fun agentStateOf(wire: String?): AgentState?` — exact match on the four words, anything else `null`.
  - `fun agentChipText(state: AgentState, cause: String?): String`
  - `data class AgentPane(val pane: String, val session: String, val windowId: String, val windowIndex: Int, val windowName: String, val paneIndex: Int, val state: AgentState?, val cause: String?)`
  - `fun latestAgents(samples: List<Sample>?): List<AgentPane>` — the newest sample's entries that fit. An entry is kept only when its key matches `PANE_ID_RE`, `session` matches `SESSION_NAME_RE`, `windowId` matches `WINDOW_ID_RE`, and `windowIndex` and `paneIndex` are non-null and `>= 0`. A null `windowName` is `""`. `state` is `agentStateOf(entry.state)`. `cause` is kept only when it matches `^[a-z][a-z_-]{0,23}$` (a shape, not a list: causes are server-defined), else `null` with the entry kept.
  - `data class AgentRow(val pane: String, val name: String, val session: String, val windowId: String, val state: AgentState, val cause: String?)`
  - `fun agentRows(agents: List<AgentPane>): List<AgentRow>` — the naming and ordering rule of Global Constraints.
  - `fun worstState(rows: List<AgentRow>): AgentState?`

- [ ] **Step 1: Write the failing tests** (`AgentRowsTest.kt`)

```kotlin
private fun entry(session: String, windowId: String, windowIndex: Int, windowName: String, paneIndex: Int, state: String? = null, cause: String? = null) =
    AgentEntry(session = session, windowId = windowId, windowIndex = windowIndex, windowName = windowName, paneIndex = paneIndex, state = state, cause = cause)
private fun newest(vararg agents: Pair<String, AgentEntry>) = listOf(Sample(t = 1, up = true, agents = mapOf(*agents)))
private fun names(vararg agents: Pair<String, AgentEntry>) = agentRows(latestAgents(newest(*agents))).map { it.name }

class AgentRowsTest {
    @Test fun oneAgentPerWindowIsNamedByItsWindow() {
        val rows = agentRows(latestAgents(newest(
            "%1" to entry("main", "@1", 1, "api", 0, "blocked", "permission"),
            "%2" to entry("main", "@2", 2, "frontend", 0, "working"))))
        assertEquals(listOf("1:api", "2:frontend"), rows.map { it.name })
        assertEquals(AgentRow("%1", "1:api", "main", "@1", AgentState.BLOCKED, "permission"), rows.first())
    }

    @Test fun twoAgentsInOneWindowGetTheirPaneIndex() {
        assertEquals(listOf("1:api", "2:frontend.1", "2:frontend.2"), names(
            "%1" to entry("main", "@1", 1, "api", 0, "blocked", "permission"),
            "%2" to entry("main", "@2", 2, "frontend", 1, "working"),
            "%3" to entry("main", "@2", 2, "frontend", 2, "done")))
    }

    @Test fun agentsInSeveralSessionsGetTheSessionPrefix() {
        assertEquals(listOf("main › 1:opencode", "worker-site-1 › 1:claude"), names(
            "%5" to entry("main", "@1", 1, "opencode", 0, "idle"),
            "%7" to entry("worker-site-1", "@4", 1, "claude", 0, "working")))
    }

    @Test fun anEmptyOrAbsentWindowNameReadsWindow() {
        assertEquals(listOf("3:window"), names("%1" to entry("main", "@9", 3, "", 0, "idle")))
        assertEquals(listOf("3:window"), names("%1" to entry("main", "@9", 3, "", 0, "idle").copy(windowName = null)))
    }

    @Test fun anAgentWithNoStateStillCountsForTheSuffixAndThePrefix() {
        // The counts are over agent ENTRIES; only entries with a state become rows.
        assertEquals(listOf("2:frontend.1"), names(
            "%2" to entry("main", "@2", 2, "frontend", 1, "working"),
            "%3" to entry("main", "@2", 2, "frontend", 2)))
        assertEquals(listOf("main › 0:zsh"), names(
            "%1" to entry("main", "@0", 0, "zsh", 0, "done"),
            "%9" to entry("other", "@5", 0, "codex", 0)))
    }

    @Test fun theSameWindowIdUnderAnotherSessionIsAnotherWindow() {
        assertEquals(listOf("a › 1:x", "b › 1:x"), names(
            "%1" to entry("a", "@1", 1, "x", 0, "idle"),
            "%2" to entry("b", "@1", 1, "x", 0, "idle")))
    }

    @Test fun rowsOrderBySessionThenWindowIndexThenPaneIndex() {
        // Plain string compare (capitals first), numeric indexes (2 before 10),
        // and never by state: a row does not move when its state changes.
        val rows = agentRows(latestAgents(newest(
            "%1" to entry("alpha", "@1", 10, "w", 0, "blocked", "permission"),
            "%2" to entry("alpha", "@2", 2, "w", 1, "idle"),
            "%3" to entry("alpha", "@2", 2, "w", 0, "working"),
            "%4" to entry("Zed", "@3", 5, "w", 0, "done"))))
        assertEquals(listOf("%4", "%3", "%2", "%1"), rows.map { it.pane })
    }

    @Test fun onlyTheNewestSampleCounts() {
        val old = Sample(t = 1, up = true, agents = mapOf("%1" to entry("main", "@1", 1, "api", 0, "blocked", "permission")))
        assertTrue(latestAgents(listOf(old, Sample(t = 2, up = true))).isEmpty())
        assertTrue(latestAgents(emptyList()).isEmpty())
        assertTrue(latestAgents(null).isEmpty())
    }

    @Test fun entriesThatDoNotFitAreDropped() {
        val ok = entry("main", "@1", 1, "api", 0, "idle")
        val kept = latestAgents(newest(
            "%1" to ok,
            "main" to ok,                          // the current server keys by session name
            "%2" to ok.copy(session = "bad name"),
            "%3" to ok.copy(session = null),
            "%4" to ok.copy(windowId = "3"),
            "%5" to ok.copy(windowIndex = null),
            "%6" to ok.copy(windowIndex = -1),
            "%7" to ok.copy(paneIndex = null),
            "%8" to ok.copy(paneIndex = -1)))
        assertEquals(listOf("%1"), kept.map { it.pane })
    }

    @Test fun anUnknownStateMakesNoRowAndAStrangeCauseIsLeftOut() {
        val agents = latestAgents(newest(
            "%1" to entry("main", "@1", 1, "api", 0, "waiting"),               // the app's old vocabulary
            "%2" to entry("main", "@2", 2, "web", 0, "blocked", "PERMISSION <b>")))
        assertNull(agents.first { it.pane == "%1" }.state)
        assertEquals(listOf(AgentRow("%2", "2:web", "main", "@2", AgentState.BLOCKED, null)), agentRows(agents))
    }

    @Test fun chipTextShowsACauseOnlyWhenBlocked() {
        assertEquals("blocked · permission", agentChipText(AgentState.BLOCKED, "permission"))
        assertEquals("blocked", agentChipText(AgentState.BLOCKED, null))
        assertEquals("done", agentChipText(AgentState.DONE, "stop"))
        assertEquals("working", agentChipText(AgentState.WORKING, "prompt"))
        assertEquals("idle", agentChipText(AgentState.IDLE, null))
    }

    @Test fun precedenceIsBlockedDoneWorkingIdle() {
        assertEquals(listOf(AgentState.BLOCKED, AgentState.DONE, AgentState.WORKING, AgentState.IDLE), AgentState.entries.toList())
        val rows = listOf(AgentState.IDLE, AgentState.DONE, AgentState.WORKING).mapIndexed { i, s -> AgentRow("%$i", "n", "main", "@$i", s, null) }
        assertEquals(AgentState.DONE, worstState(rows))
        assertNull(worstState(emptyList()))
        assertEquals(AgentState.BLOCKED, agentStateOf("blocked"))
        for (bad in listOf("waiting", "Blocked", "", null)) assertNull(agentStateOf(bad))
    }
}
```

- [ ] **Step 2: Run** `./gradlew test` — FAIL at test compilation: unresolved reference `agentRows` (and the rest of the package).
- [ ] **Step 3: Implement `AgentRows.kt`.** Header comment: this is the Kotlin twin of the browser's `agentRows` in `src/web/agentState.ts`, the two must name and order a pane identically, and both counts run over entries, not rows. The browser's cases are the `NAMING_CASES` table in `test/agentNaming.test.js` (plan 1, Task 11); the tests above cover the same cases, and a case added there is added here. `agentRows` computes the two counts once over the whole list, then maps the stateful panes and sorts with `compareBy({ it.session }, { it.windowIndex }, { it.paneIndex })` on the `AgentPane` before naming.
- [ ] **Step 4: Control-byte check.** `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' app/src` — no output.
- [ ] **Step 5: Run** `./gradlew test` — PASS.
- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/agent/AgentRows.kt android/app/src/test/java/com/tmuxifier/console/agent/AgentRowsTest.kt
git commit -m "feat(android): name and order agent panes as the browser does"
```

### Task 3: Fleet cards list their agents

**Files:**
- Modify: `app/src/main/java/com/tmuxifier/console/fleet/FleetModel.kt:12-59`
- Modify: `app/src/main/java/com/tmuxifier/console/api/Models.kt` (delete `Sample.agent`)
- Create: `app/src/main/java/com/tmuxifier/console/ui/AgentChip.kt`
- Modify: `app/src/main/java/com/tmuxifier/console/ui/FleetScreen.kt:101,173-209`
- Test: `app/src/test/java/com/tmuxifier/console/fleet/FleetModelTest.kt`, `api/ModelsTest.kt`

**Interfaces:**
- Consumes: Task 2's `latestAgents`, `agentRows`, `worstState`, `agentChipText`, `AgentRow`, `AgentState`.
- Produces:
  - `data class BoxCard(val id: String, val label: String, val sessionName: String, val dot: Dot, val agents: List<AgentRow>, val worst: AgentState?, val spec1: String, val spec2: String)`. `agent` and `agentForMin` are gone.
  - `fun fleetCards(boxes: List<BoxInfo>, status: Map<String, BoxStatus>, series: Map<String, List<Sample>>): List<BoxCard>` — the `now` parameter is gone with the duration. Sort: `worst` rank (`ordinal`; a card with no stateful agent after `IDLE`), then `label.lowercase()`.
  - `Sample` no longer has `agent`. `agentStreak` is deleted.
  - `@Composable fun AgentChip(state: AgentState, cause: String?, modifier: Modifier = Modifier)` in `ui/AgentChip.kt`: `agentChipText` at `labelMedium`, `maxLines = 1`, foreground per state, background the same colour at 20 % alpha, `RoundedCornerShape(6.dp)`, padding 8 dp by 3 dp. Colours, all four already in the app: `BLOCKED` `0xFFE53935`, `DONE` `0xFFFFB300`, `WORKING` `0xFF4CAF50`, `IDLE` `0xFF9E9E9E`.

- [ ] **Step 1: Write the failing tests.** In `FleetModelTest.kt` delete `waitingSortsAboveWorkingAboveIdle` and `agentDurationCountsBackToTheFlip`, drop the `now` argument from every remaining `fleetCards` call, and add:

```kotlin
private fun agent(state: String?, windowIndex: Int = 1, name: String = "api", cause: String? = null) =
    AgentEntry(session = "main", windowId = "@$windowIndex", windowIndex = windowIndex, windowName = name, paneIndex = 0, state = state, cause = cause)
private fun newest(vararg agents: Pair<String, AgentEntry>) = listOf(Sample(t = 1000, up = true, agents = mapOf(*agents)))

@Test fun cardsSortByTheirMostUrgentAgent() {
    val boxes = listOf(box("a", "alpha"), box("b", "beta"), box("c", "gamma"), box("d", "delta"), box("e", "epsilon"))
    val series = mapOf(
        "b" to newest("%1" to agent("idle")),
        "c" to newest("%1" to agent("working")),
        "d" to newest("%1" to agent("done")),
        "e" to newest("%1" to agent("working"), "%2" to agent("blocked", 2, "web", "permission")),
    )
    assertEquals(listOf("e", "d", "c", "b", "a"), fleetCards(boxes, emptyMap(), series).map { it.id })
}

@Test fun aCardCarriesTheNewestSamplesRows() {
    val samples = listOf(
        Sample(t = 0, up = true, agents = mapOf("%1" to agent("blocked", cause = "permission"))),
        Sample(t = 1000, up = true, agents = mapOf("%2" to agent("working", 2, "web"))),
    )
    val card = fleetCards(listOf(box("a", "alpha")), emptyMap(), mapOf("a" to samples))[0]
    assertEquals(listOf(AgentRow("%2", "2:web", "main", "@2", AgentState.WORKING, null)), card.agents)
    assertEquals(AgentState.WORKING, card.worst)
}

@Test fun aSeriesFromTheCurrentServerGivesNoRows() {
    val series = ApiJson.decodeFromString(seriesMapSerializer,
        """{"a":[{"t":1,"up":true,"agent":"working","agentPresent":true,"agents":{"main":{"present":true,"attached":false,"agent":"claude","state":"working","ts":1723180000}}}]}""")
    val card = fleetCards(listOf(box("a", "alpha")), emptyMap(), series)[0]
    assertTrue(card.agents.isEmpty())
    assertNull(card.worst)
}

@Test fun theHostShellSeriesMakesNoCard() {
    val cards = fleetCards(listOf(box("a", "alpha")), emptyMap(), mapOf("__local__" to newest("%1" to agent("blocked"))))
    assertEquals(listOf("a"), cards.map { it.id })
    assertTrue(cards[0].agents.isEmpty())
}
```

In `ModelsTest.kt` change `seriesParses` to assert only `t` (its `agent` assertion goes with the field).

- [ ] **Step 2: Run** `./gradlew test` — FAIL at test compilation: `fleetCards` has no three-argument form; unresolved `card.agents` and `card.worst`.
- [ ] **Step 3: Implement the model.** `FleetModel.kt`: the new `BoxCard`, `fleetCards` building `agents = agentRows(latestAgents(series[box.id]))` and `worst = worstState(agents)`, the new sort; delete `agentStreak`. `Models.kt`: delete `Sample.agent`. Update the `BoxCard` header comment (rows instead of "the agent chip that decides the sort").
- [ ] **Step 4: Implement the screen.** Create `ui/AgentChip.kt`. In `FleetScreen.kt`: call `fleetCards(bx, st, se)`; in `BoxCardRow` wrap the existing header `Row` in a `Column`, delete the old chip block (lines 195-206), and under the header draw one line per `card.agents` through a new `@Composable private fun AgentRowLine(row: AgentRow, enabled: Boolean = true, onClick: (() -> Unit)? = null)`: the row name (`bodyMedium`, `maxLines = 1`, `TextOverflow.Ellipsis`, `Modifier.weight(1f)`) and its `AgentChip`. The rows block is indented 20 dp from the card's content edge with a 1 dp vertical guide in `MaterialTheme.colorScheme.outlineVariant` along its left, 6 dp between rows. A non-null `onClick` makes the line `Modifier.clickable(enabled = enabled, onClick = onClick)`; this task passes none (Task 6 does), so a tap on a row falls through to the card. Update the file's header comment ("blocked agents on top").
- [ ] **Step 5: Run** `./gradlew test` — PASS. Then `./gradlew assembleDebug` — `BUILD SUCCESSFUL`.
- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/fleet/FleetModel.kt android/app/src/main/java/com/tmuxifier/console/api/Models.kt android/app/src/main/java/com/tmuxifier/console/ui/AgentChip.kt android/app/src/main/java/com/tmuxifier/console/ui/FleetScreen.kt android/app/src/test/java/com/tmuxifier/console/fleet/FleetModelTest.kt android/app/src/test/java/com/tmuxifier/console/api/ModelsTest.kt
git commit -m "feat(android): fleet cards list each agent pane with its state"
```

- [ ] **Step 7: Device checklist (operator).** Debug build on the phone, paired with a server running plan 1, and a test box running agents. Installing a debug build over the Play-signed one needs an uninstall and a new pairing (`android/README.md`, Play Store section).
  - A box with one Claude in window `1:api` and two in split panes of `2:frontend` shows three rows, `1:api`, `2:frontend.1`, `2:frontend.2`, with the same names and order as the browser sidebar.
  - A box with agents in two sessions shows `main › …` and `<other session> › …`.
  - The four states have four colours; a blocked row reads `blocked · permission`.
  - A box with no agent shows its card as before, with no rows.
  - Cards order: a box with a blocked agent first, then done, working, idle, then boxes with none.
  - A 64-character window name ellipsizes and its chip stays whole on the cover screen.
  - Paired with a server of the previous generation: no rows, no crash, no "offline — retrying".
  - A card tap still opens the box; a long press still opens the session sheet.

### Task 4: The session chip and the acknowledgement

**Files:**
- Create: `app/src/main/java/com/tmuxifier/console/agent/AgentAck.kt`
- Modify: `app/src/main/java/com/tmuxifier/console/api/ApiClient.kt`
- Modify: `app/src/main/java/com/tmuxifier/console/ui/SessionScreen.kt:104-156,199-209`
- Test: `app/src/test/java/com/tmuxifier/console/agent/AgentAckTest.kt`, `api/ApiClientBodyTest.kt`

**Interfaces:**
- Consumes: Task 1's `PaneSnapshot.pane`/`agentTs`/`agentCause`, `PANE_ID_RE`; Task 2's `agentStateOf`; Task 3's `AgentChip`.
- Produces (package `com.tmuxifier.console.agent`):
  - `data class AckKey(val boxId: String, val pane: String, val ts: Long)`
  - `data class AckState(val settled: Set<AckKey> = emptySet(), val inFlight: AckKey? = null)`
  - `fun ackCandidate(boxId: String, snap: PaneSnapshot?): AckKey?` — non-null only when `snap.agent == "done"`, `snap.pane` matches `PANE_ID_RE`, and `snap.agentTs` is non-null and `> 0`.
  - `fun ackNext(state: AckState, candidate: AckKey?, foreground: Boolean): AckKey?` — the key to post now, or `null`.
  - `fun ackStarted(state: AckState, key: AckKey): AckState`
  - `fun ackFinished(state: AckState, key: AckKey, status: Int): AckState` — `status` is 200 for success, else `ApiException.status`. The key is settled on 200 and on any 400-499 (the server has answered for this marker; asking again each second cannot change it); 0 and 5xx leave it unsettled, so a later capture posts it again.
  - In `ApiClient.kt`: `internal fun agentSeenBody(pane: String, ts: Long): String` and `suspend fun agentSeen(boxId: String, pane: String, ts: Long)` (`POST /api/boxes/$boxId/agent-seen`).

- [ ] **Step 1: Write the failing tests**

`AgentAckTest.kt`:

```kotlin
private fun snap(agent: String?, pane: String? = "%12", ts: Long? = 1723180000L) =
    PaneSnapshot(ok = true, content = "x", agent = agent, pane = pane, agentTs = ts)
private val KEY = AckKey("b1", "%12", 1723180000L)
private val LATER = KEY.copy(ts = 1723180100L)

class AgentAckTest {
    @Test fun onlyADoneCaptureWithItsPaneAndTsIsACandidate() {
        assertEquals(KEY, ackCandidate("b1", snap("done")))
        val none = listOf(null, snap("working"), snap("blocked"), snap("idle"), snap(null),
            snap("done", pane = null), snap("done", ts = null),   // an older server sends neither
            snap("done", pane = "12"), snap("done", ts = 0))
        for (s in none) assertNull(ackCandidate("b1", s), "$s")
    }

    @Test fun postsOncePerMarkerOneAtATimeAndOnlyInFront() {
        var st = AckState()
        assertNull(ackNext(st, KEY, foreground = false))
        assertNull(ackNext(st, null, foreground = true))
        assertEquals(KEY, ackNext(st, KEY, foreground = true))
        st = ackStarted(st, KEY)
        assertNull(ackNext(st, KEY, true))    // in flight: the 1 s captures do not stack posts
        assertNull(ackNext(st, LATER, true))  // not even for another marker
        st = ackFinished(st, KEY, 200)
        assertNull(ackNext(st, KEY, true))    // settled
        assertEquals(LATER, ackNext(st, LATER, true)) // the next finished turn is a new key
    }

    @Test fun aFailureIsRetriedARefusalIsNot() {
        for (status in listOf(0, 500, 502)) {
            val st = ackFinished(ackStarted(AckState(), KEY), KEY, status)
            assertEquals(KEY, ackNext(st, KEY, true), "status $status")
        }
        for (status in listOf(400, 403, 404)) {
            val st = ackFinished(ackStarted(AckState(), KEY), KEY, status)
            assertNull(ackNext(st, KEY, true), "status $status")
        }
    }
}
```

`ApiClientBodyTest.kt` (add):

```kotlin
@Test fun agentSeenNamesThePaneAndSendsTsAsANumber() {
    // The route checks Number.isSafeInteger(ts): a quoted ts is a 400.
    assertEquals("""{"pane":"%12","ts":1723180000}""", agentSeenBody("%12", 1723180000L))
}
```

- [ ] **Step 2: Run** `./gradlew test` — FAIL at test compilation: unresolved `ackCandidate`, `agentSeenBody`.
- [ ] **Step 3: Implement `AgentAck.kt` and the two `ApiClient` members.** Header comment of `AgentAck.kt`: "Seen is a client claim" (spec 4.5) — the app claims only the pane it rendered, and only while it is in front.
- [ ] **Step 4: Run** `./gradlew test` — PASS.
- [ ] **Step 5: Wire `SessionScreen.kt`.**
  - Chip (replacing lines 199-209): `agentStateOf(snap?.agent)?.let { AgentChip(it, snap?.agentCause) }`. A word outside the four states draws no chip.
  - State, declared before the poll effect: `var ack by remember(boxId) { mutableStateOf(AckState()) }`.
  - In the poll loop, after a capture has been stored in `snap`:

```kotlin
val front = lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && !sheetOpen
ackNext(ack, ackCandidate(boxId, s), front)?.let { key ->
    ack = ackStarted(ack, key)
    scope.launch { // not the poll's own coroutine: a slow post must not delay the next capture
        val status = try { client.agentSeen(key.boxId, key.pane, key.ts); 200 } catch (e: ApiException) { e.status }
        ack = ackFinished(ack, key, status)
        if (status == 401) onUnauthorized()
    }
}
```

  A failed acknowledgement shows nothing: the chip simply stays `done`.
- [ ] **Step 6: Run** `./gradlew test` — PASS. Then `./gradlew assembleDebug` — `BUILD SUCCESSFUL`.
- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/agent/AgentAck.kt android/app/src/main/java/com/tmuxifier/console/api/ApiClient.kt android/app/src/main/java/com/tmuxifier/console/ui/SessionScreen.kt android/app/src/test/java/com/tmuxifier/console/agent/AgentAckTest.kt android/app/src/test/java/com/tmuxifier/console/api/ApiClientBodyTest.kt
git commit -m "feat(android): the session chip is the pane on screen, and looking at a finished turn acknowledges it"
```

- [ ] **Step 8: Device checklist (operator).**
  - The chip shows the state of the pane on screen in the four colours. With `blocked · permission` on the cover screen, the box label, the session chip, the agent chip and the browser button all stay on the header row.
  - An agent finishes a turn while the session screen is closed: its fleet row reads `done`. Open the session: within about two seconds the chip reads `idle`, and the same pane's row in the browser sidebar turns `idle`.
  - Two agents finish in two windows of one session: opening the session clears only the one on screen; the other still reads `done` in the browser.
  - With the session sheet open over a `done` pane it stays `done`; it clears when the sheet closes.
  - A turn that finishes while the app is in the background or the screen is off stays `done` until the session screen is in front again.
  - Paired with a server of the previous generation: the chip draws, nothing is acknowledged, no error line appears.

### Task 5: The jump planner (pure)

**Files:**
- Create: `app/src/main/java/com/tmuxifier/console/agent/AgentJump.kt`
- Modify: `app/src/main/java/com/tmuxifier/console/api/ApiClient.kt:120-125`
- Test: `app/src/test/java/com/tmuxifier/console/agent/AgentJumpTest.kt`, `api/ApiClientBodyTest.kt`

**Interfaces:**
- Consumes: `SESSION_NAME_RE`, `WINDOW_ID_RE`, `PANE_ID_RE`; `BoxStatus`, `ApiException`.
- Produces (package `com.tmuxifier.console.agent`):
  - `data class JumpTarget(val session: String, val windowId: String, val pane: String)`
  - `fun jumpTargetOf(session: String?, windowId: String?, pane: String?): JumpTarget?` — non-null only when all three are present and match their regex.
  - `sealed interface JumpStep { data class SetSession(val name: String) : JumpStep; data class SelectPane(val session: String, val windowId: String, val pane: String) : JumpStep }`
  - `fun planJump(configuredSession: String, target: JumpTarget): List<JumpStep>` — `SetSession` first, only when the box's configured session differs from the target's (an empty configured name is `web`, as in `sessionTargets`); then always `SelectPane`. The window call is made even when the agent may already be in front: it is idempotent, and the fleet data can be ten seconds old.
  - `fun targetListed(status: BoxStatus?, target: JumpTarget): Boolean` — the status lists a session named `target.session` whose `windowList` holds `target.windowId`.
  - `suspend fun runJump(steps: List<JumpStep>, setSession: suspend (String) -> Unit, selectPane: suspend (session: String, windowId: String, pane: String) -> Unit): String?` — runs the steps in order and stops at the first `ApiException`: `null` on success; on failure the exception's message, or `HTTP <status>` when it has none; a 401 is rethrown.
  - In `ApiClient.kt`: `internal fun windowBody(session: String, windowId: String, paneId: String?): String` (omits `paneId` when null, as `killBody` omits `windowId`) and `suspend fun selectWindow(boxId: String, session: String, windowId: String, paneId: String? = null)`.

- [ ] **Step 1: Write the failing tests**

`AgentJumpTest.kt`:

```kotlin
private val TARGET = JumpTarget("main", "@3", "%12")
private fun status(vararg sessions: TmuxSession) = BoxStatus(reachable = true, tmux = true, sessions = sessions.toList())

class AgentJumpTest {
    @Test fun aTargetNeedsAllThreeIdsInShape() {
        assertEquals(TARGET, jumpTargetOf("main", "@3", "%12"))
        assertNull(jumpTargetOf(null, "@3", "%12"))
        assertNull(jumpTargetOf("main", null, "%12"))
        assertNull(jumpTargetOf("main", "@3", null))
        assertNull(jumpTargetOf("bad name", "@3", "%12"))
        assertNull(jumpTargetOf("main", "3", "%12"))
        assertNull(jumpTargetOf("main", "@3", "12"))
    }

    @Test fun sameSessionSelectsThePaneOnly() {
        assertEquals(listOf(JumpStep.SelectPane("main", "@3", "%12")), planJump("main", TARGET))
    }

    @Test fun anotherSessionRepointsTheBoxFirst() {
        assertEquals(
            listOf(JumpStep.SetSession("main"), JumpStep.SelectPane("main", "@3", "%12")),
            planJump("web", TARGET),
        )
    }

    @Test fun anUnsetConfiguredSessionIsWeb() {
        assertEquals(listOf(JumpStep.SelectPane("web", "@3", "%12")), planJump("", TARGET.copy(session = "web")))
        assertEquals(JumpStep.SetSession("main"), planJump("", TARGET).first())
    }

    @Test fun aTargetIsListedOnlyWithItsSessionAndWindow() {
        val st = status(
            TmuxSession(name = "main", windowList = listOf(TmuxWindow(id = "@0"), TmuxWindow(id = "@3"))),
            TmuxSession(name = "other", windowList = listOf(TmuxWindow(id = "@7"))),
        )
        assertTrue(targetListed(st, TARGET))
        assertFalse(targetListed(st, TARGET.copy(windowId = "@9")))   // the window was killed
        assertFalse(targetListed(st, TARGET.copy(session = "gone")))  // the session was killed
        assertFalse(targetListed(st, TARGET.copy(session = "other"))) // @3 is not other's window
        assertFalse(targetListed(null, TARGET))
    }

    @Test fun stepsRunInOrder() = runTest {
        val calls = mutableListOf<String>()
        val failed = runJump(planJump("web", TARGET), { calls += "session:$it" }, { s, w, p -> calls += "pane:$s:$w:$p" })
        assertNull(failed)
        assertEquals(listOf("session:main", "pane:main:@3:%12"), calls)
    }

    @Test fun aFailedRepointStopsBeforeTheWindow() = runTest {
        val calls = mutableListOf<String>()
        val failed = runJump(planJump("web", TARGET), { throw ApiException(502, "boom") }, { _, _, _ -> calls += "pane" })
        assertEquals("boom", failed)
        assertTrue(calls.isEmpty())
    }

    @Test fun aFailedSelectReportsItsMessage() = runTest {
        assertEquals("box setup is still running",
            runJump(planJump("main", TARGET), { }, { _, _, _ -> throw ApiException(409, "box setup is still running") }))
    }

    @Test fun aRevokedDeviceIsRethrown() = runTest {
        assertFailsWith<ApiException> { runJump(planJump("web", TARGET), { throw ApiException(401, "unauthorized") }, { _, _, _ -> }) }
    }
}
```

`runTest` is `kotlinx.coroutines.test.runTest` (already a test dependency).

`ApiClientBodyTest.kt` (add):

```kotlin
@Test fun aWindowSelectOmitsPaneIdUnlessGiven() {
    assertEquals("""{"session":"main","windowId":"@3"}""", windowBody("main", "@3", null))
    assertEquals("""{"session":"main","windowId":"@3","paneId":"%12"}""", windowBody("main", "@3", "%12"))
}
```

- [ ] **Step 2: Run** `./gradlew test` — FAIL at test compilation: unresolved `planJump`, `windowBody`.
- [ ] **Step 3: Implement `AgentJump.kt` and the `ApiClient` change.** Header comment of `AgentJump.kt`: the order is the server contract's (repoint, then window and pane, then open the screen); `ui/SessionSheet.kt` keeps its own window-then-repoint order for its rows and is not changed.
- [ ] **Step 4: Run** `./gradlew test` — PASS.
- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/agent/AgentJump.kt android/app/src/main/java/com/tmuxifier/console/api/ApiClient.kt android/app/src/test/java/com/tmuxifier/console/agent/AgentJumpTest.kt android/app/src/test/java/com/tmuxifier/console/api/ApiClientBodyTest.kt
git commit -m "feat(android): plan a jump to an agent pane"
```

### Task 6: A row tap opens that agent

**Files:**
- Modify: `app/src/main/java/com/tmuxifier/console/MainActivity.kt:148-189`
- Modify: `app/src/main/java/com/tmuxifier/console/ui/FleetScreen.kt:66-71,133-155`
- Modify: `app/src/main/java/com/tmuxifier/console/ui/SessionScreen.kt:96-107`

**Interfaces:**
- Consumes: Task 5's `JumpTarget`, `planJump`, `runJump`, `selectWindow(…, paneId)`; Task 3's `AgentRowLine`, `BoxCard.agents`.
- Produces:
  - `FleetScreen(state, onOpen, onOpenAgent: (boxId: String, label: String, configuredSession: String, target: JumpTarget) -> Unit, opening: Boolean, onSettings, onUnauthorized)`.
  - `SessionScreen(state, boxId, boxLabel, onUnauthorized, notice: String? = null, bottomBar)`: `notice` seeds the existing four-second error line (`var sendError by remember(boxId, notice) { mutableStateOf(notice) }`).
  - In `Shell`: `jumping`, `notice`, and `openAgent(boxId, label, configuredSession, target)`, which Task 7 reuses.

- [ ] **Step 1: Wire `Shell` in `MainActivity.kt`.**

```kotlin
var jumping by remember { mutableStateOf(false) }
var notice by remember { mutableStateOf<String?>(null) }
val scope = rememberCoroutineScope()

fun openAgent(boxId: String, label: String, configuredSession: String, target: JumpTarget) {
    val client = state.client() ?: return
    if (jumping) return                       // one jump at a time; a second tap is dropped
    jumping = true
    scope.launch {
        try {
            val failed = runJump(
                planJump(configuredSession, target),
                setSession = { client.setSession(boxId, it) },
                selectPane = { s, w, p -> client.selectWindow(boxId, s, w, p) },
            )
            notice = failed?.let { "agent not selected: $it" }
            screen = Screen.Session(boxId, label) // also after a failure: the operator asked for this box
        } catch (e: ApiException) {               // runJump rethrows only a 401
            screen = Screen.Settings
        } finally {
            jumping = false
        }
    }
}
```

  Pass `onOpenAgent = ::openAgent` and `opening = jumping` to `FleetScreen`, `notice = notice` to `SessionScreen`, and make the card path clear it: `onOpen = { notice = null; screen = it }`.
- [ ] **Step 2: Wire `FleetScreen.kt`.** Each `AgentRowLine` gets `enabled = !opening` and `onClick = { onOpenAgent(card.id, card.label, card.sessionName, JumpTarget(row.session, row.windowId, row.pane)) }` (the card's own tap and long press stay as they are). While `opening`, show `opening…` where `offline — retrying` is drawn, in `onSurfaceVariant`.
- [ ] **Step 3: Wire `SessionScreen.kt`** as in Produces.
- [ ] **Step 4: Run** `./gradlew test` — PASS. Then `./gradlew assembleDebug` — `BUILD SUCCESSFUL`.
- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/MainActivity.kt android/app/src/main/java/com/tmuxifier/console/ui/FleetScreen.kt android/app/src/main/java/com/tmuxifier/console/ui/SessionScreen.kt
git commit -m "feat(android): tapping an agent row opens its session, window and pane"
```

- [ ] **Step 6: Device checklist (operator).**
  - Tap a row for an agent in a background window of the box's configured session: the session screen opens on that pane; a browser attached to the session follows to that window without reconnecting.
  - Tap a row for an agent in a split pane that is not the active one: the capture shows that pane (its cursor and its chip).
  - Tap a row for an agent in another session: the session chip names that session, the pane is shown, and an open browser reconnects to the session.
  - Close an agent's pane on the box, then tap its stale row within ten seconds: the session screen opens and shows `agent not selected: …` for about four seconds.
  - While a setup job runs on the box, a row tap opens the session with `agent not selected: box setup is still running`.
  - During a jump the rows do not answer a second tap and `opening…` shows.
  - A card tap and a long press behave as before.

### Task 7: Push per agent, and its tap

**Files:**
- Create: `app/src/main/java/com/tmuxifier/console/push/PushTarget.kt`
- Modify: `app/src/main/java/com/tmuxifier/console/push/Push.kt:58-82`
- Modify: `app/src/main/java/com/tmuxifier/console/push/PushService.kt:1-7,27-36`
- Modify: `app/src/main/java/com/tmuxifier/console/MainActivity.kt:60-62,76,105-108,157-162`
- Test: `app/src/test/java/com/tmuxifier/console/push/PushTargetTest.kt`

**Interfaces:**
- Consumes: Task 5's `JumpTarget`, `jumpTargetOf`, `targetListed`; Task 6's `openAgent`, `jumping`, `notice`.
- Produces (package `com.tmuxifier.console.push`, `PushTarget.kt` has no Android imports):
  - `data class PushTarget(val boxId: String, val jump: JumpTarget?)`
  - `fun pushTargetOf(data: Map<String, String?>): PushTarget?` — keys `boxId`, `session`, `windowId`, `pane` (the FCM data keys, which are also the intent extras). `null` unless `boxId` matches `^[A-Za-z0-9_-]{1,64}$` (it becomes a URL path segment). `jump = jumpTargetOf(session, windowId, pane)`.
  - `fun notificationIdOf(boxId: String, pane: String?): Int` — `boxId.hashCode()` when `pane` is null, else `"$boxId $pane".hashCode()`.
  - `fun showAgentNotification(context: Context, target: PushTarget, title: String, body: String)` replaces the `boxId: String` form.

- [ ] **Step 1: Write the failing tests** (`PushTargetTest.kt`)

```kotlin
private val FULL: Map<String, String?> =
    mapOf("boxId" to "b1", "kind" to "agent-blocked", "session" to "main", "pane" to "%12", "windowId" to "@3")

class PushTargetTest {
    @Test fun aPaneLevelPushCarriesAJumpTarget() {
        assertEquals(PushTarget("b1", JumpTarget("main", "@3", "%12")), pushTargetOf(FULL))
    }

    @Test fun anOlderServersPushOpensTheBoxOnly() {
        assertEquals(PushTarget("b1", null), pushTargetOf(mapOf("boxId" to "b1", "kind" to "agent-input", "session" to "main")))
    }

    @Test fun aPartialOrMisshapenTargetIsNoTarget() {
        val bad = listOf(FULL - "windowId", FULL - "pane", FULL - "session", FULL + ("pane" to null),
            FULL + ("pane" to "12"), FULL + ("windowId" to "3"), FULL + ("session" to "bad name"))
        for (d in bad) assertEquals(PushTarget("b1", null), pushTargetOf(d), "$d")
    }

    @Test fun aBoxIdThatIsNotAPlainIdIsNoPush() {
        // The activity is exported: these values can come from any app's intent.
        for (id in listOf(null, "", "a b", "../devices/self", "b1?x=1")) assertNull(pushTargetOf(FULL + ("boxId" to id)), "$id")
        assertEquals("3f2b8c1e-5d47-4a9b-8e21-0c6f7a9d1b23", pushTargetOf(mapOf("boxId" to "3f2b8c1e-5d47-4a9b-8e21-0c6f7a9d1b23"))?.boxId)
    }

    @Test fun notificationIdIsPerBoxAndPane() {
        assertEquals("b1".hashCode(), notificationIdOf("b1", null))           // an older server's push: as before
        assertEquals(notificationIdOf("b1", "%12"), notificationIdOf("b1", "%12")) // the same agent replaces its own
        assertNotEquals(notificationIdOf("b1", "%12"), notificationIdOf("b1", "%13"))
        assertNotEquals(notificationIdOf("b1", "%12"), notificationIdOf("b2", "%12"))
        assertNotEquals(notificationIdOf("b1", "%12"), notificationIdOf("b1", null))
    }
}
```

- [ ] **Step 2: Run** `./gradlew test` — FAIL at test compilation: unresolved `pushTargetOf`.
- [ ] **Step 3: Implement `PushTarget.kt`.**
- [ ] **Step 4: Run** `./gradlew test` — PASS.
- [ ] **Step 5: `Push.kt` and `PushService.kt`.** `showAgentNotification` puts the extras `boxId` and, when `target.jump` is non-null, `session`, `windowId`, `pane`; it uses `notificationIdOf(target.boxId, target.jump?.pane)` both as the `PendingIntent` request code and as the notification id. The request code must differ per agent: two `PendingIntent`s that differ only in extras are one, and `FLAG_UPDATE_CURRENT` would point both notifications at the newer agent. `PushService.onMessageReceived` does `val target = pushTargetOf(msg.data) ?: return`. Update both header comments (data now carries `session`, `pane`, `windowId`; id per box and pane).
- [ ] **Step 6: `MainActivity.kt`.**
  - `pendingBox: MutableState<String?>` becomes `pendingPush: MutableState<PushTarget?>`, filled by a private `pushTargetFrom(intent: Intent?): PushTarget?` that reads the four string extras into the pure `pushTargetOf`.
  - `onCreate` reads the launch intent only when it is a fresh launch:

```kotlin
val fresh = savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
if (fresh) pendingPush.value = pushTargetFrom(intent)
```

    The activity keeps its launch intent across a recreation (fold, rotation) and a reopen from recents; without this guard each of those would run the jump again. `onNewIntent` always sets `pendingPush.value = pushTargetFrom(intent)`.
  - `Shell`'s effect:

```kotlin
LaunchedEffect(pendingPush.value) {
    val push = pendingPush.value ?: return@LaunchedEffect
    pendingPush.value = null // re-keys and cancels this effect: nothing below may suspend
    if (!state.enrolled) return@LaunchedEffect
    val target = push.jump
    if (target == null || jumping) {          // an older server's push, or a jump already running: as today
        notice = null
        screen = Screen.Session(push.boxId, push.boxId)
    } else {
        openFromPush(push.boxId, target)      // launches on `scope`
    }
}
```

  - `openFromPush(boxId, target)`, a local function beside `openAgent`, sets `jumping`, launches on `scope`, clears `jumping` in `finally`, and follows these rules:
    1. Fetch `client.boxes()` and `client.status()` together (`coroutineScope` with two `async`).
    2. A fetch that fails with 401 goes to `Screen.Settings`; any other failure, or a box id not in the list, opens `Screen.Session(boxId, boxId)` with no jump, as today.
    3. The label is `box.label.ifEmpty { box.id }`.
    4. When `targetListed(status[boxId], target)` is false, open the session with no jump and no notice: the box is never repointed at a session the server does not list.
    5. Otherwise run `runJump(planJump(box.sessionName, target), …)` with the same two lambdas as `openAgent`, set `notice` as `openAgent` does, and open the session. A 401 from it goes to `Screen.Settings`.
- [ ] **Step 7: Run** `./gradlew test` — PASS. Then `./gradlew assembleDebug` — `BUILD SUCCESSFUL`.
- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/com/tmuxifier/console/push/PushTarget.kt android/app/src/main/java/com/tmuxifier/console/push/Push.kt android/app/src/main/java/com/tmuxifier/console/push/PushService.kt android/app/src/main/java/com/tmuxifier/console/MainActivity.kt android/app/src/test/java/com/tmuxifier/console/push/PushTargetTest.kt
git commit -m "feat(android): one notification per agent pane, and its tap opens that pane"
```

- [ ] **Step 9: Device checklist (operator).** Push must be configured on the server (`android/README.md`, Firebase section).
  - App in front, two agents on one box block: two notifications, neither replaces the other. The same agent blocks again: its notification is replaced, not doubled.
  - Tap the notification of an agent in a background window: the session screen opens on that pane.
  - Tap the notification of an agent in another session: the box is repointed and the pane is shown.
  - App in the background or killed: the system posts the notification; its tap makes the same jump. (Whether two of these replace each other is decided by the server's FCM message, not by the app.)
  - Kill an agent's session on the box, then tap its old notification: the box opens on the session it points at now and the session chip is unchanged.
  - After a push-tap jump, switch the session to another window in the browser, then fold or unfold (or rotate) the phone: the window does not switch back.
  - After a push-tap jump press Back, leave the app, and reopen it from recents: the fleet list, with no jump.
  - A push from a server of the previous generation opens the box as before.

### Task 8: Version 1.3.0 and the guides

**Files:**
- Modify: `android/app/build.gradle.kts:17-18`
- Modify: `docs/android-app.md` (Screens, Push notifications), `android/README.md` (Commands), `README.md` (the "Android app (agent console)" section only), `CLAUDE.md` and `AGENTS.md` (the "Android app (`android/`)" paragraph only)

**Interfaces:**
- Consumes: everything above.
- Produces: an app that reports `1.3.0` (`BuildConfig.VERSION_NAME`, shown in the fleet header and Settings).

- [ ] **Step 1: Bump** `versionCode = 23`, `versionName = "1.3.0"`.
- [ ] **Step 2: `docs/android-app.md`.** The wording is the writer's; the facts each part must state:
  - **Fleet:** a card has one row per agent pane on the box, named `window-index:window-name`, with `.pane-index` when a window holds several agents and `session ›` when the box has agents in several sessions, each with a state chip (`blocked` with its cause, `done`, `working`, `idle`); cards order by their most urgent agent; a row tap switches the box to that agent's session when needed, selects its window and pane (every client attached to that session follows) and opens the session; a card tap opens the box as it is. Remove the sentence about plain green chips and the two "issue #5" remarks about chips and floating; keep the remark that the app has no toggle for the blocked push.
  - **Session:** the chip is the state of the pane on screen; while the session is in front, a `done` pane on screen is acknowledged and turns `idle` everywhere; agents in the session's other windows are not acknowledged.
  - **Push:** a notification names the agent's pane; two agents on one box each keep their own; a tap opens that pane; it is suppressed while that pane is on screen in an attached client.
  - **Versions:** app 1.3.0 needs a server with pane-level agent state to show agents; against an older server it shows none; an older app against the new server shows none either.
- [ ] **Step 3: The other guides.** `android/README.md`: the test list reads `(agent/, api/, fleet/, keys/, pane/, push/, session/)`. `README.md`: replace "fleet glance with waiting-first sorting" with a phrase saying the fleet glance lists each box's agents, most urgent first. `CLAUDE.md` and `AGENTS.md`, same sentence in both: add `agent/` (`agentRows` mirrors the browser's row naming, `ackNext`, `planJump`) to the pure, JVM-tested packages, and say the app acknowledges the pane its session screen shows. Touch nothing else in those two files: plan 1 edits their other sections.
- [ ] **Step 4: Verify.** `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' app/src` — no output. `./gradlew test` — PASS. `./gradlew assembleDebug` — `BUILD SUCCESSFUL`. From the worktree root: `git diff --stat` lists only `android/` and the five documentation files; `git diff` holds no real hostname, address or email.
- [ ] **Step 5: Commit**

```bash
git add android/app/build.gradle.kts android/README.md docs/android-app.md README.md CLAUDE.md AGENTS.md
git commit -m "chore(android): app 1.3.0, pane-level agent state in the guides"
```

### Task 9: Release (operator)

Not for an unattended agent: signing needs the gitignored `android/keystore.properties`, and Play needs the operator's account. The steps are the existing ones of `android/README.md` (Play Store and Signing & distribution).

- [ ] **Step 1: Preconditions.** Plan 1 is validated on the live app, and the device checklists of Tasks 3, 4, 6 and 7 passed on a build that reports `1.3.0`. Order of release: the server first (the checklists ran against it), then the app; either order is safe, since each side shows no agent state against the other's older generation.
- [ ] **Step 2: Build and upload.** `./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`; upload it to the Play **internal testing** track.
- [ ] **Step 3: Serve the Play-signed build.** Download the Play-signed universal APK (Play Console → App bundle explorer) and copy it by hand to the server's `data/app/tmuxifier-console.apk`. Do not press Build app on that server afterwards.
- [ ] **Step 4: Publish for other deployments.**

```bash
gh release create android-v1.3.0 --title "android-v1.3.0 — pane-level agent state" --notes "One row per agent pane, a jump to the agent from a row or a push, per-agent notifications, and the app acknowledges the finished turn it shows. Needs a server with pane-level agent state."
cp data/app/tmuxifier-console.apk /tmp/tmuxifier-console-v1.3.0.apk
gh release upload android-v1.3.0 /tmp/tmuxifier-console-v1.3.0.apk
sha256sum data/app/tmuxifier-console.apk
```

- [ ] **Step 5: Pin it.** In `scripts/fetch-apk.mjs` update all four fields of `RELEASE` together: `version: '1.3.0'`, `versionCode: 23`, the two `1.2.2` in `url` to `1.3.0` (owner and repository unchanged), and `sha256` to the digest Step 4 printed. Run `npx vitest run test/fetchApkScript.test.js` — PASS. Commit `chore(android): pin app 1.3.0 for fetch-apk`.
- [ ] **Step 6: Verify.** `gh release view android-v1.3.0 --json tagName --jq .tagName` prints `android-v1.3.0`; `npm run fetch-apk` ends with `digest verified`; the phone updates from Play and its fleet header reads `v1.3.0`.
