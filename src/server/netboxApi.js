import http from 'node:http';
import https from 'node:https';
import { tlsProbe, derToPem, normFp } from './tlsPin.js';

// Certificate-verification failure codes OpenSSL/Node surface on the request
// error. Seeing one in ca mode means "the cert exists but isn't CA-trusted" —
// the fixable-by-pinning case, distinct from plain unreachability.
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
]);

// NetBox token allowed-IP lists match the socket's remote address, which on a
// dual-stack listener is the IPv4-mapped form — a plain a.b.c.d entry won't match.
const AUTH_HINT = 'check the token and its allowed-IP list — requests can arrive from an IPv4-mapped IPv6 address like ::ffff:192.168.1.10';

function jsonRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 10000, tls: tlsOpts = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    // Fixed Content-Length (never chunked) — same lesson as proxmoxApi.js: some
    // reverse proxies in front of API servers reject chunked request bodies.
    const payload = body == null ? null : JSON.stringify(body);
    const reqHeaders = payload == null ? headers : { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = mod.request({
      hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method, headers: reqHeaders, timeout: timeoutMs,
      ...(secure ? {
        rejectUnauthorized: tlsOpts.rejectUnauthorized !== false,
        ...(tlsOpts.ca ? { ca: tlsOpts.ca } : {}),
        ...(typeof tlsOpts.checkServerIdentity === 'function' ? { checkServerIdentity: tlsOpts.checkServerIdentity } : {}),
      } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch {} resolve({ status: res.statusCode, json, text: data }); });
    });
    req.on('timeout', () => req.destroy(new Error('NetBox request timed out')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Resolve the stored TLS mode to request options. Pin mode does the token-less
// probe first; a blank or mismatched pin comes back as `failure` (never a
// throw) so testNetbox can render it and the client can throw it.
async function resolveTlsOpts(settings, { connect, timeoutMs }) {
  const u = new URL(settings.url);
  const secure = u.protocol === 'https:';
  const mode = secure ? (settings.tlsMode || 'ca') : null;
  if (mode === 'insecure') return { mode, tlsOpts: { rejectUnauthorized: false } };
  if (mode !== 'pin') return { mode, tlsOpts: {} };
  let probe;
  try { probe = await connect({ host: u.hostname, port: Number(u.port) || 443, timeoutMs }); }
  catch (e) { return { mode, failure: { kind: 'unreachable', error: e.message } }; }
  if (!normFp(settings.fingerprint256)) {
    return { mode, failure: { kind: 'tls', fingerprint256: probe.fingerprint256 || null, error: 'no fingerprint pinned yet — pin the certificate below to trust this server' } };
  }
  if (normFp(probe.fingerprint256) !== normFp(settings.fingerprint256)) {
    return { mode, failure: { kind: 'tls', fingerprint256: probe.fingerprint256 || null, error: 'TLS fingerprint mismatch — the NetBox certificate changed; re-pin to accept the new one' } };
  }
  const trust = probe.chain && probe.chain.length ? probe.chain : [probe.raw];
  return { mode, tlsOpts: { ca: trust.map(derToPem), rejectUnauthorized: true, checkServerIdentity: () => undefined } };
}

// Probe {url}/api/status/ with the token. Resolves a result object instead of
// throwing so the /api/netbox/test route (and the UI) get one shape to render.
export async function testNetbox(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs = 10000 } = {}) {
  const u = new URL(settings.url);
  const port = Number(u.port) || 443;
  const { mode, failure, tlsOpts } = await resolveTlsOpts(settings, { connect, timeoutMs });
  if (failure) return { ok: false, ...failure };
  let res;
  try {
    res = await request({ url: `${settings.url}/api/status/`, headers: { Authorization: `Token ${settings.token}`, Accept: 'application/json' }, timeoutMs, tls: tlsOpts });
  } catch (e) {
    if (mode === 'ca' && TLS_ERROR_CODES.has(e.code)) {
      let fp = null;
      try { fp = (await connect({ host: u.hostname, port, timeoutMs })).fingerprint256; } catch { /* keep null */ }
      return { ok: false, kind: 'tls', fingerprint256: fp, error: `TLS verification failed (${e.message}) — pin the certificate fingerprint to trust this server` };
    }
    return { ok: false, kind: 'unreachable', error: e.message };
  }
  if (res.status === 401 || res.status === 403) {
    const detail = res.json && res.json.detail ? `${res.json.detail} — ` : '';
    return { ok: false, kind: 'auth', error: `NetBox rejected the token (${res.status}): ${detail}${AUTH_HINT}` };
  }
  if (res.status !== 200 || !res.json || typeof res.json['netbox-version'] !== 'string') {
    return { ok: false, kind: 'unexpected', error: `unexpected response from ${settings.url}/api/status/ (HTTP ${res.status}) — is this a NetBox URL?` };
  }
  return { ok: true, version: res.json['netbox-version'] };
}

// First usable IPv4 host of a prefix (network address + 1): the conventional
// gateway. auto-static infers its gateway from this and never allocates it.
// Networks with a different gateway convention use the `static` preset mode.
export function firstUsableIp(prefixCidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(prefixCidr));
  if (!m) throw new Error(`unparseable prefix: ${prefixCidr}`);
  const len = Number(m[5]);
  if (len > 30) throw new Error(`prefix ${prefixCidr} is too small for auto-static`);
  const value = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  const first = ((value & mask) >>> 0) + 1;
  return [(first >>> 24) & 255, (first >>> 16) & 255, (first >>> 8) & 255, first & 255].join('.');
}

