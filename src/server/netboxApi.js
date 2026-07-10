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

function jsonRequest({ url, headers = {}, timeoutMs = 10000, tls: tlsOpts = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method: 'GET', headers, timeout: timeoutMs,
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
    req.end();
  });
}

// Probe {url}/api/status/ with the token. Resolves a result object instead of
// throwing so the /api/netbox/test route (and the UI) get one shape to render.
export async function testNetbox(settings, { request = jsonRequest, connect = tlsProbe, timeoutMs = 10000 } = {}) {
  const u = new URL(settings.url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || 443;
  const mode = secure ? (settings.tlsMode || 'ca') : null;
  let tlsOpts = {};
  if (mode === 'insecure') tlsOpts = { rejectUnauthorized: false };
  if (mode === 'pin') {
    let probe;
    try { probe = await connect({ host: u.hostname, port, timeoutMs }); }
    catch (e) { return { ok: false, kind: 'unreachable', error: e.message }; }
    if (!normFp(settings.fingerprint256)) {
      return { ok: false, kind: 'tls', fingerprint256: probe.fingerprint256 || null, error: 'no fingerprint pinned yet — pin the certificate below to trust this server' };
    }
    if (normFp(probe.fingerprint256) !== normFp(settings.fingerprint256)) {
      return { ok: false, kind: 'tls', fingerprint256: probe.fingerprint256 || null, error: 'TLS fingerprint mismatch — the NetBox certificate changed; re-pin to accept the new one' };
    }
    const trust = probe.chain && probe.chain.length ? probe.chain : [probe.raw];
    tlsOpts = { ca: trust.map(derToPem), rejectUnauthorized: true, checkServerIdentity: () => undefined };
  }
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
