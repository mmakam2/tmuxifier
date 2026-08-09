package com.tmuxifier.console.keys

// The action row's key catalog and the arm-then-fire reducer — a Kotlin port
// of the web's arming.ts policy: first tap arms, second tap commits, anything
// else disarms (and fires itself, if it's an ordinary key). ARM_MS matches
// the web's 3s window.

const val ARM_MS = 3000L

data class ArmState(val armed: String? = null)

sealed interface SendSpec {
    data class Named(val key: String) : SendSpec
    data class Text(val text: String) : SendSpec
}

data class ActionKey(val label: String, val send: SendSpec, val armed: Boolean = false)

// Digits and y/n are TEXT sends — the server's NAMED_KEYS allowlist has no
// names for them (send-keys -l types them literally).
val ACTION_KEYS: List<ActionKey> = listOf(
    ActionKey("Esc", SendSpec.Named("Escape")),
    ActionKey("↑", SendSpec.Named("Up")),
    ActionKey("↓", SendSpec.Named("Down")),
    ActionKey("Tab", SendSpec.Named("Tab")),
    ActionKey("⏎", SendSpec.Named("Enter")),
    ActionKey("1", SendSpec.Text("1")),
    ActionKey("2", SendSpec.Text("2")),
    ActionKey("3", SendSpec.Text("3")),
    ActionKey("y", SendSpec.Text("y")),
    ActionKey("n", SendSpec.Text("n")),
    ActionKey("^C", SendSpec.Named("C-c"), armed = true),
)

/** Returns the next state and the label to fire (null while arming). */
fun armReduce(state: ArmState, clickedId: String, armable: Boolean): Pair<ArmState, String?> = when {
    armable && state.armed == clickedId -> ArmState() to clickedId
    armable -> ArmState(clickedId) to null
    else -> ArmState() to clickedId
}
