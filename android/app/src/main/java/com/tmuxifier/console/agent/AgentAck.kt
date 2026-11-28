package com.tmuxifier.console.agent

// "Seen is a client claim" (spec 4.5). A finished turn (`done`) turns `idle`
// everywhere only when a client that is really showing it says so, so the app
// claims exactly the pane it rendered, and only while its session screen is in
// front. That whole decision is this file, a pure reducer; SessionScreen feeds
// it each capture and runs the one post it returns.
//
//  - One claim per (box, pane, marker ts): the server refuses a ts ahead of the
//    marker and a marker that has moved on, so the key is exactly what the
//    capture carried and a later finished turn is a new key.
//  - Never two posts in flight: the screen captures every second, a slow post
//    must not stack another behind it, not even for another marker.
//  - 401, 403 and 404 are the server's final answer for this marker (signed
//    out, a refused device, no such box or pane): asking again cannot change
//    it, so it is settled and not posted again. Anything else is retried on a
//    later capture: a transport failure (status 0), a 5xx, and a 400, which the
//    server's markSeen answers whenever its latest sample momentarily lacks
//    the pane, so it is transient while the capture still offers the marker.
//  - A retry is spaced: after a failed post of a key, that key is not posted
//    again for ACK_RETRY_FIRST_MS, doubling with each further failure up to
//    ACK_RETRY_MAX_MS, so a failing acknowledgement is not re-posted on every
//    capture. The spacing belongs to the key: a new marker is posted at once.
//  - A capture with no pane id or no ts (an older server sends neither) is no
//    candidate: nothing is acknowledged and nothing is shown.
//
// The chip is never faked: after a successful claim the next capture reads
// `idle` by itself.
import com.tmuxifier.console.api.PaneSnapshot
import com.tmuxifier.console.session.PANE_ID_RE

/** One marker of one pane of one box: what an acknowledgement names. */
data class AckKey(val boxId: String, val pane: String, val ts: Long)

/** The spacing of a key whose last post failed: not posted again before [notBeforeMs]. */
data class AckRetry(val key: AckKey, val notBeforeMs: Long, val waitMs: Long)

data class AckState(
    val settled: Set<AckKey> = emptySet(),
    val inFlight: AckKey? = null,
    val retry: AckRetry? = null,
)

const val ACK_RETRY_FIRST_MS = 5_000L
const val ACK_RETRY_MAX_MS = 60_000L

/** The marker this capture could acknowledge, or null: only a `done` capture with its pane and ts. */
fun ackCandidate(boxId: String, snap: PaneSnapshot?): AckKey? {
    if (snap == null || snap.agent != AgentState.DONE.wire) return null
    val pane = snap.pane
    val ts = snap.agentTs
    if (pane == null || !PANE_ID_RE.matches(pane)) return null
    if (ts == null || ts <= 0L) return null
    return AckKey(boxId, pane, ts)
}

/**
 * The key to post now, or null: in front, nothing in flight, not already
 * settled, and past its spacing if its last post failed. [nowMs] is a
 * monotonic clock, the same one [ackFinished] was given.
 */
fun ackNext(state: AckState, candidate: AckKey?, foreground: Boolean, nowMs: Long): AckKey? {
    if (!foreground || candidate == null) return null
    if (state.inFlight != null || candidate in state.settled) return null
    val retry = state.retry
    if (retry != null && retry.key == candidate && nowMs < retry.notBeforeMs) return null
    return candidate
}

fun ackStarted(state: AckState, key: AckKey): AckState = state.copy(inFlight = key)

/** The statuses that settle a key for good: the server's final answer for it. */
private fun settles(status: Int): Boolean = status == 200 || status == 401 || status == 403 || status == 404

/**
 * [status] is 200 for success, else the failure's `ApiException.status`. A
 * success or a final refusal settles the key; anything else spaces its next
 * post (see the header), and a key that settles leaves no spacing behind.
 */
fun ackFinished(state: AckState, key: AckKey, status: Int, nowMs: Long): AckState {
    if (settles(status)) {
        return AckState(
            settled = state.settled + key,
            inFlight = null,
            retry = state.retry?.takeIf { it.key != key },
        )
    }
    val prev = state.retry?.takeIf { it.key == key }
    val wait = if (prev == null) ACK_RETRY_FIRST_MS else minOf(prev.waitMs * 2, ACK_RETRY_MAX_MS)
    return AckState(settled = state.settled, inFlight = null, retry = AckRetry(key, nowMs + wait, wait))
}
