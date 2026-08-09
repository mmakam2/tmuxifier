package com.tmuxifier.console.ui

// Semantic keys for driving Claude — one POST per tap, ^C behind the two-tap
// arm. Buttons are equal-width across the row so every key stays in the thumb
// zone on a ~380dp cover screen.
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tmuxifier.console.keys.ACTION_KEYS
import com.tmuxifier.console.keys.ARM_MS
import com.tmuxifier.console.keys.ArmState
import com.tmuxifier.console.keys.SendSpec
import com.tmuxifier.console.keys.armReduce
import kotlinx.coroutines.delay

@Composable
fun ActionRow(onSend: (SendSpec) -> Unit) {
    var arm by remember { mutableStateOf(ArmState()) }
    LaunchedEffect(arm) {
        if (arm.armed != null) {
            delay(ARM_MS)
            arm = ArmState()
        }
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        for (key in ACTION_KEYS) {
            val isArmed = arm.armed == key.label
            Surface(
                shape = RoundedCornerShape(6.dp),
                color = if (isArmed) MaterialTheme.colorScheme.errorContainer
                else MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier
                    .weight(1f)
                    .clickable {
                        val (next, fire) = armReduce(arm, key.label, key.armed)
                        arm = next
                        if (fire != null) {
                            ACTION_KEYS.firstOrNull { it.label == fire }?.let { onSend(it.send) }
                        }
                    },
            ) {
                Text(
                    if (isArmed) "!" else key.label,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 11.dp),
                )
            }
        }
    }
}
