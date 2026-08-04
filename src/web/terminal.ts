import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { reconnectDelay } from './reconnect';
import { clipboardActionForKey, writeClipboard, readClipboard, parseOsc52, type ClipboardDeps } from './clipboard';
import { buildFontFamily, clampFontSize, DEFAULT_TERM_FONT_SIZE } from './termFont';
import { api } from './api';
import { filesFromDataTransfer, uploadName, sizeError, termSafe } from './upload';
import { wireVoice, createVoiceHotkeyHandler, type VoiceHotkeyTarget } from './voiceUi';
import { createTouchGesture, HOLD_MS, type GestureAction } from './touchGesture';
import type { PaneConn } from './paneHeader';

// Phone mode raises the terminal font two steps for touch legibility. Checked
// once per openTerminal call: a mid-session flip across the breakpoint keeps
// the open terminal's size (accepted in the phone-mode spec).
function phoneCoarse(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 720px) and (pointer: coarse)').matches;
}

// Synchronous execCommand('copy') used when the async Clipboard API is missing
// (insecure context) or rejects (document not focused). A hidden textarea is the
// only portable way to drive execCommand.
function execCommandCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Identifies THIS browser tab to the server, which gives it its own ssh and its
// own `tmux attach` for whatever box it opens. Without it every viewer shared a
// single screen drawn at a single size — whoever resized last won, and any
// viewer with a smaller window then received cursor moves past its own last row
// and column, which renders as smeared and duplicated text.
//
// sessionStorage is the right lifetime: it survives a reload (so the reload
// reattaches to this tab's existing PTY through the grace window, instead of
// stranding one ssh per refresh) and dies with the tab. A second tab, window or
// machine gets its own id and therefore its own attach, which is the point.
const CLIENT_ID_KEY = 'tmuxifier.clientId';
const CLIENT_ID_OK = /^[A-Za-z0-9_-]{1,64}$/;
let cachedClientId = '';
function clientId(): string {
  if (cachedClientId) return cachedClientId;
  let id = '';
  try { id = sessionStorage.getItem(CLIENT_ID_KEY) || ''; } catch { /* storage blocked */ }
  if (!CLIENT_ID_OK.test(id)) {
    const raw = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    id = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    try { sessionStorage.setItem(CLIENT_ID_KEY, id); } catch { /* storage blocked */ }
  }
  // Held in memory too, so a tab with storage disabled still keeps ONE id for
  // its lifetime rather than minting a fresh PTY on every reconnect.
  cachedClientId = id;
  return id;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

// Connect an xterm Terminal to the system clipboard: copy-on-select plus
// Cmd/Ctrl+Shift+C to copy and Ctrl+Shift+V to paste. Decisions about which
// key combos count live in the pure ./clipboard module; this only supplies the
// browser objects and forwards the result. See the diagnosis in clipboard.ts.
// Also handles the voice hotkey (Ctrl+Shift+Space): xterm's
// attachCustomKeyEventHandler keeps only ONE handler, so voice must be checked
// in this same callback rather than attaching a second one, which would
// silently replace this handler and disable copy/paste.
function wireClipboard(term: Terminal, voice?: VoiceHotkeyTarget): void {
  const voiceKey = voice ? createVoiceHotkeyHandler(voice) : null;
  const deps: ClipboardDeps = {
    clipboard: typeof navigator !== 'undefined' ? navigator.clipboard : undefined,
    fallbackCopy: execCommandCopy,
  };
  const env = { mac: isMacPlatform() };

  // OSC 52 bridge: apps that own the mouse (Claude Code fullscreen, vim, tmux
  // copy-mode) never see a browser drag — they copy by emitting OSC 52, which
  // xterm.js ignores unless explicitly handled. parseOsc52 returns null for
  // read-queries ("?") and garbage, so those consume the sequence without
  // touching the clipboard; returning true stops xterm's default handling.
  term.parser.registerOscHandler(52, (payload) => {
    const text = parseOsc52(payload);
    if (text) void writeClipboard(text, deps);
    return true;
  });

  // Copy-on-select: mirror any new selection to the clipboard immediately.
  // Async Clipboard API only — never the execCommand fallback here, whose hidden
  // textarea would steal focus and fight the in-progress drag on every
  // onSelectionChange tick (this path matters only on insecure-context
  // deployments, where the explicit copy shortcut still works).
  term.onSelectionChange(() => {
    if (!deps.clipboard?.writeText) return;
    const sel = term.getSelection();
    if (sel) void writeClipboard(sel, deps);
  });

  term.attachCustomKeyEventHandler((ev) => {
    // Voice is checked first and returns false so nothing belonging to the
    // Ctrl+Shift+Space chord ever reaches the PTY. xterm keeps only ONE
    // custom key handler, so this must live in the same callback as the
    // clipboard bindings — a second attach call would silently replace them.
    // createVoiceHotkeyHandler (voiceUi.ts) owns the whole chord state
    // machine: the first non-repeat keydown of the chord toggles (starts a
    // recording, or finishes one already in flight), and every other event
    // belonging to that same physical press — auto-repeat keydowns fired
    // while Space stays held, and the keyups as the keys come back up in
    // whatever order — is swallowed too, so a chord held for several seconds
    // can't leak spaces into the pane. It internally no-ops (returns false,
    // letting the keys fall through here) whenever voice isn't actually
    // usable — the /api/ui-config readiness fetch still pending, the server
    // has voice off, or the mounted readiness verdict itself was not ok
    // (e.g. plain HTTP) — since nothing could act on the keystroke either way.
    if (voiceKey?.(ev)) return false;
    const action = clipboardActionForKey(ev, env);
    if (action === 'copy') {
      const sel = term.getSelection();
      if (sel) {
        ev.preventDefault();
        // Refocus the terminal after a possible execCommand fallback grabbed focus.
        void writeClipboard(sel, deps).then(() => term.focus());
      }
      return false; // handled — don't let xterm send the combo to the PTY
    }
    if (action === 'paste') {
      ev.preventDefault();
      // Route through term.paste so bracketed-paste mode is honored.
      void readClipboard(deps).then((t) => { if (t) term.paste(t); });
      return false;
    }
    return true; // everything else (incl. bare Ctrl+C/Ctrl+V) reaches the PTY
  });
}

// Pasting a file/image or dropping one onto the terminal uploads it to the
// box's ~/.tmuxifier-uploads. The server types the quoted path into the tmux
// pane itself when it's safe (Claude Code / shell prompt — see the spec); the
// browser only reports uploads the server chose not to type. Text pastes take
// the untouched native path (wireClipboard). Capture phase so the file case
// wins before xterm's own paste handler sees the event.
function wireUploads(parent: HTMLElement, term: Terminal, boxId: string): () => void {
  // Batches are serialized on a promise chain so a second paste/drop while a
  // prior batch is uploading can't interleave status lines or path injections.
  let chain: Promise<void> = Promise.resolve();
  // Set on dispose so an in-flight upload's continuation never touches the
  // torn-down Terminal.
  let disposed = false;
  async function uploadAll(files: File[]): Promise<void> {
    for (const f of files) {
      if (disposed) return;
      const name = uploadName(f, Date.now());
      const tooBig = sizeError(f.size, uploadMaxBytes);
      if (tooBig) {
        term.write(`\r\n\x1b[33m[upload failed: ${termSafe(`${name}: ${tooBig}`)}]\x1b[0m\r\n`);
        continue;
      }
      term.write(`\r\n\x1b[2m[uploading ${termSafe(name)}…]\x1b[0m\r\n`);
      try {
        const res = await api.uploadFile(boxId, name, f);
        if (disposed) return;
        // The server typed the path into the pane (it arrives through the
        // normal attach stream) — only surface the cases where it didn't.
        if (!res.injected) {
          term.write(`\r\n\x1b[33m[uploaded: ${termSafe(res.path)} — pane busy, not typed]\x1b[0m\r\n`);
        }
      } catch (e) {
        if (disposed) return;
        term.write(`\r\n\x1b[33m[upload failed: ${termSafe((e as Error).message || 'error')}]\x1b[0m\r\n`);
      }
    }
    if (disposed) return;
    term.focus();
  }
  const onPaste = (ev: ClipboardEvent) => {
    const files = filesFromDataTransfer<File>(ev.clipboardData);
    if (!files.length) return; // text paste — leave xterm's native handling alone
    ev.preventDefault();
    ev.stopPropagation();
    chain = chain.then(() => uploadAll(files)).catch(() => {});
  };
  const onDragOver = (ev: DragEvent) => { ev.preventDefault(); };
  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    const files = filesFromDataTransfer<File>(ev.dataTransfer);
    if (files.length) chain = chain.then(() => uploadAll(files)).catch(() => {});
  };
  parent.addEventListener('paste', onPaste, true);
  parent.addEventListener('dragover', onDragOver);
  parent.addEventListener('drop', onDrop);
  return () => {
    disposed = true;
    parent.removeEventListener('paste', onPaste, true);
    parent.removeEventListener('dragover', onDragOver);
    parent.removeEventListener('drop', onDrop);
  };
}

