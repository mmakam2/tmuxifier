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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
import com.tmuxifier.console.session.killConsequence
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
    // The sheet owns its idea of which session the box is pointed at. The
    // param is the caller's snapshot — up to a Fleet poll (10s) old, and after
    // a switch made from HERE it is simply wrong until that poll lands. Both
    // the ✓ and killLegend key on it, so a stale value moves the tick nowhere
    // after a successful switch and makes the arm legend state the wrong blast
    // radius ("the app is showing this session" on the session it no longer is).
    var currentSession by remember(boxId) { mutableStateOf(sessionName) }
    var refreshing by remember(boxId) { mutableStateOf(false) }
    var busy by remember(boxId) { mutableStateOf(false) }
    var error by remember(boxId) { mutableStateOf<String?>(null) }
    var arm by remember(boxId) { mutableStateOf(ArmState()) }
    var creating by remember(boxId) { mutableStateOf(false) }
    var newName by remember(boxId) { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState()

    // Every refresh() call is its own independently-launched coroutine (the
    // open-path probe keeps running past its own wait cap, and an action's
    // post-action probe can be launched while it is still in flight), so two
    // responses can land out of order. A monotonic generation — issued at the
    // START of refresh(), compared before the result is applied — keeps a
    // late, stale response from clobbering a fresher one. All of these run on
    // the composable's own (main) dispatcher, so plain Int state is enough:
    // no two refresh() calls execute concurrently between suspension points.
    var probeSeq by remember(boxId) { mutableStateOf(0) }
    var appliedSeq by remember(boxId) { mutableStateOf(0) }

    // quiet: an open-path probe that fails while we already have rows is a
    // slightly-stale list, not something to shout about. After an action it is.
    suspend fun refresh(quiet: Boolean) {
        val seq = ++probeSeq
        try {
            val result = client.probe(boxId)[boxId]
            if (result != null && seq > appliedSeq) {
                status = result
                appliedSeq = seq
                // A successful probe retires whatever the last failure said:
                // otherwise an offline message sits under a freshly-populated
                // list until the next action happens to clear it.
                error = null
            }
        } catch (e: ApiException) {
            when {
                e.status == 401 -> onUnauthorized()
                quiet && status != null -> Unit
                else -> error = e.message
            }
        }
    }

    // Repoint the box, and adopt the name the server hands back — that BoxInfo
    // is what setSession returns and is fresher than anything the caller holds,
    // so the sheet's ✓ and legends are correct before the next poll lands.
    suspend fun switchTo(name: String) {
        val info = client.setSession(boxId, name)
        currentSession = info.sessionName.ifEmpty { name }
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
        // Handed no name at all (the Session screen before its first snapshot,
        // or after /pane went 502 on a dead session): ask the server what the
        // box is configured for, alongside the probe. Without this the model
        // would default to 'web' — store.js's own default, but not necessarily
        // THIS box's session — and offer to recreate a session it never had.
        // Best-effort: a failure leaves the sheet working on that default.
        if (sessionName.isEmpty()) {
            scope.launch {
                val name = try {
                    client.boxes().firstOrNull { it.id == boxId }?.sessionName.orEmpty()
                } catch (_: ApiException) {
                    ""
                }
                if (name.isNotEmpty() && currentSession.isEmpty()) currentSession = name
            }
        }
        delay(OPEN_REFRESH_WAIT_MS)
        refreshing = false
    }
    // A changed param is fresh server truth from the caller's own poll, so it
    // wins over what the sheet remembers. Empty is not truth — it is the
    // caller having nothing yet — and never clobbers a resolved name.
    LaunchedEffect(sessionName) {
        if (sessionName.isNotEmpty()) currentSession = sessionName
    }
    LaunchedEffect(arm) {
        if (arm.armed != null) {
            delay(ARM_MS)
            arm = ArmState()
        }
    }

    val list = sessionTargetList(status, currentSession)

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 28.dp)) {
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
                            // A window of the CURRENT session is the cheap case:
                            // select-window alone, no PATCH and no reattach —
                            // the current window is session state in tmux, so
                            // every attached client follows on its own. A window
                            // of ANOTHER session needs both, window first: the
                            // PATCH is what actually repoints the box (without
                            // it the tap changes a session nobody is looking at
                            // and nothing visible moves), and doing the window
                            // first means the reattach it forces lands already
                            // on the chosen window. Both in ONE act {} so a
                            // failure surfaces once and the probe still runs.
                            RowAction.SWITCH ->
                                if (t.kind == TargetKind.WINDOW) {
                                    act {
                                        client.selectWindow(boxId, t.session, t.windowId!!)
                                        if (!t.current) switchTo(t.session)
                                    }
                                } else {
                                    act { switchTo(t.session) }
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
                        // Gated like the Create button beside it: the success
                        // path clears newName, so text typed while a create is
                        // in flight would be wiped without ever being sent.
                        enabled = !busy,
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
                TextButton(
                    onClick = { creating = true },
                    enabled = !busy,
                    modifier = Modifier.padding(horizontal = 8.dp),
                ) {
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
            // While armed, the pending consequence outranks both — it is the
            // only one of the three that is about to destroy something, and it
            // lasts three seconds.
            val consequence = if (armed) killConsequence(t, sole) else null
            val note = when {
                consequence != null -> consequence
                t.reason != null -> t.reason
                action == RowAction.RECREATE -> "not running — tap to recreate"
                else -> null
            }
            note?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (consequence != null) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (canKill(t)) {
            // The button stays compact in both states so the tap target does not
            // move between the arming tap and the firing one; the warning itself
            // rides the row's note line above. Sighted users read the clause
            // there, screen readers get the whole sentence from here.
            val legend = killLegend(t, sole)
            TextButton(
                enabled = enabled,
                onClick = onKill,
                modifier = Modifier.semantics { contentDescription = legend },
            ) {
                Text(
                    if (armed) "kill?" else "×",
                    color = MaterialTheme.colorScheme.error,
                    style = if (armed) MaterialTheme.typography.labelLarge else MaterialTheme.typography.titleMedium,
                )
            }
        }
    }
}
