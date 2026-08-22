package com.tmuxifier.console.ui

// The session sheet: a box's tmux sessions and windows, with switch, kill and
// create. Opened by a long press on a Fleet card or the Session header's chip.
// The rows come from the pure model in session/SessionTargets.kt; this file
// owns only presentation, the arm-then-fire policy, and the calls.
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.tmuxifier.console.AppState
import com.tmuxifier.console.api.ApiException
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.keys.ARM_MS
import com.tmuxifier.console.keys.ArmState
import com.tmuxifier.console.keys.armReduce
import com.tmuxifier.console.session.RowAction
import com.tmuxifier.console.session.SESSION_NAME_RE
import com.tmuxifier.console.session.SessionTarget
import com.tmuxifier.console.session.TargetKind
import com.tmuxifier.console.session.canKill
import com.tmuxifier.console.session.isSoleWindow
import com.tmuxifier.console.session.killLegend
import com.tmuxifier.console.session.rowAction
import com.tmuxifier.console.session.rowKey
import com.tmuxifier.console.session.sessionTargetList
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// How long the open path waits for a fresh probe before showing the list it
// already has. Long enough for a healthy box over the ControlMaster, short
// enough that a box which has gone away is a slightly-late list, not a dead
// sheet. Mirrors the web's freshProbe.ts cap.
const val OPEN_REFRESH_WAIT_MS = 700L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionSheet(
    state: AppState,
    boxId: String,
    boxLabel: String,
    sessionName: String,
    initialStatus: BoxStatus?,
    onDismiss: () -> Unit,
    onUnauthorized: () -> Unit,
) {
    val client = state.client() ?: return
    var status by remember(boxId) { mutableStateOf(initialStatus) }
    var refreshing by remember(boxId) { mutableStateOf(false) }
    var busy by remember(boxId) { mutableStateOf(false) }
    var error by remember(boxId) { mutableStateOf<String?>(null) }
    var arm by remember(boxId) { mutableStateOf(ArmState()) }
    var creating by remember(boxId) { mutableStateOf(false) }
    var newName by remember(boxId) { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState()

    // quiet: an open-path probe that fails while we already have rows is a
    // slightly-stale list, not something to shout about. After an action it is.
    suspend fun refresh(quiet: Boolean) {
        try {
            client.probe(boxId)[boxId]?.let { status = it }
        } catch (e: ApiException) {
            when {
                e.status == 401 -> onUnauthorized()
                quiet && status != null -> Unit
                else -> error = e.message
            }
        }
    }

    fun act(block: suspend () -> Unit) {
        scope.launch {
            busy = true
            error = null
            arm = ArmState()
            try {
                block()
                // The window and kill routes re-probe server-side, so this
                // reads an authoritative snapshot rather than a 30s cache.
                refresh(quiet = false)
            } catch (e: ApiException) {
                when (e.status) {
                    401 -> onUnauthorized()
                    404 -> { error = e.message; onDismiss() }
                    else -> error = e.message
                }
            } finally {
                busy = false
            }
        }
    }

    // Open on whatever is in hand, then probe — and stop WAITING after the cap,
    // never stop probing: a late answer still lands and repaints the rows.
    LaunchedEffect(boxId) {
        refreshing = true
        scope.launch { refresh(quiet = true) }
        delay(OPEN_REFRESH_WAIT_MS)
        refreshing = false
    }
    LaunchedEffect(arm) {
        if (arm.armed != null) {
            delay(ARM_MS)
            arm = ArmState()
        }
    }

    val list = sessionTargetList(status, sessionName)

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().padding(bottom = 28.dp)) {
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(boxLabel, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                if (refreshing || busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            }
            for (t in list.options) {
                TargetRow(
                    t = t,
                    selected = t.value == list.value,
                    sole = isSoleWindow(list.options, t),
                    armed = arm.armed == rowKey(t),
                    enabled = !busy,
                    onTap = {
                        arm = ArmState()
                        when (rowAction(t)) {
                            RowAction.SWITCH ->
                                if (t.kind == TargetKind.WINDOW) {
                                    act { client.selectWindow(boxId, t.session, t.windowId!!) }
                                } else {
                                    act { client.setSession(boxId, t.session) }
                                }
                            RowAction.RECREATE -> act { client.createSession(boxId, t.session) }
                            RowAction.SELECTED, RowAction.NONE -> Unit
                        }
                    },
                    onKill = {
                        val (next, fire) = armReduce(arm, rowKey(t), armable = true)
                        arm = next
                        if (fire != null) act { client.killTarget(boxId, t.session, t.windowId) }
                    },
                )
            }
            if (creating) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = newName,
                        onValueChange = { newName = it },
                        singleLine = true,
                        label = { Text("session name") },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        modifier = Modifier.weight(1f),
                    )
                    // A courtesy, not a gate: the server rejects rather than
                    // silently renaming, and learning the charset after a round
                    // trip is a worse way to learn it.
                    TextButton(
                        enabled = !busy && SESSION_NAME_RE.matches(newName),
                        onClick = {
                            val name = newName
                            act {
                                client.createSession(boxId, name)
                                newName = ""
                                creating = false
                            }
                        },
                    ) { Text("Create") }
                }
            } else {
                TextButton(onClick = { creating = true }, modifier = Modifier.padding(horizontal = 8.dp)) {
                    Text("+ New session…")
                }
            }
            Text(
                "Switching a session repoints this box everywhere — open browsers reconnect to it.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
            error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
        }
    }
}

// One row: tap the body to act, the trailing × to kill. Windows are indented
// with padding rather than with characters in the label.
@Composable
private fun TargetRow(
    t: SessionTarget,
    selected: Boolean,
    sole: Boolean,
    armed: Boolean,
    enabled: Boolean,
    onTap: () -> Unit,
    onKill: () -> Unit,
) {
    val action = rowAction(t)
    val dim = action == RowAction.NONE
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled && action != RowAction.NONE, onClick = onTap)
            .padding(start = if (t.kind == TargetKind.WINDOW) 40.dp else 16.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (selected) "✓" else " ",
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(end = 8.dp),
        )
        Column(Modifier.weight(1f).padding(vertical = 10.dp)) {
            Text(
                t.label,
                style = MaterialTheme.typography.bodyLarge,
                color = if (dim) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            )
            val note = when {
                t.reason != null -> t.reason
                action == RowAction.RECREATE -> "not running — tap to recreate"
                else -> null
            }
            note?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (canKill(t)) {
            TextButton(enabled = enabled, onClick = onKill) {
                Text(
                    if (armed) killLegend(t, sole) else "×",
                    color = MaterialTheme.colorScheme.error,
                    style = if (armed) MaterialTheme.typography.bodySmall else MaterialTheme.typography.titleMedium,
                )
            }
        }
    }
}