// Touch drags become synthetic wheel events (rationale below) — and, when the
// app has MOUSE TRACKING on (Claude Code fullscreen, tmux `mouse on`), taps
// become inert: xterm would forward a tap as a real SGR click, so a stray
// touch on a TUI option list selected and activated it. A tap now suppresses
// the browser's compatibility mouse events entirely and refocuses the
// terminal itself; a deliberate ~500ms hold dispatches the synthetic
// mousedown/mouseup pair so touch activation survives. With tracking off the
// gesture machine (touchGesture.ts, the pure unit-tested half) reproduces the
// old path exactly — plain prompts keep today's behavior byte-for-byte.
//
// The wheel rationale: xterm's own touch path only scrolls its viewport,
// which at scrollback 0 (every box terminal — tmux owns history) can never
// consume the drag; the unconsumed touchmove then bubbled to the browser as
// pull-to-refresh. The wheel path already handles every case correctly —
// arrow-key fallback on a scrollback-0 buffer (DECCKM-aware), SGR mouse
// reporting when the app enabled tracking — so a drag is translated into the
// event that working path expects rather than reimplemented beside it.
// Capture phase on the container so xterm's dead-end touch handlers never
// run; multi-touch cancels the gesture, so pinch passes through untouched.
// The provision terminal keeps xterm's native path — it has real scrollback.
function wireTouchGestures(parent: HTMLElement, deps: { guard(): boolean; focus(): void }): () => void {
  const g = createTouchGesture();
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let pressTarget: HTMLElement | null = null; // element under the finger at touchstart
  const clearHold = () => { clearTimeout(holdTimer); holdTimer = undefined; };
  const mouse = (type: 'mousedown' | 'mouseup', x: number, y: number) => {
    pressTarget?.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0,
      bubbles: true, cancelable: true,
    }));
  };
  const apply = (a: GestureAction, ev: TouchEvent) => {
    switch (a.act) {
      case 'scroll':
        clearHold();
        if (ev.cancelable) ev.preventDefault();
        ev.stopPropagation();
        (ev.target as HTMLElement | null)?.dispatchEvent(new WheelEvent('wheel', {
          deltaY: a.deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true,
        }));
        break;
      case 'tap':
        clearHold();
        // Suppress the compatibility mousedown/mouseup/click the browser would
        // synthesize — that suppression also kills its focus path, so refocus
        // explicitly to keep tap-opens-keyboard working.
        if (ev.cancelable) ev.preventDefault();
        deps.focus();
        break;
      case 'hold-press': mouse('mousedown', a.x, a.y); break;
      case 'hold-release':
        if (ev.cancelable) ev.preventDefault();
        mouse('mouseup', a.x, a.y);
        break;
      case 'cancelled': clearHold(); break;
    }
  };
  const onStart = (ev: TouchEvent) => {
    clearHold();
    const t = ev.touches.length === 1 ? ev.touches[0] : null;
    pressTarget = ev.target as HTMLElement | null;
    g.start(t?.clientX ?? 0, t?.clientY ?? 0, ev.touches.length, deps.guard());
    if (g.holdPending) holdTimer = setTimeout(() => apply(g.timerFired(), ev), HOLD_MS);
  };
  const onMove = (ev: TouchEvent) => {
    const t = ev.touches.length === 1 ? ev.touches[0] : null;
    apply(g.move(t?.clientX ?? 0, t?.clientY ?? 0, ev.touches.length), ev);
  };
  const onEnd = (ev: TouchEvent) => { apply(g.end(), ev); clearHold(); };
  const onCancel = (ev: TouchEvent) => { apply(g.cancel(), ev); clearHold(); };
  parent.addEventListener('touchstart', onStart, { capture: true, passive: true });
  parent.addEventListener('touchmove', onMove, { capture: true, passive: false });
  parent.addEventListener('touchend', onEnd, true);
  parent.addEventListener('touchcancel', onCancel, true);
  return () => {
    clearHold(); // a pane disposed mid-hold must not fire a stray mousedown
    parent.removeEventListener('touchstart', onStart, true);
    parent.removeEventListener('touchmove', onMove, true);
    parent.removeEventListener('touchend', onEnd, true);
    parent.removeEventListener('touchcancel', onCancel, true);
  };
}

