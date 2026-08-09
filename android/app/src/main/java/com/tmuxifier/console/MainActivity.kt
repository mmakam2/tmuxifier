package com.tmuxifier.console

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.google.firebase.messaging.FirebaseMessaging
import com.tmuxifier.console.push.pushAvailable
import com.tmuxifier.console.ui.FleetScreen
import com.tmuxifier.console.ui.SessionScreen
import com.tmuxifier.console.ui.SettingsScreen
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

// Screen survives process death as a string — no navigation library for a
// three-screen app.
val ScreenSaver = Saver<Screen, String>(
    save = {
        when (it) {
            Screen.Fleet -> "fleet"
            Screen.Settings -> "settings"
            is Screen.Session -> "session:${it.boxId}:${it.boxLabel}"
        }
    },
    restore = { raw ->
        when {
            raw == "settings" -> Screen.Settings
            raw.startsWith("session:") -> {
                val parts = raw.removePrefix("session:").split(":", limit = 2)
                Screen.Session(parts[0], parts.getOrElse(1) { parts[0] })
            }
            else -> Screen.Fleet
        }
    },
)

class MainActivity : ComponentActivity() {
    // A push tap lands here: the notification intent (foreground path) and the
    // system-posted notification (background path) both carry a boxId extra.
    private val pendingBox = mutableStateOf<String?>(null)
    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* optional — push just stays silent if denied */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Canonical inset handling: explicit edge-to-edge so the window
        // dispatches real inset values, consumed by safeDrawingPadding on the
        // root (bars + cutout + IME — the keyboard resizes the layout). The
        // brief windowOptOutEdgeToEdgeEnforcement detour is gone: One UI can
        // overlay-draw its 3-button nav bar regardless, so padding from
        // dispatched insets is the only approach that covers it.
        enableEdgeToEdge()
        val state = AppState(applicationContext)
        pendingBox.value = intent?.getStringExtra("boxId")
        if (state.enrolled) {
            maybeAskNotifications()
            syncFcmToken(state)
        }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    // targetSdk 35 forces edge-to-edge: without this, the
                    // composer sits under the gesture-nav zone (taps eaten,
                    // keyboard never summoned) and the IME covers the bottom
                    // bar instead of lifting it. safeDrawing = bars + cutout
                    // + ime, so the keyboard resizes the layout too.
                    Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                        Shell(state, pendingBox)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pendingBox.value = intent.getStringExtra("boxId")
    }

    private fun maybeAskNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // Push the current FCM registration token to the server when it differs
    // from the last one it accepted (rotation also lands via onNewToken).
    private fun syncFcmToken(state: AppState) {
        if (!pushAvailable(this)) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { t ->
            if (t.isNullOrEmpty() || t == state.prefs.fcmSynced) return@addOnSuccessListener
            val client = state.client() ?: return@addOnSuccessListener
            CoroutineScope(Dispatchers.IO).launch {
                runCatching { client.updateSelf(fcmToken = t) }
                    .onSuccess { state.prefs.fcmSynced = t }
            }
        }
    }
}

@Composable
private fun Shell(state: AppState, pendingBox: MutableState<String?>) {
    var screen by rememberSaveable(stateSaver = ScreenSaver) {
        mutableStateOf(if (state.enrolled) Screen.Fleet else Screen.Settings)
    }
    // Notification tap-through: an agent-input push opens that box's session.
    LaunchedEffect(pendingBox.value) {
        val boxId = pendingBox.value ?: return@LaunchedEffect
        if (state.enrolled) screen = Screen.Session(boxId, boxId)
        pendingBox.value = null
    }
    BackHandler(enabled = state.enrolled && screen != Screen.Fleet) { screen = Screen.Fleet }
    when (screen) {
        Screen.Settings -> SettingsScreen(
            state,
            onEnrolled = { screen = Screen.Fleet },
            onSignedOut = { /* stay on Settings, now in enroll mode */ },
        )
        Screen.Fleet -> FleetScreen(
            state,
            onOpen = { screen = it },
            onSettings = { screen = Screen.Settings },
            onUnauthorized = { screen = Screen.Settings },
        )
        is Screen.Session -> {
            val s = screen as Screen.Session
            SessionScreen(
                state,
                boxId = s.boxId,
                boxLabel = s.boxLabel,
                onUnauthorized = { screen = Screen.Settings },
            )
        }
    }
}
