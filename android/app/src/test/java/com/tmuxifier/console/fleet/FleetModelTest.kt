package com.tmuxifier.console.fleet

import com.tmuxifier.console.agent.AgentRow
import com.tmuxifier.console.agent.AgentState
import com.tmuxifier.console.api.AgentEntry
import com.tmuxifier.console.api.ApiJson
import com.tmuxifier.console.api.BoxInfo
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.Metrics
import com.tmuxifier.console.api.Sample
import com.tmuxifier.console.api.seriesMapSerializer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun box(id: String, label: String) =
    BoxInfo(id = id, label = label, host = "h", sessionName = "main", tags = emptyList())

private fun agent(state: String?, windowIndex: Int = 1, name: String = "api", cause: String? = null) =
    AgentEntry(session = "main", windowId = "@$windowIndex", windowIndex = windowIndex, windowName = name, paneIndex = 0, state = state, cause = cause)
private fun newest(vararg agents: Pair<String, AgentEntry>) = listOf(Sample(t = 1000, up = true, agents = mapOf(*agents)))

class FleetModelTest {
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

    @Test fun specLinesFromMetrics() {
        val st = BoxStatus(
            reachable = true,
            metrics = Metrics(
                cpus = 4, osId = "debian", osVer = "12",
                memTotalKb = 8_192_000, diskUsedKb = 12_000_000, diskTotalKb = 40_000_000,
            ),
        )
        val card = fleetCards(listOf(box("a", "alpha")), mapOf("a" to st), emptyMap())[0]
        assertEquals("debian 12 · 4 cores", card.spec1)
        assertTrue(card.spec2.contains("RAM"))
        assertTrue(card.spec2.contains("disk"))
        assertEquals(Dot.OK, card.dot)
    }

    @Test fun dotPrecedence() {
        assertEquals(
            Dot.AUTH,
            fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = true, needsAuth = true)), emptyMap())[0].dot,
        )
        assertEquals(
            Dot.DOWN,
            fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = false)), emptyMap())[0].dot,
        )
        assertEquals(
            Dot.STOPPED,
            fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = false, proxmoxState = "stopped")), emptyMap())[0].dot,
        )
    }

    @Test fun missingMetricsDegradeToPlaceholders() {
        val card = fleetCards(listOf(box("a", "x")), emptyMap(), emptyMap())[0]
        assertEquals("—", card.spec1)
        assertEquals("—", card.spec2)
    }

    @Test fun bytesFormatterDropsTrailingZero() {
        assertEquals("7.8G", fmtBytesKb(8_192_000))
        assertEquals("38G", fmtBytesKb(40_000_000))
        assertEquals("512K", fmtBytesKb(512))
    }

    @Test fun cardsCarryTheConfiguredSessionName() {
        val cards = fleetCards(
            boxes = listOf(
                BoxInfo(id = "b1", label = "alpha", sessionName = "web"),
                BoxInfo(id = "b2", label = "beta"),
            ),
            status = emptyMap(),
            series = emptyMap(),
        )
        assertEquals("web", cards.first { it.id == "b1" }.sessionName)
        // An unset name stays empty here; the target model applies store.js's
        // 'web' default in one place rather than two.
        assertEquals("", cards.first { it.id == "b2" }.sessionName)
    }
}