// A connection that survives this long counts as a real session, so we reset the
// reconnect backoff. The WebSocket to the server always opens, so onopen itself
// can't be the success signal — it must stay up past the box's ConnectTimeout (10s).
const STABLE_MS = 15000;
// A terminal refused because the box is mid-setup is a bounded wait, not an
// outage: setup finishes in seconds-to-minutes, so retry on a fixed short
// interval rather than the escalating outage backoff.
const SETUP_RETRY_MS = 2000;

// Terminal font. The family is the bundled stack (MesloLGMDZ Nerd Font for
// text/powerline/icons/ballot/sparkle, then MesloLGSDZ and JuliaMono as fallbacks
// for the U+2000-2BFF symbols Meslo lacks — Braille, ⎿/⏺ — then per-OS monospace),
// optionally with a TMUXIFIER_TERM_FONT family PREPENDED. The pure builders and
// the prepend-not-replace rationale live in ./termFont. setTerminalFont() is
// called once at boot (main.ts) with /api/ui-config before any terminal opens.
let termFontSize = DEFAULT_TERM_FONT_SIZE;
let userFont: string | null = null;
function termFontFamily(): string { return buildFontFamily(userFont); }

export function setTerminalFont(o: { termFont: string | null; termFontSize: number }): void {
  userFont = o?.termFont ?? null;
  termFontSize = clampFontSize(o?.termFontSize);
}

