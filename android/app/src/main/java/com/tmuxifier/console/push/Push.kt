package com.tmuxifier.console.push

// Notification plumbing. pushAvailable() is the runtime half of the
// conditional-Firebase build: without google-services.json there is no
// FirebaseApp, and every push-related step quietly no-ops.
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.tmuxifier.console.MainActivity

const val CHANNEL_AGENT = "agent"

fun pushAvailable(context: Context): Boolean = try {
    FirebaseApp.getApps(context).isNotEmpty()
} catch (_: Throwable) {
    false
}

fun showAgentNotification(context: Context, boxId: String, title: String, body: String) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(
        NotificationChannel(CHANNEL_AGENT, "Agent events", NotificationManager.IMPORTANCE_HIGH),
    )
    val intent = Intent(context, MainActivity::class.java).apply {
        putExtra("boxId", boxId)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val pi = PendingIntent.getActivity(
        context, boxId.hashCode(), intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    // Notification id = boxId hash: a newer event for the same box replaces
    // the older one instead of stacking.
    val n = NotificationCompat.Builder(context, CHANNEL_AGENT)
        .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
        .setContentTitle(title)
        .setContentText(body)
        .setAutoCancel(true)
        .setContentIntent(pi)
        .build()
    // Without POST_NOTIFICATIONS (API 33+) this is a no-op; never a crash.
    runCatching { NotificationManagerCompat.from(context).notify(boxId.hashCode(), n) }
}
