package com.tmuxifier.console.ui

// The reason the app exists: a real Android multiline field where ALL editing
// is local until Send — Samsung keyboard, autocorrect, voice dictation, none
// of it visible to the pty. Send transmits the collapsed draft as literal
// text, then Enter as a named key; empty Send is a bare Enter.
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun ComposerBar(
    draft: String,
    onDraft: (String) -> Unit,
    busy: Boolean,
    onSend: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraft,
            placeholder = { Text("Prompt… (empty Send = Enter)") },
            minLines = 1,
            maxLines = 4,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onSend, enabled = !busy) {
            Text("➤", color = MaterialTheme.colorScheme.primary)
        }
    }
}
