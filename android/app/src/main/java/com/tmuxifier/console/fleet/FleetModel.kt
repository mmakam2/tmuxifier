package com.tmuxifier.console.fleet

// Pure card mapping for the fleet screen — no Android imports, JVM-tested.
// Mirrors the web dashboard's fleet cards: a spec sheet (what the box is /
// what it has), not live gauges, plus the agent chip that decides the sort.
import com.tmuxifier.console.api.BoxInfo
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.api.Sample

enum class Dot { OK, DOWN, AUTH, PAUSED, STOPPED }

data class BoxCard(
    val id: String,
    val label: String,
    val dot: Dot,
    val agent: String?,        // "working" | "waiting" | null
    val agentForMin: Long?,    // whole minutes in the current agent state
    val spec1: String,         // "debian 12 · 4 cores"
    val spec2: String,         // "7.8G RAM · 11G of 38G disk"
)

fun fleetCards(
    boxes: List<BoxInfo>,
    status: Map<String, BoxStatus>,
    series: Map<String, List<Sample>>,
    now: Long,
): List<BoxCard> {
    val cards = boxes.map { box ->
        val st = status[box.id]
        val samples = series[box.id].orEmpty()
        val (agent, sinceT) = agentStreak(samples)
        BoxCard(
            id = box.id,
            label = box.label.ifEmpty { box.id },
            dot = dotOf(st),
            agent = agent,
            agentForMin = if (agent != null && sinceT != null) ((now - sinceT) / 60_000).coerceAtLeast(0) else null,
            spec1 = spec1(st),
            spec2 = spec2(st),
        )
    }
    // Boxes wanting the operator first, then busy ones, then the rest.
    return cards.sortedWith(
        compareBy({ when (it.agent) { "waiting" -> 0; "working" -> 1; else -> 2 } }, { it.label.lowercase() }),
    )
}

/** The latest agent state and the timestamp of the sample where its streak began. */
private fun agentStreak(samples: List<Sample>): Pair<String?, Long?> {
    val agent = samples.lastOrNull()?.agent ?: return null to null
    var since = samples.last().t
    for (i in samples.indices.reversed()) {
        if (samples[i].agent != agent) break
        since = samples[i].t
    }
    return agent to since
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
