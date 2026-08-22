package com.tmuxifier.console.session

// Every test here names a property AND builds the world where it is false.
// The v1.24.48 web run shipped three tests that passed while proving nothing,
// all by skipping that second half.
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.TmuxSession
import com.tmuxifier.console.api.TmuxWindow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private fun win(id: String, index: Int, name: String, active: Boolean = false) =
    TmuxWindow(id = id, index = index, name = name, active = active)

private fun status(vararg sessions: TmuxSession) =
    BoxStatus(reachable = true, tmux = true, sessions = sessions.toList())

class SessionTargetsTest {
    @Test fun configuredSessionLeadsAndSurvivesWhenTmuxDoesNotListIt() {
        // tmux knows only "other"; the box still points at "web".
        val t = sessionTargets(status(TmuxSession(name = "other")), "web")
        assertEquals("web", t.first().session)
        assertEquals(TargetKind.SESSION, t.first().kind)
        assertFalse(t.first().live)
        assertEquals(RowAction.RECREATE, rowAction(t.first()))
        assertFalse(canKill(t.first()))
    }

    @Test fun configuredSessionIsLiveWhenTmuxListsIt() {
        // The falsifying half of the test above: a model hardcoding live=false
        // would pass that one and fail this one.
        val t = sessionTargets(status(TmuxSession(name = "web")), "web")
        assertTrue(t.first().live)
        assertEquals(RowAction.SELECTED, rowAction(t.first()))
        assertTrue(canKill(t.first()))
    }

    @Test fun absentSessionNameFallsBackToWeb() {
        // store.js defaults an absent name to 'web'.
        assertEquals("web", sessionTargets(null, null).single().session)
        assertEquals("web", sessionTargets(null, "").single().session)
    }

    @Test fun groupedSessionsShareWindowIdsButRowKeysDiffer() {
        // `new-session -t web -s webclone` shares window OBJECTS: the same @7
        // legitimately appears under two names. Keyed by id alone, an arm could
        // migrate onto the other session between the arming and firing taps.
        val shared = listOf(win("@7", 0, "zsh"))
        val t = sessionTargets(
            status(TmuxSession(name = "web", windowList = shared), TmuxSession(name = "webclone", windowList = shared)),
            "web",
        )
        val windows = t.filter { it.kind == TargetKind.WINDOW }
        assertEquals(2, windows.size)
        assertEquals(listOf("w:web:@7", "w:webclone:@7"), windows.map { rowKey(it) })
        assertEquals(2, windows.map { it.value }.toSet().size)
    }

    @Test fun isSoleWindowIsTrueOnlyForASessionsLastWindow() {
        val t = sessionTargets(
            status(
                TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"), win("@1", 1, "claude"))),
                TmuxSession(name = "solo", windowList = listOf(win("@9", 0, "zsh"))),
            ),
            "web",
        )
        val twoOfTwo = t.first { it.value == "w:web:@1" }
        val onlyOne = t.first { it.value == "w:solo:@9" }
        assertFalse(isSoleWindow(t, twoOfTwo))
        assertTrue(isSoleWindow(t, onlyOne))
        assertFalse(isSoleWindow(t, t.first()))  // a session row is never a sole window
    }

    @Test fun killLegendDistinguishesEveryBlastRadius() {
        val t = sessionTargets(
            status(
                TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"), win("@1", 1, "claude"))),
                TmuxSession(name = "other", windowList = listOf(win("@9", 0, "zsh"))),
            ),
            "web",
        )
        val currentSession = t.first { it.value == "s:web" }
        val otherSession = t.first { it.value == "s:other" }
        val plainWindow = t.first { it.value == "w:web:@1" }
        val soleOther = t.first { it.value == "w:other:@9" }
        // Four distinct sentences: the app-view warning, the plain session, the
        // plain window, and the session-goes-too window. Asserting only that
        // each contains its name would pass for one shared string.
        val legends = listOf(
            killLegend(currentSession, isSoleWindow(t, currentSession)),
            killLegend(otherSession, isSoleWindow(t, otherSession)),
            killLegend(plainWindow, isSoleWindow(t, plainWindow)),
            killLegend(soleOther, isSoleWindow(t, soleOther)),
        )
        assertEquals(4, legends.toSet().size)
        assertTrue(legends[0].contains("the app is showing"))
        assertEquals("kill session other?", legends[1])
        assertEquals("kill 1: claude?", legends[2])
        assertTrue(legends[3].contains("last window"))
    }

