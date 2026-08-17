package com.tmuxifier.console.ui

// The session surface: a 1s-polled tmux snapshot rendered as native styled
// text. A full-screen TUI pane (alt-screen: Claude Code, vim) auto-FITS its
// column count to the screen width (pane/Fit.kt) so borders and layout render
// exactly as tmux drew them — soft-wrapping an 80-column frame at phone width
// shredded every border into stacked dashes. A TUI pane never wraps: pinching
// in zooms to a per-box persisted size and the pane pans horizontally at
// intact layout (the ⤢ fit chip returns to auto-fit). Plain shell panes keep
// the larger soft-wrapped text at the Settings size. INERT TO TOUCH by design: the pane composables carry no click
// handlers wired to the API, so touches structurally have no path to the pty
// — scroll and select are the only gestures that do anything. The bottomBar
// slot hosts the action row and composer (later tasks).
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
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
import com.tmuxifier.console.keys.sendTextOf
import com.tmuxifier.console.pane.Span
import com.tmuxifier.console.pane.Style
import com.tmuxifier.console.pane.fitFontSp
import com.tmuxifier.console.pane.paneContentWidthPx
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
    var draft by remember(boxId) { mutableStateOf(state.prefs.draft(boxId)) }
    var sending by remember { mutableStateOf(false) }
    var fontSize by remember { mutableFloatStateOf(state.prefs.fontSize) }
    // A pinched TUI pane size sticks per box (null = follow auto-fit); the
    // ⤢ fit chip clears it back to auto.
    var manualSp by remember(boxId) { mutableStateOf(state.prefs.paneFont(boxId).takeIf { it > 0f }) }
    // Bumped after a wheel send: re-keys the poll effect so the next snapshot
    // is fetched immediately instead of up to 1s later.
    var refreshTick by remember { mutableIntStateOf(0) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current

    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(client, boxId, refreshTick) {
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

        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().background(SCREEN_BG)) {
            val (all, screenStart) = visibleWindow(lines, snap?.height ?: 0)
            val cursorLine = snap?.let { screenStart + it.cursorY }
            // Fit-to-width for full-screen TUIs: measure the monospace glyph
            // once (per density — the measurer is recreated on fold/unfold)
            // and size the font so the pane's whole column count spans the
            // screen. Null (plain shell, or pinched to manual) keeps the
            // preference size and soft-wrap.
            val measurer = rememberTextMeasurer()
            val glyphPerSp = remember(measurer) {
                measurer.measure(
                    AnnotatedString("0"),
                    TextStyle(fontFamily = FontFamily.Monospace, fontSize = 100.sp),
                ).size.width / 100f
            }
            val availPx = constraints.maxWidth - with(LocalDensity.current) { 12.dp.toPx() }
            val altPane = snap?.alt == true
            val fit = if (altPane && manualSp == null) {
                fitFontSp(availPx, snap?.width ?: 0, glyphPerSp)
            } else null
            val effSp = manualSp ?: fit?.sp ?: fontSize
            val altNow = rememberUpdatedState(altPane)
            val effSpNow = rememberUpdatedState(effSp)
            // A TUI pane NEVER soft-wraps — wrapping is what shredded Claude's
            // borders into stacked dashes. Fitted it spans the screen exactly;
            // zoomed in it pans horizontally at intact layout instead.
            val hScroll = rememberScrollState()
            LaunchedEffect(fit != null) { if (fit != null) hScroll.scrollTo(0) }
            val contentWidth = with(LocalDensity.current) {
                paneContentWidthPx(snap?.width ?: 0, glyphPerSp, effSp).toDp()
            }
            // includeFontPadding=false drops Android's extra first/last-line
            // padding so consecutive box-drawing rows sit close enough to read
            // as continuous borders; natural line metrics avoid glyph clipping.
            val paneStyle = TextStyle(
                fontFamily = FontFamily.Monospace,
                fontSize = effSp.sp,
                platformStyle = PlatformTextStyle(includeFontPadding = false),
            )
            SelectionContainer {
                Box(Modifier.fillMaxSize().then(if (altPane) Modifier.horizontalScroll(hScroll) else Modifier)) {
                    LazyColumn(
                        state = listState,
                        modifier = (if (altPane) Modifier.fillMaxHeight().width(contentWidth) else Modifier.fillMaxSize())
                            .pointerInput(Unit) {
                                detectTransformGestures { _, _, zoom, _ ->
                                    if (zoom != 1f) {
                                        if (altNow.value) {
                                            // Per-box persisted zoom, seeded from
                                            // the current size so the first pinch
                                            // continues smoothly from the fit.
                                            val next = (effSpNow.value * zoom).coerceIn(6f, 32f)
                                            manualSp = next
                                            state.prefs.setPaneFont(boxId, next)
                                        } else {
                                            fontSize = (fontSize * zoom).coerceIn(8f, 32f)
                                            state.prefs.fontSize = fontSize
                                        }
                                    }
                                }
                            }
                            .padding(horizontal = 6.dp),
                    ) {
                        itemsIndexed(all) { i, spans ->
                            Text(
                                annotated(spans, if (i == cursorLine) snap?.cursorX else null),
                                style = paneStyle,
                                color = DEFAULT_FG,
                                softWrap = !altPane,
                            )
                        }
                    }
                }
            }
            if (altPane && manualSp != null) {
                PaneChip("⤢ fit", Modifier.align(Alignment.TopEnd).padding(8.dp)) {
                    manualSp = null
                    state.prefs.clearPaneFont(boxId)
                }
            }
            if (listState.canScrollForward) {
                PaneChip("▼ latest", Modifier.align(Alignment.BottomEnd).padding(8.dp)) {
                    scope.launch { if (lines.isNotEmpty()) listState.scrollToItem(lines.size - 1) }
                }
            }
            // A mouse-aware pane app (Claude Code) keeps its own transcript;
            // the snapshot carries no scrollback for it (the server trims the
            // alt screen's stale shell history), so these scroll the app
            // itself via server-injected wheel events. Worded labels — a bare
            // arrow would blur into "▼ latest" one corner away.
            if (snap?.mouse == true) {
                val wheel: (String) -> Unit = { dir ->
                    scope.launch {
                        try {
                            client.sendWheel(boxId, dir)
                            refreshTick++ // fetch the scrolled screen now, not next second
                        } catch (e: ApiException) {
                            if (e.status == 401) onUnauthorized() else sendError = e.message
                        }
                    }
                }
                Column(
                    Modifier.align(Alignment.CenterEnd).padding(end = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    PaneChip("▲ older") { wheel("up") }
                    PaneChip("▼ newer") { wheel("down") }
                }
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
        ComposerBar(
            draft = draft,
            onDraft = { draft = it; state.prefs.setDraft(boxId, it) },
            busy = sending,
            onSend = {
                val text = sendTextOf(draft)
                sending = true
                scope.launch {
                    try {
                        if (text.isEmpty()) {
                            client.sendKey(boxId, "Enter")
                        } else {
                            client.sendText(boxId, text)
                            // The pane accepted the text: the draft's job is done
                            // even if the follow-up Enter fails (the row recovers).
                            draft = ""
                            state.prefs.setDraft(boxId, "")
                            try {
                                client.sendKey(boxId, "Enter")
                            } catch (e: ApiException) {
                                sendError = "sent — Enter failed, tap ⏎"
                            }
                        }
                    } catch (e: ApiException) {
                        // Send never destroys a draft the pane didn't accept.
                        if (e.status == 401) onUnauthorized() else sendError = e.message
                    } finally {
                        sending = false
                    }
                }
            },
        )
        bottomBar()
    }
}

/** Compact pill control overlaying the pane — clipped, translucent-backed so
 *  it reads as a button over any content rather than loose floating text. */
@Composable
private fun PaneChip(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = MaterialTheme.colorScheme.primary,
        style = MaterialTheme.typography.labelLarge,
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(Color(0xE61A212B))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
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
