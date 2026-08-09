package com.tmuxifier.console.keys

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ArmingTest {
    @Test fun plainKeyFiresImmediately() {
        val (s, fire) = armReduce(ArmState(), "Enter", armable = false)
        assertNull(s.armed)
        assertEquals("Enter", fire)
    }

    @Test fun armableArmsThenFires() {
        val (s1, f1) = armReduce(ArmState(), "C-c", armable = true)
        assertEquals("C-c", s1.armed)
        assertNull(f1)
        val (s2, f2) = armReduce(s1, "C-c", armable = true)
        assertNull(s2.armed)
        assertEquals("C-c", f2)
    }

    @Test fun anythingElseDisarmsAndFiresItself() {
        val (s1, _) = armReduce(ArmState(), "C-c", armable = true)
        val (s2, f2) = armReduce(s1, "Enter", armable = false)
        assertNull(s2.armed)
        assertEquals("Enter", f2)
    }

    @Test fun catalogSendsDigitsAsTextNotNamedKeys() {
        // Server NAMED_KEYS has no digits/y/n — they must go as {text}.
        val one = ACTION_KEYS.first { it.label == "1" }
        assertEquals(SendSpec.Text("1"), one.send)
        val esc = ACTION_KEYS.first { it.label == "Esc" }
        assertEquals(SendSpec.Named("Escape"), esc.send)
        val interrupt = ACTION_KEYS.first { it.label == "^C" }
        assertEquals(SendSpec.Named("C-c"), interrupt.send)
        assertEquals(true, interrupt.armed)
    }
}
