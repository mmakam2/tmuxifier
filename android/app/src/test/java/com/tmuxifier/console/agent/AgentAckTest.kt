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
        assertNull(ackNext(st, KEY, foreground = false, nowMs = 0))
        assertNull(ackNext(st, null, foreground = true, nowMs = 0))
        assertEquals(KEY, ackNext(st, KEY, foreground = true, nowMs = 0))
        st = ackStarted(st, KEY)
        assertNull(ackNext(st, KEY, true, 0))    // in flight: the 1 s captures do not stack posts
        assertNull(ackNext(st, LATER, true, 0))  // not even for another marker
        st = ackFinished(st, KEY, 200, 0)
        assertNull(ackNext(st, KEY, true, 0))    // settled
        assertEquals(LATER, ackNext(st, LATER, true, 0)) // the next finished turn is a new key
    }

    // Only 401, 403 and 404 are the server's final word on a marker. A 400 is
    // transient while the candidate still exists (the server's latest sample
    // momentarily lacked the pane), so it is retried like a transport failure
    // or a 5xx.
    @Test fun aFailureIsRetriedARefusalIsNot() {
        for (status in listOf(0, 400, 409, 500, 502)) {
            val st = ackFinished(ackStarted(AckState(), KEY), KEY, status, 0)
            assertEquals(KEY, ackNext(st, KEY, true, ACK_RETRY_FIRST_MS), "status $status")
        }
        for (status in listOf(401, 403, 404)) {
            val st = ackFinished(ackStarted(AckState(), KEY), KEY, status, 0)
            assertNull(ackNext(st, KEY, true, 1_000_000), "status $status")
        }
    }

    // A failing acknowledgement is not re-posted on every 1 s capture: each
    // failure of a key waits longer before that key is posted again, 5 s
    // doubling to a 60 s ceiling.
    @Test fun aFailedKeyWaitsAGrowingIntervalUpToTheCeiling() {
        var st = AckState()
        var now = 1_000L
        var expectWait = ACK_RETRY_FIRST_MS
        val waits = mutableListOf<Long>()
        repeat(6) {
            assertEquals(KEY, ackNext(st, KEY, true, now))
            st = ackFinished(ackStarted(st, KEY), KEY, 503, now)
            assertNull(ackNext(st, KEY, true, now + expectWait - 1), "wait $expectWait")
            waits.add(expectWait)
            now += expectWait
            expectWait = minOf(expectWait * 2, ACK_RETRY_MAX_MS)
        }
        assertEquals(listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L, 60_000L), waits)
        // A success settles the key and forgets its spacing.
        assertEquals(KEY, ackNext(st, KEY, true, now))
        st = ackFinished(ackStarted(st, KEY), KEY, 200, now)
        assertNull(ackNext(st, KEY, true, now + 1_000_000))
        assertNull(st.retry)
    }

    @Test fun aNewMarkerIsNeverDelayedByAnOlderKeysSpacing() {
        var st = ackFinished(ackStarted(AckState(), KEY), KEY, 0, 0)
        assertNull(ackNext(st, KEY, true, 1))
        assertEquals(LATER, ackNext(st, LATER, true, 1))
        // ...and its own first failure starts its own spacing from the first step.
        st = ackFinished(ackStarted(st, LATER), LATER, 0, 1)
        assertNull(ackNext(st, LATER, true, ACK_RETRY_FIRST_MS))
        assertEquals(LATER, ackNext(st, LATER, true, 1 + ACK_RETRY_FIRST_MS))
    }

    @Test fun aRefusalOrASuccessOfAnotherKeyLeavesNoSpacingBehindForIt() {
        var st = ackFinished(ackStarted(AckState(), KEY), KEY, 0, 0)
        st = ackFinished(ackStarted(st, LATER), LATER, 404, 1)
        assertNull(ackNext(st, LATER, true, 1_000_000)) // settled
        assertEquals(KEY, ackNext(st, KEY, true, ACK_RETRY_FIRST_MS + 1)) // KEY still spaced, not settled
    }
}
