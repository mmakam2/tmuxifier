package com.tmuxifier.console.push

// What a push points at, read from its data keys (`boxId`, `session`, `windowId`,
// `pane`; src/server/fcmPush.js). The same keys arrive two ways: as FCM data in
// the foreground, and as the launch intent's extras when the operator taps a
// notification, whoever posted it. The activity is exported, so an intent with
// these extras can come from any app on the device: every value is checked here
// before it can reach a request, and a value that fails is dropped, never rewritten.
//
//  - `boxId` becomes a URL path segment, so a push whose box id is not a plain id
//    is no push at all.
//  - The jump target needs all three of session, window and pane, each in shape
//    (`jumpTargetOf`). A push from an older server, or for an older event, has no
//    window or pane: it opens the box, as before.
//  - The notification id is per box and pane, so two agents on one box keep one
//    notification each and an agent's newer push replaces its own. A push with no
//    pane keeps the old id (the box's), so it replaces as it always did.
//
// Pure (no Android imports), so it is JVM-tested.
import com.tmuxifier.console.agent.JumpTarget
import com.tmuxifier.console.agent.jumpTargetOf

private val BOX_ID_RE = Regex("^[A-Za-z0-9_-]{1,64}$")

/** The box a tapped push opens and, when the push named one in shape, the agent pane to jump to. */
data class PushTarget(val boxId: String, val jump: JumpTarget?)

/** The target of a push's data (or a tap's extras), or null unless `boxId` is a plain id. */
fun pushTargetOf(data: Map<String, String?>): PushTarget? {
    val boxId = data["boxId"]?.takeIf { BOX_ID_RE.matches(it) } ?: return null
    return PushTarget(boxId, jumpTargetOf(data["session"], data["windowId"], data["pane"]))
}

/** One notification per box and agent pane; the box's own id for a push with no pane. */
fun notificationIdOf(boxId: String, pane: String?): Int =
    if (pane == null) boxId.hashCode() else "$boxId $pane".hashCode()
