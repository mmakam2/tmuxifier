package com.tmuxifier.console.pane

// E is the ESC character via a Kotlin escape — never a raw byte in source
// (raw control bytes make git treat the file as binary and break plain grep).
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val E = "\u001B"

class SgrTest {
    @Test fun plainTextIsOneSpanPerLine() {
        val lines = parseSgr("hello\nworld")
        assertEquals(listOf("hello"), lines[0].map { it.text })
        assertEquals(Style(), lines[0][0].style)
        assertEquals("world", lines[1][0].text)
    }

    @Test fun boldAndReset() {
        val l = parseSgr("a$E[1mb$E[0mc")[0]
        assertEquals(listOf("a", "b", "c"), l.map { it.text })
        assertTrue(l[1].style.bold)
        assertFalse(l[2].style.bold)
    }

    @Test fun ansiAndBrightForeground() {
        val l = parseSgr("$E[31mred $E[91mbright")[0]
        assertEquals(SgrColor.Ansi(1), l[0].style.fg)
        assertEquals(SgrColor.Ansi(9), l[1].style.fg)
    }

    @Test fun palette256AndTruecolor() {
        val l = parseSgr("$E[38;5;208mx$E[48;2;10;20;30my")[0]
        assertEquals(SgrColor.Palette(208), l[0].style.fg)
        assertEquals(SgrColor.Rgb(10, 20, 30), l[1].style.bg)
    }

    @Test fun attributesToggleOff() {
        val l = parseSgr("$E[1;2;3;4;7ma$E[22;23;24;27mb")[0]
        val a = l[0].style
        assertTrue(a.bold && a.dim && a.italic && a.underline && a.inverse)
        assertEquals(Style(fg = a.fg, bg = a.bg), l[1].style)
    }

    @Test fun stateCarriesAcrossLines() {
        val lines = parseSgr("$E[32mgreen\nstill")
        assertEquals(SgrColor.Ansi(2), lines[1][0].style.fg)
    }

    @Test fun defaultColors39And49() {
        val l = parseSgr("$E[31;41mx$E[39;49my")[0]
        assertNull(l[1].style.fg)
        assertNull(l[1].style.bg)
    }

    @Test fun nonSgrSequencesAreStripped() {
        // capture-pane -e emits only SGR, but be defensive: CSI-not-m, OSC, charset
        val l = parseSgr("a$E[2Jb$E]0;title\u0007c$E(Bd")[0]
        assertEquals("abcd", l.joinToString("") { it.text })
    }

    @Test fun emptyParamsMeanReset() {
        val l = parseSgr("$E[1mx$E[my")[0]
        assertEquals(Style(), l[1].style)
    }

    @Test fun xtermColorMapsCubeAndGray() {
        assertEquals(0xFFFF8700L, xtermColor(SgrColor.Palette(208), false))
        assertEquals(0xFF080808L, xtermColor(SgrColor.Palette(232), false))
        assertEquals(0xFF0A141EL, xtermColor(SgrColor.Rgb(10, 20, 30), false))
    }

    @Test fun boldPromotesBaseAnsiColors() {
        assertEquals(xtermColor(SgrColor.Ansi(9), false), xtermColor(SgrColor.Ansi(1), true))
        // Bright colors stay themselves under bold.
        assertEquals(xtermColor(SgrColor.Ansi(9), false), xtermColor(SgrColor.Ansi(9), true))
    }
}
