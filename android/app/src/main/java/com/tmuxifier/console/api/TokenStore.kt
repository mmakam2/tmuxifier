package com.tmuxifier.console.api

// The device token is the app's only credential; it lives in
// EncryptedSharedPreferences backed by an Android Keystore master key, per the
// design spec. The base URL and device name ride along — not secrets, but they
// belong to the same "who am I signed into" record and clear() must drop all
// three together.
import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TokenStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "auth",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var baseUrl: String?
        get() = prefs.getString("baseUrl", null)
        set(v) { prefs.edit().putString("baseUrl", v).apply() }

    var token: String?
        get() = prefs.getString("token", null)
        set(v) { prefs.edit().putString("token", v).apply() }

    var deviceName: String?
        get() = prefs.getString("deviceName", null)
        set(v) { prefs.edit().putString("deviceName", v).apply() }

    fun clear() { prefs.edit().clear().apply() }
}
