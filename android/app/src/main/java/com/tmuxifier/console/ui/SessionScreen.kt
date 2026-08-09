package com.tmuxifier.console.ui

// The session surface: a 1s-polled tmux snapshot rendered as native styled
// text. Soft-wrapped at the chosen font size — never shrunk to fit 80
// columns. INERT TO TOUCH by design: the pane composables carry no click
// handlers wired to the API, so touches structurally have no path to the pty
// — scroll and select are the only gestures that do anything. The bottomBar
// slot hosts the action row and composer (later tasks).
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.tmuxifier.console.AppState
import com.tmuxifier.console.api.ApiException
import com.tmuxifier.console.api.PaneSnapshot
import com.tmuxifier.console.keys.SendSpec
import com.tmuxifier.console.pane.Span
import com.tmuxifier.console.pane.Style
import com.tmuxifier.console.pane.parseSgr
import com.tmuxifier.console.pane.visibleWindow
import com.tmuxifier.console.pane.xtermColor
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val SCREEN_BG = Color(0xFF10141A)
private val DEFAULT_FG = Color(0xFFE5E5E5)
private val CURSOR_BG = Color(0x80FFB300)

@Composable
fun SessionScreen(
    state: AppState,
    boxId: String,
    boxLabel: String,
    onUnauthorized: () -> Unit,
    bottomBar: @Composable () -> Unit = {},
) {
    val client = state.client() ?: return
    var snap by remember { mutableStateOf<PaneSnapshot?>(null) }
    var lines by remember { mutableStateOf<List<List<Span>>>(emptyList()) }
    var reconnecting by remember { mutableStateOf(false) }
    var sendError by remember { mutableStateOf<String?>(null) }
    var fontSize by remember { mutableFloatStateOf(state.prefs.fontSize) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current

    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(client, boxId) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                try {
                    val s = client.pane(boxId)
                    // Stick to the bottom when the viewer was already there;
                    // a scrolled-back reader stays put.
                    val stick = !listState.canScrollForward
                    snap = s
                    lines = parseSgr(s.content)
                    reconnecting = false
                    if (stick && lines.isNotEmpty()) {
                        runCatching { listState.scrollToItem(lines.size - 1) }
                    }
                } catch (e: ApiException) {
                    if (e.status == 401) { onUnauthorized(); return@repeatOnLifecycle }
                    reconnecting = true
                }
                delay(1_000)
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        // Header: label + agent chip + open-in-browser. The Reconnect-style
        // actions live on the web; this header is read-only.
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(boxLabel, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            snap?.agent?.let { agent ->
                val fg = if (agent == "waiting") Color(0xFFFFB300) else Color(0xFF4CAF50)
                Text(
                    agent,
                    color = fg,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier
                        .background(fg.copy(alpha = 0.2f), RoundedCornerShape(6.dp))
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                )
            }
            TextButton(onClick = { state.store.baseUrl?.let { uriHandler.openUri(it) } }) { Text("browser") }
        }
        if (reconnecting) {
            Text(
                "reconnecting…",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        }

        Box(Modifier.weight(1f).fillMaxWidth().background(SCREEN_BG)) {
            val (all, screenStart) = visibleWindow(lines, snap?.height ?: 0)
            val cursorLine = snap?.let { screenStart + it.cursorY }
            SelectionContainer {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) {
                            detectTransformGestures { _, _, zoom, _ ->
                                if (zoom != 1f) {
                                    fontSize = (fontSize * zoom).coerceIn(8f, 32f)
                                    state.prefs.fontSize = fontSize
                                }
                            }
                        }
                        .padding(horizontal = 6.dp),
                ) {
                    itemsIndexed(all) { i, spans ->
                        Text(
                            annotated(spans, if (i == cursorLine) snap?.cursorX else null),
                            fontFamily = FontFamily.Monospace,
                            fontSize = fontSize.sp,
                            color = DEFAULT_FG,
                            softWrap = true,
                        )
                    }
                }
            }
            if (listState.canScrollForward) {
                TextButton(
                    onClick = { scope.launch { if (lines.isNotEmpty()) listState.scrollToItem(lines.size - 1) } },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp),
                ) { Text("▼ latest") }
            }
        }

        sendError?.let { msg ->
            Text(
                msg,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            LaunchedEffect(msg) {
                delay(4_000)
                sendError = null
            }
        }
        ActionRow(onSend = { spec ->
            scope.launch {
                try {
                    when (spec) {
                        is SendSpec.Named -> client.sendKey(boxId, spec.key)
                        is SendSpec.Text -> client.sendText(boxId, spec.text)
                    }
                } catch (e: ApiException) {
                    if (e.status == 401) onUnauthorized() else sendError = e.message
                }
            }
        })
        bottomBar()
    }
}

/** Spans → styled text; the cursor column gets a background overlay. */
private fun annotated(spans: List<Span>, cursorX: Int?): AnnotatedString = buildAnnotatedString {
    for (span in spans) {
        val st = span.style
        val fgColor = st.fg?.let { Color(xtermColor(it, st.bold).toInt()) } ?: DEFAULT_FG
        val bgColor = st.bg?.let { Color(xtermColor(it, false).toInt()) }
        val fg = if (st.inverse) (bgColor ?: SCREEN_BG) else fgColor
        val bg = if (st.inverse) fgColor else bgColor
        pushStyle(
            SpanStyle(
                color = if (st.dim) fg.copy(alpha = 0.6f) else fg,
                background = bg ?: Color.Unspecified,
                fontWeight = if (st.bold) FontWeight.Bold else null,
                fontStyle = if (st.italic) FontStyle.Italic else null,
                textDecoration = if (st.underline) TextDecoration.Underline else null,
            ),
        )
        append(span.text)
        pop()
    }
    if (cursorX != null) {
        while (length <= cursorX) append(' ')
        addStyle(SpanStyle(background = CURSOR_BG), cursorX, cursorX + 1)
    }
}
