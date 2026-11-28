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
//  - A transport failure (status 0) or a 5xx is retried on a later capture. A
//    4xx is the server's answer for this marker (nothing to acknowledge, a
//    refused device); asking again every second cannot change it, so it is
//    settled and not posted again.
//  - A capture with no pane id or no ts (an older server sends neither) is no
//    candidate: nothing is acknowledged and nothing is shown.
//
// The chip is never faked: after a successful claim the next capture reads
// `idle` by itself.
import com.tmuxifier.console.api.PaneSnapshot
import com.tmuxifier.console.session.PANE_ID_RE

/** One marker of one pane of one box: what an acknowledgement names. */
data class AckKey(val boxId: String, val pane: String, val ts: Long)

data class AckState(val settled: Set<AckKey> = emptySet(), val inFlight: AckKey? = null)

/** The marker this capture could acknowledge, or null: only a `done` capture with its pane and ts. */
fun ackCandidate(boxId: String, snap: PaneSnapshot?): AckKey? {
    if (snap == null || snap.agent != AgentState.DONE.wire) return null
    val pane = snap.pane
    val ts = snap.agentTs
    if (pane == null || !PANE_ID_RE.matches(pane)) return null
    if (ts == null || ts <= 0L) return null
    return AckKey(boxId, pane, ts)
}

/** The key to post now, or null: in front, nothing in flight, and not already settled. */
fun ackNext(state: AckState, candidate: AckKey?, foreground: Boolean): AckKey? {
    if (!foreground || candidate == null) return null
    if (state.inFlight != null || candidate in state.settled) return null
    return candidate
}

fun ackStarted(state: AckState, key: AckKey): AckState = state.copy(inFlight = key)

/** [status] is 200 for success, else the failure's `ApiException.status`; 0 and 5xx stay unsettled. */
fun ackFinished(state: AckState, key: AckKey, status: Int): AckState =
    AckState(
        settled = if (status == 200 || status in 400..499) state.settled + key else state.settled,
        inFlight = null,
    )
