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
}
