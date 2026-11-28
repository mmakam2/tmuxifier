package com.tmuxifier.console.ui

// Home: box cards, blocked agents on top; each card lists its agent panes, one row
// per pane with its state (fleet/FleetModel.kt names and orders them); a row tap
// opens that agent (MainActivity's openAgent runs the jump). Polls every
// 10s while STARTED — repeatOnLifecycle cancels the loop in background (push
// covers it; the spec forbids background polling).
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tmuxifier.console.R
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.tmuxifier.console.AppState
import com.tmuxifier.console.Screen
import com.tmuxifier.console.agent.AgentRow
import com.tmuxifier.console.agent.JumpTarget
import com.tmuxifier.console.api.ApiException
import com.tmuxifier.console.api.BoxStatus
import com.tmuxifier.console.fleet.BoxCard
import com.tmuxifier.console.fleet.Dot
import com.tmuxifier.console.fleet.fleetCards
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay

private fun dotColor(d: Dot): Color = when (d) {
    Dot.OK -> Color(0xFF4CAF50)
    Dot.DOWN -> Color(0xFFE53935)
    Dot.AUTH -> Color(0xFFAB47BC)
    Dot.PAUSED -> Color(0xFF9E9E9E)
    Dot.STOPPED -> Color(0xFF607D8B)
}

@Composable
fun FleetScreen(
    state: AppState,
    onOpen: (Screen.Session) -> Unit,
    onOpenAgent: (boxId: String, label: String, configuredSession: String, target: JumpTarget) -> Unit,
    opening: Boolean,
    onSettings: () -> Unit,
    onUnauthorized: () -> Unit,
) {
    val client = state.client() ?: return
    var cards by remember { mutableStateOf<List<BoxCard>>(emptyList()) }
    var statuses by remember { mutableStateOf<Map<String, BoxStatus>>(emptyMap()) }
    // The box id, not the card: the 10s poll rebuilds `cards`, and a sheet
    // handed the snapshot it opened with would keep naming the session the box
    // pointed at then — including right after a switch made from the sheet
    // itself. Re-derived below on every composition instead.
    var sheetForId by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var offline by remember { mutableStateOf(false) }

    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(client) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                try {
                    coroutineScope {
                        val boxesJob = async { client.boxes() }
                        val statusJob = async { client.status() }
                        val seriesJob = async { client.series() }
                        val bx = boxesJob.await()
                        val st = statusJob.await()
                        val se = seriesJob.await()
                        // The sheet opens on this snapshot; fleetCards keeps only
                        // what a card draws, and the rows need the sessions. Both
                        // writes land together, after every await succeeds, so a
                        // failure on one endpoint can never leave statuses ahead
                        // of cards from different poll cycles.
                        statuses = st
                        cards = fleetCards(bx, st, se)
                    }
                    loaded = true
                    offline = false
                } catch (e: ApiException) {
                    if (e.status == 401) { onUnauthorized(); return@repeatOnLifecycle }
                    offline = true
                }
                delay(10_000)
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(
                painterResource(R.drawable.tmuxifier_logo),
                contentDescription = null,
                modifier = Modifier.size(30.dp),
            )
            // Version in the home header: device-validation rounds keep
            // getting confused about which build is actually installed.
            Text(
                "tmuxifier · v${com.tmuxifier.console.BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f).padding(start = 10.dp),
            )
            IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, contentDescription = "Settings") }
        }
        if (opening) {
            // A row's jump is in flight: its rows take no second tap until it lands.
            Text(
                "opening…",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        } else if (offline) {
            Text(
                "offline — retrying",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        }
        if (loaded && cards.isEmpty()) {
            Text("No boxes.", modifier = Modifier.padding(16.dp))
        }
        LazyColumn(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        ) {
            items(cards, key = { it.id }) { card ->
                BoxCardRow(
                    card,
                    onClick = { onOpen(Screen.Session(card.id, card.label)) },
                    onLongClick = { sheetForId = card.id },
                    opening = opening,
                    // The row's ids came through agentRows, which validated them.
                    onOpenAgent = { row ->
                        onOpenAgent(card.id, card.label, card.sessionName, JumpTarget(row.session, row.windowId, row.pane))
                    },
                )
            }
        }
        sheetForId?.let { id ->
            cards.firstOrNull { it.id == id }?.let { card ->
                SessionSheet(
                    state = state,
                    boxId = card.id,
                    boxLabel = card.label,
                    sessionName = card.sessionName,
                    initialStatus = statuses[card.id],
                    onDismiss = { sheetForId = null },
                    onUnauthorized = onUnauthorized,
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BoxCardRow(
    card: BoxCard,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    opening: Boolean,
    onOpenAgent: (AgentRow) -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    Surface(
        shape = RoundedCornerShape(10.dp),
        tonalElevation = 2.dp,
        modifier = Modifier.fillMaxWidth().combinedClickable(
            onClick = onClick,
            onLongClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onLongClick()
            },
        ),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).background(dotColor(card.dot), CircleShape))
                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                    Text(card.label, style = MaterialTheme.typography.titleMedium)
                    Text(card.spec1, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(card.spec2, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (card.agents.isNotEmpty()) {
                // Indented under the label, a 1 dp guide down its left edge.
                val guide = MaterialTheme.colorScheme.outlineVariant
                Column(
                    Modifier
                        .padding(start = 20.dp, top = 8.dp)
                        .drawBehind { drawRect(guide, size = Size(1.dp.toPx(), size.height)) }
                        .padding(start = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    card.agents.forEach { row ->
                        AgentRowLine(row, enabled = !opening, onClick = { onOpenAgent(row) })
                    }
                }
            }
        }
    }
}

// One agent pane: its name, then its state chip. A row with no onClick draws no
// click target, so a tap on it reaches the card behind it.
@Composable
private fun AgentRowLine(row: AgentRow, enabled: Boolean = true, onClick: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            row.name,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        AgentChip(row.state, row.cause, Modifier.padding(start = 8.dp))
    }
}
