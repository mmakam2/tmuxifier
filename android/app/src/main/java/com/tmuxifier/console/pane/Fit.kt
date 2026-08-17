package com.tmuxifier.console.pane

import kotlin.math.floor

// Pure fit-to-width math for alt-screen panes: the font size (sp) at which
// `cols` monospace columns exactly span `availPx`. Floored to a 0.1sp step so
// rounding can never push the line past the available width, and clamped —
// `fits` is false when even the floor size can't hold the columns, which is
// the caller's cue to keep soft-wrap on instead of clipping.
data class FitResult(val sp: Float, val fits: Boolean)

fun fitFontSp(
    availPx: Float,
    cols: Int,
    glyphWidthPerSpPx: Float,
    minSp: Float = 6f,
    maxSp: Float = 32f,
): FitResult? {
    if (availPx <= 0f || cols <= 0 || glyphWidthPerSpPx <= 0f) return null
    val raw = availPx / (cols * glyphWidthPerSpPx)
    val floored = floor(raw * 10f) / 10f
    return FitResult(sp = floored.coerceIn(minSp, maxSp), fits = floored >= minSp)
}

// Width of an unwrapped TUI pane's content at a given size — what the
// horizontal pan container must hold. One extra column of slack: glyph
// advances are measured at one reference size and scaled, so per-size
// rounding must never be able to clip the last character.
fun paneContentWidthPx(cols: Int, glyphWidthPerSpPx: Float, sp: Float): Float =
    if (cols <= 0) 0f else (cols + 1) * glyphWidthPerSpPx * sp
