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

class AppState(context: Context) {
    val store = TokenStore(context)
    val prefs = Prefs(context)

    val enrolled: Boolean get() = store.baseUrl != null && store.token != null

    fun client(): ApiClient? {
        val url = store.baseUrl ?: return null
        val token = store.token ?: return null
        return ApiClient(url, token)
    }

    // Local sign-out only: there is no self-delete route — the server-side
    // record stays until it is revoked from web Settings → Devices. The FCM
    // sync cache must go too: a re-enrollment mints a NEW server row, and a
    // cached "already synced" token would skip the PATCH that row needs.
    fun signOut() {
        store.clear()
        prefs.fcmSynced = null
    }
}
