import { WebSocket } from 'ws';

// TrueNAS JSON-RPC 2.0 client over a single persistent WebSocket. TrueNAS
// deprecated the REST API in 25.04 and removed it in 26, so wss://…/api/current
// is the only forward-compatible surface. Authentication is auth.login_ex with
// API_KEY_PLAIN: auth.login_with_api_key is removed in v27, and SCRAM needs
// TrueNAS 26. The mechanism is never negotiated with the server — the advertised
// mechanism list is unauthenticated, so a downgrade would be strippable.
//
// Nothing here throws out to the caller: every failure resolves as a tagged
// result, the same contract serviceCheck.js already holds, so one bad service
// cannot poison a sweep.
//
// The https-only rule lives at the boundaries where a user-supplied URL enters
// (servicesStore.js validation and the /api/services/truenas/test route), not
// here: TrueNAS revokes any API key sent over plain HTTP, and that check belongs
// where user input is validated. This client maps whatever scheme it is handed.
const DEFAULT_TIMEOUT_MS = 10000;

const AUTH_MESSAGES = {
  AUTH_ERR: 'API key rejected — check the key and the username it belongs to',
  EXPIRED: 'API key has expired — mint a new one on the TrueNAS',
  OTP_REQUIRED: 'this account requires a one-time password — use a user-linked API key on an account without OTP',
  REDIRECT: 'TrueNAS redirected authentication to another server',
};

// The middleware's wording for a session that is gone. Matching it is what lets
// one expiry trigger a single re-login instead of surfacing as an outage.
const EXPIRED_RE = /not authenticated|session (?:has )?(?:expired|is invalid)/i;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function socketUrl(baseUrl) {
  const u = new URL(String(baseUrl));
  const scheme = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws' : 'wss';
  return `${scheme}://${u.host}/api/current`;
}

function mapPool(p) {
  const size = num(p?.size);
  const allocated = num(p?.allocated);
  return {
    name: String(p?.name ?? ''),
    size,
    allocated,
    free: num(p?.free),
    // Derived rather than trusted: pool.query's capacity fields are nullable and
    // its fragmentation field is a string, so nothing here assumes a number.
    usedPct: size && size > 0 && allocated != null ? (allocated / size) * 100 : null,
    healthy: p?.healthy === true,
    status: String(p?.status ?? 'UNKNOWN'),
    scanning: p?.scan?.state === 'SCANNING',
  };
}

function mapAlerts(list) {
  const out = { critical: 0, warning: 0 };
  for (const a of Array.isArray(list) ? list : []) {
    // Dismissed means the operator has already seen it and said so.
    if (a?.dismissed === true) continue;
    const level = String(a?.level ?? '').toUpperCase();
    if (level === 'ERROR' || level === 'CRITICAL' || level === 'ALERT' || level === 'EMERGENCY') out.critical++;
    else if (level === 'WARNING' || level === 'NOTICE') out.warning++;
  }
  return out;
}

function mapMetrics({ pools, info, alerts }) {
  return {
    pools: (Array.isArray(pools) ? pools : []).map(mapPool),
    alerts: mapAlerts(alerts),
    version: typeof info?.version === 'string' ? info.version : null,
    hostname: typeof info?.hostname === 'string' ? info.hostname : null,
    uptimeSec: num(info?.uptime_seconds),
  };
}

export function createTruenasClient({
  baseUrl, username = '', apiKey = '', insecure = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  makeSocket = (url, opts) => new WebSocket(url, opts),
}) {
  const url = socketUrl(baseUrl);
  let socket = null;
  let ready = null;
  let nextId = 0;
  const pending = new Map();

  // `only` guards against a stale socket's close/error event arriving after a
  // reconnect and tearing down its replacement: the retry path closes the old
  // socket and opens a new one, and the old one's 'close' fires a tick later.
  function teardown(err, only) {
    if (only && socket !== only) return;
    const dead = socket;
    socket = null;
    ready = null;
    const reason = err || Object.assign(new Error('connection closed'), { kind: 'unreachable' });
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(reason); }
    pending.clear();
    try { dead?.close(); } catch { /* already gone */ }
  }

  function send(method, params = []) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== 1) {
        reject(Object.assign(new Error('not connected'), { kind: 'unreachable' }));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out`), { kind: 'unreachable' }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; } // unreadable frame: the per-call timeout handles it
    if (msg?.id == null) return;                             // server-initiated event, not a reply
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const message = msg.error?.message || 'call failed';
      p.reject(Object.assign(new Error(message), { kind: EXPIRED_RE.test(message) ? 'expired' : 'call' }));
      return;
    }
    p.resolve(msg.result);
  }

  function open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const s = makeSocket(url, insecure ? { rejectUnauthorized: false } : {});
      socket = s;
      const timer = setTimeout(() => {
        const e = Object.assign(new Error('connection timed out'), { kind: 'unreachable' });
        finish(reject, e);
        teardown(e, s);
      }, timeoutMs);
      s.on('message', onMessage);
      s.on('error', (err) => {
        clearTimeout(timer);
        const e = Object.assign(new Error(err?.message || 'connection failed'), { kind: 'unreachable' });
        finish(reject, e);
        teardown(e, s);
      });
      s.on('close', () => { clearTimeout(timer); if (settled) teardown(undefined, s); });
      s.on('open', () => { clearTimeout(timer); finish(resolve, s); });
    });
  }

  // Single-flight: concurrent calls that find no live session await one login.
  async function ensure() {
    if (ready) return ready;
    ready = (async () => {
      await open();
      const res = await send('auth.login_ex', [{
        mechanism: 'API_KEY_PLAIN', username, api_key: apiKey,
      }]);
      const type = res?.response_type;
      if (type !== 'SUCCESS') {
        // The key itself never enters the message.
        throw Object.assign(new Error(AUTH_MESSAGES[type] || 'authentication failed'), { kind: 'auth' });
      }
      return true;
    })();
    try {
      return await ready;
    } catch (e) {
      teardown(e);
      throw e;
    }
  }

  // One retry, never a loop: an expired session re-authenticates once and
  // replays; a second expiry resolves as an auth failure for this tick.
  async function callAll(methods) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await ensure();
      try {
        return await Promise.all(methods.map((m) => send(m)));
      } catch (e) {
        if (e.kind !== 'expired' || attempt === 1) throw e;
        teardown();
      }
    }
    throw Object.assign(new Error(AUTH_MESSAGES.AUTH_ERR), { kind: 'auth' });
  }

  function fail(e) {
    const kind = e?.kind === 'auth' || e?.kind === 'expired' ? 'auth'
      : e?.kind === 'parse' ? 'parse'
        : 'unreachable';
    return { ok: false, kind, error: e?.message || 'request failed' };
  }

  return {
    async fetchMetrics() {
      try {
        const [pools, info, alerts] = await callAll(['pool.query', 'system.info', 'alert.list']);
        return { ok: true, metrics: mapMetrics({ pools, info, alerts }) };
      } catch (e) {
        return fail(e);
      }
    },

    async fetchVersion() {
      try {
        const [info] = await callAll(['system.info']);
        return { ok: true, version: info?.version ?? null, hostname: info?.hostname ?? null };
      } catch (e) {
        return fail(e);
      }
    },

    // Log out rather than abandon the session, mirroring the Pi-hole client:
    // a restart that leaked one session per configured NAS accumulates them.
    async close() {
      if (!socket) { ready = null; return; }
      try { await send('auth.logout'); } catch { /* best-effort: it expires anyway */ }
      teardown();
    },
  };
}
