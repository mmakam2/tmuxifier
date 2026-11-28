package com.tmuxifier.console.ui

// The one agent-state chip, shared by the fleet cards and the session screen so a
// state has one colour and one wording everywhere. The word comes from
// agent/AgentRows.kt (`blocked · <cause>` for a blocked pane that has a cause);
// the colours are the ones the app already uses (the fleet dots and the old
// chip), one per state.
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.tmuxifier.console.agent.AgentState
import com.tmuxifier.console.agent.agentChipText

private fun agentColor(state: AgentState): Color = when (state) {
    AgentState.BLOCKED -> Color(0xFFE53935)
    AgentState.DONE -> Color(0xFFFFB300)
    AgentState.WORKING -> Color(0xFF4CAF50)
    AgentState.IDLE -> Color(0xFF9E9E9E)
}

@Composable
fun AgentChip(state: AgentState, cause: String?, modifier: Modifier = Modifier) {
    val fg = agentColor(state)
    Text(
        agentChipText(state, cause),
        color = fg,
        style = MaterialTheme.typography.labelMedium,
        maxLines = 1,
        modifier = modifier
            .background(fg.copy(alpha = 0.2f), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}
