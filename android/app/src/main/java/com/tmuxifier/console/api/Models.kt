package com.tmuxifier.console.api

// Serializable mirrors of the server responses the app consumes. Every
// optional field is defaulted and unknown keys are ignored (ApiJson): the
// server adds fields over time and an old app must keep parsing. `notify`
// stays a Map — notification kinds are server-defined, never enumerated here.
// `agents` is keyed by tmux pane id, and an entry that does not fit is dropped by
// `agent/AgentRows.kt`, never here.
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

@Serializable
data class BoxInfo(
    val id: String,
    val label: String = "",
    val host: String = "",
    val sessionName: String = "",
    val tags: List<String> = emptyList(),
)

@Serializable
data class Metrics(
    val load1: Double? = null,
    val cpus: Int? = null,
    val cpuPct: Int? = null,
    val memTotalKb: Long? = null,
    val memAvailKb: Long? = null,
    val diskTotalKb: Long? = null,
    val diskUsedKb: Long? = null,
    val diskPct: Int? = null,
    val uptimeSec: Long? = null,
    val osId: String? = null,
    val osVer: String? = null,
)

// One tmux window. `id` is tmux's own #{window_id} ("@7") — an id names a
// window OBJECT, not a slot: indexes renumber under move-window, and a grouped
// session (`new-session -t web -s webclone`) SHARES window objects, which is why
// every route that takes an id also demands the session.
@Serializable
data class TmuxWindow(
    val id: String,
    val index: Int = 0,
    val name: String = "",
    val active: Boolean = false,
)

@Serializable
data class TmuxSession(
    val name: String,
    val windows: Int = 0,
    val attached: Boolean = false,
    val activity: Long? = null,
    val paneCmd: String? = null,
    val windowList: List<TmuxWindow> = emptyList(),
)

@Serializable
data class BoxStatus(
    val reachable: Boolean = false,
    val tmux: Boolean? = null,
    val needsAuth: Boolean? = null,
    val paused: Boolean? = null,
    val hostKeyChanged: Boolean? = null,
    val metrics: Metrics? = null,
    val sessions: List<TmuxSession> = emptyList(),
    val proxmoxState: String? = null,
    val error: String? = null,
)

// One agent pane of a sample, keyed by pane id ("%12") in Sample.agents. Only
// the fields the app renders are read; the server's agent, ts, visible, focused
// and attached are deliberately left out. Every field is nullable because a
// server that predates pane-level state keys `agents` by SESSION name with
// entries of another shape, and those must decode (to entries with no window).
@Serializable
data class AgentEntry(
    val session: String? = null,
    val windowId: String? = null,
    val windowIndex: Int? = null,
    val windowName: String? = null,
    val paneIndex: Int? = null,
    val state: String? = null,
    val cause: String? = null,
)

@Serializable
data class Sample(
    val t: Long,
    val up: Boolean,
    val stopped: Boolean? = null,
    val agents: Map<String, AgentEntry> = emptyMap(),
    val cpuPct: Int? = null,
    val memPct: Int? = null,
    val diskPct: Int? = null,
)

@Serializable
data class PaneSnapshot(
    val ok: Boolean = false,
    val width: Int = 0,
    val height: Int = 0,
    val cursorX: Int = 0,
    val cursorY: Int = 0,
    // alt: the pane app owns the full screen (Claude Code, vim); the server
    // ships only the visible screen, so there is no local scrollback beyond
    // it. mouse: the pane accepts SGR wheel injection ({wheel} on /keys) —
    // the app's path to scrolling the TUI's own transcript. Old servers send
    // neither; both default off.
    val alt: Boolean = false,
    val mouse: Boolean = false,
    val content: String = "",
    val agent: String? = null,
    // The captured pane's agent cause, its id ("%12") and its marker's ts, when
    // the server knows them; an older server sends none.
    val agentCause: String? = null,
    val pane: String? = null,
    val agentTs: Long? = null,
    val sessionName: String? = null,
)

@Serializable
data class EnrollResponse(
    val id: String,
    val name: String,
    val created: Long? = null,
    val lastSeen: Long? = null,
    val hasFcmToken: Boolean = false,
    val notify: Map<String, Boolean> = emptyMap(),
    val token: String,
)

@Serializable
data class DeviceView(
    val id: String,
    val name: String = "",
    val hasFcmToken: Boolean = false,
    val notify: Map<String, Boolean> = emptyMap(),
)

// The Firebase client config the operator's server serves for runtime init
// (GET /api/devices/fcm-config). Public client identifiers, not secrets.
@Serializable
data class FcmConfig(
    val available: Boolean = false,
    val projectId: String? = null,
    val senderId: String? = null,
    val applicationId: String? = null,
    val apiKey: String? = null,
)

val ApiJson = Json { ignoreUnknownKeys = true; explicitNulls = false }
val boxListSerializer = ListSerializer(BoxInfo.serializer())
val statusMapSerializer = MapSerializer(String.serializer(), BoxStatus.serializer())
val seriesMapSerializer = MapSerializer(String.serializer(), ListSerializer(Sample.serializer()))
