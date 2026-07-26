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

export async function checkService(service, opts = {}) {
  const kind = service?.check?.kind || 'http';
  if (kind === 'none') return null;
  if (kind === 'tcp') return checkTcp(service.check?.target, opts);
  return checkHttp(service.check?.target || service.url, opts);
}