    @Test fun unaddressableNamesOfferNoAction() {
        // A name outside SESSION_NAME_RE cannot be switched (PATCH would
        // silently rewrite it), killed, or window-selected — all three routes
        // apply the same charset. Offered, disabled, reason attached.
        val t = sessionTargets(
            status(TmuxSession(name = "web"), TmuxSession(name = "my session", windowList = listOf(win("@4", 0, "zsh")))),
            "web",
        )
        val bad = t.first { it.session == "my session" && it.kind == TargetKind.SESSION }
        val badWindow = t.first { it.session == "my session" && it.kind == TargetKind.WINDOW }
        assertFalse(bad.addressable)
        assertEquals(UNSWITCHABLE, bad.reason)
        assertEquals(RowAction.NONE, rowAction(bad))
        assertFalse(canKill(bad))
        assertEquals(RowAction.NONE, rowAction(badWindow))
        assertFalse(canKill(badWindow))
        // Beside it, an ordinary name is addressable — otherwise a model that
        // returned NONE for everything would pass.
        assertTrue(t.first { it.value == "s:web" }.addressable)
    }

    @Test fun windowsOfAnUnaddressableCurrentSessionAreAlsoUnaddressable() {
        // Deliberate deviation from the web, which exempts the current
        // session's windows ("they need no PATCH"). POST /window sends the
        // SESSION too, and 400s on this name — so there is nothing to offer.
        val t = sessionTargets(
            status(TmuxSession(name = "my session", windowList = listOf(win("@4", 0, "zsh")))),
            "my session",
        )
        val window = t.first { it.kind == TargetKind.WINDOW }
        assertFalse(window.addressable)
        assertEquals(RowAction.NONE, rowAction(window))
    }

    @Test fun windowIdOutsideItsCharsetIsUnaddressable() {
        val t = sessionTargets(status(TmuxSession(name = "web", windowList = listOf(win("7", 0, "zsh")))), "web")
        val window = t.first { it.kind == TargetKind.WINDOW }
        assertFalse(window.addressable)
        assertFalse(canKill(window))
    }

    @Test fun windowRowsAreLabelledByIndexAndName() {
        val t = sessionTargets(status(TmuxSession(name = "web", windowList = listOf(win("@0", 0, ""), win("@1", 3, "claude")))), "web")
        val labels = t.filter { it.kind == TargetKind.WINDOW }.map { it.label }
        // No indent in the label: a Compose row indents with padding, unlike an
        // <option>, so the web's WINDOW_INDENT has no counterpart here.
        assertEquals(listOf("0: window", "3: claude"), labels)
    }

    @Test fun selectionIsTheCurrentSessionsActiveWindow() {
        val list = sessionTargetList(
            status(TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"), win("@3", 1, "claude", active = true)))),
            "web",
        )
        assertEquals("w:web:@3", list.value)
    }

    @Test fun selectionFallsBackToTheSessionRowWhenNoWindowIsActive() {
        assertEquals("s:web", sessionTargetList(status(TmuxSession(name = "web")), "web").value)
        assertEquals("s:web", sessionTargetList(null, "web").value)
    }

    @Test fun aWindowRowKnowsWhetherItsSessionIsTheConfiguredOne() {
        // `current` is the flag the sheet branches on for a window tap: a window
        // of the configured session needs select-window alone, one of ANOTHER
        // session needs the PATCH too or the tap changes a session nobody is
        // looking at. So both halves are pinned here, and the configured
        // session's ACTIVE window is the one used — a model that answered
        // SELECTED for it (it IS the ✓ row) would silently make that tap a
        // no-op, and every other fixture in this file builds inactive windows.
        val snapshot = status(
            TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"), win("@3", 1, "claude", active = true))),
            TmuxSession(name = "alpha", windowList = listOf(win("@5", 2, "claude"))),
        )
        val t = sessionTargets(snapshot, "web")
        val activeOfCurrent = t.first { it.value == "w:web:@3" }
        val foreign = t.first { it.value == "w:alpha:@5" }
        assertTrue(activeOfCurrent.current)
        assertFalse(foreign.current)
        // Both are still a SWITCH: what differs is only the price of the switch.
        assertEquals(RowAction.SWITCH, rowAction(activeOfCurrent))
        assertEquals(RowAction.SWITCH, rowAction(foreign))
        // ...and the active window is the selected row, so the two facts above
        // are about the row the ✓ actually sits on.
        assertEquals("w:web:@3", sessionTargetList(snapshot, "web").value)
    }

    @Test fun otherSessionsFollowTheConfiguredOneWithTheirOwnWindows() {
        val t = sessionTargets(
            status(
                TmuxSession(name = "alpha", windowList = listOf(win("@5", 0, "zsh"))),
                TmuxSession(name = "web", windowList = listOf(win("@0", 0, "zsh"))),
            ),
            "web",
        )
        assertEquals(listOf("s:web", "w:web:@0", "s:alpha", "w:alpha:@5"), t.map { it.value })
        assertTrue(t.first { it.value == "w:web:@0" }.current)
        assertFalse(t.first { it.value == "w:alpha:@5" }.current)
        assertEquals(RowAction.SWITCH, rowAction(t.first { it.value == "s:alpha" }))
        assertEquals(RowAction.SWITCH, rowAction(t.first { it.value == "w:web:@0" }))
    }
}