// Upload limit from /api/ui-config, applied at boot like the font settings.
let uploadMaxBytes = 25 * 1024 * 1024;
export function setTerminalUploads(o: { uploadMaxBytes?: number }): void {
  if (Number.isFinite(o?.uploadMaxBytes) && (o.uploadMaxBytes as number) > 0) uploadMaxBytes = o.uploadMaxBytes as number;
}

// xterm measures the glyph cell size ONCE, when it first renders. On a reattach
// the server replays the running screen immediately, so if our webfonts are still
// loading at that point xterm locks in the fallback font's cell metrics and paints
// the replay with them. fit.fit() alone only recomputes rows/cols from those stale
// metrics — it never re-measures the cell — so box-drawing art (Claude Code's
// animated figure) keeps tiling at the wrong width and breaks into disconnected
// "lines", and later frames only partially repaint.
//
// So once the fonts actually resolve we force xterm to re-measure: toggling
// term.options.fontFamily fires its onSpecificOptionChange(['fontFamily']) →
// CharSizeService.measure() path, which remeasures with the now-loaded font and,
// if the cell size changed, triggers a full re-render at the correct metrics.
// (Setting the same value is a no-op, hence the toggle through 'monospace'.) Then
// re-fit and refresh every row so the replayed screen repaints cleanly. Pre-loading
// the faces first — JuliaMono only carries symbols, so '⣿' forces its fetch past
// the unicode-range gate — means this usually settles within a frame.
function refitWhenFontReady(term: Terminal, fit: FitAddon): void {
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) { try { fit.fit(); } catch {} return; }
  // Also preload the configured custom family (if any) so xterm re-measures the
  // cell with it once resolved; for a locally-installed font fonts.load settles
  // immediately, and an absent one rejects harmlessly (caught below).
  const loads = [
    fonts.load(`${termFontSize}px 'MesloLGMDZ Nerd Font'`),
    fonts.load(`bold ${termFontSize}px 'MesloLGMDZ Nerd Font'`),
    fonts.load(`${termFontSize}px 'JuliaMono'`, '⣿'),
  ];
  if (userFont) loads.push(fonts.load(`${termFontSize}px '${userFont}'`).catch(() => []));
  Promise.all(loads)
    .then(() => fonts.ready)
    .then(() => {
      try { (term as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.(); } catch {}
      try {
        term.options.fontFamily = 'monospace';
        term.options.fontFamily = termFontFamily();
      } catch {}
      try { fit.fit(); } catch {}
      try { term.refresh(0, term.rows - 1); } catch {}
    })
    .catch(() => {});
}

