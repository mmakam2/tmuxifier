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

// A Pi-hole check reports numbers, not just reachability. The `auth` state is
// deliberately distinct from `down`: a rotated app password means the Pi-hole is
// answering perfectly well, and painting it red would cry wolf. It maps onto the
// violet `.dot.auth` lamp boxes already use for failed SSH credentials.
export async function checkPihole(service, { piholeRegistry } = {}) {
  if (!piholeRegistry) return { state: 'down', error: 'pi-hole client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await piholeRegistry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'pi-hole client setup failed' };
  }
  const res = await client.fetchSummary();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, pihole: res.metrics };
  if (res.kind === 'auth') {
    // A Pi-hole with no password configured authenticates on an empty one, so
    // the empty-password attempt is made first and only its failure is reported
    // as the missing credential.
    const error = service.hasPassword === false
      ? 'no app password configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}

// A TrueNAS check reports storage, not just reachability. As with Pi-hole the
// `auth` state is deliberately distinct from `down`: a rotated or expired API key
// means the NAS is answering perfectly well, and painting it red would cry wolf.
export async function checkTruenas(service, { truenasRegistry } = {}) {
  if (!truenasRegistry) return { state: 'down', error: 'truenas client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await truenasRegistry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'truenas client setup failed' };
  }
  const res = await client.fetchMetrics();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, truenas: res.metrics };
  if (res.kind === 'auth') {
    const error = service.hasPassword === false
      ? 'no API key configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}

// A UniFi check reports the network, not just reachability. As with Pi-hole and
// TrueNAS the `auth` state is deliberately distinct from `down`: a rotated or
// revoked API key means the controller is answering perfectly well, and painting
// it red would cry wolf. A TLS failure is deliberately NOT auth — it is a
// transport the operator has to decide about, so it stays `down`.
export async function checkUnifi(service, { unifiRegistry } = {}) {
  if (!unifiRegistry) return { state: 'down', error: 'unifi client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await unifiRegistry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'unifi client setup failed' };
  }
  const res = await client.snapshot();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, unifi: res.metrics };
  if (res.kind === 'auth') {
    const error = service.hasPassword === false
      ? 'no API key configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}

// An Immich check reports the photo library, not just reachability. As with the
// other credentialed kinds the `auth` state is deliberately distinct from
// `down`. A 403 is not auth: the key is valid and the server answered, so the
// client degrades those readings and the tile stays up (see immichApi.js).
export async function checkImmich(service, { immichRegistry } = {}) {
  if (!immichRegistry) return { state: 'down', error: 'immich client unavailable' };
  const started = Date.now();
  let client;
  try {
    client = await immichRegistry.clientFor(service);
  } catch (err) {
    return { state: 'down', error: err?.message || 'immich client setup failed' };
  }
  const res = await client.snapshot();
  const latencyMs = Date.now() - started;
  if (res.ok) return { state: 'up', latencyMs, immich: res.metrics };
  if (res.kind === 'auth') {
    const error = service.hasPassword === false
      ? 'no API key configured — add one in Settings → Services'
      : res.error;
    return { state: 'auth', latencyMs, error };
  }
  return { state: 'down', latencyMs, error: res.error };
}

export async function checkService(service, opts = {}) {
  const kind = service?.check?.kind || 'http';
  if (kind === 'none') return null;
  if (kind === 'pihole') return checkPihole(service, opts);
  if (kind === 'truenas') return checkTruenas(service, opts);
  if (kind === 'unifi') return checkUnifi(service, opts);
  if (kind === 'immich') return checkImmich(service, opts);
  if (kind === 'tcp') return checkTcp(service.check?.target, opts);
  return checkHttp(service.check?.target || service.url, opts);
}
