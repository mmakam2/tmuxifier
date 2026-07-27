import http from 'node:http';
import https from 'node:https';

// Pi-hole v6 REST client. v6 replaced admin/api.php with a session-authenticated
// API under /api/: POST /api/auth trades an app password for a sid, which every
// later request carries in X-FTL-SID. Sessions are a capped resource on the
// Pi-hole side, so this client holds exactly one and reuses it — minting one per
// 30-second sweep would exhaust the pool within the hour. Nothing here throws
// out to the caller: every failure resolves as a tagged result, the same
// contract serviceCheck.js already holds so one bad service can't poison a sweep.
const DEFAULT_TIMEOUT_MS = 8000;
// Re-authenticate once the session is this far through its advertised validity,
// so a sweep never races an expiry the Pi-hole already told us about.
const RENEW_AT = 0.8;

const AUTH_REJECTED = 'app password rejected — check Settings → Web interface / API on the Pi-hole';
const AUTH_TOTP = 'this Pi-hole requires a two-factor code — create an app password (Settings → Web interface / API) and use that instead';

function jsonRequest({ url, method = 'GET', headers = {}, body, timeoutMs, insecure }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    // Fixed Content-Length, never chunked — same lesson as netboxApi.js: reverse
    // proxies in front of API servers sometimes reject chunked request bodies.
    const payload = body == null ? null : JSON.stringify(body);
    const reqHeaders = payload == null
      ? headers
      : { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: reqHeaders,
      timeout: timeoutMs,
      // Unlike the plain http/tcp service checks — which always tolerate a bad
      // certificate because they send no credentials — this request carries a
      // password, so TLS is verified unless the operator opted out per service.
      ...(secure ? { rejectUnauthorized: !insecure } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        let parseError = false;
        if (data) {
          try { json = JSON.parse(data); } catch { parseError = true; }
        }
        resolve({ status: res.statusCode, json, parseError });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Pi-hole request timed out')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function mapMetrics({ summary, version, system, blocking }) {
  const q = summary?.queries ?? {};
  const c = summary?.clients ?? {};
  const g = summary?.gravity ?? {};
  const v = version?.version ?? {};
  const local = (k) => v?.[k]?.local?.version ?? null;
  const remote = (k) => v?.[k]?.remote?.version ?? null;
  return {
    blocking: blocking?.blocking === 'disabled' ? 'disabled' : 'enabled',
    blockingTimer: num(blocking?.timer),
    queriesTotal: num(q.total),
    queriesBlocked: num(q.blocked),
    percentBlocked: num(q.percent_blocked),
    clientsActive: num(c.active),
    clientsTotal: num(c.total),
    gravityDomains: num(g.domains_being_blocked),
    versionCore: local('core'),
    versionWeb: local('web'),
    versionFtl: local('ftl'),
    updateAvailable: ['core', 'web', 'ftl'].some((k) => local(k) && remote(k) && local(k) !== remote(k)),
    uptimeSec: num(system?.system?.uptime),
  };
}

export function createPiholeClient({
  baseUrl, password = '', insecure = false,
  timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now(), request = jsonRequest,
}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let sid = null;
  let renewAt = 0;
  let authing = null;

  async function authenticate() {
    const res = await request({ url: `${base}/api/auth`, method: 'POST', body: { password }, timeoutMs, insecure });
    const s = res.json?.session;
    if (res.status === 200 && s?.valid && s.sid) {
      sid = s.sid;
      const validity = Number(s.validity) > 0 ? Number(s.validity) : 1800;
      renewAt = now() + validity * RENEW_AT * 1000;
      return sid;
    }
    sid = null;
    renewAt = 0;
    // The password itself never enters the message.
    throw Object.assign(new Error(s?.totp === true ? AUTH_TOTP : AUTH_REJECTED), { kind: 'auth' });
  }

  // Single-flight: concurrent reads that find no live session await one POST.
  function session() {
    if (sid && now() < renewAt) return Promise.resolve(sid);
    if (!authing) authing = authenticate().finally(() => { authing = null; });
    return authing;
  }

  async function get(path, currentSid) {
    const res = await request({ url: `${base}${path}`, headers: { 'X-FTL-SID': currentSid, Accept: 'application/json' }, timeoutMs, insecure });
    if (res.status === 401) throw Object.assign(new Error('session expired'), { kind: 'expired' });
    if (res.parseError) throw Object.assign(new Error(`unreadable response from ${path}`), { kind: 'parse' });
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`http ${res.status} from ${path}`), { kind: 'unreachable' });
    return res.json;
  }

  // One retry, never a loop: an expired session re-authenticates once and
  // replays the reads; a second expiry resolves as an auth failure for this tick.
  async function readAll(paths) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const currentSid = await session();
      try {
        return await Promise.all(paths.map((p) => get(p, currentSid)));
      } catch (e) {
        if (e.kind !== 'expired' || attempt === 1) throw e;
        sid = null;
        renewAt = 0;
      }
    }
    throw Object.assign(new Error(AUTH_REJECTED), { kind: 'auth' });
  }

  function fail(e) {
    const kind = e?.kind === 'auth' ? 'auth'
      : e?.kind === 'expired' ? 'auth'
        : e?.kind === 'parse' ? 'parse'
          : 'unreachable';
    return { ok: false, kind, error: kind === 'auth' && e?.kind === 'expired' ? AUTH_REJECTED : (e?.message || 'request failed') };
  }

  return {
    async fetchSummary() {
      try {
        const [summary, version, system, blocking] = await readAll([
          '/api/stats/summary', '/api/info/version', '/api/info/system', '/api/dns/blocking',
        ]);
        return { ok: true, metrics: mapMetrics({ summary, version, system, blocking }) };
      } catch (e) {
        return fail(e);
      }
    },

    async fetchVersion() {
      try {
        const [version] = await readAll(['/api/info/version']);
        return { ok: true, version: version?.version?.core?.local?.version ?? null };
      } catch (e) {
        return fail(e);
      }
    },

    // Revoke rather than abandon: v6 caps concurrent sessions, so a restart that
    // leaked one per configured Pi-hole would eventually lock the operator out
    // of their own web UI.
    async close() {
      const current = sid;
      sid = null;
      renewAt = 0;
      if (!current) return;
      try {
        await request({ url: `${base}/api/auth`, method: 'DELETE', headers: { 'X-FTL-SID': current }, timeoutMs, insecure });
      } catch { /* best-effort: the session expires on its own */ }
    },
  };
}
