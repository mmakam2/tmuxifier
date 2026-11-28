package com.tmuxifier.console.fleet

// Pure card mapping for the fleet screen — no Android imports, JVM-tested.
// Mirrors the web dashboard's fleet cards: a spec sheet (what the box is /
// what it has), not live gauges, plus one row per agent pane (named and ordered
// by agent/AgentRows.kt, as the browser's sidebar does) whose worst state decides
// the sort.
import com.tmuxifier.console.agent.AgentRow
import com.tmuxifier.console.agent.AgentState
import com.tmuxifier.console.agent.agentRows
import com.tmuxifier.console.agent.latestAgents
import com.tmuxifier.console.agent.worstState
import com.tmuxifier.console.api.BoxInfo
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.Sample

enum class Dot { OK, DOWN, AUTH, PAUSED, STOPPED }

data class BoxCard(
    val id: String,
    val label: String,
    val sessionName: String,   // the box's configured tmux session — what the sheet opens on
    val dot: Dot,
    val agents: List<AgentRow>, // one per agent pane with a state, in the browser's order
    val worst: AgentState?,    // the most urgent of [agents]; null when there is none
    val spec1: String,         // "debian 12 · 4 cores"
    val spec2: String,         // "7.8G RAM · 11G of 38G disk"
)

fun fleetCards(
    boxes: List<BoxInfo>,
    status: Map<String, BoxStatus>,
    series: Map<String, List<Sample>>,
): List<BoxCard> {
    val cards = boxes.map { box ->
        val st = status[box.id]
        val agents = agentRows(latestAgents(series[box.id]))
        BoxCard(
            id = box.id,
            label = box.label.ifEmpty { box.id },
            sessionName = box.sessionName,
            dot = dotOf(st),
            agents = agents,
            worst = worstState(agents),
            spec1 = spec1(st),
            spec2 = spec2(st),
        )
    }
    // Boxes wanting the operator first (blocked, done, working, idle), then the
    // ones with no agent.
    return cards.sortedWith(
        compareBy({ it.worst?.ordinal ?: AgentState.entries.size }, { it.label.lowercase() }),
    )
}

private fun dotOf(st: BoxStatus?): Dot = when {
    st == null -> Dot.DOWN
    st.proxmoxState == "stopped" -> Dot.STOPPED
    st.needsAuth == true -> Dot.AUTH
    !st.reachable -> Dot.DOWN
    st.paused == true -> Dot.PAUSED
    else -> Dot.OK
}

private fun spec1(st: BoxStatus?): String {
    val m = st?.metrics ?: return "—"
    val os = listOfNotNull(m.osId, m.osVer).joinToString(" ").ifEmpty { null }
    val cores = m.cpus?.let { "$it cores" }
    return listOfNotNull(os, cores).joinToString(" · ").ifEmpty { "—" }
}

private fun spec2(st: BoxStatus?): String {
    val m = st?.metrics ?: return "—"
    val ram = m.memTotalKb?.let { "${fmtBytesKb(it)} RAM" }
    val disk = if (m.diskUsedKb != null && m.diskTotalKb != null) {
        "${fmtBytesKb(m.diskUsedKb)} of ${fmtBytesKb(m.diskTotalKb)} disk"
    } else null
    return listOfNotNull(ram, disk).joinToString(" · ").ifEmpty { "—" }
}

/** KB → "7.8G" style; whole numbers keep no decimal (a capacity is a round number). */
fun fmtBytesKb(kb: Long): String {
    var v = kb.toDouble()
    val units = arrayOf("K", "M", "G", "T", "P")
    var u = 0
    while (v >= 1024 && u < units.size - 1) { v /= 1024; u++ }
    val rounded = (v * 10).toLong() / 10.0
    val num = if (v >= 10 || rounded == rounded.toLong().toDouble()) {
        Math.round(v).toString()
    } else {
        rounded.toString()
    }
    return num + units[u]
}
