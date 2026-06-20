import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function openTerminal(parent: HTMLElement, boxId: string) {
  const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: '#0b0e14' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(parent);
  fit.fit();

  const cid = crypto.randomUUID();
  let ws: WebSocket;
  let closedByUser = false;
  let backoff = 500;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const { cols, rows } = term;
    ws = new WebSocket(`${proto}://${location.host}/term?box=${boxId}&cid=${cid}&cols=${cols}&rows=${rows}`);
    ws.onopen = () => { backoff = 500; sendResize(); };
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');
    ws.onclose = () => {
      if (closedByUser) return;
      term.write('\r\n\x1b[33m[disconnected — reconnecting…]\x1b[0m\r\n');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
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
    dispose: () => { closedByUser = true; window.removeEventListener('resize', onResize); ws?.close(); term.dispose(); },
    refit: onResize,
  };
}
