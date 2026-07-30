import http from 'node:http';
import https from 'node:https';
import { tlsProbe, pinnedConnectionFactory, normFp } from './tlsPin.js';
import { buildMetrics } from './unifiMetrics.js';
import { mapWithConcurrency } from './concurrency.js';

// Dependency-free client for the UniFi Network Integration API v1, in the mold
// of netboxApi.js. GET only: there is deliberately no code path here that
// issues another verb, so the API key's blast radius stays at reads even though
// UniFi's local keys inherit their admin account's role.
const API_PREFIX = '/proxy/network/integration/v1';
const PAGE = 200;
// Bounds one refresh on a very large site. The client total still comes from
// the envelope's totalCount, so only the wired/wireless split is approximate
// past this many clients.
const MAX_CLIENT_PAGES = 5;
// How many per-device statistics requests are in flight at once. Small on
// purpose: the ceiling exists to keep a large site from opening a socket per
// device against what is often a consumer gateway, not to extract maximum
// throughput.
const STATS_CONCURRENCY = 6;
const DEFAULT_TTL_MS = 30000;

function jsonRequest({ url, headers = {}, timeoutMs = 10000, tls: tlsOpts = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method: 'GET', headers, timeout: timeoutMs,
      ...(secure ? (tlsOpts.pin ? {
        createConnection: pinnedConnectionFactory({ host: u.hostname, port: Number(u.port) || 443, fingerprint256: tlsOpts.pin, timeoutMs }),
      } : { rejectUnauthorized: tlsOpts.rejectUnauthorized !== false }) : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* reported as unexpected */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('UniFi request timed out')));
    req.on('error', reject);
    req.end();
  });
}

// A thrown ApiError carries the classification serviceCheck.js needs; every
// public method converts it into a result object rather than letting it escape.
class ApiError extends Error {
  // `fingerprint256` is set only for the trust-on-first-use refusal, where the
  // served certificate is what the operator needs in order to arm pin mode. A
  // mismatch deliberately leaves it unset: Tmuxifier never offers to re-pin
  // automatically, the same posture it takes toward a changed SSH host key.
  constructor(kind, message, { fingerprint256 = null } = {}) {
    super(message);
    this.kind = kind;
    if (fingerprint256) this.fingerprint256 = fingerprint256;
  }
}

const rows = (body) => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null);

