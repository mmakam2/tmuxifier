package com.tmuxifier.console

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.google.firebase.messaging.FirebaseMessaging
import com.tmuxifier.console.agent.JumpNotice
import com.tmuxifier.console.agent.JumpTarget
import com.tmuxifier.console.agent.jumpMayLand
import com.tmuxifier.console.agent.jumpNotice
import com.tmuxifier.console.agent.planJump
import com.tmuxifier.console.agent.runJump
import com.tmuxifier.console.agent.targetListed
import com.tmuxifier.console.api.ApiClient
import com.tmuxifier.console.api.ApiException
import com.tmuxifier.console.push.PushTarget
import com.tmuxifier.console.push.initFirebase
import com.tmuxifier.console.push.pushTargetOf
import com.tmuxifier.console.ui.FleetScreen
import com.tmuxifier.console.ui.SessionScreen
import com.tmuxifier.console.ui.SettingsScreen
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

// Screen survives process death as a string — no navigation library for a
// three-screen app.
val ScreenSaver = Saver<Screen, String>(
    save = {
        when (it) {
            Screen.Fleet -> "fleet"
            Screen.Settings -> "settings"
            is Screen.Session -> "session:${it.boxId}:${it.boxLabel}"
        }
    },
    restore = { raw ->
        when {
            raw == "settings" -> Screen.Settings
            raw.startsWith("session:") -> {
                val parts = raw.removePrefix("session:").split(":", limit = 2)
                Screen.Session(parts[0], parts.getOrElse(1) { parts[0] })
            }
            else -> Screen.Fleet
        }
    },
)

class MainActivity : ComponentActivity() {
    // A push tap lands here: the notification intent (foreground path) and the
    // system-posted notification (background path) both carry the FCM data keys
    // as extras. The activity is exported, so any app can send them: they are
    // read only through the pure pushTargetOf, which checks every value.
    private val pendingPush = mutableStateOf<PushTarget?>(null)
    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* optional — push just stays silent if denied */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Canonical inset handling: explicit edge-to-edge so the window
        // dispatches real inset values, consumed by safeDrawingPadding on the
        // root (bars + cutout + IME — the keyboard resizes the layout). The
        // brief windowOptOutEdgeToEdgeEnforcement detour is gone: One UI can
        // overlay-draw its 3-button nav bar regardless, so padding from
        // dispatched insets is the only approach that covers it.
        enableEdgeToEdge()
        val state = AppState(applicationContext)
        // Only a fresh launch reads its intent. The activity keeps its launch
        // intent across a recreation (fold, rotation: savedInstanceState is set)
        // and a reopen from recents (LAUNCHED_FROM_HISTORY); without this guard
        // each of those would run the push's jump again.
        val fresh = savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
        if (fresh) pendingPush.value = pushTargetFrom(intent)
        if (state.enrolled) {
            maybeAskNotifications()
            syncFcmToken(state)
        }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    // targetSdk 35 forces edge-to-edge: without this, the
                    // composer sits under the gesture-nav zone (taps eaten,
                    // keyboard never summoned) and the IME covers the bottom
                    // bar instead of lifting it. safeDrawing = bars + cutout
                    // + ime, so the keyboard resizes the layout too.
                    Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                        // onEnrolled side effects run HERE too, not only in
                        // onCreate: a fresh install enrolls mid-session, and
                        // gating permission+token-sync on cold-start left the
                        // new server row with no FCM token (observed live —
                        // zero push targets after an uninstall/re-pair).
                        Shell(state, pendingPush, onEnrolledSideEffects = {
                            maybeAskNotifications()
                            syncFcmToken(state)
                        })
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pendingPush.value = pushTargetFrom(intent)
    }

    // An extras bundle another app built may not even unparcel (a class this app
    // does not have): that is no push, never a crash.
    private fun pushTargetFrom(intent: Intent?): PushTarget? {
        val extras = intent ?: return null
        return runCatching {
            pushTargetOf(listOf("boxId", "session", "windowId", "pane").associateWith { extras.getStringExtra(it) })
        }.getOrNull()
    }

    private fun maybeAskNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // Fetch the operator's Firebase client config from THEIR server, persist
    // it, (re)initialize Firebase from it, then sync the registration token.
    // Nothing is baked into the APK — a server with no TMUXIFIER_FCM_APP_CONFIG
    // simply has no push, and everything else works.
    private fun syncFcmToken(state: AppState) {
        val client = state.client() ?: return
        val appCtx = applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            val cfg = runCatching { client.fcmConfig() }.getOrNull()
            if (cfg?.available == true) {
                val json = com.tmuxifier.console.api.ApiJson.encodeToString(
                    com.tmuxifier.console.api.FcmConfig.serializer(), cfg,
                )
                if (json != state.prefs.fcmClientConfig) {
                    state.prefs.fcmClientConfig = json
                    state.prefs.fcmSynced = null // possibly a new project — re-sync the token
                }
            }
            if (!initFirebase(appCtx, state.prefs.fcmClientConfig)) return@launch
            FirebaseMessaging.getInstance().token.addOnSuccessListener { t ->
                if (t.isNullOrEmpty() || t == state.prefs.fcmSynced) return@addOnSuccessListener
                CoroutineScope(Dispatchers.IO).launch {
                    runCatching { client.updateSelf(fcmToken = t) }
                        .onSuccess { state.prefs.fcmSynced = t }
                }
            }
        }
    }
}

