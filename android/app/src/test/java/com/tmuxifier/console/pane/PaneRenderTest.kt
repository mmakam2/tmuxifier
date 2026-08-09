package com.tmuxifier.console.pane

import kotlin.test.Test
import kotlin.test.assertEquals

class PaneRenderTest {
    @Test fun screenStartIsContentMinusHeight() {
        val lines = parseSgr((1..30).joinToString("\n") { "line$it" })
        val (all, screenStart) = visibleWindow(lines, height = 24)
        assertEquals(30, all.size)
        assertEquals(6, screenStart)
    }

    @Test fun shortContentStartsAtZero() {
        val (_, screenStart) = visibleWindow(parseSgr("a\nb"), height = 24)
        assertEquals(0, screenStart)
    }
}
