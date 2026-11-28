package com.tmuxifier.console.agent

// The jump to one agent pane (a tap on an agent row, or on a push): which requests
// take the operator there, in what order, and what a failure says. Pure, so every
// case is decided here with real values; the screen that runs it only supplies the
// two calls and opens the session screen afterwards.
//
// The order is the server contract's: repoint the box at the target's session
// (`PATCH /api/boxes/:id`, only when the box's configured session differs), then
// select the window and focus the pane (`POST /api/boxes/:id/window` with
// `paneId`), then open the screen. The window call is made even when the agent may
// already be in front: it is idempotent, and the fleet data can be ten seconds old.
// `ui/SessionSheet.kt` keeps its own window-then-repoint order for its rows, for
// reasons of its own, and is not changed by this.
//
//  - Every id is checked with its regex here, before it can reach a request. A
//    value that fails is dropped (no target), never rewritten; the server checks
//    again, and checks the pane still exists in that window before it moves
//    anything, so a stale target fails cleanly (502) without switching windows.
//  - A push tapped long after it arrived names a session and window that may be
//    gone. The caller asks [targetListed] against fresh data first, so a box is
//    never repointed at a session the server does not list.
//  - A failure is a short line of plain text for the operator: the server's own
//    message (it is text here, never markup), else `HTTP <status>`. A 401 is not
//    ours to report: the device was revoked and the caller's own handler runs.
import com.tmuxifier.console.api.ApiException
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.session.PANE_ID_RE
import com.tmuxifier.console.session.SESSION_NAME_RE
import com.tmuxifier.console.session.WINDOW_ID_RE

/** One pane, named by the session and window that hold it. All three are in shape. */
data class JumpTarget(val session: String, val windowId: String, val pane: String)

/** The target for these ids, or null unless all three are present and match their regex. */
fun jumpTargetOf(session: String?, windowId: String?, pane: String?): JumpTarget? =
    if (session != null && windowId != null && pane != null &&
        SESSION_NAME_RE.matches(session) && WINDOW_ID_RE.matches(windowId) && PANE_ID_RE.matches(pane)
    ) JumpTarget(session, windowId, pane) else null

sealed interface JumpStep {
    data class SetSession(val name: String) : JumpStep
    data class SelectPane(val session: String, val windowId: String, val pane: String) : JumpStep
}

/**
 * The requests for a jump: the repoint first, only when the box's configured
 * session differs from the target's (an unset one is `web`, as in `sessionTargets`),
 * then always the window and pane.
 */
fun planJump(configuredSession: String, target: JumpTarget): List<JumpStep> {
    val current = configuredSession.ifEmpty { "web" } // store.js defaults an absent name to 'web'
    val select = JumpStep.SelectPane(target.session, target.windowId, target.pane)
    return if (current == target.session) listOf(select) else listOf(JumpStep.SetSession(target.session), select)
}

/** Whether the status still lists the target's session and, in it, the target's window. */
fun targetListed(status: BoxStatus?, target: JumpTarget): Boolean =
    status?.sessions.orEmpty().any { s -> s.name == target.session && s.windowList.any { it.id == target.windowId } }

/**
 * Runs the steps in order and stops at the first failure: null on success, else a
 * line for the operator. A 401 is rethrown (the caller's revoked-device path).
 */
suspend fun runJump(
    steps: List<JumpStep>,
    setSession: suspend (String) -> Unit,
    selectPane: suspend (session: String, windowId: String, pane: String) -> Unit,
): String? {
    try {
        for (step in steps) when (step) {
            is JumpStep.SetSession -> setSession(step.name)
            is JumpStep.SelectPane -> selectPane(step.session, step.windowId, step.pane)
        }
    } catch (e: ApiException) {
        if (e.status == 401) throw e
        return e.message?.takeIf { it.isNotBlank() } ?: "HTTP ${e.status}"
    }
    return null
}
