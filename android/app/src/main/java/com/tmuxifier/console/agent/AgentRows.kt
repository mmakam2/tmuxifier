package com.tmuxifier.console.agent

// The agent rows of one box: the Kotlin twin of the browser's `agentRows` in
// src/web/agentState.ts. The unit of agent state is the tmux PANE, and the server
// ships `agents` on every health sample keyed by pane id. The two runtimes must
// name and order a pane identically, so the name an operator reads in the
// browser's sidebar is the name the app shows. The browser's cases are the
// NAMING_CASES table in test/agentNaming.test.js; AgentRowsTest repeats them, and
// a case added there is added here.
//
// Naming rule: a row is named for its window, `<windowIndex>:<windowName>` (`window`
// when the name is empty). `.<paneIndex>` is appended only when the box has more
// than one agent ENTRY with the same session and window id; `<session> › ` is
// prefixed only when the box's agent entries span more than one session. Both
// counts run over entries, stateless ones included, and only an entry WITH a state
// becomes a row: a name does not change when a neighbouring pane's marker appears
// or goes. Rows are ordered by session (plain `String.compareTo`, no lowercasing),
// then window index, then pane index, never by state.
//
// Only the newest sample counts, and an entry that does not fit is dropped, never
// repaired: the server validates again, and today's released server keys `agents`
// by SESSION name with entries that carry no window or pane index, which this
// shape check turns into no rows at all rather than into wrong ones.
import com.tmuxifier.console.api.Sample
import com.tmuxifier.console.session.PANE_ID_RE
import com.tmuxifier.console.session.SESSION_NAME_RE
import com.tmuxifier.console.session.WINDOW_ID_RE

/** Declaration order is the precedence, worst (most attention-demanding) first; `ordinal` is the rank. */
enum class AgentState(val wire: String) {
    BLOCKED("blocked"),
    DONE("done"),
    WORKING("working"),
    IDLE("idle"),
}

/** The four words the server sends, exactly; anything else (the app's old `waiting` too) is no state. */
fun agentStateOf(wire: String?): AgentState? = AgentState.entries.firstOrNull { it.wire == wire }

/** The state word; a blocked pane with a cause reads `blocked · <cause>`. */
fun agentChipText(state: AgentState, cause: String?): String =
    if (state == AgentState.BLOCKED && !cause.isNullOrEmpty()) "blocked · $cause" else state.wire

// Causes are server-defined and grow, so this is a shape, not a list.
private val CAUSE_RE = Regex("^[a-z][a-z_-]{0,23}$")

/** One agent pane of the newest sample, every field checked; [state] is null for a pane with no marker yet. */
data class AgentPane(
    val pane: String,
    val session: String,
    val windowId: String,
    val windowIndex: Int,
    val windowName: String,
    val paneIndex: Int,
    val state: AgentState?,
    val cause: String?,
)

/** The newest sample's agent panes that fit the shape the app will name a request after. */
fun latestAgents(samples: List<Sample>?): List<AgentPane> {
    val newest = samples?.lastOrNull() ?: return emptyList()
    return newest.agents.mapNotNull { (pane, e) ->
        val session = e.session
        val windowId = e.windowId
        val windowIndex = e.windowIndex
        val paneIndex = e.paneIndex
        if (!PANE_ID_RE.matches(pane)) return@mapNotNull null
        if (session == null || !SESSION_NAME_RE.matches(session)) return@mapNotNull null
        if (windowId == null || !WINDOW_ID_RE.matches(windowId)) return@mapNotNull null
        if (windowIndex == null || windowIndex < 0) return@mapNotNull null
        if (paneIndex == null || paneIndex < 0) return@mapNotNull null
        AgentPane(
            pane = pane,
            session = session,
            windowId = windowId,
            windowIndex = windowIndex,
            windowName = e.windowName.orEmpty(),
            paneIndex = paneIndex,
            state = agentStateOf(e.state),
            cause = e.cause?.takeIf { CAUSE_RE.matches(it) },
        )
    }
}

/** One row of a box's agent list: a pane with a state, named by the rule in this file's header. */
data class AgentRow(
    val pane: String,
    val name: String,
    val session: String,
    val windowId: String,
    val state: AgentState,
    val cause: String?,
)

private val ROW_ORDER = compareBy<AgentPane>({ it.session }, { it.windowIndex }, { it.paneIndex })

/** The box's agent rows: named, ordered, stateful only. The two counts run over [agents] whole. */
fun agentRows(agents: List<AgentPane>): List<AgentRow> {
    val perWindow = agents.groupingBy { it.session to it.windowId }.eachCount()
    val acrossSessions = agents.map { it.session }.distinct().size > 1
    return agents.sortedWith(ROW_ORDER).mapNotNull { a ->
        val state = a.state ?: return@mapNotNull null
        var name = "${a.windowIndex}:${a.windowName.ifEmpty { "window" }}"
        if ((perWindow[a.session to a.windowId] ?: 0) > 1) name += ".${a.paneIndex}"
        if (acrossSessions) name = "${a.session} › $name"
        AgentRow(a.pane, name, a.session, a.windowId, state, a.cause)
    }
}

/** The worst state among [rows] (the enum's order), or null when there are none. */
fun worstState(rows: List<AgentRow>): AgentState? = rows.minOfOrNull { it.state }