@Composable
private fun Shell(
    state: AppState,
    pendingPush: MutableState<PushTarget?>,
    onEnrolledSideEffects: () -> Unit,
) {
    var screen by rememberSaveable(stateSaver = ScreenSaver) {
        mutableStateOf(if (state.enrolled) Screen.Fleet else Screen.Settings)
    }
    // A jump to one agent pane in flight (row taps take no second one while it
    // runs), and the line the session screen shows for four seconds when it did not
    // land: an event, so the same text twice (or for two boxes) shows each time.
    var jumping by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<JumpNotice?>(null) }
    // The generation of the latest jump or push open, bumped as each one starts
    // (startJump, openNow). A running jump whose generation is no longer the latest
    // was overtaken by a later one and does not land; whichever started later wins.
    // It doubles as the notice's sequence number: only the latest generation lands.
    var jumpGen by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()

    fun startJump(): Int {
        jumpGen += 1
        jumping = true
        return jumpGen
    }

    // Only the latest jump clears `jumping`: an overtaken one finishing first must
    // not re-enable the rows while the later one still runs.
    fun endJump(gen: Int) {
        if (gen == jumpGen) jumping = false
    }

    // An open that needs no request (a card tap, a push with no pane): it lands at
    // once and overtakes a running jump, which then does not land even if the
    // operator comes back to the screen it started from.
    fun openNow(to: Screen) {
        jumpGen += 1
        jumping = false // the overtaken jump's endJump no longer matches
        notice = null   // a notice left from an earlier jump is not about this open
        screen = to
    }

    // Every jump and push open that made a request lands through here, and only
    // where the operator still is (jumpMayLand): still the latest one started, on
    // the screen it started from, with the client it started with. Otherwise
    // neither the screen nor the notice changes.
    fun land(gen: Int, startedOn: Screen, client: ApiClient, to: Screen, failed: String? = null) {
        if (!jumpMayLand(gen, jumpGen, startedOn, screen, client == state.client())) return
        notice = jumpNotice(failed, gen)
        screen = to
    }

    // The one jump: repoint the box when the pane is in another session, select its
    // window and pane, then open the session screen. The screen opens after a
    // failure too (the operator asked for this box), with the reason as its notice.
    // Nothing is rolled back: a repoint that succeeded before the select failed
    // leaves the box on the target's session, which is what the opened screen then
    // shows. A 401 from any step is the revoked-device path, as everywhere else.
    suspend fun jumpAndLand(
        gen: Int, startedOn: Screen, client: ApiClient,
        boxId: String, label: String, configuredSession: String, target: JumpTarget,
    ) {
        val failed = try {
            runJump(
                planJump(configuredSession, target),
                setSession = { client.setSession(boxId, it) },
                selectPane = { s, w, p -> client.selectWindow(boxId, s, w, p) },
            )
        } catch (e: ApiException) {               // runJump rethrows only a 401
            land(gen, startedOn, client, Screen.Settings)
            return
        }
        land(gen, startedOn, client, Screen.Session(boxId, label), failed)
    }

    // A row tap on the fleet list.
    fun openAgent(boxId: String, label: String, configuredSession: String, target: JumpTarget) {
        val client = state.client() ?: return
        if (jumping) return                       // one jump at a time; a second tap is dropped
        val startedOn = screen
        val gen = startJump()
        scope.launch {
            try {
                jumpAndLand(gen, startedOn, client, boxId, label, configuredSession, target)
            } finally {
                endJump(gen)
            }
        }
    }

    // A tapped push that names an agent pane: the same jump, from fresh data. The
    // push may be old, so the box and its status are fetched first, and the box is
    // never repointed at a session (or a window) the server no longer lists: then
    // it opens on whatever it points at now, with no notice. When the box cannot
    // be read, or is gone from the list, it opens as an older server's push does.
    // A tap can come over any screen and while a row's jump runs: it starts a jump
    // of its own (which overtakes that one), and lands only on the screen it was
    // tapped over, with the same client.
    fun openFromPush(boxId: String, target: JumpTarget) {
        val client = state.client()
        if (client == null) {
            openNow(Screen.Session(boxId, boxId))
            return
        }
        val startedOn = screen
        val gen = startJump()
        scope.launch {
            try {
                val fetched = try {
                    coroutineScope {
                        val boxes = async { client.boxes() }
                        val status = async { client.status() }
                        boxes.await() to status.await()
                    }
                } catch (e: ApiException) {
                    if (e.status == 401) {
                        land(gen, startedOn, client, Screen.Settings)
                        return@launch
                    }
                    null
                }
                val box = fetched?.first?.firstOrNull { it.id == boxId }
                if (fetched == null || box == null) {
                    land(gen, startedOn, client, Screen.Session(boxId, boxId))
                    return@launch
                }
                val label = box.label.ifEmpty { box.id }
                if (!targetListed(fetched.second[boxId], target)) {
                    land(gen, startedOn, client, Screen.Session(boxId, label))
                    return@launch
                }
                jumpAndLand(gen, startedOn, client, boxId, label, box.sessionName, target)
            } finally {
                endJump(gen)
            }
        }
    }

    // Notification tap-through. A push with no agent pane (an older server's, or
    // an older event's) opens that box's session at once; one with a pane jumps to
    // it. Either overtakes a jump that is still running.
    LaunchedEffect(pendingPush.value) {
        val push = pendingPush.value ?: return@LaunchedEffect
        pendingPush.value = null // re-keys and cancels this effect: nothing below may suspend
        if (!state.enrolled) return@LaunchedEffect
        val target = push.jump
        if (target == null) {
            openNow(Screen.Session(push.boxId, push.boxId))
        } else {
            openFromPush(push.boxId, target) // launches on `scope`, which outlives this effect
        }
    }
    BackHandler(enabled = state.enrolled && screen != Screen.Fleet) { screen = Screen.Fleet }
    when (screen) {
        Screen.Settings -> SettingsScreen(
            state,
            onEnrolled = {
                onEnrolledSideEffects()
                screen = Screen.Fleet
            },
            onSignedOut = { /* stay on Settings, now in enroll mode */ },
        )
        Screen.Fleet -> FleetScreen(
            state,
            onOpen = { openNow(it) },
            onOpenAgent = ::openAgent,
            opening = jumping,
            onSettings = { screen = Screen.Settings },
            onUnauthorized = { screen = Screen.Settings },
        )
        is Screen.Session -> {
            val s = screen as Screen.Session
            SessionScreen(
                state,
                boxId = s.boxId,
                boxLabel = s.boxLabel,
                onUnauthorized = { screen = Screen.Settings },
                notice = notice,
            )
        }
    }
}
