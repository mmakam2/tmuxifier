package com.tmuxifier.console.fleet

import com.tmuxifier.console.api.BoxInfo
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.Metrics
import com.tmuxifier.console.api.Sample
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private fun box(id: String, label: String) =
    BoxInfo(id = id, label = label, host = "h", sessionName = "main", tags = emptyList())

class FleetModelTest {
    @Test fun waitingSortsAboveWorkingAboveIdle() {
        val boxes = listOf(box("a", "alpha"), box("b", "beta"), box("c", "gamma"))
        val series = mapOf(
            "b" to listOf(Sample(t = 1000, up = true, agent = "waiting")),
            "c" to listOf(Sample(t = 1000, up = true, agent = "working")),
        )
        val cards = fleetCards(boxes, emptyMap(), series, now = 2000)
        assertEquals(listOf("b", "c", "a"), cards.map { it.id })
    }

    @Test fun agentDurationCountsBackToTheFlip() {
        // waiting for 4 minutes: the streak of samples with the same agent state
        val s = listOf(
            Sample(t = 0, up = true, agent = "working"),
            Sample(t = 240_000, up = true, agent = "waiting"),
            Sample(t = 300_000, up = true, agent = "waiting"),
        )
        val card = fleetCards(listOf(box("a", "alpha")), emptyMap(), mapOf("a" to s), now = 480_000)[0]
        assertEquals("waiting", card.agent)
        assertEquals(4L, card.agentForMin)
    }

    @Test fun specLinesFromMetrics() {
        val st = BoxStatus(
            reachable = true,
            metrics = Metrics(
                cpus = 4, osId = "debian", osVer = "12",
                memTotalKb = 8_192_000, diskUsedKb = 12_000_000, diskTotalKb = 40_000_000,
            ),
        )
        val card = fleetCards(listOf(box("a", "alpha")), mapOf("a" to st), emptyMap(), now = 0)[0]
        assertEquals("debian 12 · 4 cores", card.spec1)
        assertTrue(card.spec2.contains("RAM"))
        assertTrue(card.spec2.contains("disk"))
        assertEquals(Dot.OK, card.dot)
    }

    @Test fun dotPrecedence() {
        assertEquals(
            Dot.AUTH,
            fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = true, needsAuth = true)), emptyMap(), 0)[0].dot,
        )
        assertEquals(
            Dot.DOWN,
            fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = false)), emptyMap(), 0)[0].dot,
        )
        assertEquals(
            Dot.STOPPED,
            fleetCards(listOf(box("a", "x")), mapOf("a" to BoxStatus(reachable = false, proxmoxState = "stopped")), emptyMap(), 0)[0].dot,
        )
    }

    @Test fun missingMetricsDegradeToPlaceholders() {
        val card = fleetCards(listOf(box("a", "x")), emptyMap(), emptyMap(), 0)[0]
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
            now = 0L,
        )
        assertEquals("web", cards.first { it.id == "b1" }.sessionName)
        // An unset name stays empty here; the target model applies store.js's
        // 'web' default in one place rather than two.
        assertEquals("", cards.first { it.id == "b2" }.sessionName)
    }
}