function humanDelay(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
}

interface ProvisionOptions {
  ohMyTmux: boolean;
  ohMyZsh: boolean;
  ohMyBash: boolean;
  tools?: string[];
}

// The display glass (Bench Instrument world): screen-well background, bone
// foreground, amber cursor. ANSI colors stay at xterm defaults — terminal
// content belongs to the programs running in it, not to the chrome.
const SCREEN_THEME = {
  background: '#0a0b0d',
  foreground: '#e6e2da',
  cursor: '#ffb000',
  cursorAccent: '#0a0b0d',
  selectionBackground: 'rgba(255, 176, 0, 0.25)',
};

export function openTerminal(
  parent: HTMLElement,
  boxId: string,
  label?: string,
  opts?: { voiceMount?: HTMLElement; onConnState?: (s: PaneConn) => void; transformInput?: (d: string) => string },
) {
  const term = new Terminal({
    cursorBlink: true,
    // Math.min before the clamp, not after: clampFontSize falls back to the
    // DEFAULT (12) for anything outside its 6-32 range, so a configured 32
    // bumped past the ceiling would come back as 12 — a phone rendering
    // SMALLER than the desktop it is meant to enlarge. Saturating at the
    // ceiling keeps the bump monotonic. 32 is that ceiling, a literal in
    // clampFontSize (termFont.ts); it is not exported, so it is restated
    // rather than imported. +1 (was +2): validated on a real phone —
    // one step reads comfortably, two costs too many columns.
    fontSize: phoneCoarse() ? clampFontSize(Math.min(termFontSize + 1, 32)) : termFontSize,
    fontFamily: termFontFamily(),
    theme: SCREEN_THEME,
    // A box terminal is always a tmux attach, and tmux draws on the alternate
    // screen — nothing ever lands in xterm's own scrollback (scroll history is
    // tmux copy-mode). Zeroing it matters for width, not memory: FitAddon
    // reserves the viewport scrollbar's width whenever scrollback !== 0, and
    // xterm's Viewport reads overlay scrollbars (width 0) as its 15px fallback,
    // so every browser lost a dead 15px column on the right of the glass.
    // The provision terminal below keeps its scrollback — raw setup logs are
    // exactly the content that needs browser-side scroll.
    scrollback: 0,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(parent);
  fit.fit();
  refitWhenFontReady(term, fit);
  // Built here rather than reaching into wireClipboard: ClipboardDeps is
  // assembled inline there and never exported. execCommandCopy is the
  // module-local synchronous fallback for insecure contexts.
  const voice = wireVoice(opts?.voiceMount ?? parent, boxId, {
    write: (t) => term.write(t),
    copy: (t) => {
      void writeClipboard(t, {
        clipboard: typeof navigator !== 'undefined' ? navigator.clipboard : undefined,
        fallbackCopy: execCommandCopy,
      });
    },
    focus: () => term.focus(),
  });
  wireClipboard(term, voice);
  const offUploads = wireUploads(parent, term, boxId);
  const offTouchScroll = wireTouchGestures(parent, {
    // Read live per gesture, the same pattern as the bar's DECCKM-aware arrows.
    guard: () => term.modes.mouseTrackingMode !== 'none',
    focus: () => term.focus(),
  });

  // Strip control chars so a box label can't inject escape sequences into the
  // terminal feedback line.
  const name = (label || boxId).replace(/[^A-Za-z0-9 ._-]/g, '') || boxId;

  let ws: WebSocket;
  let closedByUser = false;
  let failures = 0;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  // A listener error must never break the terminal it is only observing.
  const emitConn = (s: PaneConn) => { try { opts?.onConnState?.(s); } catch {} };

  function connect() {
    // A backoff retry can fire after dispose() (its timer belongs to the old
    // tab); without this guard it would write to a disposed Terminal and open a
    // second WebSocket — a duplicate server-side PTY listener — for the box.
    if (closedByUser) return;
    emitConn({ kind: 'connecting' });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const { cols, rows } = term;
    // Immediate feedback so opening a box is never a mystery blank cursor — the
    // user knows it's connecting (and that a password prompt may be coming).
    term.write(`\x1b[2m[connecting to ${name}…]\x1b[0m\r\n`);
    ws = new WebSocket(`${proto}://${location.host}/term?box=${encodeURIComponent(boxId)}&cols=${cols}&rows=${rows}&client=${clientId()}`);
    ws.onopen = () => {
      emitConn({ kind: 'open' });
      sendResize();
      // Only treat the connection as a real session once it survives a while; the
      // box's ssh fails ~10s in, before this fires, so a dead box keeps escalating.
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => { failures = 0; }, STABLE_MS);
    };
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');
    ws.onclose = (ev) => {
      clearTimeout(stableTimer);
      if (closedByUser) return;
      // The server refuses a terminal while the box's setup job runs. Retry
      // promptly and leave `failures` untouched: counting this as a failure
      // would poison the backoff that real outages depend on, and could leave
      // the tab idle for minutes after setup had already finished.
      if (ev.reason === 'setting up') {
        emitConn({ kind: 'setup' });
        term.write('\r\n\x1b[33m[setting up — reconnecting when ready…]\x1b[0m\r\n');
        retryTimer = setTimeout(connect, SETUP_RETRY_MS);
        return;
      }
      failures += 1;
      emitConn({ kind: 'retrying', attempt: failures });
      const delay = reconnectDelay(failures);
      // Escalating backoff to a 5-minute floor (never gives up): a down box settles
      // to a gentle ~1 attempt/5min and auto-reconnects when it comes back.
      term.write(`\r\n\x1b[33m[disconnected — retrying in ${humanDelay(delay)}…]\x1b[0m\r\n`);
      retryTimer = setTimeout(connect, delay);
    };
  }
  function sendResize() {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
  }
  const sendInput = (d: string) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); };
  term.onData((d) => sendInput(opts?.transformInput ? opts.transformInput(d) : d));

  const onResize = () => { fit.fit(); sendResize(); };
  window.addEventListener('resize', onResize);
  connect();

  return {
    focus: () => term.focus(),
    dispose: () => { offUploads(); offTouchScroll(); voice.dispose(); closedByUser = true; clearTimeout(stableTimer); clearTimeout(retryTimer); window.removeEventListener('resize', onResize); ws?.close(); term.dispose(); },
    refit: onResize,
    input: sendInput,
    appCursor: () => term.modes.applicationCursorKeysMode,
  };
}

