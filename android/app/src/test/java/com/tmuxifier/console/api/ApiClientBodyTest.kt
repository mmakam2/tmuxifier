package com.tmuxifier.console.api

// The one unit-testable part of the HTTP layer: body shaping. There is no
// MockWebServer in this module, so the calls themselves are device-validated.
import kotlin.test.Test
import kotlin.test.assertEquals

class ApiClientBodyTest {
    @Test fun sessionKillOmitsWindowIdEntirely() {
        // POST /api/boxes/:id/kill branches on the PRESENCE of windowId; an
        // explicit null reads as present-and-invalid and 400s.
        assertEquals("""{"session":"web"}""", killBody("web", null))
    }

    @Test fun windowKillCarriesBothHalves() {
        // Always session-qualified: a grouped session shares window objects, so
        // a bare @3 names two windows and tmux picks whichever it finds first.
        assertEquals("""{"session":"web","windowId":"@3"}""", killBody("web", "@3"))
    }
}
