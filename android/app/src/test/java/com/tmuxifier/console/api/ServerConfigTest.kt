package com.tmuxifier.console.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ServerConfigTest {
    @Test fun schemeLessGetsHttps() = assertEquals("https://tmuxifier.example.com", normalizeBaseUrl(" tmuxifier.example.com "))
    @Test fun httpKeptForLan() = assertEquals("http://192.168.1.10:7437", normalizeBaseUrl("http://192.168.1.10:7437/"))
    @Test fun trailingSlashStripped() = assertEquals("https://x.example.com", normalizeBaseUrl("https://x.example.com/"))
    @Test fun garbageIsNull() {
        assertNull(normalizeBaseUrl(""))
        assertNull(normalizeBaseUrl("ht tp://x"))
        assertNull(normalizeBaseUrl("ftp://x.example.com"))
        assertNull(normalizeBaseUrl("https://"))
    }
}