export function openProvisionTerminal(
  parent: HTMLElement,
  boxId: string,
  options: ProvisionOptions,
  onComplete: (code: number) => void,
) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: termFontSize,
    fontFamily: termFontFamily(),
    theme: SCREEN_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(parent);
  fit.fit();
  refitWhenFontReady(term, fit);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = [
    `box=${encodeURIComponent(boxId)}`,
    `mode=provision`,
    `cols=${term.cols}`,
    `rows=${term.rows}`,
    `ohMyTmux=${options.ohMyTmux ? '1' : '0'}`,
    `ohMyZsh=${options.ohMyZsh ? '1' : '0'}`,
    `ohMyBash=${options.ohMyBash ? '1' : '0'}`,
    ...(options.tools && options.tools.length ? [`tools=${encodeURIComponent(options.tools.join(','))}`] : []),
  ].join('&');
  const ws = new WebSocket(`${proto}://${location.host}/term?${qs}`);

  let done = false;

  term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); });

  ws.onmessage = (e) => {
    const raw = typeof e.data === 'string' ? e.data : '';
    try {
      const msg = JSON.parse(raw);
      if (msg.t === 'x') {
        done = true;
        onComplete(msg.code);
        return;
      }
    } catch {}
    term.write(raw);
  };

  ws.onclose = () => {
    if (!done) onComplete(-1);
  };

  const onResize = () => { fit.fit(); };
  window.addEventListener('resize', onResize);

  return {
    dispose: () => {
      window.removeEventListener('resize', onResize);
      if (!done) { done = true; onComplete(-1); }
      ws.close();
      term.dispose();
    },
    focus: () => term.focus(),
  };
}
