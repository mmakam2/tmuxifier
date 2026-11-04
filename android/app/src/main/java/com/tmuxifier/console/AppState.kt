package com.tmuxifier.console

import android.content.Context
import com.tmuxifier.console.api.ApiClient
import com.tmuxifier.console.api.TokenStore

// The three screens. Session carries the label so its header doesn't need a
// boxes fetch to render.
sealed class Screen {
    data object Fleet : Screen()
    data class Session(val boxId: String, val boxLabel: String) : Screen()
    data object Settings : Screen()
}

internal class ClientCache(
    private val factory: (String, String) -> ApiClient = { url, token -> ApiClient(url, token) },
) {
    private var cachedUrl: String? = null
    private var cachedToken: String? = null
    private var cachedClient: ApiClient? = null

    @Synchronized
    fun get(url: String?, token: String?): ApiClient? {
        if (url == null || token == null) {
            clear()
            return null
        }
        val existing = cachedClient
        if (existing != null && cachedUrl == url && cachedToken == token) return existing
        return factory(url, token).also {
            cachedUrl = url
            cachedToken = token
            cachedClient = it
        }
    }

    @Synchronized
    fun clear() {
        cachedUrl = null
        cachedToken = null
        cachedClient = null
    }
}

class AppState(context: Context) {
    val store = TokenStore(context)
    val prefs = Prefs(context)
    private val clients = ClientCache()

    val enrolled: Boolean get() = store.baseUrl != null && store.token != null

    fun client(): ApiClient? = clients.get(store.baseUrl, store.token)

    // Local sign-out only: there is no self-delete route — the server-side
    // record stays until it is revoked from web Settings → Devices. The FCM
    // sync cache must go too: a re-enrollment mints a NEW server row, and a
    // cached "already synced" token would skip the PATCH that row needs.
    fun signOut() {
        clients.clear()
        store.clear()
        prefs.fcmSynced = null
    }
}
