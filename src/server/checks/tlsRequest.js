import http from 'node:http';
import https from 'node:https';
import { pinnedConnectionFactory } from '../tlsPin.js';

// The HTTP request path shared by the http and json check executors.
//
// It exists because those two used bare `fetch`, which offers no way to trust a
// certificate the system CA store does not vouch for. Every internal HTTPS
// service — a NetBox behind a private CA, a router's own cert, anything with a
// self-signed leaf — therefore failed with UNABLE_TO_GET_ISSUER_CERT_LOCALLY,
// and the check reported that as the service being down. A monitoring system
// that cannot watch most of the fleet, and lies about why, is worse than one
// that admits the gap.
//
// Built on node:http/https over `tlsPin.js`, exactly as netboxApi.js and
// proxmoxApi.js already are, so the three trust modes mean the same thing
// everywhere in this codebase: `ca` (system trust), `pin` (TOFU fingerprint,
// like `ssh accept-new`), `insecure` (explicit opt-out).

// A probe must not be able to exhaust the prober's own memory: a health endpoint
// that starts streaming gigabytes should cost a bounded read, not the whole
// stream. Assertions only ever look for a marker or a JSON field near the top.
const MAX_BODY = 256 * 1024;

// Pure. Resolves a stored check's TLS settings into request options.
//
// An unrecognised mode falls back to system trust, the strictest of the three —
// never to `insecure`. data/checks.json is a mutable file, so a typo or a
// hand-edit must not be able to silently downgrade certificate verification.
export function resolveCheckTls(check, url) {
  let secure = false;
  try { secure = new URL(url).protocol === 'https:'; } catch { return {}; }
  if (!secure) return {};
  const mode = check?.tlsMode || 'ca';
  if (mode === 'insecure') return { rejectUnauthorized: false };
  if (mode === 'pin') return { pin: check?.fingerprint256 || '' };
  return {};
}

export function requestCheck({ url, headers = {}, timeoutMs = 10000, tls = {}, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    const port = Number(u.port) || (secure ? 443 : 80);
    // `pin` present but blank still routes here on purpose: pinnedSocket refuses
    // a blank fingerprint, so "pin this cert" can never silently degrade into
    // "trust whatever the CA store likes".
    const pinning = secure && Object.prototype.hasOwnProperty.call(tls, 'pin');
    let pinAgent = null;
    if (pinning) {
      pinAgent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      pinAgent.createConnection = pinnedConnectionFactory({
        host: u.hostname, port, fingerprint256: tls.pin || '', timeoutMs,
      });
    }
    const cleanup = () => { if (pinAgent) pinAgent.destroy(); };
    const req = mod.request({
      hostname: u.hostname, port, path: u.pathname + u.search, method, headers, timeout: timeoutMs,
      // No connection pooling. A probe holds nothing open on the target — the
      // same rule tcpCheck follows by destroying its socket the moment it
      // settles. Node's global agent keeps sockets alive by default, which for
      // a checker running every 30s across a fleet would mean a permanent
      // connection to everything it watches.
      // pin mode rides a dedicated agent whose own createConnection is the
      // pinned factory, rather than passing createConnection in the request
      // options the way netboxApi.js and proxmoxApi.js do.
      //
      // Both forms work on their own — but `createConnection` in the options is
      // silently ignored when `agent: false` is also set, and this module wants
      // agent:false for the no-pooling reason below. Verified empirically:
      // options.createConnection with no agent option uses the pinned socket;
      // the same options plus agent:false skip it entirely and fall through to
      // ordinary system validation, which against a private cert fails as
      // DEPTH_ZERO_SELF_SIGNED_CERT while looking for all the world like the
      // pin was applied. Putting the factory on an explicit agent is immune to
      // that interaction, so pinning and pooling can both be controlled here.
      ...(secure && pinAgent ? { agent: pinAgent } : { agent: false }),
      ...(secure && !pinAgent ? { rejectUnauthorized: tls.rejectUnauthorized !== false } : {}),
    }, (res) => {
      let text = '';
      let done = false;
      res.on('data', (c) => {
        if (done) return;
        text += c;
        if (text.length >= MAX_BODY) { done = true; text = text.slice(0, MAX_BODY); res.destroy(); }
      });
      const finish = () => {
        if (res.__settled) return;
        res.__settled = true;
        cleanup();
        resolve({ status: res.statusCode, text });
      };
      res.on('end', finish);
      res.on('close', finish); // a capped body destroys the stream, so 'end' never fires
    });
    // Tagged rather than matched on message text: the caller words the operator
    // -facing detail, and a timeout must stay distinguishable from a refused
    // connection ("too slow to answer" vs "nothing is listening").
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { timedOut: true })));
    req.on('error', (e) => { cleanup(); reject(e); });
    req.end();
  });
}
