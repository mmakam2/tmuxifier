package com.tmuxifier.console.api

/** Normalize what the operator typed into a base URL, or null if unusable.
 *  Scheme-less means https (the live server is behind TLS); explicit http is
 *  kept for LAN/dev. Trailing slash stripped so path-joins stay simple. */
fun normalizeBaseUrl(raw: String): String? {
    val t = raw.trim()
    if (t.isEmpty() || t.any { it.isWhitespace() }) return null
    val url = when {
        t.startsWith("https://") || t.startsWith("http://") -> t
        t.contains("://") -> return null
        else -> "https://" + t
    }.trimEnd('/')
    // A bare scheme ("https://") trims to no host at all — refuse it.
    val host = url.substringAfter("://", "")
    return if (host.isNotEmpty() && !host.contains('/')) url else null
}