// Throwing NetBox client for the provisioning/deprovisioning flows (testNetbox
// stays result-shaped for the settings UI). Same auth header, same TLS modes;
// pin mode verifies the fingerprint via resolveTlsOpts BEFORE any
// authenticated request is sent.
export function createNetboxClient(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs = 10000 } = {}) {
  async function call(method, path, body) {
    const { failure, tlsOpts } = await resolveTlsOpts(settings, { connect, timeoutMs });
    if (failure) throw new Error(failure.error);
    const res = await request({
      url: `${settings.url}/api${path}`, method, body, timeoutMs, tls: tlsOpts,
      headers: { Authorization: `Token ${settings.token}`, Accept: 'application/json' },
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = res.json && res.json.detail ? `: ${res.json.detail}` : '';
      throw new Error(`NetBox API error ${res.status}${detail}`);
    }
    return res.json;
  }
  return {
    async findPrefixByVlan(vid) {
      const data = await call('GET', `/ipam/prefixes/?vlan_vid=${encodeURIComponent(vid)}`);
      const results = (data && data.results) || [];
      if (results.length === 0) throw new Error(`no NetBox prefix for VLAN ${vid}`);
      if (results.length > 1) throw new Error(`VLAN ${vid} maps to multiple NetBox prefixes; cannot auto-allocate`);
      return { id: results[0].id, prefix: results[0].prefix };
    },
    async allocateIp(prefix, fields) {
      const gateway = firstUsableIp(prefix.prefix);
      // GET-then-POST instead of NetBox's atomic next-free POST: the atomic
      // endpoint happily hands out an unregistered gateway address (bit us in
      // production). A concurrent duplicate reservation makes NetBox reject
      // the POST -> the job errors cleanly and a retry succeeds; acceptable
      // for a single-user tool.
      const avail = await call('GET', `/ipam/prefixes/${encodeURIComponent(prefix.id)}/available-ips/`);
      const list = Array.isArray(avail) ? avail : [];
      const pick = list.find((item) => item && item.address && String(item.address).split('/')[0] !== gateway);
      if (!pick) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
      const created = await call('POST', '/ipam/ip-addresses/', { address: pick.address, ...fields });
      if (!created || !created.address) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
      return { id: created.id, address: created.address, gateway };
    },
    // A mask-less ?address= filter matches on host address regardless of the
    // record's prefix length, so one query catches /24 and /32 twins.
    async findIpsByAddress(address) {
      const data = await call('GET', `/ipam/ip-addresses/?address=${encodeURIComponent(address)}`);
      return ((data && data.results) || []).map((rec) => ({ id: rec.id, address: rec.address }));
    },
    async releaseIp(id) { await call('DELETE', `/ipam/ip-addresses/${encodeURIComponent(id)}/`); },
  };
}
