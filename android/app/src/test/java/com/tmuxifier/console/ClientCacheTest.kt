package com.tmuxifier.console

import com.tmuxifier.console.api.ApiClient
import com.tmuxifier.console.api.defaultHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertSame

class ClientCacheTest {
    @Test fun apiClientSharesOneOkHttpPoolAndComparesByCredentials() {
        val first = ApiClient("https://box.example.com", "tok-1")
        val second = ApiClient("https://box.example.com", "tok-1")
        val rotated = ApiClient("https://box.example.com", "tok-2")
        val unauthed = ApiClient("https://box.example.com", null)

        assertSame(defaultHttpClient, first.http)
        assertSame(first.http, second.http)
        assertSame(first.http, unauthed.http)
        assertEquals(first, second)
        assertEquals(first.hashCode(), second.hashCode())
        assertNotEquals(first, rotated)
        assertNotEquals(first, unauthed)
    }

    @Test fun clientCacheReusesExactInstanceAcrossRecompositionsUntilRotatedOrCleared() {
        var builds = 0
        val cache = ClientCache { url, token ->
            builds += 1
            ApiClient(url, token)
        }

        assertNull(cache.get(null, "tok-1"))
        assertNull(cache.get("https://box.example.com", null))
        assertEquals(0, builds)

        val c1 = cache.get("https://box.example.com", "tok-1")!!
        val c2 = cache.get("https://box.example.com", "tok-1")!!
        assertSame(c1, c2)
        assertEquals(1, builds)

        val rotatedToken = cache.get("https://box.example.com", "tok-2")!!
        assertNotSame(c1, rotatedToken)
        assertEquals(2, builds)

        val rotatedUrl = cache.get("https://other.example.com", "tok-2")!!
        assertNotSame(rotatedToken, rotatedUrl)
        assertEquals(3, builds)

        cache.clear()
        val rebuilt = cache.get("https://other.example.com", "tok-2")!!
        assertNotSame(rotatedUrl, rebuilt)
        assertEquals(4, builds)

        assertNull(cache.get(null, null))
        val afterNull = cache.get("https://other.example.com", "tok-2")!!
        assertNotSame(rebuilt, afterNull)
        assertEquals(5, builds)
    }
}
