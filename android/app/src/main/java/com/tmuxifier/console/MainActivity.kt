package com.tmuxifier.console

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tmuxifier.console.ui.FleetScreen
import com.tmuxifier.console.ui.SessionScreen
import com.tmuxifier.console.ui.SettingsScreen

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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val state = AppState(applicationContext)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    Shell(state)
                }
            }
        }
    }
}

@Composable
private fun Shell(state: AppState) {
    var screen by rememberSaveable(stateSaver = ScreenSaver) {
        mutableStateOf(if (state.enrolled) Screen.Fleet else Screen.Settings)
    }
    // Back from Session/Settings returns to Fleet (once enrolled); on Fleet the
    // system default applies (app backgrounds).
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

@Composable
private fun PlaceholderScreen(title: String, body: String, onSettings: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(body, style = MaterialTheme.typography.bodyMedium)
        Button(onClick = onSettings) { Text("Settings") }
    }
}
