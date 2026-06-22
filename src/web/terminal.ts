import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { reconnectDelay } from './reconnect';

// A connection that survives this long counts as a real session, so we reset the
// reconnect backoff. The WebSocket to the server always opens, so onopen itself
// can't be the success signal — it must stay up past the box's ConnectTimeout (10s).
const STABLE_MS = 15000;

function humanDelay(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
}

interface ProvisionOptions {
  ohMyTmux: boolean;
  ohMyZsh: boolean;
  ohMyBash: boolean;
}

export function openTerminal(parent: HTMLElement, boxId: string, label?: string) {
  const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: '#0b0e14' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(parent);
  fit.fit();

  // Strip control chars so a box label can't inject escape sequences into the
  // terminal feedback line.
  const name = (label || boxId).replace(/[^A-Za-z0-9 ._-]/g, '') || boxId;

  let ws: WebSocket;
  let closedByUser = false;
  let failures = 0;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;

  function connect() {
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
      setTimeout(connect, delay);
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
    dispose: () => { closedByUser = true; clearTimeout(stableTimer); window.removeEventListener('resize', onResize); ws?.close(); term.dispose(); },
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
    fontSize: 13,
    theme: { background: '#0b0e14' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(parent);
  fit.fit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = [
    `box=${encodeURIComponent(boxId)}`,
    `mode=provision`,
    `cols=${term.cols}`,
    `rows=${term.rows}`,
    `ohMyTmux=${options.ohMyTmux ? '1' : '0'}`,
    `ohMyZsh=${options.ohMyZsh ? '1' : '0'}`,
    `ohMyBash=${options.ohMyBash ? '1' : '0'}`,
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
