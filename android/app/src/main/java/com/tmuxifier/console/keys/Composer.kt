package com.tmuxifier.console.keys

// Client-side mirror of the server's sanitizeSendText (tmuxInject.js) and the
// web composer's sendTextOf: whitespace runs — including newlines, which
// send-keys would deliver as Enter — collapse to single spaces; remaining
// C0/C1 controls are stripped; trimmed. Mirrored here so what the operator
// sees leave the field is exactly what lands in the pane.
private val WS = Regex("\\s+")
private val CONTROLS = Regex("[\u0000-\u0008\u000B-\u001F\u007F-\u009F]")

fun sendTextOf(draft: String): String =
    draft.replace(WS, " ").replace(CONTROLS, "").trim()
