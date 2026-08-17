package com.tmuxifier.console

// Plain SharedPreferences for non-secrets (the token lives in TokenStore's
// encrypted store instead). Font size is shared between the Settings slider
// and the pane view's pinch gesture.
import android.content.Context

class Prefs(context: Context) {
    private val p = context.getSharedPreferences("prefs", Context.MODE_PRIVATE)

    var fontSize: Float
        get() = p.getFloat("fontSize", 14f)
        set(v) { p.edit().putFloat("fontSize", v.coerceIn(8f, 32f)).apply() }

    // Composer drafts persist per box: a half-written prompt survives pane
    // switches and process death (the whole point of local-until-send).
    fun draft(boxId: String): String = p.getString("draft.$boxId", "") ?: ""
    fun setDraft(boxId: String, text: String) { p.edit().putString("draft.$boxId", text).apply() }

    // A pinched-in TUI pane size persists per box (0 = unset, follow the
    // auto-fit); the pane's ⤢ fit chip clears it back to auto.
    fun paneFont(boxId: String): Float = p.getFloat("paneFont.$boxId", 0f)
    fun setPaneFont(boxId: String, sp: Float) { p.edit().putFloat("paneFont.$boxId", sp.coerceIn(6f, 32f)).apply() }
    fun clearPaneFont(boxId: String) { p.edit().remove("paneFont.$boxId").apply() }

    // The last FCM registration token the server accepted — skip the PATCH
    // when it hasn't rotated.
    var fcmSynced: String?
        get() = p.getString("fcmSynced", null)
        set(v) { p.edit().putString("fcmSynced", v).apply() }

    // The server-fetched Firebase client config (FcmConfig JSON) that runtime
    // Firebase init uses — persisted so the Application class can initialize
    // at process start (a push can arrive while the app is dead).
    var fcmClientConfig: String?
        get() = p.getString("fcmClientConfig", null)
        set(v) { p.edit().putString("fcmClientConfig", v).apply() }
}
