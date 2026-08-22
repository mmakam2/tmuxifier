package com.tmuxifier.console.api

// The one HTTP layer. Thin on purpose: every method is a suspend call that
// either returns a parsed model or throws ApiException(status, message) —
// status 0 means transport (network) failure, 401 is how screens learn the
// device was revoked. Bodies are built with kotlinx JSON builders, never
// string concatenation, so nothing user-typed needs escaping here.
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String) : Exception(message)

// Split out of killTarget so the presence rule is unit-testable: the route
// branches on whether windowId is there, so a session kill must OMIT it rather
// than send null.
internal fun killBody(session: String, windowId: String?): String = buildJsonObject {
    put("session", session)
    if (windowId != null) put("windowId", windowId)
}.toString()

class ApiClient(val baseUrl: String, private val token: String?) {
    private val http = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build()
    private val jsonType = "application/json".toMediaType()

    private fun errorOf(body: String, code: Int): String = try {
        ApiJson.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.content ?: "HTTP $code"
    } catch (_: Exception) {
        "HTTP $code"
    }

    private suspend fun request(method: String, path: String, body: String? = null): String =
        withContext(Dispatchers.IO) {
            val b = Request.Builder().url(baseUrl + path)
            if (token != null) b.header("Authorization", "Bearer $token")
            if (method == "GET") b.get() else b.method(method, (body ?: "{}").toRequestBody(jsonType))
            try {
                http.newCall(b.build()).execute().use { res ->
                    val text = res.body?.string() ?: ""
                    if (!res.isSuccessful) throw ApiException(res.code, errorOf(text, res.code))
                    text
                }
            } catch (e: IOException) {
                throw ApiException(0, e.message ?: "network error")
            }
        }

    private fun <T> parse(s: DeserializationStrategy<T>, text: String): T = ApiJson.decodeFromString(s, text)

    suspend fun enroll(code: String, name: String, fcmToken: String? = null): EnrollResponse {
        val body = buildJsonObject {
            put("code", code)
            put("name", name)
            if (fcmToken != null) put("fcmToken", fcmToken)
        }.toString()
        return parse(EnrollResponse.serializer(), request("POST", "/api/devices/enroll", body))
    }

    suspend fun boxes(): List<BoxInfo> = parse(boxListSerializer, request("GET", "/api/boxes"))

    suspend fun status(): Map<String, BoxStatus> = parse(statusMapSerializer, request("GET", "/api/status"))

    suspend fun series(): Map<String, List<Sample>> = parse(seriesMapSerializer, request("GET", "/api/health/series"))

    // cols/rows, when present, ask the server to keep an invisible tmux client
    // of that size attached (device-token identity), so the window reflows to
    // phone geometry the way an attached browser would.
    suspend fun pane(boxId: String, lines: Int = 200, cols: Int? = null, rows: Int? = null): PaneSnapshot {
        val geo = if (cols != null && rows != null) "&cols=$cols&rows=$rows" else ""
        return parse(PaneSnapshot.serializer(), request("GET", "/api/boxes/$boxId/pane?lines=$lines$geo"))
    }

    suspend fun sendText(boxId: String, text: String) {
        request("POST", "/api/boxes/$boxId/keys", buildJsonObject { put("text", text) }.toString())
    }

    suspend fun sendKey(boxId: String, key: String) {
        request("POST", "/api/boxes/$boxId/keys", buildJsonObject { put("key", key) }.toString())
    }

    // Scroll a mouse-aware pane app's own viewport (Claude Code's transcript):
    // the server injects SGR wheel reports, refusing panes without mouse
    // tracking (409). dir is "up" or "down" — server-validated.
    suspend fun sendWheel(boxId: String, dir: String, steps: Int = 5) {
        request("POST", "/api/boxes/$boxId/keys", buildJsonObject { put("wheel", dir); put("steps", steps) }.toString())
    }

    // Re-probe ONE box and hand back its fresh entry, keyed by box id — the
    // same shape GET /api/status answers in. Deliberately un-gated by a running
    // setup job on the server: it only reads what the poller already reads.
    suspend fun probe(boxId: String): Map<String, BoxStatus> =
        parse(statusMapSerializer, request("POST", "/api/boxes/$boxId/probe"))

    // Switch the session's active window. No reattach: the current window is
    // session state in tmux, so every attached client follows on its own.
    suspend fun selectWindow(boxId: String, session: String, windowId: String) {
        request("POST", "/api/boxes/$boxId/window",
            buildJsonObject { put("session", session); put("windowId", windowId) }.toString())
    }

    // Kill a session, or one window inside it. Session-qualified in both forms.
    suspend fun killTarget(boxId: String, session: String, windowId: String? = null) {
        request("POST", "/api/boxes/$boxId/kill", killBody(session, windowId))
    }

    // Create a session detached, WITHOUT switching the box to it — the same
    // ensure-session remote (carrying the box's startupCommand) that the
    // browser's attach path would have run.
    suspend fun createSession(boxId: String, name: String) {
        request("POST", "/api/boxes/$boxId/sessions", buildJsonObject { put("name", name) }.toString())
    }

    // Repoint the box at another session. GLOBAL: the server drops every
    // viewer's PTY so browsers reattach to the new session.
    suspend fun setSession(boxId: String, name: String): BoxInfo =
        parse(BoxInfo.serializer(), request("PATCH", "/api/boxes/$boxId",
            buildJsonObject { put("sessionName", name) }.toString()))

    suspend fun fcmConfig(): FcmConfig =
        parse(FcmConfig.serializer(), request("GET", "/api/devices/fcm-config"))

    suspend fun updateSelf(fcmToken: String? = null, notify: Map<String, Boolean>? = null): DeviceView {
        val body = buildJsonObject {
            if (fcmToken != null) put("fcmToken", fcmToken)
            if (notify != null) put("notify", buildJsonObject { notify.forEach { (k, v) -> put(k, v) } })
        }.toString()
        return parse(DeviceView.serializer(), request("PATCH", "/api/devices/self", body))
    }
}
