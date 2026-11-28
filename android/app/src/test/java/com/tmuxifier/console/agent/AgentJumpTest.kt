package com.tmuxifier.console.agent

// The jump planner: which requests take the operator to one agent pane, in what
// order, and what a failure says. Pure, because the screens that run it (a tap on
// an agent row, a tapped push) cannot be unit-tested.
import com.tmuxifier.console.Screen
import com.tmuxifier.console.api.ApiException
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.TmuxSession
import com.tmuxifier.console.api.TmuxWindow
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

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

    // A jump (a row tap) or a push open takes a while; it lands only where the operator
    // still is: same client, same screen, and no later jump or open started since.
    @Test fun aJumpLandsWithTheSameClientOnTheSameScreen() {
        assertTrue(jumpMayLand(startedGen = 3, latestGen = 3, startedOn = Screen.Fleet, now = Screen.Fleet, sameClient = true))
        // a push tap starts over the screen showing then, and lands there
        assertTrue(jumpMayLand(3, 3, Screen.Session("b1", "b1"), Screen.Session("b1", "b1"), sameClient = true))
        assertTrue(jumpMayLand(3, 3, Screen.Settings, Screen.Settings, sameClient = true))
    }

    @Test fun aJumpDoesNotLandForAnotherClient() {
        assertFalse(jumpMayLand(3, 3, Screen.Fleet, Screen.Fleet, sameClient = false)) // signed out, or re-enrolled elsewhere
    }

    @Test fun aJumpDoesNotLandAfterTheScreenChanged() {
        assertFalse(jumpMayLand(3, 3, Screen.Fleet, Screen.Settings, sameClient = true))          // opened Settings
        assertFalse(jumpMayLand(3, 3, Screen.Fleet, Screen.Session("b2", "b2"), sameClient = true)) // tapped a card
        assertFalse(jumpMayLand(3, 3, Screen.Session("b1", "b1"), Screen.Fleet, sameClient = true)) // went back to the list
    }

    @Test fun anEarlierJumpDoesNotLandAfterALaterOneStarted() {
        // a push tapped while a row's jump runs: the push (4) wins, the row's jump (3) is dropped
        assertFalse(jumpMayLand(startedGen = 3, latestGen = 4, startedOn = Screen.Fleet, now = Screen.Fleet, sameClient = true))
        assertTrue(jumpMayLand(startedGen = 4, latestGen = 4, startedOn = Screen.Fleet, now = Screen.Fleet, sameClient = true))
    }

    @Test fun aSucceededJumpHasNoNotice() {
        assertNull(jumpNotice(null, 1))
    }

    @Test fun aFailedJumpNoticeNamesTheReason() {
        assertEquals("agent not selected: box setup is still running", jumpNotice("box setup is still running", 1)?.text)
    }

    @Test fun everyNoticeIsItsOwnEventEvenWithTheSameText() {
        assertNotEquals(jumpNotice("boom", 1), jumpNotice("boom", 2))
        assertEquals(jumpNotice("boom", 1), jumpNotice("boom", 1))
    }
}
