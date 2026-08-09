package com.tmuxifier.console

import android.app.Application
import com.tmuxifier.console.push.initFirebase

class TmuxifierApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Firebase comes up from the persisted server-fetched config, at
        // process start: FCM can wake a dead process to deliver a message,
        // and PushService needs an initialized FirebaseApp when it does.
        initFirebase(this, Prefs(this).fcmClientConfig)
    }
}
