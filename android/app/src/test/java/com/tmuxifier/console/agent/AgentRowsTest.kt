package com.tmuxifier.console.agent

// Every case of the browser's NAMING_CASES table (test/agentNaming.test.js) is
// repeated here, so the two runtimes name and order a pane the same way; a case
// added there is added here. The separators are spelled as escapes (U+203A and
// U+00B7) while the source writes the literal characters, so a mangled byte on
// either side fails a test.
import com.tmuxifier.console.api.AgentEntry
import com.tmuxifier.console.api.ApiJson
import com.tmuxifier.console.api.Sample
import com.tmuxifier.console.api.seriesMapSerializer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

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
        assertEquals(listOf("main \u203A 1:opencode", "worker-site-1 \u203A 1:claude"), names(
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
        assertEquals(listOf("main \u203A 0:zsh"), names(
            "%1" to entry("main", "@0", 0, "zsh", 0, "done"),
            "%9" to entry("other", "@5", 0, "codex", 0)))
    }

    @Test fun theSameWindowIdUnderAnotherSessionIsAnotherWindow() {
        assertEquals(listOf("a \u203A 1:x", "b \u203A 1:x"), names(
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

    // The browser's NAMING_CASES, in its order and with its words, so the two
    // tables read side by side. A case with no agents at all is the empty list.
    @Test fun theBrowsersNamingCasesGiveTheSameNames() {
        val main = entry("main", "@1", 2, "frontend", 1, "working")
        val cases: List<Triple<String, List<Pair<String, AgentEntry>>, List<String>>> = listOf(
            Triple("one agent: the window alone",
                listOf("%1" to main),
                listOf("2:frontend")),
            Triple("two panes of one window: the pane index is added",
                listOf("%1" to main, "%2" to main.copy(paneIndex = 2)),
                listOf("2:frontend.1", "2:frontend.2")),
            Triple("two sessions: the session is prefixed, one pane per window has no suffix",
                listOf("%1" to main, "%5" to main.copy(session = "worker-site-1", windowId = "@4", windowIndex = 1, windowName = "claude")),
                listOf("main \u203A 2:frontend", "worker-site-1 \u203A 1:claude")),
            Triple("an empty window name reads window",
                listOf("%1" to main.copy(windowName = "")),
                listOf("2:window")),
            Triple("a stateless agent in the window still adds the pane index",
                listOf("%1" to main, "%2" to main.copy(paneIndex = 2, state = null)),
                listOf("2:frontend.1")),
            Triple("a stateless agent in another session still adds the session prefix",
                listOf("%1" to main, "%2" to main.copy(session = "side", windowId = "@9", state = null)),
                listOf("main \u203A 2:frontend")),
            Triple("the same window id under two sessions is counted per session: no pane suffix",
                listOf("%1" to main, "%2" to main.copy(session = "side")),
                listOf("main \u203A 2:frontend", "side \u203A 2:frontend")),
            Triple("rows are ordered by session, window index (numerically), pane index",
                listOf(
                    "%9" to main.copy(session = "b", windowId = "@2", windowIndex = 1, windowName = "one"),
                    "%3" to main.copy(windowId = "@7", windowIndex = 10, windowName = "late"),
                    "%2" to main.copy(paneIndex = 2, windowName = "two"),
                    "%1" to main.copy(paneIndex = 1, windowName = "two"),
                    "%4" to main.copy(windowId = "@5", windowIndex = 3, windowName = "three")),
                listOf("b \u203A 1:one", "main \u203A 2:two.1", "main \u203A 2:two.2", "main \u203A 3:three", "main \u203A 10:late")),
            Triple("pane index 0 is a suffix, not none",
                listOf("%1" to main.copy(paneIndex = 0), "%2" to main.copy(paneIndex = 1)),
                listOf("2:frontend.0", "2:frontend.1")),
            Triple("sessions are ordered by a plain string compare: uppercase before lowercase",
                listOf("%1" to main.copy(session = "alpha"), "%2" to main.copy(session = "Zeta")),
                listOf("Zeta \u203A 2:frontend", "alpha \u203A 2:frontend")),
            Triple("nothing stateful: no rows",
                listOf("%1" to main.copy(state = null)),
                emptyList()),
            Triple("no agents at all",
                emptyList(),
                emptyList()),
        )
        for ((why, agents, expected) in cases) {
            assertEquals(expected, agentRows(latestAgents(newest(*agents.toTypedArray()))).map { it.name }, why)
        }
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

    @Test fun aSessionKeyedSampleOfTheCurrentServerMakesNoRows() {
        // Decoded from the wire, not built by hand: today's server keys agents by
        // session name, with entries that carry a state and a cause but no window.
        val series = ApiJson.decodeFromString(seriesMapSerializer,
            """{"b1":[{"t":1,"up":true,"agent":"working","agentPresent":true,"agents":{"main":{"present":true,"attached":false,"agent":"claude","state":"working","cause":"prompt","ts":1723180000},"logs":{"present":false,"attached":true}}}]}""")
        val decoded = series.getValue("b1").last().agents
        assertEquals("working", decoded.getValue("main").state) // it decoded with a state, so only the shape check can drop it
        assertTrue(latestAgents(series.getValue("b1")).isEmpty())
        assertTrue(agentRows(latestAgents(series.getValue("b1"))).isEmpty())
    }

    @Test fun aPaneKeyedSampleOfThePlannedServerMakesRows() {
        // The falsifying half of the test above: an implementation that dropped every
        // entry would pass it. This one is the new server's shape, decoded the same way.
        val series = ApiJson.decodeFromString(seriesMapSerializer,
            """{"b1":[{"t":1,"up":true,"agents":{"%12":{"session":"main","windowId":"@3","windowIndex":2,"windowName":"frontend","paneIndex":1,"agent":"claude","state":"blocked","cause":"permission","ts":1723180000,"visible":true,"focused":false,"attached":true},"%14":{"session":"main","windowId":"@4","windowIndex":3,"windowName":"","paneIndex":0,"agent":"codex","visible":false,"focused":false,"attached":true}}}]}""")
        val rows = agentRows(latestAgents(series.getValue("b1")))
        assertEquals(listOf(AgentRow("%12", "2:frontend", "main", "@3", AgentState.BLOCKED, "permission")), rows)
    }

    @Test fun anUnknownStateMakesNoRowAndAStrangeCauseIsLeftOut() {
        val agents = latestAgents(newest(
            "%1" to entry("main", "@1", 1, "api", 0, "waiting"),               // the app's old vocabulary
            "%2" to entry("main", "@2", 2, "web", 0, "blocked", "PERMISSION <b>")))
        assertNull(agents.first { it.pane == "%1" }.state)
        assertEquals(listOf(AgentRow("%2", "2:web", "main", "@2", AgentState.BLOCKED, null)), agentRows(agents))
    }

    @Test fun chipTextShowsACauseOnlyWhenBlocked() {
        assertEquals("blocked \u00B7 permission", agentChipText(AgentState.BLOCKED, "permission"))
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
