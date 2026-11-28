package com.tmuxifier.console.push

// A push's target: which box and, from a server that sends them, which agent pane
// a tap opens, and which notification a newer push of the same agent replaces.
// The values come from FCM data or from intent extras any app can send (the
// activity is exported), so every case of a bad value is decided here.
import com.tmuxifier.console.agent.JumpTarget
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull

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

    // A background push is posted by the Firebase SDK as notify(<the server's tag>, 0, n);
    // the app's foreground post of the same pane must land in that slot, not beside it.
    @Test fun aPaneNotificationIsPostedInTheBackgroundPushsSlot() {
        assertEquals(NotificationSlot("b1:%12", 0), notificationSlotOf("b1", "%12")) // fcmPush.js: `${boxId}:${pane}`
        assertEquals(NotificationSlot("3f2b8c1e-5d47:%7", 0), notificationSlotOf("3f2b8c1e-5d47", "%7"))
        assertNotEquals(notificationSlotOf("b1", "%12"), notificationSlotOf("b1", "%13"))
        assertNotEquals(notificationSlotOf("b1", "%12"), notificationSlotOf("b2", "%12"))
        // No pane: the box's own id and no tag, as before.
        assertEquals(NotificationSlot(null, "b1".hashCode()), notificationSlotOf("b1", null))
    }
}
