package com.tmuxifier.console.push

// FCM entry points. Server messages carry notification {title, body} plus
// data {boxId, kind} (src/server/fcmPush.js). Foreground delivery lands here
// and we post the notification ourselves; background delivery is auto-posted
// by the system and the tap carries the data keys as launcher-intent extras —
// MainActivity reads the same "boxId" in both paths.
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.tmuxifier.console.AppState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // Token rotation: best-effort PATCH; unenrolled devices have nothing
        // to update and the next enrollment carries the token anyway.
        val state = AppState(applicationContext)
        val client = state.client() ?: return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { client.updateSelf(fcmToken = token) }
                .onSuccess { state.prefs.fcmSynced = token }
        }
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val boxId = msg.data["boxId"] ?: return
        val kind = msg.data["kind"] ?: ""
        showAgentNotification(
            this,
            boxId,
            msg.notification?.title ?: "Tmuxifier",
            msg.notification?.body ?: kind,
        )
    }
}
