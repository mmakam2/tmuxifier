package com.tmuxifier.console.agent

// The acknowledgement decision (spec 4.5, "seen is a client claim"): every case
// of when the session screen may post an agent-seen is decided here, with real
// values, because the Compose wiring that runs it cannot be unit-tested.
import com.tmuxifier.console.api.PaneSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
