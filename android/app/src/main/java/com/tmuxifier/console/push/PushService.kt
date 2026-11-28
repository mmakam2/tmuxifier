package com.tmuxifier.console.push

// FCM entry points. Server messages carry notification {title, body} plus
// data {boxId, kind, session} and, for an agent pane, {pane, windowId}
// (src/server/fcmPush.js; an older server sends neither of the last two).
// Foreground delivery lands here and we post the notification ourselves, one id
// per box and pane (notificationIdOf); background delivery is auto-posted by the
// system, which replaces by the tag the server sets, and the tap carries the data
// keys as launcher-intent extras. MainActivity reads the same keys in both paths,
// through pushTargetOf.
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
        val target = pushTargetOf(msg.data) ?: return
        val kind = msg.data["kind"] ?: ""
        showAgentNotification(
            this,
            target,
            msg.notification?.title ?: "tmuxifier",
            msg.notification?.body ?: kind,
        )
    }
}
