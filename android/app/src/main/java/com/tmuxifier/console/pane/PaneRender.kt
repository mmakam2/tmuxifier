package com.tmuxifier.console.pane

// Pure geometry: capture-pane content is scrollback + visible screen; the
// screen is the LAST `height` lines and cursorY is relative to it.
fun visibleWindow(lines: List<List<Span>>, height: Int): Pair<List<List<Span>>, Int> =
    lines to (lines.size - height).coerceAtLeast(0)
