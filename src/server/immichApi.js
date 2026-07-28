import http from 'node:http';
import https from 'node:https';
import { buildMetrics } from './immichMetrics.js';

// Dependency-free client for the Immich REST API, in the mold of netboxApi.js.
// GET only: there is deliberately no code path here that issues another verb,
// so the API key's blast radius stays at reads.
//
// Verified against Immich v3.0.3. The endpoints moved from /api/server-info/*
// to /api/server/* around v1.118, so this targets the modern paths only.
const DEFAULT_TTL_MS = 30000;

// Each endpoint carries the permission Immich requires for it, so a 403 can
// tell the operator exactly what to grant rather than just failing.
const ENDPOINTS = [
  { key: 'about', path: '/api/server/about', permission: 'server.about' },
  { key: 'storage', path: '/api/server/storage', permission: 'server.storage' },
  { key: 'statistics', path: '/api/server/statistics', permission: 'server.statistics' },
  { key: 'jobs', path: '/api/jobs', permission: 'job.read' },
  { key: 'versionCheck', path: '/api/server/version-check', permission: 'server.versionCheck' },
  { key: 'config', path: '/api/server/config', permission: 'systemConfig.read' },
];

// An operator who pastes the API base rather than the web base would otherwise
// build /api/api/server/about and get a silent 404 storm.
export function normalizeBase(raw) {
  return String(raw ?? '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
}

function jsonRequest({ url, headers = {}, timeoutMs = 10000, insecure = false }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      // Verified by default because this request carries a credential; the
      // opt-out is per-service and applies only to https.
      ...(secure ? { rejectUnauthorized: !insecure } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* reported as unexpected */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Immich request timed out')));
    req.on('error', reject);
    req.end();
  });
}

export function createImmichClient({
  baseUrl, apiKey, insecure = false,
  timeoutMs = 10000, ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(), request = jsonRequest,
} = {}) {
  const base = normalizeBase(baseUrl);
  let cached = null; // { at, metrics }

  async function fetchOne(endpoint) {
    let res;
    try {
      res = await request({
        url: `${base}${endpoint.path}`,
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        timeoutMs,
        insecure,
      });
    } catch (e) {
      return { kind: 'unreachable', error: e?.message || 'request failed' };
    }
    if (res.status === 401) return { kind: 'auth', error: 'the server rejected the API key (HTTP 401)' };
    // 403: a valid key without this permission. 404: a server version that does
    // not implement the endpoint. Both cost their own readings and nothing else.
    if (res.status === 403 || res.status === 404) return { kind: 'denied' };
    if (res.status < 200 || res.status >= 300) return { kind: 'unexpected' };
    if (res.json == null) return { kind: 'unexpected' };
    return { kind: 'ok', json: res.json };
  }

  async function refresh() {
    const settled = await Promise.all(
      ENDPOINTS.map(async (endpoint) => ({ endpoint, result: await fetchOne(endpoint) })),
    );

    // A 403 is proof the server answered, so liveness needs no separate ping
    // call: only a total transport failure means the server is actually down.
    if (settled.every(({ result }) => result.kind === 'unreachable')) {
      return { ok: false, kind: 'unreachable', error: settled[0].result.error };
    }
    const rejected = settled.find(({ result }) => result.kind === 'auth');
    if (rejected) return { ok: false, kind: 'auth', error: rejected.result.error };

    const payloads = {};
    const denied = [];
    for (const { endpoint, result } of settled) {
      if (result.kind === 'ok') payloads[endpoint.key] = result.json;
      else if (result.kind === 'denied') denied.push(endpoint.permission);
    }
    return { ok: true, metrics: buildMetrics({ ...payloads, denied }) };
  }

  return {
    // Used by the settings Test button: proves the key works and reports which
    // permissions are missing, so a scoped key can be fixed before saving.
    async probe() {
      const res = await refresh();
      if (!res.ok) return res;
      return { ok: true, version: res.metrics.version, denied: res.metrics.denied };
    },

    // Used by the sweep. Only successes are cached: a transient failure must not
    // pin the tile to an error for the rest of the TTL window.
    async snapshot() {
      if (cached && now() - cached.at < ttlMs) return { ok: true, metrics: cached.metrics };
      const res = await refresh();
      if (res.ok) cached = { at: now(), metrics: res.metrics };
      return res;
    },
  };
}
