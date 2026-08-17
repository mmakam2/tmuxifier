package com.tmuxifier.console.api

// Fixtures are REAL response shapes (see the plan's server-surface reference);
// unknown fields must be ignored — the server adds fields over time.
import kotlin.test.Test
import kotlin.test.assertEquals

class ModelsTest {
    @Test fun paneSnapshotParses() {
        val snap = ApiJson.decodeFromString(PaneSnapshot.serializer(),
            """{"ok":true,"width":80,"height":24,"cursorX":3,"cursorY":22,"content":"line1\nline2","agent":"waiting","sessionName":"main","extra":1}""")
        assertEquals(80, snap.width)
        assertEquals("waiting", snap.agent)
        assertEquals(22, snap.cursorY)
    }
    @Test fun paneSnapshotAltMouseParse() {
        // New servers flag alt-screen panes (content trimmed to the screen) and
        // mouse-aware panes (wheel scrolling available); an old server sends
        // neither and both must default off.
        val snap = ApiJson.decodeFromString(PaneSnapshot.serializer(),
            """{"ok":true,"width":80,"height":24,"cursorX":0,"cursorY":0,"alt":true,"mouse":true,"content":"x"}""")
        assertEquals(true, snap.alt)
        assertEquals(true, snap.mouse)
        val old = ApiJson.decodeFromString(PaneSnapshot.serializer(),
            """{"ok":true,"width":80,"height":24,"cursorX":0,"cursorY":0,"content":"x"}""")
        assertEquals(false, old.alt)
        assertEquals(false, old.mouse)
    }
    @Test fun statusMapParses() {
        val m = ApiJson.decodeFromString(statusMapSerializer,
            """{"b1":{"reachable":true,"metrics":{"cpus":4,"memTotalKb":8000000,"memAvailKb":2000000,"osId":"debian","osVer":"12"}},"b2":{"reachable":false,"error":"timeout"}}""")
        assertEquals(4, m["b1"]?.metrics?.cpus)
        assertEquals(false, m["b2"]?.reachable)
    }
    @Test fun seriesParses() {
        val s = ApiJson.decodeFromString(seriesMapSerializer,
            """{"b1":[{"t":1723180000000,"up":true,"agent":"working","agentPresent":true}]}""")
        assertEquals("working", s["b1"]?.last()?.agent)
        assertEquals(1723180000000L, s["b1"]?.last()?.t)
    }
    @Test fun fcmConfigParses() {
        val c = ApiJson.decodeFromString(FcmConfig.serializer(),
            """{"available":true,"projectId":"p","senderId":"42","applicationId":"1:42:android:x","apiKey":"AIza"}""")
        assertEquals("42", c.senderId)
        val off = ApiJson.decodeFromString(FcmConfig.serializer(), """{"available":false}""")
        assertEquals(false, off.available)
    }

    @Test fun enrollParses() {
        val e = ApiJson.decodeFromString(EnrollResponse.serializer(),
            """{"id":"abc123","name":"Fold","created":1,"lastSeen":null,"hasFcmToken":false,"notify":{"agent-input":true,"agent-done":true},"token":"tok"}""")
        assertEquals("tok", e.token)
        assertEquals(true, e.notify["agent-input"])
    }
}
