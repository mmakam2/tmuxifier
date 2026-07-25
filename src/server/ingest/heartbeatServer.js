import http from 'node:http';
import { writeJson } from '../jsonFile.js';

// The only inbound surface in phase 1, and deliberately the smallest thing that
// can work: bare node:http, no framework, no cookies, no sessions, no
// credentials of any kind. The token in the URL is the whole authentication —
// it identifies one check and grants nothing else.
const MAX_BODY = 64 * 1024;

export function createHeartbeatServer({ checkinLog, isKnownToken, heartbeatFile, now = () => Date.now() }) {
  async function stampAlive() {
    // Absence of this stamp is how the dashboard distinguishes "nothing is
    // wrong" from "the receiver is dead" — the most dangerous failure here,
    // because nothing else looks broken.
    try { await writeJson(heartbeatFile, { at: now() }, { mode: 0o600 }); } catch { /* best effort */ }
  }

  async function handle(req, res) {
    // The pattern is the gate: anything that is not a plain token is refused
    // here, so nothing malformed ever reaches the lookup that reads
    // data/checks.json.
    const m = /^\/hb\/([A-Za-z0-9._-]{1,128})$/.exec((req.url || '').split('?')[0]);
    if (!m || (req.method !== 'POST' && req.method !== 'GET')) {
      res.writeHead(404); res.end(); return;
    }
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY && !tooBig) { tooBig = true; res.writeHead(413); res.end(); req.destroy(); }
    });
    await new Promise((r) => req.on('end', r).on('close', r));
    if (tooBig) return;
    const token = m[1];
    if (!await isKnownToken(token)) { res.writeHead(404); res.end(); return; }
    await checkinLog.append({
      via: 'heartbeat', source: `check:${token}`, key: `check:${token}`, norm: null,
      severity: 'info', state: 'checkin', title: 'check-in', body: '',
    });
    await stampAlive();
    res.writeHead(204); res.end();
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* socket gone */ } });
  });

  return {
    handle,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}
