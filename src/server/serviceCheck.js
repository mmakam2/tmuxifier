import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Liveness probes for the standby dashboard's service tiles. Every failure
// mode resolves to a `down` result — a check never throws, so one bad
// service can't poison a sweep. TLS certificate errors are tolerated on
// purpose: this is a reachability probe, not a security boundary, and it
// shares nothing with the pinned Proxmox/NetBox API clients.
const DEFAULT_TIMEOUT_MS = 5000;

export function checkHttp(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve({ state: 'down', error: 'invalid url' }); return; }
    const started = Date.now();
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const latencyMs = Date.now() - started;
      res.resume(); // discard the body — up/down is decided by the status line
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      done(ok
        ? { state: 'up', latencyMs }
        : { state: 'down', latencyMs, error: `http ${res.statusCode}` });
      req.destroy();
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done({ state: 'down', error: err?.message || 'request failed' }));
  });
}

export function checkTcp(target, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const m = /^(.+):(\d+)$/.exec(String(target || ''));
    if (!m) { resolve({ state: 'down', error: 'invalid target' }); return; }
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host: m[1], port: Number(m[2]) });
    const done = (result) => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done({ state: 'up', latencyMs: Date.now() - started }));
    socket.on('timeout', () => done({ state: 'down', error: 'timeout' }));
    socket.on('error', (err) => done({ state: 'down', error: err?.message || 'connect failed' }));
  });
}

// The credentialed checks. Unlike http/tcp these report numbers, not just
// reachability, and they all share one semantics that took four integrations to
// settle:
//
//   - `auth` is deliberately distinct from `down`. A rotated or revoked
//     credential means the service is answering perfectly well, and painting it
//     red would cry wolf. It maps onto the violet `.dot.auth` lamp boxes already
//     use for failed SSH credentials.
//   - A missing stored credential is named as such rather than repeating
//     whatever the API said, because "unauthorized" is unhelpful when the real
//     answer is that the tile was never given a key.
//   - Everything else is `down`, including TLS failures: a transport the
//     operator has to decide about is not an authentication problem.
//   - A missing registry or a client that throws during setup degrades to
//     `down`, never a throw — one bad service must not poison a sweep.
//
// Each kind differs only in registry, client method, metrics key, and what its
// credential is called, so those are data. This was four near-identical
// wrappers (C1 in the 2026-07-29 review); the point of the table is that the
// fifth integration inherits the rules above rather than re-transcribing them
// and getting the auth-vs-down distinction subtly wrong.
export const CREDENTIALED_CHECKS = {
  // A Pi-hole with no password configured authenticates on an empty one, so the
  // empty-password attempt is made first and only its failure is reported as
  // the missing credential.
  pihole: { registry: 'piholeRegistry', method: 'fetchSummary', metricsKey: 'pihole', label: 'pi-hole', credential: 'app password' },
  truenas: { registry: 'truenasRegistry', method: 'fetchMetrics', metricsKey: 'truenas', label: 'truenas', credential: 'API key' },
  unifi: { registry: 'unifiRegistry', method: 'snapshot', metricsKey: 'unifi', label: 'unifi', credential: 'API key' },
  // A 403 is not auth here: the key is valid and the server answered, so the
  // client degrades those readings and the tile stays up (see immichApi.js).
  immich: { registry: 'immichRegistry', method: 'snapshot', metricsKey: 'immich', label: 'immich', credential: 'API key' },
};

async function checkCredentialed(service, opts, spec) {
  const registry = opts?.[spec.registry];
  if (!registry) return { state: 'down', error: `${spec.label} client unavailable` };
  const started = Date.now();
  let client;
  try {
    client = await registry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || `${spec.label} client setup failed` };
  }
  const res = await client[spec.method]();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, [spec.metricsKey]: res.metrics };
  if (res.kind === 'auth') {
    const error = service.hasPassword === false
      ? `no ${spec.credential} configured — add one in Settings → Services`
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}

export async function checkService(service, opts = {}) {
  const kind = service?.check?.kind || 'http';
  if (kind === 'none') return null;
  const credentialed = CREDENTIALED_CHECKS[kind];
  if (credentialed) return checkCredentialed(service, opts, credentialed);
  if (kind === 'tcp') return checkTcp(service.check?.target, opts);
  return checkHttp(service.check?.target || service.url, opts);
}
