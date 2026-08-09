package com.tmuxifier.console.ui

// Enrollment + preferences. The app offers ONLY the pairing-code path — it
// works against both server auth modes (and passkey-only), so a password
// field would be a second branch with no user; password enrollment stays a
// server-side API (curl, tests).
import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.tmuxifier.console.AppState
import com.tmuxifier.console.api.ApiClient
import com.tmuxifier.console.api.ApiException
import com.tmuxifier.console.api.normalizeBaseUrl
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(state: AppState, onEnrolled: () -> Unit, onSignedOut: () -> Unit) {
    val scope = rememberCoroutineScope()
    var url by rememberSaveable { mutableStateOf(state.store.baseUrl ?: "") }
    var name by rememberSaveable { mutableStateOf(state.store.deviceName ?: Build.MODEL) }
    var code by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var enrolled by remember { mutableStateOf(state.enrolled) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var fontSize by remember { mutableStateOf(state.prefs.fontSize) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.titleLarge)
        if (enrolled) {
            Text("Server: ${state.store.baseUrl}", style = MaterialTheme.typography.bodyMedium)
            Text("Device: ${state.store.deviceName}", style = MaterialTheme.typography.bodyMedium)
            Text("Terminal font size: ${fontSize.toInt()} sp", style = MaterialTheme.typography.bodyMedium)
            Slider(
                value = fontSize,
                onValueChange = { fontSize = it; state.prefs.fontSize = it },
                valueRange = 8f..32f,
            )
            Button(onClick = { confirmSignOut = true }) { Text("Sign out") }
            if (confirmSignOut) {
                AlertDialog(
                    onDismissRequest = { confirmSignOut = false },
                    title = { Text("Sign out?") },
                    text = { Text("This forgets the token on this phone only. The server still lists the device until you revoke it in web Settings → Devices.") },
                    confirmButton = {
                        TextButton(onClick = {
                            confirmSignOut = false
                            enrolled = false
                            state.signOut()
                            onSignedOut()
                        }) { Text("Sign out") }
                    },
                    dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
                )
            }
        } else {
            OutlinedTextField(
                url, { url = it },
                label = { Text("Server URL") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                name, { name = it },
                label = { Text("Device name") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                code, { code = it },
                label = { Text("Pairing code") }, singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                modifier = Modifier.fillMaxWidth(),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(enabled = !busy, onClick = {
                val base = normalizeBaseUrl(url)
                if (base == null) {
                    error = "Enter a valid server URL"
                    return@Button
                }
                busy = true
                error = null
                scope.launch {
                    try {
                        val res = ApiClient(base, null).enroll(code.trim(), name.trim())
                        state.store.baseUrl = base
                        state.store.token = res.token
                        state.store.deviceName = res.name
                        enrolled = true
                        onEnrolled()
                    } catch (e: ApiException) {
                        error = when (e.status) {
                            401 -> "Wrong or expired code — mint a fresh one in web Settings → Devices"
                            429 -> "Rate-limited — wait a minute and try again"
                            0 -> "Can't reach the server: ${e.message}"
                            else -> e.message
                        }
                    } finally {
                        busy = false
                    }
                }
            }) { Text(if (busy) "Enrolling…" else "Enroll") }
            Text(
                "Mint a code in the web dashboard: Settings → Devices → Pair new device (valid 2 minutes).",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
