package com.tmuxifier.console.push

// Notification plumbing. pushAvailable() is the runtime half of the
// conditional-Firebase build: without google-services.json there is no
// FirebaseApp, and every push-related step quietly no-ops. The app posts a
// notification itself only in the foreground (PushService); it is one per box
// and agent pane, and its tap carries the push's data keys as extras.
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.tmuxifier.console.MainActivity
import com.tmuxifier.console.api.ApiJson
import com.tmuxifier.console.api.FcmConfig

const val CHANNEL_AGENT = "agent"

fun pushAvailable(context: Context): Boolean = try {
    FirebaseApp.getApps(context).isNotEmpty()
} catch (_: Throwable) {
    false
}

/** Initialize (or re-initialize) Firebase from the server-fetched client
 *  config JSON. Returns whether a usable FirebaseApp exists afterwards.
 *  Nothing is baked into the APK — no config from the server, no push. */
fun initFirebase(context: Context, cfgJson: String?): Boolean {
    if (cfgJson == null) return pushAvailable(context)
    return try {
        val cfg = ApiJson.decodeFromString(FcmConfig.serializer(), cfgJson)
        val projectId = cfg.projectId ?: return false
        val appId = cfg.applicationId ?: return false
        val apiKey = cfg.apiKey ?: return false
        val senderId = cfg.senderId ?: return false
        val existing = FirebaseApp.getApps(context).firstOrNull()
        if (existing != null) {
            if (existing.options.applicationId == appId) return true
            existing.delete() // server switched Firebase projects — rare, legal
        }
        FirebaseApp.initializeApp(
            context,
            FirebaseOptions.Builder()
                .setProjectId(projectId)
                .setApplicationId(appId)
                .setApiKey(apiKey)
                .setGcmSenderId(senderId)
                .build(),
        )
        true
    } catch (_: Throwable) {
        false
    }
}

fun showAgentNotification(context: Context, target: PushTarget, title: String, body: String) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(
        NotificationChannel(CHANNEL_AGENT, "Agent events", NotificationManager.IMPORTANCE_HIGH),
    )
    // The tap carries the same keys as the FCM data, so MainActivity reads one set
    // of extras whether this notification or the system's was tapped.
    val intent = Intent(context, MainActivity::class.java).apply {
        putExtra("boxId", target.boxId)
        target.jump?.let {
            putExtra("session", it.session)
            putExtra("windowId", it.windowId)
            putExtra("pane", it.pane)
        }
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    // One id per box and agent pane (the box's own for a push with no pane): a
    // newer event of the same agent replaces its notification, two agents on one
    // box keep one each. The id is the PendingIntent's request code too: two
    // PendingIntents that differ only in extras are one, and FLAG_UPDATE_CURRENT
    // would point both notifications at the newer agent.
    val id = notificationIdOf(target.boxId, target.jump?.pane)
    val pi = PendingIntent.getActivity(
        context, id, intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val n = NotificationCompat.Builder(context, CHANNEL_AGENT)
        .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
        .setContentTitle(title)
        .setContentText(body)
        .setAutoCancel(true)
        .setContentIntent(pi)
        .build()
    // Without POST_NOTIFICATIONS (API 33+) this is a no-op; never a crash.
    runCatching { NotificationManagerCompat.from(context).notify(id, n) }
}
