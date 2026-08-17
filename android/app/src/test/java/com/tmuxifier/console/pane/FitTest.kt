package com.tmuxifier.console.pane

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class FitTest {
    // A 1080px-wide pane, 80 columns, glyph 6px per sp: raw = 1080/480 = 2.25sp
    // — below the floor, so it clamps to min and reports it does NOT fit
    // (caller keeps soft-wrap on as the fallback).
    @Test fun clampsToMinAndReportsUnfit() {
        val r = fitFontSp(availPx = 1080f, cols = 80, glyphWidthPerSpPx = 6f)!!
        assertEquals(6f, r.sp)
        assertEquals(false, r.fits)
    }

    // 2000px, 80 cols, 2px/sp glyph: raw = 12.5sp → floored to a 0.1 step,
    // inside the clamp, fits.
    @Test fun fitsInsideRange() {
        val r = fitFontSp(availPx = 2000f, cols = 80, glyphWidthPerSpPx = 2f)!!
        assertEquals(12.5f, r.sp)
        assertEquals(true, r.fits)
    }

    // Flooring guards rounding: 999px over 80 cols at 1px/sp is 12.4875 —
    // never round UP past what actually fits.
    @Test fun floorsToTenthSp() {
        val r = fitFontSp(availPx = 999f, cols = 80, glyphWidthPerSpPx = 1f)!!
        assertEquals(12.4f, r.sp)
        assertEquals(true, r.fits)
    }

    // A huge screen over few columns clamps to the ceiling — still "fits".
    @Test fun clampsToMax() {
        val r = fitFontSp(availPx = 10000f, cols = 10, glyphWidthPerSpPx = 2f)!!
        assertEquals(32f, r.sp)
        assertEquals(true, r.fits)
    }

    // Degenerate geometry (no snapshot yet, zero-width pane) yields null so
    // the caller keeps the manual font size.
    @Test fun degenerateInputsAreNull() {
        assertNull(fitFontSp(availPx = 0f, cols = 80, glyphWidthPerSpPx = 6f))
        assertNull(fitFontSp(availPx = 1000f, cols = 0, glyphWidthPerSpPx = 6f))
        assertNull(fitFontSp(availPx = 1000f, cols = 80, glyphWidthPerSpPx = 0f))
    }
}
