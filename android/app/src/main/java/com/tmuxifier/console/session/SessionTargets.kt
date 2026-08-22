package com.tmuxifier.console.session

// The session sheet's pure row model — a Kotlin transliteration of the web's
// sessionTargets/sessionTargetList (paneHeader.ts) and isSoleWindow/killLegend/
// rowKey (sessionPicker.ts), with two app-only additions: `live` (the app never
// attaches, so a killed session stays dead until something recreates it) and
// `addressable` (every route validates the name and id, so a row tmux will not
// let us name is a row with no actions at all).
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.TmuxSession

// Mirrors src/server/sshCommand.js. The server re-validates everything; these
// only decide what the sheet offers.
val SESSION_NAME_RE = Regex("^[A-Za-z0-9_-]{1,64}$")
val WINDOW_ID_RE = Regex("^@\\d{1,9}$")

const val UNSWITCHABLE = "name not usable from here (allowed: letters, digits, _ -)"
const val UNADDRESSABLE_WINDOW = "window id not usable from here"

enum class TargetKind { SESSION, WINDOW }

data class SessionTarget(
    val kind: TargetKind,
    // "s:<session>" | "w:<session>:<@id>". A window value carries its session
    // even though @id looks unique: a grouped session shares window objects, so
    // the same id appears under two names, and an arm keyed by the bare id could
    // migrate between the arming and firing taps.
    val value: String,
    val label: String,
    val session: String,
    val windowId: String? = null,
    val current: Boolean = false,     // belongs to the box's configured session
    val live: Boolean = true,         // tmux lists it right now
    val addressable: Boolean = true,  // the routes can name it
    val reason: String? = null,       // why not
)

data class SessionTargetList(val options: List<SessionTarget>, val value: String)

/** What tapping a row does. The sheet branches on this, never on the fields. */
enum class RowAction { SELECTED, SWITCH, RECREATE, NONE }

fun rowAction(t: SessionTarget): RowAction = when {
    !t.addressable -> RowAction.NONE
    t.kind == TargetKind.SESSION && t.current && !t.live -> RowAction.RECREATE
    t.kind == TargetKind.SESSION && t.current -> RowAction.SELECTED
    else -> RowAction.SWITCH
}

/** A row may be killed only if a route can name it and tmux still has it. */
fun canKill(t: SessionTarget): Boolean = t.addressable && t.live

fun rowKey(t: SessionTarget): String = t.value

/**
 * The rows: the box's configured session first — always, live or not, because
 * it is the selection fallback and, when dead, the only path back — its windows
 * beneath it, then every other live session with its own windows.
 */
fun sessionTargets(status: BoxStatus?, sessionName: String?): List<SessionTarget> {
    val current = sessionName.orEmpty().ifEmpty { "web" } // store.js defaults an absent name to 'web'
    val live = status?.sessions.orEmpty().filter { it.name.isNotEmpty() }
    val currentLive = live.firstOrNull { it.name == current }
    val ordered = listOf(currentLive ?: TmuxSession(name = current)) + live.filter { it.name != current }
    val out = mutableListOf<SessionTarget>()
    for (s in ordered) {
        val isCurrent = s.name == current
        val nameOk = SESSION_NAME_RE.matches(s.name)
        out += SessionTarget(
            kind = TargetKind.SESSION,
            value = "s:${s.name}",
            label = s.name,
            session = s.name,
            current = isCurrent,
            live = !isCurrent || currentLive != null,
            addressable = nameOk,
            reason = if (nameOk) null else UNSWITCHABLE,
        )
        for (w in s.windowList) {
            val idOk = WINDOW_ID_RE.matches(w.id)
            out += SessionTarget(
                kind = TargetKind.WINDOW,
                value = "w:${s.name}:${w.id}",
                label = "${w.index}: ${w.name.ifEmpty { "window" }}",
                session = s.name,
                windowId = w.id,
                current = isCurrent,
                live = true,
                addressable = nameOk && idOk,
                reason = when {
                    !nameOk -> UNSWITCHABLE
                    !idOk -> UNADDRESSABLE_WINDOW
                    else -> null
                },
            )
        }
    }
    return out
}

/**
 * The rows plus the selected one: the current session's ACTIVE window when the
 * snapshot knows it, else the session row. This is what makes the sheet answer
 * "which window am I looking at", not only which session the box points at.
 */
fun sessionTargetList(status: BoxStatus?, sessionName: String?): SessionTargetList {
    val current = sessionName.orEmpty().ifEmpty { "web" }
    val active = status?.sessions.orEmpty()
        .firstOrNull { it.name == current }?.windowList?.firstOrNull { it.active }
    return SessionTargetList(
        options = sessionTargets(status, sessionName),
        value = if (active != null) "w:$current:${active.id}" else "s:$current",
    )
}

/**
 * tmux destroys a session when its last window is killed. Nothing here
 * special-cases that — it just refuses to let it be a surprise, by letting the
 * arm legend say so.
 */
fun isSoleWindow(targets: List<SessionTarget>, t: SessionTarget): Boolean =
    t.kind == TargetKind.WINDOW &&
        targets.count { it.kind == TargetKind.WINDOW && it.session == t.session } == 1

/** What the armed × states before the second tap commits. */
fun killLegend(t: SessionTarget, sole: Boolean): String = when {
    t.kind == TargetKind.SESSION && t.current -> "kill ${t.label}? the app is showing this session"
    t.kind == TargetKind.SESSION -> "kill session ${t.label}?"
    sole && t.current -> "kill ${t.label}? last window — the app's session goes too"
    sole -> "kill ${t.label}? last window — the session goes too"
    else -> "kill ${t.label}?"
}