export function createUnifiClient({
  baseUrl, apiKey, site = '', tls = 'verify', fingerprint = '',
  timeoutMs = 10000, ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(), request = jsonRequest, connect = tlsProbe,
} = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let siteIdPromise = null;
  let cached = null; // { at, metrics }

  // Pin mode probes the certificate before any authenticated request, so a
  // mismatch is caught while the key is still unsent. Resolved once per client:
  // the request connection re-verifies the pin anyway (pinnedSocket).
  let tlsPromise = null;
  function resolveTls() {
    if (tls === 'insecure') return Promise.resolve({ rejectUnauthorized: false });
    if (tls !== 'pin') return Promise.resolve({});
    tlsPromise ??= (async () => {
      const u = new URL(base);
      if (u.protocol !== 'https:') throw new ApiError('tls', 'certificate pinning requires an https URL');
      let probe;
      try { probe = await connect({ host: u.hostname, port: Number(u.port) || 443, timeoutMs }); }
      catch (e) { throw new ApiError('unreachable', e?.message || 'TLS probe failed'); }
      // Nothing pinned yet: refuse, but carry the fingerprint the probe above
      // just observed so Test connection can offer it. Without this the
      // instruction in the message ("run Test connection") named the very call
      // that was failing, and pin mode could never be armed at all.
      if (!normFp(fingerprint)) {
        throw new ApiError('tls', 'no fingerprint pinned yet — accept the certificate below to pin it', { fingerprint256: probe?.fingerprint256 });
      }
      if (normFp(probe.fingerprint256) !== normFp(fingerprint)) {
        throw new ApiError('tls', 'TLS fingerprint mismatch — the controller certificate changed; re-pin to accept the new one');
      }
      return { pin: fingerprint };
    })().catch((e) => { tlsPromise = null; throw e; });
    return tlsPromise;
  }

  async function get(path, { optional = false } = {}) {
    const tlsOpts = await resolveTls();
    let res;
    try {
      res = await request({
        url: `${base}${API_PREFIX}${path}`,
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
        timeoutMs, tls: tlsOpts,
      });
    } catch (e) {
      throw new ApiError('unreachable', e?.message || 'request failed');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('auth', `the controller rejected the API key (HTTP ${res.status})`);
    }
    // An endpoint this firmware does not implement costs the readings it feeds
    // and nothing else.
    if (optional && (res.status === 404 || res.status === 501)) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError('unexpected', `unexpected response from ${path} (HTTP ${res.status})`);
    }
    if (res.json == null) throw new ApiError('unexpected', `unparseable response from ${path}`);
    return res.json;
  }

  async function listSites() {
    const body = await get('/sites');
    const list = rows(body);
    if (!list) throw new ApiError('unexpected', 'unexpected /sites response — is this a UniFi controller URL?');
    return list.map((s) => ({ id: String(s?.id ?? ''), name: String(s?.name ?? ''), reference: String(s?.internalReference ?? '') }));
  }

  function resolveSiteId() {
    siteIdPromise ??= (async () => {
      const list = await listSites();
      if (list.length === 0) throw new ApiError('unexpected', 'the controller reports no sites');
      if (!site) return list[0].id;
      const match = list.find((s) => s.reference === site || s.name === site || s.id === site);
      if (!match) throw new ApiError('unexpected', `no site named ${JSON.stringify(site)} on this controller`);
      return match.id;
    })().catch((e) => { siteIdPromise = null; throw e; });
    return siteIdPromise;
  }

  async function listClients(siteId) {
    const all = [];
    let total = null;
    for (let page = 0; page < MAX_CLIENT_PAGES; page++) {
      const body = await get(`/sites/${encodeURIComponent(siteId)}/clients?limit=${PAGE}&offset=${page * PAGE}`);
      const list = rows(body) ?? [];
      if (total == null && typeof body?.totalCount === 'number') total = body.totalCount;
      all.push(...list);
      if (list.length < PAGE) break;
    }
    return { clients: all, total };
  }

  async function refresh() {
    const siteId = await resolveSiteId();
    const devicesBody = await get(`/sites/${encodeURIComponent(siteId)}/devices?limit=${PAGE}`);
    const devices = rows(devicesBody) ?? [];
    const { clients, total } = await listClients(siteId);
    const networksBody = await get(`/sites/${encodeURIComponent(siteId)}/networks?limit=${PAGE}`, { optional: true });

    // One request per device, bounded rather than serial (E2). Serially this
    // cost a full round trip per device — up to 200 on a large site, all of it
    // in front of the snapshot every tile waits on. Bounded rather than
    // unleashed for the same reason mapWithConcurrency exists for SSH probes: a
    // controller is often a consumer gateway, and 200 simultaneous sockets is a
    // burst, not a read.
    const withIds = devices.filter((d) => d?.id);
    const stats = await mapWithConcurrency(withIds, STATS_CONCURRENCY, (d) => get(
      `/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(d.id)}/statistics/latest`,
      { optional: true },
    ));
    // mapWithConcurrency returns in input order, so the zip is positional and
    // a slow device cannot end up wearing another's readings.
    const statsById = new Map(withIds.map((d, i) => [d.id, stats[i]]));

    return buildMetrics({
      devices, statsById, clients, clientsTotal: total,
      networks: networksBody === null ? null : rows(networksBody),
    });
  }

  const asResult = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof ApiError) {
        return { ok: false, kind: e.kind, error: e.message, ...(e.fingerprint256 ? { fingerprint256: e.fingerprint256 } : {}) };
      }
      return { ok: false, kind: 'unexpected', error: e?.message || 'unifi request failed' };
    }
  };

  return {
    // Used by the settings Test button: proves the key works, and hands back the
    // site list plus the served fingerprint so pin mode can be armed.
    probe: () => asResult(async () => {
      const sites = await listSites();
      let fingerprint256 = null;
      const u = new URL(base);
      if (u.protocol === 'https:') {
        try { fingerprint256 = (await connect({ host: u.hostname, port: Number(u.port) || 443, timeoutMs })).fingerprint256 ?? null; }
        catch { /* the probe already succeeded; the fingerprint is a bonus */ }
      }
      return { ok: true, sites, fingerprint256 };
    }),

    // Used by the sweep. Only successes are cached: a transient failure must not
    // pin the tile to an error for the rest of the TTL window.
    snapshot: () => asResult(async () => {
      if (cached && now() - cached.at < ttlMs) return { ok: true, metrics: cached.metrics };
      const metrics = await refresh();
      cached = { at: now(), metrics };
      return { ok: true, metrics };
    }),
  };
}
