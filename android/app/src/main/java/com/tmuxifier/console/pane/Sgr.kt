package com.tmuxifier.console.pane

// The app's only "terminal" code: turn `tmux capture-pane -e` output into
// styled spans. tmux is the emulator — there is no cursor addressing or
// scroll-region handling here, just SGR state carried across a line list.
// Anything that isn't SGR (CSI with another final byte, OSC, charset
// selection) is stripped defensively; capture-pane -e shouldn't emit it, but
// a stray sequence must never reach the screen as text.

sealed interface SgrColor {
    data class Ansi(val n: Int) : SgrColor        // 0–15
    data class Palette(val n: Int) : SgrColor     // 16–255 (256-color)
    data class Rgb(val r: Int, val g: Int, val b: Int) : SgrColor
}

data class Style(
    val fg: SgrColor? = null,
    val bg: SgrColor? = null,
    val bold: Boolean = false,
    val dim: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val inverse: Boolean = false,
)

data class Span(val text: String, val style: Style)

private const val ESC = '\u001B'
private const val BEL = '\u0007'

/** One inner list per line; SGR state carries across newlines. */
fun parseSgr(content: String): List<List<Span>> {
    val lines = mutableListOf<List<Span>>()
    var spans = mutableListOf<Span>()
    val text = StringBuilder()
    var style = Style()

    fun flushSpan() {
        if (text.isNotEmpty()) {
            spans.add(Span(text.toString(), style))
            text.clear()
        }
    }
    fun flushLine() {
        flushSpan()
        if (spans.isEmpty()) spans.add(Span("", style))
        lines.add(spans)
        spans = mutableListOf()
    }

    var i = 0
    while (i < content.length) {
        val c = content[i]
        when {
            c == '\n' -> { flushLine(); i++ }
            c == ESC -> {
                val next = content.getOrNull(i + 1)
                when (next) {
                    '[' -> {
                        // CSI: params up to a final byte (0x40–0x7E); only `m` is SGR.
                        var j = i + 2
                        while (j < content.length && content[j] !in '@'..'~') j++
                        if (j < content.length && content[j] == 'm') {
                            val applied = applySgr(style, content.substring(i + 2, j))
                            if (applied != style) { flushSpan(); style = applied }
                        }
                        i = j + 1
                    }
                    ']' -> {
                        // OSC: consume to BEL or ESC \ (ST).
                        var j = i + 2
                        while (j < content.length && content[j] != BEL &&
                            !(content[j] == ESC && content.getOrNull(j + 1) == '\\')
                        ) j++
                        i = if (j < content.length && content[j] == ESC) j + 2 else j + 1
                    }
                    null -> i++
                    '(', ')' -> i += 3 // charset designation is ESC ( B — three chars
                    else -> i += 2     // ESC =, ESC > and friends: ESC + one char
                }
            }
            else -> { text.append(c); i++ }
        }
    }
    flushLine()
    return lines
}

private fun applySgr(start: Style, params: String): Style {
    var s = start
    // Empty parameter string (ESC[m) means reset.
    val parts = if (params.isEmpty()) listOf(0) else params.split(';').map { it.toIntOrNull() ?: 0 }
    var i = 0
    while (i < parts.size) {
        when (val p = parts[i]) {
            0 -> s = Style()
            1 -> s = s.copy(bold = true)
            2 -> s = s.copy(dim = true)
            3 -> s = s.copy(italic = true)
            4 -> s = s.copy(underline = true)
            7 -> s = s.copy(inverse = true)
            22 -> s = s.copy(bold = false, dim = false)
            23 -> s = s.copy(italic = false)
            24 -> s = s.copy(underline = false)
            27 -> s = s.copy(inverse = false)
            in 30..37 -> s = s.copy(fg = SgrColor.Ansi(p - 30))
            39 -> s = s.copy(fg = null)
            in 40..47 -> s = s.copy(bg = SgrColor.Ansi(p - 40))
            49 -> s = s.copy(bg = null)
            in 90..97 -> s = s.copy(fg = SgrColor.Ansi(p - 90 + 8))
            in 100..107 -> s = s.copy(bg = SgrColor.Ansi(p - 100 + 8))
            38, 48 -> {
                val color = when (parts.getOrNull(i + 1)) {
                    5 -> parts.getOrNull(i + 2)?.let { n ->
                        i += 2
                        if (n < 16) SgrColor.Ansi(n) else SgrColor.Palette(n)
                    }
                    2 -> {
                        val r = parts.getOrNull(i + 2)
                        val g = parts.getOrNull(i + 3)
                        val b = parts.getOrNull(i + 4)
                        i += 4
                        if (r != null && g != null && b != null) SgrColor.Rgb(r, g, b) else null
                    }
                    else -> null
                }
                if (color != null) s = if (p == 38) s.copy(fg = color) else s.copy(bg = color)
            }
        }
        i++
    }
    return s
}

// Standard xterm 16-color palette.
private val ANSI16 = longArrayOf(
    0xFF000000, 0xFFCD0000, 0xFF00CD00, 0xFFCDCD00, 0xFF0000EE, 0xFFCD00CD, 0xFF00CDCD, 0xFFE5E5E5,
    0xFF7F7F7F, 0xFFFF0000, 0xFF00FF00, 0xFFFFFF00, 0xFF5C5CFF, 0xFFFF00FF, 0xFF00FFFF, 0xFFFFFFFF,
)
private val CUBE = intArrayOf(0, 95, 135, 175, 215, 255)

/** 0xAARRGGBB. Bold promotes ANSI 0–7 to their bright counterparts. */
fun xtermColor(c: SgrColor, bold: Boolean): Long = when (c) {
    is SgrColor.Ansi -> {
        val n = if (bold && c.n < 8) c.n + 8 else c.n
        ANSI16[n.coerceIn(0, 15)]
    }
    is SgrColor.Palette -> when {
        c.n in 16..231 -> {
            val idx = c.n - 16
            val r = CUBE[idx / 36]
            val g = CUBE[(idx / 6) % 6]
            val b = CUBE[idx % 6]
            argb(r, g, b)
        }
        c.n in 232..255 -> {
            val v = 8 + 10 * (c.n - 232)
            argb(v, v, v)
        }
        else -> ANSI16[c.n.coerceIn(0, 15)]
    }
    is SgrColor.Rgb -> argb(c.r.coerceIn(0, 255), c.g.coerceIn(0, 255), c.b.coerceIn(0, 255))
}

private fun argb(r: Int, g: Int, b: Int): Long =
    0xFF000000L or (r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong()
