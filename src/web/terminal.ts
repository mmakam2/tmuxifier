import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { reconnectDelay } from './reconnect';
import { clipboardActionForKey, writeClipboard, readClipboard, type ClipboardDeps } from './clipboard';
import { buildFontFamily, clampFontSize, DEFAULT_TERM_FONT_SIZE } from './termFont';
import { api } from './api';
import { filesFromDataTransfer, uploadName, sizeError, termSafe } from './upload';

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
function wireClipboard(term: Terminal): void {
  const deps: ClipboardDeps = {
    clipboard: typeof navigator !== 'undefined' ? navigator.clipboard : undefined,
    fallbackCopy: execCommandCopy,
  };
  const env = { mac: isMacPlatform() };

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

// A connection that survives this long counts as a real session, so we reset the
// reconnect backoff. The WebSocket to the server always opens, so onopen itself
// can't be the success signal — it must stay up past the box's ConnectTimeout (10s).
const STABLE_MS = 15000;

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

export function openTerminal(parent: HTMLElement, boxId: string, label?: string) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: termFontSize,
    fontFamily: termFontFamily(),
    theme: { background: '#0b0e14' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(parent);
  fit.fit();
  refitWhenFontReady(term, fit);
  wireClipboard(term);
  const offUploads = wireUploads(parent, term, boxId);

  // Strip control chars so a box label can't inject escape sequences into the
  // terminal feedback line.
  const name = (label || boxId).replace(/[^A-Za-z0-9 ._-]/g, '') || boxId;

  let ws: WebSocket;
  let closedByUser = false;
  let failures = 0;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function connect() {
    // A backoff retry can fire after dispose() (its timer belongs to the old
    // tab); without this guard it would write to a disposed Terminal and open a
    // second WebSocket — a duplicate server-side PTY listener — for the box.
    if (closedByUser) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const { cols, rows } = term;
    // Immediate feedback so opening a box is never a mystery blank cursor — the
    // user knows it's connecting (and that a password prompt may be coming).
    term.write(`\x1b[2m[connecting to ${name}…]\x1b[0m\r\n`);
    ws = new WebSocket(`${proto}://${location.host}/term?box=${boxId}&cols=${cols}&rows=${rows}`);
    ws.onopen = () => {
      sendResize();
      // Only treat the connection as a real session once it survives a while; the
      // box's ssh fails ~10s in, before this fires, so a dead box keeps escalating.
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => { failures = 0; }, STABLE_MS);
    };
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');
    ws.onclose = () => {
      clearTimeout(stableTimer);
      if (closedByUser) return;
      failures += 1;
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
  term.onData((d) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); });

  const onResize = () => { fit.fit(); sendResize(); };
  window.addEventListener('resize', onResize);
  connect();

  return {
    focus: () => term.focus(),
    dispose: () => { offUploads(); closedByUser = true; clearTimeout(stableTimer); clearTimeout(retryTimer); window.removeEventListener('resize', onResize); ws?.close(); term.dispose(); },
    refit: onResize,
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
    theme: { background: '#0b0e14' },
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
