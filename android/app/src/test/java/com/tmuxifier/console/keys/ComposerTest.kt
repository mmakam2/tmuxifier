package com.tmuxifier.console.keys

import kotlin.test.Test
import kotlin.test.assertEquals

class ComposerTest {
    @Test fun newlinesCollapseToSpaces() = assertEquals("a b c", sendTextOf("a\nb\n\nc"))
    @Test fun whitespaceRunsCollapse() = assertEquals("a b", sendTextOf("  a \t b  "))
    @Test fun controlsStripped() = assertEquals("ab", sendTextOf("a\u0007\u009Bb"))
    @Test fun emptyStaysEmpty() = assertEquals("", sendTextOf("   \n  "))
}
